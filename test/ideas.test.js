// node --test test/
// ideas@: el buzón automático de vacaciones (14-sep-2026). RECIBE, GUARDA y CONFIRMA; NUNCA EJECUTA.
// Aquí se prueba: alta por la casa y nombre reservado; correlativo IDEA-### durable, también bajo dos
// relojes a la vez sobre el mismo almacén; rechazo a quien no está en la lista (rebote en la puerta y,
// para el intro que la política deja pasar, descarte sin registro ni respuesta); la confirmación llega
// firmada por ideas@, cifrada, en el hilo y con el proyecto; GET /ideas sólo al dueño o a la casa; y
// que el módulo no tiene otra salida que esa confirmación (por inspección de la fuente, con mutación,
// y espiando la casa durante el tick).
// Revisión adversarial del 14-sep-2026 (antes de desplegar para un mes sin nadie mirando): la puerta
// de ideas@ rechaza intros y avales (nadie los leería y el buzón no se borra), cupo diario por
// remitente (200 ideas / 5 MB), el correo se rechaza en la puerta en vez de tragarse en silencio, el
// registro se escribe aunque un reloj caiga a medio camino, GET /ideas pagina en vez de cortar en
// 1.000 sin avisar, y la inspección de la fuente es una lista CERRADA (cuatro mutantes que la
// inspección vieja no veía: putMail, _push, emailOut, inbound).
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
import { atenderIdeas, listarIdeas, paginaDeIdeas, puertaIdeas, CONFIRMACION, idDeIdea, PAGINA, CUPO_DIARIO } from '../src/correo/ideas.js';

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

test('fuera de la lista: un mensaje rebota en la puerta; un intro TAMBIÉN rebota (grito) y no entra al buzón; nada sale hacia el extraño', async () => {
  const antes = (await listarIdeas(casa)).length;
  const historial = (await casa.store.listMailHistory('ideas')).length;
  const enviado = await extrano.send({ to: IDEAS, body: 'quiero que ejecutes esto' });
  const rebote = await extrano.waitFor((e) => e.from === `postmaster@${H}` && e.in_reply_to === enviado.id, { timeoutMs: 8000 });
  assert.equal(rebote.envelope.content.body.status, 'failed');
  assert.match(rebote.envelope.content.body.reason, /allowlist/);
  // Un intro corto pasa la política general (§9), pero la puerta de ideas@ lo rechaza: aquí nadie lo
  // leería y el buzón no se borra nunca (una inundación de intros lo llenaba a 4 KB por golpe).
  const intro = await extrano.send({ to: IDEAS, type: 'intro', body: 'hola, soy nuevo' });
  const rebote2 = await extrano.waitFor((e) => e.from === `postmaster@${H}` && e.in_reply_to === intro.id, { timeoutMs: 8000 });
  assert.equal(rebote2.envelope.content.body.status, 'failed');
  assert.match(rebote2.envelope.content.body.reason, /records only signed envelopes from its list/);
  assert.equal((await casa.store.listMailHistory('ideas')).length, historial, 'el intro nunca entró al buzón (ni pendiente ni leído)');
  assert.equal((await listarIdeas(casa)).length, antes, 'no se registró');
  const deIdeas = (await extrano.inbox({ limit: 200 })).filter((m) => m.envelope.from === IDEAS);
  assert.deepEqual(deIdeas, [], 'ideas@ no le escribió al extraño');
  assert.ok(!(await casa.store.listOutbox('ideas')).some((o) => o.to.includes(extrano.address)), 'ni salió nada hacia él');
  // Silencio: el mismo intro a un buzón por lista que NO es ideas@ sigue entrando (§9 no cambió).
  const introNico = await extrano.send({ to: claudeNico.address, type: 'intro', body: 'hola, soy nuevo' });
  await claudeNico.waitFor((e) => e.id === introNico.id, { timeoutMs: 8000 });
});

test('puerta: cupo diario por remitente — grito al pasarse de ideas y de bytes, silencio al día siguiente y para otro remitente', async () => {
  assert.deepEqual(CUPO_DIARIO, { ideas: 200, bytes: 5 * 1024 * 1024 }, 'el cupo real: 200 ideas y 5 MB por remitente y día UTC');
  const rec = await casa.store.getAgent('ideas');
  const sobre = (n, from = nicholas.address, relleno = 10) => ({ nyx5: '1', id: `cupo-${n}`, from, to: [IDEAS], type: 'message', content: { media: 'text/plain', body: 'x'.repeat(relleno) }, signature: { alg: 'Ed25519', kid: 'k', value: 'v' } });
  const hoy = Date.parse('2026-10-01T12:00:00Z');
  const cupo = { ideas: 3, bytes: 100_000 };
  for (let i = 1; i <= 3; i++) assert.equal(await puertaIdeas(casa, sobre(i), rec, { cupo, nowMs: hoy }), null, `la idea ${i} entra`);
  const cuarta = await puertaIdeas(casa, sobre(4), rec, { cupo, nowMs: hoy });
  assert.equal(cuarta?.code, 403, 'la cuarta rebota, permanente (un 429 dejaría la cola de la otra casa reintentando un día entero)');
  assert.match(cuarta.reason, /daily limit .*\(3 ideas or 0 MB per UTC day\): not recorded$/);
  assert.equal((await puertaIdeas(casa, sobre(5), rec, { cupo, nowMs: hoy + 3600_000 }))?.code, 403, 'una hora después es el mismo día UTC: sigue cerrado');
  assert.equal(await puertaIdeas(casa, sobre(6), rec, { cupo, nowMs: hoy + 24 * 3600_000 }), null, 'al día siguiente vuelve a abrir');
  assert.equal(await puertaIdeas(casa, sobre(7, nico.address), rec, { cupo, nowMs: hoy }), null, 'el cupo es por remitente: nico@ no paga el de nicholas@');
  // Bytes: dos sobres de ~60 KB caben en 100 KB... no: el segundo se pasa y cierra el día.
  assert.equal(await puertaIdeas(casa, sobre(8, claudeNico.address, 60_000), rec, { cupo, nowMs: hoy }), null);
  const pasado = await puertaIdeas(casa, sobre(9, claudeNico.address, 60_000), rec, { cupo, nowMs: hoy });
  assert.equal(pasado?.code, 403, 'el que se pasa de bytes rebota');
  assert.equal((await puertaIdeas(casa, sobre(10, claudeNico.address, 10), rec, { cupo, nowMs: hoy }))?.code, 403, 'y el día queda cerrado aunque el siguiente sea chico');
  // Fuera de la lista: rebota antes de contar (el extraño no gasta filas de cupo).
  const ajeno = await puertaIdeas(casa, sobre(11, extrano.address), rec, { cupo, nowMs: hoy });
  assert.equal(ajeno?.code, 403); assert.match(ajeno.reason, /only signed envelopes from its list/);
  assert.equal(await casa.store.kvGet('ideas-cupo', `${extrano.address}:2026-10-01:n`), null, 'un extraño no deja fila de cupo');
  // Y por la puerta de verdad (inbound), con un cupo chico inyectado por el constructor: el 3.º rebota con motivo.
  const chica = await new Estafeta({ domain: 'cupo.test', port: P + 2, dataDir: path.join(tmp, 'cupo'), adminToken: 't', hosts: { 'cupo.test': { url: `http://127.0.0.1:${P + 2}` } }, workerIntervalMs: 100, libro: { welcome: 0, feeBps: 0 }, log: () => {}, remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') }, ideas: { enabled: true, cupo: { ideas: 2, bytes: 1_000_000 } } }).start();
  try {
    const due = Agent.create('duena@cupo.test', `http://127.0.0.1:${P + 2}`, { hosts: { 'cupo.test': { url: `http://127.0.0.1:${P + 2}` } } });
    await due.register({ adminToken: 't' });
    assert.equal((await foto(`http://127.0.0.1:${P + 2}/admin/ideas`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ owner: due.address, keys: generateKeys() }) })).status, 201);
    const t0 = Date.now();
    const ids = []; for (let i = 0; i < 3; i++) ids.push((await due.send({ to: 'ideas@cupo.test', body: `idea ${i}` })).id);
    const rebote = await due.waitFor((e) => e.from === 'postmaster@cupo.test' && e.in_reply_to === ids[2], { timeoutMs: 8000 });
    assert.match(rebote.envelope.content.body.reason, /daily limit of the ideas mailbox reached .*2 ideas or 1 MB/);
    for (const id of ids.slice(0, 2)) await due.waitFor((e) => e.from === 'ideas@cupo.test' && e.in_reply_to === id && Date.parse(e.created) > t0, { timeoutMs: 8000 });
    assert.deepEqual((await listarIdeas(chica)).map((x) => x.id_sobre), ids.slice(0, 2), 'las dos primeras se registraron; la tercera nunca entró');
  } finally { await chica.stop(); }
});

test('puerta del correo: un email a ideas@ con From: de la lista se rechaza (rebote SMTP), nada queda en el buzón; a otro buzón sigue entrando', async () => {
  const historial = (await casa.store.listMailHistory('ideas')).length;
  const r = await casa.receiveEmail({ from: nicholas.address, to: IDEAS, subject: 'idea', text: 'una idea por correo', messageId: 'correo-a-ideas-0001@x' });
  assert.equal(r.ok, false); assert.equal(r.code, 403); assert.match(r.reason, /email is not recorded/);
  assert.equal((await casa.store.listMailHistory('ideas')).length, historial, 'el correo no entró (antes entraba y el tick lo tragaba en silencio)');
  const ok = await casa.receiveEmail({ from: 'alguien@ejemplo.test', to: nico.address, subject: 'hola', text: 'un correo normal', messageId: 'correo-a-nico-0001@x' });
  assert.equal(ok.code, 202, JSON.stringify(ok));
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
    // Byte a byte iguales a una ruta que no existe (estado, cuerpo y cabeceras salvo date): que
    // ideas@ esté apagado no se distingue desde fuera.
    const foto404 = async (path, init) => { const r = await fetch(`http://127.0.0.1:${P + 1}${path}`, init); const h = Object.fromEntries([...r.headers].filter(([k]) => k !== 'date')); return { status: r.status, headers: h, body: await r.text() }; };
    const bearer = { headers: { authorization: 'Bearer t' } };
    assert.deepEqual(await foto404('/ideas', bearer), await foto404('/ideaz', bearer));
    const post = { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: '{}' };
    assert.deepEqual(await foto404('/admin/ideas', post), await foto404('/admin/ideaz', post));
    assert.equal((await foto404('/ideas', bearer)).status, 404);
  } finally { await apagada.stop(); }
});

test('GET /ideas pagina: 1.005 registros -> 1.000 con next=1000 y total=1005; ?after=1000 da los 5 que faltan; after inválido es 400', async () => {
  const pag = await new Estafeta({ domain: 'pagina.test', port: P + 3, dataDir: path.join(tmp, 'pagina'), adminToken: 't', workerIntervalMs: 999_999, log: () => {}, remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') }, ideas: { enabled: true } }).start();
  try {
    assert.equal(PAGINA, 1000);
    const N = PAGINA + 5;
    for (let n = 1; n <= N; n++) await pag.store.kvPut('ideas', `n:${String(n).padStart(6, '0')}`, { n, id: idDeIdea(n), at: '2026-10-01T00:00:00.000Z' });
    await pag.store.kvPut('ideas', '_n', N);
    const p1 = await foto(`http://127.0.0.1:${P + 3}/ideas`, { headers: { authorization: 'Bearer t' } });
    assert.equal(p1.status, 200);
    assert.equal(p1.body.total, N, 'total es el último número asignado, no lo que cupo en la página');
    assert.equal(p1.body.count, PAGINA); assert.equal(p1.body.ideas.length, PAGINA); assert.equal(p1.body.next, PAGINA);
    assert.deepEqual([p1.body.ideas[0].n, p1.body.ideas[PAGINA - 1].n], [1, PAGINA]);
    const p2 = await foto(`http://127.0.0.1:${P + 3}/ideas?after=${p1.body.next}`, { headers: { authorization: 'Bearer t' } });
    assert.deepEqual(p2.body.ideas.map((x) => x.n), [1001, 1002, 1003, 1004, 1005]);
    assert.equal(p2.body.next, null); assert.equal(p2.body.total, N);
    assert.equal((await foto(`http://127.0.0.1:${P + 3}/ideas?after=x`, { headers: { authorization: 'Bearer t' } })).status, 400);
    assert.equal((await foto(`http://127.0.0.1:${P + 3}/ideas?after=-1`, { headers: { authorization: 'Bearer t' } })).status, 400);
    // Con menos de una página no hay next, y el registro vacío también contesta bien formado.
    assert.deepEqual(await paginaDeIdeas(pag, { after: N }), { total: N, count: 0, ideas: [], next: null });
  } finally { await pag.stop(); }
});

test('el registro se escribe aunque el reloj caiga entre el número y el registro: al reintentar no queda una idea confirmada sin registro (grito) ni un número repetido (silencio)', async () => {
  // En Node el adaptador dispara un tick COMPLETO tras cada petición (en el edge va con programado:
  // false); para observar una pasada a mano se apaga ese tick mientras dura la prueba.
  clearInterval(casa.timer);
  const tickReal = casa.tick.bind(casa); casa.tick = async () => {};
  const t0 = Date.now();
  const n0 = await casa.store.kvGet('ideas', '_n');
  const enviado = await nicholas.send({ to: IDEAS, body: 'idea que cae a medio camino' });
  await tickReal({ programado: false });
  assert.ok((await casa.store.listMail('ideas')).some((m) => m.envelope.id === enviado.id), 'en el buzón, sin atender');
  // Primer reloj: el almacén falla JUSTO al escribir el registro `n:`, después de asignar el número.
  const kvPut = casa.store.kvPut.bind(casa.store);
  let caidas = 0;
  casa.store.kvPut = (ns, key, ...r) => { if (ns === 'ideas' && key.startsWith('n:')) { caidas++; throw new Error('D1 caído al escribir el registro'); } return kvPut(ns, key, ...r); };
  try { assert.equal(await atenderIdeas(casa), 0); } finally { casa.store.kvPut = kvPut; }
  assert.equal(caidas, 1);
  assert.equal(await casa.store.kvGet('ideas', '_n'), n0 + 1, 'el número ya salió');
  assert.equal(await casa.store.kvGet('ideas', `n:${String(n0 + 1).padStart(6, '0')}`), null, 'y el registro no está');
  assert.ok((await casa.store.listMail('ideas')).some((m) => m.envelope.id === enviado.id), 'el sobre sigue pendiente (no se confirmó sin registro)');
  // Segundo reloj (15 minutos después): se suelta el turno y se reintenta.
  await casa.store.kvDelete('ideas-turno', enviado.id);
  assert.equal(await atenderIdeas(casa), 1);
  const reg = await casa.store.kvGet('ideas', `n:${String(n0 + 1).padStart(6, '0')}`);
  assert.equal(reg?.id_sobre, enviado.id, 'el registro existe ahora, con el MISMO número');
  assert.equal(await casa.store.kvGet('ideas', '_n'), n0 + 1, 'no se gastó otro número');
  casa.tick = tickReal;
  casa.timer = setInterval(() => casa.tick().catch(() => {}), casa.workerIntervalMs);
  const conf = await confirmacionA(nicholas, t0);
  assert.equal(conf.envelope.in_reply_to, enviado.id);
  assert.match((await nicholas.open(conf.envelope)).content.body, new RegExp(`^Saved as ${idDeIdea(n0 + 1)} on `));
  assert.equal((await casa.store.listOutbox('ideas')).filter((o) => o.envelope.in_reply_to === enviado.id).length, 1, 'una sola confirmación');
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
// Lista CERRADA de lo que el módulo puede tocar. Revisión del 14-sep-2026: la inspección anterior era
// una lista de PROHIBIDOS (fetch, _systemSend, libro...) y cuatro mutantes la pasaban en silencio:
// `est.store.putMail` a otro buzón, `est._push` (webhook), `est.emailOut` y `est.inbound` directo.
// Con una lista de permitidos, cualquier miembro nuevo de la estafeta, del almacén o del agente grita.
// Lo que NO cubre: un alias (`const x = est; x.inbound()`) o acceso por corchetes; por eso además se
// prohíben los corchetes sobre est/store/agente y se espía la casa en vivo (prueba siguiente).
const PERMITIDO = {
  imports: ['./resolver.js', '../nucleo/crypto.js', './politica.js'],
  est: ['ideas', 'store', 'domain', 'log', 'agenteDeBoveda', '_evento'],
  store: ['kvIncrement', 'kvGet', 'kvPut', 'kvPutIfAbsent', 'kvList', 'getAgent', 'listMail', 'ackMail'],
  agente: ['open', 'send'],
};
function salidasDe(conComentarios) {
  // Se inspecciona el CÓDIGO: los comentarios pueden nombrar lo que el módulo no hace.
  const fuente = conComentarios.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '');
  const hallazgos = [];
  for (const m of fuente.matchAll(/^import\s.*?from\s+'([^']+)'/gm)) if (!PERMITIDO.imports.includes(m[1])) hallazgos.push(`import ${m[1]}`);
  for (const m of fuente.matchAll(/\best\.store\.(\w+)/g)) if (!PERMITIDO.store.includes(m[1])) hallazgos.push(`est.store.${m[1]}`);
  for (const m of fuente.matchAll(/\best\.(?!store\.)(\w+)/g)) if (!PERMITIDO.est.includes(m[1])) hallazgos.push(`est.${m[1]}`);
  for (const m of fuente.matchAll(/\bagente\.(\w+)/g)) if (!PERMITIDO.agente.includes(m[1])) hallazgos.push(`agente.${m[1]}`);
  if (/\b(est|store|agente)\s*\[/.test(fuente)) hallazgos.push('acceso por corchetes');
  // Y lo que nunca puede aparecer, se llame como se llame la variable.
  const PROHIBIDO = { fetch: /\bfetch\s*\(/, _systemSend: /_systemSend/, enqueue: /\benqueue\b/, putMail: /putMail/, inbound: /\binbound\b/, libro: /\.libro\b|libroOp|\/libro\//, anthropic: /anthropic/i, API_MENSAJES: /API_MENSAJES/, url: /https?:\/\//, env: /process\.env/, webhook: /webhook/i, email: /emailOut|_push\b/, global: /globalThis/ };
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
    // Los cuatro que la inspección por prohibidos NO veía (revisión del 14-sep-2026):
    'escribir en otro buzón (putMail)': fuente.replace('registradas++;', 'registradas++; await est.store.putMail("nico", { ...e, id: e.id + "-copia" }, { from_verified: true });'),
    'webhook por _push': fuente.replace('registradas++;', 'registradas++; est._push("nico", e);'),
    'correo por emailOut': fuente.replace('registradas++;', 'registradas++; await est.emailOut({ fromAgent: propia, to: "x@ejemplo.test", subject: "idea", text: "copia" });'),
    'inbound directo': fuente.replace('registradas++;', 'registradas++; await est.inbound({ ...e, to: ["nico@" + est.domain] });'),
    'un miembro nuevo del almacén': fuente.replace('registradas++;', 'registradas++; await est.store.listAgents();'),
    'un miembro nuevo del agente': fuente.replace('registradas++;', 'registradas++; await agente.reply(e, "ok");'),
    'acceso por corchetes': fuente.replace('registradas++;', 'registradas++; await est["inbou" + "nd"](e);'),
    'el resolver hacia otra casa': fuente.replace('registradas++;', 'registradas++; await est.resolver.agentCard("x@otra.test");'),
  };
  for (const [nombre, m] of Object.entries(mutantes)) assert.notEqual(m, fuente, `el mutante no mutó: ${nombre}`);
  for (const [nombre, m] of Object.entries(mutantes)) assert.ok(salidasDe(m).length > 0, `la inspección no vio: ${nombre}`);
});

test('única salida (en vivo): durante el tick la casa no sale a la red, no usa _systemSend ni la API, y lo único que sale de ideas@ son confirmaciones a la lista', async () => {
  const antesRed = salidas.length, antesApi = llamadasApi;
  let sistema = 0; const original = casa._systemSend.bind(casa);
  casa._systemSend = async (...a) => { sistema++; return original(...a); };
  try {
    // Con el reloj parado, UNA pasada de atenderIdeas con espías sobre toda la superficie de la casa
    // que puede sacar algo: lo único que puede llamar es /outbound como ideas@ hacia el remitente.
    clearInterval(casa.timer);
    const tickReal = casa.tick.bind(casa); casa.tick = async () => {};  // sin el tick del adaptador (ver prueba del registro)
    const antesBuzones = new Map(); for (const l of ['nico', 'extrano', 'nicholas']) antesBuzones.set(l, (await casa.store.listMailHistory(l)).length);
    const esp = await nicholas.send({ to: IDEAS, body: 'idea bajo espías' });
    await tickReal({ programado: false });
    const llamadas = {}; const cuenta = (k) => { llamadas[k] = (llamadas[k] || 0) + 1; };
    const restaurar = [];
    for (const k of ['inbound', '_push', 'emailOut', '_deliver', 'outbound', 'fetch']) { const o = casa[k]; restaurar.push(() => { casa[k] = o; }); casa[k] = (...a) => { cuenta(k); return o.apply(casa, a); }; }
    for (const k of ['putMail', 'enqueue']) { const o = casa.store[k].bind(casa.store); restaurar.push(() => { casa.store[k] = o; }); casa.store[k] = (...a) => { cuenta(`store.${k}`); return o(...a); }; }
    const rutas = []; const hr = casa.handleRequest.bind(casa); restaurar.push(() => { casa.handleRequest = hr; });
    casa.handleRequest = (rx) => { rutas.push([rx.method, rx.path, rx.body?.from, rx.body?.to]); return hr(rx); };
    let registradas;
    try { registradas = await atenderIdeas(casa); } finally { for (const r of restaurar) r(); }
    assert.equal(registradas, 1);
    assert.deepEqual(llamadas, { outbound: 1, 'store.enqueue': 1 }, `la casa hizo algo más que encolar la confirmación: ${JSON.stringify(llamadas)}`);
    assert.deepEqual(rutas, [['POST', '/outbound', IDEAS, [nicholas.address]]], 'la única petición interna es /outbound de ideas@ al remitente');
    for (const [l, n] of antesBuzones) assert.equal((await casa.store.listMailHistory(l)).length, n, `el buzón de ${l} no cambió durante el tick`);
    assert.equal(salidas.length - antesRed, 0);
    casa.tick = tickReal;
    casa.timer = setInterval(() => casa.tick().catch(() => {}), casa.workerIntervalMs);
    await nicholas.waitFor((e) => e.from === IDEAS && e.in_reply_to === esp.id, { timeoutMs: 8000 });
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
testD1('los dos almacenes cuentan igual: kvIncrement suma `by` (bytes del cupo) y kvList pagina con `after`', async () => {
  const db = openLocalD1(); db._raw.exec(MIGRACIONES);
  const fileStore = casa.store;
  for (const [nombre, st] of [['FileStore', fileStore], ['D1Store', new D1Store(db)]]) {
    assert.equal(await st.kvIncrement('prueba-by', 'k', null, Date.now(), 5), 5, nombre);
    assert.equal(await st.kvIncrement('prueba-by', 'k', null, Date.now(), 7), 12, nombre);
    assert.equal(await st.kvIncrement('prueba-by', 'k'), 13, `${nombre}: sin by suma 1`);
    assert.equal(await st.kvIncrement('prueba-by', 'vencido', Date.now() - 1, Date.now(), 4), 4, `${nombre}: vencido arranca en by`);
    for (const k of ['n:000001', 'n:000002', 'n:000003', 'x:000009']) await st.kvPut('prueba-list', k, { k });
    assert.deepEqual((await st.kvList('prueba-list', { prefix: 'n:' })).map((f) => f.key), ['n:000001', 'n:000002', 'n:000003'], nombre);
    assert.deepEqual((await st.kvList('prueba-list', { prefix: 'n:', after: 'n:000001' })).map((f) => f.key), ['n:000002', 'n:000003'], `${nombre}: after excluye la clave`);
    assert.deepEqual((await st.kvList('prueba-list', { prefix: 'n:', after: 'n:000002', limit: 1 })).map((f) => f.key), ['n:000003'], nombre);
    assert.deepEqual(await st.kvList('prueba-list', { prefix: 'n:', after: 'n:000003' }), [], nombre);
    for (const k of ['n:000001', 'n:000002', 'n:000003', 'x:000009']) await st.kvDelete('prueba-list', k);
    await st.kvDelete('prueba-by', 'k'); await st.kvDelete('prueba-by', 'vencido');
  }
});
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
