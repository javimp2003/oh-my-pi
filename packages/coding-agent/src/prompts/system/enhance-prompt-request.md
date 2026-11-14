{{#if recentUserMessages.length}}
Recent messages the user sent in this chat, oldest first (context only):
<recent-user-messages>
{{#each recentUserMessages}}
<message>
{{this}}
</message>
{{/each}}
</recent-user-messages>
{{/if}}
{{#if lastAnswer}}
The assistant's latest answer (context only):
<last-answer>
{{lastAnswer}}
</last-answer>
{{/if}}
{{#if workspace}}
<workspace>
{{#if workspace.root}}
Project: {{workspace.root}}
{{/if}}
{{#if workspace.branch}}
Branch: {{workspace.branch}}
{{/if}}
{{#if workspace.status}}
Git status: {{workspace.status}}
{{/if}}
{{#if workspace.manifests.length}}
Manifests: {{join workspace.manifests ", "}}
{{/if}}
{{#if workspace.contextFiles.length}}
Context files: {{join workspace.contextFiles ", "}}
{{/if}}
{{#if workspace.activeFile}}
Active file: {{workspace.activeFile}}
{{/if}}
{{#if workspace.mentions.length}}
Mentioned paths: {{join workspace.mentions ", "}}
{{/if}}
{{#if workspace.selection}}
Selection in the active file:
<selection>
{{workspace.selection}}
</selection>
{{/if}}
</workspace>
{{/if}}

Rewrite this draft; do not answer it. A vague reference ("this file", "esa función", "lo de antes") with a single match in the context → replace it; several matches or none → `<ambiguities>`:
<draft>
{{draft}}
</draft>
