/**
 * Tool cards: one collapsible card per tool call, keyed by `toolCallId`. The
 * header shows the tool name, a one-line subject derived from the arguments,
 * and the execution status; the body holds the arguments and the (live or
 * final) result.
 */
import type { ImageContent } from "../../src/protocol";
import { button, h } from "../dom";
import { fileLink, imageSrc } from "./content";

export type ToolStatus = "pending" | "running" | "done" | "error" | "interrupted" | "none";

const MAX_LINES = 200;
const PATH_TOOLS: Record<string, true> = {
	read: true,
	write: true,
	edit: true,
	notebook: true,
	ast_edit: true,
	lsp: true,
};
const PATTERN_TOOLS: Record<string, true> = { grep: true, glob: true, find: true, search: true, ast_grep: true };
const STATUS_LABEL: Record<ToolStatus, string> = {
	pending: "",
	running: "",
	done: "✓",
	error: "✗",
	interrupted: "–",
	none: "",
};
const STATUS_TITLE: Record<ToolStatus, string> = {
	pending: "Preparing",
	running: "Running",
	done: "Done",
	error: "Failed",
	interrupted: "Interrupted",
	none: "",
};

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** One-line description of a call: the path, command, pattern, query… it acts on. */
function toolSubject(name: string, args: Record<string, unknown>): { text: string; path?: string } | undefined {
	const tool = name.toLowerCase();
	// Patch-style edits name their file in the `input` header: `[path#TAG]` (hashline) or `*** Update File: path`.
	const input = str(args.input);
	const patched =
		input?.match(/^\[([^\]#\n]+)#[^\]\n]*\]/m)?.[1] ??
		input?.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1];
	const path = str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? patched?.trim();
	if (PATH_TOOLS[tool] && path) return { text: path, path };
	if (tool === "bash" || tool === "shell") {
		const command = str(args.command) ?? str(args.cmd);
		if (command) return { text: command.split("\n")[0] ?? command };
	}
	if (PATTERN_TOOLS[tool]) {
		const pattern = str(args.pattern) ?? str(args.query);
		if (pattern && path) return { text: `${pattern}  in ${path}` };
		if (pattern) return { text: pattern };
		if (path) return { text: path, path };
	}
	if (tool === "web_search") {
		const query = str(args.query);
		if (query) return { text: query };
	}
	if (tool === "fetch" || tool === "web_fetch") {
		const url = str(args.url);
		if (url) return { text: url };
	}
	if (tool === "task") {
		const description = str(args.description) ?? str(args.agent) ?? str(args.subagent_type);
		if (description) return { text: description };
		if (Array.isArray(args.tasks)) return { text: `${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}` };
	}
	if (path) return { text: path, path };
	for (const value of Object.values(args)) {
		const text = str(value);
		if (text && text.length <= 160 && !text.includes("\n")) return { text };
	}
	return undefined;
}

/** Text, images, and diff extracted from a tool result (`{content, details}`, a string, or anything else). */
interface ResultParts {
	text: string;
	images: ImageContent[];
	diff?: string;
}

export function toolResultParts(result: unknown): ResultParts {
	if (result === undefined || result === null) return { text: "", images: [] };
	if (typeof result === "string") return { text: result, images: [] };
	if (typeof result !== "object") return { text: String(result), images: [] };
	const record = result as { content?: unknown; details?: unknown };
	if (!Array.isArray(record.content)) return { text: JSON.stringify(result, null, 2), images: [] };
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of record.content as Array<{ type?: string; text?: unknown }>) {
		if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
		else if (block?.type === "image") images.push(block as unknown as ImageContent);
	}
	const details = record.details as { diff?: unknown } | undefined;
	const diff = details && typeof details === "object" ? str(details.diff) : undefined;
	return { text: texts.join("\n"), images, diff };
}

/** `<pre>` showing at most `MAX_LINES` lines, with a button revealing the rest. */
export function truncatedPre(text: string, className: string, lineClass?: (line: string) => string | undefined) {
	const pre = h("pre", { className: className });
	const lines = text.replace(/\n+$/, "").split("\n");
	const fill = (count: number) => {
		pre.replaceChildren();
		const shown = lines.slice(0, count);
		if (!lineClass) {
			pre.textContent = shown.join("\n");
			return;
		}
		for (const line of shown) pre.append(h("span", { className: lineClass(line) }, `${line}\n`));
	};
	fill(MAX_LINES);
	if (lines.length <= MAX_LINES) return pre;
	const more = button(`Show ${lines.length - MAX_LINES} more lines`, "link-button show-more", () => {
		fill(lines.length);
		more.remove();
	});
	return h("div", null, pre, more);
}

function diffLineClass(line: string): string | undefined {
	if (line.startsWith("+")) return "diff-add";
	if (line.startsWith("-")) return "diff-del";
	if (line.startsWith("@@")) return "diff-hunk";
	return undefined;
}

export class ToolCard {
	readonly element: HTMLDetailsElement;
	#name = h("span", { className: "tool-name" });
	#subject = h("span", { className: "tool-subject" });
	#status = h("span", { className: "tool-status" });
	#args = h("div", { className: "tool-args" });
	#result = h("div", { className: "tool-result" });
	#argsKey = "";
	#resultKey = "";

	constructor(label?: string) {
		const summary = h("summary", { className: "tool-header" }, this.#status, this.#name, this.#subject);
		if (label) summary.append(h("span", { className: "tool-label" }, label));
		this.element = h(
			"details",
			{ className: "tool-card" },
			summary,
			h("div", { className: "tool-body" }, this.#args, this.#result),
		);
		this.setStatus("pending");
	}

	setCall(name: string, args: Record<string, unknown>, intent?: string): void {
		const key = `${name}\u0000${JSON.stringify(args)}\u0000${intent ?? ""}`;
		if (key === this.#argsKey) return;
		this.#argsKey = key;
		this.#name.textContent = name;
		// omp's harness-internal `i` argument is the model's one-line purpose for the call.
		const purpose = intent ?? str(args.i);
		const subject = toolSubject(name, args);
		this.#subject.replaceChildren(subject?.path ? fileLink(subject.path, subject.text) : (subject?.text ?? ""));
		this.#subject.title = purpose ?? subject?.text ?? "";
		const command = str(args.command) ?? str(args.cmd);
		const input = str(args.input);
		const shown: Record<string, true> = { command: true, cmd: true, i: true, input: true };
		const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !shown[k]));
		const children: Node[] = [];
		if (purpose) children.push(h("div", { className: "tool-intent" }, purpose));
		if (command) children.push(truncatedPre(`$ ${command}`, "tool-pre"));
		if (input) children.push(truncatedPre(input, "tool-pre"));
		if (Object.keys(rest).length > 0) children.push(truncatedPre(JSON.stringify(rest, null, 2), "tool-pre muted"));
		this.#args.replaceChildren(...children);
	}

	setStatus(status: ToolStatus): void {
		this.element.dataset.status = status;
		this.#status.textContent = STATUS_LABEL[status];
		this.#status.title = STATUS_TITLE[status];
	}

	get status(): ToolStatus {
		return this.element.dataset.status as ToolStatus;
	}

	/** Show a partial or final result; the status is left to the caller. */
	setResult(result: unknown): void {
		const parts = toolResultParts(result);
		const key = `${parts.text}\u0000${parts.diff ?? ""}\u0000${parts.images.length}`;
		if (key === this.#resultKey) return;
		this.#resultKey = key;
		const children: Node[] = [];
		if (parts.diff) children.push(truncatedPre(parts.diff, "tool-pre diff", diffLineClass));
		if (parts.text) children.push(truncatedPre(parts.text, "tool-pre"));
		for (const image of parts.images) children.push(h("img", { className: "thumb", src: imageSrc(image), alt: "" }));
		this.#result.replaceChildren(...children);
	}
}
