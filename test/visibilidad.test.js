// node --test test/
// Visibilidad por agente (13-sep-2026, NX-202): public (en el directorio), private (existe; lo
// encuentra quien sabe la dirección; el defecto) y secret (a quien no está en su lista se le responde
// EXACTAMENTE lo que a un nombre inexistente). Nació de que /resolve contestaba 200 o 404 y con eso
// se enumeraban los nombres de la casa. Lo que estas pruebas cuidan: la respuesta a un extraño es
// byte a byte la de un inexistente (cuerpo y cabeceras), un contacto sí lo ve y le escribe, y entre
// dos casas la casa que pregunta firma para quién pregunta.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { signObject, uuid } from '../src/nucleo/crypto.js';

// Puertos propios de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const PA = 4293, PB = 4294;
const A = 'vis-a.test', B = 'vis-b.test';
const URL_A = `http://127.0.0.1:${PA}`, URL_B = `http://127.0.0.1:${PB}`;
const hosts = { [A]: { url: URL_A }, [B]: { url: URL_B } };
let tmp, casaA, casaB, alicia, carla, dani, publica, bob, eva;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-visibilidad-'));
  const cfg = (domain, port) => ({ domain, port, dataDir: path.join(tmp, domain), adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {}, policy: { registration: 'open', registrations_per_minute: 200, rate_per_minute: 500 } });
  casaA = await new Estafeta(cfg(A, PA)).start();
  casaB = await new Estafeta(cfg(B, PB)).start();
  alicia = Agent.create(`alicia@${A}`, URL_A, { hosts });
  carla = Agent.create(`carla@${A}`, URL_A, { hosts });
  dani = Agent.create(`dani@${A}`, URL_A, { hosts });
  publica = Agent.create(`publica@${A}`, URL_A, { hosts });
  bob = Agent.create(`bob-b@${B}`, URL_B, { hosts });
  eva = Agent.create(`eva-b@${B}`, URL_B, { hosts });
  for (const a of [carla, dani, bob, eva]) await a.register({ adminToken: 't' });
  await publica.register({ adminToken: 't', visibility: 'public' });
  await alicia.register({ adminToken: 't', visibility: 'secret', inbox: { policy: 'allowlist', allowlist: [carla.address, bob.address] }, capabilities: { listed: true, presence: true } });
});
after(async () => { await casaA?.stop(); await casaB?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Respuesta comparable: estado, cuerpo y cabeceras salvo la fecha.
const foto = async (url, init) => { const r = await fetch(url, init); const h = Object.fromEntries([...r.headers].filter(([k]) => k !== 'date')); return { status: r.status, headers: h, body: (await r.text()).replace(/alicia|nadie/g, 'N') }; };

test('un secreto responde a un extraño exactamente lo que un inexistente: cuerpo y cabeceras', async () => {
  for (const ruta of [(n) => `/agents/${n}`, (n) => `/agents/${n}/historial`, (n) => `/agents/${n}/presence`, (n) => `/x402/inbox/${n}`, (n) => `/resolve/${encodeURIComponent(`${n}@${A}`)}`]) {
    const secreto = await foto(`${URL_A}${ruta('alicia')}`);
    const nadie = await foto(`${URL_A}${ruta('nadie')}`);
    // (presence contesta 200 «sin presencia» a los dos; el resto, 404. Lo que importa es que no se distingan.)
    assert.deepEqual(secreto, nadie, `${ruta('alicia')} se distingue de ${ruta('nadie')}`);
  }
  // Autenticado pero fuera de la lista: lo mismo. Y no puede escribirle (ni siquiera resolverla).
  await assert.rejects(() => dani.resolver.agentCard(alicia.address, { onBehalfOf: dani.address }), /404/);
  await assert.rejects(() => dani.send({ to: alicia.address, body: 'hola' }), /could not resolve/);
  // Un sobre firmado que llega igual a la puerta: el rechazo es el de un inexistente.
  const crudo = signObject({ nyx5: '1', id: uuid(), from: dani.address, to: [alicia.address], created: new Date().toISOString(), expires: null, thread: null, in_reply_to: null, type: 'message', content: { media: 'text/plain', body: 'x' } }, dani.keys);
  const r1 = await casaA.inbound(crudo);
  const r2 = await casaA.inbound(signObject({ ...crudo, id: uuid(), to: [`nadie@${A}`], signature: undefined }, dani.keys));
  assert.deepEqual([r1.code, r1.reason], [r2.code, r2.reason]);
  // Tampoco se la puede meter en un grupo, y el error no la distingue de un inexistente.
  await assert.rejects(() => dani.createGroup('cebo', { members: [alicia.address] }), /does not exist or is revoked/);
  // «Nombre tomado» tampoco delata: el 409 es el de un nombre reservado.
  const pedir = (local) => fetch(`${URL_A}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signObject({ local, sig: dani.keys.sig, enc: dani.keys.enc, ts: new Date().toISOString() }, dani.keys)) }).then(async (r) => [r.status, (await r.json()).reason.replace(/alicia|abuse/g, 'N')]);
  assert.deepEqual(await pedir('alicia'), await pedir('abuse'));
});

test('un contacto de su lista la resuelve y le escribe; ella contesta; presencia e historial se le sirven', async () => {
  const card = await carla.resolver.agentCard(alicia.address, { onBehalfOf: carla.address });
  assert.equal(card.visibility, 'secret');
  const m = await carla.send({ to: alicia.address, body: 'hola alicia' });
  const llego = await alicia.waitFor((e) => e.id === m.id, { timeoutMs: 5000 });
  assert.equal((await alicia.open(llego.envelope)).content.body, 'hola alicia');
  const resp = await alicia.send({ to: carla.address, body: 'hola carla', inReplyTo: m.id });
  const vuelta = await carla.waitFor((e) => e.id === resp.id, { timeoutMs: 5000 });
  assert.equal((await carla.open(vuelta.envelope)).content.body, 'hola carla', 'carla verifica la firma de una remitente secreta');
  const auth = (p) => ({ headers: { authorization: carla._auth('GET', p) } });
  assert.equal((await fetch(`${URL_A}/agents/alicia/presence`, auth('/agents/alicia/presence'))).status, 200);
  assert.equal((await fetch(`${URL_A}/agents/alicia/historial`, auth('/agents/alicia/historial'))).status, 200);
  assert.equal((await fetch(`${URL_A}/resolve/${encodeURIComponent(alicia.address)}`, auth(`/resolve/${encodeURIComponent(alicia.address)}`))).status, 200);
});

test('entre casas: la casa que pregunta firma para quién, y la otra sirve el secreto sólo a su contacto', async () => {
  // alicia (secreta en A) le escribe a bob (en B): B verifica la firma pidiéndole a A la tarjeta «para bob».
  const m = await alicia.send({ to: bob.address, body: 'desde el secreto' });
  const llego = await bob.waitFor((e) => e.id === m.id, { timeoutMs: 8000 });
  assert.equal((await bob.open(llego.envelope)).content.body, 'desde el secreto', 'bob abre (su casa resolvió a alicia para él)');
  // bob contesta: su cliente resuelve a alicia por su propia casa, que firma para él.
  const resp = await bob.send({ to: alicia.address, body: 'desde b', inReplyTo: m.id });
  const vuelta = await alicia.waitFor((e) => e.id === resp.id, { timeoutMs: 8000 });
  assert.equal((await alicia.open(vuelta.envelope)).content.body, 'desde b');
  // eva (en B, fuera de la lista) no la resuelve ni por su casa, y su sobre rebota como inexistente.
  await assert.rejects(() => eva.send({ to: alicia.address, body: 'hola' }), /could not resolve/);
  const fromB = await foto(`${URL_A}/agents/alicia`, { headers: { 'x-nyx5-for': casaB._firmarPara(eva.address, A) } });
  assert.equal(fromB.status, 404);
  // Una firma «para bob» hecha para OTRA casa destino no sirve aquí (no se puede reutilizar).
  const ajena = await foto(`${URL_A}/agents/alicia`, { headers: { 'x-nyx5-for': casaB._firmarPara(bob.address, 'otra.test') } });
  assert.equal(ajena.status, 404);
  const buena = await foto(`${URL_A}/agents/alicia`, { headers: { 'x-nyx5-for': casaB._firmarPara(bob.address, A) } });
  assert.equal(buena.status, 200);
});

test('directorio: public figura; secret nunca, ni con listed; private no figura; visibilidad inválida se rechaza', async () => {
  const dir = await fetch(`${URL_A}/agents`).then((r) => r.json());
  const nombres = dir.agents.map((a) => a.address);
  assert.ok(nombres.includes(publica.address));
  assert.ok(!nombres.includes(alicia.address), 'un secreto salió en el directorio');
  assert.ok(!nombres.includes(carla.address));
  await assert.rejects(() => dani.register({ adminToken: 't', visibility: 'invisible' }), /visibility must be one of/);
  // Re-registrar sin decir visibilidad la conserva.
  await alicia.register({ adminToken: 't' });
  assert.equal((await casaA.store.getAgent('alicia')).visibility, 'secret');
});
