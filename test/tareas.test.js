// node --test test/
// Trabajo sembrado: la casa es el primer comprador. Lo que se prueba es el criterio de
// "publicado" del sprint — un agente recién unido toma una tarea, entrega, y el asiento se
// libera sin que un humano toque nada — y que las defensas contra Sybil no son decorativas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { Tareas, normalizarTarea } from '../src/libro/tareas.js';
import { MEDIA } from '../src/libro/libro.js';

const P = 4181;
const hosts = { 't.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa, mundo, mundoPort, estado = 200;

const catalogo = () => [
  { id: 'ping', concept: 'comprobar que el faro responde', price: 50, verify: { type: 'http_status', url: `https://127.0.0.1:${mundoPort}/faro` }, instructions: 'entrega cuando lo hayas comprobado' },
  { id: 'otra', concept: 'segunda tarea', price: 30, verify: { type: 'http_status', url: `https://127.0.0.1:${mundoPort}/faro` } },
];

// El verificador apunta a https en el catálogo; el mundo de prueba es http local.
const parchearFetch = () => { casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o); };

// Un agente toma una tarea: cotiza al mostrador con los términos publicados, tal cual.
async function tomar(agente, tarea, extra = {}) {
  const pub = await (await fetch(`http://127.0.0.1:${P}/tareas`)).json();
  const t = pub.tasks.find((x) => x.id === tarea);
  return agente.quote({
    to: pub.desk, contract: 'escrow', price: extra.price ?? t.price, concept: t.concept,
    arbiter: extra.arbiter === null ? undefined : (extra.arbiter || pub.arbiter),
    terms: extra.terms || t.terms,
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-tareas-'));
  mundo = http.createServer((q, r) => { r.writeHead(estado); r.end('faro'); });
  await new Promise((r) => mundo.listen(0, '127.0.0.1', r));
  mundoPort = mundo.address().port;
  casa = new Estafeta({
    domain: 't.test', port: P, dataDir: path.join(tmp, 't.test'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 100, feeBps: 1000 }, tareas: { catalogo: catalogo(), porAgenteDia: 1, porDia: 50 }, verifica: { enabled: true, privados: true }, log: () => {},
  });
  await casa.start();
  // La casa necesita fondos para comprar: en producción los emite ella misma.
  await casa.libro.topup(`tareas@t.test`, 5000, 'presupuesto de trabajo sembrado');
});
after(async () => { await casa.stop(); await new Promise((r) => mundo.close(r)); });

test('una tarea sin prueba de aceptación no se puede publicar', () => {
  assert.throws(() => normalizarTarea({ id: 'x', concept: 'algo', price: 10 }), /sin prueba no se paga/);
  assert.throws(() => normalizarTarea({ id: 'x', concept: 'algo', price: 0, verify: { type: 'http_status' } }), /precio entero positivo/);
  assert.throws(() => normalizarTarea({ concept: 'algo' }), /necesita id y concept/);
});

test('el catálogo es público y publica la prueba entera, no solo el precio', async () => {
  const res = await fetch(`http://127.0.0.1:${P}/tareas`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.desk, 'tareas@t.test');
  assert.equal(j.arbiter, 'verifica@t.test');
  const ping = j.tasks.find((t) => t.id === 'ping');
  assert.equal(ping.price, 50);
  assert.equal(ping.verify[0].type, 'http_status', 'quien va a trabajar puede leer con qué se le va a comprobar');
  assert.equal(ping.terms.seed_task, 'ping');
});

test('criterio de publicado: se une, toma, entrega y cobra sin que un humano toque nada', async () => {
  const a = await join({ house: 't.test', hosts, name: 'recien' });
  estado = 200;
  const saldoInicial = (await a._agente.balance()).balance;

  await tomar(a._agente, 'ping');
  // El recibo del Libro responde al sobre con que la CASA aceptó, no a la cotización del agente.
  const recibo = await a._agente.waitFor((e) => e.from === 'libro@t.test', { timeoutMs: 5000 });
  const contrato = (await a._agente.open(recibo.envelope)).content.body.contract;
  assert.equal(contrato.kind, 'escrow');
  assert.equal(contrato.seller, a.address, 'el vendedor es el agente, con su propia llave');
  assert.equal(contrato.buyer, 'tareas@t.test', 'la casa es la compradora');
  assert.equal(contrato.state, 'held', 'los tokens quedan retenidos antes de que trabaje');

  // Entrega y el cron verifica. Nadie aprueba a mano.
  const entrega = await a._agente.deliver('t.test', contrato.id, { note: 'comprobado' });
  await a._agente.awaitReceipt(entrega.id);
  parchearFetch();
  await casa.tick();
  await a._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@t.test' && e.id !== recibo.envelope.id, { timeoutMs: 5000 });

  const fin = await a._agente.contract('t.test', contrato.id);
  assert.equal(fin.state, 'released');
  assert.equal(fin.acp.phase, 'Terminal');
  assert.equal((await a._agente.balance()).balance, saldoInicial + 45, '50 menos el 10% de la casa');
  // Y lo que importa: ahora tiene historial que otro puede leer.
  const h = await a._agente.historial();
  assert.equal(h.resumen.entregas, 1);
  assert.equal(h.resumen.cumplimiento, 1);
  assert.equal((await casa.store.listEvents({ name: 'seed_task_taken' })).at(-1).data.task, 'ping');
});

test('si la prueba falla, la casa recupera su presupuesto y el intento queda en el historial', async () => {
  const a = await join({ house: 't.test', hosts, name: 'apurado' });
  estado = 500;
  const antes = (await a._agente.balance()).balance;
  await tomar(a._agente, 'ping');
  const recibo = await a._agente.waitFor((e) => e.from === 'libro@t.test', { timeoutMs: 5000 });
  const contrato = (await a._agente.open(recibo.envelope)).content.body.contract;
  const entrega = await a._agente.deliver('t.test', contrato.id, { note: 'listo (mentira)' });
  await a._agente.awaitReceipt(entrega.id);
  parchearFetch();
  await casa.tick();
  await a._agente.waitFor((e) => e.thread === contrato.id && e.id !== recibo.envelope.id, { timeoutMs: 5000 });

  assert.equal((await a._agente.contract('t.test', contrato.id)).state, 'refunded');
  assert.equal((await a._agente.balance()).balance, antes, 'no cobró un token por afirmar');
  assert.equal((await a._agente.historial()).resumen.entregas_falladas, 1);
  estado = 200;
});

test('Sybil: tope por agente y día, una a la vez, y cada tarea se paga una vez', async () => {
  const t = new Tareas({ catalogo: catalogo(), porAgenteDia: 1, porDia: 3 });
  const tarea = t.tarea('ping');
  const hoy = new Date().toISOString().slice(0, 10);
  const c = (extra) => ({ created: `${hoy}T10:00:00.000Z`, terms: { seed_task: 'ping' }, seller: 'x@t.test', state: 'released', ...extra });

  assert.equal(t.cupo(tarea, 'x@t.test', []).ok, true);
  assert.match(t.cupo(tarea, 'x@t.test', [c({})]).reason, /per-agent cap is 1/);
  // Con una en curso, el mensaje accionable gana: "termínala" antes que "vuelve mañana".
  assert.match(t.cupo(tarea, 'x@t.test', [c({ state: 'held' })]).reason, /in flight/);
  assert.match(t.cupo(tarea, 'y@t.test', [c({ seller: 'a@t.test' }), c({ seller: 'b@t.test' }), c({ seller: 'c@t.test' })]).reason, /already seeded 3 tasks today/);
  // Lo de ayer no consume el cupo de hoy (con OTRA tarea: la misma ya estaría pagada).
  assert.equal(t.cupo(tarea, 'x@t.test', [c({ created: '2020-01-01T00:00:00.000Z', terms: { seed_task: 'otra' } })]).ok, true);
  // Y cada tarea se paga UNA vez por agente, aunque el cupo diario sobre y cambie el día.
  const holgado = new Tareas({ catalogo: catalogo(), porAgenteDia: 5, porDia: 0 });
  assert.match(holgado.cupo(tarea, 'x@t.test', [c({ created: '2020-01-01T00:00:00.000Z' })]).reason, /already got paid for task ping/);
});

test('el tope diario se aplica de verdad en la casa, no solo en la clase', async () => {
  const a = await join({ house: 't.test', hosts, name: 'insistente' });
  await tomar(a._agente, 'ping');
  await a._agente.waitFor((e) => e.from === 'libro@t.test', { timeoutMs: 5000 });
  // Segunda tarea el mismo día: el mostrador la rechaza y dice por qué.
  const segunda = await tomar(a._agente, 'otra');
  const rebote = await a._agente.waitFor((e) => e.in_reply_to === segunda.id && e.from.startsWith('postmaster@'), { timeoutMs: 5000 });
  const cuerpo = (await a._agente.open(rebote.envelope)).content.body;
  assert.equal(cuerpo.status, 'failed');
  assert.match(cuerpo.reason, /in flight|per-agent cap/);
});

test('no se negocia: precio inflado, prueba cambiada o árbitro ajeno se rechazan', async () => {
  const a = await join({ house: 't.test', hosts, name: 'vivo' });
  const casos = [
    [{ price: 5000 }, /the price of ping is 50/],
    [{ terms: { seed_task: 'ping', verify: [{ type: 'http_status', url: 'https://siempre-ok.invalid/' }] } }, /not the one published/],
    [{ arbiter: a.address }, /the arbiter of a seeded task is verifica@t\.test/],
    // Sin seed_task no hay a qué tarea referirse: la casa lo dice y apunta al catálogo.
    [{ terms: { acceptance: 'algo' } }, /no seeded task with id undefined/],
  ];
  for (const [extra, esperado] of casos) {
    const enviada = await tomar(a._agente, 'ping', extra);
    const rebote = await a._agente.waitFor((e) => e.in_reply_to === enviada.id && e.from.startsWith('postmaster@'), { timeoutMs: 5000 });
    const cuerpo = (await a._agente.open(rebote.envelope)).content.body;
    assert.match(cuerpo.reason, esperado);
  }
  // Y el saldo de la casa sigue intacto: ningún intento movió tokens.
  assert.equal((await a._agente.historial()).total_movido, 0);
});

test('tareas@ es de sistema y solo acepta cotizaciones, no cualquier sobre', async () => {
  const a = await join({ house: 't.test', hosts, name: 'curioso' });
  const suelto = await a._agente.send({ to: 'tareas@t.test', type: 'message', body: 'hola, quiero trabajar', encrypt: false });
  const rebote = await a._agente.waitFor((e) => e.in_reply_to === suelto.id && e.from.startsWith('postmaster@'), { timeoutMs: 5000 });
  assert.match((await a._agente.open(rebote.envelope)).content.body.reason, new RegExp(MEDIA.cotizacion.replace(/[.+]/g, '\\$&')));
  const usurpador = await fetch(`http://127.0.0.1:${P}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ local: 'tareas', sig: 'x' }) });
  assert.equal(usurpador.status, 409);
});

// El catálogo que la casa real publica. Guard nacido de un fallo que sería SILENCIOSO: si
// alguien edita el texto de una tarea y no su hash, la tarea queda imposible de cumplir, ningún
// agente cobra nunca, y nada en el sistema grita. Aquí el hash se recalcula desde el literal.
test('el catálogo sembrado de nyx5.com es válido y sus hashes corresponden a su enunciado', async () => {
  const { NYX5_TAREAS } = await import('../src/plataformas/worker.js');
  const { sha256hex } = await import('../src/nucleo/crypto.js');
  const t = new Tareas(NYX5_TAREAS);
  assert.ok(t.enabled && t.catalogo.length >= 2);

  // Una sola fuente: cada tarea de hash declara su literal, y de ahí salen enunciado y hash.
  // Si alguien cambia uno sin el otro, esto falla: no hay dónde desincronizarse en silencio.
  const deHash = t.catalogo.filter((x) => x.verify[0].type === 'sha256');
  assert.ok(deHash.length >= 2, 'se esperaban tareas de hash en el catálogo');
  for (const tarea of deHash) {
    assert.ok(tarea.literal, `la tarea ${tarea.id} no declara el literal a hashear`);
    assert.equal(tarea.verify[0].expect, sha256hex(tarea.literal), `el hash de "${tarea.id}" no corresponde a ${JSON.stringify(tarea.literal)}: nadie podría cobrarla`);
    assert.ok(tarea.concept.includes(tarea.literal), `el enunciado de "${tarea.id}" no dice qué texto hashear`);
    assert.ok(tarea.instructions.includes(JSON.stringify(tarea.literal)), `las instrucciones de "${tarea.id}" no muestran el literal exacto`);
  }

  // Ninguna tarea sembrada puede pagar sin prueba, y ninguna prueba puede necesitar shell
  // (la casa real corre en el edge, donde exit_0 no existe).
  const { pruebasDisponibles } = await import('../src/libro/verifica.js');
  for (const tarea of t.catalogo) {
    assert.ok(tarea.verify.length, `${tarea.id} sin prueba`);
    for (const v of tarea.verify) assert.ok(v.type !== 'exit_0', `${tarea.id} usa exit_0, que el edge no puede correr`);
    if (tarea.verify[0].type === 'http_status') assert.match(tarea.verify[0].url, /^https:\/\//);
  }
  assert.ok(!pruebasDisponibles().includes('x'));
});

// Guard nacido de un defecto real en producción: las dos casas comparten worker.js, así que
// la beta empezó a publicar el catálogo de la principal sin tener un peso para pagarlo. Un
// mostrador con tareas que nadie puede cobrar es peor que ninguno: promete y no cumple.
test('una casa solo publica trabajo si lo tiene encendido, y la beta no lo enciende', async () => {
  const fs = await import('node:fs');
  const principal = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const beta = fs.readFileSync(new URL('../wrangler.beta.toml', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../src/plataformas/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /cfg\('SEED'\) === 'on' \? NYX5_TAREAS : \{\}/, 'el catálogo debe encenderse por casa, no venir siempre');
  assert.match(principal, /NYX5_SEED = "on"/, 'la casa principal siembra trabajo');
  assert.ok(!/NYX5_SEED/.test(beta), 'la beta NO debe sembrar: no tiene presupuesto para pagarlo');
});

test('una casa sin catálogo no expone el mostrador', async () => {
  const P2 = 4182;
  const seca = new Estafeta({
    domain: 'seca.test', port: P2, dataDir: path.join(tmp, 'seca.test'), adminToken: 't',
    hosts: { 'seca.test': { url: `http://127.0.0.1:${P2}` } }, workerIntervalMs: 100,
    policy: { registration: 'open' }, log: () => {},
  });
  await seca.start();
  try {
    const res = await fetch(`http://127.0.0.1:${P2}/tareas`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).reason, /does not seed work/);
    assert.equal(await seca.agentCard('tareas'), null, 'sin catálogo no se levanta tareas@');
  } finally { await seca.stop(); }
});
