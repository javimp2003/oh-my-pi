import { describe, expect, it } from "bun:test";
import { userPrompt } from "../src/chat/prompt-entries";

const skillEntry = {
	type: "custom_message",
	customType: "skill-prompt",
	attribution: "user",
	content: "<expanded SKILL.md>",
	display: true,
	details: { name: "review", args: "src", prompt: "/skill:review src please", lineCount: 3 },
	timestamp: "2026-01-02T03:04:05.678Z",
};

describe("userPrompt", () => {
	it("counts a user-invoked skill prompt with its draft and checkpoint timestamp", () => {
		expect(userPrompt(skillEntry)).toEqual({
			text: "/skill:review src please",
			timestamp: Date.parse("2026-01-02T03:04:05.678Z"),
		});
	});

	it("rebuilds the draft from name and args on sessions without the submitted prompt", () => {
		const entry = { ...skillEntry, details: { name: "review", args: "src", lineCount: 3 } };
		expect(userPrompt(entry)?.text).toBe("/skill:review src");
	});

	it("skips skill prompts the agent or autoload injected (omp cannot rewind to them)", () => {
		expect(userPrompt({ ...skillEntry, attribution: "agent" })).toBeUndefined();
	});

	it("skips synthetic user messages and joins the text blocks of real ones", () => {
		expect(userPrompt({ type: "message", message: { role: "user", synthetic: true, content: "x" } })).toBeUndefined();
		const content = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		];
		expect(userPrompt({ type: "message", message: { role: "user", content, timestamp: 5 } })).toEqual({
			text: "a\nb",
			timestamp: 5,
		});
	});
});
