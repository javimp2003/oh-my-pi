import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ResponseCopyButton } from "../src/chat/response-copy-button";
import { setTranscriptActionHandler, type TranscriptAction } from "../src/chat/transcript-actions";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { Composer } from "../src/prompt/composer";
import { initTheme } from "../src/theme";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => setTranscriptActionHandler(undefined));

describe("response copy dock", () => {
	for (const pinnedInput of [false, true]) {
		it(`copies the painted complete Markdown with pinned input ${pinnedInput}, only inside the button`, () => {
			const actions: TranscriptAction[] = [];
			setTranscriptActionHandler(action => actions.push(action));
			let answer: string | undefined =
				`# Respuesta\n\n\`\`\`ts\n\tconst café = "✓";\n\`\`\`\n${"long response\n".repeat(2000)}`;
			const expected = answer;
			const button = new ResponseCopyButton(() => answer);
			const composer = new Composer({
				terminal: new VirtualTerminal(80, 24),
				preferences: { quiet: true, pinnedInput },
			});
			composer.start();
			try {
				composer.setRuntimeChildren([new TranscriptContainer(), button]);
				const frame = composer.renderFrame({ columns: 80, rows: 24 });
				const row = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("[ Copy response ]"));
				expect(row).toBeGreaterThanOrEqual(0);
				expect(composer.activateViewportClick(row, 40)).toBe(false);
				expect(composer.activateViewportClick(-1, 2)).toBe(false);
				// A click belongs to what was painted, even if another turn starts before repaint.
				answer = undefined;
				expect(composer.activateViewportClick(row, 2)).toBe(true);
				expect(actions).toEqual([{ act: "copy", text: expected }]);
				const cleared = composer.renderFrame({ columns: 80, rows: 24 });
				expect(cleared.viewport.join("\n")).not.toContain("Copy response");
				expect(composer.activateViewportClick(row, 2)).toBe(false);
			} finally {
				composer.stop();
			}
		});
	}
});
