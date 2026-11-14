import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { cfgCommitIssueKey, cfgCommitStyle } from "./settings";
import type { ConventionalCommit } from "./types";
import { validateScope } from "./analysis/validation";
import stylePrompt from "./prompts/style.md" with { type: "text" };

export type CommitStyle = "conventional" | "unicaja";
export type CommitPolicy = { style: "conventional" } | { style: "unicaja"; issueKey: string };

/** First complete Jira token, regardless of project name or branch namespace. */
export function extractCommitIssueKey(branch: string): string | undefined {
	return branch.match(/(?:^|[^a-z0-9_])([a-z][a-z0-9_]*-[1-9][0-9]*)(?=$|[^a-z0-9_])/i)?.[1]?.toUpperCase();
}

/** Resolve before staging or contacting a model: never invent a missing task id. */
export async function resolveCommitPolicy(
	cwd: string,
	settings: Settings,
	signal?: AbortSignal,
): Promise<CommitPolicy> {
	if (cfgCommitStyle.get(settings) !== "unicaja") return { style: "conventional" };
	const override = cfgCommitIssueKey.get(settings).trim();
	const branch = override ? undefined : await vcs.requireGit(cwd).currentBranch(signal);
	const issueKey = override ? extractCommitIssueKey(override) : extractCommitIssueKey(branch ?? "");
	if (override && issueKey !== override.toUpperCase()) {
		throw new Error("commit.issueKey must be a complete Jira key such as PROJECT-123, without brackets.");
	}
	if (!issueKey) {
		throw new Error(
			"Unicaja commits require a Jira task. Use a branch containing PROJECT-123 or set commit.issueKey in Settings > Tasks > Commits.",
		);
	}
	return { style: "unicaja", issueKey };
}

/** Keep style rules in one static prompt for every model-backed commit path. */
export function commitStyleSystemPrompt(basePrompt: string, policy?: CommitPolicy): string {
	if (policy?.style !== "unicaja") return basePrompt;
	return prompt.render(stylePrompt, { base_prompt: basePrompt, unicaja: true, issue_key: policy.issueKey });
}

/** Validate the user-visible Unicaja message, including its deterministic prefix. */
export function validateUnicajaCommit(message: ConventionalCommit): string[] {
	const errors: string[] = [];
	if (!message.issueKey || extractCommitIssueKey(message.issueKey) !== message.issueKey)
		errors.push("A complete uppercase Jira key is required");
	if (!/^(feat|fix|refactor|docs|test|chore|ci|build|perf|style)$/.test(message.type))
		errors.push("Use a standard Unicaja conventional commit type");
	errors.push(...validateScope(message.scope).errors);
	if (!message.summary.trim() || /[\r\n\x00-\x1f\x7f]/.test(message.summary))
		errors.push("The summary must be a non-empty single line");
	if (/^\[|^[a-z]+(?:\([^)]*\))?!?:/.test(message.summary))
		errors.push("The summary must not repeat the ticket or conventional commit prefix");
	if (message.summary.trimEnd().endsWith(".")) errors.push("The summary must not end with a period");
	const header = `[${message.issueKey ?? ""}] ${message.type}${message.scope ? `(${message.scope})` : ""}: ${message.summary}`;
	if (Array.from(header).length > 72)
		errors.push("The entire subject, including the Jira prefix, must fit within 72 characters");
	if (/co-authored-by:|signed-off-by:/i.test([header, ...message.body, ...message.footers].join("\n")))
		errors.push("Unicaja commits must not contain author or signature trailers");
	return errors;
}
