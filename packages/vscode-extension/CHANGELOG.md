# Changelog

## [0.3.1]

### Changed

- Going back to a session you left while it was working no longer starts omp again: once its work is done, its process stays warm (up to 3 idle sessions, each for 10 minutes, the least recently used stopping first), so returning joins it at once instead of showing "Starting omp…"

## [0.3.0]

### Fixed

- Moving to another session (History, New chat, the Sessions view, `omp: Switch Session…`) no longer kills the turn running in the current one. Each session now runs in its own omp process: a session that is working keeps going in the background while you open, start, or prompt others, and switching back joins it live. Before, the chat reused one process for every session it showed, and omp's session switch aborted the running turn (the interrupted session could even be lost from disk)

### Added

- The Sessions view and the History panel mark each session's activity: a spinner while it works, a green dot once it finished while you were in another session (cleared when you open it)
- When a session in the background waits for a plan approval, a notification offers to show it

### Changed

- An idle process is reused in place when you switch sessions (no new start-up), and a background process stops once its work has settled; the session reopens from disk when you go back to it

## [0.2.4]

### Fixed

- The context ring and its popover update right after Clean up, Compact, Handoff or any other local slash command, instead of only after the next reply: the chat now re-reads the session when omp reports command output
- The popover's session numbers read as what they are: "Session totals · N requests" with "Input sent", "Output", "Cache read" and "Cache write", summed over every model request (each request sends the whole conversation again, so they grow far past the context window); a tooltip explains it

## [0.2.3]

### Added

- Clicking an image (a pasted attachment in the composer, or an image in the conversation) opens it enlarged over the chat on a dimmed backdrop; Escape, the close button, or a click outside the image closes it. Thumbnails are also reachable with Tab and open with Enter

## [0.2.2]

### Added

- Pasting an image (a screenshot or a copied picture) into the composer attaches it to the next prompt; attachments show as thumbnails above the text with a button to remove each one, and a prompt can be just images
- Rename chats from the chat: double-click the title (or its pencil on hover) to rename the open one, or use the pencil of any row in History to rename an older one

## [0.2.1]

### Fixed

- File links in answers open when the agent cites a path relative to the repository it works in (a subfolder of the open folder) or only a file name (`agent.md`): a path missing under the workspace folders is looked up anywhere in the workspace, opening the only match or asking which one when several match, instead of failing with "Unable to resolve nonexistent file"

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
