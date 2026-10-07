'use strict';
/* Every routing branch that points to a native subagent must also say what to do when no native
   definition exists. Agents created in the panel live in the panel's own folder, which the harness
   does not load as native subagents, so an orchestrator on the same account followed "run it as a
   native subagent", got "Agent type... not found" and had no instruction to fall back to run_agent. */
const test = require('node:test');
const assert = require('node:assert/strict');
const resolution = require('../panel/agent-resolution');

test('every native-subagent route names run_agent as the fallback', () => {
  for (const account of [null, { id: 'claude-a', name: 'a', provider: 'claude' }]) {
    const lines = resolution.routing(account).split('\n');
    const bullets = [];
    for (const l of lines) {
      if (l.startsWith('- ')) bullets.push(l);
      else if (l.startsWith('  ') && bullets.length) bullets[bullets.length - 1] += ' ' + l.trim();
    }
    for (const b of bullets.filter((x) => /native subagent/.test(x))) {
      assert.match(b, /if it does not[^.]*`run_agent`/, 'no run_agent fallback in: ' + b);
    }
  }
});
