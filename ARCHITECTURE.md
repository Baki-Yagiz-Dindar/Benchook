# Architecture

`panel/main.js` owns Electron windows, local processes, IPC, account profiles, and
file operations. `panel/preload.js` exposes a constrained bridge to the renderer.
`panel/panel.js` renders the interface and manages project/tab state; xterm displays
terminal output. Context isolation, renderer sandboxing, a content security policy,
and sender validation separate the renderer from privileged operations.

`panel/accounts.js` manages account references; `panel/account-identity.js` reads account
identity. `panel/sessions.js` handles session discovery and compatible continuation.
`panel/worker.js` executes agents through provider CLIs. `tools/mcp-server.js` exposes
the stdio MCP interface; `panel/mcp-transport.js` handles framing and cancellation.

`panel/agent-writer.js` writes agent definitions. `panel/skills.js` manages skills.
`panel/project-setup.js` previews and applies project integration settings.
`panel/persistent-json.js` provides atomic persistence and backup recovery;
`panel/folder-transaction.js` journals multi-file operations and recovers interrupted work.

Runtime helpers in `tools/` must stay alongside `panel/`. Native PTY support and
trace-storage reclamation are Windows-specific. Local provider session and quota
formats are integration dependencies, not stable application-owned schemas.

Provider readers tolerate additional fields and validate the fields they consume.
Invalid catalog entries do not remove valid models; the latest readable Claude
catalog is preferred over an empty or unsupported one. Context and quota events
are read independently. Unknown numeric or identity fields remain unavailable,
and Codex session lookup checks project metadata when present and rejects ambiguous
matches. Legacy records without metadata retain filename-based lookup.
`tests/provider-compatibility.test.js` exercises these boundaries alongside the
existing account, session-copy and provider tests. This does not guarantee support
for future removed commands, authentication changes or incompatible schemas.

Module names, storage directories, IPC channels, definition fields, and MCP tool names
are English. Data from earlier development versions is not migrated. One legacy
compatibility rule remains: a Turkish "project guidance" section in older agent files
is recognised so it can be removed from the definition (`panel/agent-registry.js`).
