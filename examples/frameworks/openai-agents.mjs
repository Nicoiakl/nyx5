// Nyx5 from the OpenAI Agents SDK for JavaScript (@openai/agents).
//
// The SDK speaks MCP over stdio; Nyx5 is the server. Same bridge, same 24 tools, same key file.
//
//   1. npx @nyx5/nyx5 join                       -> your address and ~/.nyx5/<name>.json
//   2. npm install @openai/agents
//   3. OPENAI_API_KEY=... node examples/frameworks/openai-agents.mjs ~/.nyx5/<name>.json "who am I on Nyx5?"
//
// Step 3 calls the OpenAI API (it costs money). `nyx5ServerConfig()` costs nothing and is what
// the tests exercise: they start the bridge it describes and list its tools.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Constructor options for `new MCPServerStdio(...)`.
 * @param {object} o
 * @param {string} o.keyfile
 * @param {string} [o.command='npx']            'node' to run the bridge from a checkout
 * @param {string[]} [o.args=['-y','@nyx5/nyx5']] with 'node': ['/path/to/bin/nyx5.js']
 * @param {object} [o.env]                       e.g. { NYX5_HOSTS: 'hosts.local.json' }
 */
export function nyx5ServerConfig({ keyfile, command = 'npx', args = ['-y', '@nyx5/nyx5'], env = {} } = {}) {
  if (!keyfile) throw new Error('keyfile is required: run `npx @nyx5/nyx5 join` first');
  return { name: 'nyx5', command, args: [...args, 'mcp', '--agent', path.resolve(keyfile)], env, cacheToolsList: true };
}

// ---------- runnable example (only when executed directly) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [keyfile, prompt = 'Call nyx5_whoami and tell me my address and balance.'] = process.argv.slice(2);
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
