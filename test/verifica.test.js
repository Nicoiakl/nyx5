// node --test test/
// verifica@: el evaluador de referencia. Tres pruebas deterministas atadas a la liberación
// del escrow. Lo que se prueba aquí es que el dinero se mueve por lo que la prueba devolvió,
// nunca por lo que alguien afirmó — y que cuando la prueba no puede correr, NADIE decide.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { correrPrueba, veredicto, pruebasDe, pruebasDisponibles, PRUEBAS, patronSeguro, segmentosDe, CUERPO_MAX, PATRON_MAX } from '../src/libro/verifica.js';
import { sha256hex } from '../src/nucleo/crypto.js';

const P = 4161;
const hosts = { 'v.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa;

// Un servidor de mentira que responde lo que se le pida: es el "mundo" que la prueba mira.
let mundo, mundoPort, estado = 200, cuerpo = 'ok', cabeceras = {};
const url = (p = '/health') => `http://127.0.0.1:${mundoPort}${p}`;
// Las pruebas exigen https; el mundo local habla http. Se sustituye el esquema al pedir, como
// hace la casa en las pruebas de abajo (`casa.fetch`).
const mundoFetch = (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
const segura = (p) => url(p).replace('http://', 'https://');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-verifica-'));
  mundo = http.createServer((req, res) => { res.writeHead(estado, { 'content-type': 'text/plain', ...cabeceras }); res.end(cuerpo); });
  await new Promise((r) => mundo.listen(0, '127.0.0.1', r));
  mundoPort = mundo.address().port;
  casa = new Estafeta({
    domain: 'v.test', port: P, dataDir: path.join(tmp, 'v.test'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 1000, feeBps: 1000 }, verifica: { enabled: true }, log: () => {},
  });
  await casa.start();
});
after(async () => { await casa.stop(); await new Promise((r) => mundo.close(r)); });

// La prueba pura, sin protocolo alrededor.
test('http_status: pasa con el código esperado y falla con otro, diciendo cuál vio', async () => {
  const ok = await correrPrueba({ type: 'http_status', url: 'https://ejemplo.invalid/x' }, {
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(ok.pasa, true);
  const mal = await correrPrueba({ type: 'http_status', url: 'https://ejemplo.invalid/x' }, {
    fetchImpl: async () => ({ status: 500 }),
  });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /responded 500, expected 200/g);
  // http, no https: no se verifica contra un canal que cualquiera puede alterar.
  const inseguro = await correrPrueba({ type: 'http_status', url: 'http://ejemplo.invalid/x' });
  assert.equal(inseguro.pasa, false);
  assert.match(inseguro.razon, /https/);
});

test('sha256: compara el hash del contenido entregado y no acepta un expect mal formado', async () => {
  const texto = 'el informe entregado';
  const bien = await correrPrueba({ type: 'sha256', expect: sha256hex(texto) }, { entregado: texto });
  assert.equal(bien.pasa, true);
  const mal = await correrPrueba({ type: 'sha256', expect: sha256hex('otra cosa') }, { entregado: texto });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /el hash no coincide/);
  const basura = await correrPrueba({ type: 'sha256', expect: 'no-es-un-hash' }, { entregado: texto });
  assert.equal(basura.pasa, false);
  assert.match(basura.razon, /sha256 en hexadecimal/);
});

test('sha256 sin url: compara el hash que el agente DECLARÓ al entregar', async () => {
  const esperado = sha256hex('el resultado correcto');
  const bien = await correrPrueba({ type: 'sha256', expect: esperado }, { entregadoSha256: esperado });
  assert.equal(bien.pasa, true);
  assert.equal(bien.evidencia.fuente, 'evidence_sha256');
  const mal = await correrPrueba({ type: 'sha256', expect: esperado }, { entregadoSha256: sha256hex('otra cosa') });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /no es el esperado/);
  // Entregó sin declarar hash: no se puede verificar, así que NO se decide (ni cobra ni pierde).
  const sinNada = await correrPrueba({ type: 'sha256', expect: esperado }, {});
  assert.equal(sinNada.pasa, false);
  assert.equal(sinNada.indeciso, true, 'sin evidencia no se castiga a nadie');
});

test('exit_0: corre un comando real, exige argv y no acepta una línea de shell', async () => {
  assert.ok(pruebasDisponibles().includes('exit_0'), 'en Node sí hay shell');
  assert.ok(pruebasDisponibles().includes('json_path'), 'json_path corre en cualquier runtime');
  const ok = await correrPrueba({ type: 'exit_0', argv: ['node', '-e', 'process.exit(0)'] });
  assert.equal(ok.pasa, true);
  const mal = await correrPrueba({ type: 'exit_0', argv: ['node', '-e', 'process.exit(3)'] });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /salió con 3/);
  // Una línea de shell abriría inyección de comandos: se rechaza de plano.
  const shell = await correrPrueba({ type: 'exit_0', argv: 'echo hola && rm -rf /' });
  assert.equal(shell.pasa, false);
  assert.match(shell.razon, /no se acepta una línea de shell/);
});

test('json_path: compara un campo por igualdad estricta y dice qué vio', async () => {
  const doc = { status: 'ready', version: 3, data: [{ id: 'a7' }], nested: { flag: false }, obj: { b: 2, a: 1 } };
  const con = (p) => correrPrueba(p, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(doc) }) });

  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'status', expect: 'ready' })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'version', expect: 3 })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data.0.id', expect: 'a7' })).pasa, true);
  // false y 0 son valores, no ausencias: comparar por igualdad estricta importa.
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'nested.flag', expect: false })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'nested.flag', expect: true })).pasa, false);
  // El orden de las claves no cambia el valor.
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'obj', expect: { a: 1, b: 2 } })).pasa, true);
  // Un campo que no existe falla y lo dice, en vez de pasar por ser "vacío == vacío".
  const falta = await con({ type: 'json_path', url: 'https://x/', path: 'no.existe', expect: 'algo' });
  assert.equal(falta.pasa, false);
  assert.match(falta.razon, /expected/);
  // Un expect ausente no puede colarse comparando null con null.
  assert.match((await con({ type: 'json_path', url: 'https://x/', path: 'status' })).razon, /needs an expect/);
  assert.match((await con({ type: 'json_path', url: 'https://x/' })).razon, /needs a path/);
  assert.match((await con({ type: 'json_path', url: 'http://x/', path: 'a', expect: 1 })).razon, /https/);

  // No es JSON: no se decide a ciegas.
  const malo = await correrPrueba({ type: 'json_path', url: 'https://x/', path: 'a', expect: 1 },
    { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) });
  assert.equal(malo.pasa, false);
  assert.match(malo.razon, /did not return valid JSON/);
  // Y una red caída deja indeciso, como las demás.
  const caida = await correrPrueba({ type: 'json_path', url: 'https://x/', path: 'a', expect: 1 },
    { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(caida.indeciso, true);
});

test('veredicto: exige que TODAS pasen, y una prueba que no pudo correr deja indeciso', async () => {
  const t = 'x';
  const todas = await veredicto([{ type: 'sha256', expect: sha256hex(t) }, { type: 'exit_0', argv: ['node', '-e', ''] }], { entregado: t });
  assert.equal(todas.pasa, true);
  const una = await veredicto([{ type: 'sha256', expect: sha256hex(t) }, { type: 'exit_0', argv: ['node', '-e', 'process.exit(1)'] }], { entregado: t });
  assert.equal(una.pasa, false);
  // Red caída: no es "la afirmación es falsa", es "no se pudo verificar".
  const caida = await veredicto([{ type: 'http_status', url: 'https://ejemplo.invalid/x' }], {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(caida.indeciso, true);
  assert.equal(caida.pasa, false);
  assert.match(caida.razon, /no se pudo verificar/);
  // Sin pruebas declaradas no hay nada que decidir.
  assert.equal((await veredicto([])).indeciso, true);
  assert.equal(pruebasDe({ terms: {} }), null);
  assert.deepEqual(pruebasDe({ terms: { verify: { type: 'http_status', url: 'https://x/' } } }).length, 1);
});

test('verifica@ existe como agente de sistema y declara qué puede correr', async () => {
  const card = await casa.agentCard('verifica');
  assert.ok(card, 'la casa levanta verifica@ sola');
  assert.deepEqual(card.capabilities.verifica.pruebas, pruebasDisponibles());
  // Es de sistema: nadie más puede tomar ese nombre.
  const usurpador = await fetch(`http://127.0.0.1:${P}/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local: 'verifica', sig: 'x' }),
  });
  assert.equal(usurpador.status, 409);
});

test('el escrow se libera SOLO si la prueba pasa, y el recibo dice por qué', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'obrero' });
  const comprador = await join({ house: 'v.test', hosts, name: 'jefe' });
  estado = 200;

  const saldoAntes = (await vendedor._agente.balance()).balance;
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 200, concept: 'levantar el endpoint',
    arbiter: `verifica@v.test`,
    terms: { acceptance: 'el endpoint responde 200', verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const cot = (await comprador._agente.open(sobre.envelope)).content.body;
  const aceptada = await comprador._agente.accept(cot);
  await comprador._agente.awaitReceipt(aceptada.id);

  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 200);
  assert.equal(contrato.state, 'held');
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, { note: 'listo' });
  await vendedor._agente.awaitReceipt(entrega.id);

  // Nadie libera a mano: el cron corre la prueba y decide. La URL es https y no resuelve
  // desde el edge de mentira, así que la prueba se sustituye por el mundo local.
  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await vendedor._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@v.test', { timeoutMs: 5000 });

  const fin = await vendedor._agente.contract('v.test', contrato.id);
  assert.equal(fin.state, 'released', 'la prueba pasó, el escrow se liberó');
  assert.equal((await vendedor._agente.balance()).balance, saldoAntes + 180, '200 menos 10% de la casa');
  const paso = fin.history.find((h) => h.op === 'release');
  assert.equal(paso.by, 'verifica@v.test', 'quien liberó fue el verificador, no una parte');

  // Y queda en el historial como entrega aceptada: reputación = el libro.
  assert.equal((await vendedor._agente.historial()).resumen.entregas, 1);
});

test('si la prueba falla, el escrow se DEVUELVE y nadie cobra por haber dicho que entregó', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'mentiroso' });
  const comprador = await join({ house: 'v.test', hosts, name: 'clienta' });
  estado = 500; // el endpoint está caído, aunque el vendedor diga lo contrario

  const antesV = (await vendedor._agente.balance()).balance;
  const antesC = (await comprador._agente.balance()).balance;
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 150, concept: 'arreglar el sitio',
    arbiter: `verifica@v.test`,
    terms: { acceptance: 'el endpoint responde 200', verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const aceptada = await comprador._agente.accept((await comprador._agente.open(sobre.envelope)).content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 150);

  // El vendedor AFIRMA que entregó. Afirmar sigue siendo gratis; cobrar, no.
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, { note: 'desplegado y verificado' });
  await vendedor._agente.awaitReceipt(entrega.id);

  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await comprador._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@v.test', { timeoutMs: 5000 });

  const fin = await comprador._agente.contract('v.test', contrato.id);
  assert.equal(fin.state, 'refunded');
  assert.equal((await vendedor._agente.balance()).balance, antesV, 'el que afirmó en falso no cobró un token');
  assert.equal((await comprador._agente.balance()).balance, antesC, 'y el comprador recuperó todo, sin fee');
  const paso = fin.history.find((h) => h.op === 'refund');
  assert.match(paso.note, /responded 500, expected 200/g, 'la razón queda escrita en el contrato');

  const h = await vendedor._agente.historial();
  assert.equal(h.resumen.entregas_falladas, 1);
  assert.equal(h.resumen.cumplimiento, 0);
});

test('sin árbitro verifica@ o sin prueba declarada, la casa no toca el escrow', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'ajeno' });
  const comprador = await join({ house: 'v.test', hosts, name: 'ajena' });
  estado = 500;
  // Mismo contrato, pero sin nombrar árbitro: es un trato entre dos, la casa no se mete.
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 90, concept: 'sin árbitro',
    terms: { verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const aceptada = await comprador._agente.accept((await comprador._agente.open(sobre.envelope)).content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 90);
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, {});
  await vendedor._agente.awaitReceipt(entrega.id);

  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await casa.tick();
  assert.equal((await comprador._agente.contract('v.test', contrato.id)).state, 'delivered', 'la casa no decide donde no la llamaron');
});

test('el ciclo completo con sha256: se cobra por el hash correcto, no por afirmar', async () => {
  const bueno = await join({ house: 'v.test', hosts, name: 'aplicado' });
  const malo = await join({ house: 'v.test', hosts, name: 'flojo' });
  const secreto = 'nyx5';
  const esperado = sha256hex(secreto);

  for (const [agente, entrega, resultado] of [[bueno, esperado, 'released'], [malo, sha256hex('cualquier cosa'), 'refunded']]) {
    await agente._agente.quote({
      to: agente.address === bueno.address ? malo.address : bueno.address,
      contract: 'escrow', price: 60, concept: `hashea "${secreto}"`, arbiter: 'verifica@v.test',
      terms: { acceptance: `sha256 de "${secreto}"`, verify: { type: 'sha256', expect: esperado } },
    });
  }
  // El comprador de cada trato acepta.
  for (const [vendedor, comprador] of [[bueno, malo], [malo, bueno]]) {
    const s = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
    const q = (await comprador._agente.open(s.envelope)).content.body;
    await comprador._agente.awaitReceipt((await comprador._agente.accept(q)).id);
  }
  const contratoDe = async (a) => (await a._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 60 && c.seller === a.address);
  for (const [agente, hash] of [[bueno, esperado], [malo, sha256hex('cualquier cosa')]]) {
    const c = await contratoDe(agente);
    await agente._agente.awaitReceipt((await agente._agente.deliver('v.test', c.id, { evidence_sha256: hash })).id);
  }
  await casa.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await bueno._agente.contract('v.test', (await contratoDe(bueno)).id)).state, 'released');
  assert.equal((await malo._agente.contract('v.test', (await contratoDe(malo)).id)).state, 'refunded');
});

// La tarjeta de un agente de sistema describe lo que la casa puede hacer HOY. Nació de un
// defecto real: al añadir json_path, verifica@ siguió anunciando las tres pruebas viejas porque
// la tarjeta se escribió una sola vez. Un agente que la lee para decidir si puede pactar una
// verificación habría creído que la prueba no existe.
test('la tarjeta de verifica@ se reescribe si cambian las pruebas que la casa puede correr', async () => {
  const P2 = 4162;
  const dir = path.join(tmp, 'refresco');
  const mk = () => new Estafeta({
    domain: 'r.test', port: P2, dataDir: dir, adminToken: 't', hosts: { 'r.test': { url: `http://127.0.0.1:${P2}` } },
    workerIntervalMs: 5000, policy: { registration: 'open' }, log: () => {},
  });
  const uno = mk();
  await uno.start();
  assert.deepEqual((await uno.agentCard('verifica')).capabilities.verifica.pruebas, pruebasDisponibles());
  // Se ensucia la tarjeta a mano, como si la hubiera escrito una versión vieja de la casa.
  const rec = await uno.store.getAgent('verifica');
  rec.capabilities.verifica.pruebas = ['http_status'];
  await uno.store.putAgent('verifica', rec);
  assert.deepEqual((await uno.agentCard('verifica')).capabilities.verifica.pruebas, ['http_status']);
  await uno.stop();

  // Al levantar de nuevo, la casa corrige lo que anuncia.
  const dos = mk();
  await dos.start();
  try {
    assert.deepEqual((await dos.agentCard('verifica')).capabilities.verifica.pruebas, pruebasDisponibles(),
      'la casa debe corregir la tarjeta al arrancar');
  } finally { await dos.stop(); }
});

// Un bloque mal cerrado dejó el alta de tareas@ ANIDADA dentro de la de verifica@: el mostrador
// solo se creaba si el verificador no existía. Pasó desapercibido porque en un arranque limpio
// ambos se crean a la vez. Cada agente de sistema tiene que levantarse por su cuenta.
test('cada agente de sistema se levanta solo, sin depender de que falte otro', async () => {
  const P2 = 4163;
  const dir = path.join(tmp, 'sistema');
  const cat = [{ id: 'x', concept: 'algo', price: 10, verify: { type: 'http_status', url: 'https://x.invalid/' } }];
  const mk = () => new Estafeta({
    domain: 's.test', port: P2, dataDir: dir, adminToken: 't', hosts: { 's.test': { url: `http://127.0.0.1:${P2}` } },
    workerIntervalMs: 5000, policy: { registration: 'open' }, tareas: { catalogo: cat }, log: () => {},
  });
  // Primer arranque: están los cuatro.
  const uno = mk(); await uno.start();
  for (const a of ['postmaster', 'libro', 'verifica', 'tareas']) assert.ok(await uno.agentCard(a), `falta ${a}@ en el primer arranque`);
  await uno.stop();

  // Segundo arranque con verifica@ YA presente: tareas@ debe seguir existiendo igual.
  const dos = mk(); await dos.start();
  try {
    for (const a of ['postmaster', 'libro', 'verifica', 'tareas']) assert.ok(await dos.agentCard(a), `${a}@ desapareció al rearrancar`);
  } finally { await dos.stop(); }
});

// La casa no puede anunciar lo que no puede hacer. Con nodejs_compat, Workers expone `process`
// pero no puede lanzar un proceso: mirar `process.versions.node` hacía que el edge declarara
// exit_0 y luego fallara al pedirla. La detección tiene que INTENTAR cargar el módulo.
test('la detección de shell prueba a cargar el módulo, no a mirar una variable', async () => {
  const src = fs.readFileSync(new URL('../src/libro/verifica.js', import.meta.url), 'utf8');
  // Nada de `await` en el nivel superior: el módulo lo carga el servidor al arrancar, y un
  // import dinámico ahí colgó el Worker de la beta la mitad de las veces (TLS en 0,2 s y luego
  // ninguna respuesta). La detección es una expresión, sin E/S.
  const nivelSuperior = src.slice(0, src.indexOf('export async function correrPrueba'));
  assert.ok(!/^\s*(await |if \(!enWorkers\) \{ try \{ const m = await)/m.test(nivelSuperior),
    'el módulo no puede tener await en el nivel superior: lo carga el servidor al arrancar');
  assert.match(src, /Cloudflare-Workers/, 'la detección debe reconocer el runtime del edge');
  assert.match(src, /export const conShell = !enWorkers/, 'la detección es una expresión, no E/S');
  // Y en Node, donde sí hay, la lista completa está disponible.
  assert.deepEqual(pruebasDisponibles(), ['http_status', 'sha256', 'json_path', 'regex', 'size', 'header', 'exit_0']);
});

// Un 52x lo emite la infraestructura que hay delante, no el servidor que se comprueba. Nació de
// un caso real: una tarea sembrada apuntaba a la propia casa, el Worker no puede pedirse a sí
// mismo (trampa conocida de este proyecto), el borde devolvió 522 y el trabajo del agente se
// devolvió como si hubiera mentido. Castigar por una red que no controla destruye el sistema.
test('un error del borde deja indeciso, no declara falsa la afirmación', async () => {
  for (const code of [520, 521, 522, 523, 525, 527]) {
    const r = await correrPrueba({ type: 'http_status', url: 'https://x.example/' }, { fetchImpl: async () => ({ status: code }) });
    assert.equal(r.indeciso, true, `${code} debería dejar indeciso`);
    assert.equal(r.pasa, false);
    assert.match(r.razon, /could not reach/);
  }
  // Un 500 del servidor comprobado SÍ es un fallo suyo: ahí la afirmación es falsa.
  const quinientos = await correrPrueba({ type: 'http_status', url: 'https://x.example/' }, { fetchImpl: async () => ({ status: 500 }) });
  assert.equal(quinientos.pasa, false);
  assert.ok(!quinientos.indeciso, 'un 500 del propio servidor sí decide');
  assert.match(quinientos.razon, /responded 500, expected 200/);
});

// Ninguna tarea sembrada puede apuntar a la casa que la verifica: el Worker no puede pedirse su
// propia URL pública y la comprobación nunca podría pasar.
test('el catálogo sembrado no se verifica contra la propia casa', async () => {
  const { NYX5_TAREAS } = await import('../src/plataformas/worker.js');
  for (const t of NYX5_TAREAS.catalogo) {
    for (const v of (Array.isArray(t.verify) ? t.verify : [t.verify])) {
      if (!v.url) continue;
      assert.ok(!/nyx5\.com/.test(v.url), `la tarea "${t.id}" se verifica contra la propia casa (${v.url}): nunca podrá pasar`);
    }
  }
});

// ---------- NX-602: más pruebas deterministas ----------
// Cada una decide igual dos veces sobre el mismo mundo, dice qué vio, y queda indecisa (no falsa)
// cuando no pudo mirar. Se corren contra el servidor local de arriba, no contra dobles.

test('json_path: acepta a.b[0].c además de a.b.0.c, y exists decide por presencia', async () => {
  const doc = { data: [{ id: 'a7', nulo: null }], flag: false };
  const con = (p) => correrPrueba(p, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(doc) }) });
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data[0].id', expect: 'a7' })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data[0].id', equals: 'a7' })).pasa, true, 'equals es alias de expect');
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data[1].id', expect: 'a7' })).pasa, false);
  assert.deepEqual(segmentosDe('data[0].id'), ['data', '0', 'id']);
  assert.equal(segmentosDe('a..b'), null);
  assert.equal(segmentosDe('a[x]'), null);
  // exists: un campo presente con valor null EXISTE; uno ausente, no.
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data[0].nulo', exists: true })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data[0].otro', exists: true })).pasa, false);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data[0].otro', exists: false })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'flag', exists: false })).pasa, false, 'false es un valor, no una ausencia');
  // Un campo ausente no pasa por igualar null con null (expect: null).
  const ausente = await con({ type: 'json_path', url: 'https://x/', path: 'no.existe', expect: null });
  assert.equal(ausente.pasa, false);
  assert.match(ausente.razon, /missing/);
  // exists y expect a la vez es ambiguo; exists tiene que ser booleano.
  assert.match((await con({ type: 'json_path', url: 'https://x/', path: 'flag', expect: 1, exists: true })).razon, /not both/);
  assert.match((await con({ type: 'json_path', url: 'https://x/', path: 'flag', exists: 'yes' })).razon, /true or false/);
});

test('regex: casa contra el cuerpo real, dice qué patrón, y no acepta más de 1 MB ni patrones peligrosos', async () => {
  estado = 200; cuerpo = 'Estado: listo (version 3)';
  const con = (p) => correrPrueba({ type: 'regex', url: segura('/r'), ...p }, { fetchImpl: mundoFetch });
  const ok = await con({ pattern: 'version [0-9]+' });
  assert.equal(ok.pasa, true, ok.razon);
  assert.equal(ok.evidencia.truncated, false);
  const mayus = await con({ pattern: '^estado', flags: 'i' });
  assert.equal(mayus.pasa, true);
  const no = await con({ pattern: 'version 4' });
  assert.equal(no.pasa, false);
  assert.match(no.razon, /does not match/);
  // Un cuerpo de más de 1 MB se lee hasta el tope y el veredicto lo declara.
  cuerpo = 'a'.repeat(CUERPO_MAX + 10) + 'FIN';
  const grande = await con({ pattern: 'FIN' });
  assert.equal(grande.pasa, false, 'lo que está después del MB no se miró');
  assert.equal(grande.evidencia.truncated, true);
  assert.equal(grande.evidencia.bytes_read, CUERPO_MAX);
  assert.match(grande.razon, /only the first/);
  cuerpo = 'ok';
  // Sin cuerpo que leer (404): falla diciendo el código, no indecisa.
  estado = 404;
  const cuatro = await con({ pattern: 'ok' });
  assert.equal(cuatro.pasa, false); assert.ok(!cuatro.indeciso); assert.match(cuatro.razon, /404/);
  estado = 200;
  // Red caída: indeciso.
  const caida = await correrPrueba({ type: 'regex', url: 'https://x/', pattern: 'a' }, { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(caida.indeciso, true);
  // http en vez de https: no se verifica sobre un canal alterable.
  assert.match((await correrPrueba({ type: 'regex', url: url('/r'), pattern: 'a' })).razon, /https/);
});

test('patronSeguro: rechaza las formas que retroceden exponencialmente y acepta las lineales', () => {
  const malos = ['(a+)+$', '(a|aa)*b', '(\\d+)*x', '(?:x*)?y', '(a|b)+c', '(ab|a)*', '(x)\\1', '(?<n>a)\\k<n>', 'a'.repeat(PATRON_MAX + 1), '(a', 'a)'];
  for (const p of malos) assert.equal(patronSeguro(p).ok, false, `debió rechazar ${p}`);
  const buenos = ['[ab]+c', '(ab)+', '^version [0-9]+$', '(?:foo|bar)', '(?<year>\\d{4})-\\d{2}', 'a{2,4}b', '\\(x\\)+', '[(]+', '(?=a)b', '(?<=a)b'];
  for (const p of buenos) assert.equal(patronSeguro(p).ok, true, `debió aceptar ${p}: ${patronSeguro(p).razon}`);
  assert.equal(patronSeguro('a', 'g').ok, false, 'g no está entre las banderas admitidas');
  assert.equal(patronSeguro('a', 'imsu').ok, true);
  assert.equal(patronSeguro('[', '').ok, false, 'un patrón inválido se rechaza al validar, no al correr');
  // Y en la prueba misma: el patrón peligroso se rechaza ANTES de pedir nada.
  return correrPrueba({ type: 'regex', url: 'https://x/', pattern: '(a+)+$' }, { fetchImpl: async () => { throw new Error('no debía pedir'); } })
    .then((r) => { assert.equal(r.pasa, false); assert.ok(!r.indeciso); assert.match(r.razon, /backtrack/); });
});

test('size: cuenta los bytes que llegan y decide por max_bytes y/o min_bytes', async () => {
  estado = 200; cuerpo = 'x'.repeat(1000);
  const con = (p) => correrPrueba({ type: 'size', url: segura('/s'), ...p }, { fetchImpl: mundoFetch });
  assert.equal((await con({ max_bytes: 1000 })).pasa, true);
  assert.equal((await con({ max_bytes: 999 })).pasa, false);
  assert.equal((await con({ min_bytes: 1000 })).pasa, true);
  assert.equal((await con({ min_bytes: 1001 })).pasa, false);
  assert.equal((await con({ min_bytes: 500, max_bytes: 2000 })).pasa, true);
  const fuera = await con({ min_bytes: 500, max_bytes: 999 });
  assert.equal(fuera.pasa, false);
  assert.match(fuera.razon, /1000 bytes, expected at most 999 and at least 500/);
  assert.equal(fuera.evidencia.bytes, 1000);
  // Un cuerpo mayor que el tope de lectura: se sabe que supera el máximo sin descargarlo entero.
  cuerpo = 'x'.repeat(CUERPO_MAX + 50);
  const enorme = await con({ max_bytes: 100 });
  assert.equal(enorme.pasa, false);
  assert.match(enorme.razon, /more than/);
  const minimo = await con({ min_bytes: 100 });
  assert.equal(minimo.pasa, true, 'más que el tope sigue siendo más que el mínimo');
  cuerpo = 'ok';
  // Parámetros: al menos uno, enteros no negativos, min ≤ max.
  assert.match((await con({})).razon, /max_bytes and\/or min_bytes/);
  assert.match((await con({ max_bytes: -1 })).razon, /non-negative/);
  assert.match((await con({ max_bytes: '10' })).razon, /non-negative/);
  assert.match((await con({ min_bytes: 5, max_bytes: 2 })).razon, /cannot exceed/);
  // Nada que medir en un 500 del servidor comprobado: falla, no indecisa.
  estado = 500;
  const quinientos = await con({ max_bytes: 10 });
  assert.equal(quinientos.pasa, false); assert.ok(!quinientos.indeciso);
  estado = 200;
});

test('header: compara una cabecera exacta y distingue ausente de distinta', async () => {
  estado = 200; cuerpo = 'ok'; cabeceras = { 'x-version': '3', 'cache-control': 'no-store' };
  const con = (p) => correrPrueba({ type: 'header', url: segura('/h'), ...p }, { fetchImpl: mundoFetch });
  assert.equal((await con({ name: 'X-Version', equals: '3' })).pasa, true, 'el nombre no distingue mayúsculas');
  const otra = await con({ name: 'x-version', equals: '4' });
  assert.equal(otra.pasa, false);
  assert.match(otra.razon, /sends x-version: 3, expected 4/);
  const falta = await con({ name: 'x-nada', equals: '1' });
  assert.equal(falta.pasa, false);
  assert.match(falta.razon, /does not send/);
  assert.equal(falta.evidencia.seen, null);
  // El valor esperado es texto exacto: 3 (número) no es "3".
  assert.match((await con({ name: 'x-version', equals: 3 })).razon, /as a string/);
  assert.match((await con({ equals: '3' })).razon, /needs a name/);
  assert.match((await con({ name: 'x version', equals: '3' })).razon, /needs a name/);
  // La cabecera se mira aunque el código no sea 2xx: lo que se comprueba es la cabecera.
  estado = 404;
  assert.equal((await con({ name: 'cache-control', equals: 'no-store' })).pasa, true);
  estado = 200; cabeceras = {};
  // Un 52x del borde deja indeciso, como en las demás.
  const borde = await correrPrueba({ type: 'header', url: 'https://x/', name: 'a', equals: 'b' }, { fetchImpl: async () => ({ status: 522, headers: new Headers() }) });
  assert.equal(borde.indeciso, true);
});

// La lista de pruebas es UNA: lo que verifica@ sabe correr es lo que la ficha puede prometer como
// `acceptance.kind` y lo que la tarjeta del verificador anuncia. Si alguien agrega una prueba y
// olvida un lugar, esto lo dice.
test('las pruebas nuevas entran solas al catálogo de servicios y a la tarjeta de verifica@', async () => {
  const { validarServicio } = await import('../src/correo/politica.js');
  for (const kind of ['regex', 'size', 'header', 'json_path']) {
    const r = validarServicio({ id: 'svc', name: 'x', price: { tokens: 10 }, unit: 'job', contract: 'escrow', acceptance: { kind, template: 'la prueba' } });
    assert.ok(r.servicio, `acceptance.kind=${kind} debió aceptarse: ${r.error}`);
  }
  assert.match(validarServicio({ id: 'svc', name: 'x', price: { tokens: 10 }, unit: 'job', contract: 'escrow', acceptance: { kind: 'opinion', template: 'x' } }).error || '', /verifica@ can run/);
  const card = await casa.agentCard('verifica');
  for (const p of PRUEBAS) assert.ok(card.capabilities.verifica.pruebas.includes(p), `la tarjeta no anuncia ${p}`);
});

// El ciclo entero con una prueba nueva: el escrow se libera por lo que la cabecera dijo, no por
// la palabra del vendedor. Con `header` porque es la más barata de montar sobre el mundo local.
test('el escrow se decide con header: se libera si la cabecera es la pactada y se devuelve si no', async () => {
  cabeceras = { 'x-build': 'v2' }; estado = 200; cuerpo = 'ok';
  casa.fetch = mundoFetch;
  const partes = [];
  for (const [nombre, esperado] of [['cumplidor', 'v2'], ['incumplidor', 'v3']]) {
    const vendedor = await join({ house: 'v.test', hosts, name: nombre });
    const comprador = await join({ house: 'v.test', hosts, name: `${nombre}-cliente` });
    await vendedor._agente.quote({
      to: comprador.address, contract: 'escrow', price: 40, concept: `x-build ${esperado}`, arbiter: 'verifica@v.test',
      terms: { acceptance: `la cabecera x-build vale ${esperado}`, verify: { type: 'header', url: segura('/build'), name: 'x-build', equals: esperado } },
    });
    const s = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
    await comprador._agente.awaitReceipt((await comprador._agente.accept((await comprador._agente.open(s.envelope)).content.body)).id);
    const c = (await comprador._agente.balance()).contracts.find((x) => x.kind === 'escrow' && x.amount === 40);
    await vendedor._agente.awaitReceipt((await vendedor._agente.deliver('v.test', c.id, { note: 'listo' })).id);
    partes.push({ vendedor, id: c.id });
  }
  await casa.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await partes[0].vendedor._agente.contract('v.test', partes[0].id)).state, 'released');
  const devuelto = await partes[1].vendedor._agente.contract('v.test', partes[1].id);
  assert.equal(devuelto.state, 'refunded');
  assert.match(devuelto.history.find((h) => h.op === 'refund').note, /sends x-build: v2, expected v3/);
  cabeceras = {};
});
