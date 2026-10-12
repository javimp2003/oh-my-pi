import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { guessSessionDir, listSessions, sessionLabel } from "../src/sessions/session-store";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-sessions-"));
	dirs.push(dir);
	return dir;
}

/** A session file as omp writes it: fixed-width title slot, header, then entries. */
function sessionFile(options: { title?: string; id: string; prompts: string[]; padding?: number }): string {
	const slot = JSON.stringify({ type: "title", v: 1, title: options.title ?? "", updatedAt: "x", pad: "" });
	const lines = [slot, JSON.stringify({ type: "session", version: 3, id: options.id, cwd: "/w" })];
	for (const prompt of options.prompts) {
		lines.push(
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } }),
		);
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(options.padding ?? 10) }] },
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

describe("listSessions", () => {
	it("lists sessions newest first, labelled by title or first prompt, skipping empty ones", async () => {
		const dir = await tempDir();
		const older = path.join(dir, "2026-01-01_a.jsonl");
		const newer = path.join(dir, "2026-01-02_b.jsonl");
		await fs.writeFile(older, sessionFile({ id: "a", prompts: ["first line\nsecond line", "later"] }));
		await fs.writeFile(newer, sessionFile({ title: "Named session", id: "b", prompts: ["hello"] }));
		await fs.writeFile(path.join(dir, "2026-01-03_c.jsonl"), sessionFile({ id: "c", prompts: [] }));
		await fs.utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
		await fs.utimes(newer, new Date("2026-01-02"), new Date("2026-01-02"));

		const sessions = await listSessions(dir);

		expect(sessions.map(session => session.id)).toEqual(["b", "a"]);
		expect(sessions.map(sessionLabel)).toEqual(["Named session", "first line"]);
		expect(sessions[1]).toMatchObject({ messageCount: 4, truncated: false });
	});

	it("reads only a prefix of long sessions and reports the count as partial", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "2026-01-01_long.jsonl");
		await fs.writeFile(file, sessionFile({ id: "long", prompts: ["start", "more", "even more"], padding: 40_000 }));

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({ id: "long", firstMessage: "start", truncated: true });
		expect(session!.messageCount).toBeLessThan(6);
	});

	it("returns nothing for a directory that does not exist yet", async () => {
		expect(await listSessions(path.join(await tempDir(), "missing"))).toEqual([]);
	});
});

describe("guessSessionDir", () => {
	it("encodes home-relative and absolute workspaces like omp's session buckets", async () => {
		const root = "/sessions";
		const home = await fs.realpath(os.homedir());
		expect(await guessSessionDir(root, home)).toBe(path.join(root, "-"));
		expect(await guessSessionDir(root, path.join(home, "Documents", "proj"))).toBe(
			path.join(root, "-Documents-proj"),
		);
		const outside = await tempDir();
		const resolved = await fs.realpath(outside);
		expect(await guessSessionDir(root, outside)).toBe(
			path.join(root, `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`),
		);
	});
});
