/**
 * Skill curation (`skills.selfImprove`): after a task that used the user's own
 * skills and hit tool errors, run one private side turn that may correct those
 * skills in place, then record each edit in the skill history and announce it.
 *
 * Installed once per top-level session; every settled task re-reads the live
 * setting. A "task" is a stretch of runs from the first `agent_start` until the
 * session settles (no run, queued input or background work that could resume
 * it), so goal continuations, follow-ups and job results belong to one task.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgSkillsSelfImprove, cfgSkillsSelfImproveThirdParty } from "../extensibility/settings";
import { isSelfImprovableSkill } from "../extensibility/skills";
import curationTemplate from "../prompts/skills/curation.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import type { Tool } from "../tools";
import { compactSkillDiff, writeSkillHistoryEntry } from "./history";
import { type CurationSignals, collectCurationSignals, renderTaskTranscript } from "./signals";
import { SkillEditTool } from "./skill-edit-tool";

export const SKILL_UPDATE_MESSAGE_TYPE = "skill-update";

/** Details of a `skill-update` message (the VS Code extension renders them as a card). */
export interface SkillUpdateDetails {
	skill: string;
	id: string;
	summary: string;
	files: string[];
	diff: string;
}

const NOTICE_ATTEMPTS = 3;

/**
 * The model a curation turn runs on: the `curator` model role
 * (`modelRoles.curator`) resolved against `availableModels`. Undefined when the
 * role is unset or matches no available model — the turn then runs on the
 * session's model.
 */
export function resolveSkillCurationModel(
	settings: Settings,
	availableModels: Model[],
): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const selector = settings.getModelRole("curator")?.trim();
	if (!selector) return undefined;
	const resolved = resolveModelRoleValue(selector, availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	if (!resolved.model) {
		logger.warn("modelRoles.curator matched no available model; skill curation uses the session model", {
			selector,
		});
		return undefined;
	}
	return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

export interface SkillCurationControllerOptions {
	session: AgentSession;
	settings: Settings;
	/** Run one private curation turn with `tools` over a clone of the session. */
	runTurn: (content: string, tools: Tool[]) => Promise<void>;
}

export class SkillCurationController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #runTurn: SkillCurationControllerOptions["runTurn"];
	/** `session.messages` length when the current task's first run started. */
	#taskStart: number | undefined;
	#checking = false;

	constructor(options: SkillCurationControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#runTurn = options.runTurn;
		// The listener closure keeps the controller alive for the session's lifetime.
		this.#session.subscribe(event => {
			if (event.type === "agent_start") {
				this.#taskStart ??= this.#session.messages.length;
			} else if (event.type === "agent_end" && event.isTerminal !== false) {
				void this.#onTerminalEnd();
			}
		});
	}

	async #onTerminalEnd(): Promise<void> {
		if (this.#checking) return;
		this.#checking = true;
		try {
			const session = this.#session;
			await session.waitForIdle();
			while (!session.isStreaming && !session.hasAdmittedSubmission && session.hasPendingAsyncWork()) {
				await session.settleAsyncWork();
			}
			// Still busy: a later terminal end of the same task checks again.
			if (
				session.isStreaming ||
				session.hasAdmittedSubmission ||
				session.queuedMessageCount > 0 ||
				session.hasPendingAsyncWork()
			) {
				return;
			}
			const start = this.#taskStart;
			this.#taskStart = undefined;
			const messages = session.messages;
			if (start === undefined || start > messages.length) return;
			if (!cfgSkillsSelfImprove.get(this.#settings)) return;
			if (session.getPlanModeState()?.enabled || session.getGoalModeState()?.enabled) return;
			const last = messages.findLast(message => message.role === "assistant");
			if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) return;
			const taskMessages = messages.slice(start);
			const thirdParty = cfgSkillsSelfImproveThirdParty.get(this.#settings);
			const signals = collectCurationSignals(
				messages,
				start,
				session.skills.filter(skill => isSelfImprovableSkill(skill, thirdParty)),
				session.sessionManager.getCwd(),
			);
			// Not awaited: the next task is tracked while curation runs.
			if (signals) void this.#curate(signals, renderTaskTranscript(taskMessages));
		} catch (error) {
			logger.warn("Skill curation check failed", { error: String(error) });
		} finally {
			this.#checking = false;
		}
	}

	async #curate(signals: CurationSignals, transcript: string): Promise<void> {
		const skills: Array<{ name: string; filePath: string; readLate: boolean; earlier: boolean; content: string }> =
			[];
		for (const { skill, readLate, earlier } of signals.candidates) {
			try {
				skills.push({
					name: skill.name,
					filePath: skill.filePath,
					readLate,
					earlier,
					content: await Bun.file(skill.filePath).text(),
				});
			} catch (error) {
				logger.warn("Skill curation could not read a skill", { skill: skill.name, error: String(error) });
			}
		}
		if (skills.length === 0) return;
		const updates: SkillUpdateDetails[] = [];
		this.#session.emitSkillCuration("running");
		try {
			const tool = new SkillEditTool(signals.candidates.map(candidate => candidate.skill));
			const read = this.#session.getToolByName("read");
			try {
				await this.#runTurn(
					prompt.render(curationTemplate, { transcript, skills, errorCount: signals.errorCount }),
					read ? [read, tool] : [tool],
				);
			} catch (error) {
				// Edits already written still count.
				logger.warn("Skill curation failed", { error: String(error) });
			}
			for (const record of tool.edits.values()) {
				const files = [...record.files]
					.filter(([, file]) => file.before !== file.after)
					.map(([filePath, file]) => ({ path: filePath, ...file }));
				if (files.length === 0) continue;
				const summary = record.summaries.join("; ");
				try {
					const entry = await writeSkillHistoryEntry({ skill: record.skill.name, summary, files });
					updates.push({
						skill: entry.skill,
						id: entry.id,
						summary,
						files: files.map(file => file.relativePath),
						diff: files
							.map(file => `--- ${file.relativePath}\n${compactSkillDiff(file.before, file.after)}`)
							.join("\n"),
					});
				} catch (error) {
					logger.warn("Skill curation could not record an edit", {
						skill: record.skill.name,
						error: String(error),
					});
				}
			}
		} finally {
			// Before the transcript notices: those wait for the session to go idle.
			this.#session.emitSkillCuration("done", updates);
		}
		for (const details of updates) {
			try {
				await this.#announce(details);
			} catch (error) {
				logger.warn("Skill curation could not announce an edit", { skill: details.skill, error: String(error) });
			}
		}
	}

	/**
	 * Show the edit in the transcript. An idle display append paints in the TUI and
	 * reaches RPC clients; while the user's next task runs it would be injected into
	 * that turn instead, so wait for idle and give up after a few tries (the history
	 * keeps the edit either way).
	 */
	async #announce(details: SkillUpdateDetails): Promise<void> {
		const session = this.#session;
		for (let attempt = 0; attempt < NOTICE_ATTEMPTS && !session.isDisposed; attempt++) {
			await session.waitForIdle();
			if (session.isStreaming || session.queuedMessageCount > 0) continue;
			await session.sendCustomMessage({
				customType: SKILL_UPDATE_MESSAGE_TYPE,
				content: `Skill \`${details.skill}\` updated: ${details.summary}\nRevert: /skill-history revert ${details.id}`,
				display: true,
				attribution: "agent",
				details,
			});
			return;
		}
	}
}
