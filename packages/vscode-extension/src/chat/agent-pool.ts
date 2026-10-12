/**
 * Every live omp process of the window, one per open session, and what each
 * session is doing.
 *
 * A host no view shows keeps running until its work settles; then it stops
 * (the session is on disk and reopens with `--resume`). A turn that finished
 * that way is remembered as "done" until a view shows the session again.
 */
import * as vscode from "vscode";
import type { SessionActivity } from "../protocol";
import { AgentHost } from "./agent-host";

export class AgentPool implements vscode.Disposable {
	readonly #hosts = new Set<AgentHost>();
	/** Session files whose background turn finished since a view last showed them. */
	readonly #done = new Set<string>();
	#signature = "";
	readonly #onDidChangeActivity = new vscode.EventEmitter<void>();
	/** Fires when a session starts or stops running, or a finished one is seen. */
	readonly onDidChangeActivity = this.#onDidChangeActivity.event;
	readonly #onNeedsAttention = new vscode.EventEmitter<AgentHost>();
	/** A session no view shows is waiting for the user (a plan to approve). */
	readonly onNeedsAttention = this.#onNeedsAttention.event;

	constructor(readonly log: vscode.OutputChannel) {}

	create(): AgentHost {
		const host = new AgentHost(this.log);
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

	/** A view stopped showing `host`: stop it now if it has nothing left to do. */
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
		for (const host of this.#hosts) host.dispose();
		this.#hosts.clear();
		this.#onDidChangeActivity.dispose();
		this.#onNeedsAttention.dispose();
	}

	#update(host: AgentHost): void {
		if (this.#hosts.has(host) && host.views.size === 0 && !host.running && host.settled) {
			if (host.finishedUnseen && host.sessionFile) this.#done.add(host.sessionFile);
			void this.#retire(host);
		}
		this.#fireIfChanged();
	}

	async #retire(host: AgentHost): Promise<void> {
		if (!this.#hosts.delete(host)) return;
		await host.stop();
		host.dispose();
	}

	/** Hosts fire on every state refresh; the sessions list only cares when activity changes. */
	#fireIfChanged(): void {
		const signature = JSON.stringify(Object.entries(this.activities()).sort());
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#onDidChangeActivity.fire();
	}
}
