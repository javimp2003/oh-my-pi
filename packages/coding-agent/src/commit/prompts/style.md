{{{base_prompt}}}
{{#if unicaja}}

## Active message convention: Unicaja

These style rules override default language, tense, casing and body-format rules above. Preserve the requested response/tool schema.
The verified task is {{ issue_key }}. Budget the summary for the final `[{{ issue_key }}] type(scope): summary` subject.

- Write the summary and any body/details in Spanish, with correct tildes and ñ. Start the summary with a capitalized imperative verb: Añade, Quita, Corrige, Configura. Never convert Spanish text to ASCII or English past tense.
- Use one of feat, fix, refactor, docs, test, chore, ci, build, perf, style. A narrow scope is optional; omit it when it does not help.
- Write a short concrete sentence grounded in the diff. Avoid filler, marketing language, emojis, title case and decorative Markdown. No trailing period in the summary.
- Mention an environment only when the changes establish it, as a suffix such as " - PRE/PRO". Never infer an environment from the ticket or branch alone.
- The application adds the verified Jira key in brackets before type(scope):. Do not invent or emit a ticket prefix yourself, and do not duplicate type/scope inside a summary field.
- The whole final subject, including [PROJECT-123] type(scope):, must fit 72 characters. Prefer a shorter summary or omit an unhelpful scope.
- Optional body/details explain what the diff does not make clear. The final body uses plain paragraphs. No Co-authored-by, Signed-off-by or author signatures.
  {{/if}}
