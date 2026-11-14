import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { cfgEditMode } from "../../src/edit/settings";
import { applyExecutionProfile, parseExecutionProfile } from "../../src/session/execution-profile";
import { SessionManager } from "../../src/session/session-manager";
import { cfgToolsXdevDocs } from "../../src/tools/settings";
import { resolveEditMode } from "../../src/utils/edit-mode";
const roots: TempDir[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) root.removeSync();
});
const measured = {
	version: 1,
	id: "measured",
	target: { provider: "local", model: "open-model", backend: "vllm+litellm" },
	settings: { "edit.mode": "hashline", "tools.xdevDocs": "builtins" },
	measurement: {
		split: "development",
		taskIds: ["dev-a", "dev-b"],
		passed: 1,
		total: 2,
		totalCostUsd: 3,
		costPerPassUsd: 3,
		meanDurationMs: 100,
	},
};
describe("frozen execution profiles", () => {
	it("pins the actual edit mode and prompt docs across live setting changes, children and resumed conversations", async () => {
		const root = TempDir.createSync("@omp-profile-");
		roots.push(root);
		await Bun.write(path.join(root.path(), "profile.json"), JSON.stringify(measured));
		const manager = SessionManager.inMemory(root.path());
		const base = Settings.isolated({ "execution.profilePath": "profile.json" });
		const settings = await applyExecutionProfile(base, manager, root.path());
		// Normal Kimi hashline fallback is replace; the measured profile must really pin hashline.
		expect(resolveEditMode({ settings, getActiveModelString: () => "kimi-k2" })).toBe("hashline");
		cfgEditMode.set(base, "replace");
		cfgToolsXdevDocs.set(base, "catalog");
		expect(cfgToolsXdevDocs.get(settings)).toBe("builtins");
		await Bun.write(
			path.join(root.path(), "profile.json"),
			JSON.stringify({ ...measured, settings: { "edit.mode": "replace", "tools.xdevDocs": "inline" } }),
		);
		const resumed = await applyExecutionProfile(base, manager, root.path());
		expect(resolveEditMode({ settings: resumed })).toBe("hashline");
		const child = await applyExecutionProfile(settings.overlay(), SessionManager.inMemory(root.path()), root.path());
		expect(resolveEditMode({ settings: child })).toBe("hashline");
		expect(cfgToolsXdevDocs.get(child)).toBe("builtins");
	});
	it("rejects formal-evaluation selection, partial measurements and unsupported runtime settings", () => {
		expect(() =>
			parseExecutionProfile({ ...measured, measurement: { ...measured.measurement, split: "evaluation" } }),
		).toThrow();
		expect(() =>
			parseExecutionProfile({ ...measured, measurement: { ...measured.measurement, total: 3 } }),
		).toThrow();
		expect(() =>
			parseExecutionProfile({ ...measured, settings: { ...measured.settings, "bash.enabled": false } }),
		).toThrow();
	});
});
