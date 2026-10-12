import * as fs from "node:fs";
import * as vscode from "vscode";
import { type SessionSummary, listSessions, relativeTime, sessionLabel } from "./session-store";

export class SessionItem extends vscode.TreeItem {
	constructor(
		readonly session: SessionSummary,
		active: boolean,
	) {
		super(sessionLabel(session), vscode.TreeItemCollapsibleState.None);
		this.id = session.path;
		this.description = `${active ? "● " : ""}${relativeTime(session.modified)}`;
		const count = `${session.messageCount}${session.truncated ? "+" : ""} messages`;
		this.tooltip = new vscode.MarkdownString(
			[
				`**${escapeMarkdown(sessionLabel(session))}**`,
				session.title && session.firstMessage ? escapeMarkdown(session.firstMessage) : undefined,
				`${count} · ${session.modified.toLocaleString()}`,
				`\`${session.id}\``,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		this.iconPath = new vscode.ThemeIcon(active ? "comment-discussion" : "comment");
		this.contextValue = active ? "session.active" : "session";
		this.command = { command: "ompCustom.openSession", title: "Open Session", arguments: [this] };
	}
}

/** Sessions of the workspace's omp session directory, newest first; refreshes when files change. */
export class SessionsTree implements vscode.TreeDataProvider<SessionItem>, vscode.Disposable {
	readonly #onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.#onDidChangeTreeData.event;
	#dir: string | undefined;
	#activeFile: string | undefined;
	#watcher: fs.FSWatcher | undefined;
	#debounce: NodeJS.Timeout | undefined;
	#sessions: SessionSummary[] = [];

	/** Point the tree at `dir` (the active chat's session directory) and mark `activeFile`. */
	setLocation(dir: string | undefined, activeFile: string | undefined): void {
		if (dir === this.#dir && activeFile === this.#activeFile) return;
		const dirChanged = dir !== this.#dir;
		this.#dir = dir;
		this.#activeFile = activeFile;
		if (dirChanged) this.#watch();
		this.refresh();
	}

	get sessions(): readonly SessionSummary[] {
		return this.#sessions;
	}

	get directory(): string | undefined {
		return this.#dir;
	}

	refresh(): void {
		this.#onDidChangeTreeData.fire();
	}

	getTreeItem(item: SessionItem): vscode.TreeItem {
		return item;
	}

	async getChildren(element?: SessionItem): Promise<SessionItem[]> {
		if (element || !this.#dir) return [];
		this.#sessions = await listSessions(this.#dir);
		return this.#sessions.map(session => new SessionItem(session, session.path === this.#activeFile));
	}

	dispose(): void {
		this.#watcher?.close();
		clearTimeout(this.#debounce);
		this.#onDidChangeTreeData.dispose();
	}

	#watch(): void {
		this.#watcher?.close();
		this.#watcher = undefined;
		if (!this.#dir) return;
		try {
			// Session files append on every entry; coalesce bursts into one re-list.
			this.#watcher = fs.watch(this.#dir, () => {
				clearTimeout(this.#debounce);
				this.#debounce = setTimeout(() => this.refresh(), 750);
			});
		} catch {
			// The directory appears with the first session; the next setLocation retries.
		}
	}
}

/** Pick a session of `sessions` with a QuickPick. */
export async function pickSession(
	sessions: readonly SessionSummary[],
	activeFile: string | undefined,
): Promise<SessionSummary | undefined> {
	const items = sessions.map(session => ({
		label: `${session.path === activeFile ? "$(comment-discussion) " : ""}${sessionLabel(session)}`,
		description: relativeTime(session.modified),
		detail: session.title ? session.firstMessage : undefined,
		session,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		title: "omp: Switch Session",
		placeHolder: sessions.length ? "Search sessions" : "No sessions in this workspace yet",
		matchOnDescription: true,
		matchOnDetail: true,
	});
	return picked?.session;
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
