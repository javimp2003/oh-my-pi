import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { Settings } from "../config/settings";
import { cfgEditMode, normalizeEditMode } from "../edit/settings";
import { cfgExecutionProfilePath, cfgExecutionProfileSnapshot } from "./execution-profile-settings";
import type { SessionManager } from "./session-manager";

export * from "./execution-profile-schema";
import { parseExecutionProfile } from "./execution-profile-schema";
const ENTRY = "execution-profile";

export function frozenProfileEditMode(settings: Settings): EditMode | undefined {
	const snapshot = cfgExecutionProfileSnapshot.get(settings);
	return isRecord(snapshot.settings)
		? normalizeEditMode(
				typeof snapshot.settings["edit.mode"] === "string" ? snapshot.settings["edit.mode"] : undefined,
			)
		: undefined;
}

/** Resume restores the journal snapshot, even if the original file has since changed/disappeared. */
export async function applyExecutionProfile(
	settings: Settings,
	manager: SessionManager,
	cwd: string,
): Promise<Settings> {
	const persisted = manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === ENTRY);
	let value: unknown = persisted?.type === "custom" ? persisted.data : undefined;
	const inherited = cfgExecutionProfileSnapshot.get(settings);
	if (value === undefined && Object.keys(inherited).length) value = inherited;
	if (value === undefined) {
		const file = cfgExecutionProfilePath.get(settings).trim();
		if (!file) return settings;
		value = await Bun.file(path.resolve(cwd, file)).json();
	}
	const profile = parseExecutionProfile(value);
	const envMode = cfgEditMode.envValue();
	if (envMode !== undefined && envMode !== profile.settings["edit.mode"])
		throw new Error("PI_EDIT_VARIANT conflicts with the selected measured profile");
	const snapshot = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
	if (!persisted) manager.appendCustomEntry(ENTRY, snapshot);
	return settings.overlay({ ...profile.settings, "execution.profileSnapshot": snapshot });
}
