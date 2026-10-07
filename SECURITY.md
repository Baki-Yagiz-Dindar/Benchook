# Security

[Back to Benchook](README.md)

## Permissions and trust

Benchook is a local desktop application. Its terminals and agent runner execute
provider CLIs with your operating-system permissions and provider configuration.
Project agents, skills, and hooks can direct those CLIs to read files or run commands.
Review their content before using them. The application is not a sandbox for agents.

Permission choices depend on the selected provider's enforcement. They are not a
guarantee that arbitrary instructions are safe. Review project trust, hook, and
MCP prompts. Shared agent and skill edits can affect multiple projects.

## Local data and provider access

- The desktop app uses Electron's user-data directory, normally
  `%APPDATA%\Benchook`, for layouts, account references, shared definitions,
  skill copies, and diagnostic records. Deleting the portable installation does
  not erase this data. A custom Electron `--user-data-dir` changes that location.
- Helpers launched by the app inherit its data location through `BENCHOOK_DATA_DIR`.
  Standalone helpers honor that variable; setting it alone does not relocate the
  desktop app's profile.
- Provider credentials remain in provider profile folders. The account registry
  holds names and folder references, not an embedded credential export. Benchook
  reads Codex's local authentication file to derive account identity; Claude
  identity is queried through the CLI rather than reading its OAuth token contents.
- Conversations, run results, traces, backups, and crash dumps can contain private
  project content or paths. Session continuation can copy conversation records
  between local account profiles. Treat those folders as sensitive.
- Benchook's crash reporter is configured not to upload dumps. Provider CLIs still
  communicate with their services when you authenticate or run tasks; this is not
  an offline-model product. Provider terms and data handling apply to those calls.

## Reporting a vulnerability

Do not post credentials, authorization links, account files, or session transcripts
in public issues. For a vulnerability, use the repository's **Security → Report a
vulnerability** feature when enabled. If it is unavailable, open an issue requesting
a private contact without exploit details or sensitive data.

Only the current source version receives fixes. No security audit or guarantee of
freedom from vulnerabilities is claimed. Electron restricts renderer navigation,
external URL schemes, and IPC senders; those controls do not replace reviewing the
commands you authorize in a terminal.
