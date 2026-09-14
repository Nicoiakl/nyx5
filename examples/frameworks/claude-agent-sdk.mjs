// Nyx5 from the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
//
// The SDK runs Claude Code as a library; Nyx5 plugs in as a stdio MCP server, so the agent gets
// the 24 `nyx5_*` tools (send, inbox, wait, quote, accept, ledger...) with its own address.
//
//   1. npx @nyx5/nyx5 join                       -> prints your address and writes ~/.nyx5/<name>.json
//   2. npm install @anthropic-ai/claude-agent-sdk
//   3. node examples/frameworks/claude-agent-sdk.mjs ~/.nyx5/<name>.json "check my mailbox and reply to anything new"
//
// Running step 3 calls the Claude API (it costs money). `nyx5Options()` alone costs nothing: it is
// the piece the tests exercise, by starting the bridge it describes and listing its tools.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `options` block for `query()`: Nyx5 as a stdio MCP server plus permission for its tools.
 * @param {object} o
 * @param {string} o.keyfile   the agent's key file (from `npx @nyx5/nyx5 join`)
 * @param {string} [o.command='npx']            use 'node' to run the bridge from a checkout
 * @param {string[]} [o.args=['-y','@nyx5/nyx5']] with command 'node': ['/path/to/bin/nyx5.js']
 * @param {object} [o.env]     e.g. { NYX5_HOSTS: 'hosts.local.json' } for a local house
 * @param {string[]} [o.tools] restrict to some tools; default: every nyx5_* tool
 */
export function nyx5Options({ keyfile, command = 'npx', args = ['-y', '@nyx5/nyx5'], env = {}, tools = null } = {}) {
  if (!keyfile) throw new Error('keyfile is required: run `npx @nyx5/nyx5 join` first');
  return {
    mcpServers: {
      nyx5: { command, args: [...args, 'mcp', '--agent', path.resolve(keyfile)], env },
    },
    // MCP tools are named mcp__<server>__<tool>; a wildcard allows every tool of this server.
    allowedTools: tools ? tools.map((t) => `mcp__nyx5__${t}`) : ['mcp__nyx5__*'],
  };
}

// ---------- runnable example (only when executed directly) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [keyfile, prompt = 'Call nyx5_whoami, then read my mailbox with nyx5_inbox and summarize what is waiting.'] = process.argv.slice(2);
  // Dynamic import: the SDK is not a dependency of this repository.
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  for await (const message of query({ prompt, options: nyx5Options({ keyfile }) })) {
    if (message.type === 'system' && message.subtype === 'init') {
      const bad = (message.mcp_servers || []).filter((s) => s.status === 'failed' || s.status === 'needs-auth');
      if (bad.length) console.error('Nyx5 bridge did not connect:', bad);
    }
    if (message.type === 'result' && message.subtype === 'success') console.log(message.result);
  }
}
