import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import scopeCheckpointPrompt from "../prompts/system/scope-checkpoint.md" with { type: "text" };
import { cfgModelScopeCheckpointEnabled, cfgModelScopeCheckpointMinutes } from "./settings";

const SCOPE_CHECKPOINT_MESSAGE_TYPE = "scope-checkpoint";
const SCOPE_CHECKPOINT_MAX_PER_CYCLE = 2;
/** Tool rounds required before each checkpoint (since request start / since the previous checkpoint). */
const SCOPE_CHECKPOINT_MIN_TOOL_ROUNDS = 8;
/** Tools whose execution time is the user's, not the agent's. */
const USER_WAIT_TOOLS: Record<string, true> = { ask: true };

/** Capabilities the scope checkpoint borrows from its owning session. */
export interface ScopeCheckpointHost {
	settings: Settings;
	agentKind(): "main" | "sub";
	planModeEnabled(): boolean;
}

/**
 * Hidden mid-work reminder asking a long-running main agent to re-check its
 * remaining work against the literal request. Fires at most twice per request:
 * once the run has been active for the configured minutes (excluding time
 * between runs and time blocked on the user) AND has made enough tool rounds,
 * then again at twice that time after more rounds.
 */
export class ScopeCheckpoint {
	readonly #host: ScopeCheckpointHost;
	#activeMs = 0;
	#runStartedAt: number | undefined;
	#userWaitStartedAt: number | undefined;
	#userWaitMs = 0;
	#toolRounds = 0;
	#roundsAtLastCheckpoint = 0;
	#fired = 0;
	#lastAssistantStopReason: string | undefined;

	constructor(host: ScopeCheckpointHost) {
		this.#host = host;
	}

	/** Resets per-request time, round, and checkpoint budgets. */
	resetCycle(): void {
		this.#activeMs = 0;
		this.#runStartedAt = undefined;
		this.#userWaitStartedAt = undefined;
		this.#userWaitMs = 0;
		this.#toolRounds = 0;
		this.#roundsAtLastCheckpoint = 0;
		this.#fired = 0;
		this.#lastAssistantStopReason = undefined;
	}

	/** Synchronous event bookkeeping; MUST run before any await in the session event handler. */
	onAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#runStartedAt = Date.now();
				return;
			case "agent_end":
				if (this.#runStartedAt !== undefined) {
					this.#activeMs += Date.now() - this.#runStartedAt;
					this.#runStartedAt = undefined;
				}
				return;
			case "tool_execution_start":
				if (USER_WAIT_TOOLS[event.toolName]) this.#userWaitStartedAt = Date.now();
				return;
			case "tool_execution_end":
				if (USER_WAIT_TOOLS[event.toolName] && this.#userWaitStartedAt !== undefined) {
					this.#userWaitMs += Date.now() - this.#userWaitStartedAt;
					this.#userWaitStartedAt = undefined;
				}
				return;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.#lastAssistantStopReason = event.message.stopReason;
				if (event.message.stopReason === "toolUse") this.#toolRounds++;
				return;
		}
	}

	/** Takes the next checkpoint message when every gate passes; polled by the session's aside provider. */
	take(): AgentMessage | null {
		const settings = this.#host.settings;
		if (!cfgModelScopeCheckpointEnabled.get(settings)) return null;
		const minutes = cfgModelScopeCheckpointMinutes.get(settings);
		if (!(minutes > 0)) return null;
		if (this.#host.agentKind() !== "main" || this.#host.planModeEnabled()) return null;
		// The aside provider is also polled at the stop boundary, where a message would force an
		// extra model turn after the agent finished; inject only between tool rounds.
		if (this.#lastAssistantStopReason !== "toolUse") return null;
		if (this.#fired >= SCOPE_CHECKPOINT_MAX_PER_CYCLE) return null;
		const now = Date.now();
		const elapsedMs =
			this.#activeMs + (this.#runStartedAt !== undefined ? now - this.#runStartedAt : 0) - this.#userWaitMs;
		if (elapsedMs < minutes * 60_000 * (this.#fired + 1)) return null;
		if (this.#toolRounds - this.#roundsAtLastCheckpoint < SCOPE_CHECKPOINT_MIN_TOOL_ROUNDS) return null;
		this.#fired++;
		this.#roundsAtLastCheckpoint = this.#toolRounds;
		const content = prompt.render(scopeCheckpointPrompt, {
			toolRounds: this.#toolRounds,
			second: this.#fired === 2,
		});
		logger.debug("Scope checkpoint fired", { checkpoint: this.#fired, toolRounds: this.#toolRounds, elapsedMs });
		return {
			role: "custom",
			customType: SCOPE_CHECKPOINT_MESSAGE_TYPE,
			content,
			display: false,
			attribution: "agent",
			timestamp: now,
		};
	}
}
