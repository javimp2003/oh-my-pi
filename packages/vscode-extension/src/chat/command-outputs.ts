/**
 * What local slash commands (`/shake`, `/compact`, `/session`…) printed in each
 * session. omp sends that text once, as a `command_output` frame, and does not
 * keep it in the session, so the extension stores it to show it again where it
 * appeared when the transcript is rebuilt (reopening the chat, restarting VS Code).
 */
import type { CommandOutput } from "../protocol";
import { SessionFileStore } from "../session-store";

/** Older outputs of a session are dropped beyond this many. */
const MAX_OUTPUTS = 200;

export class CommandOutputStore {
	readonly #files: SessionFileStore<CommandOutput>;

	constructor(directory: string) {
		this.#files = new SessionFileStore(directory, isCommandOutput);
	}

	/** The session's outputs, oldest first. */
	load(sessionFile: string): Promise<CommandOutput[]> {
		return this.#files.load(sessionFile);
	}

	add(sessionFile: string, output: CommandOutput): Promise<void> {
		return this.#files.update(sessionFile, outputs => [...outputs, output].slice(-MAX_OUTPUTS));
	}

	/** Forget a session's outputs (its file was deleted). */
	remove(sessionFile: string): Promise<void> {
		return this.#files.remove(sessionFile);
	}
}

function isCommandOutput(value: unknown): value is CommandOutput {
	return (
		!!value &&
		typeof value === "object" &&
		"timestamp" in value &&
		typeof value.timestamp === "number" &&
		"text" in value &&
		typeof value.text === "string"
	);
}
