import { validateUnicajaCommit } from "../style";
import type { ConventionalCommit } from "../types";
import { conventionalCommit } from "./commit-types";
import { scrubDiffForPrompt, smartTruncateDiff, truncateDiffByLines } from "./diff";
import type { ConventionalGenerationInput, ConventionalGenerationResult } from "./generate";
import { runMapReduce, shouldUseMapReduce } from "./map-reduce";
import { parseConventionalAnalysisMarkdown } from "./markdown";
import { renderConventionalPrompt } from "./prompts";
import { extractScopeCandidates } from "./scope";

/** Unlike the generic parser, a missing summary must never become an English fallback. */
export function parseUnicajaCommit(text: string, issueKey: string): ConventionalCommit {
	const analysis = parseConventionalAnalysisMarkdown(text);
	if (!analysis.summary?.trim()) throw new Error("Unicaja generation requires an explicit summary");
	const message = {
		...conventionalCommit({
			type: analysis.type,
			scope: analysis.scope,
			summary: analysis.summary.normalize("NFC"),
			body: analysis.details.map(detail => detail.text.normalize("NFC")),
		}),
		issueKey,
	};
	const errors = validateUnicajaCommit(message);
	if (errors.length) throw new Error(errors.join("; "));
	return message;
}

/** Spanish generation shares bounded diff analysis, provider retries and inference caching. */
export async function generateUnicajaCommit(input: ConventionalGenerationInput): Promise<ConventionalGenerationResult> {
	const policy = input.config.policy;
	if (policy?.style !== "unicaja") throw new Error("Unicaja generation requires a resolved Jira task");
	const diff = scrubDiffForPrompt(input.diff);
	const scopeCandidates = extractScopeCandidates(input.numstat, input.config).scopeCandidates;
	const analysis = shouldUseMapReduce(diff, input.config)
		? await runMapReduce({
				inference: input.inference,
				config: input.config,
				stat: input.stat,
				diff,
				scopeCandidates,
			})
		: undefined;
	const boundedDiff = analysis
		? ""
		: diff.length > input.config.maxDiffLength
			? smartTruncateDiff(diff, input.config.maxDiffLength, input.config)
			: diff;
	const prompts = renderConventionalPrompt(
		"unicaja",
		{
			stat: input.stat,
			scope_candidates: scopeCandidates,
			issue_key: policy.issueKey,
			user_context: input.context?.userContext,
			analysis: analysis ? JSON.stringify(analysis) : "",
			diff: analysis ? "" : truncateDiffByLines(boundedDiff, 10_000, input.config),
		},
		policy,
	);
	const commit = await input.inference.complete(
		{
			operation: "unicaja",
			role: "fast",
			promptFamily: "unicaja",
			systemPrompt: prompts.system,
			userPrompt: prompts.user,
			toolName: "create_unicaja_commit",
			progressLabel: "Generating Unicaja commit message…",
		},
		response => parseUnicajaCommit(response.text, policy.issueKey),
	);
	return { commit, validationError: null };
}
