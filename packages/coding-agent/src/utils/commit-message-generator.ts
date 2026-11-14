/**
 * Generate commit messages from diffs using a smol, fast model.
 * Follows the same pattern as title-generator.ts.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { getProjectDir, logger, prompt } from "@oh-my-pi/pi-utils";
import { commitStyleSystemPrompt, resolveCommitPolicy } from "../commit/style";
import { parseUnicajaCommit } from "../commit/conventional/unicaja";
import { formatConventionalCommit } from "../commit/conventional/normalization";

import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import commitSystemPrompt from "../prompts/system/commit-message-system.md" with { type: "text" };
import commitUserPrompt from "../prompts/system/commit-message-user.md" with { type: "text" };
import { concreteThinkingLevel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";

const COMMIT_SYSTEM_PROMPT = prompt.render(commitSystemPrompt);
const MAX_DIFF_CHARS = 4000;
// Cover the "backend ignores `disableReasoning`" case unconditionally: the
// static `model.reasoning` catalog flag can't distinguish a thinking model
// declared `reasoning: false` (e.g. Qwen3 served locally via llama.cpp) from
// one that never emits thinking. `maxTokens` is a hard cap — non-thinking
// completions still return in a handful of tokens (issue #4355).
const COMMIT_MAX_TOKENS = 1024;

/** File patterns that should be excluded from commit message generation diffs. */
const NOISE_SUFFIXES = [".lock", ".lockb", "-lock.json", "-lock.yaml"];

/** Strip diff hunks for noisy files that drown out real changes. */
function filterDiffNoise(diff: string): string {
	const lines = diff.split("\n");
	const filtered: string[] = [];
	let skip = false;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			const bPath = line.split(" b/")[1];
			skip = bPath != null && NOISE_SUFFIXES.some(s => bPath.endsWith(s));
		}
		if (!skip) filtered.push(line);
	}
	return filtered.join("\n");
}

function getSmolModelCandidates(
	registry: ModelRegistry,
	settings: Settings,
): Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return [];

	const candidates: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [];
	const addCandidate = (model?: Model<Api>, thinkingLevel?: ThinkingLevel): void => {
		if (!model) return;
		if (candidates.some(c => c.model.provider === model.provider && c.model.id === model.id)) return;
		candidates.push({ model, thinkingLevel });
	};

	const matchPreferences = getModelMatchPreferences(settings);
	const configuredSmol = resolveModelRoleValue(settings.getModelRole("smol"), availableModels, {
		settings,
		matchPreferences,
	});
	addCandidate(configuredSmol.model, concreteThinkingLevel(configuredSmol.thinkingLevel));

	for (const pattern of MODEL_PRIO.smol) {
		const needle = pattern.toLowerCase();
		addCandidate(availableModels.find(m => m.id.toLowerCase() === needle));
		addCandidate(availableModels.find(m => m.id.toLowerCase().includes(needle)));
	}

	for (const model of availableModels) {
		addCandidate(model);
	}

	return candidates;
}

/**
 * Generate a commit message from a unified diff.
 * Standard mode returns null on failure; Unicaja fails explicitly to prevent unprefixed fallback commits.
 */
export async function generateCommitMessage(
	diff: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	cwd: string = getProjectDir(),
): Promise<string | null> {
	const policy = await resolveCommitPolicy(cwd, settings);
	const candidates = getSmolModelCandidates(registry, settings);
	if (candidates.length === 0) {
		if (policy.style === "unicaja") throw new Error("No model available to generate a Unicaja commit message");
		logger.debug("commit-msg-generator: no smol model found");
		return null;
	}

	const cleanDiff = filterDiffNoise(diff);
	const truncatedDiff =
		cleanDiff.length > MAX_DIFF_CHARS ? `${cleanDiff.slice(0, MAX_DIFF_CHARS)}\n… (truncated)` : cleanDiff;
	if (!truncatedDiff.trim()) {
		if (policy.style === "unicaja") throw new Error("No relevant diff available for a Unicaja commit message");
		logger.debug("commit-msg-generator: diff is empty after noise filtering");
		return null;
	}
	const userMessage = prompt.render(commitUserPrompt, { diff: truncatedDiff });

	for (const candidate of candidates) {
		const apiKey = await registry.getApiKey(candidate.model, sessionId);
		if (!apiKey) continue;

		try {
			const maxTokens = COMMIT_MAX_TOKENS;
			const response = await retryTransientCompletion(
				() =>
					completeSimple(
						candidate.model,
						{
							systemPrompt: [commitStyleSystemPrompt(COMMIT_SYSTEM_PROMPT, policy)],
							messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
						},
						{
							apiKey: registry.resolver(candidate.model, sessionId),
							sessionId,
							maxTokens,
							reasoning: toReasoningEffort(candidate.thinkingLevel),
						},
					),
				{ provider: candidate.model.provider },
			);

			if (response.stopReason === "error") {
				logger.debug("commit-msg-generator: error", { model: candidate.model.id, error: response.errorMessage });
				continue;
			}

			let msg = "";
			for (const content of response.content) {
				if (content.type === "text") msg += content.text;
			}
			msg = msg.trim();
			if (!msg) continue;
			if (policy.style === "unicaja") {
				const message = parseUnicajaCommit(msg, policy.issueKey);
				return formatConventionalCommit(message);
			}

			// Clean up: remove wrapping quotes, backticks, trailing period
			msg = msg.replace(/^[`"']|[`"']$/g, "").replace(/\.$/, "");

			logger.debug("commit-msg-generator: generated", { model: candidate.model.id, msg });
			return msg;
		} catch (err) {
			logger.debug("commit-msg-generator: error", {
				model: candidate.model.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (policy.style === "unicaja")
		throw new Error("Could not generate a valid Unicaja commit message; no unprefixed fallback was used");
	return null;
}
