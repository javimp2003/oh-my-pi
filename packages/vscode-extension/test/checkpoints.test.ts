import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "../src/checkpoints/git";
import { discoverRepos } from "../src/checkpoints/repos";
import { MAX_UNTRACKED_BYTES, restoreTurns, snapshotTree, undoRestore } from "../src/checkpoints/snapshots";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-checkpoints-")));
	dirs.push(dir);
	return dir;
}

/** A repository with one commit of `files`. */
async function repo(dir: string, files: Record<string, string>): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.email", "t@t"]);
	await git(dir, ["config", "user.name", "t"]);
	await write(dir, files);
	await git(dir, ["add", "-A"]);
	await git(dir, ["commit", "-qm", "init"]);
	return dir;
}

async function write(dir: string, files: Record<string, string>): Promise<void> {
	for (const [file, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		await fs.writeFile(path.join(dir, file), content);
	}
}

const read = (dir: string, file: string) => fs.readFile(path.join(dir, file), "utf8").catch(() => undefined);
const exists = (file: string) =>
	fs.stat(file).then(
		() => true,
		() => false,
	);
const lines = (count: number, edit: Record<number, string> = {}) =>
	`${Array.from({ length: count }, (_, index) => edit[index + 1] ?? String(index + 1)).join("\n")}\n`;
/** What `git status` and the index say, to prove snapshots and restores leave them alone. */
const gitState = async (dir: string) =>
	`${await git(dir, ["status", "--porcelain=v1", "--untracked-files=all"])}|${await git(dir, ["write-tree"])}|${await git(dir, ["rev-parse", "HEAD"])}`;

describe("snapshotTree", () => {
	it("captures tracked and untracked files without touching HEAD, the index or the status", async () => {
		const dir = await repo(await tempDir(), { "a.txt": "1\n", "b.txt": "b\n", ".gitignore": ".venv/\n" });
		await write(dir, { "b.txt": "staged\n" });
		await git(dir, ["add", "b.txt"]);
		await write(dir, { "a.txt": "unstaged\n", "new.txt": "untracked\n", ".venv/lib/site.py": "dep\n" });
		await fs.writeFile(path.join(dir, "big.bin"), Buffer.alloc(MAX_UNTRACKED_BYTES + 1));
		const before = await gitState(dir);

		const tree = await snapshotTree(dir);

		expect(await gitState(dir)).toBe(before);
		const files = (await git(dir, ["ls-tree", "-r", "--name-only", tree])).trim().split("\n");
		expect(files.sort()).toEqual([".gitignore", "a.txt", "b.txt", "new.txt"]);
		expect(await git(dir, ["show", `${tree}:a.txt`])).toBe("unstaged\n");
	});
});

describe("restoreTurns", () => {
	it("reverts only what changed during omp's turn, keeping later changes by others", async () => {
		const dir = await repo(await tempDir(), { "f.txt": lines(20), "g.txt": "g\n", "gone.txt": "gone\n" });
		const before = await snapshotTree(dir);
		// omp's turn: edits line 2, creates a file in a new directory, deletes a file.
		await write(dir, { "f.txt": lines(20, { 2: "agent" }), "src/gen/new.ts": "new\n" });
		await fs.rm(path.join(dir, "gone.txt"));
		const after = await snapshotTree(dir);
		// Later, the user (or another session): line 18 of the same file, and another file.
		await write(dir, { "f.txt": lines(20, { 2: "agent", 18: "user" }), "g.txt": "user\n" });
		const state = await gitState(dir);

		const preview = await restoreTurns(dir, [{ before, after }], { write: false });
		expect(preview.files.map(file => file.path).sort()).toEqual(["f.txt", "gone.txt", "src/gen/new.ts"]);
		expect(preview.conflicts).toEqual([]);
		expect(await gitState(dir)).toBe(state);

		await restoreTurns(dir, [{ before, after }], { write: true });
		expect(await read(dir, "f.txt")).toBe(lines(20, { 18: "user" }));
		expect(await read(dir, "g.txt")).toBe("user\n");
		expect(await read(dir, "gone.txt")).toBe("gone\n");
		expect(await exists(path.join(dir, "src"))).toBe(false);
	});

	it("reports a file edited by omp and by someone else on the same lines as a conflict, unless overwritten", async () => {
		const dir = await repo(await tempDir(), { "f.txt": lines(5) });
		const before = await snapshotTree(dir);
		await write(dir, { "f.txt": lines(5, { 2: "agent" }) });
		const after = await snapshotTree(dir);
		await write(dir, { "f.txt": lines(5, { 2: "agent and user" }) });

		const result = await restoreTurns(dir, [{ before, after }], { write: true });
		expect(result.conflicts).toEqual(["f.txt"]);
		expect(result.files).toEqual([]);
		expect(await read(dir, "f.txt")).toBe(lines(5, { 2: "agent and user" }));

		await restoreTurns(dir, [{ before, after }], { write: true, overwrite: new Set(["f.txt"]) });
		expect(await read(dir, "f.txt")).toBe(lines(5));
	});

	it("reverts several turns, keeping a change made between them", async () => {
		const dir = await repo(await tempDir(), { "a.txt": lines(10), "b.txt": "b\n" });
		const before1 = await snapshotTree(dir);
		await write(dir, { "a.txt": lines(10, { 1: "turn 1" }) });
		const after1 = await snapshotTree(dir);
		await write(dir, { "a.txt": lines(10, { 1: "turn 1", 9: "user" }), "b.txt": "user\n" });
		const before2 = await snapshotTree(dir);
		await write(dir, { "a.txt": lines(10, { 1: "turn 1", 5: "turn 2", 9: "user" }) });
		// The second turn never finished: the restore takes the work tree as its end.

		await restoreTurns(
			dir,
			[
				{ before: before1, after: after1 },
				{ before: before2, after: undefined },
			],
			{ write: true },
		);
		expect(await read(dir, "a.txt")).toBe(lines(10, { 9: "user" }));
		expect(await read(dir, "b.txt")).toBe("user\n");
	});

	it("leaves git-ignored files alone", async () => {
		const dir = await repo(await tempDir(), { ".gitignore": "venv/\n", "app.py": "v1\n" });
		const before = await snapshotTree(dir);
		await write(dir, { "app.py": "v2\n", "venv/lib/pkg.py": "installed\n" });
		const after = await snapshotTree(dir);

		await restoreTurns(dir, [{ before, after }], { write: true });
		expect(await read(dir, "app.py")).toBe("v1\n");
		expect(await read(dir, "venv/lib/pkg.py")).toBe("installed\n");
	});
});

describe("undoRestore", () => {
	it("puts back what the restore changed, except files edited since", async () => {
		const dir = await repo(await tempDir(), { "a.txt": "a\n", "b.txt": "b\n" });
		const before = await snapshotTree(dir);
		await write(dir, { "a.txt": "agent a\n", "b.txt": "agent b\n", "c.txt": "agent c\n" });
		const after = await snapshotTree(dir);
		const restored = await restoreTurns(dir, [{ before, after }], { write: true });
		await write(dir, { "b.txt": "edited after the restore\n" });

		const skipped = await undoRestore(dir, restored.current, restored.files);
		expect(skipped).toEqual(["b.txt"]);
		expect(await read(dir, "a.txt")).toBe("agent a\n");
		expect(await read(dir, "b.txt")).toBe("edited after the restore\n");
		expect(await read(dir, "c.txt")).toBe("agent c\n");
	});
});

describe("discoverRepos", () => {
	it("finds the repositories inside a folder and skips dependency directories", async () => {
		const root = await tempDir();
		const api = await repo(path.join(root, "api"), { "main.py": "x\n" });
		const web = await repo(path.join(root, "apps", "web"), { "index.ts": "x\n" });
		await repo(path.join(root, "api", "venv", "src", "pkg"), { "setup.py": "x\n" });
		await repo(path.join(root, "node_modules", "dep"), { "index.js": "x\n" });
		await write(root, { "notes.txt": "not in a repo\n" });

		expect(await discoverRepos([root])).toEqual([api, web].sort());
	});

	it("keeps a nested repository out of its parent's snapshots", async () => {
		const parent = await repo(await tempDir(), { "readme.md": "parent\n" });
		const child = await repo(path.join(parent, "child"), { "code.ts": "v1\n" });
		expect(await discoverRepos([parent])).toEqual([parent, child].sort());

		const before = await snapshotTree(parent);
		await write(child, { "code.ts": "v2\n" });
		const after = await snapshotTree(parent);
		const result = await restoreTurns(parent, [{ before, after }], { write: true });
		expect(result.files).toEqual([]);
		expect(await read(child, "code.ts")).toBe("v2\n");
	});
});
