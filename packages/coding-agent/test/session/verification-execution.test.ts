import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { ModelRegistry } from "../../src/config/model-registry";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { VerificationTool } from "../../src/tools/verification";
const roots: TempDir[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) root.removeSync();
});

it("records evidence through the real agent pre-tool and result boundaries without manually registering an execution", async () => {
	const root = TempDir.createSync("@omp-verification-execution-");
	roots.push(root);
	await Bun.write(path.join(root.path(), "a.ts"), "export const value = 1;");
	const manager = SessionManager.inMemory(root.path());
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
	const verify = new VerificationTool({
		cwd: root.path(),
		settings,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		sessionManager: manager,
		getVerificationContracts: () => session?.verificationContracts,
	});
	let executions = 0;
	const bash: AgentTool = {
		name: "bash",
		label: "Check",
		description: "fixture check",
		parameters: type({ command: "string" }),
		execute: async () => {
			executions++;
			return { content: [{ type: "text", text: "1 pass" }], details: {} };
		},
	};
	const model = buildModel({
		id: "mock",
		name: "mock",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
	const mock = createMockModel({
		responses: [
			{
				content: [
					{
						type: "toolCall",
						name: "verification",
						arguments: {
							op: "define",
							checks: [{ id: "decode", requirement: "decode", command: "bun test", paths: ["a.ts"] }],
						},
					},
				],
			},
			{ content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }] },
			{ content: ["completed"] },
		],
	});
	// Agent validates the concrete schema before dispatch; the registry erases it.
	const tools: AgentTool[] = [verify as unknown as AgentTool, bash];
	const agent = new Agent({
		initialState: { model, tools },
		convertToLlm,
		streamFn: mock.stream,
		getApiKey: () => "test",
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		modelRegistry: {
			getApiKey: async () => "test",
			getAvailable: () => [],
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry,
	});
	try {
		await session.prompt("Implement and verify decoding");
		await session.waitForIdle();
		expect(executions).toBe(1);
		expect((await session.verificationContracts.status()).map(check => check.status)).toEqual(["passed"]);
	} finally {
		await session.dispose();
	}
});
