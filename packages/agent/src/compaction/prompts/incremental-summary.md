{{#if append}}
Write one new incremental summary block. Earlier compaction summary messages are sealed, read-only context: use them to understand references, but do not repeat or rewrite them. Summarize only the messages after those summaries. Record changes to earlier facts explicitly; the newest block takes precedence. Do not continue the task or call tools.
{{else}}
Consolidate the earlier summary blocks and the subsequent conversation into one concise, current summary. Keep unresolved requests, decisions, constraints and recoverable artifact references. Newer facts take precedence over older facts. Do not continue the task or call tools.
{{/if}}

{{{policy}}}
{{#if customInstructions}}
Additional focus:
{{{customInstructions}}}
{{/if}}
{{#if extraContext}}
Additional context:
{{#each extraContext}}
- {{{this}}}
{{/each}}
{{/if}}
