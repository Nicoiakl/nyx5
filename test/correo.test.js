// node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { generateKeys, signObject, uuid, canonical, encryptContent, decryptContent, mintPow, checkPow } from '../src/nucleo/crypto.js';
import { parseTxtRecord, parseAddress } from '../src/correo/resolver.js';

const P1 = 4101, P2 = 4102;
const hosts = { 'alfa.test': { url: `http://127.0.0.1:${P1}` }, 'beta.test': { url: `http://127.0.0.1:${P2}` } };
let tmp, alfa, beta, nicolas, asistente;
const mk = (domain, port, token) => new Estafeta({ domain, port, dataDir: path.join(tmp, domain), adminToken: token, hosts, workerIntervalMs: 150, retry: { baseMs: 150, maxMs: 600 }, log: () => {} });
const env = (from, to, keys, extra = {}) => signObject({ nyx5: '1', id: uuid(), from, to: [to], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'x' }, ...extra }, keys);
const inbound = async (port, e) => { const r = await fetch(`http://127.0.0.1:${port}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) }); return { status: r.status, ...(await r.json()) }; };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-test-'));
  alfa = await mk('alfa.test', P1, 'a').start();
  beta = await mk('beta.test', P2, 'b').start();
  nicolas = Agent.create('nicolas@alfa.test', hosts['alfa.test'].url, { hosts });
  asistente = Agent.create('asistente@beta.test', hosts['beta.test'].url, { hosts });
  await nicolas.register({ adminToken: 'a' });
  await asistente.register({ adminToken: 'b' });
});
after(async () => { await alfa.stop(); await beta.stop(); });

test('primitivas: canónico, cifrado, pow', async () => {
  assert.equal(canonical({ b: 1, a: [2, { d: null, c: 'x' }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  const k = generateKeys();
  // Cifrar y descifrar son asíncronos: el acuerdo de claves va por WebCrypto (workerd no tiene diffieHellman).
  const enc = await encryptContent({ media: 'text/plain', body: 'secreto' }, [{ address: 'x@y', enc: k.enc }], 'aad');
  assert.deepEqual(await decryptContent(enc, 'x@y', k, 'aad'), { media: 'text/plain', body: 'secreto' });
  await assert.rejects(() => decryptContent(enc, 'x@y', k, 'otro-aad'));
  const pow = mintPow('id-1', 8);
  assert.ok(checkPow('id-1', pow, 8)); assert.ok(!checkPow('id-2', pow, 8));
  assert.deepEqual(parseTxtRecord('v=nyx51; url=https://mail.sigo.uk; sig=abc'), { v: 'nyx51', url: 'https://mail.sigo.uk', sig: 'abc' });
  assert.deepEqual(parseAddress('Nicolas@Sigo.UK'), { local: 'nicolas', domain: 'sigo.uk' });
  assert.throws(() => parseAddress('sin-arroba'));
});

test('tarjetas: dominio autofirmado y agente certificado por el dominio', async () => {
  const dc = await nicolas.resolver.domainCard('beta.test');
  assert.equal(dc.domain, 'beta.test'); assert.equal(dc._source, 'override');
  const ac = await nicolas.resolver.agentCard('asistente@beta.test');
  assert.equal(ac.certification.kid, beta.keys.sig); assert.equal(ac.sig, asistente.keys.sig);
});

test('flujo end-to-end: tarea cifrada, respuesta en el mismo hilo, ack', async () => {
  const sent = await nicolas.send({ to: 'asistente@beta.test', type: 'task', body: { q: 1 } });
  assert.ok(sent.envelope.encrypted && !sent.envelope.content);
  const m = await asistente.waitFor((e) => e.id === sent.id);
  assert.equal(m.from_verified, true); assert.equal(m.relay_verified, true);
  const opened = await asistente.open(m.envelope);
  assert.deepEqual(opened.content.body, { q: 1 });
  await asistente.ack(opened.id);
  assert.equal((await asistente.inbox()).some((x) => x.envelope.id === sent.id), false);
  const rep = await asistente.reply(m.envelope, { ok: true });
  const r = await nicolas.waitFor((e) => e.id === rep.id);
  assert.equal(r.envelope.thread, sent.id); assert.equal(r.envelope.in_reply_to, sent.id);
  assert.deepEqual((await nicolas.open(r.envelope)).content.body, { ok: true });
  await nicolas.ack(rep.id);
  assert.equal((await nicolas.outbox()).find((s) => s.id === sent.id).status, 'delivered');
});

test('capa de confianza: firma falsa, remitente inexistente, sin firma', async () => {
  const falsas = generateKeys();
  assert.equal((await inbound(P2, env('nicolas@alfa.test', 'asistente@beta.test', falsas))).status, 403);
  assert.equal((await inbound(P2, env('nadie@alfa.test', 'asistente@beta.test', falsas))).status, 403);
  const { signature, ...sinFirma } = env('nicolas@alfa.test', 'asistente@beta.test', nicolas.keys);
  assert.equal((await inbound(P2, sinFirma)).status, 400);
  assert.equal((await inbound(P2, env('nicolas@alfa.test', 'nadie@beta.test', nicolas.keys))).status, 404);
});

test('políticas: allowlist acepta solo intro; pow exige estampilla', async () => {
  const selecto = Agent.create('selecto@beta.test', hosts['beta.test'].url, { hosts });
  await selecto.register({ adminToken: 'b', inbox: { policy: 'allowlist', allowlist: ['socio@gamma.test'] } });
  assert.equal((await inbound(P2, env('nicolas@alfa.test', 'selecto@beta.test', nicolas.keys))).status, 403);
  assert.equal((await inbound(P2, env('nicolas@alfa.test', 'selecto@beta.test', nicolas.keys, { type: 'intro' }))).status, 202);
  const caro = Agent.create('caro@beta.test', hosts['beta.test'].url, { hosts });
  await caro.register({ adminToken: 'b', inbox: { policy: 'pow', pow_bits: 10 } });
  assert.equal((await inbound(P2, env('nicolas@alfa.test', 'caro@beta.test', nicolas.keys))).status, 402);
  const s = await nicolas.send({ to: 'caro@beta.test', body: 'con pow' });
  assert.equal(s.envelope.pow.bits, 10);
  await caro.waitFor((e) => e.id === s.id);
});

test('idempotencia: la misma entrega dos veces produce una sola copia', async () => {
  const s = await nicolas.send({ to: 'asistente@beta.test', body: 'una' });
  await asistente.waitFor((e) => e.id === s.id);
  const again = await inbound(P2, s.envelope);
  assert.equal(again.duplicate, true);
  assert.equal((await asistente.inbox()).filter((m) => m.envelope.id === s.id).length, 1);
  await asistente.ack(s.id);
});

test('store-and-forward: destino apagado, reintento, entrega y rebote por remitente rechazado', async () => {
  await beta.stop();
  const s = await nicolas.send({ to: 'asistente@beta.test', body: 'mientras estabas apagado' });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await alfa.store.listQueue()).length, 1);
  assert.equal((await nicolas.outbox()).find((x) => x.id === s.id).status, 'retrying');
  beta = await mk('beta.test', P2, 'b').start();
  const m = await asistente.waitFor((e) => e.id === s.id, { timeoutMs: 8000 });
  assert.equal((await asistente.open(m.envelope)).content.body, 'mientras estabas apagado');
  assert.equal((await alfa.store.listQueue()).length, 0);
  await asistente.ack(s.id);
  // rebote: destinatario inexistente -> receipt failed del postmaster en el buzón del remitente
  const bad = await nicolas.send({ to: 'asistente@beta.test', body: 'x' });
  await asistente.waitFor((e) => e.id === bad.id); await asistente.ack(bad.id);
  const s2 = signObject({ ...bad.envelope, id: uuid(), to: ['inexistente@beta.test'] }, nicolas.keys);
  const r = await fetch(`http://127.0.0.1:${P1}/outbound`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: nicolas._auth('POST', '/outbound') }, body: JSON.stringify(s2) });
  assert.equal(r.status, 202);
  const bounce = await nicolas.waitFor((e) => e.type === 'receipt' && e.in_reply_to === s2.id, { timeoutMs: 5000 });
  const opened = await nicolas.open(bounce.envelope);
  assert.equal(opened.content.body.status, 'failed'); assert.match(opened.content.body.reason, /404/);
  assert.equal(opened.content.body.sha256.length, 64, 'el rebote lleva el hash del sobre original');
});

test('rotación de claves: la clave anterior sigue válida en el período de gracia', async () => {
  const oldSig = nicolas.keys.sig;
  await nicolas.rotateKeys({ adminToken: 'a' });
  const s = await nicolas.send({ to: 'asistente@beta.test', body: 'con clave nueva' });
  const m = await asistente.waitFor((e) => e.id === s.id); // la estafeta refresca la tarjeta sola
  assert.equal((await asistente.open(m.envelope)).content.body, 'con clave nueva');
  await asistente.ack(s.id);
  const card = await asistente.resolver.agentCard('nicolas@alfa.test');
  assert.notEqual(card.sig, oldSig); assert.equal(card.previous[0].sig, oldSig);
});

test('auth de agente: token de otro agente o path distinto son rechazados', async () => {
  const r1 = await fetch(`http://127.0.0.1:${P1}/mailbox/nicolas`, { headers: { authorization: asistente._auth('GET', '/mailbox/nicolas') } });
  assert.equal(r1.status, 401);
  const r2 = await fetch(`http://127.0.0.1:${P1}/mailbox/nicolas`, { headers: { authorization: nicolas._auth('GET', '/outbox/nicolas') } });
  assert.equal(r2.status, 401);
});

// Un sobre sin nada dentro no es un mensaje (4-nov-2026). El caso es REAL: una llamada al puente
// publicado con `text` en vez de `body` dejó `content = { media, body: undefined }`, la clave
// desapareció al serializar, la casa lo aceptó y a nicholas@nyx5.com le llegó el sobre
// 4c8811dd-2715-41e8-8aee-d78e7f30c1c2, que no se puede abrir. El remitente leyó `id` y
// `encrypted: true`: un éxito reportado sobre nada. El guardia va en `Agent.send`, la FUENTE,
// porque el del puente sólo cubre a su consumidor; se prueba sin red, porque rechaza antes de
// tocar nada (si algún día deja de hacerlo, este test se cuelga y eso también es la señal).
test('GRITO · send sin cuerpo se niega, y se niega ANTES de tocar la red', async () => {
  const { Agent } = await import('../src/correo/agente.js');
  const intocable = new Proxy({}, { get: (_, k) => { throw new Error(`send tocó this.${String(k)} antes de validar`); } });
  for (const args of [
    { to: 'alguien@casa', text: 'me equivoqué de nombre' },   // la llamada que de verdad pasó
    { to: 'alguien@casa' },
    { to: 'alguien@casa', body: null },
    { to: 'alguien@casa', body: undefined, attachments: [] },
  ]) {
    await assert.rejects(() => Agent.prototype.send.call(intocable, args),
      /body is required.*Nothing was sent/s, `salió un sobre vacío con ${JSON.stringify(args)}`);
  }
});

test('SILENCIO · un cuerpo falsy es contenido, y los adjuntos solos son un mensaje', async () => {
  const { Agent } = await import('../src/correo/agente.js');
  // Pasado el guardia tiene que seguir: lo delata que el error ya NO sea el del cuerpo.
  const intocable = new Proxy({}, { get: (_, k) => { throw new Error(`SIGUIO:${String(k)}`); } });
  for (const args of [
    { to: 'alguien@casa', body: 0 },
    { to: 'alguien@casa', body: false },
    { to: 'alguien@casa', body: '' },
    { to: 'alguien@casa', attachments: [{ blob: 'abc', bytes: 1 }] },
  ]) {
    await assert.rejects(() => Agent.prototype.send.call(intocable, args),
      /^Error: SIGUIO:/, `el guardia retuvo algo bueno: ${JSON.stringify(args)}`);
  }
});
