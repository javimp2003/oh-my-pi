Stage a change to one existing file of an omp skill. Nothing is written now: your staged changes to a skill become one proposal the user reviews, then approves or rejects. Calls on the same file build on each other. `file` is relative to the skill directory (default `SKILL.md`).
- Targeted change: exact `old_text` → `new_text`; `old_text` MUST match exactly once; empty `new_text` deletes it.
- Restructure or rewrite: omit `old_text`; `new_text` is the whole new file, frontmatter included.
SKILL.md keeps its frontmatter `name`; `description` stays third person, ≤1024 characters; body ≤500 lines.
`summary`: one line for the user — what the skill will now get right.
`reason`: for the user — the evidence (transcript, the skill's own text, or a source you read) that makes this change an improvement.
