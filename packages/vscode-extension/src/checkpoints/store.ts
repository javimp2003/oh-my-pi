/**
 * File checkpoints of each session, persisted in the extension's storage (one
 * JSON file per session file) so they survive restarts.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
}

export class CheckpointStore {
	/** Serializes writes per session file. */
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(readonly directory: string) {}

	async load(sessionFile: string): Promise<Checkpoint[]> {
		const text = await fs.readFile(this.#file(sessionFile), "utf8").catch(() => undefined);
		if (text === undefined) return [];
		try {
			const parsed: unknown = JSON.parse(text);
			return Array.isArray(parsed) ? parsed.filter(isCheckpoint) : [];
		} catch {
			return [];
		}
	}

	/** Add a checkpoint, or replace the one with the same prompt. */
	put(sessionFile: string, checkpoint: Checkpoint): Promise<void> {
		return this.#update(sessionFile, checkpoints => {
			const kept = checkpoints.filter(entry => entry.promptTimestamp !== checkpoint.promptTimestamp);
			kept.push(checkpoint);
			return kept.slice(-MAX_CHECKPOINTS);
		});
	}

	/** Forget a session's checkpoints (its file was deleted). */
	remove(sessionFile: string): Promise<void> {
		return this.#update(sessionFile, () => undefined);
	}

	#update(sessionFile: string, change: (checkpoints: Checkpoint[]) => Checkpoint[] | undefined): Promise<void> {
		const previous = this.#queues.get(sessionFile) ?? Promise.resolve();
		const next = previous.then(async () => {
			const file = this.#file(sessionFile);
			const updated = change(await this.load(sessionFile));
			if (!updated) {
				await fs.rm(file, { force: true });
				return;
			}
			await fs.mkdir(this.directory, { recursive: true });
			const temp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temp, JSON.stringify(updated));
			await fs.rename(temp, file);
		});
		this.#queues.set(
			sessionFile,
			next.catch(() => {}),
		);
		return next;
	}

	#file(sessionFile: string): string {
		const key = createHash("sha256").update(path.resolve(sessionFile)).digest("hex").slice(0, 32);
		return path.join(this.directory, `${key}.json`);
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
