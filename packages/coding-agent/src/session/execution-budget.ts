import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import reservePrompt from "../prompts/system/execution-budget-reserve.md" with { type: "text" };
import type { SessionManager } from "./session-manager";
import {
	cfgExecutionBudgetTokens,
	cfgExecutionMaxSeconds,
	cfgExecutionPrefillWeight,
	cfgExecutionReservePercent,
} from "./settings";

export interface ExecutionBudgetConfig {
	tokens: number;
	prefillWeight: number;
	reservePercent: number;
	maxSeconds: number;
}
export interface ExecutionBudgetStatus {
	spent: number;
	remaining: number | null;
	remainingSeconds: number | null;
	phase: "work" | "reserve" | "exhausted";
	elapsedSeconds: number;
}
const nonnegative = (value: number, fallback = 0): number => (Number.isFinite(value) && value >= 0 ? value : fallback);

/** A lease belongs to exactly one root request; background children retain their old lease. */
export class ExecutionBudget {
	readonly #seen = new Set<string>();
	readonly #started: number;
	readonly config: Readonly<ExecutionBudgetConfig>;
	#spent = 0;
	constructor(
		config: ExecutionBudgetConfig,
		private readonly now: () => number = () => performance.now(),
	) {
		this.config = Object.freeze({
			tokens: nonnegative(config.tokens),
			prefillWeight: nonnegative(config.prefillWeight, 0.2),
			reservePercent: Math.min(90, nonnegative(config.reservePercent, 20)),
			maxSeconds: nonnegative(config.maxSeconds),
		});
		this.#started = now();
	}
	record(id: string, usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): void {
		if (this.#seen.has(id)) return;
		this.#seen.add(id);
		// Input is uncached input in the normalized provider contract. cacheRead is
		// separate and deliberately free here; cacheWrite still requires prefill.
		this.#spent +=
			nonnegative(usage.output) +
			this.config.prefillWeight * (nonnegative(usage.input) + nonnegative(usage.cacheWrite));
	}
	status(): ExecutionBudgetStatus {
		const elapsedSeconds = Math.max(0, (this.now() - this.#started) / 1000);
		const remaining = this.config.tokens > 0 ? Math.max(0, this.config.tokens - this.#spent) : null;
		const remainingSeconds = this.config.maxSeconds > 0 ? Math.max(0, this.config.maxSeconds - elapsedSeconds) : null;
		const timeExceeded = remainingSeconds === 0;
		const reserveTime =
			remainingSeconds !== null && remainingSeconds <= (this.config.maxSeconds * this.config.reservePercent) / 100;
		const phase =
			timeExceeded || remaining === 0
				? "exhausted"
				: reserveTime ||
					  (remaining !== null && remaining <= (this.config.tokens * this.config.reservePercent) / 100)
					? "reserve"
					: "work";
		return { spent: this.#spent, remaining, remainingSeconds, phase, elapsedSeconds };
	}
	assertSpawn(purpose: "work" | "verification" = "work"): void {
		const { phase } = this.status();
		if (phase === "exhausted" || (phase === "reserve" && purpose !== "verification"))
			throw new Error(
				`Shared execution budget ${phase}; finish integration and verification with the existing work`,
			);
	}
}

/** Wires observed usage, pre-dispatch enforcement and one reserve notice per session/lease. */
export class SessionExecutionBudget {
	#budget: ExecutionBudget | undefined;
	#inFlightBudget: ExecutionBudget | undefined;
	#noticePhase: ExecutionBudgetStatus["phase"] | undefined;
	readonly #id = Snowflake.next();
	#sequence = 0;
	readonly #dispose: Array<() => void> = [];
	constructor(
		private readonly settings: Settings,
		private readonly inherited: ExecutionBudget | undefined,
		agent: Agent,
		manager: SessionManager,
		notice: (text: string) => void,
	) {
		this.#budget = inherited;
		this.resetRequest();
		this.#dispose.push(
			agent.subscribe(event => {
				if (event.type === "message_end" && event.message.role === "assistant")
					this.#inFlightBudget?.record(
						`${manager.getSessionId()}:${this.#id}:assistant:${++this.#sequence}`,
						event.message.usage,
					);
			}),
		);
		this.#dispose.push(
			manager.addEntryListener(entry => {
				if (entry.type === "model_usage")
					this.#budget?.record(`${manager.getSessionId()}:${entry.id}`, entry.usage);
			}),
		);
		this.#dispose.push(
			agent.addBeforeModelCall(context => {
				const budget = this.#budget;
				this.#inFlightBudget = budget;
				if (!budget) return;
				const status = budget.status();
				if (status.phase === "exhausted") {
					if (this.#noticePhase !== "exhausted") {
						this.#noticePhase = "exhausted";
						notice("Shared execution budget exhausted; no further provider request was sent");
					}
					return { stop: true, reason: "Shared execution budget exhausted" };
				}
				if (status.phase === "reserve" && this.#noticePhase !== "reserve") {
					this.#noticePhase = "reserve";
					const message = {
						role: "developer" as const,
						content: [
							{
								type: "text" as const,
								text: prompt.render(reservePrompt, {
									...status,
									remainingSeconds:
										status.remainingSeconds === null ? null : Math.ceil(status.remainingSeconds),
								}),
							},
						],
						timestamp: Date.now(),
						attribution: "agent" as const,
					};
					context.messages.push(message);
					agent.appendMessage(message);
					manager.appendMessage(message);
					notice("Shared execution budget entered verification reserve");
				}
			}),
		);
	}
	get current(): ExecutionBudget | undefined {
		return this.#budget;
	}
	resetRequest(): void {
		if (this.inherited) return;
		const tokens = cfgExecutionBudgetTokens.get(this.settings);
		const maxSeconds = cfgExecutionMaxSeconds.get(this.settings);
		this.#budget =
			tokens > 0 || maxSeconds > 0
				? new ExecutionBudget({
						tokens,
						maxSeconds,
						prefillWeight: cfgExecutionPrefillWeight.get(this.settings),
						reservePercent: cfgExecutionReservePercent.get(this.settings),
					})
				: undefined;
		this.#noticePhase = undefined;
	}
	dispose(): void {
		for (const dispose of this.#dispose.splice(0)) dispose();
	}
}
