/**
 * Every live omp process of the window, one per open session, and what each
 * session is doing.
 *
 * A host no view shows keeps running until its work settles. Then it stays
 * warm for a while, so going back to that session joins it instead of starting
 * omp again: at most `MAX_WARM_HOSTS` idle hosts, each for up to `WARM_TTL_MS`,
 * the least recently used stopping first (the session is on disk and reopens
 * with `--resume`). A turn that finished with no view attached is remembered as
 * "done" until a view shows the session again.
 */
import * as vscode from "vscode";
import type { CheckpointStore } from "../checkpoints/store";
import type { CommandOutputStore } from "./command-outputs";
import type { SessionActivity } from "../protocol";
import { AgentHost } from "./agent-host";

/** Idle hosts no view shows that stay running for a quick return. */
const MAX_WARM_HOSTS = 3;
/** How long such a host stays running before it stops. */
const WARM_TTL_MS = 10 * 60_000;

export class AgentPool implements vscode.Disposable {
	readonly #hosts = new Set<AgentHost>();
	/** Idle hosts no view shows, oldest first, each with the timer that stops it. */
	readonly #warm = new Map<AgentHost, NodeJS.Timeout>();
	/** Session files whose background turn finished since a view last showed them. */
	readonly #done = new Set<string>();
	#signature = "";
	readonly #onDidChangeActivity = new vscode.EventEmitter<void>();
	/** Fires when a session starts or stops running, or a finished one is seen. */
	readonly onDidChangeActivity = this.#onDidChangeActivity.event;
	readonly #onNeedsAttention = new vscode.EventEmitter<AgentHost>();
	/** A session no view shows is waiting for the user (a plan to approve). */
	readonly onNeedsAttention = this.#onNeedsAttention.event;

	constructor(
		readonly log: vscode.OutputChannel,
		readonly checkpoints: CheckpointStore,
		readonly commandOutputs: CommandOutputStore,
	) {}

	/** A new host; one for a chat without a workspace runs in the no-workspace folder and takes no file checkpoints. */
	create(noWorkspace = false): AgentHost {
		const host = new AgentHost(
			this.log,
			noWorkspace ? undefined : this.checkpoints,
			noWorkspace,
			this.commandOutputs,
		);
		this.#hosts.add(host);
		host.onDidChange(() => this.#update(host));
		host.onNeedsAttention(() => this.#onNeedsAttention.fire(host));
		return host;
	}

	/** The live host that has `sessionFile` open, other than `except`. */
	find(sessionFile: string | undefined, except?: AgentHost): AgentHost | undefined {
		if (!sessionFile) return undefined;
		for (const host of this.#hosts) {
			if (host !== except && host.process && host.sessionFile === sessionFile) return host;
		}
		return undefined;
	}

	/** Activity per session file; sessions doing nothing notable are absent. */
	activities(): Record<string, SessionActivity> {
		const result: Record<string, SessionActivity> = {};
		for (const file of this.#done) result[file] = "done";
		for (const host of this.#hosts) {
			if (host.running && host.sessionFile) result[host.sessionFile] = "running";
		}
		return result;
	}

	/** A view shows `sessionFile`: it is no longer "done" unseen. */
	seen(sessionFile: string | undefined): void {
		if (sessionFile && this.#done.delete(sessionFile)) this.#fireIfChanged();
	}

	/** A view stopped showing `host`: keep it warm if it is idle, or let it finish its work. */
	release(host: AgentHost): void {
		this.#update(host);
	}

	/** Stop the background process of `sessionFile` (its file is being deleted). */
	async stopSession(sessionFile: string): Promise<void> {
		const host = this.find(sessionFile);
		if (host && host.views.size === 0) await this.#retire(host);
		this.#done.delete(sessionFile);
		this.#fireIfChanged();
	}

	dispose(): void {
		for (const timer of this.#warm.values()) clearTimeout(timer);
		this.#warm.clear();
		for (const host of this.#hosts) host.dispose();
		this.#hosts.clear();
		this.#onDidChangeActivity.dispose();
		this.#onNeedsAttention.dispose();
	}

	#update(host: AgentHost): void {
		if (this.#hosts.has(host)) {
			const idleAndHidden = host.views.size === 0 && !host.running && host.settled && !host.curating;
			if (!idleAndHidden) this.#unwarm(host);
			else if (!this.#warm.has(host)) this.#keepWarm(host);
		}
		this.#fireIfChanged();
	}

	/** An idle host no view shows: keep it for a quick return, within the warm limits. */
	#keepWarm(host: AgentHost): void {
		if (host.finishedUnseen && host.sessionFile) this.#done.add(host.sessionFile);
		// A dead process or one with no session has nothing to return to.
		if (!host.process || !host.sessionFile) {
			void this.#retire(host);
			return;
		}
		this.#warm.set(
			host,
			setTimeout(() => void this.#retire(host), WARM_TTL_MS),
		);
		for (const oldest of this.#warm.keys()) {
			if (this.#warm.size <= MAX_WARM_HOSTS) break;
			void this.#retire(oldest);
		}
	}

	#unwarm(host: AgentHost): void {
		clearTimeout(this.#warm.get(host));
		this.#warm.delete(host);
	}

	async #retire(host: AgentHost): Promise<void> {
		this.#unwarm(host);
		if (!this.#hosts.delete(host)) return;
		await host.stop();
		host.dispose();
		this.#fireIfChanged();
	}

	/** Hosts fire on every state refresh; the sessions list only cares when activity changes. */
	#fireIfChanged(): void {
		const signature = JSON.stringify(Object.entries(this.activities()).sort());
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#onDidChangeActivity.fire();
	}
}
