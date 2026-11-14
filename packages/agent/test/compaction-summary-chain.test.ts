import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	compact,
	createCompactionContextMessages,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getCompactionSummaryChain,
	type CompactionPreparation,
	type CompactionDetails,
	type CompactionResult,
	type SummaryOptions,
} from "@oh-my-pi/pi-agent-core/compaction";
import { defaultConvertToLlm as convertToLlm } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1,
		provider: "mock",
		model: "mock",
		api: "mock",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function preparation(
	text: string,
	previous?: CompactionResult,
	overrides: Partial<CompactionPreparation["settings"]> = {},
): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [{ role: "user", content: text, timestamp: 2 }],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent", timestamp: 3 }],
		isSplitTurn: false,
		tokensBefore: 20000,
		fileOps: createFileOps(),
		previousSummary: previous?.summary,
		previousPreserveData: previous?.preserveData,
		previousDetails: previous?.details as CompactionDetails | undefined,
		previousSummaryTimestamp: "2026-11-01T00:00:00.000Z",
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false, summaryChainEnabled: true, ...overrides },
	};
}
function harness() {
	const requests: Array<{ context: Context; options: SimpleStreamOptions }> = [];
	const options: SummaryOptions = {
		promptCacheKey: "cache-affinity",
		sessionId: "isolated-session",
		oneshotRetry: false,
		buildProviderContext: async (history: AgentMessage[]) => ({
			systemPrompt: ["fixed repository map"],
			tools: [],
			messages: convertToLlm(history),
		}),
		completeImpl: async (_model, context, options) => {
			requests.push({ context, options });
			return assistant(`Outcome ${requests.length}`);
		},
	};
	return { requests, options };
}
function replay(result: CompactionResult) {
	return convertToLlm(
		createCompactionContextMessages(result.summary, result.tokensBefore, "2026-11-12T00:00:00Z", result.preserveData),
	);
}

describe("incremental compaction", () => {
	test("preserves the previous provider prefix and summarizes only new raw history", async () => {
		const { requests, options } = harness();
		const first = await compact(preparation("Keep PROJ-12 unchanged"), model, "test", undefined, undefined, options);
		const firstPrefix = replay(first);
		const second = await compact(preparation("Now fix PROJ-13", first), model, "test", undefined, undefined, options);
		expect(replay(second).slice(0, firstPrefix.length)).toEqual(firstPrefix);
		expect(replay(second)).toHaveLength(2);
		const secondRequest = requests[2]!;
		expect(secondRequest.context.systemPrompt).toEqual(["fixed repository map"]);
		expect(secondRequest.context.messages.slice(0, firstPrefix.length)).toEqual(firstPrefix);
		expect(
			secondRequest.context.messages.filter(
				message => message.role === "user" && message.content === "Keep PROJ-12 unchanged",
			),
		).toHaveLength(0);
		expect(
			secondRequest.context.messages.some(
				message => message.role === "user" && message.content === "Now fix PROJ-13",
			),
		).toBe(true);
		expect(secondRequest.options.toolChoice).toBe("none");
		expect(secondRequest.options.promptCacheKey).toBe("cache-affinity");
		expect(secondRequest.options.sessionId).toBe("isolated-session");
	});

	test("consolidates a full chain without losing previous exact user constraints", async () => {
		const { options } = harness();
		const first = await compact(
			preparation("Keep PROJ-12", undefined, { summaryChainMaxBlocks: 2 }),
			model,
			"test",
			undefined,
			undefined,
			options,
		);
		const second = await compact(
			preparation("Keep PROJ-13", first, { summaryChainMaxBlocks: 2 }),
			model,
			"test",
			undefined,
			undefined,
			options,
		);
		const third = await compact(
			preparation("Keep PROJ-14", second, { summaryChainMaxBlocks: 2 }),
			model,
			"test",
			undefined,
			undefined,
			options,
		);
		expect(replay(second)).toHaveLength(2);
		expect(replay(third)).toHaveLength(1);
		for (const ref of ["PROJ-12", "PROJ-13", "PROJ-14"]) expect(third.summary).toContain(ref);
	});

	test("consolidates before appending when the token budget is already consumed", async () => {
		const { options } = harness();
		const first = await compact(
			preparation("Constraint " + Array.from({ length: 400 }, (_, i) => `item${i}`).join(" ")),
			model,
			"test",
			undefined,
			undefined,
			options,
		);
		const second = await compact(
			preparation("new work", first, { summaryChainMaxTokens: 256 }),
			model,
			"test",
			undefined,
			undefined,
			options,
		);
		expect(replay(second)).toHaveLength(1);
		expect(second.summary).toContain("item300");
		expect(second.summary).toContain("new work");
	});

	test("consolidates immediately when a new fidelity block crosses the token budget", async () => {
		const { options } = harness();
		const first = await compact(preparation("Keep PROJ-12"), model, "test", undefined, undefined, options);
		const delta = "Keep PROJ-13 " + Array.from({ length: 300 }, (_, i) => `item${i}`).join(" ");
		const second = await compact(
			preparation(delta, first, { summaryChainMaxTokens: 512 }),
			model,
			"test",
			undefined,
			undefined,
			options,
		);
		expect(replay(second)).toHaveLength(1);
		expect(second.summary).toContain("PROJ-12");
		expect(second.summary).toContain("PROJ-13");
	});

	test("falls back to windowed summarization on prefix overflow without rewriting sealed blocks", async () => {
		const { options } = harness();
		const first = await compact(preparation("Keep PROJ-12"), model, "test", undefined, undefined, options);
		let overflowed = false;
		const result = await compact(preparation("Now fix PROJ-13", first), model, "test", undefined, undefined, {
			...options,
			completeImpl: async (_model, context) => {
				if (context.systemPrompt?.[0] === "fixed repository map") {
					overflowed = true;
					return {
						...assistant(""),
						stopReason: "error",
						errorMessage: "400: prompt is too long: maximum context length exceeded",
					};
				}
				return assistant("Recovered summary");
			},
		});
		expect(overflowed).toBe(true);
		expect(replay(result)).toHaveLength(2);
		expect(replay(result)[0]).toEqual(replay(first)[0]);
		expect(result.summary).toContain("Recovered summary");
	});

	test("cancellation leaves earlier sealed data untouched", async () => {
		const { options } = harness();
		const first = await compact(preparation("Keep PROJ-12"), model, "test", undefined, undefined, options);
		const saved = JSON.stringify(first);
		const controller = new AbortController();
		controller.abort();
		await expect(
			compact(preparation("new work", first), model, "test", undefined, controller.signal, {
				...options,
				completeImpl: async (_model, _context, streamOptions) => {
					streamOptions.signal?.throwIfAborted();
					return assistant("unexpected");
				},
			}),
		).rejects.toThrow();
		expect(JSON.stringify(first)).toBe(saved);
	});

	test("stale hook metadata falls back to the replacement summary", () => {
		const preserveData = {
			summaryChain: {
				version: 1,
				blocks: [{ summary: "old", timestamp: "2026-11-01T00:00:00Z", tokensBefore: 12 }],
			},
		};
		const messages = createCompactionContextMessages("hook replacement", 20, "2026-11-12T00:00:00Z", preserveData);
		expect(messages.map(message => message.summary)).toEqual(["hook replacement"]);
		expect(
			getCompactionSummaryChain(
				{ summaryChain: { version: 1, blocks: [{ summary: "old", timestamp: "invalid", tokensBefore: 12 }] } },
				"old",
			),
		).toBeUndefined();
	});

	test("a legacy summary becomes the first sealed block", async () => {
		const { options } = harness();
		const previous = { summary: "Earlier constraint: keep PROJ-12", tokensBefore: 1000, firstKeptEntryId: "legacy" };
		const result = await compact(preparation("New work", previous), model, "test", undefined, undefined, options);
		expect(replay(result)).toHaveLength(2);
		expect(
			createCompactionContextMessages(result.summary, 20000, "2026-11-12T00:00:00Z", result.preserveData)[0]
				?.summary,
		).toBe(previous.summary);
	});
});
