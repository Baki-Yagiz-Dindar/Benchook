'use strict';
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
rl.on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') console.log(JSON.stringify({ id: r.id, result: {} }));
  else if (r.method === 'initialized') initialized = true;
  else if (r.method === 'account/rateLimits/read' && initialized) console.log(JSON.stringify({ id: r.id,
    result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 2000000000 } } } } }));
  else process.exit(7);
});
