import * as path from "node:path";
import * as vscode from "vscode";
import { errorMessage } from "../chat/agent-host";
import { agentDir } from "../config";
import { runOmp } from "../settings/settings-panel";
import type { SkillProposalSummary } from "../protocol";
import type { SkillProposalStore } from "./proposals";

/** One skill of `omp skill list --json`. */
export interface SkillSummary {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	hide: boolean;
	/** omp may propose corrections to this skill after tasks that relied on it. */
	selfImprovable: boolean;
}

/** One self-improvement edit of `omp skill history --json`. */
export interface HistoryEntry {
	/** Passed to `omp skill revert`. */
	id: string;
	skill: string;
	createdAt: number;
	summary: string;
	/** Paths relative to the skill directory. */
	files: string[];
	diff: string;
	revertedAt?: number;
}

export type SkillsNode =
	| { kind: "skill"; skill: SkillSummary; proposals: SkillProposalSummary[]; history: HistoryEntry[] }
	| { kind: "proposal"; proposal: SkillProposalSummary }
	| { kind: "entry"; entry: HistoryEntry };

/** The skills omp discovers, each with its pending proposals and omp's applied edits to it, newest first. */
export class SkillsTree implements vscode.TreeDataProvider<SkillsNode>, vscode.Disposable {
	readonly #onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.#onDidChangeTreeData.event;
	readonly #watcher: vscode.FileSystemWatcher;
	#debounce: NodeJS.Timeout | undefined;
	#loaded = false;
	#skills: SkillSummary[] = [];
	#entries: HistoryEntry[] = [];

	constructor(
		private readonly log: vscode.OutputChannel,
		private readonly proposals: SkillProposalStore,
	) {
		// omp writes one JSON file per edit and rewrites it on revert, from the chat or the CLI.
		this.#watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.join(agentDir(), "skill-history")), "**/*.json"),
		);
		const schedule = () => {
			clearTimeout(this.#debounce);
			this.#debounce = setTimeout(() => void this.refresh(), 300);
		};
		this.#watcher.onDidCreate(schedule);
		this.#watcher.onDidChange(schedule);
		this.#watcher.onDidDelete(schedule);
		proposals.onDidChange(() => this.#onDidChangeTreeData.fire());
	}

	/** Re-read skills and history from omp and repaint the view. */
	async refresh(): Promise<void> {
		this.#loaded = true;
		try {
			const [list, history] = await Promise.all([
				runOmp(["skill", "list", "--json"]),
				runOmp(["skill", "history", "--json"]),
			]);
			this.#skills = listField<SkillSummary>(JSON.parse(list), "skills");
			this.#entries = listField<HistoryEntry>(JSON.parse(history), "entries");
		} catch (error) {
			this.#skills = [];
			this.#entries = [];
			this.log.appendLine(`[error] Could not list skills: ${errorMessage(error)}`);
		}
		this.#onDidChangeTreeData.fire();
	}

	getTreeItem(node: SkillsNode): vscode.TreeItem {
		if (node.kind === "skill") {
			const { skill, proposals } = node;
			const item = new vscode.TreeItem(
				skill.name,
				node.history.length > 0 || proposals.length > 0
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None,
			);
			const pending =
				proposals.length > 0 ? ` · ${proposals.length} proposal${proposals.length === 1 ? "" : "s"}` : "";
			item.description = `${skill.source}${skill.selfImprovable ? " · self-improving" : ""}${pending}`;
			item.tooltip = skill.description;
			item.iconPath = new vscode.ThemeIcon("book");
			item.contextValue = "skill";
			item.command = { command: "vscode.open", title: "Open Skill", arguments: [vscode.Uri.file(skill.filePath)] };
			return item;
		}
		if (node.kind === "proposal") {
			const { proposal } = node;
			const item = new vscode.TreeItem(proposal.summary, vscode.TreeItemCollapsibleState.None);
			item.description = proposal.stale ? "outdated" : `proposed · ${new Date(proposal.createdAt).toLocaleString()}`;
			item.tooltip = proposal.reason;
			item.iconPath = new vscode.ThemeIcon(proposal.stale ? "warning" : "lightbulb");
			item.contextValue = proposal.stale ? "skillProposalStale" : "skillProposal";
			item.command = { command: "ompCustom.showSkillProposal", title: "Show Skill Proposal", arguments: [proposal] };
			return item;
		}
		const { entry } = node;
		const item = new vscode.TreeItem(entry.summary, vscode.TreeItemCollapsibleState.None);
		item.description = `${new Date(entry.createdAt).toLocaleString()}${entry.revertedAt ? " · reverted" : ""}`;
		item.tooltip = entry.files.join("\n");
		item.contextValue = entry.revertedAt ? "skillHistoryReverted" : "skillHistory";
		item.command = { command: "ompCustom.showSkillChange", title: "Show Skill Change", arguments: [entry] };
		return item;
	}

	async getChildren(node?: SkillsNode): Promise<SkillsNode[]> {
		if (node) {
			if (node.kind !== "skill") return [];
			return [
				...node.proposals.map(proposal => ({ kind: "proposal" as const, proposal })),
				...node.history.map(entry => ({ kind: "entry" as const, entry })),
			];
		}
		if (!this.#loaded) await this.refresh();
		return this.#skills
			.toSorted((a, b) => a.name.localeCompare(b.name))
			.map(skill => ({
				kind: "skill",
				skill,
				proposals: this.proposals.proposals.filter(proposal => proposal.skill === skill.name),
				history: this.#entries.filter(entry => entry.skill === skill.name),
			}));
	}

	dispose(): void {
		clearTimeout(this.#debounce);
		this.#watcher.dispose();
		this.#onDidChangeTreeData.dispose();
	}
}

/** The array `value[key]` of omp's JSON output, or `[]` when omp printed another shape. */
function listField<T>(value: unknown, key: string): T[] {
	if (typeof value !== "object" || value === null || !(key in value)) return [];
	const field: unknown = Reflect.get(value, key);
	// omp's own `--json` contract (skill list / skill history); entries are not validated field by field.
	const list = Array.isArray(field) ? (field as T[]) : [];
	return list;
}
