# Changelog

## [0.2.0]

### Changed

- The chat is restyled after the Codex extension while keeping omp's π mark, accent colour, and braille spinner with turn timer
- Tool calls show as one-line activity rows ("Read …", "Edited … +N −M") that expand on click. `bash`/`shell` calls read "Bash" and `python`/`eval` calls "Code" (Python icon), titled by the call's purpose with the command or first line of code indented beneath, like the TUI's compact rows
- The assistant messages of one turn (each tool round trip is a message) are spaced like the blocks inside a message, so thinking, tool and answer rows sit evenly apart; a user message's Copy action appears beside its bubble on hover instead of under it, so every bubble sits at the same distance from the answer above and the reply below
- Model and reasoning moved from the header to a picker in the composer, next to a context-window ring; `+` in the composer attaches files as `@path` mentions
- History in the chat header opens a searchable session list inside the chat instead of a QuickPick
- The chat view's title bar has no icons; Open Chat in Editor moved to its `…` menu
- Clicking the context ring opens a popover with context usage, session tokens and cost, and Compact (`/compact`), Clean up (`/shake`) and Handoff (`/handoff`) buttons whose tooltips explain each
- A brain button in the composer expands or folds every thinking block of the session; with it off, thinking stays folded while it streams too (a shimmering "Thinking" row shows it is in progress) instead of opening until the message ends. Expanded thinking ends at its last line (the blank lines models append are trimmed)
- Reading a web URL shows as "Fetched <url>" with a globe icon, and the URL opens in the browser
- Code blocks are syntax-highlighted (highlight.js, VS Code Dark/Light Modern colors)
- `/new`, `/resume`, and `/settings` work in the chat (omp's RPC mode does not offer them; the chat runs them itself)
- A plan button in the composer (and `/plan`, `/plan <prompt>`) turns omp's plan mode on and off. The plan omp proposes appears in the chat as a card with the whole plan rendered, an Open in editor button (Markdown preview), and Approve and execute / Refine plan buttons; the proposal shows as a "Proposed plan" row. Needs an omp with RPC plan mode (this repo's `packages/coding-agent`); with older omp builds the button stays hidden
- Expanded `write` rows show the written content as text instead of escaped JSON
- Multi-line `select` prompts from omp open as a modal dialog with the options as buttons
- Tooltips are the chat's own (VS Code hover style): they appear after 350 ms, at once when moving between controls, and stay up while the chat refreshes, instead of the native `title` tooltip that took about a second and often did not show

## [0.1.2]

### Fixed

- A prompt that invokes a skill shows what you wrote, with the skill as a chip, instead of the whole SKILL.md; the skill's instructions sent to the model are folded below it, as in the terminal

## [0.1.1]

### Fixed

- Slash completion also opens mid-prompt: a `/` after a space lists skills (`/skill:name`, the commands omp expands anywhere in a prompt) and completes in place; at the start of the draft it still lists every command

## [0.1.0]

### Added

- Initial release: chat view and editor-tab chats driving `omp --mode rpc-ui`, a sessions view (open, rename, delete), model and thinking pickers, an omp settings editor backed by `omp config`, Add Selection/File to Chat, native dialogs for omp's `ask`/confirm/sign-in requests, provider login/logout, and an Open in Terminal command.
