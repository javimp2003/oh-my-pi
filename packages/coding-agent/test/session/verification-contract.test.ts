import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../../src/session/session-manager";
import { VerificationContracts } from "../../src/session/verification-contract";

const roots: TempDir[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) root.removeSync();
});
async function setup() {
	const root = TempDir.createSync("@omp-contract-");
	roots.push(root);
	await Bun.write(path.join(root.path(), "a.ts"), "export const value = 1;");
	const manager = SessionManager.inMemory(root.path());
	manager.appendMessage({ role: "user", content: "implement both paths", timestamp: 1 });
	const ledger = new VerificationContracts(manager);
	ledger.define([
		{ id: "sync", requirement: "sync decoding", command: "bun test sync", paths: ["a.ts"] },
		{ id: "async", requirement: "async decoding", command: "bun test async", paths: ["a.ts"] },
	]);
	return { root, manager, ledger };
}

describe("acceptance evidence", () => {
	it("requires each declared command, expires passed checks after source changes, and restores evidence on resume", async () => {
		const { ledger, manager, root } = await setup();
		await ledger.begin("sync-1", "bun test sync");
		ledger.finish("sync-1", true);
		expect((await ledger.status()).map(check => check.status)).toEqual(["passed", "pending"]);
		await ledger.begin("async-1", "bun test async");
		ledger.finish("async-1", false);
		expect((await ledger.status()).map(check => check.status)).toEqual(["passed", "failed"]);
		await ledger.begin("async-2", "bun test async");
		ledger.finish("async-2", true);
		await ledger.status();
		expect((await new VerificationContracts(manager).status()).map(check => check.status)).toEqual([
			"passed",
			"passed",
		]);
		await Bun.write(path.join(root.path(), "a.ts"), "export const value = 2;");
		expect((await ledger.status()).map(check => check.status)).toEqual(["stale", "stale"]);
	});
	it("rejects a successful test that overlaps an edit and cannot accept invented execution ids", async () => {
		const { ledger, root } = await setup();
		ledger.finish("invented", true);
		await ledger.begin("sync-1", "bun test sync");
		await Bun.write(path.join(root.path(), "a.ts"), "export const value = 2;");
		ledger.finish("sync-1", true);
		expect((await ledger.status()).map(check => check.status)).toEqual(["failed", "pending"]);
	});
	it("keeps obligations on a retry and clears them across a new request or branch reset", async () => {
		const { ledger, manager } = await setup();
		const initial = manager.getLeafId()!;
		expect(() => ledger.define([{ id: "easy", requirement: "easy only", command: "true", paths: ["a.ts"] }])).toThrow(
			"Keep existing verification check",
		);
		manager.appendMessage({ role: "user", content: "new task", timestamp: 2 });
		expect(await ledger.status()).toEqual([]);
		manager.branch(initial);
		expect((await ledger.status()).map(check => check.id)).toEqual(["sync", "async"]);
		manager.appendResetBoundary();
		expect(await ledger.status()).toEqual([]);
	});
	it("retains prior evidence when adding a requirement and hashes prototype-like filenames safely", async () => {
		const { ledger, root } = await setup();
		await ledger.begin("sync-1", "bun test sync");
		ledger.finish("sync-1", true);
		await ledger.status();
		await Bun.write(path.join(root.path(), "__proto__"), "before");
		ledger.define([
			...(await ledger.status()),
			{ id: "edge", requirement: "prototype-like filename", command: "bun test edge", paths: ["__proto__"] },
		]);
		expect((await ledger.status()).map(check => check.status)).toEqual(["passed", "pending", "pending"]);
		await ledger.begin("edge-1", "bun test edge");
		ledger.finish("edge-1", true);
		expect((await ledger.status())[2]?.status).toBe("passed");
		await Bun.write(path.join(root.path(), "__proto__"), "after");
		expect((await ledger.status())[2]?.status).toBe("stale");
	});

	it("does not accept a passing command from a different working directory", async () => {
		const { ledger, root } = await setup();
		await Bun.write(path.join(root.path(), "sub/a.ts"), "nested");
		await ledger.begin("wrong-cwd", "bun test sync", undefined, "sub");
		ledger.finish("wrong-cwd", true);
		expect((await ledger.status())[0]?.status).toBe("pending");
		ledger.define([
			...(await ledger.status()),
			{ id: "nested", requirement: "nested tests", command: "bun test nested", cwd: "sub", paths: ["sub/a.ts"] },
		]);
		await ledger.begin("right-cwd", "bun test nested", undefined, "sub");
		ledger.finish("right-cwd", true);
		expect((await ledger.status())[2]?.status).toBe("passed");
	});

	it("does not certify directories or allow workspace-escaping paths", async () => {
		const { ledger, manager, root } = await setup();
		await Bun.write(path.join(root.path(), "sub/a.ts"), "value");
		expect(() =>
			ledger.define([{ id: "bad", requirement: "external", command: "true", paths: ["../elsewhere"] }]),
		).toThrow("inside the workspace");
		manager.appendMessage({ role: "user", content: "directory check", timestamp: 2 });
		ledger.define([{ id: "dir", requirement: "directory is not a file snapshot", command: "true", paths: ["sub"] }]);
		await ledger.begin("dir-1", "true");
		ledger.finish("dir-1", true);
		expect((await ledger.status())[0]?.status).not.toBe("passed");
	});
});
