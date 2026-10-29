// node --test test/
// Agentes VIVOS (26-oct-2026): que cualquier dirección del equipo pueda pensar y actuar desde la
// casa, sin el Mac de Nicholas. Tres cosas se prueban aquí, y la API se simula (estas pruebas no
// gastan un peso):
//
// 1. El silencio del `task`. Defecto MEDIDO contra producción: el sobre 1bff694c de tipo `task`
//    llevaba seis semanas en el buzón de qa@nyx5.com sin respuesta y sin rebote, porque el filtro
//    de `atenderAsistentes` sólo miraba message y result, y el panel decía `pending: 1`. Ahora un
//    `task` se atiende, y un tipo que el asistente no atiende se contesta diciendo qué llegó y qué
//    se atiende, y se confirma para que no quede eterno.
// 2. La adopción: un cerebro para una dirección que YA EXISTE (rosetta@, norte@, sigo@). La tarjeta
//    pasa a declarar la custodia de la casa, la llave va a la bóveda, y nace APAGADA.
// 3. Las manos: un juego CERRADO de herramientas que la casa ejecuta con la llave del propio
//    agente. NADA que mueva dinero, y la lista cerrada se comprueba por inspección y por mutación.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { generateKeys } from '../src/nucleo/crypto.js';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { TIPOS_ATENDIDOS, NO_ATIENDE, CUPO_DESPERTAR, LIMITES_ENTRADA, DEMASIADO_LARGO, CORTADO, atenderAsistentes, gastoDe, leerFlujo, esEncargo, porGrupo } from '../src/correo/asistente.js';
import { ACCIONES, CUPO_ENVIOS_DIA, NOMBRES, NO_ESCRIBIR, IDEAS, MAX_ENVIOS, MAX_RECORDATORIOS, MAX_PASOS, SOLO_RAIZ, destinosDe, ejecutar, herramientasDe } from '../src/correo/acciones.js';
import { LOCAL as IDEAS_LOCAL } from '../src/correo/ideas.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4831;
const H = 'vivos.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp, casa, duena, amiga, extrano, rosetta, claudeDuena;
const pedidos = [];
const proximas = [];      // lo que contesta la API simulada, en orden
const USO = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// La API simulada habla SSE como la real, incluidos los bloques de herramienta (content_block_start
// + input_json_delta + content_block_stop) y un bloque de pensamiento con su firma: así se prueba el
// lector del flujo y no una forma que la API ya no usa.
const sse = (j) => {
  const partes = [`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: j.usage.input_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}`];
  let i = 0;
  for (const b of j.content || []) {
    if (b.type === 'text') {
      partes.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })}`);
      for (const t of b.text.match(/.{1,5}/g) || []) partes.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } })}`);
    } else if (b.type === 'thinking') {
      partes.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } })}`);
      partes.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: b.signature } })}`);
    } else if (b.type === 'tool_use') {
      partes.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })}`);
      const json = JSON.stringify(b.input);
      for (const t of json.match(/.{1,7}/g) || []) partes.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: t } })}`);
    }
    partes.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}`);
    i++;
  }
  partes.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: j.stop_reason }, usage: { output_tokens: j.usage.output_tokens } })}`);
  partes.push('event: message_stop\ndata: {"type":"message_stop"}');
  return partes.join('\n\n') + '\n\n';
};
const texto = (t) => ({ status: 200, json: { content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: USO } });
const usa = (llamadas, cola = 'listo') => ({
  status: 200,
  json: { content: [{ type: 'thinking', thinking: '', signature: 'firma-de-prueba' }, ...llamadas.map((x, n) => ({ type: 'tool_use', id: `tu_${n}_${Math.random().toString(36).slice(2, 8)}`, name: x.name, input: x.input }))], stop_reason: 'tool_use', usage: USO },
  cola,
});
let demora = 0;   // milisegundos de la API simulada: abre la ventana de una carrera a mano
const apiFalsa = async (url, init) => {
  const body = JSON.parse(init.body);
  pedidos.push({ url, headers: init.headers, body, bytes: init.body.length });
  if (demora) await espera(demora);
  const r = proximas.length ? proximas.shift() : texto(`respuesta ${pedidos.length}`);
  assert.equal(body.stream, true, 'toda llamada va en flujo');
  if (r.status !== 200) return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  return new Response(sse(r.json), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const admin = (metodo, ruta, body) => fetch(`${URL_CASA}${ruta}`, { method: metodo, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const respuestaA = (quien, desde, from) => quien.waitFor((e) => e.from === from && Date.parse(e.created) > desde, { timeoutMs: 8000 });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-vivos-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    libro: { welcome: 0, feeBps: 0 }, log: () => {}, index: { enabled: true, crawlMinutes: 999 },
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
    asistente: { apiKey: 'clave-de-prueba', fetchImpl: apiFalsa },
    ideas: { enabled: true },
  }).start();
  duena = Agent.create(`duena@${H}`, URL_CASA, { hosts });
  amiga = Agent.create(`amiga@${H}`, URL_CASA, { hosts });
  extrano = Agent.create(`extrano@${H}`, URL_CASA, { hosts });
  // La dirección que YA EXISTE y se va a adoptar: raíz, con su propia llave y su buzón por lista.
  rosetta = Agent.create(`rosetta@${H}`, URL_CASA, { hosts });
  for (const a of [duena, amiga, extrano]) await a.register({ adminToken: 't' });
  await rosetta.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [duena.address, amiga.address] }, capabilities: { listed: true } });
  claudeDuena = await duena.delegate('claude', { scope: { messages_only: true } });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- piedra angular: la lista de tipos y la lista de herramientas son CERRADAS ----------

test('las dos listas cerradas son exactamente las acordadas: los tipos atendidos y las cinco manos', () => {
  assert.deepEqual([...TIPOS_ATENDIDOS], ['message', 'task', 'result'], 'agregar o quitar un tipo atendido es una decisión, no un detalle');
  assert.deepEqual([...NOMBRES], ['nyx5_enviar', 'nyx5_buscar', 'nyx5_historial', 'nyx5_notarizar', 'nyx5_recordar']);
  for (const a of ACCIONES) {
    assert.equal(a.input_schema.additionalProperties, false, `${a.name}: el esquema deja pasar campos que nadie lee`);
    assert.ok(a.description.length > 80, `${a.name}: sin descripción el modelo no sabe cuándo usarla`);
  }
  assert.deepEqual([...SOLO_RAIZ], ['nyx5_notarizar']);
});

test('ninguna herramienta mueve dinero: la fuente se inspecciona con lista de PERMITIDOS y grita ante catorce mutantes', () => {
  const fuente = fs.readFileSync(path.join(raiz, 'src/correo/acciones.js'), 'utf8');
  assert.deepEqual(salidasDe(fuente), []);
  const mutantes = {
    'pagar con el agente': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.pay(ctx.domain, { to: a.to, amount: 1, concept: "x" });\n    return { content: corta({ sent: true'),
    'aceptar una cotización': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.accept({ house: ctx.domain });\n    return { content: corta({ sent: true'),
    'contratar': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.hire({ agent: a.to, service: "x" });\n    return { content: corta({ sent: true'),
    'entregar un contrato': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.deliver(ctx.domain, "c1", {});\n    return { content: corta({ sent: true'),
    'liberar un escrow': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.release(ctx.domain, "c1");\n    return { content: corta({ sent: true'),
    'una fianza': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.bond(ctx.domain, { amount: 1, claim: "x" });\n    return { content: corta({ sent: true'),
    'un mandato': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.mandate(ctx.domain, { grantee: a.to, cap: 10 });\n    return { content: corta({ sent: true'),
    'una op cualquiera del Libro': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente.libroOp(ctx.domain, { op: "pay" });\n    return { content: corta({ sent: true'),
    'el Libro por dentro': fuente.replace('return { content: corta({ sent: true', 'await ctx.est.libro.topup(a.to, 1, "x");\n    return { content: corta({ sent: true'),
    'un alias para pagar': fuente.replace('return { content: corta({ sent: true', 'const yo = ctx.agente; await yo.pay(ctx.domain, { to: a.to, amount: 1 });\n    return { content: corta({ sent: true'),
    'escribir en otro buzón': fuente.replace('return { content: corta({ sent: true', 'await ctx.est.store.putMail("duena", {}, {});\n    return { content: corta({ sent: true'),
    'salir a la red por fuera': fuente + '\nexport async function avisar(u) { return fetch(u); }\n',
    'acceso por corchetes al agente': fuente.replace('return { content: corta({ sent: true', 'await ctx.agente["p" + "ay"](ctx.domain, {});\n    return { content: corta({ sent: true'),
    'una herramienta nueva en la lista': fuente.replace("export const NOMBRES", "export const EXTRA = Object.freeze({ name: 'nyx5_pagar', description: 'x', input_schema: { type: 'object', properties: {}, additionalProperties: false } });\nexport const NOMBRES"),
  };
  for (const [nombre, m] of Object.entries(mutantes)) assert.notEqual(m, fuente, `el mutante no mutó: ${nombre}`);
  for (const [nombre, m] of Object.entries(mutantes)) assert.ok(salidasDe(m).length > 0, `la inspección no vio: ${nombre}`);
});

// Lista CERRADA de lo que el módulo de las manos puede tocar (el modelo de `test/ideas.test.js`):
// con una lista de PROHIBIDOS, cualquier primitiva nueva del agente o del almacén pasaría callada.
const PERMITIDO = {
  imports: ['./resolver.js', '../libro/notaria.js'],
  // `cupo`: el contador del día que vive en el almacén. Entra a la lista porque no mueve dinero ni
  // escribe fuera de las manos: cuenta. Lo pone `asistente.js`, que es quien puede tocar el almacén.
  ctx: ['estado', 'agente', 'domain', 'propia', 'cfg', 'rec', 'nowMs', 'disponibles', 'cupo'],
  agente: ['send', 'search', 'historial', 'notarize', 'recordar'],
  est: [],
  store: [],
};
function salidasDe(conComentarios) {
  // Se inspecciona el CÓDIGO: los comentarios pueden nombrar lo que el módulo no hace.
  const fuente = conComentarios.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '');
  const h = [];
  for (const m of fuente.matchAll(/^import\s.*?from\s+'([^']+)'/gm)) if (!PERMITIDO.imports.includes(m[1])) h.push(`import ${m[1]}`);
  for (const m of fuente.matchAll(/\bctx\.(\w+)/g)) if (!PERMITIDO.ctx.includes(m[1])) h.push(`ctx.${m[1]}`);
  for (const m of fuente.matchAll(/\bagente\.(\w+)/g)) if (!PERMITIDO.agente.includes(m[1])) h.push(`agente.${m[1]}`);
  for (const m of fuente.matchAll(/\best\.store\.(\w+)/g)) if (!PERMITIDO.store.includes(m[1])) h.push(`est.store.${m[1]}`);
  for (const m of fuente.matchAll(/\best\.(?!store\.)(\w+)/g)) if (!PERMITIDO.est.includes(m[1])) h.push(`est.${m[1]}`);
  if (/\b(est|store|agente|ctx)\s*\[/.test(fuente)) h.push('acceso por corchetes');
  // Y lo que no puede aparecer se llame como se llame la variable: toda LLAMADA que mueva dinero o
  // que escriba fuera de las manos. Se mira la forma `.nombre(`, no la palabra: las descripciones
  // que lee el modelo nombran justamente lo que NO se puede hacer.
  const PROHIBIDO = {
    dinero: /\.(pay|accept|hire|deliver|release|refund|reclaim|bond|vouch|forfeit|mandate|charge|revoke|quote|quoteFromCatalog|libroOp|balance|statement|tomar)\s*\(/,
    libro: /\.libro\b|libroOp/,
    buzon: /\.(putMail|ackMail|emailOut|_push|inbound|enqueue|putAgent|registerAgent|delegate|rotateKeys|setProfile|createGroup|editGroup)\s*\(/,
    fetch: /\bfetch\s*\(/,
    sistema: /_systemSend|process\.env|globalThis/,
    api: /anthropic/i,
    url: /https?:\/\//,
  };
  for (const [nombre, re] of Object.entries(PROHIBIDO)) if (re.test(fuente)) h.push(nombre);
  // Un nombre declarado en ACCIONES sin mano, o una mano sin nombre declarado, es un agujero.
  const declarados = [...fuente.matchAll(/name:\s*'(nyx5_\w+)'/g)].map((m) => m[1]).sort();
  const manos = [...fuente.matchAll(/^  async (nyx5_\w+)\(/gm)].map((m) => m[1]).sort();
  if (declarados.join(',') !== manos.join(',')) h.push(`declaradas ${declarados.join(',')} contra manos ${manos.join(',')}`);
  return h;
}

// ---------- 1. el silencio del `task` ----------

test('un sobre `task` se atiende (grito: con el filtro viejo quedaba eterno) y message y result siguen atendiéndose (silencio)', async () => {
  const asis = await altaDelegado('sigo', { budget_usd: 5 });
  for (const tipo of ['task', 'message', 'result']) {
    const t0 = Date.now();
    const env = await duena.send({ to: asis.address, type: tipo, body: `te encargo esto por ${tipo}` });
    const r = await duena.waitFor((e) => e.from === asis.address && e.in_reply_to === env.id, { timeoutMs: 8000 });
    assert.match((await duena.open(r.envelope)).content.body, /^respuesta \d+/, `no contestó un ${tipo}`);
    assert.ok(Date.parse(r.envelope.created) >= t0);
  }
  assert.equal((await casa.store.listMail(asis.local)).length, 0, 'lo contestado queda confirmado');
});

test('un tipo que no se atiende se contesta y se confirma: no queda eterno (grito), y a un extraño que entra con un intro no se le contesta nada', async () => {
  const asis = await altaDelegado('sigo2', { budget_usd: 5 });
  const n = pedidos.length;
  const env = await duena.send({ to: asis.address, type: 'intro', body: 'hola, me presento' });
  const r = await duena.waitFor((e) => e.from === asis.address && e.in_reply_to === env.id, { timeoutMs: 8000 });
  assert.equal((await duena.open(r.envelope)).content.body, NO_ATIENDE('intro', TIPOS_ATENDIDOS));
  assert.equal(pedidos.length, n, 'un tipo que no se atiende no cuesta una llamada a la API');
  assert.equal((await casa.store.listMail(asis.local)).length, 0, 'el sobre quedó confirmado: nada eterno');
  // Un desconocido entra a un buzón por lista con un intro de 4 KB (§9). Se cierra sin contestarle:
  // contestarle a un extraño es gastar una salida en quien la lista no eligió.
  const t0 = Date.now();
  await extrano.send({ to: asis.address, type: 'intro', body: 'y yo' });
  await espera(900);
  await casa.tick({ programado: true });
  assert.equal((await casa.store.listMail(asis.local)).length, 0, 'tampoco queda eterno el del extraño');
  assert.equal(pedidos.length, n, 'y no costó nada');
  const suyos = (await extrano.inbox()).filter((x) => x.envelope.from === asis.address && Date.parse(x.envelope.created) > t0);
  assert.deepEqual(suyos, [], 'al extraño no se le contesta');
});

test('un mensaje de alguien que no está en la lista (entrado con un intro previo) no se contesta ni queda pendiente', async () => {
  const asis = await altaDelegado('sigo3', { budget_usd: 5 });
  const n = pedidos.length;
  // Un `message` de un extraño lo rechaza la puerta; lo que sí entra es el intro, y ya se probó.
  // Aquí se mete el sobre a mano en el buzón para probar el guardia del propio asistente: es el
  // camino del aval (§9), que la política SÍ deja pasar sin estar en la lista.
  const env = (await extrano.send({ to: duena.address, body: 'avalado' }));
  const m = (await duena.inbox()).find((x) => x.envelope.id === env.id);
  await casa.store.putMail(asis.local, m.envelope, { from_verified: true });
  await espera(100);
  await casa.tick({ programado: true });
  assert.equal(pedidos.length, n, 'un remitente fuera de la lista no llega a costar nada');
  assert.equal((await casa.store.listMail(asis.local)).length, 0, 'y no queda eterno');
});

// La trampa de este proyecto: una carrera no se ve corriendo el reloj dos veces en Node, porque el
// servidor local serializa. Se golpea el MÉTODO: dos pasadas concurrentes sobre el mismo almacén.
test('dos relojes sobre el mismo sobre: una sola respuesta, un solo rebote (el turno por sobre cubre los dos caminos)', async () => {
  const asis = await altaDelegado('sigo5', { budget_usd: 5 });
  clearInterval(casa.timer);
  const tickReal = casa.tick.bind(casa);
  casa.tick = async () => {};  // el adaptador de Node dispara un tick completo tras cada petición
  try {
    const pregunta = await duena.send({ to: asis.address, type: 'task', body: 'contéstame una vez' });
    const intro = await duena.send({ to: asis.address, type: 'intro', body: 'y rebótame una vez' });
    // `programado: false` entrega la cola sin atender asistentes: es justo para esto que existe.
    for (let i = 0; i < 3; i++) { await tickReal({ programado: false }); await espera(50); }
    assert.equal((await casa.store.listMail(asis.local)).length, 2, 'los dos sobres están pendientes');
    const n = pedidos.length;
    await Promise.all([atenderAsistentes(casa), atenderAsistentes(casa)]);
    assert.equal(pedidos.length - n, 1, `dos relojes llamaron a la API ${pedidos.length - n} veces por el mismo sobre`);
    await tickReal({ programado: true });
    const respuestas = (await duena.inbox()).filter((x) => x.envelope.in_reply_to === pregunta.id && x.envelope.from === asis.address);
    assert.equal(respuestas.length, 1, `llegaron ${respuestas.length} respuestas a la misma pregunta`);
    const rebotes = (await duena.inbox()).filter((x) => x.envelope.in_reply_to === intro.id && x.envelope.from === asis.address);
    assert.equal(rebotes.length, 1, `llegaron ${rebotes.length} rebotes por el mismo sobre`);
  } finally {
    casa.tick = tickReal;
    // Devolver el reloj: sin esto el resto del archivo corre sin trabajador y se cuelga entero.
    casa.timer = setInterval(() => casa.tick().catch(() => {}), casa.workerIntervalMs);
    casa.timer.unref?.();
  }
});

// ---------- 2. adopción de una dirección que ya existe ----------

test('adopción: rosetta@ sigue siendo la misma dirección, su tarjeta declara la custodia de la casa, y nace APAGADA', async () => {
  const antes = await casa.store.getAgent('rosetta');
  const r = await admin('POST', '/admin/assistants', { adopt: true, local: 'rosetta', keys: rosetta.keys, config: { budget_usd: 5, persona: 'Eres rosetta.', tools: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.address, rosetta.address);
  assert.deepEqual(r.body.custody, { keys: 'house', via: 'assistant', since: r.body.custody.since });
  assert.equal(r.body.adopted, true);
  assert.equal(r.body.enabled, false, 'nadie se despierta solo por haber sido adoptado');
  const card = await casa.store.getAgent('rosetta');
  assert.equal(card.sig, antes.sig, 'la llave pública no cambia: es la misma dirección');
  assert.equal(card.custody.keys, 'house');
  assert.ok(await casa.llavesDeBoveda('rosetta'), 'la llave quedó en la bóveda');
  // Apagada: un mensaje no se contesta y queda pendiente (nadie lo cerró, porque nadie lo atendió).
  const n = pedidos.length;
  await duena.send({ to: rosetta.address, body: '¿estás ahí?' });
  await espera(400); await casa.tick({ programado: true });
  assert.equal(pedidos.length, n, 'apagada no llama a la API');
  assert.equal((await casa.store.listMail('rosetta')).length, 1);
});

test('adopción: el delegado NO se adopta (409 con el dueño), la doble custodia no se pisa (409), y lo inexistente es 404', async () => {
  const delegado = await admin('POST', '/admin/assistants', { adopt: true, local: claudeDuena.local, keys: claudeDuena.keys, config: {} });
  assert.equal(delegado.status, 409);
  assert.match(delegado.body.reason, /delegated address of duena@vivos\.test/);
  // ideas@ ya está bajo custodia de la casa por la vía `ideas`: ese cerebro no se reemplaza de aquí.
  const alta = await admin('POST', '/admin/ideas', { owner: duena.address, allow: [duena.address], keys: generateKeys() });
  assert.equal(alta.status, 201, JSON.stringify(alta.body));
  const ideas = await admin('POST', '/admin/assistants', { adopt: true, local: 'ideas', keys: generateKeys(), config: {} });
  assert.equal(ideas.status, 409);
  assert.match(ideas.body.reason, /house custody via ideas/);
  assert.equal((await admin('POST', '/admin/assistants', { adopt: true, local: 'nadie', keys: generateKeys(), config: {} })).status, 404);
  assert.equal((await admin('POST', '/admin/assistants', { adopt: true, local: 'libro', keys: generateKeys(), config: {} })).status, 409);
  // Y sin prueba de posesión no hay adopción: las llaves tienen que ser las de ESA tarjeta.
  const ajenas = await admin('POST', '/admin/assistants', { adopt: true, local: 'amiga', keys: { ...rosetta.keys }, config: {} });
  assert.equal(ajenas.status, 400);
  assert.match(ajenas.body.reason, /do not match the card/);
  const malas = await admin('POST', '/admin/assistants', { adopt: true, local: 'amiga', keys: { ...amiga.keys, sigPriv: generateKeys().sigPriv }, config: {} });
  assert.equal(malas.status, 400);
  assert.match(malas.body.reason, /sigPriv/);
  // Dos adopciones de la misma dirección: la segunda no pisa la primera.
  const otra = await admin('POST', '/admin/assistants', { adopt: true, local: 'rosetta', keys: rosetta.keys, config: {} });
  assert.equal(otra.status, 409);
  assert.match(otra.body.reason, /already has an assistant brain/);
});

test('encendido explícito: PUT config { enabled: true } y recién entonces contesta (y lo pendiente se atiende)', async () => {
  const n = pedidos.length;
  const r = await admin('PUT', '/admin/assistants/rosetta/config', { enabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.tools, true);
  const resp = await respuestaA(duena, 0, rosetta.address);
  assert.match((await duena.open(resp.envelope)).content.body, /respuesta/);
  assert.ok(pedidos.length > n);
  assert.equal((await admin('PUT', '/admin/assistants/rosetta/config', { enabled: 'si' })).status, 400);
  // `tools` tiene que ser booleano: un 'si' guardado como cadena sería una configuración que
  // nadie aplica, y quien la escribió creería que encendió las manos.
  const malo = await admin('PUT', '/admin/assistants/rosetta/config', { tools: 'si' });
  assert.equal(malo.status, 400);
  assert.match(malo.body.reason, /tools must be true or false/);
  assert.equal((await admin('GET', '/admin/assistants/rosetta')).body.tools, true, 'un rechazo no cambió lo guardado');
});

// El agujero del 14-sep por la otra puerta: el rebote también es un sobre, y la estampilla la paga
// QUIEN MANDA. Una dirección adoptada es raíz, así que tiene cuenta y saldo que perder.
test('no se rebota a un remitente cuyo buzón cobra estampilla: el rebote se lo cobraría al asistente', async () => {
  const atacante = Agent.create(`atacante@${H}`, URL_CASA, { hosts });
  await atacante.register({ adminToken: 't', inbox: { policy: 'stamp', price: 25 } });
  await casa.libro.topup(rosetta.address, 5000, 'carga de prueba');
  await casa.agregarContactos('rosetta', [atacante.address]);
  casa.resolver.invalidate(`agent:${rosetta.address}`);
  const saldoAntes = (await rosetta.balance(H)).balance;
  const n = pedidos.length;
  const env = await atacante.send({ to: rosetta.address, type: 'intro', body: 'cóbrame el rebote' });
  await espera(700); await casa.tick({ programado: true });
  await espera(400); await casa.tick({ programado: true });
  assert.equal(pedidos.length, n, 'un tipo que no se atiende no cuesta una llamada a la API');
  assert.equal((await casa.store.listMail('rosetta')).length, 0, 'el sobre quedó confirmado, no eterno');
  const suyos = (await atacante.inbox()).filter((x) => x.envelope.from === rosetta.address && x.envelope.in_reply_to === env.id);
  assert.deepEqual(suyos, [], 'se le rebotó a un buzón que cobra estampilla');
  assert.equal((await rosetta.balance(H)).balance, saldoAntes, 'el asistente pagó una estampilla por rebotar');
  // Y a un remitente normal de la lista sí se le rebota (silencio): el guardia es por estampilla.
  const env2 = await amiga.send({ to: rosetta.address, type: 'intro', body: 'yo sí' });
  const r = await amiga.waitFor((e) => e.from === rosetta.address && e.in_reply_to === env2.id, { timeoutMs: 8000 });
  assert.equal((await amiga.open(r.envelope)).content.body, NO_ATIENDE('intro', TIPOS_ATENDIDOS));
});

// ---------- 3. las manos ----------

test('sin `tools` no hay manos, y una dirección de sólo mensajes nunca recibe la de la notaría', () => {
  const raizRec = { inbox: { policy: 'open' } };
  const delegadoRec = { delegation: { by: duena.address, scope: { messages_only: true } } };
  assert.deepEqual(herramientasDe({ tools: false }, raizRec), []);
  assert.deepEqual(herramientasDe({}, raizRec), [], 'por defecto, apagadas');
  assert.deepEqual(herramientasDe({ tools: true }, raizRec).map((x) => x.name), NOMBRES);
  assert.deepEqual(herramientasDe({ tools: true }, delegadoRec).map((x) => x.name), NOMBRES.filter((x) => x !== 'nyx5_notarizar'));
});

test('el cerebro manda un mensaje con nyx5_enviar y llega FIRMADO por esa dirección, con la llave de la bóveda', async () => {
  const n = pedidos.length;
  const t0 = Date.now();
  proximas.push(usa([{ name: 'nyx5_enviar', input: { to: amiga.address, body: 'me pidieron avisarte del plazo' } }]));
  proximas.push(texto('listo: le avisé a amiga.'));
  await duena.send({ to: rosetta.address, body: 'avísale a amiga del plazo' });
  const aviso = await respuestaA(amiga, t0, rosetta.address);
  const abierto = await amiga.open(aviso.envelope);
  assert.equal(abierto.content.body, 'me pidieron avisarte del plazo');
  assert.equal(abierto.encrypted, true, 'el sobre de una mano va cifrado como cualquiera');
  assert.equal(aviso.envelope.signature.kid, rosetta.keys.sig, 'lo firmó la llave de rosetta@, no la de la casa');
  const r = await respuestaA(duena, t0, rosetta.address);
  assert.match((await duena.open(r.envelope)).content.body, /le avisé a amiga/);
  // Lo que se le mandó a la API: la lista de herramientas, y el turno del asistente devuelto COMPLETO
  // (con su bloque de pensamiento y su firma: perderlo invalida el turno con herramientas).
  const llamadas = pedidos.slice(n);
  assert.equal(llamadas.length, 2, `dos llamadas: la que pide la herramienta y la que cierra (${llamadas.length})`);
  assert.deepEqual(llamadas[0].body.tools.map((x) => x.name), NOMBRES);
  const turno = llamadas[1].body.messages.find((x) => x.role === 'assistant' && Array.isArray(x.content));
  assert.ok(turno, 'el turno del asistente no volvió como bloques');
  const pensar = turno.content.find((b) => b.type === 'thinking');
  assert.equal(pensar?.signature, 'firma-de-prueba', 'el bloque de pensamiento volvió sin su firma');
  const uso = turno.content.find((b) => b.type === 'tool_use');
  assert.deepEqual(uso.input, { to: amiga.address, body: 'me pidieron avisarte del plazo' }, 'la entrada se armó mal desde el flujo');
  const res = llamadas[1].body.messages.at(-1).content[0];
  assert.equal(res.type, 'tool_result');
  assert.equal(res.tool_use_id, uso.id);
  assert.match(res.content, /"sent":true/);
});

test('nyx5_enviar a alguien fuera de la lista se rechaza, nombrando a quién sí puede escribirle, y nada sale', async () => {
  const t0 = Date.now();
  proximas.push(usa([{ name: 'nyx5_enviar', input: { to: extrano.address, body: 'hola extraño' } }]));
  proximas.push(texto('no puedo escribirle a esa dirección.'));
  await duena.send({ to: rosetta.address, body: 'escríbele al extraño' });
  await respuestaA(duena, t0, rosetta.address);
  const res = pedidos.at(-1).body.messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /is not on your list/);
  assert.match(res.content, /duena@vivos\.test/, 'le dice a quién sí puede escribirle');
  const suyos = (await extrano.inbox()).filter((x) => x.envelope.from === rosetta.address);
  assert.deepEqual(suyos, [], 'al extraño no le llegó nada');
});

test('nyx5_enviar: ni a un grupo, ni a libro@, ni a sí misma, y el tope es de cinco envíos por turno', async () => {
  const g = await duena.createGroup('sala-vivos', { members: [rosetta.address, amiga.address] });
  const t0 = Date.now();
  proximas.push(usa([
    { name: 'nyx5_enviar', input: { to: g.address, body: 'al grupo' } },
    { name: 'nyx5_enviar', input: { to: `libro@${H}`, body: 'una op' } },
    { name: 'nyx5_enviar', input: { to: rosetta.address, body: 'a mí misma' } },
    { name: 'nyx5_enviar', input: { to: 'no es direccion', body: 'x' } },
  ]));
  proximas.push(texto('nada de eso se pudo.'));
  await duena.send({ to: rosetta.address, body: 'prueba los bordes' });
  await respuestaA(duena, t0, rosetta.address);
  const malos = pedidos.at(-1).body.messages.at(-1).content;
  assert.equal(malos.length, 4);
  assert.ok(malos.every((x) => x.is_error === true), JSON.stringify(malos));
  assert.match(malos[0].content, /cannot write to a group/);
  assert.match(malos[1].content, /protocol address of the house/);
  assert.match(malos[2].content, /your own address/);
  assert.match(malos[3].content, /is not an address/);
  // El tope: seis envíos en un turno, cinco salen y el sexto vuelve como error.
  const t1 = Date.now();
  proximas.push(usa(Array.from({ length: MAX_ENVIOS + 1 }, (_, i) => ({ name: 'nyx5_enviar', input: { to: amiga.address, body: `tanda ${i}` } }))));
  proximas.push(texto('mandé lo que pude.'));
  await duena.send({ to: rosetta.address, body: 'manda seis' });
  await respuestaA(duena, t1, rosetta.address);
  const seis = pedidos.at(-1).body.messages.at(-1).content;
  assert.equal(seis.length, MAX_ENVIOS + 1);
  assert.equal(seis.filter((x) => !x.is_error).length, MAX_ENVIOS, 'salieron más de cinco');
  assert.match(seis.at(-1).content, new RegExp(`already sent ${MAX_ENVIOS} messages`));
  await espera(600); await casa.tick({ programado: true });
  const recibidos = (await amiga.inbox()).filter((x) => x.envelope.from === rosetta.address && /^tanda /.test(x.envelope.content?.body ?? ''));
  assert.ok(recibidos.length <= MAX_ENVIOS, `llegaron ${recibidos.length} de la tanda`);
});

test('una herramienta que no existe se contesta como que no existe y el turno sigue; buscar, historial y notarizar funcionan', async () => {
  const t0 = Date.now();
  proximas.push(usa([
    { name: 'nyx5_pagar', input: { to: amiga.address, amount: 100 } },
    { name: 'nyx5_buscar', input: { q: 'rosetta' } },
    { name: 'nyx5_historial', input: { address: amiga.address } },
    { name: 'nyx5_notarizar', input: { sha256: 'a'.repeat(64), name: 'informe' } },
    { name: 'nyx5_recordar', input: { body: 'retomar el plazo', cuando: new Date(Date.now() + 3600_000).toISOString() } },
  ]));
  proximas.push(texto('eso es todo.'));
  await duena.send({ to: rosetta.address, body: 'usa todo' });
  await respuestaA(duena, t0, rosetta.address);
  const res = pedidos.at(-1).body.messages.at(-1).content;
  assert.equal(res.length, 5);
  assert.equal(res[0].is_error, true);
  assert.match(res[0].content, /There is no tool called nyx5_pagar/);
  assert.ok(!res[1].is_error, `buscar falló: ${res[1].content}`);
  assert.match(res[1].content, /"agents"/);
  assert.ok(!res[2].is_error, `historial falló: ${res[2].content}`);
  assert.ok(!res[3].is_error, `notarizar falló: ${res[3].content}`);
  assert.match(res[3].content, /"requested":true/);
  assert.ok(!res[4].is_error, `recordar falló: ${res[4].content}`);
  // El sello existe de verdad: la op entró al Libro por la puerta de todos, firmada por rosetta@.
  await espera(600); await casa.tick({ programado: true });
  const sellos = await casa.store.notariaList('a'.repeat(64));
  assert.equal(sellos.length, 1, 'el hash no quedó sellado');
  assert.equal(sellos[0].by, rosetta.address);
});

test('nyx5_recordar: un recordatorio inmediato se rechaza (sería un bucle), y uno por turno es el tope', async () => {
  const t0 = Date.now();
  proximas.push(usa([
    { name: 'nyx5_recordar', input: { body: 'ya', cuando: new Date(Date.now() + 1000).toISOString() } },
    { name: 'nyx5_recordar', input: { body: 'mañana', cuando: new Date(Date.now() + 86_400_000).toISOString() } },
    { name: 'nyx5_recordar', input: { body: 'otro más', cuando: new Date(Date.now() + 90_000_000).toISOString() } },
  ]));
  proximas.push(texto('agendado.'));
  await duena.send({ to: rosetta.address, body: 'agenda' });
  await respuestaA(duena, t0, rosetta.address);
  const res = pedidos.at(-1).body.messages.at(-1).content;
  assert.equal(res[0].is_error, true);
  assert.match(res[0].content, /at least five minutes/);
  assert.ok(!res[1].is_error, `el de mañana falló: ${res[1].content}`);
  assert.equal(res[2].is_error, true, `el tope es ${MAX_RECORDATORIOS} por turno`);
});

test('el tope de rondas: el modelo que sigue pidiendo herramientas recibe el motivo y cierra con texto', async () => {
  const n = pedidos.length;
  const t0 = Date.now();
  // MAX_PASOS rondas ejecutadas + la que pide una más y recibe el motivo; la siguiente cierra.
  for (let i = 0; i <= MAX_PASOS; i++) proximas.push(usa([{ name: 'nyx5_historial', input: { address: amiga.address } }]));
  proximas.push(texto('me quedé sin rondas.'));
  await duena.send({ to: rosetta.address, body: 'insiste' });
  const r = await respuestaA(duena, t0, rosetta.address);
  assert.match((await duena.open(r.envelope)).content.body, /sin rondas/);
  const llamadas = pedidos.slice(n);
  assert.ok(llamadas.length <= MAX_PASOS + 2, `${llamadas.length} llamadas en un turno con tope ${MAX_PASOS}`);
  const corte = llamadas.at(-1).body.messages.at(-1).content[0];
  assert.equal(corte.is_error, true);
  assert.match(corte.content, /No more tool calls this turn/);
  proximas.length = 0;
});

test('el tope en dólares manda sobre las herramientas: pasado el tope a mitad de turno no se ejecuta ninguna más', async () => {
  const mes = new Date().toISOString().slice(0, 7);
  const n = pedidos.length;
  const t0 = Date.now();
  proximas.push(usa([{ name: 'nyx5_enviar', input: { to: amiga.address, body: 'esto no debería salir' } }]));
  proximas.push(texto('sin presupuesto.'));
  // Se deja el gasto justo por debajo y la primera llamada lo pasa: el corte ocurre a mitad de turno.
  await casa.store.kvPut('asistente-gasto', `rosetta:${mes}`, { usd: 4.9999, llamadas: 1, avisado: true });
  await admin('PUT', '/admin/assistants/rosetta/config', { budget_usd: 5 });
  await duena.send({ to: rosetta.address, body: 'manda algo' });
  await respuestaA(duena, t0, rosetta.address);
  const res = pedidos.at(-1).body.messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /ran out of its monthly budget/);
  const suyos = (await amiga.inbox()).filter((x) => x.envelope.content?.body === 'esto no debería salir');
  assert.deepEqual(suyos, [], 'se ejecutó una herramienta sin presupuesto');
  assert.ok(pedidos.length - n <= 2);
  await casa.store.kvPut('asistente-gasto', `rosetta:${mes}`, { usd: 0, llamadas: 0, avisado: false });
});

test('un recordatorio propio despierta al agente y NO se contesta a sí mismo (sería un bucle); el cupo del día lo acota', async () => {
  const n = pedidos.length;
  proximas.push(texto('retomé el plazo.'));
  await rosetta.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: 'retoma el plazo' });
  await espera(600); await casa.tick({ programado: true });
  await espera(400); await casa.tick({ programado: true });
  assert.ok(pedidos.length > n, 'el recordatorio propio no despertó al agente');
  assert.match(pedidos.at(-1).body.messages.at(-1).content, /recordatorio que te dejaste/);
  assert.equal((await casa.store.listMail('rosetta')).length, 0, 'el recordatorio quedó confirmado');
  const propios = (await casa.store.listMailHistory('rosetta', { limit: 100 })).filter((x) => x.envelope.from === rosetta.address);
  assert.equal(propios.length, 1, 'se contestó a sí misma: hay más de un sobre propio');
  // El cupo: pasado el día, un recordatorio más se cierra sin llamar a la API.
  const dia = new Date().toISOString().slice(0, 10);
  await casa.store.kvPut('asistente-despertar', `rosetta:${dia}`, CUPO_DESPERTAR + 5);
  const n2 = pedidos.length;
  await rosetta.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: 'otra vez' });
  await espera(600); await casa.tick({ programado: true });
  await espera(400); await casa.tick({ programado: true });
  assert.equal(pedidos.length, n2, 'pasado el cupo del día, un recordatorio propio no cuesta nada');
  assert.equal((await casa.store.listMail('rosetta')).length, 0);
  await casa.store.kvPut('asistente-despertar', `rosetta:${dia}`, 0);
});

// El mismo bucle por la otra puerta: pasado el tope en dólares, el aviso «llegué a mi tope» no se
// manda a sí misma. Si se mandara, ese aviso es otro sobre propio, y el turno siguiente lo atiende.
test('pasado el tope en dólares, un recordatorio propio se cierra sin mandarse nada a sí misma', async () => {
  const mes = new Date().toISOString().slice(0, 7);
  const propiosAntes = (await casa.store.listMailHistory('rosetta', { limit: 200 })).filter((x) => x.envelope.from === rosetta.address).length;
  const n = pedidos.length;
  await casa.store.kvPut('asistente-gasto', `rosetta:${mes}`, { usd: 999, llamadas: 1, avisado: true });
  await rosetta.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: 'sin presupuesto' });
  await espera(600); await casa.tick({ programado: true });
  await espera(400); await casa.tick({ programado: true });
  assert.equal(pedidos.length, n, 'pasado el tope no se llama a la API');
  assert.equal((await casa.store.listMail('rosetta')).length, 0, 'el recordatorio quedó confirmado');
  const propiosDespues = (await casa.store.listMailHistory('rosetta', { limit: 200 })).filter((x) => x.envelope.from === rosetta.address).length;
  assert.equal(propiosDespues, propiosAntes + 1, 'se mandó un aviso a sí misma: ese es el bucle');
  await casa.store.kvPut('asistente-gasto', `rosetta:${mes}`, { usd: 0, llamadas: 0, avisado: false });
});

// El guardia que sostiene a `recordar`, y con él la memoria entre sesiones de un agente vivo.
test('un sobre a sí mismo pasa su propia política (grito: antes rebotaba o se cobraba) y la de los demás sigue cerrada (silencio)', async () => {
  const porLista = Agent.create(`solitaria@${H}`, URL_CASA, { hosts });
  await porLista.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [duena.address] } });
  const env = await porLista.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: 'nota para mi yo futuro' });
  const mio = await porLista.waitFor((e) => e.id === env.id, { timeoutMs: 8000 });
  assert.equal((await porLista.open(mio.envelope)).content.body, 'nota para mi yo futuro');
  // Un buzón con estampilla se cobraba a SÍ MISMO: con saldo cero, el recordatorio no llegaba nunca.
  const conSello = Agent.create(`cobradora@${H}`, URL_CASA, { hosts });
  await conSello.register({ adminToken: 't', inbox: { policy: 'stamp', price: 25 } });
  assert.equal((await conSello.balance(H)).balance, 0, 'esta prueba sólo vale con saldo cero');
  const env2 = await conSello.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: 'sin pagarme a mí misma' });
  const mio2 = await conSello.waitFor((e) => e.id === env2.id, { timeoutMs: 8000 });
  assert.equal((await conSello.open(mio2.envelope)).content.body, 'sin pagarme a mí misma');
  assert.equal((await conSello.balance(H)).balance, 0, 'se cobró una estampilla a sí misma');
  // Silencio: la lista y la estampilla siguen cerradas para los demás.
  await extrano.send({ to: porLista.address, body: 'y yo?' });
  const rebote = await extrano.waitFor((e) => e.from === `postmaster@${H}`, { timeoutMs: 8000 });
  assert.match(JSON.stringify((await extrano.open(rebote.envelope)).content.body), /allowlist/);
});

test('destinosDe: el dueño y la lista del buzón, sin repetidos; un buzón abierto sin dueño no deja escribirle a nadie', () => {
  assert.deepEqual(destinosDe({ owner: duena.address, free_for: [amiga.address] }, { inbox: { policy: 'allowlist', allowlist: [duena.address, extrano.address] } }),
    [duena.address, amiga.address, extrano.address]);
  assert.deepEqual(destinosDe({}, { inbox: { policy: 'open' } }), []);
  assert.deepEqual(destinosDe({ owner: 'no es direccion' }, { inbox: { policy: 'open' } }), []);
});

test('ejecutar: cada nombre declarado tiene mano (una entrada mala da error de la mano, no de inexistencia)', async () => {
  const ctx = { est: casa, agente: await casa.agenteDeBoveda('rosetta'), cfg: {}, rec: {}, propia: rosetta.address, domain: H, nowMs: Date.now(), disponibles: [...NOMBRES], estado: { envios: 0, recordatorios: 0 } };
  for (const nombre of NOMBRES) {
    const r = await ejecutar(ctx, nombre, {});
    assert.equal(r.is_error, true, `${nombre} aceptó una entrada vacía`);
    assert.ok(!/There is no tool called/.test(r.content), `${nombre} está declarada y no tiene mano`);
  }
  assert.match((await ejecutar(ctx, 'constructor', {})).content, /There is no tool called/, 'el despacho se llega por prototipo');
  assert.match((await ejecutar(ctx, '__proto__', {})).content, /There is no tool called/);
  // Una herramienta que existe pero no está disponible para este asistente tampoco se ejecuta.
  const sinNotaria = { ...ctx, disponibles: NOMBRES.filter((x) => x !== 'nyx5_notarizar') };
  assert.match((await ejecutar(sinNotaria, 'nyx5_notarizar', { sha256: 'b'.repeat(64) })).content, /not available to you/);
});

// ---------- quitar el cerebro ----------

test('DELETE deja la dirección VIVA y sin cerebro: la tarjeta dice que la custodia terminó y la llave sale de la bóveda', async () => {
  const r = await admin('DELETE', '/admin/assistants/rosetta');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.removed, true);
  assert.equal(r.body.alive, true);
  assert.equal(r.body.custody.keys, 'self');
  assert.equal(r.body.custody.was, 'assistant');
  const card = await casa.store.getAgent('rosetta');
  assert.ok(card && !card.revoked, 'la dirección se murió al quitarle el cerebro');
  assert.equal(card.custody.keys, 'self');
  assert.equal(card.custody.via, null);
  assert.equal(await casa.llavesDeBoveda('rosetta'), null, 'la llave sigue en la bóveda');
  assert.equal((await admin('GET', '/admin/assistants/rosetta')).status, 404);
  assert.deepEqual((await casa.store.kvGet('asistente', '_indice')).filter((x) => x === 'rosetta'), []);
  // Y la dirección sigue recibiendo: el buzón es de ella, no del cerebro.
  const n = pedidos.length;
  const env = await duena.send({ to: rosetta.address, body: 'sigues viva?' });
  await espera(400); await casa.tick({ programado: true });
  assert.equal(pedidos.length, n, 'sin cerebro no hay llamada a la API');
  assert.ok((await casa.store.listMail('rosetta')).some((x) => x.envelope.id === env.id), 'el sobre llegó a su buzón');
  // Su dueña la sigue manejando con su propia llave, que nunca dejó de ser suya.
  const propio = await rosetta.send({ to: duena.address, body: 'sigo siendo yo' });
  assert.ok(propio.id);
});

// ---------- el lector del flujo ----------

test('leerFlujo arma los bloques por índice, conserva el pensamiento con su firma y tolera un JSON de herramienta cortado', async () => {
  const cuerpo = sse({ content: [{ type: 'thinking', thinking: '', signature: 'xyz' }, { type: 'text', text: 'hola' }, { type: 'tool_use', id: 'tu_1', name: 'nyx5_historial', input: { address: 'a@b.test' } }], stop_reason: 'tool_use', usage: USO });
  const j = await leerFlujo(new Response(cuerpo, { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepEqual(j.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.equal(j.content[0].signature, 'xyz');
  assert.equal(j.content[1].text, 'hola');
  assert.deepEqual(j.content[2].input, { address: 'a@b.test' });
  assert.equal(j.stop_reason, 'tool_use');
  assert.equal(j.usage.output_tokens, USO.output_tokens);
  // Cortado por largo: la entrada queda vacía y la mano la rechaza por nombre, no revienta.
  const roto = cuerpo.replace('{"address":"a@b.test"}'.slice(0, 7), '{"addre');
  const cortado = cuerpo.split('\n\n').filter((x) => !/input_json_delta","partial_json":"b.test/.test(x)).join('\n\n');
  for (const texto2 of [roto, cortado.replace(/"partial_json":"\{"/, '"partial_json":"{')]) {
    const k = await leerFlujo(new Response(texto2, { headers: { 'content-type': 'text/event-stream' } }));
    const u = k.content.find((b) => b.type === 'tool_use');
    assert.ok(u, 'se perdió el bloque de herramienta');
    assert.equal(typeof u.input, 'object');
  }
  // Un flujo sin content_block_start (lo que mandaba la prueba vieja) no pierde el texto.
  const viejo = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'suelto' } })}\n\n`;
  const v = await leerFlujo(new Response(viejo, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(v.content[0].text, 'suelto');
});

// Un asistente DELEGADO de sólo mensajes, como el de Sigo: el modo que ya estaba desplegado.
async function altaDelegado(nombre, config) {
  const d = await duena.delegate(nombre, { scope: { messages_only: true }, inbox: { policy: 'allowlist', allowlist: [duena.address, amiga.address] } });
  const r = await admin('POST', '/admin/assistants', { local: d.local, keys: d.keys, config: { persona: 'Eres un asistente de prueba.', ...config } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return d;
}

// ---------- 4. el tope de ENTRADA (decisión de Nicholas, 26-oct-2026) ----------
// Nació de un defecto medido: el historial reenviaba cada pregunta anterior, así que el costo de un
// hilo crecía con el CUADRADO de los mensajes y al turno 13 la petición pasaba del millón de tokens
// (400 de la API) y el hilo quedaba trabado para siempre. `scripts/revision-vivos/a1-*.mjs` lo mide.

test('una pregunta sobre el tope NO llama a la API, contesta cuánto es el máximo y no queda eterna (grito); una justo por debajo sí pasa (silencio)', async () => {
  const asis = await altaDelegado('topes', { budget_usd: 5 });
  const n = pedidos.length;
  const largo = LIMITES_ENTRADA.pregunta + 1_000;
  const larga = await duena.send({ to: asis.address, body: 'L'.repeat(largo) });
  const r = await duena.waitFor((e) => e.from === asis.address && e.in_reply_to === larga.id, { timeoutMs: 15_000 });
  assert.equal((await duena.open(r.envelope)).content.body, DEMASIADO_LARGO(largo));
  assert.equal(pedidos.length, n, `una pregunta sobre el tope costó ${pedidos.length - n} llamadas a la API`);
  assert.equal((await casa.store.listMail(asis.local)).length, 0, 'la pregunta larga quedó pendiente para siempre');
  const bajo = await duena.send({ to: asis.address, body: 'c'.repeat(LIMITES_ENTRADA.pregunta - 1_000) });
  const r2 = await duena.waitFor((e) => e.from === asis.address && e.in_reply_to === bajo.id, { timeoutMs: 15_000 });
  assert.match((await duena.open(r2.envelope)).content.body, /^respuesta \d+/, 'una pregunta bajo el tope no se contestó');
  assert.ok(pedidos.length > n, 'una pregunta bajo el tope tiene que llamar a la API');
});

test('del historial viajan seis cartas: con siete turnos previos las primeras ya no van, y una carta sobre el tope viaja cortada', async () => {
  const asis = await altaDelegado('hist', { budget_usd: 5 });
  for (let i = 1; i <= 7; i++) {
    const e = await duena.send({ to: asis.address, body: `marca-${i}` });
    await duena.waitFor((x) => x.from === asis.address && x.in_reply_to === e.id, { timeoutMs: 15_000 });
  }
  const n = pedidos.length;
  const ultima = await duena.send({ to: asis.address, body: 'la pregunta de ahora' });
  await duena.waitFor((x) => x.from === asis.address && x.in_reply_to === ultima.id, { timeoutMs: 15_000 });
  const enviado = JSON.stringify(pedidos[n].body.messages);
  // Seis CARTAS, propias y ajenas: con siete preguntas contestadas, las seis últimas son las tres
  // más recientes y sus tres respuestas. Las cuatro primeras preguntas ya no viajan.
  const presentes = [1, 2, 3, 4, 5, 6, 7].filter((i) => enviado.includes(`marca-${i}`));
  const respuestas = (enviado.match(/respuesta \d+/g) || []).length;
  const cartas = presentes.length + respuestas;
  assert.ok(cartas <= LIMITES_ENTRADA.turnos, `viajaron ${cartas} cartas de historial (marcas ${presentes.join(',')} + ${respuestas} respuestas), y el tope es ${LIMITES_ENTRADA.turnos}`);
  assert.ok(!presentes.includes(1) && !presentes.includes(2), `viajaron las marcas ${presentes.join(',')}: las primeras tienen que quedar fuera`);
  assert.ok(presentes.includes(7), 'la última pregunta contestada tiene que seguir en el historial');
  assert.ok(enviado.includes('la pregunta de ahora'), 'la pregunta de ahora tiene que viajar');
  // Una carta que se rechazó por larga SIGUE en el historial: tiene que viajar cortada, o el tope
  // se evita por la puerta de al lado (mandar una enorme y después una corta).
  await duena.send({ to: asis.address, body: 'X'.repeat(LIMITES_ENTRADA.pregunta + 5_000) });
  await duena.waitFor((x) => x.from === asis.address && /máximo que puedo leer/.test(x.content?.body || ''), { timeoutMs: 15_000 }).catch(() => {});
  await espera(600); await casa.tick({ programado: true });
  const n2 = pedidos.length;
  const corta = await duena.send({ to: asis.address, body: 'y esta sí es corta' });
  await duena.waitFor((x) => x.from === asis.address && x.in_reply_to === corta.id, { timeoutMs: 15_000 });
  const conCorte = JSON.stringify(pedidos[n2].body.messages);
  assert.ok(conCorte.includes(CORTADO.trim()), 'la carta larga del historial viajó sin cortar');
  assert.ok(conCorte.length < (LIMITES_ENTRADA.turnos + 1) * LIMITES_ENTRADA.pregunta, `el historial pesó ${conCorte.length}`);
});

test('el turno más caro posible queda acotado y NO crece con los turnos: cada petición cabe en (6+1) topes', async () => {
  const asis = await altaDelegado('caro', { budget_usd: 50 });
  const bytes = [];
  for (let i = 0; i < 6; i++) {
    const n = pedidos.length;
    const e = await duena.send({ to: asis.address, body: `T${i} ` + 'g'.repeat(LIMITES_ENTRADA.pregunta - 10) });
    await duena.waitFor((x) => x.from === asis.address && x.in_reply_to === e.id, { timeoutMs: 20_000 });
    if (pedidos.length > n) bytes.push(pedidos[n].bytes);
  }
  const cota = (LIMITES_ENTRADA.turnos + 1) * LIMITES_ENTRADA.pregunta;
  assert.ok(bytes.length >= 4, `se midieron ${bytes.length} turnos`);
  for (const b of bytes) assert.ok(b <= cota, `una petición pesó ${b} bytes, sobre la cota ${cota}`);
  // Lo que importa no es sólo el tope: es que el turno 6 no cueste más que el turno 3. Con el
  // historial sin tope, la última medía 4 veces la primera (medido: 102, 200, 297 y 395 KB).
  const ultimas = bytes.slice(-3);
  assert.ok(Math.max(...ultimas) <= Math.min(...ultimas) * 1.5, `el costo por turno sigue creciendo: ${bytes.join(', ')}`);
});

test('el tope vive en UNA constante: la fuente no trae otra copia del número ni otro límite de historial', () => {
  const fuente = fs.readFileSync(path.join(raiz, 'src/correo/asistente.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const sinDefinicion = fuente.replace(/export const LIMITES_ENTRADA[^\n]*\n/, '');
  assert.equal(/\b40[._]?000\b/.test(sinDefinicion), false, 'hay una segunda copia del tope en la fuente');
  assert.match(fuente, /conversacion\(local, \{ con: de, limit: LIMITES_ENTRADA\.turnos \}\)/, 'el historial no lee el tope de la constante');
  assert.ok((sinDefinicion.match(/LIMITES_ENTRADA\.pregunta/g) || []).length >= 3, 'el tope se usa en menos lugares de los que debería (rechazo, recorte, y la propia cota)');
  assert.deepEqual(Object.keys(LIMITES_ENTRADA), ['pregunta', 'turnos']);
  assert.equal(Object.isFrozen(LIMITES_ENTRADA), true);
});

// ---------- 5. ideas@ no es alcanzable por una mano (decisión de Nicholas, 26-oct-2026) ----------
// Importa que sea GRITO de verdad: el alta de ideas@ AGREGA ideas@ a la lista de cada dirección
// local que filtre por lista, así que sin esta guardia todo agente vivo lo tenía a tiro.

test('ideas@ no es alcanzable por una mano aunque esté en la lista del buzón (grito), ni en otra casa, y el nombre es el que reserva el protocolo', async () => {
  assert.equal(IDEAS, IDEAS_LOCAL, 'la guardia de las manos y el buzón de ideas no se llaman igual');
  const asis = await altaDelegado('conideas', { budget_usd: 5, tools: true });
  // Lo que hace el alta de ideas@ con las direcciones que ya existían: meterse en su lista.
  await casa.agregarContactos(asis.local, [`ideas@${H}`]);
  casa.resolver.invalidate(`agent:${asis.address}`);
  const rec = await casa.store.getAgent(asis.local);
  const cfg = await casa.store.kvGet('asistente', asis.local);
  assert.ok(destinosDe(cfg, rec).includes(`ideas@${H}`), 'la prueba no reprodujo la condición: ideas@ no quedó en la lista');
  const ctx = { est: casa, agente: await casa.agenteDeBoveda(asis.local), cfg, rec, propia: asis.address, domain: H, nowMs: Date.now(), disponibles: [...NOMBRES], estado: { envios: 0, recordatorios: 0 }, cupo: async () => ({ ok: true, tope: CUPO_ENVIOS_DIA }) };
  const ideasAntes = (await casa.store.listMail(IDEAS_LOCAL)).length;
  for (const destino of [`ideas@${H}`, 'ideas@otra.test']) {
    const r = await ejecutar(ctx, 'nyx5_enviar', { to: destino, body: 'anótame esta idea' });
    assert.equal(r.is_error, true, `una mano le escribió a ${destino}`);
    assert.match(r.content, /inbox of a person/);
  }
  assert.equal(ctx.estado.envios, 0, 'se contó un envío que no salió');
  await espera(300); await casa.tick({ programado: true });
  assert.equal((await casa.store.listMail(IDEAS_LOCAL)).length, ideasAntes, 'algo llegó al buzón de ideas');
  // Silencio: a una dirección normal de su lista sí le escribe.
  const ok = await ejecutar(ctx, 'nyx5_enviar', { to: duena.address, body: 'esto sí puede salir' });
  assert.ok(!ok.is_error, `la guardia se llevó lo bueno: ${ok.content}`);
});

test('una mano no le escribe a una dirección de protocolo de NINGUNA casa (grito: antes sólo se miraba la de esta casa)', async () => {
  const asis = await altaDelegado('ajenas', { budget_usd: 5, tools: true });
  await casa.agregarContactos(asis.local, ['libro@otra.test', 'postmaster@otra.test', 'verifica@otra.test', 'tareas@otra.test']);
  casa.resolver.invalidate(`agent:${asis.address}`);
  const rec = await casa.store.getAgent(asis.local);
  const cfg = await casa.store.kvGet('asistente', asis.local);
  const ctx = { est: casa, agente: await casa.agenteDeBoveda(asis.local), cfg, rec, propia: asis.address, domain: H, nowMs: Date.now(), disponibles: [...NOMBRES], estado: { envios: 0, recordatorios: 0 }, cupo: async () => ({ ok: true, tope: CUPO_ENVIOS_DIA }) };
  const destinos = destinosDe(cfg, rec);
  for (const nombre of NO_ESCRIBIR) {
    const ajena = `${nombre}@otra.test`;
    assert.ok(destinos.includes(ajena), `la prueba no reprodujo la condición: ${ajena} no quedó en la lista`);
    const r = await ejecutar(ctx, 'nyx5_enviar', { to: ajena, body: JSON.stringify({ op: 'pay', amount: 999 }) });
    assert.equal(r.is_error, true, `una mano le mandó una op a ${ajena}`);
    assert.match(r.content, /protocol address/);
    const propia2 = `${nombre}@${H}`;
    const r2 = await ejecutar(ctx, 'nyx5_enviar', { to: propia2, body: 'x' });
    assert.equal(r2.is_error, true, `una mano le escribió a ${propia2}`);
  }
  assert.equal(ctx.estado.envios, 0);
  assert.match((await ejecutar(ctx, 'nyx5_enviar', { to: `libro@${H}`, body: 'x' })).content, /only takes signed operations/);
});

test('los dos textos que lee quien escribe son los que Nicholas aprobó: fijados byte a byte (CLAUDE.md §5)', () => {
  assert.equal(NO_ATIENDE('intro', ['message', 'task', 'result']),
    'I do not handle envelopes of type "intro". I handle: message, task, result. Nothing was done with this one; send it again as one of those types if you want an answer.');
  // Aprobado el 27-oct-2026, en inglés como el de arriba, y con separador de miles en coma.
  assert.equal(DEMASIADO_LARGO(41_000),
    'Your message is 41,000 characters and the most I can read is 40,000. I did not read it: send it again shorter, or in parts.');
  assert.equal(DEMASIADO_LARGO(1_234_567).startsWith('Your message is 1,234,567 characters '), true);
  // La marca del historial NO la lee una persona: va en el prompt y sigue en español.
  assert.equal(CORTADO, '\n[cortado aquí: supera el tope de 40.000 caracteres]');
});

// ---------- 6. los contadores que son el único freno: el gasto y el volumen ----------

test('el gasto del mes se cuenta ATÓMICO: dos turnos a la vez no pierden una llamada (grito con la suma leída-sumada-escrita)', async () => {
  const asis = await altaDelegado('plata', { budget_usd: 5 });
  const mes = new Date().toISOString().slice(0, 7);
  clearInterval(casa.timer);
  const tickReal = casa.tick.bind(casa);
  casa.tick = async () => {};
  try {
    await casa.store.kvDelete('asistente-gasto', `${asis.local}:${mes}`);
    await casa.store.kvDelete('asistente-gasto', `${asis.local}:${mes}:n`);
    await duena.send({ to: asis.address, body: 'una' });
    await amiga.send({ to: asis.address, body: 'otra' });
    for (let i = 0; i < 3; i++) { await tickReal({ programado: false }); await espera(50); }
    assert.equal((await casa.store.listMail(asis.local)).length, 2, 'los dos sobres tienen que estar pendientes');
    const n = pedidos.length;
    demora = 80;   // la ventana de la carrera: sin ella el servidor local serializa
    await Promise.all([atenderAsistentes(casa, { maxPorTick: 2 }), atenderAsistentes(casa, { maxPorTick: 2 })]);
    demora = 0;
    const llamadas = pedidos.length - n;
    assert.equal(llamadas, 2, `se esperaban dos llamadas concurrentes y hubo ${llamadas}`);
    const g = await gastoDe(casa.store, asis.local, mes);
    assert.equal(g.llamadas, llamadas, `la API se llamó ${llamadas} veces y quedaron anotadas ${g.llamadas}: el tope mensual cuenta de menos`);
    assert.ok(g.usd > 0, 'no se anotó gasto');
    // Y el lector sigue entendiendo la forma vieja `{ usd, llamadas }` que ya hay en producción.
    await casa.store.kvPut('asistente-gasto', `${asis.local}:${mes}`, { usd: 2.5, llamadas: 7, avisado: true });
    const viejo = await gastoDe(casa.store, asis.local, mes);
    assert.deepEqual([viejo.usd, viejo.llamadas, viejo.avisado], [2.5, 7, true], 'el gasto del mes en curso se perdió al cambiar de forma');
    assert.equal(await casa.store.kvGet('asistente-gasto', `${asis.local}:${mes}`), 2_500_000, 'no se convirtió a micro-dólares');
  } finally {
    casa.tick = tickReal;
    casa.timer = setInterval(() => casa.tick().catch(() => {}), casa.workerIntervalMs);
    casa.timer.unref?.();
  }
});

test('el cupo de envíos del DÍA acota el volumen que el tope por turno no acota (grito), y con cupo los cinco del turno salen (silencio)', async () => {
  const asis = await altaDelegado('volumen', { budget_usd: 5, tools: true });
  const dia = new Date().toISOString().slice(0, 10);
  const clave = `${asis.local}:${dia}`;
  // Silencio primero: con el contador en cero, los cinco del turno salen.
  await casa.store.kvPut('asistente-envios', clave, 0);
  const t0 = Date.now();
  proximas.push(usa(Array.from({ length: MAX_ENVIOS }, (_, i) => ({ name: 'nyx5_enviar', input: { to: amiga.address, body: `cupo-si ${i}` } }))));
  proximas.push(texto('salieron'));
  await duena.send({ to: asis.address, body: 'manda cinco' });
  await respuestaA(duena, t0, asis.address);
  const conCupo = pedidos.at(-1).body.messages.at(-1).content;
  assert.equal(conCupo.filter((x) => !x.is_error).length, MAX_ENVIOS, `con cupo salieron ${conCupo.filter((x) => !x.is_error).length} de ${MAX_ENVIOS}`);
  assert.equal(Number(await casa.store.kvGet('asistente-envios', clave)), MAX_ENVIOS, 'el cupo del día no contó lo que salió');
  // Grito: a uno del tope del día, el turno siguiente manda UNO y los demás vuelven con el motivo.
  await casa.store.kvPut('asistente-envios', clave, CUPO_ENVIOS_DIA - 1);
  const t1 = Date.now();
  proximas.push(usa(Array.from({ length: MAX_ENVIOS }, (_, i) => ({ name: 'nyx5_enviar', input: { to: amiga.address, body: `cupo-no ${i}` } }))));
  proximas.push(texto('no pude'));
  await duena.send({ to: asis.address, body: 'manda cinco más' });
  await respuestaA(duena, t1, asis.address);
  const alTope = pedidos.at(-1).body.messages.at(-1).content;
  assert.equal(alTope.filter((x) => !x.is_error).length, 1, `salieron ${alTope.filter((x) => !x.is_error).length} con el cupo del día en ${CUPO_ENVIOS_DIA - 1}`);
  assert.match(alTope.at(-1).content, new RegExp(`${CUPO_ENVIOS_DIA} messages a day`));
  await espera(600); await casa.tick({ programado: true });
  let llegaron = 0;
  for (const x of await amiga.inbox()) {
    try { if (/^cupo-no /.test((await amiga.open(x.envelope)).content?.body ?? '')) llegaron++; } catch { /* no es para ella */ }
  }
  assert.equal(llegaron, 1, `llegaron ${llegaron} mensajes del turno que estaba al tope`);
  await casa.store.kvPut('asistente-envios', clave, 0);
});

test('el cupo de despertares se cobra al TOMAR el turno, no al mirar el buzón (grito: dos relojes contaban dos por un recordatorio)', async () => {
  const asis = await altaDelegado('reloj', { budget_usd: 5, tools: true });
  const agente = await casa.agenteDeBoveda(asis.local);
  const dia = new Date().toISOString().slice(0, 10);
  const clave = `${asis.local}:${dia}`;
  clearInterval(casa.timer);
  const tickReal = casa.tick.bind(casa);
  casa.tick = async () => {};
  try {
    await casa.store.kvPut('asistente-despertar', clave, 0);
    await agente.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: 'retoma esto' });
    for (let i = 0; i < 3; i++) { await tickReal({ programado: false }); await espera(50); }
    assert.equal((await casa.store.listMail(asis.local)).length, 1);
    const n = pedidos.length;
    demora = 80;
    await Promise.all([atenderAsistentes(casa), atenderAsistentes(casa)]);
    demora = 0;
    assert.equal(pedidos.length - n, 1, 'dos relojes despertaron dos veces por el mismo recordatorio');
    assert.equal(Number(await casa.store.kvGet('asistente-despertar', clave)), 1, `el cupo del día contó ${await casa.store.kvGet('asistente-despertar', clave)} despertares para UN recordatorio`);
    // Y lo que queda fuera de `maxPorTick` no paga: antes se cobraba por mirarlo.
    await casa.store.kvPut('asistente-despertar', clave, 0);
    for (let i = 0; i < 4; i++) await agente.recordar({ cuando: new Date(Date.now() - 1000).toISOString(), body: `otro ${i}` });
    for (let i = 0; i < 3; i++) { await tickReal({ programado: false }); await espera(50); }
    const m = pedidos.length;
    await atenderAsistentes(casa, { maxPorTick: 1 });
    assert.equal(pedidos.length - m, 1, 'maxPorTick 1 tiene que atender uno');
    assert.equal(Number(await casa.store.kvGet('asistente-despertar', clave)), 1, 'se cobró el cupo de los recordatorios que ni se atendieron');
  } finally {
    casa.tick = tickReal;
    casa.timer = setInterval(() => casa.tick().catch(() => {}), casa.workerIntervalMs);
    casa.timer.unref?.();
  }
});

// ---------- 5. un ENCARGO por grupo despierta (29-oct-2026, decisión de Nicholas) ----------
// Nació de un caso medido: su Claude web mandó el paquete Santander a `g.rosetta@` —plazo lunes,
// reunión el martes— y no despertó a nadie, porque hasta ese día un sobre de grupo no despertaba ni
// a un cerebro ni a un ejecutor. El canal que uno usa para repartirle trabajo a un equipo era el
// único que no podía despertar. Ahora despierta si es un ENCARGO; la charla del grupo, no.

test('un ENCARGO por grupo despierta a CADA cerebro (grito), la respuesta va a quien encargó y no al grupo, y la charla sigue sin despertar (silencio)', async () => {
  const a1 = await altaDelegado('encargo1', { budget_usd: 5 });
  const a2 = await altaDelegado('encargo2', { budget_usd: 5 });
  const sala = await duena.createGroup('sala-encargo', { members: [a1.address, a2.address] });
  const n = pedidos.length;
  const desde = Date.now();
  const env = await duena.send({ to: sala.address, type: 'task', body: 'ENCARGO: medí el borde y reportá', project: 'santander', role: 'cowork' });

  // GRITO: las DOS direcciones contestan. Antes del 29-oct no contestaba ninguna por la regla del
  // grupo; y con la regla arreglada habría contestado UNA SOLA, porque el candado del turno se
  // guardaba con el id del sobre a secas — y el mismo sobre vive en el buzón de cada miembro.
  const r1 = await duena.waitFor((e) => e.from === a1.address && e.in_reply_to === env.id, { timeoutMs: 9000 });
  const r2 = await duena.waitFor((e) => e.from === a2.address && e.in_reply_to === env.id, { timeoutMs: 9000 });
  assert.ok(r1 && r2, 'un encargo por grupo tiene que despertar a cada cerebro del grupo');
  const deEsteEncargo = (desde_) => pedidos.slice(desde_).filter((p) => JSON.stringify(p.body.messages).includes('medí el borde y reportá'));
  assert.equal(deEsteEncargo(n).length, 2, `una llamada a la API por cerebro, no más: ${deEsteEncargo(n).length}`);

  // La respuesta va a QUIEN ENCARGÓ, nunca al grupo: un encargo a quince miembros no se convierte
  // en quince mensajes para los quince (es la regla de silencio de Nicholas, en el protocolo).
  for (const r of [r1, r2]) {
    assert.deepEqual(r.envelope.to, [duena.address], 'la respuesta se fue al grupo');
    assert.ok(!(r.envelope.to || []).some((t) => t.startsWith('g.')), 'la respuesta se fue al grupo');
  }
  // Y el sobre del encargo quedó cerrado en los dos buzones: no vuelve en el tick siguiente.
  for (const d of [a1, a2]) {
    assert.equal((await casa.store.listMail(d.local)).filter((m) => m.envelope.id === env.id).length, 0, `${d.local} dejó el encargo pendiente`);
  }

  // SILENCIO: la charla del grupo —sin proyecto, sin rol, y no es `task`— sigue sin costar un peso.
  const n2 = pedidos.length;
  await duena.send({ to: sala.address, body: 'charla suelta, sin proyecto ni rol' });
  await espera(1500);
  const porLaCharla = pedidos.slice(n2).filter((p) => JSON.stringify(p.body.messages).includes('charla suelta, sin proyecto ni rol'));
  assert.deepEqual(porLaCharla, [], 'la charla de un grupo despertó a un cerebro y gastó el tope del dueño');
});

test('el criterio de encargo es una sola función, y distingue la intención DECLARADA de la palabra del texto', () => {
  const g = (extra) => ({ to: ['g.sala@casa'], ...extra });
  assert.equal(porGrupo(g({})), true);
  assert.equal(porGrupo({ to: ['alguien@casa'] }), false);
  // Lo que ES un encargo: el tipo del protocolo, o proyecto Y rol declarados.
  assert.equal(esEncargo(g({ type: 'task' })), true);
  assert.equal(esEncargo(g({ type: 'message', extensions: { 'urn:nyx5:ext:proyecto': { project: 'santander', role: 'cowork' } } })), true);
  // Lo que NO: la charla, el proyecto sin rol, y un texto que DICE «encargo» sin declarar nada.
  assert.equal(esEncargo(g({ type: 'message' })), false);
  assert.equal(esEncargo(g({ type: 'message', extensions: { 'urn:nyx5:ext:proyecto': { project: 'santander' } } })), false);
  assert.equal(esEncargo(g({ type: 'message', content: { media: 'text/plain', body: 'ENCARGO URGENTE: hacelo ya' } })), false,
    'la palabra en el texto no es la intención: la declara el sobre, que va firmado');
});
