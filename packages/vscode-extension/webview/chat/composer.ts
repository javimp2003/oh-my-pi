/**
 * Bottom dock: notice banners, queued-message chips, slash-command popup, and
 * the auto-growing prompt textarea with Send/Stop.
 */
import type { AvailableSlashCommand, ChatRequest } from "../../src/protocol";
import { button, h } from "../dom";

type Post = (request: ChatRequest) => void;
type NoticeLevel = "info" | "warning" | "error";

const MAX_SUGGESTIONS = 50;

export class Composer {
	readonly element: HTMLElement;
	#notices = h("div", { className: "notices" });
	#queue = h("div", { className: "queue", hidden: true });
	#popup = h("div", { className: "slash-popup", role: "listbox", hidden: true });
	#input = h("textarea", {
		className: "input",
		rows: 1,
		placeholder: "Ask omp… (/ for commands)",
		ariaLabel: "Prompt",
	});
	#send: HTMLButtonElement;
	#stop: HTMLButtonElement;
	#commands: AvailableSlashCommand[] = [];
	#matches: AvailableSlashCommand[] = [];
	#selected = 0;
	/** Draft text for which the user dismissed the popup with Escape. */
	#dismissedFor: string | undefined;
	#busy = false;

	constructor(
		private readonly post: Post,
		private readonly saveDraft: (draft: string) => void,
		draft: string,
	) {
		this.#send = button("Send", "send-button", () => this.#submit());
		this.#stop = button("Stop", "stop-button", () => this.post({ type: "abort" }));
		this.#stop.hidden = true;
		this.#input.value = draft;
		this.#input.addEventListener("input", () => this.#onInput());
		this.#input.addEventListener("keydown", event => this.#onKeyDown(event));
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
				this.#input,
				h("div", { className: "composer-buttons" }, this.#stop, this.#send),
			),
		);
		this.#refresh();
	}

	setBusy(busy: boolean): void {
		this.#busy = busy;
		this.#refresh();
	}

	setEnabled(enabled: boolean): void {
		this.#input.disabled = !enabled;
		this.#refresh();
	}

	setCommands(commands: AvailableSlashCommand[]): void {
		this.#commands = commands;
		this.#updatePopup();
	}

	setQueue(steering: string[], followUp: string[], liveSteered = 0): void {
		const chip = (text: string, queue: "steering" | "followUp", removable: boolean) => {
			const el = h(
				"div",
				{ className: `queue-chip ${queue}`, title: text },
				h("span", { className: "queue-kind" }, queue === "steering" ? "Steer" : "Queued"),
				h("span", { className: "queue-text" }, text),
			);
			if (removable) {
				const remove = button("×", "chip-remove", () => this.post({ type: "removeQueued", message: text, queue }));
				remove.title = "Remove from queue";
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
		close.title = "Dismiss";
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

	#onInput(): void {
		this.#dismissedFor = undefined;
		this.saveDraft(this.#input.value);
		this.#refresh();
		this.#updatePopup();
	}

	#refresh(): void {
		this.#input.style.height = "auto";
		this.#input.style.height = `${this.#input.scrollHeight}px`;
		const hasText = this.#input.value.trim() !== "";
		this.#stop.hidden = !this.#busy;
		this.#send.hidden = this.#busy && !hasText;
		this.#send.disabled = !hasText || this.#input.disabled;
		this.#send.title = this.#busy ? "Queue message (Enter)" : "Send (Enter)";
	}

	#submit(): void {
		const text = this.#input.value;
		if (text.trim() === "" || this.#input.disabled) return;
		this.post({ type: "prompt", text });
		this.#input.value = "";
		this.#onInput();
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
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			this.#submit();
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
