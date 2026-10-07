# Changelog

Notable changes to Benchook are recorded here. Versions are added when a release is published.

## 0.1.0 — 2026-10-07

First public release. Windows only; other operating systems are not tested.

### Added

- Separate quick-start, user, and limitations guides; portable runtime documentation.

- Embedded Claude Code and Codex terminals with saved project and tab layouts.
- Separate account profiles per provider. The application starts with no accounts;
  accounts are added and signed in through each provider's own flow.
- Session continuation when switching accounts or models within one provider, where
  compatible local records are available. Switching providers starts a new conversation;
  chat history and context are not transferred.
- Agent definitions shared across projects, with per-agent account and model, and a stdio
  MCP server (`list_agents`, `run_agent`, `list_accounts`) for the orchestrator.
- Project skills written for both Claude Code and Codex.
- Context and quota displays that mark unavailable data instead of showing zero.
- Install checks that tell a missing Claude Code or Codex CLI from a broken install and
  show the official command that fixes it, before an account is added or a session starts.

### Known limitations

- The Windows portable build is unsigned. Use your existing Claude Code or Codex setup
  with Node.js 22.12 or newer; see [Node.js setup](docs/QUICKSTART.md#install-nodejs).

- Provider session, quota, and profile formats are external and may change.
- The Electron integration test uses a synthetic CLI; live provider sign-in is not tested
  automatically.

### Fixed

- Codex connection checks recognize commented and quoted TOML headers; setup preserves multiline environment lists.
- Delayed connection updates cannot overwrite the status of another project or account.
- Workspace changes stay on their original tab while terminals stop and restart; cancelled launches do not leave hidden terminals running.
- Adding an existing agent to another project preserves its chosen permission level.
- Shared skill save confirmations include both provider folders of every member project.
- Duplicate sign-in e-mail warnings compare accounts within the same provider only.
- Escape closes account, agent, and skill forms as well as run details.
