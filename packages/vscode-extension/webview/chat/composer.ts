/**
 * Bottom dock: notice banners, queued-message chips, and the composer card
 * (slash-command popup, pasted-image attachments, auto-growing textarea,
 * footer with attach, thinking toggle, model picker, context meter, and Send/Stop).
 */
import type { AvailableSlashCommand, ChatRequest, ImageContent, SessionState, SessionStats } from "../../src/protocol";
import { button, h, iconButton } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { ContextMeter } from "./context-meter";
import { DictationControl, type DictationState } from "./dictation";
import { GhostText } from "./ghost-text";
import { openLightbox } from "./lightbox";
import { ModelPicker } from "./model-picker";

type Post = (request: ChatRequest) => void;
type NoticeLevel = "info" | "warning" | "error";

/**
 * A slash command the webview runs itself: TUI commands omp's RPC mode does
 * not offer (`/new`, `/resume`, `/settings`, `/plan`) mapped onto the chat's own UI.
 */
export interface LocalCommand {
	name: string;
	description: string;
	/** `args` is the text after the command name, trimmed. */
	run(args: string): void;
}

export interface ComposerOptions {
	localCommands: LocalCommand[];
	/** The brain button toggled; `expanded` is the new state. */
	onToggleThinking(expanded: boolean): void;
}

const MAX_SUGGESTIONS = 50;
const PLACEHOLDER = "Ask omp anything. / for commands and skills";
const PLACEHOLDER_BUSY = "Ask for follow-up changes";
const PLACEHOLDER_PLAN = "Plan mode: describe what to plan";
const PLACEHOLDER_LISTENING = "Listening… click the microphone to finish, Esc to cancel";
const PLACEHOLDER_TRANSCRIBING = "Transcribing…";

/** A pasted image file as an omp image block (base64 data and MIME type). */
function readImage(file: File): Promise<ImageContent> {
	const { promise, resolve, reject } = Promise.withResolvers<ImageContent>();
	const reader = new FileReader();
	reader.onerror = () => reject(reader.error);
	reader.onload = () => {
		const url = String(reader.result);
		const comma = url.indexOf(",");
		const mimeType = file.type || url.slice("data:".length, url.indexOf(";"));
		resolve({ type: "image", data: url.slice(comma + 1), mimeType });
	};
	reader.readAsDataURL(file);
	return promise;
}

export class Composer {
	readonly element: HTMLElement;
	#notices = h("div", { className: "notices" });
	#queue = h("div", { className: "queue", hidden: true });
	#popup = h("div", { className: "slash-popup", role: "listbox", hidden: true });
	#input = h("textarea", {
		className: "input",
		rows: 1,
		placeholder: PLACEHOLDER,
		ariaLabel: "Prompt",
	});
	#send: HTMLButtonElement;
	#stop: HTMLButtonElement;
	#meter: ContextMeter;
	#thinkingToggle: HTMLButtonElement;
	#thinkingExpanded = false;
	#planToggle: HTMLButtonElement;
	#planCommand: LocalCommand;
	#planAvailable = false;
	#planOn = false;
	readonly picker: ModelPicker;
	/** Commands omp offers (`available_commands_update`). */
	#offered: AvailableSlashCommand[] = [];
	/** `#offered` plus the local commands it does not shadow. */
	#commands: AvailableSlashCommand[] = [];
	#local = new Map<string, LocalCommand>();
	#matches: AvailableSlashCommand[] = [];
	#selected = 0;
	/** Draft text for which the user dismissed the popup with Escape. */
	#dismissedFor: string | undefined;
	#busy = false;
	/** Pasted images sent with the next prompt. */
	#images: ImageContent[] = [];
	#attachments = h("div", { className: "attachments", hidden: true });
	#dictation: DictationControl;
	/** A streaming speech model's running transcript, shown above the input while recording. */
	#dictationPreview = h("div", { className: "dictation-preview", hidden: true });
	/** Grey word predictions after the caret, accepted with Tab or →. */
	#ghost: GhostText;

	constructor(
		private readonly post: Post,
		private readonly saveDraft: (draft: string) => void,
		draft: string,
		private readonly options: ComposerOptions,
	) {
		this.#send = h("button", { type: "button", className: "send-button", ariaLabel: "Send" }, icon("arrowUp"));
		this.#send.addEventListener("click", () => this.#submit());
		this.#stop = h(
			"button",
			{ type: "button", className: "stop-button", ariaLabel: "Stop", dataset: { tooltip: "Stop (Esc)" } },
			icon("stop"),
		);
		this.#stop.addEventListener("click", () => this.post({ type: "abort" }));
		this.#stop.hidden = true;
		this.picker = new ModelPicker(post);
		this.#meter = new ContextMeter(post);
		this.#dictation = new DictationControl(post, state => this.#onDictationState(state));
		this.#ghost = new GhostText(this.#input, post);
		this.#thinkingToggle = iconButton("brain", "", () => {
			this.#thinkingExpanded = !this.#thinkingExpanded;
			this.#renderThinkingToggle();
			this.options.onToggleThinking(this.#thinkingExpanded);
		});
		this.#thinkingToggle.classList.add("thinking-toggle");
		this.#renderThinkingToggle();
		this.#planToggle = iconButton("plan", "", () => this.#setPlanMode(!this.#planOn));
		this.#planToggle.classList.add("plan-toggle");
		this.#planCommand = {
			name: "plan",
			description: "Toggle plan mode (agent plans before executing)",
			run: args => this.#setPlanMode(args ? true : !this.#planOn, args || undefined),
		};
		this.#renderPlanToggle();
		this.setCommands([]);
		this.#input.value = draft;
		this.#input.addEventListener("input", () => this.#onInput());
		this.#input.addEventListener("keydown", event => this.#onKeyDown(event));
		this.#input.addEventListener("paste", event => this.#onPaste(event));
		this.#input.addEventListener("blur", () => setTimeout(() => this.#closePopup(), 150));
		this.#popup.addEventListener("mousedown", event => event.preventDefault());

		this.element = h(
			"div",
			{ className: "dock" },
			this.#notices,
			this.#queue,
			h(
				"div",
				{ className: "composer" },
				this.#popup,
				this.#attachments,
				this.#dictationPreview,
				this.#ghost.element,
				h(
					"div",
					{ className: "composer-footer" },
					h(
						"div",
						{ className: "composer-footer-left" },
						iconButton("plus", "Attach files", () => this.post({ type: "attachFiles" })),
						this.#thinkingToggle,
						this.#planToggle,
						this.picker.element,
					),
					h(
						"div",
						{ className: "composer-footer-right" },
						this.#meter.element,
						this.#dictation.element,
						this.#stop,
						this.#send,
					),
				),
			),
		);
		this.#refresh();
	}

	setBusy(busy: boolean): void {
		this.#busy = busy;
		this.#meter.setBusy(busy);
		this.#refresh();
	}

	setEnabled(enabled: boolean): void {
		this.#input.disabled = !enabled;
		this.#refresh();
	}

	/** Context-window meter (usage, session tokens and cost). */
	setUsage(state: SessionState, stats: SessionStats | undefined): void {
		this.#meter.setUsage(state, stats);
	}

	setCommands(commands: AvailableSlashCommand[]): void {
		this.#offered = commands;
		this.#mergeCommands();
	}

	/** Plan mode button: hidden when omp cannot enter plan mode (setting off, or an omp without RPC plan mode). */
	setPlanState(state: SessionState): void {
		this.#planAvailable = state.planModeAvailable === true;
		this.#planOn = state.planMode?.enabled === true;
		this.#renderPlanToggle();
		this.#mergeCommands();
	}

	/** omp's commands plus the local ones it does not offer itself. */
	#mergeCommands(): void {
		const commands = this.#offered;
		const offered = new Set(commands.flatMap(command => [command.name, ...(command.aliases ?? [])]));
		const candidates = this.#planAvailable
			? [...this.options.localCommands, this.#planCommand]
			: this.options.localCommands;
		const local = candidates.filter(command => !offered.has(command.name));
		this.#local = new Map(local.map(command => [command.name, command]));
		// Local commands join omp's builtins, ahead of skills and custom commands.
		const builtins = commands.filter(command => command.source === "builtin");
		this.#commands = [
			...builtins,
			...local.map(command => ({
				name: command.name,
				description: command.description,
				source: "builtin" as const,
			})),
			...commands.filter(command => command.source !== "builtin"),
		];
		this.#updatePopup();
	}

	/** Toggle plan mode; `prompt` (from `/plan <prompt>`) enters it and then sends the prompt. */
	#setPlanMode(enabled: boolean, prompt?: string): void {
		this.#planOn = enabled;
		this.#renderPlanToggle();
		this.post(prompt ? { type: "setPlanMode", enabled, prompt } : { type: "setPlanMode", enabled });
	}

	#renderPlanToggle(): void {
		this.#planToggle.hidden = !this.#planAvailable;
		const title = this.#planOn ? "Leave plan mode" : "Plan mode: plan read-only before changing code";
		setTooltip(this.#planToggle, title);
		this.#planToggle.ariaLabel = title;
		this.#input.placeholder = this.#placeholder();
		this.#planToggle.ariaPressed = String(this.#planOn);
	}

	setQueue(steering: string[], followUp: string[], liveSteered = 0): void {
		const chip = (text: string, queue: "steering" | "followUp", removable: boolean) => {
			const el = h(
				"div",
				{ className: `queue-chip ${queue}`, dataset: { tooltip: text } },
				h("span", { className: "queue-kind" }, queue === "steering" ? "Steer" : "Queued"),
				h("span", { className: "queue-text" }, text),
			);
			if (removable) {
				const remove = button("×", "chip-remove", () => this.post({ type: "removeQueued", message: text, queue }));
				setTooltip(remove, "Remove from queue");
				el.append(remove);
			}
			return el;
		};
		this.#queue.replaceChildren(
			...steering.map((text, index) => chip(text, "steering", index >= liveSteered)),
			...followUp.map(text => chip(text, "followUp", true)),
		);
		this.#queue.hidden = this.#queue.childElementCount === 0;
	}

	showNotice(level: NoticeLevel, message: string): void {
		const notice = h("div", { className: `notice ${level}`, role: level === "error" ? "alert" : "status" });
		const close = button("×", "notice-close", () => notice.remove());
		setTooltip(close, "Dismiss");
		notice.append(h("span", { className: "notice-text" }, message), close);
		this.#notices.append(notice);
	}

	/** Insert at the cursor (replacing any selection) and focus. */
	insertText(text: string): void {
		const { selectionStart, selectionEnd, value } = this.#input;
		const before = value.slice(0, selectionStart);
		const pad = before !== "" && !/\s$/.test(before) && !/^\s/.test(text) ? " " : "";
		this.#input.setRangeText(pad + text, selectionStart, selectionEnd, "end");
		this.#onInput();
		this.focus();
	}

	/** Replace the draft (example prompts) and focus. */
	fill(text: string): void {
		this.#input.value = text;
		this.#onInput();
		this.focus();
	}

	focus(): void {
		this.#input.focus();
	}

	/** "Toggle Voice Input" from the command palette or a keybinding. */
	toggleDictation(): void {
		this.#dictation.toggle();
	}

	/** omp's dictation state; `text` is a streaming model's running transcript. */
	dictationUpdate(
		state: "recording" | "transcribing" | "idle",
		text: string | undefined,
		error: string | undefined,
	): void {
		this.#dictation.update(state);
		this.#dictationPreview.textContent = text ?? "";
		this.#dictationPreview.hidden = state !== "recording" || !text;
		if (error) this.showNotice("error", error);
	}

	/** omp answered a word prediction for the draft. */
	wordPrediction(requestId: number, suffix: string | null): void {
		this.#ghost.onPrediction(requestId, suffix);
	}

	/** A finished dictation: the text goes in at the cursor, and is sent when omp's submit trigger fired. */
	dictationText(text: string, submit: boolean): void {
		this.#dictation.update("idle");
		if (!text) {
			this.showNotice("info", "No speech detected.");
			return;
		}
		this.insertText(text);
		if (submit) this.#submit();
	}

	#onDictationState(state: DictationState): void {
		if (state !== "recording") this.#dictationPreview.hidden = true;
		this.#refresh();
		if (state === "idle") this.focus();
	}

	#onInput(): void {
		this.#dismissedFor = undefined;
		this.saveDraft(this.#input.value);
		this.#refresh();
		this.#updatePopup();
		this.#ghost.onInput();
	}

	#refresh(): void {
		this.#input.style.height = "auto";
		this.#input.style.height = `${this.#input.scrollHeight}px`;
		const hasContent = this.#input.value.trim() !== "" || this.#images.length > 0;
		this.#stop.hidden = !this.#busy;
		this.#send.hidden = this.#busy && !hasContent;
		this.#send.disabled = !hasContent || this.#input.disabled;
		setTooltip(this.#send, this.#busy ? "Queue message (Enter)" : "Send (Enter)");
		this.#input.placeholder = this.#placeholder();
		this.#ghost.setEnabled(!this.#input.disabled && this.#dictation.state === "idle");
	}

	#placeholder(): string {
		if (this.#dictation.state === "recording") return PLACEHOLDER_LISTENING;
		if (this.#dictation.state === "transcribing") return PLACEHOLDER_TRANSCRIBING;
		if (this.#busy) return PLACEHOLDER_BUSY;
		return this.#planOn ? PLACEHOLDER_PLAN : PLACEHOLDER;
	}

	#submit(): void {
		const text = this.#input.value;
		if ((text.trim() === "" && this.#images.length === 0) || this.#input.disabled) return;
		const command = /^\s*\/(\S+)\s*([\s\S]*)$/.exec(text);
		const local = this.#local.get(command?.[1] ?? "");
		if (local) {
			// Local commands take no images; they stay attached for the next prompt.
			local.run(command?.[2]?.trim() ?? "");
		} else {
			this.post(this.#images.length > 0 ? { type: "prompt", text, images: this.#images } : { type: "prompt", text });
			this.#images = [];
			this.#renderAttachments();
		}
		this.#input.value = "";
		this.#onInput();
	}

	/**
	 * Images on the clipboard (screenshots, copied pictures) become attachments of
	 * the next prompt. Text on the same clipboard still pastes as text.
	 */
	#onPaste(event: ClipboardEvent): void {
		const data = event.clipboardData;
		if (!data) return;
		const files = [...data.items]
			.filter(item => item.kind === "file" && item.type.startsWith("image/"))
			.map(item => item.getAsFile())
			.filter((file): file is File => file !== null);
		if (files.length === 0) return;
		if (!data.types.includes("text/plain")) event.preventDefault();
		for (const file of files) {
			void readImage(file).then(
				image => {
					this.#images.push(image);
					this.#renderAttachments();
					this.#refresh();
				},
				() => this.showNotice("warning", `Could not read the pasted image (${file.type}).`),
			);
		}
	}

	#renderAttachments(): void {
		this.#attachments.replaceChildren(
			...this.#images.map((image, index) => {
				const remove = iconButton("close", "Remove image", () => {
					this.#images.splice(index, 1);
					this.#renderAttachments();
					this.#refresh();
					this.focus();
				});
				remove.classList.add("attachment-remove");
				const src = `data:${image.mimeType};base64,${image.data}`;
				const preview = h(
					"button",
					{
						type: "button",
						className: "attachment-open",
						ariaLabel: "Preview image",
						dataset: { tooltip: "Preview image" },
					},
					h("img", { src, alt: "Pasted image" }),
				);
				preview.addEventListener("click", () => openLightbox(src, "Pasted image"));
				return h("div", { className: "attachment" }, preview, remove);
			}),
		);
		this.#attachments.hidden = this.#images.length === 0;
	}

	#renderThinkingToggle(): void {
		const title = this.#thinkingExpanded ? "Collapse all thinking" : "Expand all thinking";
		setTooltip(this.#thinkingToggle, title);
		this.#thinkingToggle.ariaLabel = title;
		this.#thinkingToggle.ariaPressed = String(this.#thinkingExpanded);
	}

	#onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || event.keyCode === 229) return;
		const popupOpen = !this.#popup.hidden;
		if (popupOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				this.#selected = (this.#selected + step + this.#matches.length) % this.#matches.length;
				this.#renderPopup();
				return;
			}
			if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
				event.preventDefault();
				this.#complete(this.#matches[this.#selected]!);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				this.#dismissedFor = this.#input.value;
				this.#closePopup();
				return;
			}
		}
		if (this.#ghost.accept(event)) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			this.#submit();
		} else if (
			event.key === "Escape" &&
			(this.#dictation.state === "starting" || this.#dictation.state === "recording")
		) {
			event.preventDefault();
			this.#dictation.cancel();
		} else if (event.key === "Escape" && this.#busy) {
			event.preventDefault();
			this.post({ type: "abort" });
		}
	}

	/**
	 * The `/token` ending at the cursor, or undefined when the popup should not
	 * show. At the start of the draft every command applies; mid-prompt (after
	 * whitespace) only skills do, since omp runs builtin commands only as the
	 * first word but expands `/skill:name` anywhere.
	 */
	#slashToken(): { start: number; query: string; skillsOnly: boolean } | undefined {
		const value = this.#input.value;
		if (this.#dismissedFor === value) return undefined;
		const match = /(^|\s)\/(\S*)$/.exec(value.slice(0, this.#input.selectionEnd));
		if (!match) return undefined;
		const start = match.index + match[1]!.length;
		return { start, query: match[2]!, skillsOnly: start > 0 };
	}

	#updatePopup(): void {
		const token = this.#slashToken();
		if (token === undefined || this.#input.disabled) {
			this.#closePopup();
			return;
		}
		const needle = token.query.toLowerCase();
		const candidates = token.skillsOnly
			? this.#commands.filter(command => command.source === "skill")
			: this.#commands;
		// Skills match by their bare name too: `/sem` finds `skill:semantic-compression`.
		const names = (command: AvailableSlashCommand) =>
			[command.name, ...(command.aliases ?? [])].flatMap(n => {
				const lower = n.toLowerCase();
				return lower.startsWith("skill:") ? [lower, lower.slice("skill:".length)] : [lower];
			});
		const prefix = candidates.filter(command => names(command).some(n => n.startsWith(needle)));
		const rest = candidates.filter(
			command => !prefix.includes(command) && names(command).some(n => n.includes(needle)),
		);
		this.#matches = [...prefix, ...rest].slice(0, MAX_SUGGESTIONS);
		if (this.#matches.length === 0) {
			this.#closePopup();
			return;
		}
		this.#selected = Math.min(this.#selected, this.#matches.length - 1);
		this.#popup.hidden = false;
		this.#renderPopup();
	}

	#renderPopup(): void {
		this.#popup.replaceChildren(
			...this.#matches.map((command, index) => {
				const item = h(
					"div",
					{ className: "slash-item", role: "option", ariaSelected: String(index === this.#selected) },
					h("span", { className: "slash-name" }, `/${command.name}`),
					command.input?.hint ? h("span", { className: "slash-hint" }, command.input.hint) : null,
					h("span", { className: "slash-desc" }, command.description ?? ""),
				);
				item.addEventListener("click", () => this.#complete(command));
				return item;
			}),
		);
		this.#popup.children[this.#selected]?.scrollIntoView({ block: "nearest" });
	}

	/** Replace the `/token` at the cursor with the chosen command, keeping the text around it. */
	#complete(command: AvailableSlashCommand): void {
		const token = this.#slashToken();
		if (!token) return;
		const value = this.#input.value;
		const tokenEnd = token.start + (/^\/\S*/.exec(value.slice(token.start))?.[0].length ?? 0);
		const before = value.slice(0, token.start);
		const after = value.slice(tokenEnd).replace(/^\s*/, "");
		const inserted = `/${command.name} `;
		this.#input.value = `${before}${inserted}${after}`;
		const cursor = before.length + inserted.length;
		this.#input.setSelectionRange(cursor, cursor);
		this.#closePopup();
		this.saveDraft(this.#input.value);
		this.#refresh();
		this.focus();
	}

	#closePopup(): void {
		this.#popup.hidden = true;
		this.#selected = 0;
	}
}
