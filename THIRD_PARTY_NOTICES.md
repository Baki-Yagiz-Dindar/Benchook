# Third-party software

Benchook's MIT license covers this project's original source. Dependencies retain
their own licenses. `panel/package-lock.json` records resolved packages and license
metadata. Installing dependencies includes their license files; preserve those
notices when redistributing a bundled application.

Direct dependencies are Electron, xterm.js and its addons, `@lydell/node-pty`, and
`@iarna/toml`. Acorn and rcedit are development dependencies. The MIT-licensed
rcedit is used only at build time to set Windows executable branding; it is not
included in the portable runtime. Electron binaries include
additional Chromium and other third-party notices. This source distribution does
not include downloaded binaries or `node_modules`. The portable Windows ZIP includes
Electron's LICENSE and LICENSES.chromium.html at its root, and dependency license files
under resources/app/panel/node_modules. Node.js and provider CLIs are not bundled.

Claude Code and Codex are separately installed products governed by their providers'
terms. Benchook is an independent project and does not imply provider endorsement.
