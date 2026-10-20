import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandOutputStore } from "../src/chat/command-outputs";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-command-outputs-"));
	dirs.push(dir);
	return dir;
}

describe("CommandOutputStore", () => {
	it("keeps each session's outputs across restarts, in order, readable right after a write", async () => {
		const directory = await tempDir();
		const store = new CommandOutputStore(directory);
		const first = { timestamp: 1, text: "Shook out 3 tool results (12k tokens freed)" };
		const second = { timestamp: 2, text: "Compacted" };
		void store.add("/sessions/a.jsonl", first);
		void store.add("/sessions/a.jsonl", second);
		void store.add("/sessions/b.jsonl", { timestamp: 3, text: "other session" });
		// The reload after a /shake must already see its output, though the write was not awaited.
		expect(await store.load("/sessions/a.jsonl")).toEqual([first, second]);

		const restarted = new CommandOutputStore(directory);
		expect(await restarted.load("/sessions/a.jsonl")).toEqual([first, second]);
		await restarted.remove("/sessions/a.jsonl");
		expect(await restarted.load("/sessions/a.jsonl")).toEqual([]);
		expect(await restarted.load("/sessions/b.jsonl")).toEqual([{ timestamp: 3, text: "other session" }]);
	});
});
