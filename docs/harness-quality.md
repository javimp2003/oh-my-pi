# Verification, cache-preserving forks and measured execution

These features target full-task correctness and useful work per inference budget. They do not claim a Frontier Harness score improvement without a paired run on the actual model/backend.

## Acceptance checks

The root session exposes the discoverable `verification` tool. For a substantial behavior change, define a short contract before implementation:

```json
{
  "op": "define",
  "checks": [
    {
      "id": "async-decode",
      "requirement": "Decode asynchronous input, including empty input",
      "command": "bun test test/async-decode.test.ts",
      "paths": ["src/decode.ts", "test/async-decode.test.ts"]
    }
  ]
}
```

Run the exact command through foreground `bash` from the workspace root (or declare the check's optional relative `cwd` and use that same `bash.cwd`); then use `verification` with `{"op":"status"}`. A check passes only after an observed successful execution with identical file contents before and after it. Later changes to a tracked source/test file make its evidence stale. Include relevant dependencies and configuration in `paths`: this tracks declared files, not every possible input to a build. An exit code alone does not prove a test's assertions are adequate.

Contracts and evidence are append-only session entries, survive compaction/resume, and follow branch navigation. Requirements cannot be weakened within the same user request. Adding requirements retains existing evidence. A new user request starts a new contract. Checks and file revisions are read together, so independent-review preflight avoids a duplicate file scan. Reads are bounded even if a file grows after its size was checked. Snapshots support up to 24 checks, 128 distinct workspace files and 16 MiB total; directories, workspace escapes and oversized snapshots cannot be certified. Missing files have a distinct revision so deletion checks work.

Existing verification reminders remain available when no contract is defined. `verify.reminders` and `verify.remindersMax` still control stop reminders; explicit instructions not to run checks are respected.

## Independent executable review

After the checks pass, `verification` with `{"op":"review"}` starts a fresh `verifier` conversation on the current workspace, including uncommitted changes. It reads the requirements and code, runs focused checks and tries counterexamples. It is instructed to leave source/existing tests untouched and use scratch files for reproductions; this is an instruction, not a filesystem sandbox.

The host audits its structured report against actual child tool receipts:

- A clean report needs a passing test receipt for every requirement.
- A reproduced finding needs a receipt for a real failed command and a supplied requirement id.
- Missing/invented receipts, invalid output, cancellation or provider errors cannot produce a clean report.
- File or requirement changes, newly failed acceptance checks, and discarded review branches invalidate an earlier review.

Receipts prove execution, not the semantic validity of every finding. Inspect the reproduction, repair actual failures and rerun the affected acceptance checks. At most two review attempts are allowed per user request, including interrupted attempts; concurrent callers reserve their slots atomically in the active session journal. `status` includes persisted findings and the attempt count. Requesting `review` again reuses a still-valid clean/issues report without another model request. A successful rerun of acceptance checks after findings permits a fresh review even when the repair only changed the environment, not source files. The reviewer does not apply repairs itself. Parent continuation handles repair/revalidation within the existing reminder limit.

Enable `verify.executableReview: true` to request this review automatically at the stop boundary after declared checks pass. It defaults to false because it spends additional inference. `task.receipts.enabled` must remain enabled for auditable reviews. Existing agent allowlists/spawn restrictions still apply.

## Full-history forks on open-model backends

With `task.fork.enabled`, a task fork inherits the parent's actual system blocks, history, model/thinking selection and prompt-cache identity. Providers with mid-conversation tool changes keep their existing yield protocol.

For a flat-prefix backend such as LiteLLM → vLLM, the child freezes the complete ordered tool definitions from the parent's latest request. It adds its role/assignment at the end of the history and normally finishes with plain text or schema-validated JSON, without adding a child-only `yield` tool. Existing tools remain executable only within the child's delegated scope; retaining a wire declaration does not grant execution. The same definitions are retained on revival. A refused next request cannot recycle the previous assignment’s final response as a new successful result. The GLM in-band tool dialect also retains its embedded tool prompt.

This makes reuse possible; it cannot prevent server eviction, a different chat template/model, routing to a different KV pool, or cache misses caused by prior tool/prompt changes. It does not preserve a discarded conversation prefix after destructive compaction. Prefix-cache benefits still need measurement on the actual server.

## Shared execution budget

Optional settings (also available in the settings panel):

| Setting | Default | Meaning |
| --- | --- | --- |
| `execution.budgetTokens` | `0` | Weighted budget per admitted user request; zero disables the token limit |
| `execution.prefillWeight` | `0.2` | Approximate weight of uncached input/cache creation relative to output |
| `execution.reservePercent` | `20` | Final portion of the token or time budget reserved for integration, checks and review |
| `execution.maxSeconds` | `0` | Wall-clock budget, checked before subsequent main-loop model calls; zero disables |

Accounting uses `output + prefillWeight × (input + cacheWrite)` from normalized provider usage; cached input is excluded. These are configurable work units, not dollars or measured GPU time. Main-loop usage across parent/children and separately journaled auxiliary usage contribute without adding the parent's aggregate task usage a second time.

Elapsed time uses a monotonic clock. A main-loop model call retains its initiating lease until its final response arrives, including responses that finish after a new request has received a budget. Children share a lease for the originating request; old background children cannot spend a new request's lease. In reserve, a bounded append-only notice steers toward integration/verification and ordinary new child launches are refused. Independent review can use the remaining reserve. At exhaustion, the main-loop pre-dispatch gate refuses further requests. In-flight calls can overshoot, auxiliary requests are accounted after completion, and this is not an instantaneous GPU cancellation or a replacement for server-side limits. Disabled budgets preserve the normal flow.

## Select and freeze an execution profile

Use paired **development** tasks to compare editing modes and tool-document presentation with your exact GLM/LiteLLM/vLLM deployment. The selector prioritizes full-task passes, then total cost per pass (including failed/timeout spend), then mean duration. It rejects incomplete samples, duplicate task trials, infrastructure errors and overlap with the supplied formal-evaluation task ids. Partial edit success and fractional rewards do not count as full-task passes.

For Harbor runs, explicitly pin the actual editor and docs in every arm, for example:

```sh
bun packages/metaharness/src/runner.ts --model litellm/glm-5.3-flash -d YOUR_DEV_DATASET --tasks 2 --attempts 1 --job-name dev-replace --env PI_EDIT_VARIANT=replace --setting tools.xdevDocs=builtins
```

Repeat with the other candidate configurations on the same tasks/model/backend. The run importer requires the remaining settings, environment, tools, thinking and arguments to agree across arms. Do not use the formal task set to tune configurations. A run-import specification contains:

```json
{
  "split": "development",
  "target": {
    "provider": "litellm",
    "model": "glm-5.3-flash",
    "backend": "your-recorded-vllm-and-litellm-configuration"
  },
  "taskIds": ["your-dev-task-a", "your-dev-task-b"],
  "evaluationTaskIds": ["your-formal-task-id"],
  "runs": ["path/to/dev-replace", "path/to/dev-other-arm"]
}
```

Paths are relative to the specification. Import the recorded runner configuration and observed Harbor results:

```sh
bun packages/metaharness/scripts/select-execution-profile.ts calibration-runs.json selected-profile.json --runs
```

Other adapters can supply normalized `candidates` directly instead of `runs`: each candidate has `id`, `settings` (`edit.mode`, `tools.xdevDocs`) and `trials` (`task`, `status: pass|fail|timeout|infra`, `costUsd`, `durationMs`). Omit `--runs` in that case. Keep the complete development sample and the formal ids in the specification.

Set `execution.profilePath` to the selected JSON file before opening an SDK session. The harness applies the editor/docs settings and stores a snapshot in the session journal. Live parent-setting changes, file edits, child sessions and resume do not change those selected settings. A conflicting `PI_EDIT_VARIANT` fails explicitly. Start a new SDK session to select a different profile; no global settings or model/provider KDL policy are rewritten.

No measured GLM winner ships with this change. Run calibration on your deployment before selecting one. The declared backend identity is reproducibility metadata; the harness cannot remotely attest a server's deployment flags.

## Design sources

- [Frontier Harness](https://frontierharness.org/) motivates measuring complete task success and spending on failed tasks, not just edit-operation accuracy.
- [Codex stop hooks](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs) and [fresh review conversations](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/review.rs) informed the stop/review boundaries. The receipt-audited executable acceptance review here is our implementation, not a claim that Codex requires every review to run tests.
- [Codex rollout budget](https://github.com/openai/codex/blob/main/codex-rs/core/src/rollout_budget.rs) informed weighted accounting shared across the execution tree.
- [vLLM automatic prefix caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/) explains why identical prefixes can reuse KV computation and why this helps prefill rather than decoding. Freezing ordered tool/prompt bytes keeps that prerequisite intact for flat-prefix forks.
