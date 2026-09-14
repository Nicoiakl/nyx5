// node --test test/
// NX-905 · hallazgos medios de las revisiones del 13/14-sep:
//   (b) el reloj de la casa (verifica@, escrow que vence) leía la tabla de contratos ENTERA en cada
//       tick: ahora `libroListContracts({ state })` filtra, en FileStore y en D1 (índice de expresión
//       de la migración 0009), y los dos almacenes devuelven lo mismo;
//   (c) el rastreo del índice hacía 1+N subpeticiones por casa ajena: ahora pide historiales en
//       lote por `GET /agents/historial?addresses=a,b,c` (público, tope 50, límite por IP) y cae al
//       de a uno sólo si la casa no tiene la ruta.
// Qué NO cubre: el tope real de subpeticiones del edge (eso se mide en workerd), ni el coste del
// json_extract en D1 de producción (se comprueba que el plan USE el índice en el emulador).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta, HISTORIAL_LOTE_MAX } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { join } from '../src/correo/unirse.js';
import { FileStore } from '../src/nucleo/almacen.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';

// Puertos propios de esta suite (npm test corre en paralelo; lo cuida test/puertos.test.js).
const P1 = 4752, P2 = 4753, P3 = 4754;
const IDX = 'idx-lote.test', LEJOS = 'lejos-lote.test', TASA = 'tasa-lote.test';
const hosts = { [IDX]: { url: `http://127.0.0.1:${P1}` }, [LEJOS]: { url: `http://127.0.0.1:${P2}` }, [TASA]: { url: `http://127.0.0.1:${P3}` } };
let tmp, indice, lejos, tasa;
const cfg = (domain, port, extra = {}) => ({ domain, port, dataDir: path.join(tmp, domain), adminToken: 't', hosts, workerIntervalMs: 5000, log: () => {}, libro: { welcome: 100, feeBps: 0 }, policy: { registration: 'open', registrations_per_minute: 500, rate_per_minute: 500 }, ...extra });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-lote-'));
  indice = await new Estafeta(cfg(IDX, P1, { index: { enabled: true, crawlMinutes: 999 } })).start();
  lejos = await new Estafeta(cfg(LEJOS, P2)).start();
  tasa = await new Estafeta(cfg(TASA, P3, { policy: { registration: 'open', registrations_per_minute: 500, rate_per_minute: 3 } })).start();
});
after(async () => { await indice.stop(); await lejos.stop(); await tasa.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- (b) filtro por estado ----------
const contrato = (id, state, extra = {}) => ({ id, kind: 'escrow', state, amount: 10, seller: 'a@x', buyer: 'b@x', created: '2026-09-14T00:00:00.000Z', history: [], ...extra });

test('libroListContracts({ state }) filtra igual en FileStore y en D1, y sin filtro devuelve todo', { skip: !sqliteAvailable && 'node:sqlite no disponible' }, async () => {
  const fsStore = new FileStore(path.join(tmp, 'filtro'));
  await fsStore.init?.();
  const db = openLocalD1(); db._raw.exec(MIGRACIONES);
  const d1 = new D1Store(db);
  const muestra = [contrato('c1', 'held'), contrato('c2', 'delivered'), contrato('c3', 'released'), contrato('c4', 'refunded'), contrato('c5', 'delivered')];
  for (const c of muestra) { await fsStore.libroPutContract(c); await d1.libroPutContract(c); }
  const ids = (xs) => xs.map((c) => c.id).sort();
  for (const store of [fsStore, d1]) {
    assert.deepEqual(ids(await store.libroListContracts()), ['c1', 'c2', 'c3', 'c4', 'c5'], 'sin filtro: todos');
    assert.deepEqual(ids(await store.libroListContracts({ state: 'delivered' })), ['c2', 'c5']);
    assert.deepEqual(ids(await store.libroListContracts({ state: ['held', 'delivered'] })), ['c1', 'c2', 'c5']);
    assert.deepEqual(ids(await store.libroListContracts({ state: 'settled' })), [], 'un estado sin contratos da lista vacía, no todos');
    assert.deepEqual(ids(await store.libroListContracts({ state: [] })), [], 'lista vacía de estados: nada, no todo');
  }
  // Los dos almacenes dicen lo mismo, contrato por contrato (se restan, no se miran por separado).
  const a = await fsStore.libroListContracts({ state: ['held', 'delivered'] });
  const b = await d1.libroListContracts({ state: ['held', 'delivered'] });
  assert.deepEqual(a.sort((x, y) => x.id.localeCompare(y.id)), b.sort((x, y) => x.id.localeCompare(y.id)));
  // Y en D1 la consulta USA el índice de la migración 0009: si alguien lo quita, esto grita.
  const plan = db._raw.prepare("EXPLAIN QUERY PLAN SELECT doc FROM nyx5_libro_contratos WHERE json_extract(doc, '$.state') IN (?, ?)").all('held', 'delivered');
  assert.ok(plan.some((r) => /nyx5_libro_contratos_estado/.test(r.detail)), `el plan no usa el índice por estado: ${JSON.stringify(plan)}`);
});

test('el reloj de la casa pide sólo los estados que le importan, no la tabla entera', async () => {
  const casa = new Estafeta(cfg('reloj-lote.test', 4755, { verifica: { enabled: true, privados: true } }));
  await casa.init();
  const pedidos = [];
  const original = casa.store.libroListContracts.bind(casa.store);
  casa.store.libroListContracts = async (opts) => { pedidos.push(opts?.state ?? null); return original(opts); };
  await casa._verificarPendientes();
  await casa._liberarVencidos();
  assert.deepEqual(pedidos, [['held', 'delivered'], 'delivered'], 'cada recorrido declara su filtro');
});

// ---------- (c) historial en lote ----------
const lote = (casa, direcciones, init) => fetch(`${hosts[casa].url}/agents/historial?addresses=${encodeURIComponent(direcciones.join(','))}`, init);

test('GET /agents/historial?addresses=… devuelve varios historiales de una vez, con su denominador', async () => {
  const uno = await join({ house: LEJOS, hosts, name: 'uno-lote', listed: true });
  const dos = await join({ house: LEJOS, hosts, name: 'dos-lote', listed: true });
  const r = await lote(LEJOS, ['uno-lote', `dos-lote@${LEJOS}`, 'nadie-lote', `uno-lote@otra-casa.test`]);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.house, LEJOS);
  assert.equal(j.requested, 4);
  assert.equal(j.found, 2);
  assert.equal(j.historiales['uno-lote'].address, uno.address);
  assert.equal(j.historiales[`dos-lote@${LEJOS}`].address, dos.address);
  assert.equal(j.historiales['nadie-lote'], null, 'inexistente: null');
  assert.equal(j.historiales['uno-lote@otra-casa.test'], null, 'de otra casa: null, esta casa no habla por otras');
  // Es el MISMO documento que la ruta individual.
  const individual = await (await fetch(`${hosts[LEJOS].url}/agents/uno-lote/historial`)).json();
  assert.deepEqual(j.historiales['uno-lote'], individual);
  // Tope y forma: más de 50 es 400, vacío es 400. Sin `addresses` no es esta ruta.
  const muchas = Array.from({ length: HISTORIAL_LOTE_MAX + 1 }, (_, i) => `a${i}`);
  const demasiadas = await lote(LEJOS, muchas);
  assert.equal(demasiadas.status, 400);
  assert.match((await demasiadas.json()).reason, /at most 50/);
  assert.equal((await lote(LEJOS, muchas.slice(0, HISTORIAL_LOTE_MAX))).status, 200, 'exactamente 50 pasa');
  assert.equal((await fetch(`${hosts[LEJOS].url}/agents/historial?addresses=`)).status, 400);
  assert.equal((await fetch(`${hosts[LEJOS].url}/agents/historial`)).status, 404, 'sin addresses cae a la tarjeta de un agente que no existe');
  // Un segmento que no se puede decodificar no es un 500 (revisión del 14-sep).
  assert.equal((await fetch(`${hosts[LEJOS].url}/agents/historial?addresses=%E0%A4%A`)).status, 200);
  // «historial» quedó reservado: nadie puede registrar ese nombre y tapar la ruta.
  const usurpador = Agent.create(`historial@${LEJOS}`, hosts[LEJOS].url, { hosts });
  await assert.rejects(usurpador.register({ adminToken: 't' }), /reserved/);
});

test('en el lote, un secreto para quien no lo ve vale lo mismo que un inexistente', async () => {
  const carla = Agent.create(`carla-lote@${LEJOS}`, hosts[LEJOS].url, { hosts });
  await carla.register({ adminToken: 't' });
  const alicia = Agent.create(`alicia-lote@${LEJOS}`, hosts[LEJOS].url, { hosts });
  await alicia.register({ adminToken: 't', visibility: 'secret', inbox: { policy: 'allowlist', allowlist: [carla.address] } });
  const anonimo = await (await lote(LEJOS, ['alicia-lote', 'nadie-lote'])).json();
  assert.equal(anonimo.historiales['alicia-lote'], null);
  assert.deepEqual(anonimo.historiales['alicia-lote'], anonimo.historiales['nadie-lote']);
  assert.equal(anonimo.found, 0);
  // Quien está en su lista sí lo ve.
  const paraCarla = await (await lote(LEJOS, ['alicia-lote'], { headers: { authorization: carla._auth('GET', '/agents/historial') } })).json();
  assert.equal(paraCarla.historiales['alicia-lote']?.address, alicia.address);
});

test('el lote se limita por IP y el 429 dice cuándo volver', async () => {
  await join({ house: TASA, hosts, name: 'alguien-lote' });
  let ultimo;
  for (let i = 0; i < 6; i++) { ultimo = await lote(TASA, ['alguien-lote']); if (ultimo.status === 429) break; }
  assert.equal(ultimo.status, 429, 'con rate_per_minute=3 la cuarta petición ya no pasa');
  assert.ok(Number(ultimo.headers.get('retry-after')) > 0, 'Retry-After presente en el 429');
});

test('el rastreo del índice pide los historiales de una casa ajena en UN lote, y cae al de a uno sólo si la casa no tiene la ruta', async () => {
  const llamadas = [];
  const original = indice.fetch;
  indice.fetch = async (u, o) => { llamadas.push(String(u)); return original(u, o); };
  const r = await fetch(`${hosts[IDX].url}/index/houses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: LEJOS }) });
  assert.equal(r.status, 201);
  const enLote = llamadas.filter((u) => u.includes('/agents/historial?addresses='));
  const deAUno = llamadas.filter((u) => /\/agents\/[^/?]+\/historial$/.test(u));
  assert.equal(enLote.length, 1, `un solo lote para toda la casa: ${llamadas.join('\n')}`);
  assert.equal(deAUno.length, 0, 'ninguna petición por agente');
  const casa = (await indice.store.indexListHouses()).find((h) => h.domain === LEJOS);
  // Denominador: los listados (uno, dos y verifica@ de sistema) se pidieron y ninguno falló.
  assert.equal(casa.reputacion.pedidas, casa.agents);
  assert.equal(casa.reputacion.fallidas, 0);
  assert.equal(casa.reputacion.pedidas, casa.reputacion.con_puntaje + casa.reputacion.sin_historial + casa.reputacion.sin_arbitrados);

  // Una casa de una versión anterior: el lote contesta 404 y se pide de a uno, con el mismo resultado.
  llamadas.length = 0;
  indice.fetch = async (u, o) => {
    llamadas.push(String(u));
    if (String(u).includes('/agents/historial?addresses=')) return new Response(JSON.stringify({ reason: 'no such agent' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return original(u, o);
  };
  await indice._indexCrawlHouse(casa);
  assert.equal(llamadas.filter((u) => u.includes('/agents/historial?addresses=')).length, 1, 'se intentó el lote una vez');
  assert.equal(llamadas.filter((u) => /\/agents\/[^/?]+\/historial$/.test(u)).length, casa.agents, 'y después uno por agente');
  const despues = (await indice.store.indexListHouses()).find((h) => h.domain === LEJOS);
  assert.deepEqual(despues.reputacion, casa.reputacion, 'el mismo denominador por los dos caminos');
  indice.fetch = original;
});
