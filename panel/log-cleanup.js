'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Only the UUID-named trace folders of the panel; active terminals and recent journals are kept.
function cleanup(root, enabled = [], now = Date.now(), day = 7) {
  const result = { removedPaths: [], errors: [] };
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return result;
  const preserved = new Set(enabled.map(p => path.resolve(path.dirname(p))));
  for (const g of fs.readdirSync(root, { withFileTypes: true })) {
    if (!g.isDirectory() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(g.name)) continue;
    const target = path.resolve(root, g.name);
    if (path.dirname(target) !== path.resolve(root) || preserved.has(target)) continue;
    try {
      const files = fs.readdirSync(target, { withFileTypes: true });
      // Do not delete on unexpected content or a link. The Rust journals are plain files only.
      if (files.some(f => !f.isFile() || !/^codex-tui\.log(?:[.\w-]*)?$/.test(f.name))) continue;
      const last = Math.max(fs.statSync(target).mtimeMs, ...files.map(f => fs.statSync(path.join(target, f.name)).mtimeMs));
      if (now - last <= day * 86400000) continue;
      fs.rmSync(target, { recursive: true }); result.removedPaths.push(target);
    } catch (e) { result.errors.push(e.message); }
  }
  return result;
}
/* THE CONTEXT FILES OF CLOSED TERMINALS. One small file per Claude terminal ever opened
   (claude-context/<connection>.json) was kept for good. Files of live terminals are kept; others older
   than `day` days are removed. Only UUID-named .json files directly in that folder are touched. */
function cleanupContext(root, live = [], now = Date.now(), day = 7) {
  const result = { removedPaths: [], errors: [] };
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return result;
  const keep = new Set(live.map((p) => path.resolve(p)));
  for (const g of fs.readdirSync(root, { withFileTypes: true })) {
    if (!g.isFile() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(g.name)) continue;
    const target = path.resolve(root, g.name);
    if (keep.has(target)) continue;
    try {
      if (now - fs.statSync(target).mtimeMs <= day * 86400000) continue;
      fs.rmSync(target); result.removedPaths.push(target);
    } catch (e) { result.errors.push(e.message); }
  }
  return result;
}
module.exports = { cleanup, cleanupContext };
