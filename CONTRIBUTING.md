# Contributing

Explain the behavior you want to improve before proposing a large change. Include
Windows, Node.js, and provider CLI versions in reproducible bug reports. Use a small
temporary project; remove credentials, email addresses, and session content from logs.

Install with `npm ci --prefix panel`. Run `node --test tests/*.test.js` after changes
and `node tests/panel-live.cjs` when changing the renderer or terminal lifecycle.
The integration test opens Electron and uses temporary accounts with a synthetic
CLI. Do not use a contributor's live account for automated model calls.

For documentation changes, run `node tools/check-docs.cjs`. This checks local
document links and heading anchors, not remote URLs or feature correctness.
For a Windows x64 portable build, run `npm run package:windows --prefix panel`
after installing dependencies. Each build uses a fresh output under `dist/`.
Validate the extracted build before attaching it to a release.

Keep interface text and new documentation in English. Preserve existing serialized
keys or provide a tested migration. New error handling should preserve user data
and report failures accurately. Add regression tests that reproduce the problem;
avoid assertions that merely repeat the implementation.

Describe the problem, resulting behavior, checks performed, and any untested paths
in your pull request. Contributions are distributed under this project's MIT License.
