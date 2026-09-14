// node --test test/
// NX-501 · Boleta del asiento y estado de cuenta exportable.
//
// Lo que se cuida aquí, contra el terreno y no contra el reporte:
//   - todo recibo que reparte (spot, release, expire, charge) dice fee y comisión LEÍDOS del asiento;
//   - el estado de cuenta cuadra contra el saldo del Libro (dos fuentes: filas vs saldos), y cada
//     fee y cada comisión es su propia fila;
//   - el CSV suma lo mismo que el JSON, escapa comas y comillas (RFC 4180) y no deja fórmulas;
//   - el rango [desde, hasta) excluye lo de fuera y dos cortes empalman;
//   - otro agente no ve tu estado; FileStore y D1Store responden lo mismo.
import { test as _test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { boletaDe, filasDe, csvDe, campoCsv, CSV_CABECERA } from '../src/libro/estado.js';
import { llamar, TOOLS } from '../src/puentes/herramientas.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';
import { sha256hex } from '../src/nucleo/crypto.js';

const test = _test;
const P1 = 4651, H = 'estado.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P1}` } };
const CASA = `casa@${H}`;
let tmp, alfa, comprador, vendedor, referidor, ajeno;
// T separa "antes" de "después": el corte del rango que empalma los dos extractos.
let T;
const bal = (acc) => alfa.libro.balance(acc);
const receiveQuote = async (buyer, q) => (await buyer.open((await buyer.waitFor((e) => e.id === q.id)).envelope)).content.body;
const recibo = async (agente, sentId) => (await agente.awaitReceipt(sentId)).receipt;
const reciboDe = async (agente, sentId) => (await agente.open((await agente.waitFor((e) => e.type === 'receipt' && e.in_reply_to === sentId, { timeoutMs: 6000 })).envelope)).content.body;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (q = '') => `http://127.0.0.1:${P1}/libro/estado${q}`;
const firmado = (agente, q = '') => fetch(url(q), { headers: { authorization: agente._auth('GET', '/libro/estado') } });

// Un lector RFC 4180 mínimo, para que la prueba lea el CSV como lo leería una hoja de cálculo.
function leerCsv(texto) {
  const filas = []; let fila = [], campo = '', entre = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entre) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') entre = false;
      else campo += c;
    } else if (c === '"') entre = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\r' && texto[i + 1] === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; i++; }
    else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}
const num = (s) => (s === '' ? 0 : Number(s));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-estado-'));
  alfa = await new Estafeta({ domain: H, port: P1, dataDir: path.join(tmp, H), adminToken: 'a', hosts, workerIntervalMs: 120, retry: { baseMs: 120, maxMs: 500 }, libro: { feePct: 0.10, welcome: 0, reviewWindowMs: 300 }, log: () => {} }).start();
  comprador = Agent.create(`comprador@${H}`, hosts[H].url, { hosts });
  vendedor = Agent.create(`vendedor@${H}`, hosts[H].url, { hosts });
  referidor = Agent.create(`referidor@${H}`, hosts[H].url, { hosts });
  ajeno = Agent.create(`ajeno@${H}`, hosts[H].url, { hosts });
  for (const a of [comprador, vendedor, referidor, ajeno]) await a.register({ adminToken: 'a' });
  await alfa.libro.topup(comprador.address, 1000, 'carga');
});
after(async () => { await alfa.stop(); });

test('boleta: los recibos que reparten dicen fee y comisión leídos del asiento; los que no reparten, no', async () => {
  // Spot 200 con referido 15 %: comprador −200 · vendedor +150 · casa +20 · referidor +30.
  const q = await vendedor.quote({ to: comprador.address, contract: 'spot', price: 200, concept: 'dato con referido', referrer: { address: referidor.address, share: 1500 } });
  const acc = await comprador.accept(await receiveQuote(comprador, q));
  const rc = await recibo(comprador, acc.id);
  const rv = await reciboDe(vendedor, acc.id);
  for (const r of [rc, rv]) {
    assert.deepEqual(r.fee, { account: CASA, amount: 20, bps: 1000 });
    assert.deepEqual(r.commission, { account: referidor.address, amount: 30, bps: 1500 });
    // Del asiento, no de una tasa: el monto es la línea de la casa, y la tasa lo reproduce.
    assert.equal(r.fee.amount, r.asiento.lines.find((l) => l.account === CASA).delta);
    assert.equal(Math.floor(r.asiento.lines.find((l) => l.delta < 0).delta * -1 * r.fee.bps / 10_000), r.fee.amount);
  }
  // Escrow 100: la aceptación RETIENE (sin fee) y la liberación reparte (fee 10, sin comisión).
  const q2 = await vendedor.quote({ to: comprador.address, contract: 'escrow', price: 100, concept: 'obra' });
  const acc2 = await comprador.accept(await receiveQuote(comprador, q2));
  const held = await recibo(comprador, acc2.id);
  assert.equal(held.fee, undefined, 'retener no cobra fee'); assert.equal(held.commission, undefined);
  await recibo(vendedor, (await vendedor.deliver(H, held.contract.id, { evidence_sha256: sha256hex('ok') })).id);
  const rel = await recibo(comprador, (await comprador.release(H, held.contract.id)).id);
  assert.deepEqual(rel.fee, { account: CASA, amount: 10, bps: 1000 }); assert.equal(rel.commission, undefined);
  // Cobro bajo mandato: reparte con fee.
  const m = (await recibo(comprador, (await comprador.mandate(H, { grantee: vendedor.address, cap: 100 })).id)).mandate;
  const ch = await recibo(vendedor, (await vendedor.charge(H, { mandate: m.id, amount: 50, concept: 'uso' })).id);
  assert.deepEqual(ch.fee, { account: CASA, amount: 5, bps: 1000 });
  // Pago directo: sin fee, y el recibo no inventa uno.
  const pay = await recibo(comprador, (await comprador.pay(H, { to: vendedor.address, amount: 40, concept: 'almuerzo' })).id);
  assert.equal(pay.fee, undefined); assert.equal(pay.asiento.meta.fee, 0);
});

test('boleta: expire (la casa libera por reloj) también lleva el fee', async () => {
  const hace2dias = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const q = await vendedor.quote({ to: comprador.address, contract: 'escrow', price: 100, concept: 'con plazo', terms: { deadline: hace2dias } });
  const c = (await recibo(comprador, (await comprador.accept(await receiveQuote(comprador, q))).id)).contract.id;
  await recibo(vendedor, (await vendedor.deliver(H, c, { evidence_sha256: sha256hex('ok') })).id);
  const t0 = new Date().toISOString();
  await pausa(400);
  await alfa.tick();
  assert.equal((await alfa.store.libroGetContract(c)).state, 'released');
  const r = (await vendedor.open((await vendedor.waitFor((e) => e.from === `libro@${H}` && e.thread === c && e.created > t0, { timeoutMs: 5000 })).envelope)).content.body;
  assert.equal(r.op, 'expire');
  assert.deepEqual(r.fee, { account: CASA, amount: 10, bps: 1000 });
  // Corte de rango para las pruebas siguientes: todo lo anterior queda "antes de T".
  await pausa(5); T = new Date().toISOString(); await pausa(5);
});

test('boleta (unidad): lee líneas, no prosa; sin línea de la casa no hay fee aunque el concepto lo diga', () => {
  const paradoja = { lines: [{ account: 'a@x', delta: -20 }, { account: 'b@x', delta: 20 }], meta: { kind: 'pay', fee: 0 }, concept: 'fee 20 house fee comisión 30' };
  assert.deepEqual(boletaDe(paradoja, { casa: 'casa@x', feeBps: 1000 }), {});
  // Una fianza ejecutada a favor de la casa: la casa cobra, pero NO es fee (meta.fee ausente).
  const forfeit = { lines: [{ account: 'escrow:c', delta: -60 }, { account: 'casa@x', delta: 60 }], meta: { kind: 'forfeit' }, concept: 'fianza ejecutada' };
  assert.deepEqual(boletaDe(forfeit, { casa: 'casa@x' }), {});
  // Un reparto de verdad: el monto sale de la línea, la tasa del contexto.
  const spot = { at: 'x', id: 'e', n: 1, concept: 'spot', lines: [{ account: 'b@x', delta: -200 }, { account: 'v@x', delta: 150 }, { account: 'casa@x', delta: 20 }, { account: 'r@x', delta: 30 }], meta: { kind: 'charge', fee: 20, referrer: 'r@x', commission: 30 } };
  assert.deepEqual(boletaDe(spot, { casa: 'casa@x', feeBps: 1000, share: 1500 }), { fee: { account: 'casa@x', amount: 20, bps: 1000 }, commission: { account: 'r@x', amount: 30, bps: 1500 } });
  // Filas: el vendedor ve bruto + dos salidas; el comprador una sola; la casa y el referidor, la suya.
  assert.deepEqual(filasDe(spot, 'v@x', 'casa@x').map((r) => [r.kind, r.in, r.out, r.fee, r.counterparty]), [['movement', 200, 0, 0, 'b@x'], ['fee', 0, 20, 20, 'casa@x'], ['commission', 0, 30, 0, 'r@x']]);
  assert.deepEqual(filasDe(spot, 'b@x', 'casa@x').map((r) => [r.kind, r.in, r.out, r.fee, r.counterparty]), [['movement', 0, 200, 0, 'v@x']]);
  assert.deepEqual(filasDe(spot, 'casa@x', 'casa@x').map((r) => [r.in, r.counterparty]), [[20, 'b@x']]);
  assert.deepEqual(filasDe(spot, 'r@x', 'casa@x').map((r) => [r.in, r.counterparty]), [[30, 'b@x']]);
  assert.deepEqual(filasDe(spot, 'nadie@x', 'casa@x'), []);
});

test('estado JSON: cuadra con el saldo del Libro y cada fee y cada comisión es su propia fila', async () => {
  const e = await vendedor.statement(H);
  assert.equal(e.account, vendedor.address);
  assert.equal(e.opening_balance + e.totals.in - e.totals.out, e.closing_balance);
  assert.equal(e.closing_balance, await bal(vendedor.address), 'las filas dicen lo mismo que saldos');
  assert.equal(e.reconciled, true); assert.equal(e.ledger_balance, e.closing_balance);
  assert.equal(e.truncated, false); assert.equal(e.entries_shown, e.entries_total);
  // Denominador independiente: cuento en el diario los asientos donde el vendedor recibió con
  // fee, y los comparo con las filas de fee. Dos totales que deben coincidir, se restan.
  const diario = (await alfa.libro.journal()).filter((a) => a.lines.some((l) => l.account === vendedor.address));
  const conFee = diario.filter((a) => a.meta?.fee > 0 && a.lines.find((l) => l.account === vendedor.address).delta > 0);
  const filasFee = e.entries.filter((r) => r.kind === 'fee');
  assert.equal(filasFee.length, conFee.length, 'cada fee es una fila');
  assert.equal(filasFee.length, 4, 'spot, release, charge, expire');
  assert.equal(e.totals.fees, conFee.reduce((s, a) => s + a.lines.find((l) => l.account === CASA).delta, 0));
  for (const r of filasFee) { assert.equal(r.counterparty, CASA); assert.equal(r.out, r.fee); assert.equal(r.in, 0); assert.equal(r.concept, 'house fee'); }
  const com = e.entries.filter((r) => r.kind === 'commission');
  assert.equal(com.length, 1); assert.equal(com[0].out, 30); assert.equal(com[0].counterparty, referidor.address); assert.equal(e.totals.commissions, 30);
  // El bruto del spot es el precio, y la fila de fee cuelga del mismo asiento.
  const spot = e.entries.find((r) => r.concept.includes('dato con referido'));
  assert.equal(spot.in, 200); assert.equal(spot.counterparty, comprador.address);
  assert.equal(filasFee.find((r) => r.entry === spot.entry).fee, 20);
  // Saldo corrido: la última fila es el saldo final.
  assert.equal(e.entries.at(-1).balance, e.closing_balance);
  assert.equal(e.rows, e.entries.length);
});

test('estado CSV: cabeceras estables, suma que cuadra, escape RFC 4180 y ninguna fórmula suelta', async () => {
  const feo = 'dato "premium", con coma';
  await recibo(comprador, (await comprador.pay(H, { to: vendedor.address, amount: 7, concept: feo })).id);
  await recibo(comprador, (await comprador.pay(H, { to: vendedor.address, amount: 3, concept: '=SUM(A1:A9)' })).id);
  const res = await firmado(vendedor, '?formato=csv');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  const hoy = new Date().toISOString().slice(0, 10);
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="estado-vendedor-inicio-${hoy}.csv"`);
  const texto = await res.text();
  assert.ok(texto.endsWith('\r\n'), 'termina en CRLF');
  const filas = leerCsv(texto);
  assert.deepEqual(filas[0], [...CSV_CABECERA]);
  const json = await vendedor.statement(H);
  const cuerpo = filas.slice(1);
  assert.equal(cuerpo.length, json.entries.length);
  const col = Object.fromEntries(CSV_CABECERA.map((c, i) => [c, i]));
  const sumaIn = cuerpo.reduce((s, f) => s + num(f[col.in]), 0), sumaOut = cuerpo.reduce((s, f) => s + num(f[col.out]), 0), sumaFee = cuerpo.reduce((s, f) => s + num(f[col.fee]), 0);
  assert.equal(json.opening_balance + sumaIn - sumaOut, json.closing_balance, 'la suma del CSV cuadra');
  assert.equal(num(cuerpo.at(-1)[col.balance]), await bal(vendedor.address), 'el último saldo es el del Libro');
  assert.equal(sumaFee, json.totals.fees);
  // La coma y las comillas sobreviven el viaje tal cual.
  assert.ok(cuerpo.some((f) => f[col.concept] === feo), `no se recuperó "${feo}"`);
  assert.match(texto, /"dato ""premium"", con coma"/);
  // Lo que parecía fórmula sale desactivado con un apóstrofo; en JSON queda intacto.
  assert.ok(cuerpo.some((f) => f[col.concept] === "'=SUM(A1:A9)"));
  assert.ok(json.entries.some((r) => r.concept === '=SUM(A1:A9)'));
  // Y el escapador, en unidad: sólo entrecomilla cuando hace falta.
  assert.equal(campoCsv('simple'), 'simple'); assert.equal(campoCsv('a,b'), '"a,b"'); assert.equal(campoCsv('di "x"'), '"di ""x"""'); assert.equal(campoCsv('l1\nl2'), '"l1\nl2"');
  assert.equal(csvDe({ entries: [] }), `${CSV_CABECERA.join(',')}\r\n`);
});

test('rango [desde, hasta): excluye lo de fuera, dos cortes empalman y la fecha sola es medianoche UTC', async () => {
  const todo = await vendedor.statement(H);
  const antes = await vendedor.statement(H, { until: T });
  const despues = await vendedor.statement(H, { since: T });
  assert.ok(antes.entries.length > 0 && despues.entries.length > 0, 'hay movimiento a los dos lados del corte');
  assert.ok(antes.entries.every((r) => r.date < T)); assert.ok(despues.entries.every((r) => r.date >= T));
  assert.equal(antes.closing_balance, despues.opening_balance, 'el cierre de uno es la apertura del otro');
  assert.equal(antes.entries_total + despues.entries_total, todo.entries_total);
  assert.deepEqual([...antes.entries, ...despues.entries].map((r) => r.entry), todo.entries.map((r) => r.entry));
  assert.equal(antes.reconciled, null, 'con hasta no se compara con el saldo de hoy');
  assert.equal(despues.reconciled, true);
  // Un rango vacío en el futuro: abre y cierra en el saldo de hoy, sin filas.
  const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const vacio = await vendedor.statement(H, { since: manana });
  assert.equal(vacio.entries.length, 0); assert.equal(vacio.opening_balance, await bal(vendedor.address)); assert.equal(vacio.closing_balance, vacio.opening_balance);
  assert.equal(vacio.since, `${manana}T00:00:00.000Z`);
  // limit: se conservan los más recientes y el saldo inicial es el de justo antes del primero listado.
  const corto = await vendedor.statement(H, { limit: 2 });
  assert.equal(corto.entries_shown, 2); assert.equal(corto.truncated, true); assert.equal(corto.entries_total, todo.entries_total);
  assert.equal(corto.opening_balance + corto.totals.in - corto.totals.out, corto.closing_balance);
  assert.equal(corto.closing_balance, await bal(vendedor.address)); assert.equal(corto.reconciled, true);
  assert.deepEqual(corto.entries.map((r) => r.entry), todo.entries.slice(-corto.entries.length).map((r) => r.entry));
});

test('acceso: otro agente no ve tu estado (403), sin firma 401, fechas o formato inválidos 400', async () => {
  const r403 = await firmado(ajeno, `?account=${encodeURIComponent(vendedor.address)}`);
  assert.equal(r403.status, 403);
  await assert.rejects(() => ajeno._call('GET', `/libro/estado?account=${encodeURIComponent(vendedor.address)}`), (e) => e.status === 403);
  assert.equal((await fetch(url())).status, 401);
  for (const q of ['?desde=basura', '?desde=2026-09-02&hasta=2026-09-01', '?formato=xml', '?hasta=13/09/2026']) {
    assert.equal((await firmado(vendedor, q)).status, 400, `${q} debía dar 400`);
  }
  // Un ajeno sí ve el suyo (vacío), y el mismo dueño ve el propio nombrándose.
  const propio = await ajeno.statement(H);
  assert.equal(propio.entries.length, 0); assert.equal(propio.closing_balance, 0);
  assert.equal((await firmado(vendedor, `?account=${encodeURIComponent(vendedor.address)}`)).status, 200);
});

test('op statement por correo acepta since/until y responde el mismo estado que la lectura directa', async () => {
  const directo = await vendedor.statement(H, { since: T });
  const r = await recibo(vendedor, (await vendedor.libroOp(H, { op: 'statement', since: T })).id);
  assert.equal(r.opening_balance, directo.opening_balance); assert.equal(r.closing_balance, directo.closing_balance);
  assert.deepEqual(r.totals, directo.totals);
  assert.deepEqual(r.entries.map((x) => x.entry), directo.entries.map((x) => x.entry));
  assert.equal(r.since, directo.since);
  // Un since ilegible rebota con 400 en vez de devolver un extracto cualquiera.
  const malo = await vendedor.libroOp(H, { op: 'statement', since: 'ayer' });
  const rebote = (await vendedor.open((await vendedor.waitFor((e) => e.type === 'receipt' && e.from === `postmaster@${H}` && e.in_reply_to === malo.id, { timeoutMs: 6000 })).envelope)).content.body;
  assert.match(rebote.reason, /400/);
});

test('herramientas: nyx5_balance con since devuelve el estado; nyx5_libro anuncia statement con rango', async () => {
  const r = JSON.parse((await llamar(vendedor, 'nyx5_balance', { since: T })).content[0].text);
  assert.equal(r.closing_balance, await bal(vendedor.address)); assert.equal(r.since, T);
  const b = JSON.parse((await llamar(vendedor, 'nyx5_balance', {})).content[0].text);
  assert.equal(b.balance, r.closing_balance, 'sin rango sigue siendo el saldo de siempre');
  assert.match(TOOLS.find((t) => t.name === 'nyx5_libro').description, /statement \{limit, since, until\}/);
  assert.ok(TOOLS.find((t) => t.name === 'nyx5_balance').inputSchema.properties.since);
});

// Los dos almacenes tienen que decir lo mismo: si un día D1 filtra distinto que el archivo, el
// extracto en producción cuadraría "solo" (se compara consigo mismo) y nadie se enteraría.
test('FileStore y D1Store responden lo mismo a libroStatementRange y libroBalanceBefore', { skip: sqliteAvailable ? false : 'node:sqlite no disponible (Node 22+)' }, async () => {
  const db = openLocalD1(); db._raw.exec(MIGRACIONES);
  const d1 = new D1Store(db);
  const diario = await alfa.libro.journal();
  for (const a of diario) await d1.libroCommit({ asientos: [a], contracts: [], mandates: [], op: null });
  const medio = diario[Math.floor(diario.length / 2)];
  for (const cuenta of [vendedor.address, comprador.address, CASA, referidor.address]) {
    for (const opts of [{}, { since: T }, { until: T }, { since: T, limit: 2 }, { since: medio.at, until: T, limit: 3 }, { until: '2000-01-01T00:00:00.000Z' }]) {
      assert.deepEqual(await d1.libroStatementRange(cuenta, opts), alfa.store.libroStatementRange(cuenta, opts), `${cuenta} ${JSON.stringify(opts)}`);
    }
    for (const opts of [{ n: medio.n }, { at: T }, { n: medio.n, at: T }, { n: 1 }, {}]) {
      assert.equal(await d1.libroBalanceBefore(cuenta, opts), alfa.store.libroBalanceBefore(cuenta, opts), `${cuenta} ${JSON.stringify(opts)}`);
    }
    assert.deepEqual(await d1.libroStatement(cuenta, 3), alfa.store.libroStatement(cuenta, 3));
  }
});
