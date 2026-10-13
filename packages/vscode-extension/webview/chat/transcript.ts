/**
 * The scrolling transcript: renders `history` snapshots and applies live
 * session events (streaming assistant messages, tool execution, retries,
 * compaction). Tool cards are shared between assistant tool calls and their
 * results through `toolCallId`.
 */
import type {
	AgentMessage,
	AssistantMessage,
	ChatRequest,
	ChatUpdate,
	ImageContent,
	RpcAgentEvent,
	ToolResultMessage,
} from "../../src/protocol";
import { button, h, iconButton } from "../dom";
import { icon } from "../icons";
import { fileLink, parseFileRef, thumbnail } from "./content";
import { openLightbox } from "./lightbox";
import { renderMarkdown } from "./markdown";
import { MessageEditor } from "./message-editor";
import { PlanCard } from "./plan-card";
import { ToolCard, truncatedPre } from "./tools";

type LiveEvent = RpcAgentEvent & { messageId?: string };
type Post = (request: ChatRequest) => void;

const EXAMPLE_PROMPTS = [
	"Give me an overview of this codebase",
	"Find likely bugs in my recent changes",
	"Write tests for the file I have open",
];
const PIN_THRESHOLD_PX = 32;
/** The TUI's braille activity spinner (packages/tui/src/status-line/segments.ts `brandSpinnerFrame`). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface BrailleSpinner {
	readonly element: HTMLElement;
	/** Animate on one 80 ms interval; `onTick` runs on the same interval (e.g. a timer label). */
	start(onTick?: () => void): void;
	stop(): void;
}

/** The TUI's braille spinner glyph; it only animates between `start()` and `stop()`. */
export function brailleSpinner(): BrailleSpinner {
	const element = h("span", { className: "working-spinner", ariaHidden: "true" }, SPINNER_FRAMES[0]);
	let frame = 0;
	let timer = 0;
	const stop = () => {
		window.clearInterval(timer);
		timer = 0;
	};
	return {
		element,
		start(onTick) {
			stop();
			frame = 0;
			element.textContent = SPINNER_FRAMES[0]!;
			timer = window.setInterval(() => {
				frame = (frame + 1) % SPINNER_FRAMES.length;
				element.textContent = SPINNER_FRAMES[frame]!;
				onTick?.();
			}, SPINNER_INTERVAL_MS);
		},
		stop,
	};
}

/** Elapsed turn time like the TUI's `brandTimer`: `12s`, `3m`, `1h` (capped at 99h). */
function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.min(99, Math.floor(seconds / 3600))}h`;
}

/**
 * Hover-revealed actions beside a user bubble: Edit (prompts only) and Copy,
 * whose icon turns into a check after copying.
 */
function messageActions(text: string, onEdit?: () => void): HTMLElement {
	const copy = iconButton("copy", "Copy message", () => {
		void navigator.clipboard.writeText(text).then(() => {
			copy.replaceChildren(icon("check"));
			setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
		});
	});
	return h("div", { className: "msg-actions" }, onEdit && iconButton("pencil", "Edit message", onEdit), copy);
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n");
}

function contentImages(content: string | Array<{ type: string }>): ImageContent[] {
	return typeof content === "string" ? [] : (content.filter(block => block.type === "image") as ImageContent[]);
}

/** User-style bubble: plain text (pre-wrapped), image thumbnails, optional label. */
function bubble(text: string, images: ImageContent[], label?: string, onEdit?: () => void): HTMLElement {
	const el = h("div", { className: "msg user" });
	const body = h("div", { className: "bubble" });
	if (label) body.append(h("div", { className: "bubble-label" }, label));
	if (text) body.append(h("div", { className: "bubble-text" }, text));
	if (images.length > 0) {
		body.append(h("div", { className: "thumbs" }, ...images.map(image => thumbnail(image))));
	}
	el.append(body, messageActions(text, onEdit));
	return el;
}

function summaryDivider(title: string, summary: string): HTMLElement {
	const details = h(
		"details",
		{ className: "summary-details" },
		h("summary", null, title),
		h("div", { className: "markdown" }),
	);
	(details.lastElementChild as HTMLElement).innerHTML = renderMarkdown(summary);
	return h("div", { className: "msg divider" }, details);
}

/** `details` of omp's `skill-prompt` custom message (packages/tui/src/chat/messages.ts `SkillPromptDetails`). */
interface SkillPromptDetails {
	name: string;
	args?: string;
	/** The draft as submitted, `/skill:<name>` token in place; absent on older sessions. */
	prompt?: string;
	lineCount?: number;
}

function isSkillPromptDetails(details: unknown): details is SkillPromptDetails {
	return typeof details === "object" && details !== null && "name" in details && typeof details.name === "string";
}

/**
 * A skill invocation as the user wrote it: the draft with each `/skill:name`
 * token as a chip, and the loaded SKILL.md (the message content sent to the
 * model) folded below, as the terminal shows it.
 */
function skillBubble(details: SkillPromptDetails, skillText: string): HTMLElement {
	const token = `/skill:${details.name}`;
	const draft = details.prompt ?? (details.args ? `${token} ${details.args}` : token);
	const text = h("div", { className: "bubble-text" });
	for (const part of draft.split(/(\/skill:[\w.:-]+)/)) {
		if (!part) continue;
		text.append(part.startsWith("/skill:") ? h("span", { className: "skill-chip" }, `✦ ${part.slice(7)}`) : part);
	}
	const lines = details.lineCount ?? skillText.split("\n").length;
	const prompt = h("div", { className: "markdown" });
	prompt.innerHTML = renderMarkdown(skillText);
	const folded = h(
		"details",
		{ className: "skill-details" },
		h("summary", null, `Skill ${details.name} · ${lines} ${lines === 1 ? "line" : "lines"}`),
		prompt,
	);
	return h(
		"div",
		{ className: "msg user" },
		h("div", { className: "bubble" }, text, folded),
		messageActions(details.prompt ?? draft),
	);
}

interface Slot {
	type: string;
	el: HTMLElement;
	key: string;
}

class AssistantView {
	readonly element = h("div", { className: "msg assistant" });
	#slots: Slot[] = [];
	#footer = h("div", { className: "msg-footer" });

	constructor(
		private readonly key: string,
		private readonly card: (id: string) => ToolCard,
		/** The composer's "expand all thinking" toggle is on. */
		private readonly thinkingExpanded: () => boolean,
	) {
		this.element.append(this.#footer);
	}

	update(message: AssistantMessage, streaming: boolean): void {
		const content = message.content ?? [];
		for (let index = 0; index < content.length; index++) {
			const block = content[index]!;
			if (this.#slots[index]?.type !== block.type) this.#truncate(index);
			let slot = this.#slots[index];
			if (!slot) {
				slot = this.#createSlot(block.type);
				this.#slots.push(slot);
				this.element.insertBefore(slot.el, this.#footer);
			}
			switch (block.type) {
				case "text":
					if (slot.key !== block.text) {
						slot.key = block.text;
						slot.el.innerHTML = renderMarkdown(block.text);
					}
					slot.el.hidden = block.text.trim() === "";
					break;
				case "thinking": {
					const details = slot.el as HTMLDetailsElement;
					const live = streaming && index === content.length - 1;
					const label = details.querySelector(".thinking-label")!;
					label.textContent = live ? "Thinking" : "Thought";
					label.classList.toggle("shimmer", live);
					details.classList.toggle("live", live);
					if (slot.key !== block.thinking) {
						slot.key = block.thinking;
						// Models end thinking with blank lines; under `pre-wrap` they would stretch the block (and its rule) past the text.
						details.querySelector(".thinking-body")!.textContent = block.thinking.trim();
					}
					details.hidden = !streaming && block.thinking.trim() === "";
					break;
				}
				case "toolCall": {
					const card = this.card(block.id || `${this.key}:${index}`);
					card.setCall(block.name, block.arguments ?? {}, block.intent);
					if (slot.el !== card.element) {
						slot.el.replaceWith(card.element);
						slot.el = card.element;
					}
					break;
				}
				case "image":
					if (slot.key === "") {
						slot.key = "image";
						slot.el.append(thumbnail(block));
					}
					break;
			}
		}
		this.#truncate(content.length);

		this.#footer.replaceChildren();
		if (message.stopReason === "error") {
			this.#footer.append(h("div", { className: "error-block" }, message.errorMessage || "The request failed."));
		} else if (message.stopReason === "aborted") {
			this.#footer.append(h("div", { className: "note" }, "Interrupted"));
		}
	}

	#createSlot(type: string): Slot {
		switch (type) {
			case "text":
				return { type, el: h("div", { className: "markdown" }), key: "\u0000" };
			case "thinking": {
				const details = h(
					"details",
					{ className: "thinking" },
					h(
						"summary",
						null,
						h("span", { className: "thinking-chevron" }, icon("chevronRight")),
						h("span", { className: "thinking-label" }, "Thinking"),
					),
					h("div", { className: "thinking-body" }),
				);
				// Open only when the brain toggle is on, live or not; the shimmering
				// "Thinking" summary already shows the agent is reasoning.
				details.open = this.thinkingExpanded();
				return { type, el: details, key: "\u0000" };
			}
			case "image":
				return { type, el: h("div", { className: "thumbs" }), key: "" };
			default:
				// toolCall gets its card on first update; other block kinds are not displayed.
				return { type, el: h("span", { hidden: true }), key: "" };
		}
	}

	#truncate(length: number): void {
		for (const slot of this.#slots.splice(length)) slot.el.remove();
	}
}

export class Transcript {
	readonly element: HTMLElement;
	#scroller = h("div", { className: "transcript" });
	#list = h("div", { className: "messages" });
	#spinner = brailleSpinner();
	#elapsed = h("span", { className: "working-time" }, "0s");
	#busySince = 0;
	#thinkingExpanded = false;
	#working = h(
		"div",
		{ className: "working", hidden: true },
		this.#spinner.element,
		h("span", { className: "working-label shimmer" }, "Working"),
		this.#elapsed,
	);
	#empty: HTMLElement;
	#pill = h(
		"button",
		{
			type: "button",
			className: "new-messages",
			hidden: true,
			ariaLabel: "New messages",
			dataset: { tooltip: "New messages" },
		},
		icon("arrowUp"),
	);
	#tools = new Map<string, ToolCard>();
	#planCards = new Map<string, PlanCard>();
	#live = new Map<string, AssistantView | HTMLElement>();
	#pendingUpdates = new Map<string, AssistantMessage>();
	#frame = 0;
	#pinned = true;
	#anonymousKey = "";
	#anonymousCount = 0;
	#retryNote: HTMLElement | undefined;
	#compactionNote: HTMLElement | undefined;
	/** Prompts (non-synthetic user messages) in the transcript; each bubble knows its ordinal. */
	#promptCount = 0;
	#editor: MessageEditor | undefined;

	constructor(
		private readonly post: Post,
		onExample: (prompt: string) => void,
	) {
		const chips = EXAMPLE_PROMPTS.map(prompt => button(prompt, "example", () => onExample(prompt)));
		this.#empty = h(
			"div",
			{ className: "empty" },
			h("div", { className: "empty-brand", ariaHidden: "true" }, "π"),
			h("div", { className: "empty-title" }, "What should omp build?"),
			h("div", { className: "empty-hint" }, "Type / for commands and skills · Shift+Enter for a new line"),
			h("div", { className: "examples" }, ...chips),
		);
		this.#scroller.append(this.#empty, this.#list, this.#working);
		this.element = h("div", { className: "transcript-wrap" }, this.#scroller, this.#pill);

		this.#scroller.addEventListener("scroll", () => {
			const distance = this.#scroller.scrollHeight - this.#scroller.scrollTop - this.#scroller.clientHeight;
			this.#pinned = distance < PIN_THRESHOLD_PX;
			if (this.#pinned) this.#pill.hidden = true;
		});
		this.#pill.addEventListener("click", () => {
			this.#pinned = true;
			this.#afterChange();
		});
		this.#scroller.addEventListener("click", event => this.#onClick(event));
		this.#scroller.addEventListener("keydown", event => {
			const target = event.target as HTMLElement;
			if (event.key === "Enter" && target.matches("[data-file], [data-href], img.thumb")) {
				event.preventDefault();
				target.click();
			}
		});
		this.#afterChange();
	}

	/** The host did not resend an edited prompt: its editor becomes editable again. */
	editAborted(): void {
		this.#editor?.reopen();
	}

	/** Edit the prompt `ordinal` in place; sending asks the host to rewind to it and resend. */
	#editPrompt(element: HTMLElement, ordinal: number, text: string): void {
		this.#editor?.close();
		const editor = new MessageEditor(
			element,
			text,
			edited => {
				this.post({ type: "editMessage", fromEnd: this.#promptCount - 1 - ordinal, original: text, text: edited });
			},
			() => {
				if (this.#editor === editor) this.#editor = undefined;
			},
		);
		this.#editor = editor;
	}

	setHistory(messages: AgentMessage[]): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		this.#pendingUpdates.clear();
		this.#live.clear();
		this.#tools.clear();
		this.#retryNote = undefined;
		this.#compactionNote = undefined;
		this.#editor = undefined;
		this.#promptCount = 0;
		this.#list.replaceChildren();
		for (const message of messages) {
			if (message.role === "assistant") {
				const view = new AssistantView(
					`h${this.#list.childElementCount}`,
					id => this.#card(id),
					() => this.#thinkingExpanded,
				);
				view.update(message, false);
				this.#list.append(view.element);
			} else {
				this.#appendStatic(message);
			}
		}
		for (const card of this.#tools.values()) if (card.status === "pending") card.setStatus("none");
		this.#pinned = true;
		this.#afterChange();
	}

	/** Open or fold every thinking block; blocks rendered later follow the same state. */
	setThinkingExpanded(expanded: boolean): void {
		this.#thinkingExpanded = expanded;
		for (const details of this.#list.querySelectorAll<HTMLDetailsElement>("details.thinking")) {
			details.open = expanded;
		}
		this.#afterChange();
	}

	setBusy(busy: boolean): void {
		this.#working.hidden = !busy;
		if (busy) {
			this.#busySince = Date.now();
			this.#elapsed.textContent = formatElapsed(0);
			this.#spinner.start(() => {
				this.#elapsed.textContent = formatElapsed(Date.now() - this.#busySince);
			});
		} else {
			this.#spinner.stop();
			this.#flush();
		}
		this.#afterChange();
	}

	/** Show the plan omp asks to approve; a card already shown for `review.id` is replaced. */
	showPlanReview(review: Extract<ChatUpdate, { type: "planReview" }>): void {
		const card = new PlanCard(review, this.post);
		const previous = this.#planCards.get(review.id);
		if (previous?.element.isConnected) previous.element.replaceWith(card.element);
		else this.#list.append(card.element);
		this.#planCards.set(review.id, card);
		// The decision is the next thing the user must do: bring it into view.
		this.#pinned = true;
		this.#afterChange();
	}

	closePlanReview(id: string): void {
		this.#planCards.get(id)?.close();
		this.#planCards.delete(id);
	}

	appendCommandOutput(text: string): void {
		this.#list.append(h("div", { className: "msg command-output" }, truncatedPre(text, "activity-pre")));
		this.#afterChange();
	}

	handleEvent(event: LiveEvent): void {
		switch (event.type) {
			case "message_start": {
				const key = event.messageId ?? this.#nextAnonymousKey();
				this.#upsert(key, event.message, true);
				break;
			}
			case "message_update": {
				const key = event.messageId ?? this.#anonymousKey;
				if (event.message.role !== "assistant") break;
				this.#pendingUpdates.set(key, event.message);
				this.#frame ||= requestAnimationFrame(() => this.#flush());
				return;
			}
			case "message_end": {
				const key = event.messageId ?? this.#anonymousKey;
				this.#pendingUpdates.delete(key);
				this.#upsert(key, event.message, false);
				this.#live.delete(key);
				break;
			}
			case "tool_execution_start": {
				const card = this.#card(event.toolCallId);
				if (event.args && typeof event.args === "object") {
					card.setCall(event.toolName, event.args as Record<string, unknown>, event.intent);
				}
				card.setStatus("running");
				this.#adoptOrphan(card, event.toolName);
				break;
			}
			case "tool_execution_update": {
				const card = this.#card(event.toolCallId);
				card.setResult(event.partialResult);
				card.setStatus("running");
				this.#adoptOrphan(card, event.toolName);
				break;
			}
			case "tool_execution_end": {
				const card = this.#card(event.toolCallId);
				card.setResult(event.result);
				card.setStatus(event.isError ? "error" : "done");
				this.#adoptOrphan(card, event.toolName);
				break;
			}
			case "agent_end":
				this.#flush();
				for (const card of this.#tools.values()) {
					if (card.status === "pending" || card.status === "running") card.setStatus("interrupted");
				}
				break;
			case "auto_retry_start":
				this.#retryNote = this.#note(
					this.#retryNote,
					`Retrying (attempt ${event.attempt}/${event.maxAttempts})… ${event.errorMessage}`,
				);
				break;
			case "auto_retry_end":
				if (event.success) this.#retryNote?.remove();
				else this.#note(this.#retryNote, `Retry failed: ${event.finalError ?? "unknown error"}`);
				this.#retryNote = undefined;
				break;
			case "auto_compaction_start":
				this.#compactionNote = this.#note(this.#compactionNote, "Compacting context…");
				break;
			case "auto_compaction_end":
				if (event.skipped) this.#compactionNote?.remove();
				else if (event.aborted) this.#note(this.#compactionNote, "Compaction aborted");
				else if (event.errorMessage) this.#note(this.#compactionNote, `Compaction failed: ${event.errorMessage}`);
				else this.#note(this.#compactionNote, "Context compacted");
				this.#compactionNote = undefined;
				break;
			case "irc_message":
				this.#appendStatic(event.message);
				break;
			default:
				return;
		}
		this.#afterChange();
	}

	#nextAnonymousKey(): string {
		this.#anonymousKey = `anon${++this.#anonymousCount}`;
		return this.#anonymousKey;
	}

	#card(id: string): ToolCard {
		let card = this.#tools.get(id);
		if (!card) {
			card = new ToolCard();
			this.#tools.set(id, card);
		}
		return card;
	}

	/** A result whose call was never rendered (e.g. history trimmed by compaction) still gets a card. */
	#adoptOrphan(card: ToolCard, toolName: string): void {
		if (card.element.isConnected) return;
		card.setCall(toolName, {});
		this.#list.append(card.element);
	}

	#upsert(key: string, message: AgentMessage, streaming: boolean): void {
		if (message.role === "assistant") {
			let view = this.#live.get(key);
			if (!(view instanceof AssistantView)) {
				view = new AssistantView(
					key,
					id => this.#card(id),
					() => this.#thinkingExpanded,
				);
				this.#live.set(key, view);
				this.#list.append(view.element);
			}
			view.update(message, streaming);
			return;
		}
		if (message.role === "toolResult") {
			this.#applyToolResult(message);
			return;
		}
		if (this.#live.has(key)) return;
		const el = this.#appendStatic(message);
		if (el) this.#live.set(key, el);
	}

	#flush(): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		if (this.#pendingUpdates.size === 0) return;
		for (const [key, message] of this.#pendingUpdates) this.#upsert(key, message, true);
		this.#pendingUpdates.clear();
		this.#afterChange();
	}

	#applyToolResult(message: ToolResultMessage): void {
		const card = this.#card(message.toolCallId);
		card.setResult({ content: message.content, details: message.details });
		card.setStatus(message.isError ? "error" : "done");
		this.#adoptOrphan(card, message.toolName);
	}

	/** Render a non-assistant message; returns the appended element (if any). */
	#appendStatic(message: AgentMessage): HTMLElement | undefined {
		let el: HTMLElement | undefined;
		switch (message.role) {
			case "user": {
				if (message.synthetic) return undefined;
				const ordinal = this.#promptCount++;
				const text = contentText(message.content);
				const prompt = bubble(text, contentImages(message.content), undefined, () =>
					this.#editPrompt(prompt, ordinal, text),
				);
				el = prompt;
				break;
			}
			case "custom":
			case "hookMessage":
				if (!message.display) return undefined;
				el =
					message.role === "custom" &&
					message.customType === "skill-prompt" &&
					isSkillPromptDetails(message.details)
						? skillBubble(message.details, contentText(message.content))
						: bubble(contentText(message.content), contentImages(message.content), message.customType);
				break;
			case "toolResult":
				this.#applyToolResult(message);
				return undefined;
			case "bashExecution":
			case "pythonExecution": {
				const card = new ToolCard("you");
				const isBash = message.role === "bashExecution";
				card.setCall(isBash ? "bash" : "python", isBash ? { command: message.command } : { code: message.code });
				let output = message.output;
				if (message.truncated) output += "\n[output truncated]";
				if (message.cancelled) output += "\n[cancelled]";
				card.setResult(output);
				card.setStatus(
					message.cancelled
						? "interrupted"
						: message.exitCode !== undefined && message.exitCode !== 0
							? "error"
							: "done",
				);
				el = h("div", { className: "msg" }, card.element);
				break;
			}
			case "compactionSummary":
				el = summaryDivider("Context compacted", message.summary);
				break;
			case "branchSummary":
				el = summaryDivider("Branch summary", message.summary);
				break;
			case "fileMention":
				el = h("div", { className: "msg note" }, "Attached ");
				message.files.forEach((file, index) => {
					if (index > 0) el!.append(", ");
					el!.append(fileLink(file.path));
				});
				break;
			default:
				// developer messages and assistant (handled by AssistantView) are not rendered here.
				return undefined;
		}
		this.#list.append(el);
		return el;
	}

	/** Create or rewrite a muted inline note at the end of the transcript. */
	#note(existing: HTMLElement | undefined, text: string): HTMLElement {
		const el = existing ?? h("div", { className: "msg note" });
		el.textContent = text;
		if (!el.isConnected) this.#list.append(el);
		return el;
	}

	#afterChange(): void {
		this.#empty.hidden = this.#list.childElementCount > 0 || !this.#working.hidden;
		if (this.#pinned) {
			this.#scroller.scrollTop = this.#scroller.scrollHeight;
			this.#pill.hidden = true;
		} else {
			this.#pill.hidden = false;
		}
	}

	#onClick(event: MouseEvent): void {
		const target = event.target as Element;
		const thumb = target.closest<HTMLImageElement>("img.thumb");
		if (thumb) {
			// In a tool card's summary row the click would also toggle the card.
			event.preventDefault();
			openLightbox(thumb.src);
			return;
		}
		const copy = target.closest<HTMLButtonElement>(".copy-btn");
		if (copy) {
			const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
			void navigator.clipboard.writeText(code).then(() => {
				copy.classList.add("copied");
				setTimeout(() => copy.classList.remove("copied"), 1200);
			});
			return;
		}
		const file = target.closest<HTMLElement>("[data-file]");
		if (file) {
			event.preventDefault();
			this.post({ type: "openFile", ...parseFileRef(file.dataset.file!) });
			return;
		}
		const link = target.closest<HTMLElement>("[data-href]");
		if (link) {
			event.preventDefault();
			const href = link.dataset.href!;
			if (/^https?:\/\//i.test(href)) this.post({ type: "openExternal", url: href });
			else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("file:")) {
				if (!href.startsWith("#")) this.post({ type: "openFile", ...parseFileRef(href) });
			}
		}
	}
}
