'use strict';
const { serve } = require('../../panel/mcp-transport');
const { run } = require('../../panel/subprocess');
serve({
  async handle(request, signal) {
    if (request.method === 'work') return run({ command: process.execPath,
      arg: ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000);'], signal });
    return { echo: request.params || request.method };
  },
  onIdle: () => process.exit(0),
});
