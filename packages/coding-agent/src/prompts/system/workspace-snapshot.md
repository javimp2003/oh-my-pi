<workspace>
Snapshot taken at session start — re-check with git before relying on branch or status.
- Root: {{root}}
{{#if branch}}
- Branch: {{branch}}
{{/if}}
{{#if status}}
- Status: {{status}}
{{/if}}
{{#if commits.length}}
- Recent commits:
{{#each commits}}
  - {{this}}
{{/each}}
{{/if}}
{{#if manifests.length}}
- Project: {{#list manifests join=", "}}{{this}}{{/list}}{{#if packageManagers.length}} ({{#list packageManagers join="/"}}{{this}}{{/list}}){{/if}}
{{/if}}
{{#if verifyCommands.length}}
- Verify: {{#list verifyCommands join="; "}}{{this}}{{/list}}
{{/if}}
</workspace>
