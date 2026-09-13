// Nyx5/1 — Puente MCP remoto: el mismo conjunto de herramientas, por Streamable HTTP en /mcp.
//
// Es lo que deja a cualquier Claude (claude.ai en el navegador, Desktop, el teléfono) usar Nyx5
// agregando una URL, sin instalar nada. Cada llamada llega con un token OAuth que apunta a un
// subagente delegado cuya llave guarda la casa (ver src/puentes/oauth.js); el puente arma ese
// agente en el mismo proceso y ejecuta la herramienta con él. Nunca con la llave del dueño.
//
// Del transporte (MCP 2025-06-18 / 2025-11-25) se usa lo mínimo que un servidor de sólo
// herramientas necesita: un POST por mensaje JSON-RPC, respuesta application/json, 202 para
// notificaciones, 405 al GET (no hay flujo iniciado por el servidor) y sin sesión: cada petición
// trae su token, así que no hay estado que perder entre instancias del edge.
import { TOOLS, MENSAJERIA, llamar, instrucciones } from './herramientas.js';
import { validarAcceso } from './oauth.js';
import { VERSION } from '../version.js';

export const VERSIONES = ['2025-11-25', '2025-06-18', '2025-03-26'];
const HERRAMIENTAS = TOOLS.filter((t) => MENSAJERIA.has(t.name));
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Un Origin presente tiene que ser un origen real: el spec pide 403 ante uno inválido (protección
// contra DNS rebinding). No se exige una lista cerrada: la protección de fondo es el token.
function origenValido(o) {
  try { const u = new URL(o); return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)); }
  catch { return false; }
}

export async function atenderMcp(est, rx) {
  if (rx.method !== 'POST') return { status: 405, headers: { allow: 'POST' }, body: { reason: 'this MCP endpoint takes POST only; it does not open a server-initiated stream' } };
  if (rx.headers.origin !== undefined && !origenValido(rx.headers.origin)) return { status: 403, body: { reason: 'invalid Origin header' } };
  const acceso = await validarAcceso(est, rx);
  if (!acceso.ok) return acceso.out;
  const pv = rx.headers['mcp-protocol-version'];
  if (pv && !VERSIONES.includes(pv)) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: `unsupported MCP-Protocol-Version ${pv}; supported: ${VERSIONES.join(', ')}` } } };
  const sub = acceso.token.sub;
  if (!await est.remotoRate.allow(`mcp:${sub}`)) return { status: 429, headers: est._retryAfter(), body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'too many requests; slow down' } } };

  const msg = rx.body;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'send exactly one JSON-RPC message per POST' } } };
  // Notificación (sin id) o respuesta del cliente: se acepta y no se contesta nada.
  if (msg.id === undefined || msg.id === null || typeof msg.method !== 'string') return { status: 202, contentType: 'application/json', body: '' };

  const { id, method, params } = msg;
  const ok = (result, extra = {}) => ({ status: 200, body: { jsonrpc: '2.0', id, result }, ...extra });
  switch (method) {
    case 'initialize': {
      const pedida = params?.protocolVersion;
      const propia = `${sub}@${est.domain}`;
      const contactos = ((await est.store.getAgent(sub))?.inbox?.allowlist || []).filter((x) => x !== propia);
      return ok({
        protocolVersion: VERSIONES.includes(pedida) ? pedida : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nyx5', title: 'Nyx5', version: VERSION },
        instructions: instrucciones({ remoto: true, address: propia, contactos }),
      });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: HERRAMIENTAS });
    case 'tools/call': {
      const agent = await est.agenteDeBoveda(sub);
      if (!agent) return (await validarAcceso(est, { headers: {} })).out;
      let result;
      // Un error de la herramienta vuelve como resultado con isError (el modelo puede corregirse),
      // no como error del protocolo (spec 2025-11-25).
      try { result = await llamar(agent, params?.name, params?.arguments || {}, { permitidas: MENSAJERIA, esperaMaxS: 90 }); }
      catch (e) { result = { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }; }
      // kick: lo que la herramienta dejó en la cola sale ya, no en el próximo minuto del cron.
      return ok(result, { kick: true });
    }
    default: return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported: ${method}` } } };
  }
}
