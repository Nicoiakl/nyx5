// node --test test/
// Los asistentes: una dirección que contesta sola con la API de Anthropic, dentro de un tope. Nació
// para que Basti le pregunte al agente de Sigo mientras Nicholas viaja un mes. La API se simula: estas
// pruebas no gastan un peso, y comprueban lo que se le manda a la API y lo que se hace con su respuesta.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from "node:crypto";
import { sha256hex } from "../src/nucleo/crypto.js";
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { costoDe } from '../src/correo/asistente.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4251;
const H = 'asistente.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
let tmp, casa, duena, pregunton, extrano, asis;
const pedidos = [];
let proxima = null; // lo que responde la API simulada la próxima vez
const USO = { input_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 200 };
// La API se simula como la real: en flujo (SSE) cuando el cuerpo lo pide y la respuesta es 200; un
// error viene como JSON. Así se prueba el lector del flujo, no una forma que la API ya no usa.
const sse = (j) => {
  const partes = [`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: j.usage.input_tokens, cache_creation_input_tokens: j.usage.cache_creation_input_tokens || 0, cache_read_input_tokens: j.usage.cache_read_input_tokens || 0 } } })}`];
  for (const b of j.content || []) if (b.type === 'text') for (const trozo of b.text.match(/.{1,5}/g) || []) partes.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: trozo } })}`);
  partes.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: j.stop_reason }, usage: { output_tokens: j.usage.output_tokens } })}`);
  partes.push('event: message_stop\ndata: {"type":"message_stop"}');
  return partes.join('\n\n') + '\n\n';
};
const apiFalsa = async (url, init) => {
  const body = JSON.parse(init.body);
  pedidos.push({ url, headers: init.headers, body });
  const r = proxima || { status: 200, json: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: `respuesta ${pedidos.length}` }], stop_reason: 'end_turn', usage: USO } };
  proxima = null;
  assert.equal(body.stream, true, 'toda llamada va en flujo');
  if (r.status !== 200) return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  return new Response(sse(r.json), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const admin = (metodo, ruta, body) => fetch(`${URL_CASA}${ruta}`, { method: metodo, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const respuestaA = (quien, desde) => quien.waitFor((e) => e.from === asis.address && Date.parse(e.created) > desde, { timeoutMs: 8000 });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-asistente-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    libro: { welcome: 0, feeBps: 0 }, log: () => {},
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
    asistente: { apiKey: 'clave-de-prueba', fetchImpl: apiFalsa },
  }).start();
  duena = Agent.create(`duena@${H}`, URL_CASA, { hosts });
  pregunton = Agent.create(`pregunton@${H}`, URL_CASA, { hosts });
  extrano = Agent.create(`extrano@${H}`, URL_CASA, { hosts });
  for (const a of [duena, pregunton, extrano]) await a.register({ adminToken: 't' });
  asis = await duena.delegate('sigo', { scope: { messages_only: true }, inbox: { policy: 'allowlist', allowlist: [duena.address, pregunton.address] } });
  const alta = await admin('POST', '/admin/assistants', { local: asis.local, keys: asis.keys, config: { budget_usd: 1, persona: 'Eres el asistente de prueba.' } });
  assert.equal(alta.status, 201, JSON.stringify(alta.body));
  assert.equal(alta.body.custody.keys, 'house');
  assert.equal((await admin('PUT', `/admin/assistants/${asis.local}/knowledge`, { texto: 'Base: el motor vive en src/.' })).status, 200);
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('contesta solo, con lo que devuelve la API, y le manda a la API lo correcto', async () => {
  const t0 = Date.now();
  await pregunton.send({ to: asis.address, body: '¿dónde vive el motor?' });
  const r = await respuestaA(pregunton, t0);
  const abierto = await pregunton.open(r.envelope);
  assert.match(abierto.content.body, /^respuesta \d+$/, 'contesta con el texto de la API, sin el bloque de razonamiento');
  assert.equal(abierto.encrypted, true);
  const p = pedidos.at(-1);
  assert.equal(p.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(p.headers['x-api-key'], 'clave-de-prueba');
  assert.equal(p.headers['anthropic-version'], '2023-06-01');
  assert.equal(p.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(p.body.model, 'claude-opus-5');
  assert.equal(p.body.fallbacks, 'default');
  assert.deepEqual(p.body.thinking, { type: 'adaptive' });
  assert.deepEqual(p.body.system[1].cache_control, { type: 'ephemeral' }, 'la base de conocimiento va en caché');
  assert.equal(p.body.system[0].text, 'Eres el asistente de prueba.');
  assert.match(p.body.messages.at(-1).content, /dónde vive el motor/);
  assert.match(p.body.messages.at(-1).content, /pregunton@asistente\.test/, 'sabe quién le escribe');
  assert.equal((await casa.store.listMail(asis.local)).length, 0, 'lo contestado queda confirmado');
  const estado = await admin('GET', `/admin/assistants/${asis.local}`);
  assert.ok(Math.abs(estado.body.spent_usd - costoDe('claude-opus-5', USO)) < 1e-4, `gasto registrado: ${estado.body.spent_usd}`);
});

// 14-sep-2026: dos pedidas en cola no se mezclan. La primera respuesta no ve la segunda pedida.
test('lo que sigue en cola no entra al historial: cada pregunta se contesta sola', async () => {
  const n = pedidos.length;
  // En pausa, las dos pedidas quedan en cola juntas; al reanudar, un solo reloj las contesta en orden.
  assert.equal((await admin('POST', `/admin/assistants/${asis.local}/pause`)).status, 200);
  const a = await pregunton.send({ to: asis.address, body: 'primera pedida sola' });
  const b = await pregunton.send({ to: asis.address, body: 'segunda pedida sola' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await admin('POST', `/admin/assistants/${asis.local}/resume`)).status, 200);
  await pregunton.waitFor((e) => e.from === asis.address && e.in_reply_to === a.id, { timeoutMs: 8000 });
  await pregunton.waitFor((e) => e.from === asis.address && e.in_reply_to === b.id, { timeoutMs: 8000 });
  const llamadas = pedidos.slice(n).map((p) => p.body.messages.map((x) => x.content).join('\n'));
  const primera = llamadas.find((c) => c.includes('primera pedida sola') && !c.includes('segunda pedida sola'));
  assert.ok(primera, `la segunda pedida se coló en el turno de la primera: ${JSON.stringify(llamadas)}`);
  const segunda = llamadas.find((c) => c.includes('segunda pedida sola'));
  assert.ok(segunda && segunda.includes('primera pedida sola'), `la segunda sí lleva a la primera, ya contestada: ${JSON.stringify(llamadas)}`);
});

test('la segunda pregunta lleva la conversación anterior, en turnos alternados', async () => {
  const t0 = Date.now();
  await pregunton.send({ to: asis.address, body: '¿y los tests?' });
  await respuestaA(pregunton, t0);
  const roles = pedidos.at(-1).body.messages.map((m) => m.role);
  assert.equal(roles[0], 'user');
  assert.equal(roles.at(-1), 'user');
  assert.ok(roles.includes('assistant'), `sin historial: ${roles}`);
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1], 'los turnos no se alternan');
});

test('un rechazo de la API se contesta como rechazo, y un error no confirma el mensaje', async () => {
  proxima = { status: 200, json: { content: [], stop_reason: 'refusal', usage: { input_tokens: 0, output_tokens: 0 } } };
  let t0 = Date.now();
  await pregunton.send({ to: asis.address, body: 'algo que se rechaza' });
  const r = await respuestaA(pregunton, t0);
  assert.equal((await pregunton.open(r.envelope)).content.body, 'No puedo responder eso.');
  proxima = { status: 500, json: { error: { message: 'caída' } } };
  const n = pedidos.length;
  await pregunton.send({ to: asis.address, body: 'esto falla' });
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.ok(pedidos.length > n, 'llamó a la API');
  assert.equal((await casa.store.listMail(asis.local)).length, 1, 'un error de la API no confirma el mensaje: se reintenta');
});

test('al llegar al tope deja de llamar a la API, avisa a quien pregunta y, una vez, a su dueña', async () => {
  const mes = new Date().toISOString().slice(0, 7);
  await casa.store.kvPut('asistente-gasto', `${asis.local}:${mes}`, { usd: 1, llamadas: 99, avisado: false });
  const n = pedidos.length;
  const t0 = Date.now();
  await pregunton.send({ to: asis.address, body: '¿sigues ahí?' });
  const r = await respuestaA(pregunton, t0);
  assert.match((await pregunton.open(r.envelope)).content.body, /tope de gasto/);
  assert.equal(pedidos.length, n, 'pasado el tope no se llama a la API');
  const aviso = await duena.waitFor((e) => e.from === asis.address, { timeoutMs: 5000 });
  assert.match((await duena.open(aviso.envelope)).content.body, /llegó al tope/);
});

// Revisión del 13-sep-2026: un grupo no puede ser el camino para gastarle el presupuesto a un
// asistente. Aunque un contacto suyo lo meta en un grupo, el asistente sólo contesta correo directo.
test('un asistente no contesta mensajes de grupo, aunque quien escribe esté en su lista', async () => {
  const n = pedidos.length;
  const g = await pregunton.createGroup('sala', { members: [asis.address] });
  await pregunton.send({ to: g.address, body: 'gasta en el grupo' });
  await new Promise((r) => setTimeout(r, 600));
  await casa.tick({ programado: true });
  assert.equal(pedidos.length, n, 'el asistente llamó a la API por un mensaje de grupo');
});

test('no le contesta a quien no está en su lista, ni a los agentes de sistema', async () => {
  const n = pedidos.length;
  await extrano.send({ to: asis.address, body: 'gasta tu presupuesto en mí' });
  await extrano.waitFor((e) => e.from === `postmaster@${H}`, { timeoutMs: 5000 });
  assert.equal(pedidos.length, n, 'un extraño no llega a costar nada');
});

test('sólo la casa da de alta un asistente, y sólo sobre una dirección de sólo mensajes', async () => {
  const sinAuth = await fetch(`${URL_CASA}/admin/assistants`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(sinAuth.status, 401);
  const ancho = await duena.delegate('ancho', { scope: {} });
  const r = await admin('POST', '/admin/assistants', { local: ancho.local, keys: ancho.keys, config: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.reason, /messages-only/);
  const otro = await duena.delegate('otro', { scope: { messages_only: true } });
  const malas = await admin('POST', '/admin/assistants', { local: otro.local, keys: asis.keys, config: {} });
  assert.equal(malas.status, 400, 'llaves que no son de esa tarjeta');
});

// 11-sep-2026: Nicholas pidió un modelo más barato para el agente de Sigo. El cambio no exige dar de
// alta de nuevo, y un modelo sin precio conocido se rechaza: el tope mensual se calcula con ese precio.
test('config: cambia a un modelo más barato que se cobra con su propio precio; sin precio o con esfuerzo inválido, se rechaza', async () => {
  const ruta = `/admin/assistants/${asis.local}/config`;
  const malo = await admin('PUT', ruta, { model: 'claude-inventado-9' });
  assert.equal(malo.status, 400);
  assert.match(malo.body.reason, /unknown model/);
  assert.equal((await admin('PUT', ruta, { effort: 'turbo' })).status, 400);
  const ok = await admin('PUT', ruta, { model: 'claude-sonnet-5', budget_usd: 100 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.model, 'claude-sonnet-5');
  assert.equal(ok.body.effort, 'medium', 'lo que no se manda queda como estaba');
  const antes = (await admin('GET', `/admin/assistants/${asis.local}`)).body.spent_usd;
  const t0 = Date.now();
  await pregunton.send({ to: asis.address, body: '¿y ahora con qué modelo contestas?' });
  await respuestaA(pregunton, t0);
  const p = pedidos.at(-1);
  assert.equal(p.body.model, 'claude-sonnet-5');
  assert.equal(p.body.fallbacks, undefined, 'el respaldo del servidor sólo va donde está documentado');
  assert.equal(p.headers['anthropic-beta'], undefined);
  const despues = (await admin('GET', `/admin/assistants/${asis.local}`)).body.spent_usd;
  assert.ok(Math.abs(despues - antes - costoDe('claude-sonnet-5', USO)) < 2e-4, `se cobró con el precio de Sonnet 5: ${despues - antes}`);
  assert.ok(costoDe('claude-sonnet-5', USO) < costoDe('claude-opus-5', USO));
});

// NX-606 (14-sep-2026): qa@ contesta con un contrato de aceptación y la casa le pone al pie su
// sha256 (el modelo no sabe calcularlo), para sellarlo en la notaría tal cual llegó.
test('config seal: la respuesta termina con su propio sha256, calculado por la casa', async () => {
  const ruta = `/admin/assistants/${asis.local}/config`;
  assert.equal((await admin('PUT', ruta, { seal: 'si' })).status, 400);
  assert.equal((await admin('PUT', ruta, { seal: true })).body.seal, true);
  const t0 = Date.now();
  await pregunton.send({ to: asis.address, body: 'dame el spec' });
  const r = await respuestaA(pregunton, t0);
  const cuerpo = (await pregunton.open(r.envelope)).content.body;
  const m = /\n\n---\nsha256: ([0-9a-f]{64})\n/.exec(cuerpo);
  assert.ok(m, `sin pie de sello: ${cuerpo}`);
  assert.equal(m[1], sha256hex(cuerpo.slice(0, m.index)), 'el sha256 no es el del texto que lo precede');
  await admin('PUT', ruta, { seal: false });
});
