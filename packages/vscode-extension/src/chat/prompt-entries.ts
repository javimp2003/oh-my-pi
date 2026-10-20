/**
 * Prompts among omp's session entries (`get_entries`), counted the way the
 * chat webview counts its editable prompt bubbles.
 */
import { isSkillPromptDetails, skillPromptDraft } from "../protocol";

/**
 * A session entry that is a prompt the user wrote: a non-synthetic user
 * message, or a `/skill:` prompt the user invoked (see `isUserPrompt` in
 * protocol.ts). Its text as the chat shows it, and its timestamp.
 * Undefined for any other entry.
 */
export function userPrompt(
	entry: Record<string, unknown>,
): { text: string; timestamp: number | undefined } | undefined {
	if (entry.type === "custom_message") {
		if (entry.customType !== "skill-prompt" || entry.attribution !== "user") return undefined;
		if (!isSkillPromptDetails(entry.details)) return undefined;
		// Persisted as the ISO form of the message's own timestamp (the key its checkpoint is saved under).
		const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		return { text: skillPromptDraft(entry.details), timestamp: Number.isNaN(parsed) ? undefined : parsed };
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") return undefined;
	if ("synthetic" in message && message.synthetic === true) return undefined;
	const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : undefined;
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return { text: content, timestamp };
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			if (typeof block.text === "string") texts.push(block.text);
		}
	}
	return { text: texts.join("\n"), timestamp };
}
