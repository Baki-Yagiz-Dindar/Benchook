'use strict';
const fs = require('node:fs');
const path = require('node:path');
const operation = require('../../panel/folder-transaction');
const [root, mode] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = (a, b) => {
  rename(a, b);
  if (mode === 'install' && path.basename(a).startsWith('.benchook-new-')) process.exit(23);
  if (mode === 'delete' && path.basename(b).startsWith('.benchook-backup-')) process.exit(23);
  if (mode === 'commit' && path.basename(b).startsWith('.benchook-transaction-') && JSON.parse(fs.readFileSync(b)).done) process.exit(23);
  if (mode === 'backup' && path.basename(b).startsWith('.benchook-backup-')) process.exit(23);
  if (mode === 'prepare' && path.basename(b).startsWith('.benchook-transaction-') && !JSON.parse(fs.readFileSync(b)).done) process.exit(23);
  if (mode === 'recover' && path.basename(a).startsWith('.benchook-backup-')) process.exit(23);
};
operation.setup(path.join(root, 'journal'));
if (mode === 'recover') process.exit(0);
operation.apply(['a', 'b'].map(name => ({ target: path.join(root, name), remove: mode === 'delete',
  prepare: tmp => fs.writeFileSync(path.join(tmp, 'data'), 'new') })));
