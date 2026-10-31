import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("SDK directory context", () => {
	it("lists subdirectory AGENTS.md files with the workspace tree disabled", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-dir-context-");
		const cwd = tempDir.join("project");
		await Bun.write(path.join(cwd, "src", "AGENTS.md"), "rules");
		await Bun.write(path.join(cwd, "README.md"), "readme");

		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd,
				agentDir: tempDir.join("agent"),
				authStorage,
				modelRegistry,
				settings: Settings.isolated(),
				sessionManager: SessionManager.inMemory(cwd),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			session = result.session;
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain("<dir-context>");
			expect(prompt).toContain("src/AGENTS.md");
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
