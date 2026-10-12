/**
 * Reads omp's session files for one workspace without starting omp.
 *
 * Layout (packages/coding-agent/src/session): `<agentDir>/sessions/<bucket>/<stamp>_<id>.jsonl`,
 * an optional sibling artifacts directory without the extension, and inside
 * each file a fixed-width `type:"title"` slot line, the `type:"session"`
 * header, then entries (`type:"message"` carries `message.role`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionSummary {
	path: string;
	id: string;
	/** Title set by omp (auto-generated or renamed by the user). */
	title?: string;
	/** First line of the first user prompt. */
	firstMessage?: string;
	modified: Date;
	/** User + assistant messages found in the scanned prefix; a lower bound for long sessions. */
	messageCount: number;
	/** The prefix ended before the file did, so `messageCount` is partial. */
	truncated: boolean;
}

/** Bytes read from each file: covers the title, header, and first prompts of nearly every session. */
const SCAN_BYTES = 64 * 1024;

/** Display label: the title, else the first prompt, else the file name. */
export function sessionLabel(session: SessionSummary): string {
	return session.title || session.firstMessage || path.basename(session.path, ".jsonl");
}

export function relativeTime(date: Date): string {
	const seconds = Math.round((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return date.toLocaleDateString();
}

/** Sessions in `dir`, newest first; sessions without a single prompt are skipped. */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const sessions = await Promise.all(
		names
			.filter(name => name.endsWith(".jsonl"))
			.map(name => readSummary(path.join(dir, name)).catch(() => undefined)),
	);
	return sessions
		.filter((session): session is SessionSummary => session !== undefined && session.messageCount > 0)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function readSummary(file: string): Promise<SessionSummary> {
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat();
		const buffer = Buffer.alloc(Math.min(SCAN_BYTES, stat.size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead < stat.size;
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const lines = text.split("\n");
		// A cut-off final line is not valid JSON; drop it rather than guess.
		if (truncated) lines.pop();
		const summary: SessionSummary = {
			path: file,
			id: path.basename(file, ".jsonl").split("_").pop() ?? "",
			modified: stat.mtime,
			messageCount: 0,
			truncated,
		};
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: { type?: string; title?: string; id?: string; message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "title") {
				if (entry.title?.trim()) summary.title = entry.title.trim();
			} else if (entry.type === "session") {
				if (entry.id) summary.id = entry.id;
			} else if (entry.type === "message") {
				const role = entry.message?.role;
				if (role !== "user" && role !== "assistant") continue;
				summary.messageCount++;
				if (role === "user" && summary.firstMessage === undefined) {
					const prompt = promptText(entry.message?.content);
					if (prompt) summary.firstMessage = prompt;
				}
			}
		}
		return summary;
	} finally {
		await handle.close();
	}
}

function promptText(content: unknown): string | undefined {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((block): block is { type: "text"; text: string } => block?.type === "text")
						.map(block => block.text)
						.join(" ")
				: "";
	const firstLine = text.trim().split("\n")[0]?.trim();
	return firstLine ? firstLine.slice(0, 200) : undefined;
}

/** The session file and its artifacts directory (omp deletes both together). */
export function sessionPaths(file: string): string[] {
	return [file, file.slice(0, -".jsonl".length)];
}

/**
 * Best-effort bucket for `cwd` when no omp process has reported its session
 * file yet (mirrors `getDefaultSessionDirName`: home-relative paths become
 * `-a-b`, other absolute paths `--abs-path--`; omp's temp-dir special case is
 * not replicated).
 */
export async function guessSessionDir(sessionsRoot: string, cwd: string): Promise<string> {
	const resolved = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
	const relative = path.relative(home, resolved);
	const inHome = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	const name = inHome
		? `-${relative.replace(/[/\\:]/g, "-")}`
		: `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(sessionsRoot, name);
}
