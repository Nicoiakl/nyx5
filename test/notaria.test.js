// node --test test/
// Notaría (NX-601, decisión de Nicholas del 14-sep-2026: GRATIS): la casa sella el hash de un
// documento con fecha y firma, y cualquiera lo verifica sin cuenta contra la tarjeta del dominio.
// Lo que estas pruebas cuidan: el sello verifica con la llave publicada (y un sello alterado NO);
// un sobre reentregado no duplica; el mismo hash por el mismo agente da UN sello y por dos agentes
// da dos; un hash inválido rebota 400; el 404 del hash sin sellos es byte a byte el del id
// inexistente; el sello de un agente secreto no lo nombra y aun así verifica; no hay asiento; una
// dirección de sólo mensajes no sella; y lo mismo sobre D1 (índice único como candado).
import { test as _test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { signObject, verifyObject, sha256hex, uuid } from '../src/nucleo/crypto.js';
import { MEDIA, LibroError } from '../src/libro/libro.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';
import { sellar, validarNotarize } from '../src/libro/notaria.js';

// Puertos propios de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4681, P2 = 4682;
const H = 'nota.test', HD = 'nota-d1.test';
const URL_H = `http://127.0.0.1:${P}`, URL_D = `http://127.0.0.1:${P2}`;
const hosts = { [H]: { url: URL_H }, [HD]: { url: URL_D } };
const test = _test;
const testD1 = sqliteAvailable ? _test : (n) => _test(n, { skip: 'node:sqlite no disponible' });
let tmp, casa, ana, beto, sombra, casaD1, storeD1, dora;

const hash = (s) => sha256hex(s);
// Respuesta comparable: estado, cuerpo y cabeceras salvo la fecha.
const foto = async (url) => { const r = await fetch(url); const h = Object.fromEntries([...r.headers].filter(([k]) => k !== 'date')); return { status: r.status, headers: h, body: await r.text() }; };
const llaves = async (url) => (await (await fetch(`${url}/.well-known/nyx5.json`)).json()).keys.map((k) => k.sig);
const verifica = (sello, kids) => kids.includes(sello?.signature?.kid) && verifyObject(sello, sello.signature.kid);
const opSobre = (de, casaDom, body) => signObject({ nyx5: '1', id: uuid(), from: de.address, to: [`libro@${casaDom}`], created: new Date().toISOString(), expires: null, thread: null, in_reply_to: null, type: 'task', content: { media: MEDIA.op, body }, }, de.keys);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-notaria-'));
  const cfg = { adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {}, policy: { registration: 'open', registrations_per_minute: 200, rate_per_minute: 500 } };
  casa = await new Estafeta({ ...cfg, domain: H, port: P, dataDir: path.join(tmp, H) }).start();
  ana = Agent.create(`anabel@${H}`, URL_H, { hosts });
  beto = Agent.create(`beto@${H}`, URL_H, { hosts });
  sombra = Agent.create(`sombra@${H}`, URL_H, { hosts });
  await ana.register({ adminToken: 't', visibility: 'public' });
  await beto.register({ adminToken: 't' });
  await sombra.register({ adminToken: 't', visibility: 'secret' });
  if (sqliteAvailable) {
    const db = openLocalD1(); db._raw.exec(MIGRACIONES); storeD1 = new D1Store(db);
    casaD1 = await new Estafeta({ ...cfg, domain: HD, port: P2, store: storeD1 }).start();
    dora = Agent.create(`dorita@${HD}`, URL_D, { hosts });
    await dora.register({ adminToken: 't' });
  }
});
after(async () => { await casa?.stop(); await casaD1?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('sellar y verificar sin cuenta: el sello verifica con la llave del dominio, uno alterado no, y no hay asiento', async () => {
  const seqAntes = (await casa.store.libroState()).seq;
  const h = hash('informe v1');
  const enviado = await ana.notarize(H, { sha256: h, name: 'Informe v1', media: 'application/pdf', note: 'entrega al cliente' });
  const { receipt } = await ana.awaitReceipt(enviado.id);
  assert.equal(receipt.existing, false);
  assert.deepEqual([receipt.of, receipt.op, receipt.from], [enviado.id, 'notarize', ana.address]);
  const s = receipt.seal;
  assert.deepEqual([s.tipo, s.sha256, s.name, s.media, s.note, s.by, s.house], ['sello', h, 'Informe v1', 'application/pdf', 'entrega al cliente', ana.address, H]);
  assert.equal(s.op_sha256, receipt.op_sha256, 'el sello lleva el hash del sobre que lo pidió (invariante 5)');
  assert.ok(!Number.isNaN(Date.parse(s.at)));
  // Sin cuenta: fetch pelado, y la firma se comprueba con la tarjeta del dominio.
  const kids = await llaves(URL_H);
  const lista = await (await fetch(`${URL_H}/notaria/${h}`)).json();
  assert.deepEqual([lista.sha256, lista.house, lista.seals.length], [h, H, 1]);
  assert.deepEqual(lista.seals[0], s, 'lo público es el mismo sello que llegó por recibo');
  assert.ok(verifica(lista.seals[0], kids), 'la firma de la casa verifica');
  const uno = await (await fetch(`${URL_H}/notaria/sello/${s.id}`)).json();
  assert.deepEqual(uno, s);
  // El chequeo puede fallar: cambiar la fecha o el hash rompe la firma. Si esto pasara, el
  // verificador estaría leyendo prosa.
  assert.equal(verifica({ ...s, at: '2000-01-01T00:00:00.000Z' }, kids), false);
  assert.equal(verifica({ ...s, sha256: hash('otro') }, kids), false);
  // El cliente también verifica, y devuelve null cuando no hay nada.
  assert.deepEqual((await beto.notarized(h, H)).seals[0], s);
  assert.equal(await beto.notarized(hash('nunca sellado'), H), null);
  // Sin dinero no hay asiento: el diario no se movió.
  assert.equal((await casa.store.libroState()).seq, seqAntes, 'un sello consumió un número de asiento');
  assert.equal((await casa.libro.journal()).length, 0);
  // El hash en MAYÚSCULAS es el mismo documento: se normaliza y se encuentra.
  assert.equal((await (await fetch(`${URL_H}/notaria/${h.toUpperCase()}`)).json()).seals[0].id, s.id);
  // Quedó el evento, una sola vez.
  const ev = (await casa.store.listEvents({ name: 'notarized' })).filter((e) => e.data.seal === s.id);
  assert.equal(ev.length, 1);
});

test('idempotencia: el mismo sobre reentregado no duplica, y otro sobre del mismo agente con el mismo hash devuelve el sello existente', async () => {
  const h = hash('contrato borrador');
  const enviado = await ana.notarize(H, { sha256: h });
  const { receipt: r1 } = await ana.awaitReceipt(enviado.id);
  // Reentrega del MISMO sobre (invariante 4): la casa lo reconoce y no vuelve a sellar.
  const re = await casa.inbound(enviado.envelope);
  assert.equal(re.duplicate, true);
  assert.equal((await casa.store.notariaList(h)).length, 1);
  // Sobre NUEVO, mismo agente, mismo hash: un solo sello, el primero, y la receta lo dice.
  const otra = await ana.notarize(H, { sha256: h.toUpperCase(), name: 'ahora con nombre' });
  const { receipt: r2 } = await ana.awaitReceipt(otra.id);
  assert.equal(r2.existing, true);
  assert.deepEqual(r2.seal, r1.seal, 'el sello devuelto es el original, no uno nuevo con el nombre de la segunda petición');
  assert.notEqual(r2.op_sha256, r1.op_sha256, 'la receta sí lleva el hash del sobre que la pidió');
  assert.equal((await casa.store.notariaList(h)).length, 1);
  const ev = (await casa.store.listEvents({ name: 'notarized' })).filter((e) => e.data.sha256 === h);
  assert.equal(ev.length, 1, 'el sello reutilizado no cuenta como sello nuevo');
});

test('dos agentes, dos sellos, en orden de fecha; el 404 del hash sin sellos es byte a byte el del id inexistente', async () => {
  const h = hash('acta compartida');
  const a = await ana.notarize(H, { sha256: h }); await ana.awaitReceipt(a.id);
  const b = await beto.notarize(H, { sha256: h }); await beto.awaitReceipt(b.id);
  const lista = await (await fetch(`${URL_H}/notaria/${h}`)).json();
  assert.equal(lista.seals.length, 2);
  assert.deepEqual(lista.seals.map((s) => s.by), [ana.address, beto.address]);
  assert.notEqual(lista.seals[0].id, lista.seals[1].id);
  assert.ok(lista.seals[0].at <= lista.seals[1].at);
  const kids = await llaves(URL_H);
  for (const s of lista.seals) assert.ok(verifica(s, kids));
  // 404 idéntico: hash válido sin sellos, e id que no existe.
  const sinSellos = await foto(`${URL_H}/notaria/${hash('jamás')}`);
  const sinId = await foto(`${URL_H}/notaria/sello/${uuid()}`);
  assert.equal(sinSellos.status, 404);
  assert.deepEqual(sinSellos, sinId);
});

test('hash inválido rebota 400; name/note se limpian y recortan; una dirección de sólo mensajes no sella', async () => {
  for (const malo of ['abc', hash('x').slice(0, 63), `${hash('x')}0`, 'g'.repeat(64), 123, null, undefined]) {
    const r = await casa.inbound(opSobre(ana, H, { op: 'notarize', sha256: malo }));
    assert.equal(r.code, 400, `sha256=${String(malo).slice(0, 12)} pasó`);
    assert.match(r.reason, /64 hexadecimal/);
  }
  assert.throws(() => validarNotarize({ sha256: hash('x'), name: 7 }), (e) => e instanceof LibroError && e.code === 400);
  // Ancho cero fuera, controles a espacio, y los topes: 120 / 500. (Escapes, nunca el carácter literal.)
  const v = validarNotarize({ sha256: hash('x').toUpperCase(), name: `sig\u200bo\tv1 ${'a'.repeat(200)}`, note: 'n'.repeat(600), media: '', extra: 'se ignora' });
  assert.equal(v.sha256, hash('x'));
  assert.ok(v.name.startsWith('sigo v1 ') && v.name.length === 120, v.name);
  assert.equal(v.note.length, 500);
  assert.equal(v.media, null);
  assert.equal('extra' in v, false);
  // Un delegado de sólo mensajes (la llave la guarda el dueño en el teléfono) no opera el Libro.
  const bot = await ana.delegate('bot', { scope: { messages_only: true } });
  const r = await casa.inbound(opSobre(bot, H, { op: 'notarize', sha256: hash('desde el bot') }));
  assert.equal(r.code, 403);
  assert.equal((await casa.store.notariaList(hash('desde el bot'))).length, 0);
});

test('el sello de un agente secreto no lo nombra en público y aun así verifica; él sí recibe el sello con su nombre', async () => {
  const h = hash('documento reservado');
  const enviado = await sombra.notarize(H, { sha256: h, name: 'reservado' });
  const { receipt } = await sombra.awaitReceipt(enviado.id);
  assert.equal(receipt.seal.by, sombra.address, 'el recibo, que sólo ve él, sí lo nombra');
  const kids = await llaves(URL_H);
  const lista = await (await fetch(`${URL_H}/notaria/${h}`)).json();
  assert.equal(lista.seals.length, 1);
  const pub = lista.seals[0];
  assert.equal(pub.by, null, 'el sello público nombra a un agente secreto');
  assert.ok(!JSON.stringify(lista).includes('sombra'), 'el nombre se filtró por otro campo');
  assert.ok(verifica(pub, kids), 'la versión anónima también está firmada por la casa');
  assert.deepEqual([pub.id, pub.sha256, pub.at, pub.op_sha256, pub.name], [receipt.seal.id, h, receipt.seal.at, receipt.seal.op_sha256, 'reservado'], 'mismo hecho, con o sin nombre');
  assert.equal((await (await fetch(`${URL_H}/notaria/sello/${pub.id}`)).json()).by, null);
  // Un agente visible en la misma lista sí se nombra.
  const b = await beto.notarize(H, { sha256: h }); await beto.awaitReceipt(b.id);
  assert.deepEqual((await (await fetch(`${URL_H}/notaria/${h}`)).json()).seals.map((s) => s.by), [null, beto.address]);
});

test('la lectura pública consulta el límite de tasa por IP, como /resolve', async () => {
  const original = casa.rate.allow;
  casa.rate.allow = async () => false;
  try {
    const r = await fetch(`${URL_H}/notaria/${hash('informe v1')}`);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
  } finally { casa.rate.allow = original; }
});

test('almacén: un segundo sello del mismo agente para el mismo hash falla cerrado (421, reintentable) en FileStore', async () => {
  const doc = sellar({ sha256: hash('candado'), name: null, media: null, note: null, by: `x@${H}`, house: H, at: new Date().toISOString(), op_sha256: hash('op') }, casa.keys);
  await casa.store.libroCommit({ sellos: [doc] });
  const otro = sellar({ sha256: hash('candado'), name: null, media: null, note: null, by: `x@${H}`, house: H, at: new Date().toISOString(), op_sha256: hash('op2') }, casa.keys);
  await assert.rejects(() => Promise.resolve().then(() => casa.store.libroCommit({ sellos: [otro] })), (e) => e.code === 421 && e.transient === true);
  assert.equal((await casa.store.notariaList(hash('candado'))).length, 1);
  assert.equal((await casa.store.notariaGet(doc.id)).id, doc.id);
  assert.equal(await casa.store.notariaGet(otro.id), null);
});

testD1('D1: sellar, verificar sin cuenta, idempotencia por agente, y el índice único como candado', async () => {
  const h = hash('en d1');
  const enviado = await dora.notarize(HD, { sha256: h, name: 'D1' });
  const { receipt } = await dora.awaitReceipt(enviado.id);
  assert.equal(receipt.existing, false);
  const kids = await llaves(URL_D);
  const lista = await (await fetch(`${URL_D}/notaria/${h}`)).json();
  assert.deepEqual(lista.seals, [receipt.seal]);
  assert.ok(verifica(lista.seals[0], kids));
  assert.deepEqual(await (await fetch(`${URL_D}/notaria/sello/${receipt.seal.id}`)).json(), receipt.seal);
  // Mismo sobre reentregado, y sobre nuevo con el mismo hash: sigue habiendo uno.
  assert.equal((await casaD1.inbound(enviado.envelope)).duplicate, true);
  const otra = await dora.notarize(HD, { sha256: h });
  assert.equal((await dora.awaitReceipt(otra.id)).receipt.existing, true);
  assert.equal((await storeD1.notariaList(h)).length, 1);
  assert.equal((await storeD1.libroState()).seq, 0, 'un sello consumió un número de asiento en D1');
  // El candado del esquema: la inserción directa de un segundo sello (sha256, by) choca y se traduce a 421.
  const dup = sellar({ sha256: h, name: null, media: null, note: null, by: dora.address, house: HD, at: new Date().toISOString(), op_sha256: hash('op') }, casaD1.keys);
  await assert.rejects(() => storeD1.libroCommit({ sellos: [dup], op: { id: uuid(), result: {} } }), (e) => e instanceof LibroError && e.code === 421 && e.transient === true);
  assert.equal(await storeD1.libroGetOp(dup.id), null, 'el batch entero se deshizo: ni sello ni op');
  assert.equal((await storeD1.notariaList(h)).length, 1);
  // 404 idéntico también aquí.
  assert.deepEqual(await foto(`${URL_D}/notaria/${hash('nada')}`), await foto(`${URL_D}/notaria/sello/${uuid()}`));
});
