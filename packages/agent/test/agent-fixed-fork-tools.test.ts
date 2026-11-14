import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";
const model = buildModel({
	id: "open-model",
	name: "open-model",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});
function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} parent description`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}
describe("flat-prefix fork tools", () => {
	it("reuses the same embedded tool prompt when a model uses the GLM in-band dialect", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		let parentPrompt: string[] = [];
		const parent = new Agent({
			initialState: { model, systemPrompt: ["fixed"], tools: [tool("read"), tool("grep")] },
			dialect: "glm",
			getApiKey: () => "key",
			streamFn: (model, context, options) => {
				parentPrompt = [...(context.systemPrompt ?? [])];
				return mock.stream(model, context, options);
			},
		});
		await parent.prompt("inspect");
		let childPrompt: string[] = [];
		let childTools: Context["tools"];
		const child = new Agent({
			initialState: { model, systemPrompt: ["fixed"], tools: [tool("read"), tool("yield")] },
			dialect: "glm",
			pinnedToolDefinitions: parent.getLastWireToolDefinitions(),
			freezeToolDefinitions: true,
			getApiKey: () => "key",
			streamFn: (model, context, options) => {
				childPrompt = [...(context.systemPrompt ?? [])];
				childTools = context.tools;
				return mock.stream(model, context, options);
			},
		});
		await child.prompt("review");
		expect(childPrompt).toEqual(parentPrompt);
		expect(childTools).toBeUndefined();
	});

	it("sends exactly the latest parent wire list while refusing tools outside the child's executable scope", async () => {
		const parentMock = createMockModel({ handler: { content: ["parent done"] } });
		let parentTools: Tool[] = [];
		const parent = new Agent({
			initialState: { model, tools: [tool("read"), tool("todo")] },
			getApiKey: () => "key",
			streamFn: (model, context, options) => {
				parentTools = JSON.parse(JSON.stringify(context.tools ?? []));
				return parentMock.stream(model, context, options);
			},
		});
		await parent.prompt("first");
		parent.setTools([tool("read"), tool("grep")]);
		await parent.prompt("second");
		const snapshot = parent.getLastWireToolDefinitions();
		expect(snapshot.map(tool => tool.name)).toEqual(["read", "grep"]);
		const childMock = createMockModel({
			responses: [{ content: [{ type: "toolCall", name: "grep", arguments: {} }] }, { content: ["child done"] }],
		});
		const sent: Context[] = [];
		const child = new Agent({
			initialState: { model, tools: [tool("read"), tool("yield")], messages: parent.state.messages },
			pinnedToolDefinitions: snapshot,
			freezeToolDefinitions: true,
			getApiKey: () => "key",
			streamFn: (model, context, options) => {
				sent.push(JSON.parse(JSON.stringify(context)));
				return childMock.stream(model, context, options);
			},
		});
		await child.prompt("review");
		expect(sent[0]?.tools).toEqual(parentTools);
		expect(sent[1]?.tools).toEqual(parentTools);
		expect(
			child.state.messages.some(
				message => message.role === "toolResult" && message.toolName === "grep" && message.isError,
			),
		).toBe(true);
		const side = await child.buildSideRequestContext(sent[0]!.messages as Message[]);
		expect(JSON.parse(JSON.stringify(side.tools))).toEqual(parentTools);
	});
});
