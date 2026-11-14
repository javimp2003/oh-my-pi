<system-reminder>
The acceptance contract still has unverified requirements on the current code revision:
{{#each checks}}
- {{id}}: {{requirement}} — {{status}}; run `{{command}}{{#if cwd}} (cwd: {{cwd}}){{/if}}` against {{paths}}.
{{/each}}
Complete the missing checks, fix failures and re-run affected checks. If verification is blocked, explain the concrete blocker and do not claim completion.
(Reminder {{attempt}}/{{max}})
</system-reminder>
