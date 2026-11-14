import { describe, expect, it, vi } from "bun:test";
import { chooseWorkbenchCommand } from "@oh-my-pi/pi-coding-agent/modes/terminal-workbench";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { WorkbenchComponent } from "@oh-my-pi/pi-tui/overlays/workbench";
import { theme } from "@oh-my-pi/pi-tui/theme";

function harness(choice: string | undefined, input?: string) {
	const showSettingsSelector = vi.fn();
	const handleClearCommand = vi.fn(async () => {});
	const handleRenameCommand = vi.fn(async () => {});
	const showHookInput = vi.fn(async () => input);
	const panels: WorkbenchComponent[] = [];
	const showHookCustom = vi.fn(async (factory: Parameters<InteractiveModeContext["showHookCustom"]>[0]) => {
		let result: unknown;
		const component = await factory(
			{ terminal: { rows: 30 } } as TUI,
			theme,
			KeybindingsManager.inMemory(),
			value => {
				result = value;
			},
		);
		if (!(component instanceof WorkbenchComponent)) throw new Error("Expected workbench navigation");
		panels.push(component);
		const target = component.items.find(item => `${item.category} / ${item.label}` === choice);
		if (target) component.handleNativeEvent({ type: "activate", key: "list", item: target.id });
		else component.handleInput("\x1b");
		return result;
	});
	const ctx = {
		session: { model: { id: "team-model" }, isStreaming: false },
		sessionManager: { getCwd: () => process.cwd() },
		sessionName: "Review the API",
		editor: { setText: vi.fn() },
		showSettingsSelector,
		handleClearCommand,
		handleRenameCommand,
		showHookInput,
		showHookCustom,
	} as unknown as InteractiveModeContext;
	return { ctx, showSettingsSelector, handleClearCommand, handleRenameCommand, panels, showHookInput };
}

describe("terminal workbench", () => {
	it("opens settings through the normal dispatcher and exposes only existing commands", async () => {
		const h = harness("Settings / All settings");
		expect(await executeBuiltinSlashCommand("/home", { ctx: h.ctx })).toBe(true);
		expect(h.showSettingsSelector).toHaveBeenCalledTimes(1);
		const options = h.panels[0]!.items;
		expect(options.some(option => option.category === "Chat" && option.label === "History")).toBe(true);
		// Exercise each offered route, so a renamed or removed command cannot leave a dead control.
		for (const option of options) {
			const label = `${option.category} / ${option.label}`;
			const target = await chooseWorkbenchCommand(harness(label, "New title").ctx);
			expect(lookupBuiltinSlashCommand(target!.slice(1).split(" ")[0]!)).toBeDefined();
		}
	});

	it("uses the existing new-conversation lifecycle from the menu alias", async () => {
		const h = harness("Chat / New conversation");
		await executeBuiltinSlashCommand("/menu", { ctx: h.ctx });
		expect(h.handleClearCommand).toHaveBeenCalledTimes(1);
	});

	it("cleans context with shake rather than starting the project diagnostics fixer", async () => {
		expect(await chooseWorkbenchCommand(harness("Context / Clean up").ctx)).toBe("/shake");
	});

	it("leaves the session untouched when the menu or rename input is cancelled", async () => {
		const menu = harness(undefined);
		await executeBuiltinSlashCommand("/workbench", { ctx: menu.ctx });
		expect(menu.handleClearCommand).not.toHaveBeenCalled();
		expect(menu.showSettingsSelector).not.toHaveBeenCalled();
		const rename = harness("Chat / Rename", "   ");
		expect(await chooseWorkbenchCommand(rename.ctx)).toBeUndefined();
		expect(rename.handleRenameCommand).not.toHaveBeenCalled();
	});

	it("returns a single rename command even when the pasted title contains newlines", async () => {
		const h = harness("Chat / Rename", "API review\n/new");
		expect(await chooseWorkbenchCommand(h.ctx)).toBe("/rename API review /new");
	});
});
