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
	ImageContent,
	RpcAgentEvent,
	ToolResultMessage,
} from "../../src/protocol";
import { button, h } from "../dom";
import { fileLink, imageSrc, parseFileRef } from "./content";
import { renderMarkdown } from "./markdown";
import { ToolCard, truncatedPre } from "./tools";

type LiveEvent = RpcAgentEvent & { messageId?: string };
type Post = (request: ChatRequest) => void;

const EXAMPLE_PROMPTS = [
	"Give me an overview of this codebase",
	"Find likely bugs in my recent changes",
	"Write tests for the file I have open",
];
const PIN_THRESHOLD_PX = 32;

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
function bubble(text: string, images: ImageContent[], label?: string): HTMLElement {
	const el = h("div", { className: "msg user" });
	const body = h("div", { className: "bubble" });
	if (label) body.append(h("div", { className: "bubble-label" }, label));
	if (text) body.append(h("div", { className: "bubble-text" }, text));
	if (images.length > 0) {
		body.append(
			h(
				"div",
				{ className: "thumbs" },
				...images.map(image => h("img", { className: "thumb", src: imageSrc(image), alt: "" })),
			),
		);
	}
	el.append(body);
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

interface Slot {
	type: string;
	el: HTMLElement;
	key: string;
	/** Thinking block auto-opened while streaming; closes when the message ends. */
	autoOpened?: boolean;
}

class AssistantView {
	readonly element = h("div", { className: "msg assistant" });
	#slots: Slot[] = [];
	#footer = h("div", { className: "msg-footer" });

	constructor(
		private readonly key: string,
		private readonly card: (id: string) => ToolCard,
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
				slot = this.#createSlot(block.type, streaming);
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
					details.querySelector("summary")!.textContent = live ? "Thinking…" : "Thinking";
					details.classList.toggle("live", live);
					if (slot.key !== block.thinking) {
						slot.key = block.thinking;
						details.querySelector(".thinking-body")!.textContent = block.thinking;
					}
					if (!streaming && slot.autoOpened) {
						details.open = false;
						slot.autoOpened = false;
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
						slot.el.append(h("img", { className: "thumb", src: imageSrc(block), alt: "" }));
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

	#createSlot(type: string, streaming: boolean): Slot {
		switch (type) {
			case "text":
				return { type, el: h("div", { className: "markdown" }), key: "\u0000" };
			case "thinking": {
				const details = h(
					"details",
					{ className: "thinking" },
					h("summary", null, "Thinking"),
					h("div", { className: "thinking-body" }),
				);
				details.open = streaming;
				return { type, el: details, key: "\u0000", autoOpened: streaming };
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
	#working = h(
		"div",
		{ className: "working", hidden: true },
		h("span", { className: "spinner" }),
		h("span", { className: "working-label" }, "Working"),
	);
	#empty: HTMLElement;
	#pill = h("button", { type: "button", className: "new-messages", hidden: true }, "↓ New messages");
	#tools = new Map<string, ToolCard>();
	#live = new Map<string, AssistantView | HTMLElement>();
	#pendingUpdates = new Map<string, AssistantMessage>();
	#frame = 0;
	#pinned = true;
	#anonymousKey = "";
	#anonymousCount = 0;
	#retryNote: HTMLElement | undefined;
	#compactionNote: HTMLElement | undefined;

	constructor(
		private readonly post: Post,
		onExample: (prompt: string) => void,
	) {
		const chips = EXAMPLE_PROMPTS.map(prompt => button(prompt, "example", () => onExample(prompt)));
		this.#empty = h(
			"div",
			{ className: "empty" },
			h("div", { className: "empty-title" }, "Ask omp anything about this workspace"),
			h("div", { className: "empty-hint" }, "Type / for commands. Shift+Enter adds a new line."),
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
			if (event.key === "Enter" && target.matches("[data-file], [data-href]")) {
				event.preventDefault();
				target.click();
			}
		});
		this.#afterChange();
	}

	setHistory(messages: AgentMessage[]): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		this.#pendingUpdates.clear();
		this.#live.clear();
		this.#tools.clear();
		this.#retryNote = undefined;
		this.#compactionNote = undefined;
		this.#list.replaceChildren();
		for (const message of messages) {
			if (message.role === "assistant") {
				const view = new AssistantView(`h${this.#list.childElementCount}`, id => this.#card(id));
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

	setBusy(busy: boolean): void {
		this.#working.hidden = !busy;
		if (!busy) this.#flush();
		this.#afterChange();
	}

	appendCommandOutput(text: string): void {
		this.#list.append(h("div", { className: "msg command-output" }, truncatedPre(text, "tool-pre")));
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
				view = new AssistantView(key, id => this.#card(id));
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
			case "user":
				if (message.synthetic) return undefined;
				el = bubble(contentText(message.content), contentImages(message.content));
				break;
			case "custom":
			case "hookMessage":
				if (!message.display) return undefined;
				el = bubble(contentText(message.content), contentImages(message.content), message.customType);
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
		const copy = target.closest<HTMLButtonElement>(".copy-btn");
		if (copy) {
			const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
			void navigator.clipboard.writeText(code).then(() => {
				copy.textContent = "Copied";
				setTimeout(() => (copy.textContent = "Copy"), 1200);
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
