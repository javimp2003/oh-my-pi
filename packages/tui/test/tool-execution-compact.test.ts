import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
const GREP_OUTPUT = "src/a.ts\n12:// TODO one\n\nsrc/b.ts\n3:// TODO two";

function grep(result: { isError?: boolean } = {}): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"grep",
		{ pattern: "TODO", path: "src" },
		{ useBuiltInRenderer: true },
		undefined,
		ui,
	);
	component.updateResult(
		result.isError
			? { content: [{ type: "text", text: "boom: invalid regex" }], isError: true }
			: {
					content: [{ type: "text", text: GREP_OUTPUT }],
					details: { matchCount: 2, fileCount: 2, displayContent: GREP_OUTPUT },
				},
		false,
	);
	return component;
}

function visible(component: ToolExecutionComponent): string[] {
	return component
		.render(90)
		.map(row => Bun.stripANSI(row).trim())
		.filter(row => row !== "");
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setChatTranscriptDisplayPreferences({ compactToolOutput: false, answerDivider: false });
});

describe("compact tool output", () => {
	it("shows only the header row naming the call", () => {
		setChatTranscriptDisplayPreferences({ compactToolOutput: true });
		const rows = visible(grep());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Grep: TODO");
		expect(rows[0]).toContain("2 matches");
	});

	it("keeps full output while expanded and for failures", () => {
		setChatTranscriptDisplayPreferences({ compactToolOutput: true });
		const expanded = grep();
		expanded.setExpanded(true);
		expect(visible(expanded).join("\n")).toContain("// TODO two");
		expect(visible(grep({ isError: true })).join("\n")).toContain("boom: invalid regex");
	});

	it("re-shapes an existing card when the preference flips", () => {
		const component = grep();
		expect(visible(component).join("\n")).toContain("// TODO one");
		setChatTranscriptDisplayPreferences({ compactToolOutput: true });
		component.invalidate();
		expect(visible(component).join("\n")).not.toContain("// TODO one");
	});

	it("leads every compact row with a two-cell emoji so tool names share a column", () => {
		setChatTranscriptDisplayPreferences({ compactToolOutput: true });
		const bash = new ToolExecutionComponent(
			"bash",
			{ command: "ls -la" },
			{ useBuiltInRenderer: true },
			undefined,
			ui,
		);
		bash.updateResult({ content: [{ type: "text", text: "total 0" }] }, false);
		const read = new ReadToolGroupComponent();
		read.updateArgs({ path: "/tmp/a.py" }, "r1");
		read.updateResult({ content: [{ type: "text", text: "x = 1" }] }, false, "r1");
		const rows = [grep(), bash, read].map(component =>
			Bun.stripANSI(component.render(90).find(row => Bun.stripANSI(row).trim() !== "")!),
		);
		const nameColumns = rows.map(row => visibleWidth(row.slice(0, row.search(/[A-Za-z]/))));
		expect(rows[0]).toStartWith(" 🔍 Grep");
		expect(rows[1]).toStartWith(" 💻 bash: $ ls -la");
		expect(rows[2]).toStartWith(" 📄 Read");
		expect(new Set(nameColumns).size).toBe(1);
	});
});

describe("answer divider", () => {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const answer = (content: unknown[]): AssistantMessage =>
		({
			role: "assistant",
			content,
			stopReason: "stop",
			usage,
			api: "x",
			provider: "x",
			model: "x",
			timestamp: 0,
		}) as never;
	const hasRule = (component: AssistantMessageComponent): boolean =>
		component.render(60).some(row => Bun.stripANSI(row).includes("─".repeat(20)));

	it("separates a finished answer from the tools before it, but not while streaming", () => {
		setChatTranscriptDisplayPreferences({ answerDivider: true });
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("question"));
		transcript.addChild(grep());
		const reply = new AssistantMessageComponent(undefined, false, () => {});
		transcript.addChild(reply);
		const message = answer([{ type: "text", text: "The answer." }]);
		reply.updateContent(message, { transient: true });
		expect(hasRule(reply)).toBe(false);
		reply.updateContent(message);
		expect(hasRule(reply)).toBe(true);
	});

	it("leaves a direct reply to the prompt undivided unless it thought first", () => {
		setChatTranscriptDisplayPreferences({ answerDivider: true });
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("hola"));
		const direct = new AssistantMessageComponent(undefined, false, () => {});
		transcript.addChild(direct);
		direct.updateContent(answer([{ type: "text", text: "Hola!" }]));
		expect(hasRule(direct)).toBe(false);
		direct.updateContent(
			answer([
				{ type: "thinking", thinking: "Respond in Spanish." },
				{ type: "text", text: "Hola!" },
			]),
		);
		expect(hasRule(direct)).toBe(true);
	});
});
