{{#if request}}
Independently validate this user request:
{{request}}
{{else}}
Independently validate the supplied acceptance requirements.
{{/if}}

Acceptance requirements and associated files (commands are starting points; inspect and add adversarial cases):
{{#each checks}}
- {{id}}: {{requirement}}
  Command: {{command}}{{#if cwd}} (cwd: {{cwd}}){{/if}}
  Files: {{#each paths}}{{this}} {{/each}}
{{/each}}

Return {"verdict":"clean"|"issues"|"blocked","reason":"...","findings":[{"check":"id","description":"reproduction and impact","receipt":"rN"}],"evidence":[{"check":"id","receipt":"rN"}]}.
