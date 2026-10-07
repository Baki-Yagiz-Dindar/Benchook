'use strict';
// Only in this test entry point is a real, model-free process used instead of the CLI.
const path = require('node:path');
if (process.env.BENCHOOK_TEST_AUTH === '1') delete process.env.BENCHOOK_TEST;
if (process.env.BENCHOOK_TEST_EXTERNAL_LOG) {
  require('electron').shell.openExternal = async url => {
    require('node:fs').appendFileSync(process.env.BENCHOOK_TEST_EXTERNAL_LOG, JSON.stringify(url) + '\n');
  };
}
require('../../panel/cli-path').cliInvocation = () => ({ command: process.env.BENCHOOK_TEST_NODE,
  leadingArgs: [path.join(__dirname, 'terminal-fixture.cjs')] });
require('../../panel/main');
