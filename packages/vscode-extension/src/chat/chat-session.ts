/**
 * One chat surface (sidebar view or editor tab) bound to one omp process.
 *
 * Forwards live session events to the webview untouched, answers its
 * requests with RPC commands, and re-sends snapshots (history, state,
 * models) whenever the session changes underneath it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
	AgentMessage,
	RpcNotification,
	SessionState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import { agentDir, ompCommand, readConfig, workspaceCwd } from "../config";
import { DialogBridge } from "../dialogs";
import type { AgentStatus, ChatRequest, ChatUpdate, ModelChoice } from "../protocol";
import { OmpCommandError, OmpProcess } from "../rpc/omp-process";
import { webviewHtml } from "../webview-html";
import { guessSessionDir, listSessions, relativeTime, sessionLabel } from "../sessions/session-store";

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

/** Events after which the session snapshot (state, stats, title) is re-read. */
const STATE_CHANGING_EVENTS: Record<string, true> = {
	agent_end: true,
	model_changed: true,
	thinking_level_changed: true,
	auto_compaction_end: true,
	session_settled: true,
	session_info_update: true,
	config_update: true,
};

export interface ChatSurface {
	readonly webview: vscode.Webview;
	readonly visible: boolean;
	reveal(): void;
}

/** What a new process should open. */
export type SessionTarget = { kind: "continue" } | { kind: "new" } | { kind: "resume"; sessionFile: string };

export class ChatSession implements vscode.Disposable {
	#process: OmpProcess | undefined;
	#status: AgentStatus = { phase: "starting" };
	#state: SessionState | undefined;
	#title: string | undefined;
	/** Between `agent_start` and `agent_end`: a turn is running. */
	#busy = false;
	#webviewReady = false;
	#refreshTimer: NodeJS.Timeout | undefined;
	readonly #dialogs: DialogBridge;
	readonly #disposables: vscode.Disposable[] = [];
	readonly #onDidChange = new vscode.EventEmitter<ChatSession>();
	/** Fires when the process, session file, title, model, or busy state changes. */
	readonly onDidChange = this.#onDidChange.event;
	readonly #statusTexts = new Map<string, string>();
	/** Plan reviews awaiting a decision, by request id; re-sent when the webview reloads. */
	readonly #planReviews = new Map<
		string,
		{ update: Extract<ChatUpdate, { type: "planReview" }>; resolve(value: string | undefined): void }
	>();

	constructor(
		readonly surface: ChatSurface,
		readonly extensionUri: vscode.Uri,
		readonly log: vscode.OutputChannel,
		/** Commands the webview can trigger that live outside this session. */
		readonly commands: {
			openSettings(): void;
			login(session: ChatSession): void;
			attachFiles(session: ChatSession): void;
		},
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
		surface.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")],
		};
		surface.webview.html = webviewHtml(surface.webview, extensionUri, "chat");
		this.#disposables.push(
			surface.webview.onDidReceiveMessage((request: ChatRequest) => {
				void this.#handle(request).catch(error => this.#notice("error", errorMessage(error)));
			}),
		);
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
	get process(): OmpProcess | undefined {
		return this.#process?.running ? this.#process : undefined;
	}
	/** Extension status texts (`setStatus`), e.g. from omp extensions. */
	get statusTexts(): ReadonlyMap<string, string> {
		return this.#statusTexts;
	}

	/** Start (or restart) omp on `target`; resolves once the first snapshot reached the webview. */
	async start(target: SessionTarget): Promise<void> {
		await this.#stopProcess();
		const cwd = workspaceCwd();
		const process = new OmpProcess(ompCommand(cwd));
		this.#process = process;
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
		await this.#sendSnapshot(process);
	}

	async restart(): Promise<void> {
		const sessionFile = this.#state?.sessionFile;
		await this.start(sessionFile ? { kind: "resume", sessionFile } : { kind: "continue" });
	}

	post(update: ChatUpdate): void {
		if (this.#webviewReady) void this.surface.webview.postMessage(update);
	}

	/** Insert text into the composer, revealing the chat. */
	insertText(text: string): void {
		this.surface.reveal();
		this.post({ type: "insertText", text });
	}

	async newSession(): Promise<void> {
		const process = this.#requireProcess();
		const result = await process.request("new_session", {});
		if (result.cancelled) return;
		await this.#sendSnapshot(process);
	}

	async switchSession(sessionFile: string): Promise<void> {
		const process = this.process;
		if (!process) {
			await this.start({ kind: "resume", sessionFile });
			return;
		}
		const result = await process.request("switch_session", { sessionPath: sessionFile });
		if (result.cancelled) return;
		await this.#sendSnapshot(process);
	}

	async rename(name: string): Promise<void> {
		await this.#requireProcess().request("set_session_name", { name });
		this.#scheduleRefresh();
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
		await this.#sendSnapshot(process);
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#requireProcess().request("set_model", { provider, modelId });
		await this.#refreshState();
		await this.#sendThinkingLevels();
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

	dispose(): void {
		clearTimeout(this.#refreshTimer);
		void this.#stopProcess();
		this.#dialogs.dispose();
		for (const disposable of this.#disposables) disposable.dispose();
		this.#onDidChange.dispose();
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
		const update: Extract<ChatUpdate, { type: "planReview" }> = {
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
		this.surface.reveal();
		this.post(update);
		try {
			return await promise;
		} finally {
			cancelled.dispose();
		}
	}

	async #handle(request: ChatRequest): Promise<void> {
		switch (request.type) {
			case "ready":
				this.#webviewReady = true;
				this.post({ type: "status", status: this.#status });
				if (this.process) await this.#sendSnapshot(this.process);
				for (const review of this.#planReviews.values()) this.post(review.update);
				return;
			case "prompt": {
				const process = this.#requireProcess();
				await process.request("prompt", {
					message: request.text,
					streamingBehavior: readConfig().sendWhileBusy,
				});
				return;
			}
			case "abort":
				await this.abort();
				return;
			case "newSession":
				await this.newSession();
				return;
			case "listSessions": {
				const dir = this.#state?.sessionFile
					? path.dirname(this.#state.sessionFile)
					: await guessSessionDir(path.join(agentDir(), "sessions"), workspaceCwd());
				const sessions = await listSessions(dir);
				this.post({
					type: "sessions",
					sessions: sessions.map(session => ({
						path: session.path,
						label: sessionLabel(session),
						detail: session.title ? session.firstMessage : undefined,
						age: relativeTime(session.modified),
						active: session.path === this.#state?.sessionFile,
					})),
				});
				return;
			}
			case "openSession":
				await this.switchSession(request.path);
				return;
			case "attachFiles":
				this.commands.attachFiles(this);
				return;
			case "setModel":
				await this.setModel(request.provider, request.modelId);
				return;
			case "setThinkingLevel":
				await this.setThinkingLevel(request.level);
				return;
			case "setPlanMode":
				await this.setPlanMode(request.enabled);
				if (request.prompt) await this.#handle({ type: "prompt", text: request.prompt });
				return;
			case "openSettings":
				this.commands.openSettings();
				return;
			case "login":
				this.commands.login(this);
				return;
			case "compact":
				await this.compact();
				return;
			case "restart":
				await this.restart();
				return;
			case "planDecision": {
				const review = this.#planReviews.get(request.id);
				this.#planReviews.delete(request.id);
				review?.resolve(request.value);
				return;
			}
			case "openPlan":
				// Rendered, as Claude Code and Codex show plans; the preview links to the source.
				await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(request.path));
				return;
			case "openFile":
				await openWorkspaceFile(request.path, request.line);
				return;
			case "openExternal":
				await vscode.env.openExternal(vscode.Uri.parse(request.url, true));
				return;
			case "removeQueued":
				await this.#requireProcess().request("remove_queued_message", {
					message: request.message,
					queue: request.queue,
				});
				return;
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
			case "extension_error":
				this.log.appendLine(`[extension error] ${JSON.stringify(frame)}`);
				break;
			case "rpc_frame_error":
				this.log.appendLine(`[frame dropped] ${frame.error}`);
				break;
		}
		if (!NON_EVENT_FRAMES[frame.type])
			this.post({ type: "event", event: frame as Extract<ChatUpdate, { type: "event" }>["event"] });
		if (frame.type === "agent_start" || frame.type === "agent_end") {
			this.#busy = frame.type === "agent_start";
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
		if (state.sessionName) this.#title = state.sessionName;
		else if (fileChanged) this.#title = undefined;
		this.post({ type: "state", state, stats, title: this.#title });
		this.#onDidChange.fire(this);
	}

	async #sendThinkingLevels(): Promise<void> {
		const process = this.process;
		if (!process) return;
		const { levels } = await process.request("get_available_thinking_levels");
		this.post({ type: "thinkingLevels", levels });
	}

	/** Everything the webview needs after a (re)start or session switch. */
	async #sendSnapshot(process: OmpProcess): Promise<void> {
		this.#title = undefined;
		await this.#refreshState();
		const messages = await this.#history(process);
		if (this.#process !== process) return;
		this.post({ type: "history", messages });
		const [commands] = await Promise.all([
			process.request("get_available_commands").catch(() => undefined),
			this.#sendThinkingLevels().catch(error => this.log.appendLine(String(error))),
		]);
		if (commands) this.post({ type: "commands", commands: commands.commands });
		// Model discovery can take seconds; the picker fills in when it finishes.
		void this.availableModels()
			.then(models => this.post({ type: "models", models }))
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

/** Open `file` (absolute, or relative to the workspace) at an optional 1-based line. */
export async function openWorkspaceFile(file: string, line?: number): Promise<void> {
	const absolute = path.isAbsolute(file) ? file : path.join(workspaceCwd(), file);
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
	const position = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
	await vscode.window.showTextDocument(document, {
		preview: true,
		selection: position && new vscode.Range(position, position),
	});
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
