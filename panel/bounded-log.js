'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Only the diagnostic journals the panel writes itself. A live CLI journal is never truncated from outside.
function add(file, data, limit = 2 * 1024 * 1024) {
  const line = JSON.stringify(data) + '\n';
  if (Buffer.byteLength(line) > limit) throw new Error("Diagnostic entry exceeds the size limit");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > limit) {
    // One archive: a bounded total on disk, and no journal of the user is ever handed to this module.
    fs.renameSync(file, file + '.previous');
  }
  fs.appendFileSync(file, line);
}
module.exports = { add };
