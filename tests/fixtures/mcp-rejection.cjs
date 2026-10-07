'use strict';
require('../../panel/mcp-transport').serve({
  handle: async request => { if(request.method==='fail') throw request.params; return {}; },
  onIdle:()=>process.exit(0),
});
