[Skill maintenance — private; the user does not see this turn]
A task just finished. Its requests, tool calls and results:
<task-transcript>
{{transcript}}
</task-transcript>

It used these skills and hit {{errorCount}} tool error(s):
{{#each skills}}
<skill-file name="{{name}}" path="{{filePath}}"{{#if readLate}} read-late="true"{{/if}}>
{{content}}
</skill-file>
{{/each}}

Per skill, decide whether the run exposed a durable gap: a wrong or missing command, flag, endpoint, identifier, step order, environment rule or prerequisite that the skill should have stated so the task would have gone right the first time. If yes, fix the skill with `skill_edit`; otherwise change nothing.

- Integrate each fix where it belongs: correct the wrong line, add the missing flag to the step that uses it, extend the relevant list. Write in the skill's own voice, as if it had always been right.
- NEVER add sections such as "Lessons", "Experiences", "Notes", changelogs, dates, or anecdotes about this session.
- Correct or remove statements the run proved false.
- Smallest change that makes the next run succeed; never rewrite or reorganize unrelated parts.
- Only durable knowledge: no values tied to this one task (ticket numbers, temporary names, timestamps); stable identifiers the domain relies on (project IDs, cluster names, base URLs) are fine. NEVER record secrets, tokens or credentials.
- Change the frontmatter `description` only when the skill was read late (`read-late`) or matched a task it does not serve: third person, what it does + when to use it, ≤1024 characters.
- Keep the skill's scope: if it allows writes, they stay allowed; never add restrictions the user did not write.
- Failures from the environment (network, expired credentials, quota) or one-off typos are not skill gaps.

Reply `done` when finished.
