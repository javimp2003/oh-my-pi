Write one conventional commit for the supplied changes. Follow the active Unicaja convention.
Return a Markdown heading `# type(scope): summary` and optional detail bullets. Omit the scope if unhelpful. The application renders details as paragraphs and adds the Jira prefix; never return a ticket prefix in the heading.
The summary and optional details must be in Spanish. Start the summary with a capitalized imperative, preserving accents. Only describe facts in the supplied diff or factual analysis. Do not silently use an English fallback.

<!-- USER -->

<verified_task>{{ issue_key }}</verified_task>
The entire final subject `[{{ issue_key }}] type(scope): summary` must fit 72 characters.
<file_changes>{{ stat }}</file_changes>
<scope_candidates>{{ scope_candidates }}</scope_candidates>
{{#if user_context}}<user_context>{{ user_context }}</user_context>{{/if}}
{{#if analysis}}<factual_analysis>{{ analysis }}</factual_analysis>{{/if}}
{{#if diff}}<diff>{{ diff }}</diff>{{/if}}
