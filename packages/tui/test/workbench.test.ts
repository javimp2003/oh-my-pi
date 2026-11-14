import { beforeAll, describe, expect, it } from "bun:test";
import { WorkbenchComponent, type WorkbenchItem } from "@oh-my-pi/pi-tui/overlays/workbench";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { editorKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";

const ITEMS: WorkbenchItem[] = [
	{ id: "/new", category: "Chat", label: "New conversation", command: "/new", description: "Start a fresh session" },
	{ id: "/resume", category: "Chat", label: "History", command: "/resume", description: "Resume previous work" },
	{
		id: "/settings",
		category: "Settings",
		label: "All settings",
		command: "/settings",
		description: "Edit configuration and reset overrides",
	},
];

function harness() {
	const chosen: string[] = [];
	let cancelled = 0;
	let height = 30;
	const panel = new WorkbenchComponent({
		items: ITEMS,
		session: "Review the API\n\x1b[31munsafe\x07",
		workspace: "~/team\tproject",
		model: "litellm/team-model",
		state: "ready",
		getHeight: () => height,
		onSelect: id => chosen.push(id),
		onCancel: () => cancelled++,
	});
	return {
		panel,
		chosen,
		cancelled: () => cancelled,
		resize: (rows: number) => {
			height = rows;
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("workbench navigation", () => {
	it("finds an action by its description and invokes the corresponding command", () => {
		const h = harness();
		h.panel.handleInput("reset overrides");
		h.panel.handleInput("\r");
		expect(h.chosen).toEqual(["/settings"]);
	});

	it("scopes actions to the selected category and restores global search when cycling back", () => {
		const h = harness();
		h.panel.handleInput("\t");
		h.panel.handleInput("\x1b[B");
		h.panel.handleInput("\r");
		expect(h.chosen).toEqual(["/resume"]);
		h.panel.handleInput("\t");
		h.panel.handleInput("\r");
		expect(h.chosen.at(-1)).toBe("/settings");
		h.panel.handleInput("\t");
		h.panel.handleInput("fresh session");
		h.panel.handleInput("\r");
		expect(h.chosen.at(-1)).toBe("/new");
	});

	it("clears an unsuccessful search before closing, without activating an unrelated action", () => {
		const h = harness();
		h.panel.handleInput("unavailable action");
		h.panel.handleInput("\r");
		expect(h.chosen).toEqual([]);
		h.panel.handleInput("\x1b");
		expect(h.cancelled()).toBe(0);
		h.panel.handleInput("\r");
		expect(h.chosen).toEqual(["/new"]);
		h.panel.handleInput("\x1b");
		expect(h.cancelled()).toBe(1);
	});

	it("keeps the selected action and exit keys visible after shrinking the terminal", () => {
		const h = harness();
		h.panel.handleInput("reset overrides");
		for (const [width, rows] of [
			[110, 30],
			[40, 20],
			[32, 8],
		]) {
			h.resize(rows!);
			const lines = h.panel.render(width!);
			expect(lines.length).toBeLessThanOrEqual(rows!);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width!);
			const rendered = Bun.stripANSI(lines.join("\n"));
			expect(rendered).toContain("All settings");
			expect(rendered).toContain(editorKey("tui.select.cancel"));
		}
	});

	it("renders session metadata as single lines without terminal control injection", () => {
		const h = harness();
		const lines = h.panel.render(110);
		const rendered = Bun.stripANSI(lines.join("\n"));
		expect(rendered).toContain("Review the API unsafe");
		expect(rendered).not.toMatch(/[\t\x07]/);
		expect(lines.join("\n")).not.toContain("\x1b[31munsafe");
	});

	it("opens the same command through native pointer activation", () => {
		const h = harness();
		h.panel.handleNativeEvent({ type: "activate", key: "list", item: "/settings" });
		expect(h.chosen).toEqual(["/settings"]);
	});

	it("filters native text edits and switches native categories before activating an action", () => {
		const h = harness();
		h.panel.handleNativeEvent({ type: "edit", key: "search", len: 0, from: 0, to: 0, text: "overrides", cursor: 9 });
		h.panel.handleInput("\r");
		expect(h.chosen).toEqual(["/settings"]);
		h.panel.handleNativeEvent({ type: "select", key: "tabs", item: "Chat" });
		h.panel.handleInput("\r");
		expect(h.chosen.at(-1)).toBe("/new");
	});
});
