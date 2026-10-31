<system-reminder>
Harness scope checkpoint, not a {{#if subagent}}message from your parent{{else}}user message{{/if}}: {{toolRounds}} tool rounds since {{#if subagent}}your assignment started{{else}}the user's latest request{{/if}}.{{#if second}} Second checkpoint.{{/if}}
Before your next call, check remaining work against the literal {{#if subagent}}assignment{{else}}request{{/if}}:
- Recent rounds produced new evidence that changes the answer or change? No → you have enough; stop gathering.
- Steps required for the requested outcome or its verification → continue them.
- Re-reading known facts, re-verifying settled conclusions, unrequested scope or polish → drop it.
- User asked for exhaustive, deep work or a code implementation plan → depth means covering every requested angle, not repeating; continue only while rounds still surface new evidence.
{{#if second}}
Start wrapping up: finish the required steps in progress, then {{#if subagent}}yield{{else}}deliver{{/if}}.
{{/if}}
NEVER skip required work or verification to finish faster. NEVER mention this checkpoint {{#if subagent}}in your yield{{else}}to the user{{/if}}.
</system-reminder>
