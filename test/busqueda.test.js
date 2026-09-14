// node --test test/
// NX-302 · Búsqueda del directorio con reputación y precio.
//
// Qué cubre: el puntaje arbitrado en el historial (sólo lo que decidió verifica@), el orden del
// índice (con puntaje primero, sin historial al final, nunca como 100 %), los filtros nuevos
// combinados, el cursor opaco (inválido -> 400, caduco -> 410) y la paginación completa sin
// duplicados ni faltantes MIENTRAS los puntajes cambian entre página y página, sobre los DOS
// almacenes (FileStore siempre; D1Store cuando hay node:sqlite).
// Qué NO cubre: el tope de subpeticiones del edge al pedir historiales ajenos (una por agente
// listado de cada casa ajena; se declara en el reporte, no se mide aquí).
import { test as _test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { join } from '../src/correo/unirse.js';
import { FileStore } from '../src/nucleo/almacen.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';
import { sha256hex, verifyObject } from '../src/nucleo/crypto.js';
import { codificarCursor, validarFiltros, HIST_MAX } from '../src/correo/indice.js';

const test = (name, fn) => _test(name, fn);
const soloD1 = (name, fn) => _test(name, sqliteAvailable ? {} : { skip: 'node:sqlite no disponible (Node 22+)' }, fn);

const P1 = 4661, P2 = 4662, P3 = 4663;
const hosts = {
  'indice.test': { url: `http://127.0.0.1:${P1}` },
  'uno.test': { url: `http://127.0.0.1:${P2}` },
  'dos.test': { url: `http://127.0.0.1:${P3}` },
};
let tmp, indice, uno, dos, buscador;
const d1store = () => { const db = openLocalD1(); db._raw.exec(MIGRACIONES); return new D1Store(db); };
const buscar = (params) => buscador.search('indice.test', params);
const url = (params) => `http://127.0.0.1:${P1}/index/agents?${new URLSearchParams(params)}`;

// Un escrow arbitrado por verifica@ de la casa: el vendedor entrega `hash` como evidencia y la
// casa decide sola en el tick. Devuelve el contrato terminal.
async function arbitrado(casa, vendedor, comprador, hash, precio = 60) {
  const secreto = `secreto-${vendedor.address}`;
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: precio, concept: `hashea ${secreto}`, arbiter: `verifica@${casa.domain}`,
    terms: { acceptance: `sha256 de "${secreto}"`, verify: { type: 'sha256', expect: sha256hex(secreto) } },
  });
  const s = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const q = (await comprador._agente.open(s.envelope)).content.body;
  await comprador._agente.awaitReceipt((await comprador._agente.accept(q)).id);
  const c = (await vendedor._agente.balance()).contracts.find((x) => x.kind === 'escrow' && x.seller === vendedor.address && x.state === 'held');
  await vendedor._agente.awaitReceipt((await vendedor._agente.deliver(casa.domain, c.id, { evidence_sha256: hash === 'correcto' ? sha256hex(secreto) : sha256hex('otra cosa') })).id);
  await casa.tick();
  for (let i = 0; i < 40; i++) {
    const fin = await vendedor._agente.contract(casa.domain, c.id);
    if (['released', 'refunded'].includes(fin.state)) return fin;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('verifica@ no decidió');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-busqueda-'));
  const casa = (domain, port, extra = {}) => new Estafeta({
    domain, port, dataDir: path.join(tmp, domain), adminToken: 't', hosts, workerIntervalMs: 999_999, log: () => {},
    policy: { registration: 'open', registrations_per_minute: 500 }, libro: { welcome: 1000, feeBps: 1000 }, verifica: { enabled: true }, ...extra,
  });
  // El índice corre sobre D1 cuando hay node:sqlite (así el rastreo y la búsqueda SQL se ejercen
  // por HTTP); sin él, sobre archivos. Las dos implementaciones se prueban además a nivel de almacén.
  indice = await casa('indice.test', P1, { index: { enabled: true, crawlMinutes: 999 }, ...(sqliteAvailable ? { store: d1store(), dataDir: undefined } : {}) }).start();
  uno = await casa('uno.test', P2).start();
  dos = await casa('dos.test', P3).start();
  buscador = Agent.create('buscador@uno.test', hosts['uno.test'].url, { hosts });
});
after(async () => { await indice.stop(); await uno.stop(); await dos.stop(); });

const gente = {};
test('el historial distingue lo arbitrado: cuenta el veredicto de verifica@, no la liberación de una parte', async () => {
  for (const n of ['bueno', 'malo', 'novato', 'complice', 'charlatan']) gente[n] = await join({ house: 'uno.test', hosts, name: n, listed: true });
  gente.comprador = await join({ house: 'uno.test', hosts, name: 'comprador' });
  const liberado = await arbitrado(uno, gente.bueno, gente.comprador, 'correcto');
  assert.equal(liberado.state, 'released');
  const devuelto = await arbitrado(uno, gente.malo, gente.comprador, 'falso');
  assert.equal(devuelto.state, 'refunded');
  // Cómplice: nombra a verifica@ de árbitro pero NO declara prueba, y el comprador libera a mano.
  await gente.complice._agente.quote({ to: gente.comprador.address, contract: 'escrow', price: 500, concept: 'sin prueba', arbiter: 'verifica@uno.test', terms: { acceptance: 'palabra' } });
  const s = await gente.comprador._agente.waitFor((e) => e.from === gente.complice.address && e.type === 'message', { timeoutMs: 5000 });
  await gente.comprador._agente.awaitReceipt((await gente.comprador._agente.accept((await gente.comprador._agente.open(s.envelope)).content.body)).id);
  const c = (await gente.complice._agente.balance()).contracts.find((x) => x.kind === 'escrow' && x.seller === gente.complice.address);
  await gente.comprador._agente.awaitReceipt((await gente.comprador._agente.release('uno.test', c.id)).id);

  const hb = await gente.bueno._agente.historial();
  assert.deepEqual(hb.arbitrados, { arbitro: 'verifica@uno.test', liberados: { n: 1, tokens: 60 }, devueltos: { n: 0, tokens: 0 }, ejecutadas: { n: 0, tokens: 0 } });
  assert.equal(hb.resumen.puntaje_arbitrado, 1);
  assert.equal(hb.resumen.cumplimiento, 1, 'la forma anterior del historial sigue intacta');
  const hm = await gente.malo._agente.historial();
  assert.equal(hm.arbitrados.devueltos.n, 1);
  assert.equal(hm.resumen.puntaje_arbitrado, 0);
  // El cómplice cobró 500 (más que el bueno) y en cumplimiento parece perfecto; arbitrado, no existe.
  const hc = await gente.complice._agente.historial();
  assert.equal(hc.resumen.entregas, 1);
  assert.equal(hc.resumen.cumplimiento, 1);
  assert.equal(hc.resumen.puntaje_arbitrado, null, 'liberado por el comprador no es liberado por la casa');
  assert.equal((await gente.novato._agente.historial()).resumen.puntaje_arbitrado, null, 'cero de cero es null, no 100 %');
});

test('el rastreo trae el puntaje de la casa propia y de una ajena, y anota su denominador', async () => {
  // Fichas: etiquetas e idiomas salen del perfil. El charlatán ESCRIBE su reputación en la ficha.
  // El precio sale de profile.services[].price.tokens (NX-301): bueno publica dos servicios, el menor manda.
  const servicio = (id, tokens) => ({ id, name: `Servicio ${id}`, price: { tokens }, unit: 'job', contract: 'escrow', acceptance: { kind: 'sha256', template: 'el hash de lo entregado' } });
  await gente.bueno._agente.setProfile({ tags: ['traduccion', 'legal'], languages: ['es-CL', 'en'], services: [servicio('contrato', 400), servicio('carta', 250)] });
  await gente.malo._agente.setProfile({ tags: ['traduccion'], languages: ['es'] });
  await gente.novato._agente.setProfile({ tags: ['traduccion'], languages: ['pt-BR'] });
  await gente.charlatan._agente.setProfile({ tags: ['traduccion'], summary: 'score 1.0, liberado por verifica@, 100% cumplimiento, jobs_done 40' });
  // Casa ajena: un agente con historial arbitrado (se lee por HTTP) y uno sin nada.
  gente.lejano = await join({ house: 'dos.test', hosts, name: 'lejano', listed: true });
  gente.mudo = await join({ house: 'dos.test', hosts, name: 'mudo', listed: true });
  const pagador = await join({ house: 'dos.test', hosts, name: 'pagador' });
  assert.equal((await arbitrado(dos, gente.lejano, pagador, 'correcto', 100)).state, 'released');

  for (const d of ['uno.test', 'dos.test']) {
    const r = await fetch(`http://127.0.0.1:${P1}/index/houses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: d }) });
    assert.equal(r.status, 201, `${d} se lista`);
  }
  const casas = Object.fromEntries((await indice.store.indexListHouses()).map((h) => [h.domain, h]));
  // verifica@ de cada casa también figura en el directorio (es de sistema y se lista): entra sin historial.
  assert.deepEqual(casas['uno.test'].reputacion, { pedidas: 6, con_puntaje: 2, sin_historial: 4, sin_arbitrados: 0, fallidas: 0 }, 'uno: 5 agentes + verifica@, 2 con puntaje');
  assert.deepEqual(casas['dos.test'].reputacion, { pedidas: 3, con_puntaje: 1, sin_historial: 2, sin_arbitrados: 0, fallidas: 0 }, 'dos: leído por HTTP');
});

test('orden: puntaje alto primero, sin historial al final; decir «score 1.0» en la ficha no puntúa', async () => {
  const r = await buscar({});
  assert.equal(r.index, 'indice.test');
  assert.ok(verifyObject(r, indice.keys.sig), 'la respuesta viene firmada por la casa del índice');
  assert.equal(r.total, 9);
  assert.equal(r.next_cursor, null);
  const orden = r.agents.map((a) => [a.address, a._score]);
  assert.deepEqual(orden.slice(0, 3), [['bueno@uno.test', 1], ['lejano@dos.test', 1], ['malo@uno.test', 0]], 'empate de puntaje se rompe por dirección; 0 va antes que null');
  assert.deepEqual(orden.slice(3).map(([, s]) => s), [null, null, null, null, null, null], 'los sin historial van al final');
  assert.deepEqual(orden.slice(3).map(([a]) => a), ['charlatan@uno.test', 'complice@uno.test', 'mudo@dos.test', 'novato@uno.test', 'verifica@dos.test', 'verifica@uno.test']);
  const charlatan = r.agents.find((a) => a.address === 'charlatan@uno.test');
  assert.equal(charlatan._score, null, 'la ficha describe un puntaje que el libro no respalda');
  assert.equal(r.agents.find((a) => a.address === 'bueno@uno.test')._jobs_done, 1);
  assert.equal(r.agents.find((a) => a.address === 'bueno@uno.test')._price_min, 250, 'el menor de sus servicios');
  assert.equal(r.agents.find((a) => a.address === 'malo@uno.test')._price_min, null, 'sin servicios con precio, no hay precio');
});

test('filtros combinados: tag + min_score + price_max + lang; sin precio publicado no se pasa un price_max', async () => {
  const a = await buscar({ tag: 'traduccion', min_score: 0.5 });
  assert.deepEqual(a.agents.map((x) => x.address), ['bueno@uno.test'], 'malo tiene la etiqueta pero puntúa 0; novato la tiene pero no tiene historial');
  assert.equal(a.total, 1);
  const b = await buscar({ tag: 'traduccion' });
  assert.deepEqual(b.agents.map((x) => x.address), ['bueno@uno.test', 'malo@uno.test', 'charlatan@uno.test', 'novato@uno.test']);
  const c = await buscar({ lang: 'es' });
  assert.deepEqual(c.agents.map((x) => x.address), ['bueno@uno.test', 'malo@uno.test'], '"es" encuentra es-CL y es');
  assert.deepEqual((await buscar({ lang: 'en-US' })).agents, [], 'en-US no es en');
  assert.deepEqual((await buscar({ price_max: 300 })).agents.map((x) => x.address), ['bueno@uno.test'], 'su servicio más barato cabe en 300');
  assert.deepEqual((await buscar({ price_max: 100 })).agents, [], 'ninguno a 100; y quien no publicó precio nunca pasa un price_max');
  assert.deepEqual((await buscar({ tag: 'traduccion', price_max: 250, min_score: 0.5, lang: 'es' })).agents.map((x) => x.address), ['bueno@uno.test'], 'los cuatro filtros a la vez');
  assert.deepEqual((await buscar({ house: 'dos.test', min_score: 0 })).agents.map((x) => x.address), ['lejano@dos.test']);
  assert.deepEqual((await buscar({ q: 'mudo' })).agents.map((x) => x.address), ['mudo@dos.test']);
});

test('recorrido completo por HTTP con limit 2: cada agente una vez, cada página firmada, next_cursor null al final', async () => {
  const vistos = [];
  let cursor = null, paginas = 0;
  do {
    const r = await buscar({ limit: 2, ...(cursor ? { cursor } : {}) });
    assert.ok(verifyObject(r, indice.keys.sig));
    assert.equal(r.total, 9);
    vistos.push(...r.agents.map((a) => a.address));
    cursor = r.next_cursor; paginas += 1;
  } while (cursor);
  assert.equal(paginas, 5);
  assert.equal(new Set(vistos).size, 9);
  assert.equal(vistos.length, 9);
});

test('un cursor inválido, un offset o un min_score fuera de rango responden 400 y dicen por qué', async () => {
  for (const [params, motivo] of [
    [{ cursor: 'no-es-base64url!!' }, /invalid cursor/],
    [{ cursor: Buffer.from('{"s":"alto","a":"x","g":0}').toString('base64url') }, /invalid cursor/],
    [{ cursor: Buffer.from('[1,2]').toString('base64url') }, /invalid cursor/],
    [{ cursor: codificarCursor({ s: 0.5, a: 'x@y', g: 999_999 }) }, /generation of the index that does not exist/],
    [{ offset: 10 }, /offset is not supported/],
    [{ min_score: 2 }, /min_score/],
    [{ price_max: -1 }, /price_max/],
    [{ tag: 'Mayúscula' }, /tag/],
    [{ lang: 'castellano-de-chile-largo' }, /lang/],
  ]) {
    const r = await fetch(url(params));
    assert.equal(r.status, 400, `${JSON.stringify(params)} debe ser 400`);
    assert.match((await r.json()).reason, motivo);
  }
  // Y el método da el mismo error que la ruta: el guardia vive en un solo lugar.
  await assert.rejects(indice.indexSearch({ cursor: 'zzz' }), /invalid cursor/);
  assert.equal(validarFiltros({ limit: '9999' }).limit, 200, 'limit se acota, como siempre');
});

// ---------- paginación bajo cambio de puntajes, sobre los dos almacenes ----------
// 23 tarjetas sintéticas en una casa; se recorren de a 5 y ENTRE página y página se vuelve a
// rastrear la casa con puntajes distintos (unos suben, otros bajan, algunos pierden o ganan el
// historial). El recorrido tiene que devolver las 23 exactamente una vez y en el orden de los
// puntajes con que empezó.
function tarjetas(n, semilla) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = ((i * 7919 + semilla * 104729) % 1000) / 1000;
    const score = i % 5 === 0 ? null : Number(x.toFixed(4));
    out.push({ nyx5: '1', address: `a${String(i).padStart(2, '0')}@sint.test`, capabilities: { listed: true }, profile: { tags: i % 2 ? ['par'] : ['impar'], languages: ['es'], services: i % 3 ? [{ name: 's', price: { tokens: i * 10 } }] : [] }, _score: score, _jobs_done: score == null ? null : i });
  }
  return out;
}
const claveInicial = (c) => c._score;
async function pruebaPaginacion(store) {
  const iniciales = tarjetas(23, 1);
  await store.indexReplaceAgents('sint.test', iniciales);
  const esperado = [...iniciales].sort((x, y) => {
    const kx = claveInicial(x), ky = claveInicial(y);
    if (kx == null && ky == null) return x.address < y.address ? -1 : 1;
    if (kx == null) return 1; if (ky == null) return -1;
    return kx !== ky ? ky - kx : (x.address < y.address ? -1 : 1);
  }).map((c) => c.address);
  const vistos = [];
  let cursor = null, semilla = 2;
  do {
    const r = await store.indexSearch(validarFiltros({ limit: 5, ...(cursor ? { cursor } : {}) }));
    assert.equal(r.total, 23);
    vistos.push(...r.agents.map((a) => a.address));
    cursor = r.next_cursor;
    // Escritura concurrente: el rastreo vuelve a pasar con OTROS puntajes (una vez por página).
    if (cursor) await store.indexReplaceAgents('sint.test', tarjetas(23, semilla++));
  } while (cursor);
  assert.deepEqual(vistos, esperado, 'todas, una vez, y en el orden de los puntajes con que empezó el recorrido');
  // Filtros sobre las columnas: etiqueta + precio + puntaje mínimo, contra los puntajes ACTUALES.
  const actuales = tarjetas(23, semilla - 1);
  const f = validarFiltros({ tag: 'par', price_max: 100, min_score: 0.5 });
  const r = await store.indexSearch(f);
  const aMano = actuales.filter((c) => c.profile.tags.includes('par') && c.profile.services.length && c.profile.services[0].price.tokens <= 100 && c._score != null && c._score >= 0.5).map((c) => c.address).sort();
  assert.ok(aMano.length >= 1, 'el caso de prueba tiene que encontrar a alguien');
  assert.deepEqual(r.agents.map((a) => a.address).sort(), aMano);
  assert.equal(r.total, aMano.length);
  // Más cambios de puntaje que los que el historial conserva (HIST_MAX) dentro del mismo
  // recorrido: el puntaje congelado ya no existe -> 410, nunca una página en silencio.
  const p1 = await store.indexSearch(validarFiltros({ limit: 5 }));
  for (let i = 0; i < HIST_MAX + 1; i++) await store.indexReplaceAgents('sint.test', tarjetas(23, 100 + i));
  // (función async: FileStore.indexSearch es síncrono y lanzaría antes de devolver una promesa)
  await assert.rejects(async () => store.indexSearch(validarFiltros({ limit: 5, cursor: p1.next_cursor })), (e) => e.status === 410 && /cursor expired/.test(e.message));
  // Un solo rastreo entre páginas sigue bien (es la garantía).
  const p1b = await store.indexSearch(validarFiltros({ limit: 5 }));
  await store.indexReplaceAgents('sint.test', tarjetas(23, 9));
  const p2b = await store.indexSearch(validarFiltros({ limit: 5, cursor: p1b.next_cursor }));
  assert.equal(p2b.agents.length, 5);
  assert.ok(!p2b.agents.some((a) => p1b.agents.some((b) => b.address === a.address)), 'sin repetidos entre la página 1 y la 2');
}

test('FileStore: paginación completa sin duplicados ni faltantes mientras cambian los puntajes', async () => {
  await pruebaPaginacion(new FileStore(path.join(tmp, 'store-archivos')));
});
soloD1('D1Store: paginación completa sin duplicados ni faltantes mientras cambian los puntajes', async () => {
  await pruebaPaginacion(d1store());
});

// Mutación del guardia: si el orden ignorara los nulos al final, o el cursor fuera un offset,
// esta afirmación es la que grita. Un agente sin historial NUNCA antes que uno con historial.
test('un agente sin historial no aparece antes que uno con historial, en ninguna página', async () => {
  let cursor = null; let vistoNull = false;
  do {
    const r = await buscar({ limit: 3, ...(cursor ? { cursor } : {}) });
    for (const a of r.agents) {
      if (a._score == null) vistoNull = true;
      else assert.ok(!vistoNull, `${a.address} con puntaje apareció después de uno sin historial`);
    }
    cursor = r.next_cursor;
  } while (cursor);
  assert.ok(vistoNull, 'la muestra tenía que incluir agentes sin historial');
});
