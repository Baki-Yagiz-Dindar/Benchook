# Get started with Benchook

[Benchook](../README.md) · [User guide](USER-GUIDE.md) · [Troubleshooting](#troubleshooting)

This guide covers Benchook setup and assumes basic familiarity with terminal tools.
The interface is in English.

## What you need

- **Windows x64.** Other platforms are not validated for this release.
- **Node.js 22.12 or newer.** See the short setup below.
- **Your existing Claude Code or Codex setup.** Either provider is sufficient.

## Install Node.js

If you already have Node.js 22.12 or newer, skip this step. Otherwise, open
**PowerShell** and install the LTS release:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget
```

Follow the installer prompts, then reopen PowerShell and check:

```powershell
node --version
```

If `winget` is unavailable, use the **Windows Installer (.msi)** for the LTS
release from [nodejs.org](https://nodejs.org/en/download), keeping the default options.

## Install Claude Code or Codex

Benchook runs the providers' own command-line tools. If you do not have them yet,
install one or both in **PowerShell** with the providers' official installers,
which do not need Node.js:

```powershell
irm https://claude.ai/install.ps1 | iex
irm https://chatgpt.com/codex/install.ps1 | iex
```

Open a new PowerShell window afterwards. If Benchook cannot find a tool, it says
which one and the command that installs or repairs it.

## From source

Clone the Benchook repository, or use **Code → Download ZIP** on its GitHub page
and extract the archive. Open PowerShell in the repository root, where `panel`
and `tools` are located, then run:

```powershell
npm ci --prefix panel
node tools/check-install.cjs
npm start --prefix panel
```

The first command installs application dependencies, including Electron and the
terminal components. Resolve any requirements reported by the installation
checker before starting the app. Keep the `panel` and `tools` folders together.

## Windows portable ZIP

1. Download the Windows x64 ZIP and its matching `.zip.sha256` file from the
   [latest release](https://github.com/Baki-Yagiz-Dindar/Benchook/releases/latest). GitHub's **Source code** archives are
   not the portable app.
2. In PowerShell, run `Get-FileHash -Algorithm SHA256` followed by the quoted ZIP
   path. Compare the hash with the first value in the `.sha256` file. A match
   checks file integrity; obtain both files from a trusted source.
3. Extract **all files** to a permanent folder, then open `Benchook.exe`.
   Keep the executable and its accompanying files together.

The build is unsigned, so Windows may show a publisher warning. Verify the source
before running it. The ZIP includes application dependencies, but still needs
Node.js. You do not need to run `npm install` for this build.

Settings live separately from the extracted folder. Removing that folder does not
remove profiles or credentials. If you move the app, rerun the affected project's
integration setup to update helper paths. See [data and security](../SECURITY.md).

## Open your first project

Use a small sample project for your first session.

1. In **Accounts**, select **Add account**. If an account already exists, select
   **+** instead. Choose the provider, then **Add and sign in**.
2. Complete the provider's sign-in flow and check the displayed account identity.
   For Claude, enter any requested authorization code in Claude Code itself.
   Signing in in another terminal does not necessarily sign in this profile.
3. In **Overview**, select **Open project** and choose the project folder.
   Review any proposed integration changes before accepting them.
4. Choose an account and model, then select **Start orchestrator**. This opens
   your main coding session. Respond to the provider's project trust prompts.
5. Type a small request, such as asking for a summary of a sample text file
   without editing it. This uses your provider account and can consume usage.

You should now see the provider's response in the embedded terminal. Account
limits may remain unavailable until the provider reports them.

Continue with [agents](USER-GUIDE.md#work-with-agents),
[skills](USER-GUIDE.md#manage-skills), or
[account and model switching](USER-GUIDE.md#choose-accounts-and-models).

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Claude Code or Codex cannot start | Benchook says whether the CLI is not installed or installed but broken (for example, its program file is missing after an unfinished update) and shows the official command that fixes it. Run that command, then try again. If the CLI is still not found, restart Benchook. |
| Another command is not found | Check that Node.js is installed and available on PATH. Restart Benchook after changing the environment. |
| An account is signed out | Sign in through that account's Benchook profile and verify the displayed identity. |
| Usage is unavailable | Missing data is not zero usage. Some information appears only after a provider response; see [usage displays](USER-GUIDE.md#read-context-and-usage). |
| Agent tools are missing | Check the selected project's **MCP connection**, complete setup where prompted, and restart the coding session if the provider requires it. |
| A save fails | Read the error and inspect the affected files before retrying. File locks or a blocked Windows helper can prevent saving; see [limitations](LIMITATIONS.md). |

If the problem persists, include version information and reproduction steps in a
bug report. Remove sensitive content before sharing logs or screenshots.
