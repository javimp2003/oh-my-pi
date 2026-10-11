import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
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
});
