import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { cfgCommitIssueKey, cfgCommitStyle } from "../src/commit/settings";
import { extractCommitIssueKey, resolveCommitPolicy } from "../src/commit/style";
import { DEFAULT_CONVENTIONAL_GENERATION_CONFIG } from "../src/commit/conventional/config";
import { generateConventionalCommit } from "../src/commit/conventional/generate";
import { generateGitCommit } from "../src/commit/conventional/service";
import { formatConventionalCommit } from "../src/commit/conventional/normalization";
import type {
	CommitInference,
	CommitInferenceRequest,
	CommitInferenceResponse,
} from "../src/commit/conventional/inference";
import { formatCommitMessage } from "../src/commit/message";
import { createProposeCommitTool } from "../src/commit/agentic/tools/propose-commit";
import { createSplitCommitTool } from "../src/commit/agentic/tools/split-commit";
import { generateFallbackProposal } from "../src/commit/agentic/fallback";
import type { CommitAgentState } from "../src/commit/agentic/state";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../src/config/model-registry";
import { generateCommitMessage } from "../src/utils/commit-message-generator";
import { getTestModel } from "./helpers/model-fixtures";

const temps: TempDir[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temps.splice(0).map(temp => temp.remove()));
});

/** An unborn repo exercises branch detection without requiring an initial commit. */
async function repository(branch = "feature/NEW_PROJECT2-321-parser") {
	const temp = await TempDir.create("omp-unicaja-");
	temps.push(temp);
	await fs.mkdir(temp.join(".git/objects"), { recursive: true });
	await fs.mkdir(temp.join(".git/refs/heads"), { recursive: true });
	await Bun.write(temp.join(".git/HEAD"), `ref: refs/heads/${branch}\n`);
	await Bun.write(temp.join(".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
	return temp;
}

const DIFF =
	"diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -1 +1 @@\n-return oldValue;\n+return newValue;\n";

class ResponseInference implements CommitInference {
	constructor(readonly response: string) {}
	async complete<T>(_request: CommitInferenceRequest, parse: (response: CommitInferenceResponse) => T): Promise<T> {
		return parse({ text: this.response, stopReason: "stop" });
	}
}

function generate(response: string, issueKey = "NEW_PROJECT2-321") {
	return generateConventionalCommit({
		diff: DIFF,
		stat: "src/parser.ts | 2 +-",
		numstat: "1\t1\tsrc/parser.ts",
		config: { ...DEFAULT_CONVENTIONAL_GENERATION_CONFIG, policy: { style: "unicaja", issueKey } },
		inference: new ResponseInference(response),
	});
}

describe("Unicaja commit generation", () => {
	it("extracts the first complete task key across branch namespaces without a project allowlist", () => {
		expect(extractCommitIssueKey("feature/LID-31-kpis")).toBe("LID-31");
		expect(extractCommitIssueKey("NEW_PROJECT2-321-parser")).toBe("NEW_PROJECT2-321");
		expect(extractCommitIssueKey("bugfix/otros9-12-timeout")).toBe("OTROS9-12");
		expect(extractCommitIssueKey("feature/ONE-12-TWO-34")).toBe("ONE-12");
		expect(extractCommitIssueKey("release/2026-11")).toBeUndefined();
		expect(extractCommitIssueKey("feature/ABC-12suffix")).toBeUndefined();
		expect(extractCommitIssueKey("1ABC-12")).toBeUndefined();
	});

	it("uses the active branch, including before the repository's first commit", async () => {
		const repo = await repository();
		const settings = Settings.isolated({ commit: { style: "unicaja" } });
		const policy = await resolveCommitPolicy(repo.path(), settings);
		const output = await generate(
			"# fix(parser): Corrige la comparación",
			policy.style === "unicaja" ? policy.issueKey : "",
		);
		expect(formatConventionalCommit(output.commit)).toBe("[NEW_PROJECT2-321] fix(parser): Corrige la comparación");
	});

	it("honors a manual task override and allows switching back to standard commits without requiring a branch", async () => {
		const settings = Settings.isolated();
		cfgCommitStyle.set(settings, "unicaja");
		cfgCommitIssueKey.set(settings, "another7-82");
		const policy = await resolveCommitPolicy("/no-repository", settings);
		expect(
			formatCommitMessage({ type: "fix", scope: null, details: [], issueRefs: [] }, "Corrige el export", policy),
		).toBe("[ANOTHER7-82] fix: Corrige el export");
		cfgCommitStyle.set(settings, "conventional");
		const standard = await resolveCommitPolicy("/no-repository", settings);
		expect(
			formatCommitMessage({ type: "fix", scope: null, details: [], issueRefs: [] }, "fixed export", standard),
		).toBe("fix: fixed export");
	});

	it("rejects a malformed override instead of extracting a partial id", async () => {
		const settings = Settings.isolated({ commit: { style: "unicaja", issueKey: "[ABC-12] extra" } });
		await expect(resolveCommitPolicy("/no-repository", settings)).rejects.toThrow("complete Jira key");
	});

	it("stops before staging files when the branch has no task", async () => {
		const dir = await repository("main");
		await Bun.write(dir.join("changed.txt"), "pending change");
		vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated({ commit: { style: "unicaja" } }));
		await expect(generateGitCommit({ cwd: dir.path() })).rejects.toThrow("commit.issueKey");
		expect(await vcs.requireGit(dir.path()).changedFiles({ cached: true })).toEqual([]);
	});

	it("requires an explicit task in detached HEAD rather than inventing one", async () => {
		const dir = await repository();
		await Bun.write(dir.join(".git/HEAD"), `${"1".repeat(40)}\n`);
		await expect(
			resolveCommitPolicy(dir.path(), Settings.isolated({ commit: { style: "unicaja" } })),
		).rejects.toThrow("Unicaja commits require a Jira task");
	});

	it("preserves Spanish accents and imperative casing, rendering optional details as paragraphs", async () => {
		const result = await generate(
			"# feat(api): Añade validación de sesión\n\n- Rechaza peticiones sin autorización.\n- Conserva la sesión del usuario.",
		);
		expect(result.validationError).toBeNull();
		expect(formatConventionalCommit(result.commit)).toBe(
			"[NEW_PROJECT2-321] feat(api): Añade validación de sesión\n\nRechaza peticiones sin autorización.\n\nConserva la sesión del usuario.",
		);
	});

	it("rejects a subject that fits alone but exceeds the limit with its task prefix", async () => {
		await expect(generate(`# fix: ${"a".repeat(58)}`)).rejects.toThrow("including the Jira prefix");
	});

	it("rejects generated author signatures and unsupported types without substituting a bare fallback", async () => {
		await expect(generate("# fix: Corrige el parser\n- Co-authored-by: Robot <robot@example.test>")).rejects.toThrow(
			"signature trailers",
		);
		await expect(generate("# deps: Cambia las dependencias")).rejects.toThrow("Unicaja conventional commit type");
		await expect(generate('{"type":"fix","details":["Corrige la sesión"]}')).rejects.toThrow("explicit summary");
	});

	it("validates Spanish agentic proposals without imposing English past tense, and rejects oversized proposals", async () => {
		const repo = await repository();
		const state: CommitAgentState = {
			policy: { style: "unicaja", issueKey: "NEW_PROJECT2-321" },
			diffText: DIFF,
			overview: { files: ["src/parser.ts"], stat: "", numstat: [], scopeCandidates: "", isWideScope: false },
		};
		const tool = createProposeCommitTool(repo.path(), state);
		const params = {
			type: "fix" as const,
			scope: "parser",
			summary: "Corrige la comparación",
			details: [],
			issue_refs: [],
		};
		const result = await tool.execute("proposal", params, undefined, {} as never);
		expect(result.details.valid).toBe(true);
		expect(formatCommitMessage(state.proposal!.analysis, state.proposal!.summary, state.policy)).toBe(
			"[NEW_PROJECT2-321] fix(parser): Corrige la comparación",
		);
		state.proposal = undefined;
		const invalid = await tool.execute("proposal", { ...params, summary: "a".repeat(60) }, undefined, {} as never);
		expect(invalid.details.valid).toBe(false);
		expect(state.proposal).toBeUndefined();
	});

	it("applies the same convention to split proposals and the mechanical fallback", async () => {
		const repo = await repository();
		const policy = { style: "unicaja" as const, issueKey: "NEW_PROJECT2-321" };
		const state: CommitAgentState = {
			policy,
			diffText: DIFF,
			overview: { files: ["src/parser.ts"], stat: "", numstat: [], scopeCandidates: "", isWideScope: false },
		};
		const split = createSplitCommitTool(repo.path(), state, []);
		const result = await split.execute(
			"split",
			{
				commits: [
					{
						changes: [{ path: "src/parser.ts", kind: "all" }],
						type: "fix",
						scope: null,
						summary: "Corrige la comparación",
					},
				],
			},
			undefined,
			{} as never,
		);
		expect(result.details.valid).toBe(true);
		const proposal = state.splitProposal!.commits[0]!;
		expect(
			formatCommitMessage(
				{ type: proposal.type, scope: proposal.scope, details: proposal.details, issueRefs: [] },
				proposal.summary,
				policy,
			),
		).toBe("[NEW_PROJECT2-321] fix: Corrige la comparación");
		const fallback = generateFallbackProposal([{ path: "src/parser.ts", additions: 1, deletions: 1 }], policy);
		expect(formatCommitMessage(fallback.analysis, fallback.summary, policy)).toBe(
			"[NEW_PROJECT2-321] refactor: Cambia archivos del proyecto",
		);
	});

	it("keeps the task prefix in AI isolation messages and fails explicitly instead of returning a generic fallback", async () => {
		const repo = await repository();
		const model = getTestModel("anthropic");
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "fixture-only",
			resolver: () => "fixture-only",
		} as unknown as ModelRegistry;
		const response: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "fix(parser): Corrige la comparación" }],
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue(response);
		const settings = Settings.isolated({ commit: { style: "unicaja" } });
		expect(await generateCommitMessage(DIFF, registry, settings, undefined, repo.path())).toBe(
			"[NEW_PROJECT2-321] fix(parser): Corrige la comparación",
		);
		complete.mockResolvedValue({ ...response, content: [{ type: "text", text: '{"type":"fix"}' }] });
		await expect(generateCommitMessage(DIFF, registry, settings, undefined, repo.path())).rejects.toThrow(
			"no unprefixed fallback",
		);
	});
});
