import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Text } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const ROWS = 20;
const COLUMNS = 80;
const PREFIX = "Transcript row ";

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
}

function addRows(transcript: TranscriptContainer, from: number, count: number): void {
	for (let i = from; i < from + count; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${PREFIX}${row}`] });
	}
}

async function makeHarness(transcriptRows: number): Promise<Harness> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, pinnedInput: true },
	});
	const transcript = new TranscriptContainer();
	addRows(transcript, 0, transcriptRows);
	composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
	composer.start({ playWelcomeIntro: false });
	await scheduler.settle(terminal);
	return { terminal, scheduler, composer, transcript };
}

/** Transcript row numbers on screen, top to bottom. */
function visibleRows(terminal: VirtualTerminal): number[] {
	return terminal
		.getViewport()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(row => row.startsWith(PREFIX))
		.map(row => Number(row.slice(PREFIX.length)));
}

function editorRow(terminal: VirtualTerminal): number {
	return terminal.getViewport().findIndex(row => row.includes("EDITOR"));
}

beforeAll(async () => {
	await initTheme();
});

describe("composer pinned input", () => {
	it("keeps the editor on the bottom row above a top-aligned short transcript", async () => {
		const h = await makeHarness(3);
		expect(editorRow(h.terminal)).toBe(ROWS - 1);
		expect(visibleRows(h.terminal)).toEqual([0, 1, 2]);
		expect(Bun.stripANSI(h.terminal.getViewport()[0]!)).toStartWith(`${PREFIX}0`);
		h.composer.stop();
	});

	it("shows the newest rows above the editor and retires nothing to native scrollback", async () => {
		const h = await makeHarness(100);
		expect(editorRow(h.terminal)).toBe(ROWS - 1);
		// One block per row with a blank separator: the newest ten blocks fill 19 rows.
		expect(visibleRows(h.terminal)).toEqual(Array.from({ length: 10 }, (_, i) => 90 + i));
		expect(h.terminal.getScrollBuffer().some(row => Bun.stripANSI(row).startsWith(`${PREFIX}0`))).toBe(false);
		h.composer.stop();
	});

	it("holds a scrolled window still while output streams in, then follows again at the bottom", async () => {
		const h = await makeHarness(100);
		expect(h.composer.scrollTranscriptPage(-1)).toBe(true);
		await h.scheduler.settle(h.terminal);
		const reading = visibleRows(h.terminal);
		expect(reading[0]).toBeLessThan(90);
		expect(editorRow(h.terminal)).toBe(ROWS - 1);
		expect(h.terminal.getViewport()[ROWS - 2]).toContain("below");

		addRows(h.transcript, 100, 5);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(visibleRows(h.terminal)).toEqual(reading);

		h.composer.scrollTranscript(1000);
		await h.scheduler.settle(h.terminal);
		expect(visibleRows(h.terminal).at(-1)).toBe(104);
		addRows(h.transcript, 105, 1);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(visibleRows(h.terminal).at(-1)).toBe(105);
		h.composer.stop();
	});

	it("stops at the top of the transcript", async () => {
		const h = await makeHarness(30);
		h.composer.scrollTranscript(-1000);
		await h.scheduler.settle(h.terminal);
		expect(visibleRows(h.terminal)[0]).toBe(0);
		expect(editorRow(h.terminal)).toBe(ROWS - 1);
		h.composer.stop();
	});

	it("ignores scroll gestures while the layout is off", async () => {
		const h = await makeHarness(3);
		h.composer.setPreferences({ pinnedInput: false });
		expect(h.composer.scrollTranscript(-5)).toBe(false);
		await h.scheduler.settle(h.terminal);
		expect(editorRow(h.terminal)).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("keeps a released drag highlighted until its text is taken", async () => {
		const h = await makeHarness(3);
		// Rows 0, 2, 4 hold transcript rows 0, 1, 2 (blank separators between blocks).
		expect(h.composer.beginSelection(0, 1)).toBe(true);
		h.composer.extendSelection(2, 10);
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getCellReverse(0, 1)).toBe(true);
		expect(h.terminal.getCellReverse(0, 0)).toBe(false);
		expect(h.terminal.getCellReverse(2, 11)).toBe(false);
		expect(h.composer.finishSelection()).toBe(true);
		await h.scheduler.settle(h.terminal);
		expect(h.composer.hasSelection).toBe(true);
		expect(h.terminal.getCellReverse(0, 1)).toBe(true);
		// Text rows have no left padding: column 1 drops the first letter; the drag ends inclusive at column 10.
		expect(h.composer.takeSelection()).toBe(`${PREFIX.slice(1)}0\n\n${PREFIX.slice(0, 11).trimEnd()}`);
		await h.scheduler.settle(h.terminal);
		expect(h.composer.hasSelection).toBe(false);
		expect(h.terminal.getCellReverse(0, 1)).toBe(false);
		h.composer.stop();
	});

	it("treats a press without a drag as a click and holds nothing", async () => {
		const h = await makeHarness(3);
		expect(h.composer.beginSelection(0, 3)).toBe(true);
		await h.scheduler.settle(h.terminal);
		expect(h.composer.finishSelection()).toBe(false);
		expect(h.composer.hasSelection).toBe(false);
		h.composer.stop();
	});

	it("selects input rows below the transcript window", async () => {
		const h = await makeHarness(3);
		expect(h.composer.beginSelection(ROWS - 1, 0)).toBe(true);
		h.composer.extendSelection(ROWS - 1, 5);
		await h.scheduler.settle(h.terminal);
		expect(h.composer.finishSelection()).toBe(true);
		expect(h.composer.takeSelection()).toBe("EDITOR");
		h.composer.stop();
	});

	it("holds the window still under a selection while rows stream in, then follows once it clears", async () => {
		const h = await makeHarness(100);
		const before = visibleRows(h.terminal);
		expect(h.composer.beginSelection(1, 0)).toBe(true);
		h.composer.extendSelection(3, 5);
		await h.scheduler.settle(h.terminal);
		expect(h.composer.finishSelection()).toBe(true);
		addRows(h.transcript, 100, 3);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(visibleRows(h.terminal)).toEqual(before);
		h.composer.clearSelection();
		await h.scheduler.settle(h.terminal);
		expect(h.composer.hasSelection).toBe(false);
		expect(visibleRows(h.terminal).at(-1)).toBe(102);
		h.composer.stop();
	});

	it("scrolls a held selection with the wheel and still copies its rows", async () => {
		const h = await makeHarness(100);
		// Select the second visible transcript row: the top row is the drag's auto-scroll edge.
		const row = h.terminal.getViewport().findIndex(line => line.startsWith(PREFIX)) + 2;
		const target = visibleRows(h.terminal)[1]!;
		expect(h.composer.beginSelection(row, 0)).toBe(true);
		h.composer.extendSelection(row, 30);
		await h.scheduler.settle(h.terminal);
		expect(h.composer.finishSelection()).toBe(true);
		h.composer.scrollTranscript(-4);
		await h.scheduler.settle(h.terminal);
		expect(visibleRows(h.terminal)[1]).toBe(target - 2);
		const moved = h.terminal.getViewport().findIndex(line => line.startsWith(`${PREFIX}${target}`));
		expect(h.terminal.getCellReverse(moved, 0)).toBe(true);
		expect(h.composer.takeSelection()).toBe(`${PREFIX}${target}`);
		h.composer.stop();
	});
});

describe("composer sticky prompt", () => {
	async function stickyHarness(): Promise<Harness> {
		const h = await makeHarness(0);
		h.transcript.addChild(new UserMessageComponent("first question"));
		addRows(h.transcript, 0, 40);
		h.transcript.addChild(new UserMessageComponent("latest question\nwith a second line"));
		addRows(h.transcript, 40, 40);
		h.composer.setPreferences({ stickyPrompt: true });
		await h.scheduler.settle(h.terminal);
		return h;
	}

	const text = (h: Harness, row: number): string => Bun.stripANSI(h.terminal.getViewport()[row] ?? "").trim();
	const rowsWith = (h: Harness, needle: string): number[] =>
		h.terminal.getViewport().flatMap((row, index) => (Bun.stripANSI(row).includes(needle) ? [index] : []));

	it("tops the window with the prompt the visible rows answer", async () => {
		const h = await stickyHarness();
		// Following the newest rows: the latest prompt scrolled off, so it labels the window.
		expect(text(h, 0)).toBe("latest question");
		expect(editorRow(h.terminal)).toBe(ROWS - 1);
		// Scroll up until the latest prompt's own bubble is in view: it no longer
		// repeats on top; the rows above it answer the first prompt.
		while (rowsWith(h, "latest question").every(row => row === 0)) {
			h.composer.scrollTranscript(-1);
			await h.scheduler.settle(h.terminal);
		}
		const bubble = rowsWith(h, "latest question");
		expect(bubble).toHaveLength(1);
		expect(bubble[0]).toBeGreaterThan(0);
		expect(text(h, 0)).toBe("first question");
		// The sticky row is the prompt bubble's own row, theme background included.
		expect(h.terminal.getViewportRowBackgroundValues(0)).toEqual(
			h.terminal.getViewportRowBackgroundValues(bubble[0]!),
		);
		expect(h.terminal.getViewportRowBackgroundColumns(0)).toHaveLength(COLUMNS);
		// At the very top the first prompt is in view and nothing is pinned over it.
		h.composer.scrollTranscript(-1000);
		await h.scheduler.settle(h.terminal);
		const first = rowsWith(h, "first question");
		expect(first).toHaveLength(1);
		expect(first[0]).toBeGreaterThan(0);
		h.composer.stop();
	});

	it("selects transcript rows under the sticky prompt by their screen position", async () => {
		const h = await stickyHarness();
		expect(h.composer.beginSelection(0, 0)).toBe(false);
		const row = h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).startsWith(PREFIX)) + 2;
		const target = Number(Bun.stripANSI(h.terminal.getViewport()[row]!).trimEnd().slice(PREFIX.length));
		expect(h.composer.beginSelection(row, 0)).toBe(true);
		h.composer.extendSelection(row, 30);
		await h.scheduler.settle(h.terminal);
		expect(h.composer.finishSelection()).toBe(true);
		expect(h.composer.takeSelection()).toBe(`${PREFIX}${target}`);
		h.composer.stop();
	});
});
