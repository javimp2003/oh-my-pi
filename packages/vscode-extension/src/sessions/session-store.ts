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
	/** First line of the latest user prompt; absent when it could not be found near the end of a huge file. */
	lastMessage?: string;
	/** The first prompt is also the latest one: the session has a single prompt. */
	singlePrompt: boolean;
	modified: Date;
	/** User + assistant messages found in the scanned prefix; a lower bound for long sessions. */
	messageCount: number;
	/** The prefix ended before the file did, so `messageCount` is partial. */
	truncated: boolean;
}

/** Bytes read from each file: covers the title, header, and first prompts of nearly every session. */
const SCAN_BYTES = 64 * 1024;
/** The latest prompt of a longer file is searched backwards from its end in chunks of this size… */
const TAIL_CHUNK_BYTES = 256 * 1024;
/** …up to this far back (long tool outputs can follow the last prompt). */
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

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
		.filter(
			(session): session is SessionSummary =>
				// A first prompt with an image can fill the whole prefix: its message is found later.
				session !== undefined && (session.messageCount > 0 || session.firstMessage !== undefined),
		)
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
			singlePrompt: false,
		};
		// Prompts are told apart by the byte offset of their line.
		let firstOffset: number | undefined;
		let last: { offset: number; text: string } | undefined;
		let offset = 0;
		for (const line of lines) {
			const lineOffset = offset;
			offset += Buffer.byteLength(line) + 1;
			if (!line.trim()) continue;
			let entry: SessionLine;
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
				const prompt = userPrompt(entry);
				if (prompt === undefined) continue;
				if (firstOffset === undefined) {
					firstOffset = lineOffset;
					summary.firstMessage = prompt;
				}
				last = { offset: lineOffset, text: prompt };
			}
		}
		if (truncated) {
			// A first prompt carrying an image can be a line longer than the whole prefix.
			if (firstOffset === undefined) {
				const first = await findFirstPrompt(handle, stat.size);
				firstOffset = first?.offset;
				summary.firstMessage = first?.text;
			}
			last = await findLastPrompt(handle, stat.size);
		}
		summary.lastMessage = last?.text;
		summary.singlePrompt = last !== undefined && last.offset === firstOffset;
		return summary;
	} finally {
		await handle.close();
	}
}

interface SessionLine {
	type?: string;
	title?: string;
	id?: string;
	message?: { role?: string; content?: unknown; synthetic?: boolean };
}

/** The first line of a prompt the user wrote (not a synthetic user message omp injects). */
function userPrompt(entry: SessionLine): string | undefined {
	if (entry.type !== "message" || entry.message?.role !== "user" || entry.message.synthetic) return undefined;
	return promptText(entry.message.content);
}

/** A user prompt in a line of the session file, or undefined (cheap check before parsing). */
function promptInLine(line: string): string | undefined {
	if (!line.includes('"user"')) return undefined;
	try {
		return userPrompt(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/** The first prompt of a long file, read forwards in chunks up to {@link MAX_TAIL_BYTES}. */
async function findFirstPrompt(
	handle: fs.FileHandle,
	size: number,
): Promise<{ offset: number; text: string } | undefined> {
	/** Chunks of the line being read, until its end turns up. */
	let parts: Buffer[] = [];
	let lineOffset = 0;
	for (let position = 0; position < size && position < MAX_TAIL_BYTES;) {
		const chunk = Buffer.alloc(Math.min(TAIL_CHUNK_BYTES, size - position));
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
		if (bytesRead === 0) break;
		const data = chunk.subarray(0, bytesRead);
		let from = 0;
		for (let newline = data.indexOf(0x0a); newline >= 0; newline = data.indexOf(0x0a, from)) {
			const line = Buffer.concat([...parts, data.subarray(from, newline)]).toString("utf8");
			const prompt = promptInLine(line);
			if (prompt !== undefined) return { offset: lineOffset, text: prompt };
			parts = [];
			lineOffset = position + newline + 1;
			from = newline + 1;
		}
		parts.push(data.subarray(from));
		position += bytesRead;
	}
	return undefined;
}

/**
 * The latest prompt of a file too long to read whole: lines are read
 * backwards from the end, up to {@link MAX_TAIL_BYTES}, and only lines that
 * can be a user message are parsed.
 */
async function findLastPrompt(
	handle: fs.FileHandle,
	size: number,
): Promise<{ offset: number; text: string } | undefined> {
	let end = size;
	/** Bytes of a line cut by the previous chunk's start, joined with the next chunk read. */
	let carry = Buffer.alloc(0);
	while (end > 0 && size - end < MAX_TAIL_BYTES) {
		const start = Math.max(0, end - TAIL_CHUNK_BYTES);
		const chunk = Buffer.alloc(end - start);
		await handle.read(chunk, 0, chunk.length, start);
		const data = Buffer.concat([chunk, carry]);
		// Unless the chunk starts the file, its first line may be cut: keep it for the next round.
		const firstNewline = start === 0 ? -1 : data.indexOf(0x0a);
		if (firstNewline < 0 && start > 0) {
			carry = data;
			end = start;
			continue;
		}
		carry = data.subarray(0, firstNewline + 1);
		let lineEnd = data.length;
		while (lineEnd > firstNewline + 1) {
			const newline = data.lastIndexOf(0x0a, lineEnd - 1);
			const lineStart = Math.max(newline + 1, firstNewline + 1);
			const line = data.subarray(lineStart, lineEnd).toString("utf8");
			lineEnd = lineStart - 1;
			const prompt = promptInLine(line);
			if (prompt !== undefined) return { offset: start + lineStart, text: prompt };
		}
		end = start;
	}
	return undefined;
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
