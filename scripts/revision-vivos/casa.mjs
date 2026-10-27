// Casa local (D1 local, sin red) con agentes VIVOS para la revisión adversarial de la rama `vivos`.
// La API de Anthropic se SIMULA: estos scripts no gastan un peso. `proximas` es la cola de lo que
// contesta el modelo y `pedidos` lo que se le mandó, para medir en vez de opinar.
//
// Dos estafetas sobre el MISMO almacén: es la única forma de ver una carrera (una prueba sobre
// node:http serializa lo que el edge corre en paralelo; trampa declarada en CLAUDE.md).
import { randomBytes } from 'node:crypto';
import { generateKeys } from '../../src/nucleo/crypto.js';
import { Estafeta } from '../../src/correo/estafeta.js';
import { Agent } from '../../src/correo/agente.js';
import { D1Store } from '../../src/nucleo/almacen-d1.js';
import { openLocalD1 } from '../../src/nucleo/d1-local.js';
import { MIGRACIONES } from '../../test/_migraciones.js';

export const DOM = 'casa.test';
export const USO = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 };

// La API simulada habla SSE como la real, incluidos los bloques de herramienta.
export const sse = (j) => {
  const partes = [`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: j.usage.input_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}`];
  let i = 0;
  for (const b of j.content || []) {
    if (b.type === 'text') {
      partes.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })}`);
      partes.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } })}`);
    } else if (b.type === 'tool_use') {
      partes.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id || `tu_${i}_${Math.random().toString(36).slice(2, 8)}`, name: b.name, input: {} } })}`);
      partes.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })}`);
    }
    partes.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}`);
    i++;
  }
  partes.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: j.stop_reason }, usage: { output_tokens: j.usage.output_tokens } })}`);
  return partes.join('\n\n') + '\n\n';
};
export const texto = (t, uso = USO) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: uso });
export const usa = (llamadas) => ({ content: llamadas.map((x, n) => ({ type: 'tool_use', id: `tu_${n}_${Math.random().toString(36).slice(2, 8)}`, name: x.name, input: x.input })), stop_reason: 'tool_use', usage: USO });

export async function levantar({ dos = false, api = {} } = {}) {
  const db = openLocalD1(); db._raw.exec(MIGRACIONES);
  const store = new D1Store(db);
  const vaultKey = randomBytes(32).toString('base64');
  const pedidos = [];
  const proximas = [];
  const salidas = [];
  // La API: lo que se le pide se anota SIEMPRE (eso es el espía del gasto) y lo que contesta sale
  // de `proximas`; vacía, contesta texto. `api.demora` deja abrir una ventana de carrera a mano.
  const apiFalsa = async (url, init) => {
    const body = JSON.parse(init.body);
    pedidos.push({ url: String(url), bytes: init.body.length, body });
    if (api.demora) await new Promise((r) => setTimeout(r, api.demora));
    const j = proximas.length ? proximas.shift() : texto(`respuesta ${pedidos.length}`);
    if (j._status) return new Response(JSON.stringify({ error: { message: 'no' } }), { status: j._status, headers: { 'content-type': 'application/json' } });
    return new Response(sse(j), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const red = async (url, init) => {
    if (String(url).startsWith('https://api.anthropic.com')) return apiFalsa(url, init);
    salidas.push(String(url));
    throw new Error(`salida a la red: ${url}`);
  };
  const casaDe = () => new Estafeta({
    domain: DOM, store, adminToken: 't', publicUrl: `https://${DOM}`, workerIntervalMs: 999_999, log: () => {},
    fetchImpl: red, remoto: { enabled: true, vaultKey }, ideas: { enabled: true }, policy: { registration: 'open' },
    libro: { welcome: 0, feeBps: 0 }, index: { enabled: true, crawlMinutes: 999 },
    asistente: { apiKey: 'clave-de-prueba', fetchImpl: red },
  });
  const a = casaDe(); await a.init();
  const b = dos ? casaDe() : null; if (b) await b.init();
  const rx = (method, path, body, auth = 'Bearer t') => a.handleRequest({ method, path, query: new URLSearchParams(), headers: auth ? { authorization: auth } : {}, body, ip: '127.0.0.1' });
  const agente = async (local, opts = {}) => {
    const ag = Agent.create(`${local}@${DOM}`, `https://${DOM}`, { fetchImpl: a.fetchPropio });
    await ag.register({ adminToken: 't', ...opts });
    return ag;
  };
  const duena = await agente('duena');
  const amiga = await agente('amiga');
  const extrano = await agente('extrano');
  // rosetta@: una dirección que YA EXISTE, con su lista, y se adopta con manos. Es el caso real.
  const rosetta = await agente('rosetta', { inbox: { policy: 'allowlist', allowlist: [`duena@${DOM}`, `amiga@${DOM}`] }, capabilities: { listed: true } });
  const ad = await rx('POST', '/admin/assistants', { adopt: true, local: 'rosetta', keys: rosetta.keys, config: { budget_usd: 50, persona: 'Eres rosetta.', owner: duena.address, tools: true } });
  if (ad.status !== 201) throw new Error(`adopción: ${ad.status} ${JSON.stringify(ad.body)}`);
  const on = await rx('PUT', '/admin/assistants/rosetta/config', { enabled: true });
  if (on.status !== 200) throw new Error(`encender: ${on.status} ${JSON.stringify(on.body)}`);
  // Entregar la cola entera sin atender asistentes: sólo mueve sobres al buzón.
  const drenar = async (est = a) => {
    const real = store.claimDueJobs.bind(store);
    store.claimDueJobs = (n) => real(n, 5000);
    try { await est.tick({ programado: false }); } finally { store.claimDueJobs = real; }
  };
  return { a, b, db, store, rx, agente, duena, amiga, extrano, rosetta, drenar, pedidos, proximas, salidas, generateKeys };
}

// qa@ como servicio: asistente de SISTEMA con buzón ABIERTO. Es el que recibe de un extraño.
export async function altaQa(rx, { tools = true, owner, precio = 0, keys } = {}) {
  const k = keys || generateKeys();
  const r = await rx('POST', '/admin/assistants', { system: true, local: 'qa', keys: k, config: { budget_usd: 50, persona: 'Eres qa.', owner, tools, price_tokens: precio } });
  if (r.status !== 201) throw new Error(`alta qa: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body, keys: k };
}
export const ms = (t0) => `${(performance.now() - t0).toFixed(0)} ms`;
export const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
