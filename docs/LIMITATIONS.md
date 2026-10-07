# Limitations

[Back to Benchook](../README.md)

This release is intended for users comfortable with coding-agent CLIs. It is not a
claim that every account, provider version, or Windows configuration has been tested.

- **Platform:** the portable build targets Windows x64. macOS, Linux, and Windows
  ARM builds are not validated for this release.
- **Distribution:** the ZIP is unsigned, not an installer. It requires
  [Node.js](QUICKSTART.md#install-nodejs). Keep the extracted files together.
- **First installation:** this release was tested on the development machine and on
  one clean Windows machine with real provider accounts. Other Windows
  configurations have not been validated.
- **Provider compatibility:** provider CLI updates can change account information,
  model lists, usage limits, or session formats. Benchook handles some format
  changes, but removed commands or incompatible data may still require an update.
  Automated integration tests use a synthetic CLI;
  they do not prove live authentication or all cross-provider workflows.
- **Conversations:** switching providers starts a new conversation. Within-provider
  continuation requires compatible, available local session records.
- **Usage displays:** context and quota information may be missing or stale. It is
  not authoritative billing data.
- **Installation paths:** project/MCP setup can contain absolute helper paths.
  Moving the app requires rerunning the relevant setup.
- **Windows saves:** when a reader blocks atomic file replacement, an optional
  fallback compiles the included C# source using the Windows .NET Framework compiler
  and caches it in local application data. Missing or blocked compilation can cause
  a save error. An interrupted helper can leave an uncertain outcome; inspect the
  affected files before retrying.
- **Security:** agents run with provider and operating-system permissions; Benchook
  is not an agent sandbox and has not undergone an independent security audit.
- **Older development profiles:** data stored under a previous application name
  is not automatically migrated, converted, or deleted.

Report reproducible problems using the repository's bug template. Use disposable
sample files and remove sensitive details. Follow [SECURITY.md](../SECURITY.md)
for vulnerabilities.
