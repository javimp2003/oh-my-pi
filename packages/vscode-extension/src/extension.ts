import * as path from "node:path";
import * as vscode from "vscode";
import { ChatSession, errorMessage } from "./chat/chat-session";
import { ChatRegistry } from "./chat/chat-views";
import { agentDir, readConfig, workspaceCwd } from "./config";
import { renameStoredSession } from "./sessions/rename";
import { guessSessionDir, sessionLabel, sessionPaths } from "./sessions/session-store";
import { SessionItem, SessionsTree, pickSession } from "./sessions/sessions-tree";
import { SettingsPanel, openConfigFile } from "./settings/settings-panel";

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel("omp (custom)");
	const tree = new SessionsTree();
	const chats: ChatRegistry = new ChatRegistry(context.extensionUri, log, {
		openSettings: () => SettingsPanel.show(context.extensionUri),
		login: session => void login(session),
		attachFiles: session => void attachFiles(session),
	});
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = "ompCustom.focusChat";

	const updateActive = async (session: ChatSession | undefined) => {
		const sessionFile = session?.state?.sessionFile;
		const dir = sessionFile
			? path.dirname(sessionFile)
			: await guessSessionDir(path.join(agentDir(), "sessions"), workspaceCwd());
		tree.setLocation(dir, sessionFile);
		renderStatusBar(statusBar, session);
	};
	void updateActive(undefined);

	/** The active chat, or an error message when none can be shown. */
	const activeChat = async (): Promise<ChatSession | undefined> => {
		const session = await chats.ensureActive();
		if (!session) void vscode.window.showErrorMessage("omp: open the omp chat first.");
		return session;
	};

	const showSessions = async () => {
		const session = await activeChat();
		if (!session) return;
		await tree.getChildren();
		const picked = await pickSession(tree.sessions, session.state?.sessionFile);
		if (picked) await session.switchSession(picked.path);
	};

	const attachFiles = async (session: ChatSession) => {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: true,
			defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
			openLabel: "Attach",
		});
		if (!picked?.length) return;
		session.insertText(`${picked.map(file => mention(vscode.workspace.asRelativePath(file, false))).join(" ")} `);
	};

	const login = async (session?: ChatSession) => {
		const chat = session ?? (await activeChat());
		const process = chat?.process;
		if (!chat || !process) return;
		const { providers } = await process.request("get_login_providers");
		const picked = await vscode.window.showQuickPick(
			providers
				.filter(provider => provider.available)
				.map(provider => ({
					label: provider.name,
					description: provider.authenticated ? "$(check) signed in" : undefined,
					provider,
				})),
			{ title: "omp: Log In", placeHolder: "Provider to sign in to" },
		);
		if (!picked) return;
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `omp: signing in to ${picked.provider.name}…`,
				cancellable: false,
			},
			() => process.request("login", { providerId: picked.provider.id }),
		);
		void vscode.window.showInformationMessage(`omp: signed in to ${picked.provider.name}.`);
		await chat.restart();
	};

	const logout = async () => {
		const chat = await activeChat();
		const process = chat?.process;
		if (!process) return;
		const { providers } = await process.request("get_login_providers");
		const provider = await vscode.window.showQuickPick(
			providers.filter(entry => entry.authenticated).map(entry => ({ label: entry.name, entry })),
			{ title: "omp: Log Out", placeHolder: "Provider to sign out of" },
		);
		if (!provider) return;
		const { accounts } = await process.request("get_logout_accounts", { providerId: provider.entry.id });
		const account =
			accounts.length === 1
				? { account: accounts[0]! }
				: await vscode.window.showQuickPick(
						accounts.map(account => ({
							label: account.label,
							description: account.active ? "in use" : undefined,
							detail: account.detail,
							account,
						})),
						{ title: `omp: Log Out of ${provider.label}` },
					);
		if (!account) return;
		const { remainingSource } = await process.request("logout", {
			providerId: provider.entry.id,
			credentialId: account.account.credentialId,
		});
		void vscode.window.showInformationMessage(
			remainingSource
				? `omp: signed out; ${provider.label} still authenticates via ${remainingSource}.`
				: `omp: signed out of ${provider.label}.`,
		);
	};

	/** Rename a session: the active one in place, any other through a short-lived omp process. */
	const renameSession = async (item?: SessionItem) => {
		const chat = chats.active;
		const target = item?.session.path ?? chat?.state?.sessionFile;
		if (!target) return;
		const current = item ? sessionLabel(item.session) : chat?.title;
		const name = await vscode.window.showInputBox({
			title: "omp: Rename Session",
			value: current,
			prompt: "New name",
		});
		if (!name?.trim()) return;
		if (chat?.process && chat.state?.sessionFile === target) await chat.rename(name.trim());
		else await renameStoredSession(target, name.trim(), log);
		tree.refresh();
	};

	const deleteSession = async (item?: SessionItem) => {
		if (!item) return;
		const label = sessionLabel(item.session);
		const choice = await vscode.window.showWarningMessage(
			`Delete the omp session "${label}"?`,
			{ modal: true, detail: "The session file and its artifacts move to the trash." },
			"Delete",
		);
		if (choice !== "Delete") return;
		const chat = chats.active;
		if (chat?.process && chat.state?.sessionFile === item.session.path) await chat.newSession();
		for (const file of sessionPaths(item.session.path)) {
			await vscode.workspace.fs
				.delete(vscode.Uri.file(file), { recursive: true, useTrash: true })
				.then(undefined, (error: unknown) => {
					if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
				});
		}
		tree.refresh();
	};

	const selectModel = async () => {
		const chat = await activeChat();
		if (!chat?.process) return;
		const models = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: "omp: loading models" },
			() => chat.availableModels(),
		);
		const current = chat.state?.model;
		const picked = await vscode.window.showQuickPick(
			models.map(model => ({
				label: `${model.provider === current?.provider && model.id === current?.id ? "$(check) " : ""}${model.name}`,
				description: `${model.provider}/${model.id}`,
				detail: model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K context` : undefined,
				model,
			})),
			{ title: "omp: Select Model", matchOnDescription: true },
		);
		if (picked) await chat.setModel(picked.model.provider, picked.model.id);
	};

	const selectThinkingLevel = async () => {
		const chat = await activeChat();
		const process = chat?.process;
		if (!chat || !process) return;
		const { levels } = await process.request("get_available_thinking_levels");
		if (levels.length === 0) {
			void vscode.window.showInformationMessage("omp: the current model has no thinking levels.");
			return;
		}
		const level = await vscode.window.showQuickPick(
			levels.map(value => ({ label: `${value === chat.state?.thinkingLevel ? "$(check) " : ""}${value}`, value })),
			{ title: "omp: Thinking Level" },
		);
		if (level) await chat.setThinkingLevel(level.value);
	};

	const addSelectionToChat = async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const chat = await chats.focusSidebar().then(sidebar => chats.active ?? sidebar);
		if (!chat) return;
		const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
		const parts = editor.selections
			.filter(selection => !selection.isEmpty)
			.map(selection => {
				const start = selection.start.line + 1;
				const end = selection.end.line + (selection.end.character === 0 ? 0 : 1);
				const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
				const fence = "```";
				return `\`${relative}\` (${range}):\n${fence}${editor.document.languageId}\n${editor.document.getText(selection)}\n${fence}\n`;
			});
		chat.insertText(parts.length ? parts.join("\n") : `${mention(relative)} `);
	};

	const addFileToChat = async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
		const targets = selected?.length ? selected : uri ? [uri] : [vscode.window.activeTextEditor?.document.uri];
		const files = targets.filter((target): target is vscode.Uri => target !== undefined);
		if (!files.length) return;
		const chat = await chats.focusSidebar().then(sidebar => chats.active ?? sidebar);
		chat?.insertText(`${files.map(file => mention(vscode.workspace.asRelativePath(file, false))).join(" ")} `);
	};

	const run =
		(action: (...args: never[]) => Promise<unknown> | unknown) =>
		async (...args: never[]) => {
			try {
				await action(...args);
			} catch (error) {
				log.appendLine(`[error] ${errorMessage(error)}`);
				void vscode.window.showErrorMessage(`omp: ${errorMessage(error)}`);
			}
		};

	context.subscriptions.push(
		log,
		tree,
		chats,
		statusBar,
		vscode.window.registerWebviewViewProvider(ChatRegistry.viewId, chats, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.createTreeView("ompCustom.sessions", { treeDataProvider: tree, showCollapseAll: false }),
		chats.onDidChangeActive(session => void updateActive(session)),
		vscode.commands.registerCommand(
			"ompCustom.focusChat",
			run(() => chats.focusSidebar()),
		),
		vscode.commands.registerCommand(
			"ompCustom.openChatInEditor",
			run(() => chats.openPanel({ kind: "new" })),
		),
		vscode.commands.registerCommand(
			"ompCustom.newSession",
			run(async () => (await activeChat())?.newSession()),
		),
		vscode.commands.registerCommand("ompCustom.showSessions", run(showSessions)),
		vscode.commands.registerCommand(
			"ompCustom.refreshSessions",
			run(() => tree.refresh()),
		),
		vscode.commands.registerCommand(
			"ompCustom.openSession",
			run(async (item: SessionItem) => {
				const chat = await activeChat();
				chat?.surface.reveal();
				await chat?.switchSession(item.session.path);
			}),
		),
		vscode.commands.registerCommand("ompCustom.renameSession", run(renameSession)),
		vscode.commands.registerCommand("ompCustom.deleteSession", run(deleteSession)),
		vscode.commands.registerCommand(
			"ompCustom.revealSessionFile",
			run((item: SessionItem) =>
				vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(item.session.path)),
			),
		),
		vscode.commands.registerCommand("ompCustom.selectModel", run(selectModel)),
		vscode.commands.registerCommand("ompCustom.selectThinkingLevel", run(selectThinkingLevel)),
		vscode.commands.registerCommand("ompCustom.addSelectionToChat", run(addSelectionToChat)),
		vscode.commands.registerCommand("ompCustom.addFileToChat", run(addFileToChat)),
		vscode.commands.registerCommand(
			"ompCustom.openSettings",
			run(() => SettingsPanel.show(context.extensionUri)),
		),
		vscode.commands.registerCommand("ompCustom.openConfigFile", run(openConfigFile)),
		vscode.commands.registerCommand(
			"ompCustom.login",
			run(() => login()),
		),
		vscode.commands.registerCommand("ompCustom.logout", run(logout)),
		vscode.commands.registerCommand(
			"ompCustom.compact",
			run(async () => (await activeChat())?.compact()),
		),
		vscode.commands.registerCommand(
			"ompCustom.abort",
			run(() => chats.active?.abort()),
		),
		vscode.commands.registerCommand(
			"ompCustom.restartAgent",
			run(async () => (await activeChat())?.restart()),
		),
		vscode.commands.registerCommand(
			"ompCustom.openInTerminal",
			run(() => {
				const { executable, args, env } = readConfig();
				const terminal = vscode.window.createTerminal({
					name: "omp",
					shellPath: executable,
					shellArgs: [...args],
					cwd: workspaceCwd(),
					env,
					iconPath: vscode.Uri.joinPath(context.extensionUri, "media", "icon.png"),
				});
				terminal.show();
			}),
		),
		vscode.commands.registerCommand("ompCustom.showLog", () => log.show()),
	);
}

export function deactivate(): void {}

/** An omp `@file` mention; paths with spaces are quoted. */
function mention(relative: string): string {
	return /\s/.test(relative) ? `@"${relative}"` : `@${relative}`;
}

function renderStatusBar(item: vscode.StatusBarItem, session: ChatSession | undefined): void {
	if (!session) {
		item.hide();
		return;
	}
	const state = session.state;
	const busy = session.busy || state?.isCompacting;
	const status = session.status;
	const icon =
		status.phase === "stopped" ? "$(error)" : busy || status.phase === "starting" ? "$(loading~spin)" : "$(sparkle)";
	item.text = `${icon} omp${state?.model ? ` · ${state.model.id}` : ""}`;
	const lines = [
		session.title ? `**${session.title}**` : "New session",
		state?.contextUsage ? `Context: ${Math.round(state.contextUsage.percent)}%` : undefined,
		status.phase === "stopped" ? `Stopped: ${status.message}` : undefined,
		...session.statusTexts.values(),
	].filter(Boolean);
	item.tooltip = new vscode.MarkdownString(lines.join("\n\n"));
	item.show();
}
