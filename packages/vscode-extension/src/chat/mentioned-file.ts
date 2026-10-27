/**
 * Where a file the agent cites may be on disk, before any filesystem check:
 * its `local://` scratch file, a `~`-relative or absolute path, or a path
 * relative to the folders the chat works in.
 */
import * as path from "node:path";

export interface MentionContext {
	/** Folders a relative path is tried against, in order. */
	roots: readonly string[];
	/** The chat's session file; its artifacts directory holds `local://` files. */
	sessionFile?: string;
	home: string;
}

/** Absolute paths to try for `file`, most likely first; empty when it cannot name a file. */
export function mentionCandidates(file: string, context: MentionContext): string[] {
	const candidates = candidatesFor(file, context);
	// Markdown links may percent-encode the path (`a%20b.md`).
	if (file.includes("%")) {
		let decoded: string | undefined;
		try {
			decoded = decodeURIComponent(file);
		} catch {}
		if (decoded !== undefined && decoded !== file) candidates.push(...candidatesFor(decoded, context));
	}
	return [...new Set(candidates)];
}

function candidatesFor(file: string, context: MentionContext): string[] {
	if (file.startsWith("local://")) {
		// omp keeps a session's `local://` files in `<session file without .jsonl>/local` (resolveLocalRoot).
		if (!context.sessionFile?.endsWith(".jsonl")) return [];
		const root = path.join(context.sessionFile.slice(0, -".jsonl".length), "local");
		let relative: string;
		try {
			relative = decodeURIComponent(file.slice("local://".length));
		} catch {
			return [];
		}
		const target = path.resolve(root, relative);
		const inside = path.relative(root, target);
		return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? [target] : [];
	}
	if (file === "~" || /^~[/\\]/.test(file)) return [path.join(context.home, file.slice(1))];
	if (path.isAbsolute(file)) return [file];
	return [...new Set(context.roots)].map(root => path.join(root, file));
}
