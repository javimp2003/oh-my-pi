import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit-mode";

/** Every edit tool variant, as accepted by `edit.mode` and `PI_EDIT_VARIANT`. */
export const EDIT_MODES = [
	"apply_patch",
	"hashline",
	"patch",
	"replace",
	"sloppy",
] as const satisfies readonly EditMode[];

/** Narrows free text (config values, per-model variants) to an edit mode; `undefined` when unknown. */
export function normalizeEditMode(mode?: string | null): EditMode | undefined {
	return EDIT_MODES.find(candidate => candidate === mode);
}
