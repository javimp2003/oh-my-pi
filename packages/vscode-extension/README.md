# omp (custom) for VS Code

Chat with the [omp](https://github.com/javimp2003/oh-my-pi) coding agent from VS Code: a chat panel, a sessions list, model and thinking selection, and an editor for omp's settings. The extension runs your installed omp (`omp --mode rpc-ui`), so the agent, tools, skills, models, logins, and sessions are the same ones the terminal uses.

## Features

- **Chat** in the activity bar (π icon) or in an editor tab (`omp: Open Chat in Editor`, in the view's `…` menu), styled after the Codex extension: streamed answers with markdown and code blocks, collapsible thinking, an activity row per tool call ("Read …", "Edited … +3 −1"; shell commands as "Bash" and Python/JS as "Code", titled by the call's purpose with the command beneath) that expands to its arguments and output, and a queue for messages sent while omp works. The header has New chat, History, and Settings buttons; double-click the title (or its pencil) to rename the chat.
- **Edit a prompt**: hover any of your messages and click its pencil to edit it in place and resend it. The last prompt simply runs again with the new text; an earlier one continues the session from that point after a confirmation, and everything after it leaves the conversation (it stays in the session file, reachable from the terminal's `/tree`). Files omp already changed are not restored.
- **Composer**: `Enter` sends, `Shift+Enter` adds a line, `Esc` stops the reply. Typing `/` lists omp's slash commands and skills. Mention files with `@path`, or pick them with the `+` button; paste images (screenshots, copied pictures) to attach them. The footer has a brain button that expands or folds all thinking, a plan button that turns plan mode on and off (the agent plans read-only; its plan appears in the chat with Approve and execute / Refine plan buttons and Open in editor), the model and reasoning picker, and a context-window ring that opens usage, session cost, and Compact / Clean up / Handoff.
- **History** (clock icon in the chat header): searchable list of the workspace's sessions; pick one to load it, or rename it with its pencil. A spinner marks sessions that are working, a green dot those that finished while you were elsewhere.
- **Sessions** view: every session of the workspace, newest first, titled automatically, with the same running/finished marks. Click to open; rename or delete from the item's buttons or context menu. `omp: Switch Session…` searches them.
- **Several sessions at once**: each session runs in its own omp process, so a turn keeps going while you open, start, or prompt other sessions; switching back shows it live. Processes of idle sessions you left stay warm for 10 minutes (up to 3), so going back is instant; leaving a session that is still working opens the next one in a new process ("Starting omp…").
- **Model and reasoning level**: the picker in the composer, or `omp: Select Model…` / `omp: Select Thinking Level…`.
- **Settings** (`omp: Settings`, gear icon): all omp settings by tab and group, with search, typed editors, and reset to default. Changes go through `omp config set`, so they apply to the terminal too.
- **Editor integration**: `omp: Add Selection to Chat` (`Cmd+Alt+K` / `Ctrl+Alt+K`, editor context menu) quotes the selection with its file and lines; `omp: Add File to Chat` (Explorer context menu) inserts an `@file` mention.
- **Dialogs**: questions from omp (`ask`), confirmations, and provider sign-in links open as native VS Code prompts.
- `omp: Log In to a Provider…` / `omp: Log Out of a Provider…`, `omp: Compact Context`, `omp: Open omp in Terminal`, `omp: Show Log`.

## Requirements

omp must be installed. By default the extension runs `omp` from your `PATH` (`omp.exe` on Windows). Otherwise set:

| Setting | Purpose |
| --- | --- |
| `ompCustom.executable` | Program to run: a full path to `omp`/`omp.exe`, or `bun` for a source checkout |
| `ompCustom.args` | Arguments before omp's flags, e.g. `["/path/to/oh-my-pi/packages/coding-agent/src/cli.ts"]` with `bun` |
| `ompCustom.extraArgs` | Extra omp flags for the chat agent (`--model`, `--profile`, …) |
| `ompCustom.env` | Extra environment variables (proxy, certificates, API keys) |
| `ompCustom.resumeLastSession` | Continue the workspace's latest session when the chat opens (default on) |
| `ompCustom.sendWhileBusy` | `steer` (deliver mid-turn, default) or `followUp` (queue until the turn ends) |

## Install

Download `omp-custom.vsix` from the [releases](https://github.com/javimp2003/oh-my-pi/releases) and run **Extensions: Install from VSIX…**, or:

```sh
code --install-extension omp-custom.vsix
```

## Build from source

```sh
cd packages/vscode-extension
bun run build      # dist/
bun run package    # dist/omp-custom.vsix
```
