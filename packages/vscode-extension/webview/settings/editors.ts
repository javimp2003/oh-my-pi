/**
 * Value editors for one setting, by type. Every editor commits the string
 * form `omp config set <key> <value>` expects; the row owns save errors.
 */
import type { SettingEntry } from "../../src/protocol";
import { h } from "../dom";
import { effectiveValue } from "./model";

export interface EditorCallbacks {
	/** Send a new value (verbatim argument for `omp config set`). */
	commit(value: string): void;
	/** The user touched the control; clears the row's previous save error. */
	edited(): void;
}

/** Class of the focusable control inside every editor (focus survives row re-renders). */
export const CONTROL_CLASS = "editor-control";

type SettingOption = NonNullable<NonNullable<SettingEntry["ui"]>["options"]>[number];

/** The control for a boolean setting; the row wraps it in a label with the description. */
export function createCheckbox(entry: SettingEntry, callbacks: EditorCallbacks): HTMLInputElement {
	const checkbox = h("input", {
		type: "checkbox",
		className: CONTROL_CLASS,
		checked: effectiveValue(entry) === true,
	});
	checkbox.addEventListener("change", () => {
		callbacks.edited();
		callbacks.commit(checkbox.checked ? "true" : "false");
	});
	return checkbox;
}

/** Editor for every non-boolean type. */
export function createEditor(entry: SettingEntry, callbacks: EditorCallbacks): HTMLElement {
	switch (entry.type) {
		case "enum":
			return enumEditor(entry, callbacks);
		case "array":
		case "record":
			return jsonEditor(entry, callbacks);
		case "number":
		case "string":
		case "boolean":
			return textEditor(entry, callbacks);
	}
}

function enumEditor(entry: SettingEntry, callbacks: EditorCallbacks): HTMLElement {
	const options: SettingOption[] = entry.ui?.options
		? [...entry.ui.options]
		: (entry.values ?? []).map(value => ({ value, label: value }));
	const current = String(effectiveValue(entry) ?? "");
	if (!options.some(option => option.value === current)) {
		options.unshift({ value: current, label: current || "(not set)" });
	}
	const select = h(
		"select",
		{ className: CONTROL_CLASS },
		...options.map(option =>
			h("option", {
				value: option.value,
				textContent: option.label,
				title: option.description ?? "",
				selected: option.value === current,
			}),
		),
	);
	const hint = h("div", { className: "hint" });
	const showHint = () => {
		hint.textContent = options.find(option => option.value === select.value)?.description ?? "";
		hint.hidden = !hint.textContent;
	};
	showHint();
	select.addEventListener("change", () => {
		showHint();
		callbacks.edited();
		callbacks.commit(select.value);
	});
	return h("div", { className: "editor" }, select, hint);
}

/** Text input for strings and numbers; commits on Enter or blur, Escape reverts. */
function textEditor(entry: SettingEntry, callbacks: EditorCallbacks): HTMLElement {
	const isNumber = entry.type === "number";
	const current = entry.redacted ? "" : String(effectiveValue(entry) ?? "");
	const input = h("input", {
		type: entry.redacted ? "password" : isNumber ? "number" : "text",
		className: CONTROL_CLASS,
		value: current,
		placeholder: entry.redacted ? "•••• (set)" : "Not set",
		spellcheck: false,
		autocomplete: "off",
	});
	if (isNumber) input.step = "any";

	const editor = h("div", { className: "editor" }, input);
	const options = (entry.ui?.options ?? []).filter(option => !isNumber || Number.isFinite(Number(option.value)));
	if (options.length > 0) {
		const listId = `options-${entry.key}`;
		input.setAttribute("list", listId);
		editor.append(
			h(
				"datalist",
				{ id: listId },
				...options.map(option => h("option", { value: option.value, label: option.label })),
			),
		);
	}
	const hint = h("div", { className: "hint" });
	const showHint = () => {
		const text = input.value.trim();
		const match = options.find(option => (isNumber ? Number(option.value) === Number(text) : option.value === text));
		hint.textContent = text && match ? [match.label, match.description].filter(Boolean).join(" — ") : "";
		hint.hidden = !hint.textContent;
	};
	showHint();
	editor.append(hint);

	let lastSent = current;
	const commit = () => {
		const text = isNumber ? input.value.trim() : input.value;
		if (text === lastSent) return;
		if (entry.redacted && text === "") return;
		if (isNumber && (text === "" || !Number.isFinite(Number(text)))) {
			input.value = lastSent;
			showHint();
			return;
		}
		lastSent = text;
		callbacks.commit(text);
	};
	input.addEventListener("input", () => {
		showHint();
		callbacks.edited();
	});
	input.addEventListener("keydown", event => {
		if (event.key === "Enter") {
			event.preventDefault();
			commit();
		} else if (event.key === "Escape") {
			input.value = lastSent;
			showHint();
		}
	});
	input.addEventListener("blur", commit);
	return editor;
}

/** JSON textarea for arrays and records; validates before committing on blur or Ctrl/Cmd+Enter. */
function jsonEditor(entry: SettingEntry, callbacks: EditorCallbacks): HTMLElement {
	const isArray = entry.type === "array";
	const value = effectiveValue(entry) ?? (isArray ? [] : {});
	const current = entry.redacted ? "" : JSON.stringify(value, null, 2);
	const textarea = h("textarea", {
		className: `${CONTROL_CLASS} json`,
		value: current,
		placeholder: entry.redacted ? "•••• (set) — type JSON to replace" : isArray ? "[]" : "{}",
		spellcheck: false,
	});
	const fitRows = () => {
		textarea.rows = Math.min(16, Math.max(2, textarea.value.split("\n").length));
	};
	fitRows();
	const parseError = h("div", { className: "error", hidden: true });
	const editor = h("div", { className: "editor" }, textarea, parseError);

	const options = entry.ui?.options ?? [];
	if (options.length > 0) {
		editor.append(
			h(
				"div",
				{ className: "hint" },
				"Values: ",
				...options.flatMap((option, i) => [
					i > 0 ? ", " : "",
					h("code", {
						textContent: option.value,
						title: [option.label, option.description].filter(Boolean).join(" — "),
					}),
				]),
			),
		);
	}
	editor.append(h("div", { className: "hint" }, "JSON. Saved when the field loses focus or on Ctrl+Enter."));

	/** Parsed value, or an error message for invalid JSON / the wrong shape. */
	const validate = (): { value: unknown } | { error: string } => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(textarea.value);
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
		if (isArray && !Array.isArray(parsed)) return { error: 'Expected a JSON array, e.g. ["a", "b"]' };
		if (!isArray && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
			return { error: 'Expected a JSON object, e.g. {"key": "value"}' };
		}
		return { value: parsed };
	};
	const showValidation = () => {
		const result = entry.redacted && textarea.value.trim() === "" ? { value: undefined } : validate();
		parseError.textContent = "error" in result ? result.error : "";
		parseError.hidden = !("error" in result);
		textarea.classList.toggle("invalid", "error" in result);
		return result;
	};

	let lastSent = JSON.stringify(entry.redacted ? undefined : value);
	const commit = () => {
		if (entry.redacted && textarea.value.trim() === "") return;
		const result = showValidation();
		if ("error" in result) return;
		const json = JSON.stringify(result.value);
		if (json === lastSent) return;
		lastSent = json;
		callbacks.commit(json);
	};
	textarea.addEventListener("input", () => {
		fitRows();
		showValidation();
		callbacks.edited();
	});
	textarea.addEventListener("keydown", event => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			commit();
		}
	});
	textarea.addEventListener("blur", commit);
	return editor;
}
