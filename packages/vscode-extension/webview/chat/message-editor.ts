/**
 * Inline editor for a sent prompt: replaces the user bubble with a textarea and
 * Cancel / Send. Sending hands the text to the transcript and waits: the
 * conversation reloading removes the editor, and `reopen()` (the host did not
 * resend) makes it editable again.
 */
import { button, h } from "../dom";

export class MessageEditor {
	readonly #message: HTMLElement;
	readonly #editor: HTMLElement;
	readonly #input: HTMLTextAreaElement;
	readonly #send: HTMLButtonElement;
	readonly #cancel: HTMLButtonElement;
	#sending = false;

	/**
	 * @param message the `.msg.user` element; its children are hidden while editing
	 * @param onSend called with the new text; `onClose` when the editor goes away without sending
	 */
	constructor(
		message: HTMLElement,
		text: string,
		private readonly onSend: (text: string) => void,
		private readonly onClose: () => void,
	) {
		this.#message = message;
		this.#input = h("textarea", {
			className: "message-editor-input",
			rows: 1,
			value: text,
			ariaLabel: "Edit message",
		});
		this.#cancel = button("Cancel", "secondary-button", () => this.close());
		this.#send = button("Send", "primary-button", () => this.#submit());
		// Images of the message go along unchanged; show them so that is visible.
		const thumbs = message.querySelector(".thumbs")?.cloneNode(true) ?? null;
		this.#editor = h(
			"div",
			{ className: "message-editor" },
			this.#input,
			thumbs,
			h("div", { className: "message-editor-actions" }, this.#cancel, this.#send),
		);
		this.#input.addEventListener("input", () => this.#refresh());
		this.#input.addEventListener("keydown", event => {
			if (event.isComposing || event.keyCode === 229) return;
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.#submit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.close();
			}
		});
		message.classList.add("editing");
		message.append(this.#editor);
		this.#refresh();
		this.#input.focus();
		this.#input.setSelectionRange(text.length, text.length);
	}

	/** The host did not resend (declined, vetoed, or failed): editable again. */
	reopen(): void {
		this.#sending = false;
		this.#refresh();
		this.#input.focus();
	}

	/** Leave edit mode and show the original bubble again. */
	close(): void {
		if (this.#sending) return;
		this.#editor.remove();
		this.#message.classList.remove("editing");
		this.onClose();
	}

	#submit(): void {
		const text = this.#input.value;
		if (this.#sending || !this.#canSend()) return;
		this.#sending = true;
		this.#refresh();
		this.onSend(text);
	}

	#canSend(): boolean {
		return this.#input.value.trim() !== "" || this.#editor.querySelector(".thumbs") !== null;
	}

	#refresh(): void {
		this.#input.style.height = "auto";
		this.#input.style.height = `${this.#input.scrollHeight}px`;
		this.#input.disabled = this.#sending;
		this.#cancel.disabled = this.#sending;
		this.#send.disabled = this.#sending || !this.#canSend();
		this.#send.textContent = this.#sending ? "Sending…" : "Send";
	}
}
