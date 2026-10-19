/**
 * Which editable skills a finished task used, and whether it tripped.
 *
 * A task "used" a skill when it read one of the skill's files (`read` of
 * `skill://<name>[/…]` or of a path inside the skill directory) or the user
 * invoked it (`/skill:<name>`). It "tripped" when a tool call failed. Only
 * tasks that did both are worth a curation turn.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Skill } from "../extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";

export interface CurationCandidate {
	skill: Skill;
	/** The skill was first used only after a tool had already failed: its description may not trigger in time. */
	readLate: boolean;
}

export interface CurationSignals {
	candidates: CurationCandidate[];
	errorCount: number;
}

const SKILL_URL_PREFIX = "skill://";

/** The skill a `read` target belongs to, among `skills`: a `skill://` URL or a path inside a skill directory. */
export function matchSkillPath(target: string, skills: readonly Skill[], cwd: string): Skill | undefined {
	if (target.startsWith(SKILL_URL_PREFIX)) {
		const rest = target.slice(SKILL_URL_PREFIX.length);
		let match: Skill | undefined;
		for (const skill of skills) {
			const { name } = skill;
			const owns = rest === name || rest.startsWith(`${name}/`) || rest.startsWith(`${name}:`);
			if (owns && (!match || name.length > match.name.length)) match = skill;
		}
		return match;
	}
	// A trailing line selector (`SKILL.md:10-20`) keeps the path inside the directory.
	const absolute = path.resolve(cwd, target);
	return skills.find(skill => absolute === skill.filePath || absolute.startsWith(skill.baseDir + path.sep));
}

/**
 * Curation candidates in `messages` (one finished task): every skill in
 * `skills` the task used, provided at least one tool call failed. A failed read
 * of a skill file itself is not counted as a failure.
 */
export function collectCurationSignals(
	messages: readonly AgentMessage[],
	skills: readonly Skill[],
	cwd: string,
): CurationSignals | undefined {
	const firstUse = new Map<Skill, number>();
	const skillReadCallIds = new Set<string>();
	const errors: number[] = [];
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || block.name !== "read") continue;
				const target = block.arguments.path;
				if (typeof target !== "string") continue;
				const skill = matchSkillPath(target, skills, cwd);
				if (!skill) continue;
				skillReadCallIds.add(block.id);
				if (!firstUse.has(skill)) firstUse.set(skill, index);
			}
		} else if (message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const details = message.details;
			const name = details && typeof details === "object" && "name" in details ? details.name : undefined;
			const skill = skills.find(candidate => candidate.name === name);
			if (skill && !firstUse.has(skill)) firstUse.set(skill, index);
		} else if (message.role === "toolResult" && message.isError && !skillReadCallIds.has(message.toolCallId)) {
			errors.push(index);
		}
	});
	if (firstUse.size === 0 || errors.length === 0) return undefined;
	return {
		candidates: [...firstUse].map(([skill, used]) => ({ skill, readLate: errors[0] < used })),
		errorCount: errors.length,
	};
}

const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_ARGS_CHARS = 600;
const MAX_RESULT_CHARS = 800;
const MAX_TEXT_CHARS = 1_000;

function clip(text: string, max: number): string {
	const flat = text.trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.map(block => (block.type === "text" && block.text ? block.text : "")).join("\n");
}

/**
 * What a curation turn sees of a finished task: the user's requests, each tool
 * call with its (clipped) result, and the assistant's text. Keeps the end when
 * the whole exceeds the budget, since the failures and fixes are usually last.
 */
export function renderTaskTranscript(messages: readonly AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			lines.push(`USER: ${clip(textOf(message.content), MAX_TEXT_CHARS)}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) {
					lines.push(`ASSISTANT: ${clip(block.text, MAX_TEXT_CHARS)}`);
				} else if (block.type === "toolCall") {
					lines.push(`CALL ${block.name}: ${clip(JSON.stringify(block.arguments), MAX_ARGS_CHARS)}`);
				}
			}
		} else if (message.role === "toolResult") {
			lines.push(`${message.isError ? "ERROR" : "RESULT"}: ${clip(textOf(message.content), MAX_RESULT_CHARS)}`);
		} else if (message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const details = message.details;
			const name = details && typeof details === "object" && "name" in details ? details.name : undefined;
			if (typeof name === "string") lines.push(`USER: /skill:${name}`);
		}
	}
	const transcript = lines.join("\n");
	return transcript.length <= MAX_TRANSCRIPT_CHARS ? transcript : `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
}
