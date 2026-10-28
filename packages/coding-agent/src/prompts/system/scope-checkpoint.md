<system-reminder>
Harness scope checkpoint, not a user message: {{toolRounds}} tool rounds since the user's latest request.{{#if second}} Second checkpoint.{{/if}}
Before your next call, check remaining work against the literal request:
- Recent rounds produced new evidence that changes the answer or change? No → you have enough; stop gathering.
- Steps required for the requested outcome or its verification → continue them.
- Re-reading known facts, re-verifying settled conclusions, unrequested scope or polish → drop it.
- User asked for exhaustive, deep work or a code implementation plan → depth means covering every requested angle, not repeating; continue only while rounds still surface new evidence.
{{#if second}}
Start wrapping up: finish the required steps in progress, then deliver.
{{/if}}
NEVER skip required work or verification to finish faster. NEVER mention this checkpoint to the user.
</system-reminder>
