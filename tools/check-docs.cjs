'use strict';
// Local documentation links, headings and bundled documentation. No network requests.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const documents = ['README.md','SECURITY.md','CONTRIBUTING.md','ARCHITECTURE.md',
  'THIRD_PARTY_NOTICES.md','CHANGELOG.md','docs/QUICKSTART.md','docs/USER-GUIDE.md','docs/LIMITATIONS.md'];
let links = 0;
for (const file of documents) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const url = match[1]; if (/^https?:\/\//.test(url)) continue;
    assert.ok(!/^(?:file:|[A-Za-z]:)/.test(url), 'machine-local link in ' + file);
    const [name, anchor] = url.split('#');
    const target = path.resolve(path.dirname(path.join(root,file)), decodeURIComponent(name || path.basename(file)));
    assert.ok(target.startsWith(root + path.sep), 'link outside project: ' + file);
    assert.ok(fs.existsSync(target), 'missing link: ' + file + ' -> ' + url);
    if (anchor) {
      const headings = [...fs.readFileSync(target,'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
        .map(m => m[1].trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/ /g,'-'));
      assert.ok(headings.includes(anchor), 'missing heading: ' + url);
    }
    links++;
  }
}
console.log('PASS documentation: ' + documents.length + ' documents, ' + links + ' local links/anchors');
