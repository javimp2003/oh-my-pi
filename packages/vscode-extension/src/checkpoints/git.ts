/** Minimal `git` runner for file checkpoints (no VS Code dependency). */
import { spawn } from "node:child_process";

export class GitError extends Error {
	constructor(
		readonly args: readonly string[],
		message: string,
	) {
		super(message);
		this.name = "GitError";
	}
}

export interface GitOptions {
	/** Extra environment, e.g. `GIT_INDEX_FILE` for a temporary index. */
	env?: Record<string, string>;
	/** Written to stdin. */
	input?: string;
}

/**
 * Run `git args` in `cwd` and resolve to its stdout. Pathspecs are literal
 * (`GIT_LITERAL_PATHSPECS`), so file names with `*` or `:` need no escaping,
 * and optional locks are off so read commands never refresh the user's index.
 */
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("git", args, {
		cwd,
		env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.on("error", reject);
	child.on("close", code => {
		if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
		else {
			const message = Buffer.concat(stderr).toString("utf8").trim();
			reject(new GitError(args, message || `git ${args[0]} exited with code ${code}`));
		}
	});
	child.stdin.on("error", () => {});
	child.stdin.end(options.input ?? "");
	return promise;
}

let available: Promise<boolean> | undefined;

/** Whether a `git` executable is on the PATH (checked once). */
export function gitAvailable(): Promise<boolean> {
	available ??= git(process.cwd(), ["--version"]).then(
		() => true,
		() => false,
	);
	return available;
}
