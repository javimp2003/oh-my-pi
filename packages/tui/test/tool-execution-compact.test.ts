import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

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
	setChatTranscriptDisplayPreferences({ compactToolOutput: false });
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
});
