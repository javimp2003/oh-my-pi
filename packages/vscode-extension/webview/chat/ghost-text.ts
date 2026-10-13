/**
 * Predictive ghost text in the composer, as in omp's terminal editor: while a
 * prose word is typed, omp's word prediction (`predict_word`, the engine of
 * `spelling.autocomplete`, which learns from the prompt history) suggests how
 * it ends, painted in grey after the caret. `Tab` accepts it with a space,
 * `→` without one; typing letters of it shortens it, typing anything else
 * drops it. Like the terminal, accepted suggestions and ones typed past are
 * reported back (`predict_word_feedback`) so the engine keeps learning.
 *
 * A textarea cannot colour part of its text, so a mirror behind it repeats
 * the draft in transparent text, wrapped the same way, with the suggestion
 * visible after the caret. omp gates what is asked (the caret must end a prose
 * word at the end of its line; code, paths and slash commands get nothing),
 * and a failed or slow prediction simply shows nothing.
 */
import type { ChatRequest } from "../../src/protocol";
import { h } from "../dom";

type Post = (request: ChatRequest) => void;

/** Computed styles the mirror copies so its text wraps exactly like the textarea's. */
const MIRRORED_STYLES = [
	"fontFamily",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"lineHeight",
	"letterSpacing",
	"wordSpacing",
	"tabSize",
	"textIndent",
	"textTransform",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
] as const;

interface Suggestion {
	/** The draft and caret it is shown for. */
	text: string;
	cursor: number;
	suffix: string;
}

export class GhostText {
	readonly element: HTMLElement;
	#mirror = h("div", { className: "ghost-mirror", ariaHidden: "true", hidden: true });
	#nextId = 1;
	/** The request whose answer may still be shown; older answers are dropped. */
	#pending: { id: number; text: string; cursor: number } | undefined;
	#shown: Suggestion | undefined;
	#enabled = true;

	constructor(
		private readonly input: HTMLTextAreaElement,
		private readonly post: Post,
	) {
		this.element = h("div", { className: "ghost-wrap" }, this.#mirror, input);
		input.addEventListener("scroll", () => {
			this.#mirror.scrollTop = input.scrollTop;
		});
		// A caret moved away by mouse or keys leaves the word: the suggestion no longer applies.
		input.addEventListener("pointerup", () => this.#hideIfCaretMoved());
		input.addEventListener("keyup", event => {
			if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") this.#hideIfCaretMoved();
		});
		input.addEventListener("blur", () => this.#hide());
	}

	/** Off while the composer cannot take text (dictation, disabled input). */
	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
		if (!enabled) {
			this.#pending = undefined;
			this.#hide();
		}
	}

	/** The draft changed (typing, paste, accepted suggestion): shorten or drop the suggestion, then ask again. */
	onInput(): void {
		const shown = this.#shown;
		if (shown) {
			const { value, selectionStart, selectionEnd } = this.input;
			const typed = selectionStart === selectionEnd ? insertedAt(shown, value, selectionStart) : undefined;
			const overlap = typed === undefined ? 0 : Math.min(typed.length, shown.suffix.length);
			const matches =
				typed !== undefined &&
				shown.suffix.slice(0, overlap).toLocaleLowerCase() === typed.slice(0, overlap).toLocaleLowerCase();
			if (typed !== undefined && matches && typed.length < shown.suffix.length) {
				this.#show({ text: value, cursor: selectionStart, suffix: shown.suffix.slice(typed.length) });
			} else {
				// Characters that diverge from the suggestion reject it; deleting or pasting elsewhere does not.
				if (typed !== undefined && !matches) this.#feedback(shown, false);
				this.#hide();
			}
		}
		this.#request();
	}

	/**
	 * Accept the shown suggestion for `Tab` (with a trailing space) or `→`
	 * (without). Returns whether the key was used.
	 */
	accept(event: KeyboardEvent): boolean {
		const shown = this.#shown;
		if (!shown || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
		if (event.key !== "Tab" && event.key !== "ArrowRight") return false;
		if (this.input.selectionStart !== shown.cursor || this.input.selectionEnd !== shown.cursor) return false;
		event.preventDefault();
		this.#feedback(shown, true);
		const insert = event.key === "Tab" ? `${shown.suffix} ` : shown.suffix;
		this.#hide();
		// `insertText` keeps the edit undoable and fires `input`, which asks for the next word.
		if (!document.execCommand("insertText", false, insert)) {
			this.input.setRangeText(insert, shown.cursor, shown.cursor, "end");
			this.input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		return true;
	}

	/** omp answered a prediction. */
	onPrediction(requestId: number, suffix: string | null): void {
		const pending = this.#pending;
		if (!pending || pending.id !== requestId) return;
		this.#pending = undefined;
		const { value, selectionStart, selectionEnd } = this.input;
		if (!suffix || value !== pending.text || selectionStart !== pending.cursor || selectionEnd !== pending.cursor) {
			return;
		}
		if (!this.#enabled || document.activeElement !== this.input) return;
		this.#show({ text: value, cursor: selectionStart, suffix });
	}

	/** The draft was sent or replaced: forget everything. */
	reset(): void {
		this.#pending = undefined;
		this.#hide();
	}

	#request(): void {
		const { value, selectionStart, selectionEnd } = this.input;
		this.#pending = undefined;
		if (!this.#enabled || selectionStart !== selectionEnd || !value.trim()) return;
		// omp only completes a word at the end of its line; skip the round trip otherwise.
		const lineEnd = value.indexOf("\n", selectionStart);
		if ((lineEnd < 0 ? value.length : lineEnd) !== selectionStart) return;
		const id = this.#nextId++;
		this.#pending = { id, text: value, cursor: selectionStart };
		this.post({ type: "predictWord", requestId: id, text: value, cursor: selectionStart });
	}

	#hideIfCaretMoved(): void {
		const shown = this.#shown;
		if (!shown) return;
		if (this.input.selectionStart !== shown.cursor || this.input.selectionEnd !== shown.cursor) this.#hide();
	}

	#feedback(shown: Suggestion, accepted: boolean): void {
		this.post({
			type: "predictWordFeedback",
			text: shown.text,
			cursor: shown.cursor,
			suggestion: shown.suffix,
			accepted,
		});
	}

	#show(suggestion: Suggestion): void {
		this.#shown = suggestion;
		this.#syncStyles();
		const before = suggestion.text.slice(0, suggestion.cursor);
		const after = suggestion.text.slice(suggestion.cursor);
		this.#mirror.replaceChildren(
			h("span", { className: "ghost-typed" }, before),
			h("span", { className: "ghost-suggestion" }, suggestion.suffix),
			// A trailing line break needs content after it to take up its line, as in the textarea.
			h("span", { className: "ghost-typed" }, `${after}\u200b`),
		);
		this.#mirror.hidden = false;
		this.#mirror.scrollTop = this.input.scrollTop;
	}

	#hide(): void {
		this.#shown = undefined;
		this.#mirror.hidden = true;
		this.#mirror.replaceChildren();
	}

	#syncStyles(): void {
		const style = getComputedStyle(this.input);
		const mirror = this.#mirror.style;
		for (const property of MIRRORED_STYLES) mirror[property] = style[property];
		// The textarea's scrollbar narrows its text; the mirror wraps at the same width.
		mirror.width = `${this.input.clientWidth}px`;
		mirror.height = `${this.input.clientHeight}px`;
	}
}

/**
 * The text inserted at `shown`'s caret to give `value` with the caret at
 * `cursor`, or undefined when the draft changed some other way.
 */
function insertedAt(shown: Suggestion, value: string, cursor: number): string | undefined {
	const head = shown.text.slice(0, shown.cursor);
	const tail = shown.text.slice(shown.cursor);
	if (cursor <= shown.cursor || value.length - cursor !== tail.length) return undefined;
	if (!value.startsWith(head) || !value.endsWith(tail)) return undefined;
	return value.slice(shown.cursor, cursor);
}
