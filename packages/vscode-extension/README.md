# omp (custom) for VS Code

Chat with the [omp](https://github.com/javimp2003/oh-my-pi) coding agent from VS Code: a chat panel, a sessions list, model and thinking selection, and an editor for omp's settings. The extension runs your installed omp (`omp --mode rpc-ui`), so the agent, tools, skills, models, logins, and sessions are the same ones the terminal uses.

## Features

- **Chat** in the activity bar (π icon) or in an editor tab (`omp: Open Chat in Editor`, in the view's `…` menu), styled after the Codex extension: streamed answers with markdown and code blocks, collapsible thinking, an activity row per tool call ("Read …", "Edited … +3 −1"; shell commands as "Bash" and Python/JS as "Code", titled by the call's purpose with the command beneath) that expands to its arguments and output, and a queue for messages sent while omp works. The header has New chat, History, and Settings buttons; double-click the title (or its pencil) to rename the chat.
- **Edit a prompt**: hover any of your messages and click its pencil to edit it in place and resend it. The last prompt simply runs again with the new text; an earlier one continues the session from that point after a confirmation, and everything after it leaves the conversation (it stays in the session file, reachable from the terminal's `/tree`). When omp changed files since that prompt, you can also restore them ("Edit and Restore Files"). Only turns in which the session edited files with its own file tools (edit, write, ast_edit, notebook, an applied LSP rename or code action) count: a session that only talked or ran commands never offers to restore, so another session's work is never touched. In the turns that count, omp's changes are reverted (commands run in them included), while changes you or other sessions made outside them are kept; files edited on the same lines by both are listed for you to pick. A notification offers to undo the restore.
- **File checkpoints** (behind the restore): before each prompt that starts a turn, and when the turn ends, the extension snapshots every git repository of the workspace (also several repositories inside one folder). Snapshots are git objects written through a temporary index, so branches, the index, staged changes and history are untouched. Git-ignored files (a venv, `node_modules`, build output), untracked files over 10 MB and files outside git repositories are not covered. Needs git on the PATH; turn it off with `ompCustom.fileCheckpoints`.
- **Composer**: `Enter` sends, `Shift+Enter` adds a line, `Esc` stops the reply. Typing `/` lists omp's slash commands and skills. Mention files with `@path`, or pick them with the `+` button; paste images (screenshots, copied pictures) to attach them. The footer has a brain button that expands or folds all thinking, a plan button that turns plan mode on and off (the agent plans read-only; its plan appears in the chat with Approve and execute / Refine plan buttons and Open in editor), the model and reasoning picker, and a context-window ring that opens usage, session cost, and Compact / Clean up / Handoff.
- **Voice input**: the microphone button in the composer (or `omp: Toggle Voice Input`, which you can bind to a key) records what you say; click it again to transcribe, `Esc` to drop the recording. The text goes in at the cursor, ready to edit and send. omp records the microphone itself (VS Code webviews cannot) and always transcribes through Groq's API (Whisper, `groq/whisper-large-v3-turbo`); no speech model is ever downloaded or run locally. The first time without a Groq key, the button offers to sign in with one (free tier, console.groq.com/keys). Set the spoken language in `ompCustom.voiceLanguage`. Needs omp v18.9.1-custom.15 or later.
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
| `ompCustom.env` | Extra environment variables (proxy, certificates, API keys). omp already trusts the certificates of the OS store (the Windows certificate store, or roots added to the macOS keychain), so a company network that re-signs HTTPS works without setup; `NODE_EXTRA_CA_CERTS` here replaces that with your own `.pem` |
| `ompCustom.resumeLastSession` | Continue the workspace's latest session when the chat opens (default on) |
| `ompCustom.sendWhileBusy` | `steer` (deliver mid-turn, default) or `followUp` (queue until the turn ends) |
| `ompCustom.fileCheckpoints` | Snapshot the workspace's git repositories around each turn so editing a prompt can restore files (default on) |
| `ompCustom.voiceLanguage` | Language spoken to the microphone button (`es`, `en`, …); `auto` lets the speech model detect it (default) |

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
