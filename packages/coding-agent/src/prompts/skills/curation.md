[Skill maintenance — private; the user does not see this turn]
A task just finished. Decide whether any skill it used is wrong or incomplete, and fix only those. Most failed tool calls are not skill problems; leaving a skill untouched is the common, correct outcome.

<task-transcript>
{{transcript}}
</task-transcript>

The task used the skills below, or had them in context from an earlier task of the conversation (`loaded-earlier`: the transcript need not show them being read; the agent may still have followed them). {{errorCount}} tool call(s) failed somewhere in it — not necessarily because of a skill.
{{#each skills}}
<skill-file name="{{name}}" path="{{filePath}}"{{#if readLate}} read-late="true"{{/if}}{{#if earlier}} loaded-earlier="true"{{/if}}>
{{content}}
</skill-file>
{{/each}}

Per skill, edit ONLY when all three hold:
1. **Attribution** — a failure traces to the skill's own text: a wrong or stale command, flag, endpoint, identifier, path, step order or rule it states, or a prerequisite its own workflow always needs and it omits.
2. **Proof** — the transcript shows the right version: the corrected call succeeded, or tool output directly contradicts the skill. NEVER write a fix the run did not confirm.
3. **Recurrence** — following the skill as written would fail the same way on the next task it covers.

All three hold? You MUST fix it; a proven-wrong instruction fails every later run.

Not skill gaps — change nothing:
- The skill was right; the agent skipped, ignored or misread it.
- The failing call lies outside what the skill covers: other code, other tools, unrelated steps of the task.
- Environment or transient state: network, outages, expired credentials, a one-off permission denial, quota or rate limits, a tool missing on this machine.
- Task-specific input: an ID or path the user got wrong, a resource not created yet, data unique to this task.
- Failures that are part of the work: probes and existence checks, empty searches, red tests before a fix, compile/lint errors in code being written, planned retries.
- One-off agent slips: typos, malformed tool arguments, stale edit anchors.
- The skill's approach failed once but an alternative worked, and nothing shows the skill's approach is wrong in general.
- The evidence cannot tell which of the above applies.

Editing rules:
- Integrate each fix where it belongs: correct the wrong line, add the missing flag to the step that uses it, extend the relevant list. Write in the skill's own voice, as if it had always been right.
- NEVER add sections such as "Lessons", "Experiences", "Notes", changelogs, dates, or anecdotes about this session.
- Correct or remove statements the run proved false.
- Smallest change that makes the next run succeed; NEVER rewrite or reorganize unrelated parts.
- Only durable knowledge: no values tied to this one task (ticket numbers, temporary names, timestamps); stable identifiers the domain relies on (project IDs, cluster names, base URLs) are fine. NEVER record secrets, tokens or credentials.
- Change the frontmatter `description` only when the skill is `read-late` AND an earlier failure is one the skill would have prevented — the description did not trigger in time. Third person, what it does + when to use it, ≤1024 characters.
- Keep the skill's scope: if it allows writes, they stay allowed; NEVER add restrictions the user did not write.

Edit only when attribution, proof and recurrence all hold. Reply `done` when finished.
