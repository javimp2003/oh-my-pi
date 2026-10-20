/**
 * File checkpoints of each session, persisted in the extension's storage (one
 * JSON file per session file) so they survive restarts.
 */
import { SessionFileStore } from "../session-store";
import type { TurnSnapshots } from "./snapshots";

/** Older checkpoints of a session are dropped beyond this many. */
const MAX_CHECKPOINTS = 200;

/** One repository's snapshots around a turn. */
export interface RepoCheckpoint extends TurnSnapshots {
	root: string;
}

/** The snapshots around one of omp's turns, keyed by the prompt that started it. */
export interface Checkpoint {
	/** `timestamp` of the user message that started the turn (as stored in the session). */
	promptTimestamp: number;
	repos: RepoCheckpoint[];
	/**
	 * Whether the session's own file tools (edit, write…) ran during the turn.
	 * Absent in checkpoints saved before it was tracked.
	 */
	editedFiles?: boolean;
}

export class CheckpointStore {
	readonly #files: SessionFileStore<Checkpoint>;

	constructor(directory: string) {
		this.#files = new SessionFileStore(directory, isCheckpoint);
	}

	load(sessionFile: string): Promise<Checkpoint[]> {
		return this.#files.load(sessionFile);
	}

	/** Add a checkpoint, or replace the one with the same prompt. */
	put(sessionFile: string, checkpoint: Checkpoint): Promise<void> {
		return this.#files.update(sessionFile, checkpoints => {
			const kept = checkpoints.filter(entry => entry.promptTimestamp !== checkpoint.promptTimestamp);
			kept.push(checkpoint);
			return kept.slice(-MAX_CHECKPOINTS);
		});
	}

	/** Forget a session's checkpoints (its file was deleted). */
	remove(sessionFile: string): Promise<void> {
		return this.#files.remove(sessionFile);
	}
}

function isCheckpoint(value: unknown): value is Checkpoint {
	if (!value || typeof value !== "object" || !("promptTimestamp" in value) || !("repos" in value)) return false;
	return (
		typeof value.promptTimestamp === "number" && Array.isArray(value.repos) && value.repos.every(isRepoCheckpoint)
	);
}

function isRepoCheckpoint(value: unknown): value is RepoCheckpoint {
	if (!value || typeof value !== "object" || !("root" in value) || !("before" in value)) return false;
	if (typeof value.root !== "string" || typeof value.before !== "string") return false;
	return !("after" in value) || value.after === undefined || typeof value.after === "string";
}
