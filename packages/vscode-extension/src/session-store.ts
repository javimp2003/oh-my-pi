/**
 * A list of entries per omp session, persisted in the extension's storage (one
 * JSON file per session file, keyed by a hash of its path) so it survives
 * restarts. Writes to one session are serialized; reads wait for them.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export class SessionFileStore<T> {
	/** Serializes writes per session file. */
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(
		readonly directory: string,
		/** Drops entries a corrupt or older file holds in another shape. */
		private readonly isEntry: (value: unknown) => value is T,
	) {}

	/** The session's entries, after any write in flight. */
	async load(sessionFile: string): Promise<T[]> {
		await this.#queues.get(sessionFile);
		return this.#read(sessionFile);
	}

	/** Replace the session's entries with `change(current)`; `undefined` deletes them. */
	update(sessionFile: string, change: (entries: T[]) => T[] | undefined): Promise<void> {
		const previous = this.#queues.get(sessionFile) ?? Promise.resolve();
		const next = previous.then(async () => {
			const file = this.#file(sessionFile);
			const updated = change(await this.#read(sessionFile));
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

	/** Forget a session's entries (its file was deleted). */
	remove(sessionFile: string): Promise<void> {
		return this.update(sessionFile, () => undefined);
	}

	async #read(sessionFile: string): Promise<T[]> {
		const text = await fs.readFile(this.#file(sessionFile), "utf8").catch(() => undefined);
		if (text === undefined) return [];
		try {
			const parsed: unknown = JSON.parse(text);
			return Array.isArray(parsed) ? parsed.filter(this.isEntry) : [];
		} catch {
			return [];
		}
	}

	#file(sessionFile: string): string {
		const key = createHash("sha256").update(path.resolve(sessionFile)).digest("hex").slice(0, 32);
		return path.join(this.directory, `${key}.json`);
	}
}
