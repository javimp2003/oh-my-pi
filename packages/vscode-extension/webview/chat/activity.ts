/**
 * DOM-free wording of tool activity rows: the verb ("Ran", "Editing"…), the
 * subject a call acts on, and diff line counts.
 */

export type ToolStatus = "pending" | "running" | "done" | "error" | "interrupted" | "none";

/** Icon family of a tool's activity row. */
export type ToolFamily = "run" | "code" | "read" | "edit" | "search" | "web" | "task" | "plan" | "other";

/** Plan mode's approval device (`packages/coding-agent/src/tools/resolve.ts`). */
const PROPOSE_PATH = "xd://propose";

const PATH_TOOLS: Record<string, true> = {
	read: true,
	write: true,
	edit: true,
	notebook: true,
	ast_edit: true,
	lsp: true,
};
const PATTERN_TOOLS: Record<string, true> = { grep: true, glob: true, find: true, search: true, ast_grep: true };

/** `[done, running]` verbs by lowercase tool name (run tools use `RUNNERS`). */
const VERBS: Record<string, [done: string, running: string]> = {
	read: ["Read", "Reading"],
	edit: ["Edited", "Editing"],
	ast_edit: ["Edited", "Editing"],
	notebook: ["Edited", "Editing"],
	write: ["Wrote", "Writing"],
	grep: ["Searched", "Searching"],
	glob: ["Searched", "Searching"],
	find: ["Searched", "Searching"],
	search: ["Searched", "Searching"],
	ast_grep: ["Searched", "Searching"],
	web_search: ["Searched the web", "Searching the web"],
	fetch: ["Fetched", "Fetching"],
	web_fetch: ["Fetched", "Fetching"],
	task: ["Delegated", "Delegating"],
	lsp: ["Queried", "Querying"],
	todo: ["Updated plan", "Updating plan"],
	todo_write: ["Updated plan", "Updating plan"],
};

/** `value` when it is a non-blank string. */
export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** What a call acts on: a workspace file (`path`), a web page (`url`), or plain text. */
export interface ActivitySubject {
	text: string;
	path?: string;
	url?: string;
}

const WEB_URL = /^https?:\/\//i;
/** `scheme://…` other than `file:` (omp's internal `issue://`, `artifact://`… resources). */
const NON_FILE_URI = /^(?!file:)[a-z][a-z0-9+.-]*:\/\//i;

/** A path-like argument as a subject: web URLs link out, other URIs stay text, the rest open as files. */
function locationSubject(location: string): ActivitySubject {
	if (WEB_URL.test(location)) return { text: location, url: location };
	if (NON_FILE_URI.test(location)) return { text: location };
	return { text: location, path: location };
}

function toolFamily(tool: string, subject: ActivitySubject | undefined): ToolFamily {
	if (tool === "read") return subject?.url ? "web" : "read";
	if (tool === "edit" || tool === "ast_edit" || tool === "notebook" || tool === "write") return "edit";
	if (PATTERN_TOOLS[tool]) return "search";
	if (tool === "web_search" || tool === "fetch" || tool === "web_fetch") return "web";
	if (tool === "task") return "task";
	return "other";
}

/** One-line description of a call: the path, URL, command, pattern, query… it acts on. */
export function toolSubject(name: string, args: Record<string, unknown>): ActivitySubject | undefined {
	const tool = name.toLowerCase();
	// Patch-style edits name their file in the `input` header: `[path#TAG]` (hashline) or `*** Update File: path`.
	const input = str(args.input);
	const patched =
		input?.match(/^\[([^\]#\n]+)#[^\]\n]*\]/m)?.[1] ??
		input?.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1];
	const path = str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? patched?.trim();
	if (PATH_TOOLS[tool] && path) return locationSubject(path);
	if (PATTERN_TOOLS[tool]) {
		const pattern = str(args.pattern) ?? str(args.query);
		if (pattern && path) return { text: `${pattern}  in ${path}` };
		if (pattern) return { text: pattern };
		if (path) return locationSubject(path);
	}
	if (tool === "web_search") {
		const query = str(args.query);
		if (query) return { text: query };
	}
	if (tool === "fetch" || tool === "web_fetch") {
		const url = str(args.url);
		if (url) return locationSubject(url);
	}
	if (tool === "task") {
		const description = str(args.description) ?? str(args.agent) ?? str(args.subagent_type);
		if (description) return { text: description };
		if (Array.isArray(args.tasks)) return { text: `${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}` };
	}
	if (path) return locationSubject(path);
	for (const value of Object.values(args)) {
		const text = str(value);
		if (text && text.length <= 160 && !text.includes("\n")) return { text };
	}
	return undefined;
}

export interface ActivityLabel {
	verb: string;
	subject?: ActivitySubject;
	/** The subject is a command or pattern, shown in the editor font. */
	code: boolean;
	/** Picks the row's icon. */
	family: ToolFamily;
	/** Second, indented line: the command or code under a run row titled by its intent. */
	detail?: string;
}

/** Run tools: a fixed name instead of a verb, titled by the call's intent with the command beneath (as the TUI's compact rows). */
const RUNNERS: Record<string, { label: string; family: ToolFamily; prompt: string }> = {
	bash: { label: "Bash", family: "run", prompt: "$ " },
	shell: { label: "Bash", family: "run", prompt: "$ " },
	python: { label: "Code", family: "code", prompt: "" },
	eval: { label: "Code", family: "code", prompt: "" },
};

/** First non-blank line of the command (bash) or code (python/eval) a run tool executes. */
function runSource(args: Record<string, unknown>): string | undefined {
	const source = str(args.command) ?? str(args.cmd) ?? str(args.code);
	return source
		?.split("\n")
		.map(line => line.trim())
		.find(line => line !== "");
}

/**
 * Verb and subject of an activity row; the verb is progressive while the call is
 * pending or running. `intent` is the model's one-line purpose for the call.
 */
export function activityLabel(
	name: string,
	args: Record<string, unknown>,
	status: ToolStatus,
	intent?: string,
): ActivityLabel {
	const tool = name.toLowerCase();
	const running = status === "pending" || status === "running";
	// Plan mode submits its plan as a `write` of the plan title to `xd://propose`.
	if (tool === "write" && args.path === PROPOSE_PATH) {
		const title = str(args.content)?.trim();
		const verb = running ? "Proposing plan" : "Proposed plan";
		return title
			? { verb, subject: { text: title }, code: false, family: "plan" }
			: { verb, code: false, family: "plan" };
	}
	const runner = RUNNERS[tool];
	if (runner) {
		const source = runSource(args);
		const title = intent?.replace(/\s+/g, " ").trim();
		const { label: verb, family } = runner;
		if (title) {
			const label: ActivityLabel = { verb, subject: { text: title }, code: false, family };
			return source ? { ...label, detail: `${runner.prompt}${source}` } : label;
		}
		return source ? { verb, subject: { text: source }, code: true, family } : { verb, code: false, family };
	}
	const subject = toolSubject(name, args);
	const family = toolFamily(tool, subject);
	// `read` of a web URL is a fetch, not a file read.
	const verbs = tool === "read" && family === "web" ? VERBS.fetch : VERBS[tool];
	const verb = verbs ? verbs[running ? 1 : 0] : running ? `Calling ${name}` : `Called ${name}`;
	const code = PATTERN_TOOLS[tool] === true && subject !== undefined && !subject.path && !subject.url;
	return subject ? { verb, subject, code, family } : { verb, code, family };
}

export interface DiffStats {
	added: number;
	removed: number;
}

/** Added/removed line counts of a diff (`+5|text` / `-7|text` lines; `+++`/`---` headers excluded). */
export function diffStats(diff: string | undefined): DiffStats | undefined {
	if (!diff) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}
