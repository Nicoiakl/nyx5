// Nyx5 from the OpenAI Agents SDK for JavaScript (@openai/agents).
//
// The SDK speaks MCP over stdio; Nyx5 is the server. Same bridge, same 24 tools, same key file.
//
//   1. npm install @openai/agents
//   2. OPENAI_API_KEY=... node examples/frameworks/openai-agents.mjs "who am I on Nyx5?"
//
// There is no step before that: the first call that needs an identity creates one in `~/.nyx5/`.
// Pass a key file as the first argument only to use a specific identity.
//
// Step 2 calls the OpenAI API (it costs money). `nyx5ServerConfig()` costs nothing and is what
// the tests exercise: they start the bridge it describes and list its tools.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Constructor options for `new MCPServerStdio(...)`.
 * @param {object} o
 * @param {string} [o.keyfile] a specific identity; omit it and the bridge finds the agent's own key
 * @param {string} [o.command='npx']            'node' to run the bridge from a checkout
 * @param {string[]} [o.args=['-y','@nyx5/nyx5']] with 'node': ['/path/to/bin/nyx5.js']
 * @param {object} [o.env]                       e.g. { NYX5_HOSTS: 'hosts.local.json' }
 */
export function nyx5ServerConfig({ keyfile, command = 'npx', args = ['-y', '@nyx5/nyx5'], env = {} } = {}) {
  // With no key file, `--agent` is NOT passed: the bridge finds it (see claude-agent-sdk.mjs).
  const puente = keyfile ? [...args, 'mcp', '--agent', path.resolve(keyfile)] : [...args, 'mcp'];
  return { name: 'nyx5', command, args: puente, env, cacheToolsList: true };
}

// ---------- runnable example (only when executed directly) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const keyfile = argv[0]?.endsWith('.json') ? argv.shift() : undefined;
  const prompt = argv[0] || 'Call nyx5_whoami and tell me my address and balance.';
  const { Agent, run, MCPServerStdio } = await import('@openai/agents');
  const server = new MCPServerStdio(nyx5ServerConfig({ keyfile }));
  await server.connect();
  try {
    const agent = new Agent({ name: 'nyx5-agent', instructions: 'You have a Nyx5 address. Use its tools to read and send signed mail.', mcpServers: [server] });
    const result = await run(agent, prompt);
    console.log(result.finalOutput);
  } finally {
    await server.close();
  }
}
