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
import type { Message } from "@oh-my-pi/pi-ai";
import type { Skill } from "../extensibility/skills";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";

export interface CurationCandidate {
	skill: Skill;
	/** The skill was first used only after a tool had already failed: its description may not trigger in time. */
	readLate: boolean;
	/** The skill entered the conversation in an earlier task and was still in context: this task may lean on it without reading it again. */
	earlier: boolean;
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
 * Curation candidates for the task that starts at `messages[taskStart]`:
 * `messages` is the session's live context, so a skill an earlier task read or
 * invoked still counts while it stays in context (compaction drops it). Every
 * such skill in `skills` is a candidate, provided a tool call of this task
 * failed. A failed read of a skill file itself is not counted as a failure.
 */
export function collectCurationSignals(
	messages: readonly AgentMessage[],
	taskStart: number,
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
		} else if (
			index >= taskStart &&
			message.role === "toolResult" &&
			message.isError &&
			!skillReadCallIds.has(message.toolCallId)
		) {
			errors.push(index);
		}
	});
	if (firstUse.size === 0 || errors.length === 0) return undefined;
	return {
		candidates: [...firstUse].map(([skill, used]) => ({
			skill,
			readLate: used >= taskStart && errors[0] < used,
			earlier: used < taskStart,
		})),
		errorCount: errors.length,
	};
}

type Block = Exclude<Message["content"], string>[number];

/** A content block as transcript text; thinking is omitted, images are marked. */
function blockText(block: Block): string | undefined {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
			return "[image]";
		case "toolCall":
			return `CALL ${block.name}: ${JSON.stringify(block.arguments)}`;
		default:
			return undefined;
	}
}

function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		const text = blockText(block);
		if (text !== undefined) parts.push(text);
	}
	return parts.join("\n");
}

/**
 * What a curation turn sees of a finished task: every message the model saw
 * during it, in order and unabridged — user prompts (with invoked skills
 * expanded), the assistant's text and tool calls, and every tool result. Only
 * the assistant's thinking is left out.
 */
export function renderTaskTranscript(messages: readonly AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of convertToLlm([...messages])) {
		if (message.role === "user" || message.role === "developer") {
			lines.push(`USER: ${contentText(message.content)}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				const text = blockText(block);
				if (text === undefined || !text.trim()) continue;
				lines.push(block.type === "toolCall" ? text : `ASSISTANT: ${text}`);
			}
		} else if (message.role === "toolResult") {
			lines.push(`${message.isError ? "ERROR" : "RESULT"} ${message.toolName}: ${contentText(message.content)}`);
		}
	}
	return lines.join("\n");
}
