/** The git repositories file checkpoints cover: the ones containing or inside the workspace folders. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { git } from "./git";

/** Directories never searched for repositories: dependencies, environments, build output. */
const SKIPPED_DIRS = new Set([
	"node_modules",
	"venv",
	"env",
	"__pycache__",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
]);
const MAX_DEPTH = 4;
const MAX_DIRS = 4000;

/**
 * Root directories of the repositories that contain each of `roots` or sit
 * inside it (up to {@link MAX_DEPTH} levels down, skipping hidden and
 * dependency/build directories), deduplicated by real path and sorted.
 */
export async function discoverRepos(roots: readonly string[]): Promise<string[]> {
	const found = new Set<string>();
	const add = async (dir: string) => {
		found.add(await fs.realpath(dir).catch(() => path.resolve(dir)));
	};
	for (const root of roots) {
		const toplevel = await git(root, ["rev-parse", "--show-toplevel"]).then(
			output => output.trim(),
			() => undefined,
		);
		if (toplevel) await add(toplevel);
		const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
		for (let visited = 0; queue.length > 0 && visited < MAX_DIRS; visited++) {
			const { dir, depth } = queue.shift()!;
			const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
			if (depth > 0 && entries.some(entry => entry.name === ".git")) await add(dir);
			if (depth >= MAX_DEPTH) continue;
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) {
					queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
				}
			}
		}
	}
	return [...found].sort();
}
