/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";

export const cfgCommitStyle = register({
	id: "commit.style",
	type: "enum",
	values: ["conventional", "unicaja"] as const,
	default: "conventional",
	ui: {
		tab: "tasks",
		group: "Commits",
		label: "Commit style",
		description:
			"Message convention used by commit generators. Unicaja requires a Jira key from the branch or commit.issueKey and writes in Spanish.",
		options: [
			{ value: "conventional", label: "Conventional Commits", description: "Standard type(scope): summary" },
			{ value: "unicaja", label: "Unicaja", description: "[PROJECT-123] type(scope): mensaje en castellano" },
		],
	},
});

export const cfgCommitIssueKey = register({
	id: "commit.issueKey",
	type: "string",
	default: "",
	ui: {
		tab: "tasks",
		group: "Commits",
		label: "Jira task override",
		description:
			"Optional PROJECT-123 key for Unicaja commits. Leave empty to use the first Jira key in the current branch. No project allowlist is required.",
	},
});

export const cfgCommitMapReduceEnabled = register({ id: "commit.mapReduceEnabled", type: "boolean", default: true });

export const cfgCommitMapReduceThreshold = register({ id: "commit.mapReduceThreshold", type: "number", default: 5000 });

export const cfgCommitMapBatchTokenBudget = register({
	id: "commit.mapBatchTokenBudget",
	type: "number",
	default: 16000,
});

export const cfgCommitCacheEnabled = register({ id: "commit.cacheEnabled", type: "boolean", default: true });

export const cfgCommitCacheTtlDays = register({ id: "commit.cacheTtlDays", type: "number", default: 14 });

export const cfgCommitChangelogMaxDiffChars = register({
	id: "commit.changelogMaxDiffChars",
	type: "number",
	default: 120000,
});

/** Conventional commit generation and changelog limits (`commit.*`). */
export const cfgCommit = combine({
	mapReduceEnabled: cfgCommitMapReduceEnabled,
	mapReduceThreshold: cfgCommitMapReduceThreshold,
	mapBatchTokenBudget: cfgCommitMapBatchTokenBudget,
	cacheEnabled: cfgCommitCacheEnabled,
	cacheTtlDays: cfgCommitCacheTtlDays,
	changelogMaxDiffChars: cfgCommitChangelogMaxDiffChars,
});

/** Conventional commit generation and changelog limits ({@link cfgCommit}). */
export type CommitSettings = SettingValueOf<typeof cfgCommit>;
