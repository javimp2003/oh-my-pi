import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Text of every non-assistant message in a model request. */
function requestText(context: Context): string {
	return context.messages
		.filter(message => message.role !== "assistant")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
		)
		.join("\n");
}

describe("delegate mode", () => {
	let temp: TempDir | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		temp?.removeSync();
		temp = undefined;
	});

	async function start(toolNames?: string[]): Promise<{ session: AgentSession; requests: string[] }> {
		temp = TempDir.createSync("@omp-delegate-mode-");
		const cwd = temp.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const created = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			settings: await Settings.init({ inMemory: true, cwd }),
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			...(toolNames ? { toolNames, restrictToolNames: true } : {}),
		});
		session = created.session;
		const requests: string[] = [];
		const mock = createMockModel({
			handler: context => {
				requests.push(requestText(context));
				return { content: ["ok"] };
			},
		});
		session.agent.streamFn = mock.stream;
		return { session, requests };
	}

	test("steers prompts while on, then sends one exit notice after turning off", async () => {
		const { session, requests } = await start();
		expect(session.isDelegateModeAvailable()).toBe(true);
		expect(session.setDelegateMode(true)).toBe(true);

		await session.prompt("refactor the parser");
		expect(requests.at(-1)).toContain("<delegate-mode>");

		expect(session.setDelegateMode(false)).toBe(false);
		await session.prompt("next");
		const exitTurn = requests.at(-1) ?? "";
		expect(exitTurn).toContain("Delegate mode OFF");

		await session.prompt("again");
		const after = requests.at(-1) ?? "";
		// Earlier contexts stay in history; only no new context or notice is added.
		expect(after.split("Delegate mode OFF").length).toBe(exitTurn.split("Delegate mode OFF").length);
		expect(after.split("<delegate-mode>").length).toBe(exitTurn.split("<delegate-mode>").length);
	}, 30_000);

	test("cannot turn on without the task tool", async () => {
		const { session, requests } = await start(["read"]);
		expect(session.isDelegateModeAvailable()).toBe(false);
		expect(session.setDelegateMode(true)).toBe(false);
		await session.prompt("hello");
		expect(requests.at(-1)).not.toContain("<delegate-mode>");
	}, 30_000);
});
