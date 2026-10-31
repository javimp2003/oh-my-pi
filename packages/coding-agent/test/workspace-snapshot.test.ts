import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveWorkspaceSnapshot } from "@oh-my-pi/pi-coding-agent/utils/workspace-snapshot";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("resolveWorkspaceSnapshot", () => {
	it("detects package manager and verify scripts from a manifest root", async () => {
		using tempDir = TempDir.createSync("@omp-ws-snapshot-pkg-");
		const root = tempDir.join("project");
		await Bun.write(
			path.join(root, "package.json"),
			JSON.stringify({ scripts: { test: "bun test", lint: "oxlint", dev: "x" } }),
		);
		await Bun.write(path.join(root, "bun.lock"), "");
		await Bun.write(path.join(root, "src", "a.ts"), "export const a = 1;\n");

		const snapshot = await resolveWorkspaceSnapshot(root);

		expect(snapshot?.manifests).toContain("package.json");
		expect(snapshot?.packageManagers).toEqual(["bun"]);
		expect(snapshot?.verifyCommands).toEqual(["bun run test", "bun run lint"]);
	});

	it("returns null for a folder that only holds an AGENTS.md", async () => {
		using tempDir = TempDir.createSync("@omp-ws-snapshot-none-");
		const dir = tempDir.join("chats");
		await Bun.write(path.join(dir, "AGENTS.md"), "# general chats\n");

		expect(await resolveWorkspaceSnapshot(dir)).toBeNull();
	});

	it("resolves the project root and Makefile targets from a subdirectory", async () => {
		using tempDir = TempDir.createSync("@omp-ws-snapshot-make-");
		const root = tempDir.join("project");
		await Bun.write(path.join(root, "Makefile"), "build:\n\tcc main.c\ntest: build\n\t./run-tests\n");
		await Bun.write(path.join(root, "pkg", "src", "main.c"), "int main(void) { return 0; }\n");

		const snapshot = await resolveWorkspaceSnapshot(path.join(root, "pkg", "src"));

		expect(snapshot?.root).toBe(path.resolve(root));
		expect(snapshot?.verifyCommands).toEqual(["make test", "make build"]);
	});
});
