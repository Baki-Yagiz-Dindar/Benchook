'use strict';
// Edit only a fresh executable copy supplied by the packaging workflow.
const path = require('node:path');
const fs = require('node:fs');
const metadata = require('../panel/package.json');
const panelRequire = require('node:module').createRequire(path.join(__dirname, '../panel/package.json'));
const { rcedit } = panelRequire('rcedit');
async function brand(executable) {
  const target = path.resolve(executable);
  const installed = path.resolve(require('../panel/node_modules/electron'));
  if (fs.realpathSync(target).toLowerCase() === fs.realpathSync(installed).toLowerCase()
      || fs.lstatSync(target).isSymbolicLink() || path.basename(target) !== 'Benchook.exe')
    throw new Error('Brand only a copied Benchook.exe, never the installed Electron runtime.');
  if (!fs.statSync(target).isFile()) throw new Error('Executable missing');
  await rcedit(target, {
    icon: path.join(__dirname, '../panel/benchook.ico'),
    'file-version': metadata.version,
    'product-version': metadata.version,
    'version-string': { ProductName: 'Benchook', FileDescription: metadata.description,
      InternalName: 'Benchook', OriginalFilename: 'Benchook.exe', CompanyName: '',
      LegalCopyright: 'Benchook contributors. MIT License.' },
  });
}
module.exports = { brand };
if (require.main === module) brand(process.argv[2]).catch(e => { console.error(e); process.exitCode = 1; });
