// Nyx5/1 — Puente MCP (extensión urn:nyx5:ext:mcp).
// Expone un agente Nyx5 (correo + libro) como servidor MCP por stdio, para que Claude Desktop,
// Claude Code, Cursor o cualquier cliente MCP pueda enviar sobres, leer el buzón, cotizar, aceptar,
// cobrar y consultar saldo como herramientas.
// Transporte stdio de MCP: JSON-RPC 2.0, un mensaje por línea. Sin dependencias.

import readline from 'node:readline';
import { Agent } from '../correo/agente.js';
import { TOOLS, llamar, INSTRUCCIONES } from './herramientas.js';
import { VERSION } from '../version.js';

export { TOOLS };

const PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2025-06-18', '2025-03-26']);

// `agent` ya resuelto (lo normal desde el 4-nov-2026: la CLI deduce la identidad y, si no hay,
// se une sola) o `agentFile` con la ruta, que es el camino de siempre y sigue sirviendo.
export async function runMcpServer({ agent: agentDado = null, agentFile = null, hosts = {} }) {
  const agent = agentDado || await Agent.load(agentFile, { hosts });
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const call = (name, args) => llamar(agent, name, args);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    const { id, method, params } = req;
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) continue;
    try {
      let result;
      if (method === 'initialize') result = { protocolVersion: SUPPORTED.has(params?.protocolVersion) ? params.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nyx5', version: VERSION }, instructions: INSTRUCCIONES };
      else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools: TOOLS };
      else if (method === 'tools/call') { try { result = await call(params?.name, params?.arguments); } catch (e) { result = { ...text(`error: ${e.message}`), isError: true }; } }
      else { out({ jsonrpc: '2.0', id, error: { code: -32601, message: `método no soportado: ${method}` } }); continue; }
      if (id !== undefined) out({ jsonrpc: '2.0', id, result });
    } catch (e) {
      out({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
}
