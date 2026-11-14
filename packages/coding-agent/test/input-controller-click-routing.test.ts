import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

import { cfgTuiMouse, cfgTuiMouseSelection, cfgTuiPinnedInput } from "@oh-my-pi/pi-coding-agent/modes/settings";

const ESC = String.fromCharCode(27);
// SGR click on viewport row 2 (1-based y=3): the pinned expander row when the
// candidates below resolve it to the toggle sentinel.
const EXPANDER_CLICK = `${ESC}[<0;5;3M`;

function makeHarness(
	activate?: (row: number, col: number) => boolean,
	viewport = { top: 0, length: 5 },
	finishSelection = () => false,
) {
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const focused: string[] = [];
	let toggled = 0;
	const ctx = {
		ui: {
			addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				listeners.push(fn);
			},
			getMutableViewport: () => viewport,
			hasOverlay: () => false,
			requestRender: () => {},
			addStartListener: () => {},
			getFocused: () => undefined,
		},
		handlesBtwBranchKey: () => false,
		editor: {
			getText: () => "",
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			spaceHold: new SpaceHoldGesture(() => {}),
		},
		keybindings: KeybindingsManager.inMemory(),
		settings,
		dictationSpaceHold: () => undefined,
		session: {
			extensionRunner: undefined,
		},
		resolveViewportClickCandidates: (index: number) => (index === 2 ? [PINNED_HUD_TOGGLE_ID] : []),
		activateViewportClick: activate,
		focusedAgentId: undefined,
		focusAgentSession: async (id: string) => {
			focused.push(id);
		},
		togglePinnedHudExpanded: () => {
			toggled++;
		},
		showStatus: () => {},
		setClickHoverId: () => {},
		beginTextSelection: () => true,
		hasTextSelection: () => false,
		extendTextSelection: () => {},
		finishTextSelection: finishSelection,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	return {
		click: (data = EXPANDER_CLICK) => {
			for (const listener of listeners) listener(data);
		},
		focused,
		toggled: () => toggled,
	};
}

describe("InputController click routing", () => {
	it("copies on a pinned-input click release, while a text-selection drag never activates the button", () => {
		cfgTuiPinnedInput.set(settings, true);
		cfgTuiMouseSelection.set(settings, true);
		let drag = false;
		let copied = 0;
		const h = makeHarness(
			() => {
				copied++;
				return true;
			},
			undefined,
			() => drag,
		);
		h.click();
		expect(copied).toBe(0);
		h.click(`${ESC}[<0;5;3m`);
		expect(copied).toBe(1);
		drag = true;
		h.click();
		h.click(`${ESC}[<32;9;3M`);
		h.click(`${ESC}[<0;9;3m`);
		expect(copied).toBe(1);
	});
	it("routes a response button before agent focus with viewport-relative rows and mouse columns", () => {
		const clicks: [number, number][] = [];
		const viewport = { top: 1, length: 5 };
		const h = makeHarness((row, col) => {
			clicks.push([row, col]);
			return true;
		}, viewport);
		h.click();
		expect(clicks).toEqual([[1, 4]]);
		expect(h.focused).toEqual([]);
		expect(h.toggled()).toBe(0);
		viewport.length = 0;
		h.click();
		expect(clicks).toEqual([[1, 4]]);
	});
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
		cfgTuiMouse.set(settings, true);
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("focuses a live agent whose id equals the toggle sentinel", () => {
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "evil",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		const h = makeHarness();
		h.click();
		expect(h.focused).toEqual([PINNED_HUD_TOGGLE_ID]);
		expect(h.toggled()).toBe(0);
	});

	it("toggles when no live agent matches the sentinel", () => {
		const h = makeHarness();
		h.click();
		expect(h.toggled()).toBe(1);
		expect(h.focused).toEqual([]);
	});
});
