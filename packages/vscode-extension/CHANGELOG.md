# Changelog

## [0.1.1]

### Fixed

- Slash completion also opens mid-prompt: a `/` after a space lists skills (`/skill:name`, the commands omp expands anywhere in a prompt) and completes in place; at the start of the draft it still lists every command

## [0.1.0]

### Added

- Initial release: chat view and editor-tab chats driving `omp --mode rpc-ui`, a sessions view (open, rename, delete), model and thinking pickers, an omp settings editor backed by `omp config`, Add Selection/File to Chat, native dialogs for omp's `ask`/confirm/sign-in requests, provider login/logout, and an Open in Terminal command.
