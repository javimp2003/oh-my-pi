[IMPORTANT: User invoked {{count}} skills together: {{names}}. They carry equal weight: follow each skill's instructions where it applies, and where they overlap combine them instead of favouring the one listed first. Full skills below.]
{{#each skills}}

<skill name="{{name}}" directory="{{baseDir}}">
{{body}}
</skill>
{{/each}}

---

Resolve relative paths in each skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against that skill's `directory`; read referenced assets and templates; run scripts with the terminal tool when skill instructions call for it.
{{#if userArgs}}
User: {{userArgs}}
{{/if}}
