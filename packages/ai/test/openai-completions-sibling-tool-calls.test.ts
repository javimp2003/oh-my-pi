import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// OpenAI-compatible gateways (LiteLLM-fronted vLLM serving GLM observed) stream
// parallel tool calls under one reused `index` — or with no keys at all — so
// index/currentBlock routing appended the second call's arguments to the first
// (`{...}{...}`) and the merged call failed with "Unexpected trailing characters".

const model = buildModel({
	id: "test-model",
	name: "Test",
	api: "openai-completions",
	provider: "litellm",
	baseUrl: "http://127.0.0.1:4000/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

type ToolCallDelta = {
	index?: number;
	id?: string;
	type?: "function";
	function: { name?: string; arguments?: string };
};

function fetchFor(deltas: readonly ToolCallDelta[]): FetchImpl {
	const frames: unknown[] = [
		...deltas.map(delta => ({
			id: "c",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { tool_calls: [delta] } }],
		})),
		{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		"[DONE]",
	];
	const body = frames.map(f => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
	return Object.assign(
		async (): Promise<Response> => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		{ preconnect: fetch.preconnect },
	);
}

async function toolCalls(deltas: readonly ToolCallDelta[]) {
	const msg = await streamOpenAICompletions(model, context, { apiKey: "k", fetch: fetchFor(deltas) }).result();
	expect(msg.stopReason).toBe("toolUse");
	return msg.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
}

describe("openai-completions sibling tool calls sharing a stream key", () => {
	it("splits parallel calls that reuse index 0 with distinct ids", async () => {
		const calls = await toolCalls([
			{ index: 0, id: "chatcmpl-tool-A", type: "function", function: { name: "bash", arguments: "" } },
			{ index: 0, function: { arguments: '{"command":"a"}' } },
			{ index: 0, id: "chatcmpl-tool-B", type: "function", function: { name: "bash", arguments: "" } },
			{ index: 0, function: { arguments: '{"command":"b"}' } },
		]);
		expect(calls).toEqual([
			{ id: "chatcmpl-tool-A", name: "bash", arguments: { command: "a" } },
			{ id: "chatcmpl-tool-B", name: "bash", arguments: { command: "b" } },
		]);
	});

	it("splits an id-less second call whose arguments open after a complete buffer", async () => {
		const calls = await toolCalls([
			{ index: 0, function: { name: "bash", arguments: '{"command":"a"}' } },
			{ index: 0, function: { arguments: '{"command":"b"}' } },
		]);
		expect(calls.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual([
			{ name: "bash", arguments: { command: "a" } },
			{ name: "bash", arguments: { command: "b" } },
		]);
	});

	it("splits two calls whose boundary arrives inside one arguments chunk", async () => {
		const calls = await toolCalls([
			{ index: 0, id: "A", type: "function", function: { name: "bash", arguments: '{"command":"a' } },
			{ index: 0, function: { arguments: '"}{"command":"b"}' } },
		]);
		expect(calls.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual([
			{ name: "bash", arguments: { command: "a" } },
			{ name: "bash", arguments: { command: "b" } },
		]);
		expect(calls[0]?.id).toBe("A");
	});

	it("splits on a different tool name once the current call is complete", async () => {
		const calls = await toolCalls([
			{ index: 0, id: "A", function: { name: "read", arguments: '{"path":"x"}' } },
			{ index: 0, function: { name: "bash", arguments: "" } },
			{ index: 0, function: { arguments: '{"command":"b"}' } },
		]);
		expect(calls.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual([
			{ name: "read", arguments: { path: "x" } },
			{ name: "bash", arguments: { command: "b" } },
		]);
	});

	it("keeps a `{`-starting continuation inside a string on the same call", async () => {
		const calls = await toolCalls([
			{ index: 0, id: "A", function: { name: "bash", arguments: '{"command":"echo ' } },
			{ index: 0, function: { arguments: '{1..3}"}' } },
		]);
		expect(calls).toEqual([{ id: "A", name: "bash", arguments: { command: "echo {1..3}" } }]);
	});

	it("keeps one call when a host mints a new id on every chunk mid-arguments", async () => {
		const calls = await toolCalls([
			{ index: 0, id: "A", function: { name: "bash", arguments: '{"comm' } },
			{ index: 0, id: "B", function: { arguments: 'and":"a"}' } },
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ name: "bash", arguments: { command: "a" } });
	});
});
