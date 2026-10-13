/**
 * One omp process (`omp --mode rpc-ui`) and the session it has open.
 *
 * Chat views attach to a host to show it and detach when they move to another
 * session; the host keeps running with no view attached, so a turn started in
 * one session continues while the user works in another (`AgentPool` decides
 * when an idle, detached host stops). Live events go to every attached view;
 * a view that attaches later gets a snapshot (`replay`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import type {
	AgentMessage,
	ImageContent,
	RpcNotification,
	SessionState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import { gitAvailable } from "../checkpoints/git";
import { discoverRepos } from "../checkpoints/repos";
import {
	restoreTurns,
	snapshotTree,
	type TurnSnapshots,
	undoRestore,
	type WrittenFile,
} from "../checkpoints/snapshots";
import type { CheckpointStore, RepoCheckpoint } from "../checkpoints/store";
import { ompCommand, readConfig, workspaceCwd, workspaceRoots } from "../config";
import { lastSystemCa } from "../system-ca";
import { DialogBridge } from "../dialogs";
import type { AgentStatus, ChatUpdate, ModelChoice } from "../protocol";
import { OmpCommandError, OmpProcess, type OmpResult } from "../rpc/omp-process";

/** Notification frames that are not session events (everything else is forwarded as `event`). */
const NON_EVENT_FRAMES: Record<string, true> = {
	ready: true,
	prompt_result: true,
	session_settled: true,
	extension_error: true,
	extension_ui_request: true,
	available_commands_update: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	subagent_event: true,
	live_phase: true,
	live_levels: true,
	live_transcript: true,
	live_end: true,
	dictation_state: true,
	btw_delta: true,
	btw_record: true,
	command_output: true,
	session_info_update: true,
	config_update: true,
	rpc_frame_error: true,
};

/** Frames after which the session snapshot (state, stats, title) is re-read. */
const STATE_CHANGING_EVENTS: Record<string, true> = {
	agent_end: true,
	model_changed: true,
	thinking_level_changed: true,
	auto_compaction_end: true,
	session_settled: true,
	session_info_update: true,
	config_update: true,
	// Local slash commands (`/shake`, `/compact`, `/handoff`…) run no agent turn: their
	// output is the only frame telling the host the context changed.
	command_output: true,
	prompt_result: true,
};

/** `navigate_tree` retries while an aborted turn still winds down (bash, retries…). */
const NAVIGATE_BUSY_RETRIES = 6;
const NAVIGATE_BUSY_DELAY_MS = 500;
/** Transcribing a long dictation through a cloud API can take a while. */
const DICTATION_STOP_TIMEOUT_MS = 120_000;

/** What a new process should open. */
export type SessionTarget = { kind: "continue" } | { kind: "new" } | { kind: "resume"; sessionFile: string };

/** Files involved in editing a prompt (absolute paths). */
export interface EditPlan {
	/** Whether the prompt has a file checkpoint (it started a turn while file checkpoints were on). */
	checkpoint: boolean;
	/** Files a restore changes. */
	files: string[];
	/** Files omp and someone else changed on the same lines: a restore leaves them unless told to overwrite. */
	conflicts: string[];
}

/** A file restore that was applied, with what undoing it needs. */
export interface FileRestore {
	repos: Array<{ root: string; current: string; files: WrittenFile[] }>;
	files: string[];
	conflicts: string[];
}

export interface EditResult {
	/** False when a hook vetoed the rewind: nothing changed. */
	resent: boolean;
	restored?: FileRestore;
}

/** A chat view showing a host: where its updates go. */
export interface HostView {
	post(update: ChatUpdate): void;
	reveal(): void;
}

type PlanReview = Extract<ChatUpdate, { type: "planReview" }>;

export class AgentHost implements vscode.Disposable {
	#process: OmpProcess | undefined;
	#status: AgentStatus = { phase: "starting" };
	#state: SessionState | undefined;
	#title: string | undefined;
	/** Between `agent_start` and `agent_end`: a turn is running. */
	#busy = false;
	/** When the running turn started (`agent_start`), for the working timer of every view showing it. */
	#busySince = 0;
	/** A dictation this host started is recording (or transcribing). */
	#dictating = false;
	/** Idle with nothing queued or pending (omp's `session_settled` / `get_state.isSettled`). */
	#settled = true;
	/** A turn finished while no view was attached; cleared when a view shows the session. */
	#finishedUnseen = false;
	#refreshTimer: NodeJS.Timeout | undefined;
	/** The turn being checkpointed: snapshots taken before its prompt was sent. */
	#turn: { sessionFile: string; repos: RepoCheckpoint[]; promptTimestamp?: number; editedFiles: boolean } | undefined;
	/** Checkpoint snapshots and writes, in order; awaited before anything reads them. */
	#checkpointWork: Promise<void> = Promise.resolve();
	readonly #views = new Set<HostView>();
	readonly #dialogs: DialogBridge;
	readonly #statusTexts = new Map<string, string>();
	/** Plan reviews awaiting a decision, by request id; re-sent to views that attach later. */
	readonly #planReviews = new Map<string, { update: PlanReview; resolve(value: string | undefined): void }>();
	readonly #onDidChange = new vscode.EventEmitter<AgentHost>();
	/** Fires when the process, session, title, model, busy or settled state changes. */
	readonly onDidChange = this.#onDidChange.event;
	readonly #onNeedsAttention = new vscode.EventEmitter<AgentHost>();
	/** Fires when the session waits for the user (a plan to approve) with no view showing it. */
	readonly onNeedsAttention = this.#onNeedsAttention.event;

	constructor(
		readonly log: vscode.OutputChannel,
		private readonly checkpoints?: CheckpointStore,
	) {
		this.#dialogs = new DialogBridge({
			respond: response => this.#process?.respond(response),
			setStatus: (key, text) => {
				if (text) this.#statusTexts.set(key, text);
				else this.#statusTexts.delete(key);
				this.#onDidChange.fire(this);
			},
			setEditorText: text => this.post({ type: "insertText", text }),
			log: line => this.log.appendLine(line),
			reviewPlan: (request, token) => this.#reviewPlan(request, token),
		});
	}

	get status(): AgentStatus {
		return this.#status;
	}
	get state(): SessionState | undefined {
		return this.#state;
	}
	get title(): string | undefined {
		return this.#title;
	}
	get busy(): boolean {
		return this.#busy;
	}
	/** Working on something: a turn or a compaction. */
	get running(): boolean {
		return this.#busy || this.#state?.isCompacting === true;
	}
	get settled(): boolean {
		return this.#settled;
	}
	get finishedUnseen(): boolean {
		return this.#finishedUnseen;
	}
	get sessionFile(): string | undefined {
		return this.#state?.sessionFile;
	}
	get process(): OmpProcess | undefined {
		return this.#process?.running ? this.#process : undefined;
	}
	get views(): ReadonlySet<HostView> {
		return this.#views;
	}
	/** Extension status texts (`setStatus`), e.g. from omp extensions. */
	get statusTexts(): ReadonlyMap<string, string> {
		return this.#statusTexts;
	}

	attach(view: HostView): void {
		this.#views.add(view);
		this.#finishedUnseen = false;
	}

	detach(view: HostView): void {
		this.#views.delete(view);
		// Speech meant for a view that moved on must not land in another one.
		if (this.#views.size === 0 && this.#dictating) void this.dictationCancel();
	}

	/** Bring `view` up to date: status, transcript and pickers, pending plan reviews. */
	async replay(view: HostView): Promise<void> {
		view.post({ type: "status", status: this.#status });
		const process = this.process;
		if (process) await this.#sendSnapshot(process, [view]);
		for (const review of this.#planReviews.values()) view.post(review.update);
	}

	/** Start (or restart) omp on `target`; resolves once the first snapshot reached the views. */
	async start(target: SessionTarget): Promise<void> {
		await this.#stopProcess();
		const cwd = workspaceCwd();
		const command = await ompCommand(cwd);
		if (lastSystemCa) {
			this.log.appendLine(
				`[start] trusting ${lastSystemCa.certificates} certificates of the OS store (${lastSystemCa.file})`,
			);
		}
		const process = new OmpProcess(command);
		this.#process = process;
		this.#busy = false;
		this.#settled = true;
		this.#setStatus({ phase: "starting" });
		process.on("frame", frame => this.#onFrame(process, frame));
		process.on("uiRequest", request => {
			if (this.#process === process) this.#dialogs.handle(request);
		});
		process.on("stderr", text => this.log.append(text));
		process.on("exit", reason => {
			this.log.appendLine(`[omp exited] ${reason}`);
			if (this.#process !== process) return;
			this.#dialogs.dispose();
			// A dead process runs nothing: let the pool retire it if no view shows it.
			this.#busy = false;
			this.#settled = true;
			this.#setStatus({ phase: "stopped", message: reason });
		});
		const args = [...readConfig().extraArgs];
		if (target.kind === "resume") args.push("--resume", target.sessionFile);
		else if (target.kind === "continue") args.push("--continue");
		this.log.appendLine(
			`[start] ${process.command.executable} ${[...process.command.args, ...args].join(" ")} (cwd ${cwd})`,
		);
		try {
			await process.start(args);
		} catch (error) {
			if (this.#process === process) this.#setStatus({ phase: "stopped", message: errorMessage(error) });
			return;
		}
		await process.request("set_ask_dialog", { enabled: true }).catch(error => this.log.appendLine(String(error)));
		this.#setStatus({ phase: "ready" });
		this.#title = undefined;
		await this.#sendSnapshot(process, this.#views);
	}

	async restart(): Promise<void> {
		const sessionFile = this.#state?.sessionFile;
		await this.start(sessionFile ? { kind: "resume", sessionFile } : { kind: "continue" });
	}

	/** Stop the process; the host can be started again. */
	async stop(): Promise<void> {
		await this.#stopProcess();
		this.#busy = false;
		this.#settled = true;
		this.#onDidChange.fire(this);
	}

	/** Start a new session in this process. Aborts a running turn: callers only use it when idle. */
	async newSession(): Promise<void> {
		const process = this.#requireProcess();
		const result = await process.request("new_session", {});
		if (result.cancelled) return;
		this.#title = undefined;
		await this.#sendSnapshot(process, this.#views);
	}

	/** Open another session in this process. Aborts a running turn: callers only use it when idle. */
	async switchSession(sessionFile: string): Promise<void> {
		const process = this.process;
		if (!process) {
			await this.start({ kind: "resume", sessionFile });
			return;
		}
		const result = await process.request("switch_session", { sessionPath: sessionFile });
		if (result.cancelled) return;
		this.#title = undefined;
		await this.#sendSnapshot(process, this.#views);
	}

	/** Send a prompt. One that starts a turn first snapshots the workspace's repositories (file checkpoints). */
	async prompt(text: string, images: ImageContent[] | undefined): Promise<void> {
		const process = this.#requireProcess();
		if (!this.#busy) await this.#beginTurnCheckpoint();
		await process.request("prompt", {
			message: text,
			...(images?.length ? { images } : {}),
			streamingBehavior: readConfig().sendWhileBusy,
		});
	}

	/**
	 * What editing the prompt `fromEnd` prompts from the end involves for files:
	 * whether that prompt has a file checkpoint and, if so, which files a
	 * restore would change and which conflict (changed by omp and by someone
	 * else on the same lines). Nothing changes on disk.
	 */
	async planEdit(fromEnd: number, original: string): Promise<EditPlan> {
		const target = await this.#findPrompt(this.#requireProcess(), fromEnd, original);
		const repos = await this.#repoTurns(target.timestamps);
		if (!repos) return { checkpoint: false, files: [], conflicts: [] };
		const results = await Promise.all(repos.map(repo => restoreTurns(repo.root, repo.turns, { write: false })));
		return {
			checkpoint: true,
			files: results.flatMap(result => result.files.map(file => path.join(result.root, file.path))),
			conflicts: results.flatMap(result => result.conflicts.map(file => path.join(result.root, file))),
		};
	}

	/**
	 * Resend the user message `fromEnd` prompts from the end of the conversation
	 * with `text` (keeping its images). omp's `navigate_tree` rewinds the session
	 * in place to just before that message, so the edited prompt continues from
	 * there and the later turns leave the conversation (they stay in the session
	 * file on an abandoned branch, reachable from the terminal's `/tree`).
	 * A running turn is aborted first.
	 *
	 * With `restoreFiles`, the files omp changed since that message go back to
	 * how they were (see `restoreTurns`); conflicting files listed in `overwrite`
	 * are reset outright, other conflicts are left as they are.
	 */
	async editMessage(
		fromEnd: number,
		original: string,
		text: string,
		restoreFiles?: { overwrite: readonly string[] },
	): Promise<EditResult> {
		const process = this.#requireProcess();
		const target = await this.#findPrompt(process, fromEnd, original);
		if (this.running) {
			await process.request("abort");
			await this.#untilIdle();
		}
		// The aborted turn's closing snapshot belongs to what gets restored.
		await this.#checkpointWork;
		const result = await this.#navigateTree(process, target.entryId);
		if (result.cancelled) return { resent: false };
		const restored = restoreFiles ? await this.#restoreFiles(target.timestamps, restoreFiles.overwrite) : undefined;
		await this.#sendSnapshot(process, this.#views);
		await this.prompt(text, result.editorImages);
		return { resent: true, restored };
	}

	/** Undo a file restore; resolves to the files left alone because they changed since. */
	async undoRestore(restored: FileRestore): Promise<string[]> {
		const skipped = await Promise.all(
			restored.repos.map(async repo =>
				(await undoRestore(repo.root, repo.current, repo.files)).map(file => path.join(repo.root, file)),
			),
		);
		return skipped.flat();
	}

	async removeQueued(message: string, queue: "steering" | "followUp"): Promise<void> {
		await this.#requireProcess().request("remove_queued_message", { message, queue });
	}

	async rename(name: string): Promise<void> {
		await this.#requireProcess().request("set_session_name", { name });
		// The cached title would otherwise win over the new name until omp reports it.
		this.#title = name;
		await this.#refreshState();
	}

	async abort(): Promise<void> {
		await this.process?.request("abort");
	}

	async compact(): Promise<void> {
		const process = this.#requireProcess();
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "omp: compacting context…" },
			() => process.request("compact", {}),
		);
		await this.#sendSnapshot(process, this.#views);
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#requireProcess().request("set_model", { provider, modelId });
		await this.#refreshState();
		await this.#sendThinkingLevels(this.#views);
	}

	async setThinkingLevel(level: SessionState["thinkingLevel"] & string): Promise<void> {
		await this.#requireProcess().request("set_thinking_level", { level });
		await this.#refreshState();
	}

	async setPlanMode(enabled: boolean): Promise<void> {
		try {
			await this.#requireProcess().request("set_plan_mode", { enabled });
		} finally {
			// Also on failure: the webview toggled its button optimistically.
			await this.#refreshState();
		}
	}

	async availableModels(): Promise<ModelChoice[]> {
		const { models } = await this.#requireProcess().request("get_available_models");
		return models.map(model => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
		}));
	}

	/**
	 * Start recording the microphone for dictation (omp records, and transcribes
	 * through a cloud API such as Groq's Whisper); resolves with the speech model
	 * once recording. `language` is an ISO code, or `""` to let the model detect
	 * it. Unbounded: opening the microphone can wait for the OS permission prompt.
	 */
	async dictationStart(language: string): Promise<string> {
		const { model } = await this.#requireProcess().request("dictation_start", { language });
		this.#dictating = true;
		return model;
	}

	/** Stop recording and transcribe; `submit` when omp's `stt.submitTrigger` asks to send. */
	async dictationStop(): Promise<{ text: string; submit: boolean }> {
		try {
			return await this.#requireProcess().request("dictation_stop", undefined, DICTATION_STOP_TIMEOUT_MS);
		} finally {
			this.#dictating = false;
		}
	}

	/** Drop the running dictation without transcribing it. */
	async dictationCancel(): Promise<void> {
		this.#dictating = false;
		await this.#process?.request("dictation_cancel");
	}

	/** Answer a plan review shown in a view. */
	decidePlan(id: string, value: string): void {
		const review = this.#planReviews.get(id);
		this.#planReviews.delete(id);
		review?.resolve(value);
	}

	post(update: ChatUpdate): void {
		for (const view of this.#views) view.post(update);
	}

	dispose(): void {
		clearTimeout(this.#refreshTimer);
		void this.#stopProcess();
		this.#dialogs.dispose();
		this.#onDidChange.dispose();
		this.#onNeedsAttention.dispose();
	}

	#requireProcess(): OmpProcess {
		const process = this.process;
		if (!process) throw new Error('omp is not running. Use "omp: Restart Agent Process".');
		return process;
	}

	/**
	 * The user message `fromEnd` prompts from the end of the current branch:
	 * its entry id, and the timestamps of it and every later prompt, oldest first.
	 */
	async #findPrompt(
		process: OmpProcess,
		fromEnd: number,
		original: string,
	): Promise<{ entryId: string; timestamps: number[] }> {
		const { entries, leafId } = await process.request("get_entries", {});
		const byId = new Map<string, Record<string, unknown>>();
		for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
		const timestamps: number[] = [];
		let seen = 0;
		for (let id = leafId; id;) {
			const entry = byId.get(id);
			if (!entry) break;
			const prompt = userPrompt(entry);
			if (prompt) {
				if (prompt.timestamp !== undefined) timestamps.unshift(prompt.timestamp);
				if (seen++ === fromEnd) {
					if (prompt.text.trim() !== original.trim()) break;
					// Checkpoints are keyed by the prompt's timestamp: without one there is none to find.
					return { entryId: id, timestamps: prompt.timestamp === undefined ? [] : timestamps };
				}
			}
			id = typeof entry.parentId === "string" ? entry.parentId : null;
		}
		throw new Error("That message is no longer in this session. Reopen the chat and try again.");
	}

	/** Snapshot the repositories before a turn starts; the prompt that starts it keys the checkpoint. */
	async #beginTurnCheckpoint(): Promise<void> {
		this.#turn = undefined;
		const sessionFile = this.sessionFile;
		if (!this.checkpoints || !sessionFile || !readConfig().fileCheckpoints || !(await gitAvailable())) return;
		try {
			const roots = await discoverRepos(workspaceRoots());
			const repos = await Promise.all(
				roots.map(root =>
					snapshotTree(root).then(
						before => ({ root, before }),
						error => {
							this.log.appendLine(`[checkpoint] ${root}: ${errorMessage(error)}`);
							return undefined;
						},
					),
				),
			);
			this.#turn = { sessionFile, repos: repos.filter(repo => repo !== undefined), editedFiles: false };
		} catch (error) {
			this.log.appendLine(`[checkpoint] ${errorMessage(error)}`);
		}
	}

	/**
	 * Track the turn's checkpoint through its events: keyed by its prompt,
	 * marked when one of the session's own file tools runs, closed by `agent_end`.
	 */
	#trackCheckpoint(frame: RpcNotification): void {
		const turn = this.#turn;
		const store = this.checkpoints;
		if (!turn || !store) return;
		if (frame.type === "tool_execution_start") {
			if (editsFiles(frame.toolName, frame.args)) turn.editedFiles = true;
		} else if (
			(frame.type === "message_start" || frame.type === "message_end") &&
			turn.promptTimestamp === undefined
		) {
			const message = frame.message;
			if (message.role !== "user" || message.synthetic) return;
			turn.promptTimestamp = message.timestamp;
			const checkpoint = { promptTimestamp: message.timestamp, repos: turn.repos, editedFiles: turn.editedFiles };
			this.#queueCheckpointWork(() => store.put(turn.sessionFile, checkpoint));
		} else if (frame.type === "agent_end") {
			this.#turn = undefined;
			const promptTimestamp = turn.promptTimestamp;
			if (promptTimestamp === undefined) return;
			this.#queueCheckpointWork(async () => {
				const repos = await Promise.all(
					turn.repos.map(async repo => ({
						...repo,
						after: await snapshotTree(repo.root).catch(() => undefined),
					})),
				);
				await store.put(turn.sessionFile, { promptTimestamp, repos, editedFiles: turn.editedFiles });
			});
		}
	}

	#queueCheckpointWork(work: () => Promise<void>): void {
		this.#checkpointWork = this.#checkpointWork
			.then(work)
			.catch(error => this.log.appendLine(`[checkpoint] ${errorMessage(error)}`));
	}

	/**
	 * Per repository, the snapshots of the turns started by `timestamps` (a
	 * prompt and the later ones on the branch) in which the session edited files
	 * with its own file tools, or undefined when the first prompt has no
	 * checkpoint. Turns that edited nothing are left out, so what changed during
	 * them (other sessions, the user) is never restored. Repositories the first
	 * checkpoint lacks are skipped.
	 */
	async #repoTurns(
		timestamps: readonly number[],
	): Promise<Array<{ root: string; turns: TurnSnapshots[] }> | undefined> {
		const sessionFile = this.sessionFile;
		const [first] = timestamps;
		if (!this.checkpoints || !sessionFile || first === undefined) return undefined;
		await this.#checkpointWork;
		const byPrompt = new Map((await this.checkpoints.load(sessionFile)).map(entry => [entry.promptTimestamp, entry]));
		const start = byPrompt.get(first);
		if (!start) return undefined;
		// Checkpoints saved before this was tracked have no flag: they count as editing.
		const editing = timestamps.flatMap(timestamp => {
			const checkpoint = byPrompt.get(timestamp);
			return checkpoint && checkpoint.editedFiles !== false ? [checkpoint] : [];
		});
		return start.repos.map(({ root }) => ({
			root,
			turns: editing.flatMap(checkpoint => checkpoint.repos.find(repo => repo.root === root) ?? []),
		}));
	}

	async #restoreFiles(timestamps: readonly number[], overwrite: readonly string[]): Promise<FileRestore | undefined> {
		const repos = await this.#repoTurns(timestamps);
		if (!repos) return undefined;
		const results = await Promise.all(
			repos.map(repo => {
				const relative = overwrite
					.map(file => path.relative(repo.root, file))
					.filter(file => !file.startsWith("..") && !path.isAbsolute(file))
					.map(file => file.split(path.sep).join("/"));
				return restoreTurns(repo.root, repo.turns, { write: true, overwrite: new Set(relative) });
			}),
		);
		return {
			repos: results.map(({ root, current, files }) => ({ root, current, files })),
			files: results.flatMap(result => result.files.map(file => path.join(result.root, file.path))),
			conflicts: results.flatMap(result => result.conflicts.map(file => path.join(result.root, file))),
		};
	}

	/** `navigate_tree`, retried while omp finishes winding down an aborted turn. */
	async #navigateTree(process: OmpProcess, entryId: string): Promise<OmpResult<"navigate_tree">> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await process.request("navigate_tree", { entryId });
			} catch (error) {
				if (!(error instanceof OmpCommandError)) throw error;
				if (error.message.startsWith("Unknown command")) {
					throw new Error("Editing messages needs a newer omp (one with the `navigate_tree` RPC command).");
				}
				if (error.code !== "session_busy" || attempt >= NAVIGATE_BUSY_RETRIES) throw error;
				await sleep(NAVIGATE_BUSY_DELAY_MS);
			}
		}
	}

	/** Resolves once no turn or compaction runs (or after `timeoutMs`; omp then reports what is still busy). */
	async #untilIdle(timeoutMs = 15_000): Promise<void> {
		if (!this.running) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const subscription = this.onDidChange(() => {
			if (!this.running) resolve();
		});
		const timer = setTimeout(resolve, timeoutMs);
		try {
			await promise;
		} finally {
			subscription.dispose();
			clearTimeout(timer);
		}
	}

	async #stopProcess(): Promise<void> {
		const process = this.#process;
		this.#process = undefined;
		this.#dialogs.dispose();
		if (process) await process.stop();
	}

	#setStatus(status: AgentStatus): void {
		this.#status = status;
		this.post({ type: "status", status });
		this.#onDidChange.fire(this);
	}

	#notice(level: "info" | "warning" | "error", message: string): void {
		this.log.appendLine(`[${level}] ${message}`);
		this.post({ type: "notice", level, message });
	}

	/**
	 * omp's plan-approval dialog, shown as a card in the chat with the whole plan
	 * (read from the plan file `get_state` reports) and the dialog's options.
	 */
	async #reviewPlan(
		request: { id: string; title: string; options: string[] },
		token: vscode.CancellationToken,
	): Promise<string | undefined> {
		const [heading = "", ...preview] = request.title.split("\n");
		const planFile = (await this.process?.request("get_state"))?.planMode?.planFile;
		const content = planFile ? await fs.readFile(planFile, "utf8").catch(() => undefined) : undefined;
		const update: PlanReview = {
			type: "planReview",
			id: request.id,
			// `Approve plan "<title>" and start implementation?`
			title: /"(.+)"/.exec(heading)?.[1] ?? heading,
			// Without a readable plan file, the dialog's own preview of the plan.
			content: content ?? preview.join("\n").trim(),
			path: content === undefined ? undefined : planFile,
			options: request.options,
		};
		if (token.isCancellationRequested) return undefined;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		this.#planReviews.set(request.id, { update, resolve });
		const cancelled = token.onCancellationRequested(() => {
			this.#planReviews.delete(request.id);
			this.post({ type: "planReviewClosed", id: request.id });
			resolve(undefined);
		});
		if (this.#views.size === 0) this.#onNeedsAttention.fire(this);
		for (const view of this.#views) view.reveal();
		this.post(update);
		try {
			return await promise;
		} finally {
			cancelled.dispose();
		}
	}

	#onFrame(process: OmpProcess, frame: RpcNotification): void {
		if (this.#process !== process) return;
		this.#trackCheckpoint(frame);
		switch (frame.type) {
			case "available_commands_update":
				this.post({ type: "commands", commands: frame.commands });
				break;
			case "command_output":
				this.post({ type: "commandOutput", text: frame.text });
				break;
			case "session_info_update":
				if (frame.title) this.#title = frame.title;
				break;
			case "prompt_result":
				if (frame.status === "error" && frame.error) this.#notice("error", frame.error.message);
				break;
			case "session_settled":
				this.#settled = true;
				this.#onDidChange.fire(this);
				break;
			case "extension_error":
				this.log.appendLine(`[extension error] ${JSON.stringify(frame)}`);
				break;
			case "rpc_frame_error":
				this.log.appendLine(`[frame dropped] ${frame.error}`);
				break;
			case "dictation_state":
				if (frame.state === "idle") this.#dictating = false;
				this.post({ type: "dictation", state: frame.state, text: frame.text, error: frame.error });
				break;
		}
		if (!NON_EVENT_FRAMES[frame.type])
			this.post({ type: "event", event: frame as Extract<ChatUpdate, { type: "event" }>["event"] });
		if (frame.type === "agent_start") {
			this.#busy = true;
			this.#busySince = Date.now();
			this.#settled = false;
			this.#onDidChange.fire(this);
		} else if (frame.type === "agent_end") {
			this.#busy = false;
			if (this.#views.size === 0) this.#finishedUnseen = true;
			this.#onDidChange.fire(this);
		}
		// Approving a plan (a `write` to `xd://propose`) leaves plan mode mid-turn.
		const planDecision = frame.type === "tool_execution_end" && frame.toolName === "write";
		if (STATE_CHANGING_EVENTS[frame.type] || (planDecision && this.#state?.planMode)) this.#scheduleRefresh();
	}

	/** Coalesce bursts of state-changing events into one `get_state`. */
	#scheduleRefresh(): void {
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = setTimeout(() => void this.#refreshState().catch(() => {}), 150);
	}

	async #refreshState(): Promise<void> {
		const process = this.process;
		if (!process) return;
		const [state, stats] = await Promise.all([
			process.request("get_state"),
			process.request("get_session_stats").catch(() => undefined),
		]);
		if (this.#process !== process) return;
		const fileChanged = state.sessionFile !== this.#state?.sessionFile;
		this.#state = state;
		if (state.isSettled !== undefined) this.#settled = state.isSettled && !this.#busy;
		if (state.sessionName) this.#title = state.sessionName;
		else if (fileChanged) this.#title = undefined;
		this.post({
			type: "state",
			state,
			stats,
			title: this.#title,
			busySince: this.#busy ? this.#busySince : undefined,
		});
		this.#onDidChange.fire(this);
	}

	async #sendThinkingLevels(views: Iterable<HostView>): Promise<void> {
		const process = this.process;
		if (!process) return;
		const { levels } = await process.request("get_available_thinking_levels");
		for (const view of views) view.post({ type: "thinkingLevels", levels });
	}

	/** Everything `views` need after a (re)start, session change, or attaching. */
	async #sendSnapshot(process: OmpProcess, views: Iterable<HostView>): Promise<void> {
		const targets = [...views];
		const send = (update: ChatUpdate) => {
			for (const view of targets) view.post(update);
		};
		await this.#refreshState();
		const messages = await this.#history(process);
		if (this.#process !== process) return;
		send({ type: "history", messages });
		const [commands] = await Promise.all([
			process.request("get_available_commands").catch(() => undefined),
			this.#sendThinkingLevels(targets).catch(error => this.log.appendLine(String(error))),
		]);
		if (commands) send({ type: "commands", commands: commands.commands });
		// Model discovery can take seconds; the picker fills in when it finishes.
		void this.availableModels()
			.then(models => send({ type: "models", models }))
			.catch(error => this.log.appendLine(`model list failed: ${errorMessage(error)}`));
	}

	/** The whole transcript, paged so long sessions never exceed a frame. */
	async #history(process: OmpProcess): Promise<AgentMessage[]> {
		const messages: AgentMessage[] = [];
		let cursor: string | undefined;
		try {
			do {
				const page = await process.request("get_messages_page", cursor ? { cursor, limit: 256 } : { limit: 256 });
				messages.push(...page.messages);
				cursor = page.nextCursor;
			} while (cursor);
		} catch (error) {
			// Paging refuses to start mid-turn (`session_busy`) or after the session moved (`stale_cursor`).
			if (!(error instanceof OmpCommandError) || (error.code !== "session_busy" && error.code !== "stale_cursor")) {
				throw error;
			}
			return (await process.request("get_messages")).messages;
		}
		return messages;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** omp's tools that write files directly; the `lsp` tool only when it applies a rename or code action. */
const FILE_EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, notebook: true };
const LSP_EDIT_ACTIONS: Record<string, true> = { rename: true, rename_file: true, code_actions: true };

/**
 * Whether a tool call edits files directly (edit, write, ast_edit, notebook,
 * an applied LSP rename/code action). Shell and code tools do not count: what
 * they change cannot be told apart from other sessions' work.
 */
export function editsFiles(toolName: string, args: unknown): boolean {
	if (FILE_EDIT_TOOLS[toolName]) return true;
	if (toolName !== "lsp" || !args || typeof args !== "object" || !("action" in args)) return false;
	const apply = "apply" in args ? args.apply : undefined;
	return typeof args.action === "string" && LSP_EDIT_ACTIONS[args.action] === true && apply !== false;
}

/**
 * A session entry that is a prompt the user wrote (a non-synthetic user
 * message): its text, joined like the chat shows it, and its timestamp.
 * Undefined for any other entry.
 */
function userPrompt(entry: Record<string, unknown>): { text: string; timestamp: number | undefined } | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") return undefined;
	if ("synthetic" in message && message.synthetic === true) return undefined;
	const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : undefined;
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return { text: content, timestamp };
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			if (typeof block.text === "string") texts.push(block.text);
		}
	}
	return { text: texts.join("\n"), timestamp };
}
