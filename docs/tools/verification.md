# verification

Track acceptance checks against actual command executions and workspace file revisions,
then request an independent executable review.

## Source

- Tool: `packages/coding-agent/src/tools/verification.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/verification.md`
- Evidence: `packages/coding-agent/src/session/verification-contract.ts`
- Review auditing: `packages/coding-agent/src/session/executable-review.ts`

## Inputs

`op` selects `define`, `status` or `review`. `define` accepts `checks`, each with:

| Field | Meaning |
| --- | --- |
| `id` | Stable, unique check identifier |
| `requirement` | Behavior the check must establish |
| `command` | Exact foreground bash command to run |
| `paths` | Relevant source and test files, relative to the workspace |
| `cwd` | Optional workspace directory for the command; defaults to the root |

For example, define a check for a specific regression test, run its exact command
with `bash`, then call `status`. Defining a check does not execute it.

## Evidence and persistence

Checks report `pending`, `passed`, `failed` or `stale`. Only an observed completed
execution in the declared directory can pass. Failed, cancelled or unfinished
background commands cannot certify a check. Editing tracked files invalidates
earlier evidence. Contracts and evidence survive compaction and resume on the
same session branch; a new user request starts a new contract. Existing checks
cannot be removed or weakened within that request.

Contracts support 1–24 checks, up to 128 distinct files and 16 MiB of file
snapshots. Unreadable or oversized snapshots cannot certify a pass.

## Independent review

`review` requires passing checks and a session journal. It launches a fresh
verifier to execute focused tests and adversarial cases, without inheriting the
conversation or repairing files. Verdicts are audited against actual child bash
receipts and report `clean`, `issues`, `blocked` or `stale`.

At most two attempts are allowed per user request, including cancelled attempts.
An unchanged clean/issues verdict is reused. After a repair, rerun acceptance
commands to provide fresh passing evidence before requesting another review.
Request, branch or evidence changes invalidate an earlier verdict. Errors and
missing proof produce a blocker rather than a clean result.

The result contains `checks`, the available `review`, and `reviewAttempts`.
Hosts without verification contracts reject the tool; review additionally needs
the journal. These records certify observed executions, not overall correctness
or isolation from untracked workspace changes.
