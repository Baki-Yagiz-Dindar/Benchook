#!/usr/bin/env node
'use strict';
// BENCHOOK APPROVAL SERVER - answers the permission prompts of a Claude agent on the default level.
//
// The worker starts `claude --print --permission-prompt-tool mcp__benchook_approval__ask` with this server in
// `--mcp-config`. Every question normal use would ask the user in the terminal arrives here with the tool name
// and its input; it is written to the run's folder (BENCHOOK_APPROVALS), shown on the live run card, and the
// user's answer goes back to Claude: {behavior:'allow', updatedInput} or {behavior:'deny', message}.
// It decides nothing itself and has no time limit (`panel/approvals.js`).

const approvals = require('../panel/approvals');

const folder = process.env.BENCHOOK_APPROVALS;

const TOOLS = [{
  name: 'ask',
  description: 'Asks the Benchook user to allow or deny a permission request of this agent.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
    required: ['tool_name'], additionalProperties: true },
}];

async function handle(m, signal) {
  if (m.method === 'initialize') {
    return { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'benchook_approval', version: require('../panel/product').VERSION } };
  }
  if (m.method === 'tools/list') return { tools: TOOLS };
  if (m.method === 'ping') return {};
  if (m.method === 'tools/call') {
    const a = (m.params && m.params.arguments) || {};
    const input = a.input && typeof a.input === 'object' ? a.input : {};
    const decision = folder
      ? (await approvals.ask(folder, approvals.describeClaude(String(a.tool_name || ''), input), { signal })).decision
      : 'deny';
    const answer = decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: folder ? 'The user denied this in Benchook.' : 'Benchook could not show this request, so it was denied.' };
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
  }
  const error = new Error('Unknown method: ' + m.method);
  error.rpcCode = -32601;
  throw error;
}

require('../panel/mcp-transport').serve({ handle, onIdle: () => process.exit(0) });
