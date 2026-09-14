// node --test test/
// ideas@: el buzón automático de vacaciones (14-sep-2026). RECIBE, GUARDA y CONFIRMA; NUNCA EJECUTA.
// Aquí se prueba: alta por la casa y nombre reservado; correlativo IDEA-### durable, también bajo dos
// relojes a la vez sobre el mismo almacén; rechazo a quien no está en la lista (rebote en la puerta y,
// para el intro que la política deja pasar, descarte sin registro ni respuesta); la confirmación llega
// firmada por ideas@, cifrada, en el hilo y con el proyecto; GET /ideas sólo al dueño o a la casa; y
// que el módulo no tiene otra salida que esa confirmación (por inspección de la fuente, con mutación,
// y espiando la casa durante el tick).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { generateKeys, sha256hex, canonical } from '../src/nucleo/crypto.js';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
import { MIGRACIONES } from './_migraciones.js';
import { atenderIdeas, listarIdeas, CONFIRMACION, idDeIdea } from '../src/correo/ideas.js';

// Puertos propios de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4821;
const H = 'ideas.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
const IDEAS = `ideas@${H}`;
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp, casa, nicholas, nico, claudeNico, extrano;
const salidas = [];        // toda llamada de la casa a la red (fetchImpl del constructor)
let llamadasApi = 0;       // la API de Anthropic simulada: aquí no se llama nunca
const admin = (metodo, ruta, body) => fetch(`${URL_CASA}${ruta}`, { method: metodo, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const foto = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: await r.json() }; };
const confirmacionA = (quien, desde) => quien.waitFor((e) => e.from === IDEAS && Date.parse(e.created) > desde, { timeoutMs: 8000 });
const FORMA = /^Saved as IDEA-\d{3,} on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. Nothing was executed: this mailbox only records and confirms\. Nicholas reads it when he is back\.$/;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-ideas-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    libro: { welcome: 0, feeBps: 0 }, log: () => {},
    fetchImpl: async (url, init) => { salidas.push(String(url)); return globalThis.fetch(url, init); },
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
    // Hay clave de la API: si algo la llamara, se sabría. ideas@ no la llama.
    asistente: { apiKey: 'clave-de-prueba', fetchImpl: async () => { llamadasApi++; throw new Error('la API no se llama'); } },
    ideas: { enabled: true },
  }).start();
  nicholas = Agent.create(`nicholas@${H}`, URL_CASA, { hosts });
  nico = Agent.create(`nico@${H}`, URL_CASA, { hosts });
  extrano = Agent.create(`extrano@${H}`, URL_CASA, { hosts });
  for (const a of [nicholas, nico, extrano]) await a.register({ adminToken: 't' });
  // El Claude del teléfono: delegado de sólo mensajes, como el del conector remoto.
  claudeNico = await nico.delegate('claude', { scope: { messages_only: true }, inbox: { policy: 'allowlist', allowlist: [nico.address] } });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('alta: sólo la casa, con prueba de posesión; ideas@ es reservado; la tarjeta declara custodia de la casa y lista', async () => {
  const usurpador = Agent.create(IDEAS, URL_CASA, { hosts });
  await assert.rejects(usurpador.register({ adminToken: 't' }), /reserved/);
  const keys = generateKeys();
  const cuerpo = { owner: nicholas.address, allow: [nico.address, claudeNico.address], keys };
  assert.equal((await foto(`${URL_CASA}/admin/ideas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) })).status, 401, 'sin Bearer no hay alta');
  assert.equal((await admin('POST', '/admin/ideas', { ...cuerpo, keys: undefined })).status, 400, 'sin llaves no hay alta');
  const ajenas = await admin('POST', '/admin/ideas', { ...cuerpo, keys: { ...keys, sigPriv: generateKeys().sigPriv } });
  assert.equal(ajenas.status, 400); assert.match(ajenas.body.reason, /sigPriv/);
  assert.equal((await admin('POST', '/admin/ideas', { ...cuerpo, owner: 'no es dirección' })).status, 400);
  const alta = await admin('POST', '/admin/ideas', cuerpo);
  assert.equal(alta.status, 201, JSON.stringify(alta.body));
  assert.equal(alta.body.address, IDEAS);
  assert.deepEqual(alta.body.custody.keys, 'house');
  assert.equal(alta.body.custody.via, 'ideas');
  assert.deepEqual(alta.body.allow, [nicholas.address, nico.address, claudeNico.address], 'el dueño entra primero en la lista aunque no lo nombren');
  assert.equal((await admin('POST', '/admin/ideas', cuerpo)).status, 409, 'dos altas con llaves: la llave no se reemplaza por aquí');
  const card = await nicholas.resolver.agentCard(IDEAS);
  assert.equal(card.sig, keys.sig);
  assert.equal(card.delegation, undefined, 'dirección raíz de la casa');
  assert.equal(card.inbox.policy, 'allowlist');
  assert.equal(card.custody.via, 'ideas');
  assert.equal(await casa.libro.balance(IDEAS), 0, 'nace sin regalo');
  // La vuelta queda abierta: el Claude del teléfono (lista cerrada) ahora acepta a ideas@; nico@ (abierto) no cambia.
  claudeNico.resolver.invalidate(`agent:${claudeNico.address}`);
  assert.ok((await nicholas.resolver.agentCard(claudeNico.address)).inbox.allowlist.includes(IDEAS), 'ideas@ entró en la lista del delegado');
  assert.equal((await nicholas.resolver.agentCard(nico.address)).inbox.policy, 'open');
  const dir = await fetch(`${URL_CASA}/agents`).then((r) => r.json());
  assert.ok(!dir.agents.some((a) => a.address === IDEAS), 'no figura en el directorio');
});

test('recibe, guarda y confirma: IDEA-001 y IDEA-002, firmadas por ideas@, cifradas, en el hilo y con el proyecto', async () => {
  const t0 = Date.now();
  const enviado = await nicholas.send({ to: IDEAS, body: 'Idea: que el buzón diga cuántas van.', project: 'viaje', role: 'dueño' });
  const r1 = await confirmacionA(nicholas, t0);
  const abierto = await nicholas.open(r1.envelope);
  assert.equal(abierto.content.body, CONFIRMACION('IDEA-001', (await listarIdeas(casa))[0].at));
  assert.match(abierto.content.body, FORMA);
  assert.equal(abierto.encrypted, true, 'la confirmación viaja cifrada');
  assert.equal(abierto.in_reply_to, enviado.id);
  assert.equal(abierto.thread, enviado.thread || enviado.id, 'mismo hilo');
  assert.equal(abierto.project, 'viaje');
  assert.equal(abierto.role, 'dueño');
  assert.equal(abierto.sender.address, IDEAS);
  assert.equal(abierto.sender.custody.via, 'ideas', 'la firma verifica contra la tarjeta de ideas@');
  // Desde el Claude del teléfono (delegado de nico@, en la lista).
  const t1 = Date.now();
  const enviado2 = await claudeNico.send({ to: IDEAS, body: 'Segunda idea desde el teléfono.' });
  const r2 = await confirmacionA(claudeNico, t1);
  const ab2 = await claudeNico.open(r2.envelope);
  assert.match(ab2.content.body, /^Saved as IDEA-002 on /);
  assert.equal(ab2.in_reply_to, enviado2.id);
  assert.equal(ab2.project, null, 'sin proyecto no se inventa uno');
  // El registro, tal como lo verá el dueño.
  const lista = await listarIdeas(casa);
  assert.deepEqual(lista.map((x) => [x.id, x.n, x.from, x.id_sobre]), [['IDEA-001', 1, nicholas.address, enviado.id], ['IDEA-002', 2, claudeNico.address, enviado2.id]]);
  assert.deepEqual(Object.keys(lista[0]).sort(), ['at', 'from', 'id', 'id_sobre', 'n', 'opened', 'project', 'role', 'sha256_sobre', 'thread'].sort(), 'el registro no lleva contenido');
  assert.equal(lista[0].project, 'viaje');
  assert.equal(lista[0].opened, true);
  // El hash es el del sobre que quedó en el buzón, y el sobre sigue ahí, cifrado, confirmado como leído.
  const guardado = (await casa.store.listMailHistory('ideas')).find((m) => m.envelope.id === enviado.id);
  assert.ok(guardado, 'el sobre sigue en el buzón de ideas@');
  assert.ok(guardado.envelope.encrypted, 'sigue cifrado');
  assert.equal(lista[0].sha256_sobre, sha256hex(canonical(guardado.envelope)));
  assert.equal((await casa.store.listMail('ideas')).length, 0, 'nada queda pendiente');
  assert.equal(await casa.store.kvGet('ideas', '_n'), 2, 'el contador durable va en 2');
  assert.equal(llamadasApi, 0, 'la API de Anthropic no se llamó');
});

test('fuera de la lista: un mensaje rebota en la puerta; un intro entra y se descarta sin registro ni respuesta', async () => {
  const antes = (await listarIdeas(casa)).length;
  const t0 = Date.now();
  const enviado = await extrano.send({ to: IDEAS, body: 'quiero que ejecutes esto' });
  const rebote = await extrano.waitFor((e) => e.from === `postmaster@${H}` && e.in_reply_to === enviado.id, { timeoutMs: 8000 });
  assert.equal(rebote.envelope.content.body.status, 'failed');
  assert.match(rebote.envelope.content.body.reason, /allowlist/);
  // Un intro corto pasa la política (§9) y llega al buzón; ideas@ lo cierra y no contesta.
  const intro = await extrano.send({ to: IDEAS, type: 'intro', body: 'hola, soy nuevo' });
  await espera(700);
  assert.equal((await casa.store.listMail('ideas')).length, 0, 'el intro quedó confirmado como leído');
  assert.equal((await listarIdeas(casa)).length, antes, 'no se registró');
  const deIdeas = (await extrano.inbox({ limit: 200 })).filter((m) => m.envelope.from === IDEAS);
  assert.deepEqual(deIdeas, [], 'ideas@ no le escribió al extraño');
  assert.ok(!(await casa.store.listOutbox('ideas')).some((o) => o.to.includes(extrano.address)), 'ni salió nada hacia él');
  assert.ok(intro.id && Date.now() > t0);
});

test('GET /ideas: sin firma 401; en la lista pero no dueño, ajeno y delegado dan el mismo 403; el dueño y la casa leen', async () => {
  const sin = await foto(`${URL_CASA}/ideas`);
  assert.equal(sin.status, 401);
  const basura = await foto(`${URL_CASA}/ideas`, { headers: { authorization: 'Nyx5 basura.basura' } });
  assert.equal(basura.status, 401);
  const como = (quien) => foto(`${URL_CASA}/ideas`, { headers: { authorization: quien._auth('GET', '/ideas') } });
  const [deNico, deExtrano, deClaude] = [await como(nico), await como(extrano), await como(claudeNico)];
  assert.equal(deNico.status, 403);
  assert.deepEqual(deNico, deExtrano, 'estar en la lista no distingue');
  assert.deepEqual(deNico, deClaude, 'un delegado del que está en la lista tampoco');
  const dueno = await como(nicholas);
  assert.equal(dueno.status, 200);
  assert.equal(dueno.body.address, IDEAS);
  assert.equal(dueno.body.total, 2);
  assert.deepEqual(dueno.body.ideas.map((x) => x.id), ['IDEA-001', 'IDEA-002']);
  const laCasa = await admin('GET', '/ideas');
  assert.deepEqual(laCasa.body, dueno.body);
  // Cambiar la lista sin llaves: el dueño sigue siendo el dueño y la tarjeta se re-certifica.
  const cambio = await admin('POST', '/admin/ideas', { owner: nicholas.address, allow: [nico.address] });
  assert.equal(cambio.status, 200);
  assert.deepEqual(cambio.body.allow, [nicholas.address, nico.address]);
  nicholas.resolver.invalidate(`agent:${IDEAS}`);
  assert.deepEqual((await nicholas.resolver.agentCard(IDEAS)).inbox.allowlist, [nicholas.address, nico.address]);
  await admin('POST', '/admin/ideas', { owner: nicholas.address, allow: [nico.address, claudeNico.address] });
  // Con la casa apagada (sin NYX5_IDEAS) las rutas no existen.
  const apagada = await new Estafeta({ domain: 'apagada.test', port: P + 1, dataDir: path.join(tmp, 'apagada'), adminToken: 't', workerIntervalMs: 999_999, log: () => {}, remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') } }).start();
  try {
    assert.equal(apagada.ideas.enabled, false);
    assert.equal((await fetch(`http://127.0.0.1:${P + 1}/ideas`, { headers: { authorization: 'Bearer t' } })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${P + 1}/admin/ideas`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: '{}' })).status, 404);
  } finally { await apagada.stop(); }
});

test('cupos por tick: 30 intros de un extraño no dejan sin turno a una idea, y con maxDescartesPorTick=5 sólo se cierran 5 por pasada', async () => {
  // Para observar UNA pasada a mano se apaga ideas@ mientras se llena el buzón (en Node, cada petición
  // dispara un tick completo; en el edge ese tick va con programado: false) y se para el reloj.
  clearInterval(casa.timer);
  casa.ideas.enabled = false;
  try {
    const antesN = await casa.store.kvGet('ideas', '_n');
    assert.equal((await casa.store.listMail('ideas')).length, 0);
    for (let i = 0; i < 30; i++) await extrano.send({ to: IDEAS, type: 'intro', body: `hola ${i}` });
    const idea = await nicholas.send({ to: IDEAS, body: 'idea entre la inundación' });
    await casa.tick({ programado: false });
    await espera(50);
    assert.equal((await casa.store.listMail('ideas')).length, 31, 'todo en el buzón, nada atendido aún');
    casa.ideas.enabled = true;
    const registradas = await atenderIdeas(casa, { maxPorTick: 20, maxDescartesPorTick: 5 });
    assert.equal(registradas, 1, 'la idea se registró aunque venga detrás de 30 intros');
    assert.equal((await casa.store.listMail('ideas')).length, 25, 'sólo 5 intros se cerraron en esta pasada');
    assert.equal(await casa.store.kvGet('ideas', '_n'), antesN + 1);
    for (let i = 0; i < 10 && (await casa.store.listMail('ideas')).length; i++) await atenderIdeas(casa, { maxPorTick: 20, maxDescartesPorTick: 5 });
    assert.equal((await casa.store.listMail('ideas')).length, 0);
    assert.equal(await casa.store.kvGet('ideas', '_n'), antesN + 1, 'los intros nunca cuentan');
    const lista = await listarIdeas(casa);
    assert.equal(lista[lista.length - 1].id_sobre, idea.id);
  } finally {
    casa.ideas.enabled = true;
    casa.timer = setInterval(() => casa.tick().catch(() => {}), casa.workerIntervalMs);
  }
});

test('tope de bytes: un remitente de la lista que manda más de 1 MB es rechazado en la puerta y no deja rastro', async () => {
  const antes = await casa.store.kvGet('ideas', '_n');
  await assert.rejects(nicholas.send({ to: IDEAS, body: 'x'.repeat(1_100_000) }), /exceeds the maximum/);
  assert.equal(await casa.store.kvGet('ideas', '_n'), antes, 'el contador no se movió');
});

// ----- la única salida: por inspección de la fuente (con mutación) y espiando la casa -----
// Lo que el módulo NO puede tener: importar el asistente (la API), el Libro, los puentes; llamar a
// `fetch`; usar `_systemSend` o la cola; y más de un `send`. Un hallazgo aquí es un cambio de alcance.
function salidasDe(conComentarios) {
  // Se inspecciona el CÓDIGO: los comentarios pueden nombrar lo que el módulo no hace.
  const fuente = conComentarios.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '');
  const hallazgos = [];
  for (const m of fuente.matchAll(/^import\s.*?from\s+'([^']+)'/gm)) {
    if (!['./resolver.js', '../nucleo/crypto.js', './politica.js'].includes(m[1])) hallazgos.push(`import ${m[1]}`);
  }
  // Usos, no menciones: `libro` como nombre de dirección de sistema a saltar es legítimo; `.libro`,
  // `libroOp` o importar de `libro/` no lo son.
  const PROHIBIDO = { fetch: /\bfetch\s*\(/, _systemSend: /_systemSend/, enqueue: /\benqueue\b/, libro: /\.libro\b|libroOp|\/libro\//, anthropic: /anthropic/i, API_MENSAJES: /API_MENSAJES/, url: /https?:\/\//, env: /process\.env/, webhook: /webhook/i };
  for (const [nombre, re] of Object.entries(PROHIBIDO)) if (re.test(fuente)) hallazgos.push(nombre);
  const envios = (fuente.match(/\.send\(/g) || []).length;
  if (envios !== 1) hallazgos.push(`${envios} llamadas a send`);
  return hallazgos;
}

test('única salida (fuente): ideas.js no importa la API ni el Libro, no tiene fetch y tiene un solo send; la inspección grita ante una mutación', () => {
  const fuente = fs.readFileSync(path.join(raiz, 'src/correo/ideas.js'), 'utf8');
  assert.deepEqual(salidasDe(fuente), []);
  // Mutaciones: cada una tiene que ser detectada, o la inspección no vale nada.
  const mutantes = {
    'un fetch escondido': fuente + '\nexport async function avisar(u) { return fetch(u); }\n',
    'importar el asistente': fuente.replace("import { parseAddress } from './resolver.js';", "import { parseAddress } from './resolver.js';\nimport { atenderAsistentes } from './asistente.js';"),
    'un segundo send': fuente + '\nexport async function copiar(ag, a) { await ag.send({ to: a, body: "copia" }); }\n',
    'usar _systemSend': fuente + '\nexport async function aviso(est) { await est._systemSend("postmaster", [], {}); }\n',
    'operar el Libro': fuente + '\nexport async function pagar(est) { await est.libro.topup("x", 1, "y"); }\n',
    'salir a una URL': fuente + '\nexport const DESTINO = "https://ejemplo.test/hook";\n',
  };
  for (const [nombre, m] of Object.entries(mutantes)) assert.ok(salidasDe(m).length > 0, `la inspección no vio: ${nombre}`);
});

test('única salida (en vivo): durante el tick la casa no sale a la red, no usa _systemSend ni la API, y lo único que sale de ideas@ son confirmaciones a la lista', async () => {
  const antesRed = salidas.length, antesApi = llamadasApi;
  let sistema = 0; const original = casa._systemSend.bind(casa);
  casa._systemSend = async (...a) => { sistema++; return original(...a); };
  try {
    const t0 = Date.now();
    const n0 = await casa.store.kvGet('ideas', '_n');
    const enviados = await Promise.all([1, 2, 3].map((i) => nicholas.send({ to: IDEAS, body: `idea en ráfaga ${i}` })));
    const vistos = new Set();
    for (let i = 0; i < 3; i++) { const r = await nicholas.waitFor((e) => e.from === IDEAS && Date.parse(e.created) > t0 && !vistos.has(e.id), { timeoutMs: 8000 }); vistos.add(r.envelope.id); }
    assert.equal(salidas.length - antesRed, 0, `la casa salió a la red: ${salidas.slice(antesRed).join(', ')}`);
    assert.equal(llamadasApi - antesApi, 0);
    assert.equal(sistema, 0, '_systemSend no se usó');
    const ids = new Set(enviados.map((e) => e.id));
    const salidos = (await casa.store.listOutbox('ideas')).filter((o) => ids.has(o.envelope.in_reply_to));
    assert.equal(salidos.length, 3);
    for (const o of salidos) { assert.deepEqual(o.to, [nicholas.address]); assert.ok(o.envelope.encrypted); assert.equal(o.envelope.from, IDEAS); }
    const lista = await listarIdeas(casa);
    assert.deepEqual(lista.slice(-3).map((x) => x.id), [n0 + 1, n0 + 2, n0 + 3].map(idDeIdea));
  } finally { casa._systemSend = original; }
});

// ----- dos relojes a la vez sobre el MISMO almacén (D1 local): ni número repetido ni confirmación doble -----
const testD1 = (name, fn) => test(name, sqliteAvailable ? {} : { skip: 'node:sqlite no disponible (Node 22+)' }, fn);
testD1('correlativo bajo dos ticks concurrentes: seis sobres, IDEA-001..006 sin huecos ni repetidos, una confirmación por sobre', async () => {
  const db = openLocalD1(); db._raw.exec(MIGRACIONES);
  // El emulador de D1 es síncrono por dentro y los dos relojes casi nunca caen en la misma ventana de
  // microtarea: un contador hecho con leer+1+escribir pasaba en verde (medido al escribir esta prueba).
  // Se abre la ventana: lo leído de kv se retiene unos milisegundos antes de devolverse (el otro
  // reloj alcanza a leer lo mismo), como pasa entre dos isolates. Un contador atómico (kvIncrement,
  // UNA sentencia) no se entera; uno de leer-y-escribir repite número. Verificado por mutación.
  const real = new D1Store(db);
  const store = new Proxy(real, { get(t, k) { const v = t[k]; if (k === 'kvGet') return async (...a) => { const v = await t.kvGet(...a); await espera(3); return v; }; return typeof v === 'function' ? v.bind(t) : v; } });
  const vaultKey = randomBytes(32).toString('base64');
  const dominio = 'dos.test';
  const casaDe = () => new Estafeta({ domain: dominio, store, adminToken: 't', publicUrl: `https://${dominio}`, workerIntervalMs: 999_999, log: () => {}, fetchImpl: async () => { throw new Error('no debe salir a la red'); }, remoto: { enabled: true, vaultKey }, ideas: { enabled: true } });
  const a = casaDe(), b = casaDe();
  await a.init(); await b.init();
  const alta = await a.handleRequest({ method: 'POST', path: '/admin/ideas', query: new URLSearchParams(), headers: { authorization: 'Bearer t' }, body: { owner: `nicholas@${dominio}`, keys: generateKeys() }, ip: 'x' });
  assert.equal(alta.status, 201, JSON.stringify(alta.body));
  const nick = Agent.create(`nicholas@${dominio}`, `https://${dominio}`, { fetchImpl: a.fetchPropio });
  await nick.register({ adminToken: 't' });
  const enviados = [];
  for (let i = 1; i <= 6; i++) enviados.push(await nick.send({ to: `ideas@${dominio}`, body: `idea ${i}` }));
  await a.tick({ programado: false });  // entrega la cola al buzón sin atender ideas@
  assert.equal((await store.listMail('ideas')).length, 6);
  const [ra, rb] = await Promise.all([atenderIdeas(a), atenderIdeas(b)]);
  assert.equal(ra + rb, 6, `entre los dos relojes registraron ${ra} + ${rb}`);
  assert.ok(ra > 0 && rb > 0, `los dos relojes trabajaron (${ra}, ${rb}); si uno hizo todo, la carrera no se ejerció`);
  const lista = await listarIdeas(a);
  assert.deepEqual(lista.map((x) => x.id), [1, 2, 3, 4, 5, 6].map(idDeIdea));
  assert.equal(new Set(lista.map((x) => x.id_sobre)).size, 6, 'cada sobre tiene un número y ninguno dos');
  assert.equal(await store.kvGet('ideas', '_n'), 6);
  assert.equal(await atenderIdeas(a) + await atenderIdeas(b), 0, 'nada queda por registrar');
  assert.equal(await store.kvGet('ideas', '_n'), 6, 'un tick vacío no mueve el contador');
  await a.tick({ programado: false });  // entrega las confirmaciones
  const recibidas = (await store.listMail('nicholas')).filter((m) => m.envelope.from === `ideas@${dominio}`);
  assert.equal(recibidas.length, 6, 'una confirmación por sobre, ninguna doble');
  assert.deepEqual(new Set(recibidas.map((m) => m.envelope.in_reply_to)), new Set(enviados.map((e) => e.id)));
  const textos = [];
  for (const m of recibidas) textos.push((await nick.open(m.envelope)).content.body);
  assert.deepEqual(textos.map((t) => t.match(/^Saved as (IDEA-\d+)/)[1]).sort(), [1, 2, 3, 4, 5, 6].map(idDeIdea));
  for (const t of textos) assert.match(t, FORMA);
});
