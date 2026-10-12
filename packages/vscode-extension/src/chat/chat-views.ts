/**
 * Chat surfaces: the sidebar webview view and any number of editor tabs, each
 * with its own omp process. The most recently focused one is "active": it is
 * what commands, the sessions list, and the status bar act on.
 */
import * as vscode from "vscode";
import { readConfig } from "../config";
import { ChatSession, type SessionTarget } from "./chat-session";

type SessionCommands = ChatSession["commands"];

export class ChatRegistry implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = "ompCustom.chat";

	#sidebar: ChatSession | undefined;
	#sidebarView: vscode.WebviewView | undefined;
	readonly #panels = new Set<ChatSession>();
	#active: ChatSession | undefined;
	readonly #onDidChangeActive = new vscode.EventEmitter<ChatSession | undefined>();
	/** Fires when the active chat changes or its session/state changes. */
	readonly onDidChangeActive = this.#onDidChangeActive.event;

	constructor(
		readonly extensionUri: vscode.Uri,
		readonly log: vscode.OutputChannel,
		readonly commands: SessionCommands,
	) {}

	get active(): ChatSession | undefined {
		return this.#active ?? this.#sidebar;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.#sidebarView = view;
		const session = new ChatSession(
			{
				webview: view.webview,
				get visible() {
					return view.visible;
				},
				reveal: () => view.show(true),
			},
			this.extensionUri,
			this.log,
			this.commands,
		);
		this.#sidebar = session;
		this.#track(session);
		view.onDidChangeVisibility(() => {
			if (view.visible) this.#setActive(session);
		});
		view.onDidDispose(() => {
			this.#sidebar = undefined;
			this.#sidebarView = undefined;
			this.#forget(session);
		});
		this.#setActive(session);
		void session.start(readConfig().resumeLastSession ? { kind: "continue" } : { kind: "new" });
	}

	/** Reveal the sidebar chat (creating it if VS Code has not resolved the view yet). */
	async focusSidebar(): Promise<ChatSession | undefined> {
		if (this.#sidebarView) this.#sidebarView.show(false);
		else await vscode.commands.executeCommand(`${ChatRegistry.viewId}.focus`);
		return this.#sidebar;
	}

	/** Open a chat in a new editor tab on `target`. */
	openPanel(target: SessionTarget): ChatSession {
		const panel = vscode.window.createWebviewPanel(
			"ompCustom.chatPanel",
			"omp",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.png");
		const session = new ChatSession(
			{
				webview: panel.webview,
				get visible() {
					return panel.visible;
				},
				reveal: () => panel.reveal(),
			},
			this.extensionUri,
			this.log,
			this.commands,
		);
		this.#panels.add(session);
		this.#track(session);
		session.onDidChange(() => {
			panel.title = session.title ? `omp: ${session.title}` : "omp";
		});
		panel.onDidChangeViewState(() => {
			if (panel.active) this.#setActive(session);
		});
		panel.onDidDispose(() => {
			this.#panels.delete(session);
			this.#forget(session);
		});
		this.#setActive(session);
		void session.start(target);
		return session;
	}

	/** The chat to act on, revealing the sidebar when there is none yet. */
	async ensureActive(): Promise<ChatSession | undefined> {
		return this.active ?? (await this.focusSidebar());
	}

	dispose(): void {
		this.#sidebar?.dispose();
		for (const panel of this.#panels) panel.dispose();
		this.#onDidChangeActive.dispose();
	}

	#track(session: ChatSession): void {
		session.onDidChange(() => {
			if (session === this.active) this.#onDidChangeActive.fire(session);
		});
	}

	#forget(session: ChatSession): void {
		session.dispose();
		if (this.#active === session) this.#active = undefined;
		this.#onDidChangeActive.fire(this.active);
	}

	#setActive(session: ChatSession): void {
		if (this.#active === session) return;
		this.#active = session;
		this.#onDidChangeActive.fire(session);
	}
}
