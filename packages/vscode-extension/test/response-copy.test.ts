import { describe, expect, it } from "bun:test";
import { ResponseCopyAction } from "../webview/chat/response-copy";
import type { AssistantMessage } from "../src/protocol";

const message = (...content: AssistantMessage["content"]): Pick<AssistantMessage, "content"> => ({ content });

describe("copy complete response", () => {
	it("copies verbatim Markdown across text blocks, including long answers, without reasoning or tool details", async () => {
		const copied: string[] = [];
		const action = new ResponseCopyAction(
			async text => {
				copied.push(text);
			},
			() => {},
		);
		const first = "# Resultado\n\n";
		const code = "```ts\n\tconst café = '✓';\n```\n" + "long response\n".repeat(2000);
		action.update(
			message(
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: first },
				{ type: "toolCall", id: "internal", name: "bash", arguments: { command: "internal command" } },
				{ type: "text", text: code },
			),
			false,
		);
		await action.copy();
		expect(copied).toEqual([first + code]);
		expect(action.state).toBe("copied");
	});

	it("hides streaming, blank and thinking-only messages, then uses the settled answer", async () => {
		const copied: string[] = [];
		const action = new ResponseCopyAction(
			async text => {
				copied.push(text);
			},
			() => {},
		);
		for (const [answer, streaming] of [
			[message({ type: "text", text: "partial" }), true],
			[message({ type: "thinking", thinking: "not an answer" }), false],
			[message({ type: "text", text: "\n\t " }), false],
		] as const) {
			action.update(answer, streaming);
			await action.copy();
			expect(action.state).toBe("hidden");
		}
		expect(copied).toEqual([]);
		action.update(message({ type: "text", text: "settled" }), false);
		await action.copy();
		expect(copied).toEqual(["settled"]);
	});

	it("reports clipboard denial and permits retry without reporting false success", async () => {
		let attempts = 0;
		const action = new ResponseCopyAction(
			async () => {
				if (++attempts === 1) throw new Error("denied");
			},
			() => {},
		);
		action.update(message({ type: "text", text: "answer" }), false);
		await action.copy();
		expect(action.state).toBe("failed");
		await action.copy();
		expect(action.state).toBe("copied");
	});

	it("deduplicates in-flight clicks and never marks a new answer copied by an older completion", async () => {
		const pending = Promise.withResolvers<void>();
		const copied: string[] = [];
		const action = new ResponseCopyAction(
			text => {
				copied.push(text);
				return pending.promise;
			},
			() => {},
		);
		action.update(message({ type: "text", text: "first" }), false);
		const copying = action.copy();
		await action.copy();
		expect(copied).toEqual(["first"]);
		action.update(message({ type: "text", text: "second" }), false);
		pending.resolve();
		await copying;
		expect(action.state).toBe("ready");
		await action.copy();
		expect(copied).toEqual(["first", "second"]);
	});
});
