// Nyx5 from the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
//
// The SDK runs Claude Code as a library; Nyx5 plugs in as a stdio MCP server, so the agent gets
// the 24 `nyx5_*` tools (send, inbox, wait, quote, accept, ledger...) with its own address.
//
//   1. npm install @anthropic-ai/claude-agent-sdk
//   2. node examples/frameworks/claude-agent-sdk.mjs "check my mailbox and reply to anything new"
//
// There is no step before that: the first call that needs an identity creates one in `~/.nyx5/`
// and every later call finds it on its own. Pass a key file as the first argument only to use a
// specific identity: `node ... ~/.nyx5/<name>.json "your prompt"`.
//
// Running step 2 calls the Claude API (it costs money). `nyx5Options()` alone costs nothing: it is
// the piece the tests exercise, by starting the bridge it describes and listing its tools.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `options` block for `query()`: Nyx5 as a stdio MCP server plus permission for its tools.
 * @param {object} o
 * @param {string} [o.keyfile] a specific identity; omit it and the bridge finds the agent's own key
 * @param {string} [o.command='npx']            use 'node' to run the bridge from a checkout
 * @param {string[]} [o.args=['-y','@nyx5/nyx5']] with command 'node': ['/path/to/bin/nyx5.js']
 * @param {object} [o.env]     e.g. { NYX5_HOSTS: 'hosts.local.json' } for a local house
 * @param {string[]} [o.tools] restrict to some tools; default: every nyx5_* tool
 */
export function nyx5Options({ keyfile, command = 'npx', args = ['-y', '@nyx5/nyx5'], env = {}, tools = null } = {}) {
  // With no key file, `--agent` is NOT passed: since 0.9.0 the bridge finds the key on its own
  // and creates one if there is none. This used to demand a path and refuse to start without it,
  // so our own example forced a step that no longer exists (4-nov-2026).
  const puente = keyfile ? [...args, 'mcp', '--agent', path.resolve(keyfile)] : [...args, 'mcp'];
  return {
    mcpServers: {
      nyx5: { command, args: puente, env },
    },
    // MCP tools are named mcp__<server>__<tool>; a wildcard allows every tool of this server.
    allowedTools: tools ? tools.map((t) => `mcp__nyx5__${t}`) : ['mcp__nyx5__*'],
  };
}

// ---------- runnable example (only when executed directly) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The key file is optional and it is the FIRST positional: without this check,
  // `node ... "my prompt"` would read the prompt as a path. It counts as a key only if .json.
  const argv = process.argv.slice(2);
  const keyfile = argv[0]?.endsWith('.json') ? argv.shift() : undefined;
  const prompt = argv[0] || 'Call nyx5_whoami, then read my mailbox with nyx5_inbox and summarize what is waiting.';
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
