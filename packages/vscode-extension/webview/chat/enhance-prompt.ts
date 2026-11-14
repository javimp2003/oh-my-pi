/**
 * "Mejorar prompt": the sparkles button in the composer footer and the proposal
 * card above the composer. The button sends the draft to omp (`enhancePrompt`),
 * which rewrites it once, outside the session and without tools, for clarity
 * only. While it works the draft is read-only and Esc or the button again cancel.
 * An improved draft comes back as a card: the editable proposal, its word diff
 * against the draft, what changed and what is still ambiguous. Nothing is sent:
 * "Usar propuesta" only puts the proposal in the composer, "Descartar" drops it.
 */
import type { ChatRequest, ChatUpdate, EnhancePromptResult } from "../../src/protocol";
import { button, h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";

type Post = (request: ChatRequest) => void;

/** What the composer lends the enhancer. */
export interface EnhancePromptHost {
	/** The draft as shown (compact `@name` mentions included). */
	draft(): string;
	/** Paths of the draft's `@` mentions. */
	mentions(): string[];
	/** A request went out (`true`) or settled: the draft is read-only meanwhile. */
	setRunning(running: boolean): void;
	/** Put the accepted proposal in the composer in place of the draft. */
	apply(text: string): void;
	notice(level: "info" | "warning" | "error", message: string): void;
	focus(): void;
}

const LABEL = "Mejorar prompt";
const LABEL_RUNNING = "Mejorando… (Esc para cancelar)";
/** Past this many token pairs the diff shows the whole texts as replaced instead of aligning them. */
const MAX_DIFF_CELLS = 4_000_000;

interface Proposal {
	/** The draft the proposal rewrites. */
	original: string;
	result: EnhancePromptResult;
}

type DiffOp = "same" | "del" | "ins";

export class EnhancePrompt {
	readonly button: HTMLButtonElement;
	readonly card = h("section", {
		className: "enhance-prompt",
		ariaLabel: "Propuesta de prompt mejorado",
		hidden: true,
	});
	#text = h("textarea", {
		className: "enhance-prompt-input",
		ariaLabel: "Propuesta de prompt mejorado",
		spellcheck: false,
	});
	#diff = h("div", { className: "enhance-prompt-diff", hidden: true });
	#useButton = button("Usar propuesta", "skill-proposal-approve", () => this.#use());
	#discardButton = button("Descartar", "skill-proposal-secondary", () => {
		this.#close();
		this.host.focus();
	});
	#nextId = 0;
	/** The request on its way and the draft it was sent for. */
	#pending: { requestId: string; draft: string } | undefined;
	#proposal: Proposal | undefined;
	/** The draft changed after the shown proposal was asked for. */
	#stale = false;
	#diffOpen = false;
	#available = false;

	constructor(
		private readonly post: Post,
		private readonly host: EnhancePromptHost,
	) {
		this.button = h(
			"button",
			{ type: "button", className: "icon-button enhance-prompt-toggle", ariaLabel: LABEL },
			icon("sparkles"),
		);
		setTooltip(this.button, LABEL);
		setTooltip(this.#useButton, "Poner la propuesta en el cuadro de mensaje (no se envía)");
		this.button.addEventListener("click", () => (this.#pending ? this.cancel() : this.#start()));
		// Only the parts that follow the text change: re-rendering the card would take the focus away.
		this.#text.addEventListener("input", () => {
			this.#fitText();
			if (this.#diffOpen) this.#renderDiff();
			this.#useButton.disabled = this.#stale || this.#text.value.trim() === "";
		});
		this.card.addEventListener("keydown", event => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			this.#close();
			this.host.focus();
		});
	}

	/** A request is on its way. */
	get running(): boolean {
		return this.#pending !== undefined;
	}

	/**
	 * The composer's draft or enabled state changed: whether there is a prompt to improve
	 * (not empty, not only a slash command, composer usable), and whether the shown proposal still fits it.
	 */
	sync(draft: string, enabled: boolean): void {
		this.#available = enabled && draft.trim() !== "" && !/^\s*\/\S+\s*$/.test(draft);
		this.button.disabled = !this.#pending && !this.#available;
		const proposal = this.#proposal;
		if (proposal && (draft !== proposal.original) !== this.#stale) {
			this.#stale = !this.#stale;
			this.#render();
		}
	}

	/** Esc in the composer: cancel a running request, else close the card. False when there was nothing to do. */
	escape(): boolean {
		if (this.#pending) {
			this.cancel();
			return true;
		}
		if (!this.#proposal) return false;
		this.#close();
		return true;
	}

	/** Stop the running request; the draft stays as it is. */
	cancel(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.post({ type: "enhancePromptCancel", requestId: pending.requestId });
		this.#settle();
		this.host.notice("info", "Mejora cancelada");
	}

	/** omp answered the request `update.requestId`. */
	result(update: Extract<ChatUpdate, { type: "enhancePromptResult" }>): void {
		const pending = this.#pending;
		if (pending?.requestId !== update.requestId) return;
		this.#settle();
		const { result } = update;
		if (result.status === "invalid") {
			this.host.notice("warning", "La propuesta alteraba contenido literal y se descartó");
			return;
		}
		if (result.status === "unchanged") {
			const review =
				result.ambiguities.length > 0 ? ` Revisa antes de enviar: ${result.ambiguities.join("; ")}` : "";
			this.host.notice("info", `Tu prompt ya es claro; no hay cambios.${review}`);
			return;
		}
		this.#proposal = { original: pending.draft, result };
		this.#stale = this.host.draft() !== pending.draft;
		this.#diffOpen = false;
		this.#text.value = result.prompt;
		this.card.hidden = false;
		this.#render();
		this.#fitText();
	}

	/** The request `update.requestId` failed (or omp reports it cancelled). */
	error(update: Extract<ChatUpdate, { type: "enhancePromptError" }>): void {
		if (this.#pending?.requestId !== update.requestId) return;
		this.#settle();
		if (update.cancelled) this.host.notice("info", "Mejora cancelada");
		else this.host.notice("error", `No se pudo mejorar el prompt: ${update.message}`);
	}

	#start(): void {
		if (!this.#available) return;
		const draft = this.host.draft();
		const requestId = `enhance-${Date.now()}-${this.#nextId++}`;
		this.#close();
		this.#pending = { requestId, draft };
		this.button.classList.add("running");
		this.button.ariaBusy = "true";
		setTooltip(this.button, LABEL_RUNNING);
		this.button.ariaLabel = LABEL_RUNNING;
		this.host.setRunning(true);
		this.post({ type: "enhancePrompt", requestId, draft, mentions: this.host.mentions() });
	}

	/** The request is over (answered, failed or cancelled): the button and the draft are back to normal. */
	#settle(): void {
		this.#pending = undefined;
		this.button.classList.remove("running");
		this.button.ariaBusy = "false";
		setTooltip(this.button, LABEL);
		this.button.ariaLabel = LABEL;
		this.button.disabled = !this.#available;
		this.host.setRunning(false);
	}

	#close(): void {
		this.#proposal = undefined;
		this.#stale = false;
		this.card.hidden = true;
		this.card.replaceChildren();
	}

	#use(): void {
		const text = this.#text.value;
		if (this.#stale || text.trim() === "") return;
		this.#close();
		this.host.apply(text);
	}

	#render(): void {
		const proposal = this.#proposal;
		if (!proposal) return;
		const { result } = proposal;
		const close = button("×", "notice-close", () => {
			this.#close();
			this.host.focus();
		});
		setTooltip(close, "Descartar");
		const toggle = h(
			"button",
			{ type: "button", className: "skill-proposal-toggle", ariaExpanded: String(this.#diffOpen) },
			icon(this.#diffOpen ? "chevronDown" : "chevronRight"),
			this.#diffOpen ? "Ocultar cambios" : "Ver cambios",
		);
		toggle.addEventListener("click", () => {
			this.#diffOpen = !this.#diffOpen;
			if (this.#diffOpen) this.#renderDiff();
			this.#render();
		});
		this.#diff.hidden = !this.#diffOpen;
		this.#useButton.disabled = this.#stale || this.#text.value.trim() === "";
		this.card.classList.toggle("stale", this.#stale);
		const children = [
			h(
				"div",
				{ className: "skills-proposals-head enhance-prompt-head" },
				icon("sparkles"),
				h("span", { className: "skills-proposals-title" }, "Propuesta de prompt mejorado"),
				this.#stale ? h("span", { className: "skill-off" }, "Desactualizada") : null,
				h("span", { className: "enhance-prompt-model", dataset: { tooltip: result.model } }, result.model),
				close,
			),
			this.#stale
				? h(
						"p",
						{ className: "skill-proposal-reason" },
						"Has cambiado el borrador después de pedir la mejora: esta propuesta ya no corresponde a él.",
					)
				: null,
			this.#text,
			toggle,
			this.#diff,
			list("Cambios", result.changes, "enhance-prompt-changes"),
			list("Revisa antes de enviar", result.ambiguities, "enhance-prompt-ambiguities"),
			result.lengthWarning
				? h("p", { className: "enhance-prompt-warning" }, "La propuesta amplía bastante el texto")
				: null,
			h("div", { className: "skill-proposal-actions" }, this.#useButton, this.#discardButton),
		];
		this.card.replaceChildren(...children.filter(child => child !== null));
	}

	/** Word diff from the draft to the proposal as it stands in the card. */
	#renderDiff(): void {
		const proposal = this.#proposal;
		if (!proposal) return;
		this.#diff.replaceChildren(
			...wordDiff(proposal.original, this.#text.value).map(([op, text]) =>
				op === "same" ? text : h("span", { className: `enhance-prompt-diff-${op}` }, text),
			),
		);
	}

	/** Grow the proposal box with its text, up to its CSS max-height. */
	#fitText(): void {
		this.#text.style.height = "auto";
		this.#text.style.height = `${this.#text.scrollHeight + 2}px`;
	}
}

/** A titled bullet list, or nothing when `items` is empty. */
function list(title: string, items: string[], className: string): HTMLElement | null {
	if (items.length === 0) return null;
	return h(
		"div",
		{ className: `enhance-prompt-list ${className}` },
		h("span", { className: "enhance-prompt-list-title" }, title),
		h("ul", null, ...items.map(item => h("li", null, item))),
	);
}

/**
 * Edits turning `before` into `after`, by words: the longest common subsequence of
 * their word and whitespace tokens, with consecutive tokens of one kind merged.
 */
function wordDiff(before: string, after: string): [DiffOp, string][] {
	const a = before.split(/(\s+)/).filter(token => token !== "");
	const b = after.split(/(\s+)/).filter(token => token !== "");
	const ops: [DiffOp, string][] = [];
	const push = (op: DiffOp, text: string) => {
		const last = ops.at(-1);
		if (last?.[0] === op) last[1] += text;
		else ops.push([op, text]);
	};
	if (a.length * b.length > MAX_DIFF_CELLS) {
		if (before) push("del", before);
		if (after) push("ins", after);
		return ops;
	}
	// lengths[i * (m + 1) + j]: LCS length of a[i..] and b[j..].
	const n = a.length;
	const m = b.length;
	const lengths = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lengths[i * (m + 1) + j] =
				a[i] === b[j]
					? lengths[(i + 1) * (m + 1) + j + 1]! + 1
					: Math.max(lengths[(i + 1) * (m + 1) + j]!, lengths[i * (m + 1) + j + 1]!);
		}
	}
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			push("same", a[i]!);
			i++;
			j++;
		} else if (lengths[(i + 1) * (m + 1) + j]! >= lengths[i * (m + 1) + j + 1]!) {
			push("del", a[i++]!);
		} else {
			push("ins", b[j++]!);
		}
	}
	while (i < n) push("del", a[i++]!);
	while (j < m) push("ins", b[j++]!);
	return ops;
}
