// node --test test/
// Grupos (13-sep-2026): una dirección g.<nombre>@casa que reparte el mismo sobre firmado a cada
// miembro, cifrado para cada uno, con historial compartido. Nació del pedido de Nicholas de
// conversar de a varios. Lo que estas pruebas cuidan: sólo miembros publican y leen, la casa nunca
// tiene el texto en claro, un miembro nuevo no ve lo anterior, y nadie suplanta un grupo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { TOOLS, MENSAJERIA, llamar } from '../src/puentes/herramientas.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4271;
const H = 'grupos.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
let tmp, casa, ana, beto, carla, dani, erika;
const buscarTexto = (dir, texto) => { let hay = false; for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, String(f)); if (fs.statSync(p).isFile() && fs.readFileSync(p, 'utf8').includes(texto)) hay = true; } return hay; };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-grupos-'));
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 100, feeBps: 0 }, log: () => {} }).start();
  [ana, beto, carla, dani, erika] = ['ana-l', 'beto', 'carla', 'dani', 'erika'].map((n) => Agent.create(`${n}@${H}`, URL_CASA, { hosts }));
  for (const a of [ana, beto, carla, dani, erika]) await a.register({ adminToken: 't' });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('grupo: se crea, sólo los miembros publican y reciben, cifrado para cada uno, y la casa no tiene el texto', async () => {
  const g = await ana.createGroup('equipo', { members: [beto.address, carla.address] });
  assert.equal(g.address, `g.equipo@${H}`);
  assert.deepEqual(g.group.admins, [ana.address]);
  assert.deepEqual(g.group.members, [ana.address, beto.address, carla.address]);
  // Un grupo no cobra bienvenida: no es un agente.
  assert.equal(await casa.libro.balance(g.address), 0);
  const r = await ana.send({ to: g.address, body: 'texto secreto del equipo' });
  assert.equal(r.encrypted, true, 'se cifra para cada miembro');
  for (const m of [beto, carla]) {
    const e = await m.waitFor((x) => x.from === ana.address, { timeoutMs: 5000 });
    assert.deepEqual(e.envelope.to, [g.address]);
    assert.equal((await m.open(e.envelope)).content.body, 'texto secreto del equipo');
  }
  // El remitente no recibe su propia copia: la tiene en su salida, y la conversación la muestra.
  assert.equal((await ana.inbox()).filter((x) => x.envelope.from === ana.address).length, 0);
  const conv = await beto.conversation(g.address);
  assert.equal(conv.length, 1); assert.equal(conv[0].dir, 'in');
  assert.ok((await ana.conversation(g.address)).some((x) => x.dir === 'out'), 'la que escribió lo ve como enviado al grupo');
  assert.ok((await beto.conversations()).some((c) => c.with === g.address), 'el grupo aparece como una conversación');
  // La casa guarda sobres, no texto: en todo su disco no está la frase.
  assert.equal(buscarTexto(path.join(tmp, H), 'texto secreto'), false, 'la casa tiene el texto en claro');
  // Quien no es miembro no publica ni ve quién está.
  const fuera = await dani.send({ to: g.address, body: 'me cuelo' });
  const rebote = await dani.waitFor((x) => x.from === `postmaster@${H}` && x.in_reply_to === fuera.id, { timeoutMs: 6000 });
  assert.match((await dani.open(rebote.envelope)).content.body.reason || JSON.stringify((await dani.open(rebote.envelope)).content.body), /allowlist|members/);
  await assert.rejects(() => dani.group(g.address), /only members/);
  // Un intro (que la lista blanca deja pasar a un buzón normal) tampoco abre un grupo.
  const intro = await dani.send({ to: g.address, body: 'hola', type: 'intro', encrypt: false });
  await dani.waitFor((x) => x.from === `postmaster@${H}` && x.in_reply_to === intro.id, { timeoutMs: 6000 });
  assert.equal((await beto.inbox()).filter((x) => x.envelope.from === dani.address).length, 0, 'un intro entró al grupo');
});

test('grupo: los admins cambian miembros, un miembro sólo se va, el nuevo no ve lo anterior, y el último admin no se va', async () => {
  const g = `g.equipo@${H}`;
  await assert.rejects(() => beto.editGroup(g, { add: [erika.address] }), /only an admin/);
  await assert.rejects(() => beto.editGroup(g, { remove: [carla.address] }), /only an admin/);
  const r = await ana.editGroup(g, { add: [erika.address] });
  assert.ok(r.group.members.includes(erika.address));
  await ana.send({ to: g, body: 'segundo mensaje' });
  const e = await erika.waitFor((x) => x.from === ana.address, { timeoutMs: 5000 });
  assert.equal((await erika.open(e.envelope)).content.body, 'segundo mensaje');
  assert.equal((await erika.conversation(g)).length, 1, 'erika no ve lo anterior a su entrada');
  // carla se va sola y deja de recibir.
  await carla.leaveGroup(g);
  await ana.send({ to: g, body: 'tercero' });
  await beto.waitFor((x) => x.from === ana.address && x.id !== e.envelope.id, { timeoutMs: 5000 });
  assert.equal((await carla.inbox()).filter((x) => x.envelope.from === ana.address).length, 2, 'carla siguió recibiendo tras irse');
  await assert.rejects(() => ana.leaveGroup(g), /at least one admin/);
  await ana.editGroup(g, { admins: [beto.address] });
  await ana.leaveGroup(g);
  assert.deepEqual((await beto.group(g)).group.admins, [beto.address]);
});

// Revisión adversarial del 13-sep-2026, dos críticos probados: el reparto no consultaba la política
// de cada miembro, así que cualquiera metía a cualquiera en un grupo y le saltaba la lista blanca
// (incluso al asistente de Sigo, gastándole presupuesto). Consentimiento en dos capas.
test('grupo: sólo entra quien ya te acepta, y cada miembro recibe sólo de quien su buzón acepta', async () => {
  const cerrada = Agent.create(`cerrada@${H}`, URL_CASA, { hosts });
  await cerrada.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [ana.address] } });
  const cobra = Agent.create(`cobra@${H}`, URL_CASA, { hosts });
  await cobra.register({ adminToken: 't', inbox: { policy: 'stamp', price: 5 } });
  // beto no está en la lista de cerrada: no puede meterla en un grupo. ana sí.
  await assert.rejects(() => beto.createGroup('trampa', { members: [cerrada.address] }), /does not accept messages from you/);
  await assert.rejects(() => ana.createGroup('pagado', { members: [cobra.address] }), /does not accept/);
  const g = await ana.createGroup('consentido', { members: [cerrada.address, beto.address] });
  // beto es miembro, pero cerrada no lo acepta: su mensaje llega a ana, no a cerrada. El de ana sí.
  await beto.send({ to: g.address, body: 'de beto' });
  await ana.waitFor((x) => x.from === beto.address, { timeoutMs: 5000 });
  await ana.send({ to: g.address, body: 'de ana' });
  const llego = await cerrada.waitFor((x) => x.from === ana.address, { timeoutMs: 5000 });
  assert.equal((await cerrada.open(llego.envelope)).content.body, 'de ana');
  assert.equal((await cerrada.inbox()).filter((x) => x.envelope.from === beto.address).length, 0, 'el grupo fue puerta trasera a la lista blanca de cerrada');
  // Un admin tampoco puede agregar después a quien no lo acepta; y quien ya está no se re-verifica.
  await assert.rejects(() => ana.editGroup(g.address, { add: [cobra.address] }), /does not accept/);
  await ana.editGroup(g.address, { add: [carla.address] });
});

test('grupo: límites — nombres g.* reservados, miembros de otra casa y direcciones inexistentes se rechazan', async () => {
  await assert.rejects(() => Agent.create(`g.pirata@${H}`, URL_CASA, { hosts }).register({ adminToken: 't' }), /groups: create one/);
  await assert.rejects(() => ana.createGroup('x', {}), /3 to 41/);
  await assert.rejects(() => ana.createGroup('equipo', {}), /already exists/);
  await assert.rejects(() => ana.createGroup('mixto', { members: ['alguien@otra.casa'] }), /not in this house/);
  await assert.rejects(() => ana.createGroup('fantasma', { members: [`nadie@${H}`] }), /does not exist/);
  await assert.rejects(() => ana.createGroup('anidado', { members: [`g.equipo@${H}`] }), /cannot be a member/);
});

test('grupo: la herramienta nyx5_group existe, es de mensajería, y crea y lista por el puente', async () => {
  const t = TOOLS.find((x) => x.name === 'nyx5_group');
  assert.ok(t && MENSAJERIA.has('nyx5_group'), 'el conector remoto la ofrece');
  const creado = JSON.parse((await llamar(dani, 'nyx5_group', { op: 'create', name: 'sala', members: [erika.address] })).content[0].text);
  assert.equal(creado.address, `g.sala@${H}`);
  const lista = JSON.parse((await llamar(erika, 'nyx5_group', { op: 'members', group: 'sala' })).content[0].text);
  assert.deepEqual(lista.group.members, [dani.address, erika.address]);
  const salida = JSON.parse((await llamar(erika, 'nyx5_group', { op: 'leave', group: `g.sala@${H}` })).content[0].text);
  assert.deepEqual(salida.group.members, [dani.address]);
});
