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
import * as vscode from "vscode";
import type {
	AgentMessage,
	ImageContent,
	RpcNotification,
	SessionState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import { ompCommand, readConfig, workspaceCwd } from "../config";
import { DialogBridge } from "../dialogs";
import type { AgentStatus, ChatUpdate, ModelChoice } from "../protocol";
import { OmpCommandError, OmpProcess } from "../rpc/omp-process";

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

/** What a new process should open. */
export type SessionTarget = { kind: "continue" } | { kind: "new" } | { kind: "resume"; sessionFile: string };

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
	/** Idle with nothing queued or pending (omp's `session_settled` / `get_state.isSettled`). */
	#settled = true;
	/** A turn finished while no view was attached; cleared when a view shows the session. */
	#finishedUnseen = false;
	#refreshTimer: NodeJS.Timeout | undefined;
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

	constructor(readonly log: vscode.OutputChannel) {
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
		const process = new OmpProcess(ompCommand(cwd));
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

	async prompt(text: string, images: ImageContent[] | undefined): Promise<void> {
		await this.#requireProcess().request("prompt", {
			message: text,
			...(images?.length ? { images } : {}),
			streamingBehavior: readConfig().sendWhileBusy,
		});
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
		}
		if (!NON_EVENT_FRAMES[frame.type])
			this.post({ type: "event", event: frame as Extract<ChatUpdate, { type: "event" }>["event"] });
		if (frame.type === "agent_start") {
			this.#busy = true;
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
		this.post({ type: "state", state, stats, title: this.#title });
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
