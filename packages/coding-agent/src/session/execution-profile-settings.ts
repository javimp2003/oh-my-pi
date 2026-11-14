import { register } from "../config/registry";
const EMPTY_PROFILE: Record<string, unknown> = {};
export const cfgExecutionProfilePath = register({
	id: "execution.profilePath",
	type: "string",
	default: "",
	ui: {
		tab: "model",
		group: "Execution Profile",
		label: "Measured Profile File",
		description: "JSON profile selected on development tasks; frozen at conversation start (empty disables)",
	},
});
/** Internal, inherited snapshot. Changing the file or parent settings cannot alter an active profile. */
export const cfgExecutionProfileSnapshot = register({
	id: "execution.profileSnapshot",
	type: "record",
	default: EMPTY_PROFILE,
});
