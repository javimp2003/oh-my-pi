import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("buildSystemPrompt coding guidance", () => {
	it("uses the general prompt without coding rules or snapshot when coding guidance is off", async () => {
		using tempDir = TempDir.createSync("@omp-coding-guidance-off-");
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir.path(),
			skills: [],
			contextFiles: [],
			codingGuidance: false,
		});
		const text = systemPrompt.join("\n");

		expect(text).toContain("- Compiled code: NEVER avoidable allocation, copying, computation.");
		expect(text).not.toContain("NEVER fake success");
		expect(text).not.toContain("Same region fails twice");
		expect(text).not.toContain("<workspace>");
	});

	it("uses the coding prompt and renders the workspace snapshot when coding guidance is on", async () => {
		using tempDir = TempDir.createSync("@omp-coding-guidance-on-");
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir.path(),
			skills: [],
			contextFiles: [],
			codingGuidance: true,
			workspaceSnapshot: {
				root: tempDir.path(),
				branch: "main",
				status: "clean",
				commits: ["abc123 init"],
				manifests: ["package.json"],
				packageManagers: ["bun"],
				verifyCommands: ["bun run test"],
			},
		});
		const text = systemPrompt.join("\n");

		expect(text).toContain("NEVER fake success");
		expect(text).toContain("Same region fails twice");
		expect(text).toContain("<workspace>");
		expect(text).toContain("- Branch: main");
		expect(text).toContain("- Verify: bun run test");
	});
});
