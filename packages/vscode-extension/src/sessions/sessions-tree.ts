import * as fs from "node:fs";
import * as vscode from "vscode";
import type { SessionActivity } from "../protocol";
import { type SessionSummary, listSessions, relativeTime, sessionLabel } from "./session-store";

/** Icon per activity: a spinner while the session works, a green dot once it finished unseen. */
const ACTIVITY_ICONS: Record<SessionActivity, vscode.ThemeIcon> = {
	running: new vscode.ThemeIcon("loading~spin"),
	done: new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed")),
};
const ACTIVITY_LABELS: Record<SessionActivity, string> = {
	running: "Running",
	done: "Finished",
};

export class SessionItem extends vscode.TreeItem {
	constructor(
		readonly session: SessionSummary,
		active: boolean,
		activity: SessionActivity | undefined,
	) {
		super(sessionLabel(session), vscode.TreeItemCollapsibleState.None);
		this.id = session.path;
		const state = activity ? `${ACTIVITY_LABELS[activity]} · ` : "";
		this.description = `${active ? "● " : ""}${state}${relativeTime(session.modified)}`;
		const count = `${session.messageCount}${session.truncated ? "+" : ""} messages`;
		this.tooltip = new vscode.MarkdownString(
			[
				`**${escapeMarkdown(sessionLabel(session))}**`,
				...promptLines(session).map(escapeMarkdown),
				activity === "running" ? "omp is working on this session." : undefined,
				activity === "done" ? "Finished while you were in another session." : undefined,
				`${count} · ${session.modified.toLocaleString()}`,
				`\`${session.id}\``,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		this.iconPath = activity
			? ACTIVITY_ICONS[activity]
			: new vscode.ThemeIcon(active ? "comment-discussion" : "comment");
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

	/** @param activities what each session with a process in this window is doing */
	constructor(private readonly activities: () => Record<string, SessionActivity>) {}

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
		const activities = this.activities();
		return this.#sessions.map(
			session => new SessionItem(session, session.path === this.#activeFile, activities[session.path]),
		);
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
		detail: promptLines(session).join(" · ") || undefined,
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

/** "First: …" and "Last: …" (or "Only prompt: …") lines of a session's prompts. */
function promptLines(session: SessionSummary): string[] {
	if (session.singlePrompt && session.firstMessage) return [`Only prompt: ${session.firstMessage}`];
	return [
		...(session.firstMessage ? [`First: ${session.firstMessage}`] : []),
		...(session.lastMessage ? [`Last: ${session.lastMessage}`] : []),
	];
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
