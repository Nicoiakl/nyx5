// node --test test/
// qa@ como servicio (NX-606, fase 1): un asistente de SISTEMA de la casa, con cuenta en el Libro,
// que cobra por crédito (pagos con `pay` menos lo consumido) y tiene dos personas: Spec (pedida ->
// contrato) y Gate (entrega contra contrato SELLADO -> veredicto JSON firmado por la casa).
// La API de Anthropic se SIMULA (SSE, como la real): estas pruebas no gastan un peso.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256hex, verifyObject, generateKeys } from '../src/nucleo/crypto.js';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { MEDIA_GATE, parsearVeredicto, validarGate } from '../src/correo/asistente.js';
import { TOOLS, MENSAJERIA, llamar } from '../src/puentes/herramientas.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4741;
const H = 'qa.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
const QA = `qa@${H}`;
let tmp, casa, duena, cliente, otro;
const pedidos = [];
let proxima = null; // lo que responde la API simulada la próxima vez
const USO = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 };
const sse = (j) => {
  const partes = [`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: j.usage.input_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}`];
  for (const b of j.content || []) if (b.type === 'text') for (const trozo of b.text.match(/[\s\S]{1,7}/g) || []) partes.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: trozo } })}`);
  partes.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: j.stop_reason }, usage: { output_tokens: j.usage.output_tokens } })}`);
  partes.push('event: message_stop\ndata: {"type":"message_stop"}');
  return partes.join('\n\n') + '\n\n';
};
const apiFalsa = async (url, init) => {
  const body = JSON.parse(init.body);
  pedidos.push({ url, headers: init.headers, body });
  const r = proxima || { status: 200, json: { content: [{ type: 'text', text: `contrato ${pedidos.length}` }], stop_reason: 'end_turn', usage: USO } };
  proxima = null;
  assert.equal(body.stream, true, 'toda llamada va en flujo');
  if (r.status !== 200) return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  return new Response(sse(r.json), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const modelo = (obj) => { proxima = { status: 200, json: { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], stop_reason: 'end_turn', usage: USO } }; };
const admin = (metodo, ruta, body) => fetch(`${URL_CASA}${ruta}`, { method: metodo, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const respuestaA = (quien, desde) => quien.waitFor((e) => e.from === QA && Date.parse(e.created) > desde, { timeoutMs: 8000 });
const cuerpoDe = async (quien, r) => (await quien.open(r.envelope)).content.body;
const pagar = async (quien, amount) => { const s = await quien.libroOp(H, { op: 'pay', to: QA, amount, concept: 'crédito qa' }); await quien.awaitReceipt(s.id); };
const consumido = async (quien) => Number((await casa.store.kvGet('asistente-credito', `qa:${quien.address}`))?.tokens) || 0;
// Un contrato sellado por `quien`: devuelve el texto y su hash.
const sellar = async (quien, texto) => { const h = sha256hex(texto); const s = await quien.notarize(H, { sha256: h, name: 'contrato' }); await quien.awaitReceipt(s.id); return { spec: texto, spec_sha256: h }; };
const SPEC = 'Contrato de aceptación\n1. El informe tiene un título.\n2. El informe cita al menos una fuente.\n3. El informe está en español.';
const ENTREGA = 'Título: Estado del motor\nFuente: src/correo/asistente.js\nTexto en español con tildes.';
const veredictoDe = (cuerpo) => { const fin = cuerpo.indexOf('\n\n---\n'); return JSON.parse(fin >= 0 ? cuerpo.slice(0, fin) : cuerpo); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-qa-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    libro: { welcome: 0, feeBps: 0 }, log: () => {},
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
    asistente: { apiKey: 'clave-de-prueba', fetchImpl: apiFalsa },
  }).start();
  duena = Agent.create(`duena@${H}`, URL_CASA, { hosts });
  cliente = Agent.create(`cliente@${H}`, URL_CASA, { hosts });
  otro = Agent.create(`otro@${H}`, URL_CASA, { hosts });
  for (const a of [duena, cliente, otro]) await a.register({ adminToken: 't' });
  await casa.libro.topup(cliente.address, 5000, 'carga de prueba');
  await casa.libro.topup(otro.address, 5000, 'carga de prueba');
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('alta en modo system: qa@ es reservado para todos y vive como asistente con llaves propias en la bóveda', async () => {
  // Nadie registra qa@ por la puerta normal (invariante 9).
  const usurpador = Agent.create(QA, URL_CASA, { hosts });
  await assert.rejects(usurpador.register({ adminToken: 't' }), /reserved/);
  const keys = generateKeys();
  // Sin posesión de la llave privada no hay alta (llaves de otra tarjeta).
  const ajenas = await admin('POST', '/admin/assistants', { local: 'qa', system: true, keys: { ...keys, sigPriv: generateKeys().sigPriv }, config: {} });
  assert.equal(ajenas.status, 400, JSON.stringify(ajenas.body));
  assert.match(ajenas.body.reason, /sigPriv/);
  // Un nombre del protocolo no puede ser un asistente.
  assert.equal((await admin('POST', '/admin/assistants', { local: 'verifica', system: true, keys, config: {} })).status, 409);
  const alta = await admin('POST', '/admin/assistants', { local: 'qa', system: true, keys, config: { owner: duena.address, budget_usd: 5, persona: 'Eres Spec: conviertes una pedida en contrato de aceptación.', seal: true, price_tokens: 400, gate: true, gate_price_tokens: 400, gate_abstain_tokens: 200 } });
  assert.equal(alta.status, 201, JSON.stringify(alta.body));
  assert.equal(alta.body.address, QA);
  assert.deepEqual([alta.body.custody.keys, alta.body.custody.via, alta.body.system], ['house', 'assistant', true]);
  assert.equal((await admin('POST', '/admin/assistants', { local: 'qa', system: true, keys, config: {} })).status, 409, 'dos altas del mismo nombre');
  const card = await cliente.resolver.agentCard(QA);
  assert.equal(card.sig, keys.sig, 'la tarjeta certificada lleva la llave del asistente');
  assert.equal(card.delegation, undefined, 'es una dirección raíz de la casa, no un delegado');
  assert.ok(card.capabilities.accepts.includes(MEDIA_GATE));
  assert.deepEqual(card.capabilities.assistant, { spec_tokens: 400, gate_tokens: 400, gate_abstain_tokens: 200 });
  const estado = await admin('GET', '/admin/assistants/qa');
  assert.deepEqual([estado.body.system, estado.body.owner, estado.body.price_tokens, estado.body.gate_price_tokens, estado.body.gate_abstain_tokens], [true, duena.address, 400, 400, 200]);
  assert.equal((await casa.libro.balance(QA)), 0, 'nace sin regalo de bienvenida');
});

test('sin crédito: contesta cuánto falta y NO llama a la API', async () => {
  const n = pedidos.length, t0 = Date.now();
  await cliente.send({ to: QA, body: 'quiero un informe del motor' });
  const cuerpo = await cuerpoDe(cliente, await respuestaA(cliente, t0));
  assert.equal(cuerpo, `Necesitas 400 tokens de crédito: paga a ${QA} con \`pay\` en libro@${H}; tienes 0.`);
  assert.equal(pedidos.length, n, 'sin crédito no se gasta');
  assert.equal((await casa.store.listMail('qa')).length, 0, 'la pedida queda confirmada');
});

test('con crédito: llama, descuenta y el pie dice lo cobrado y lo que queda', async () => {
  await pagar(cliente, 1000);
  assert.equal(await casa.libro.balance(QA), 1000, 'el pago entró a la cuenta de qa@');
  const n = pedidos.length, t0 = Date.now();
  await cliente.send({ to: QA, body: 'quiero un informe del motor' });
  const cuerpo = await cuerpoDe(cliente, await respuestaA(cliente, t0));
  assert.equal(pedidos.length, n + 1, 'una llamada');
  assert.equal(pedidos.at(-1).body.system[0].text, 'Eres Spec: conviertes una pedida en contrato de aceptación.');
  const m = /^(contrato \d+)\n\n---\nsha256: ([0-9a-f]{64})\n[^\n]+\ncobrado: 400 tokens · crédito restante: 600$/.exec(cuerpo);
  assert.ok(m, `pie inesperado: ${cuerpo}`);
  assert.equal(m[2], sha256hex(m[1]), 'el sha256 del pie es el del texto que lo precede');
  assert.equal(await consumido(cliente), 400);
  // El recibo del `pay` que libro@ le dejó a qa@ no se queda pendiente para siempre.
  assert.equal((await casa.store.listMail('qa')).length, 0);
});

test('un error de la API devuelve lo reservado: no se cobra lo que no se contestó', async () => {
  proxima = { status: 500, json: { error: { message: 'caída' } } };
  const antes = await consumido(cliente), n = pedidos.length;
  await cliente.send({ to: QA, body: 'esto falla' });
  await new Promise((ok) => setTimeout(ok, 1200));
  assert.ok(pedidos.length > n, 'llamó a la API');
  assert.equal(await consumido(cliente), antes, 'lo reservado volvió al crédito');
  assert.equal((await casa.store.listMail('qa')).length, 1, 'el mensaje se reintenta');
  // Se limpia para las pruebas siguientes: el candado del turno vence solo; aquí se suelta.
  await casa.store.ackMail('qa', (await casa.store.listMail('qa'))[0].envelope.id);
  assert.equal((await casa.store.kvGet('asistente-cliente', `qa:${cliente.address}`)), null, 'el candado por cliente se soltó');
});

test('Gate con contrato sellado: veredicto JSON firmado por la casa, cobra 400', async () => {
  const c = await sellar(cliente, SPEC);
  modelo({ veredicto: 'pass', criterios: [{ n: 1, cumple: true, evidencia: 'Título: Estado del motor' }, { n: 2, cumple: true, evidencia: 'Fuente: src/correo/asistente.js' }, { n: 3, cumple: true, evidencia: 'Texto en español con tildes.' }], razon: 'Los tres criterios se cumplen.' });
  const antes = await consumido(cliente), n = pedidos.length, t0 = Date.now();
  await cliente.send({ to: QA, media: MEDIA_GATE, body: { ...c, delivery: { text: ENTREGA, sha256: sha256hex(ENTREGA) }, note: 'primera entrega' } });
  const cuerpo = await cuerpoDe(cliente, await respuestaA(cliente, t0));
  assert.equal(pedidos.length, n + 1);
  const p = pedidos.at(-1).body;
  assert.match(p.system[0].text, /^Eres Gate/, 'la segunda persona');
  assert.equal(p.messages.length, 1, 'Gate no lleva la conversación de Spec');
  assert.match(p.messages[0].content, /CONTRATO \(sha256 [0-9a-f]{64}, sellado /);
  assert.match(p.messages[0].content, /ENTREGA \(sha256 [0-9a-f]{64}\)/);
  const v = veredictoDe(cuerpo);
  assert.ok(verifyObject(v, casa.keys.sig), 'el veredicto lo firma la casa');
  assert.deepEqual([v.tipo, v.by, v.house, v.veredicto, v.spec_sha256, v.delivery_sha256, v.sealed_by], ['veredicto', QA, H, 'pass', c.spec_sha256, sha256hex(ENTREGA), cliente.address]);
  assert.equal(v.criterios.length, 3);
  assert.match(cuerpo, /\ncobrado: 400 tokens · crédito restante: \d+$/);
  assert.equal(await consumido(cliente), antes + 400);
});

test('Gate sin sello, con hash que no coincide o con entrega vacía: rechazo sin llamar a la API ni cobrar', async () => {
  const antes = await consumido(cliente);
  const casos = [
    [{ spec: 'contrato que nadie selló', spec_sha256: sha256hex('contrato que nadie selló'), delivery: { text: ENTREGA } }, /no está sellado en la notaría/],
    [{ spec: SPEC + ' (alterado)', spec_sha256: sha256hex(SPEC), delivery: { text: ENTREGA } }, /no es .*: es [0-9a-f]{64}/],
    [{ spec: SPEC, spec_sha256: sha256hex(SPEC), delivery: { text: '   ' } }, /delivery\.text está vacío/],
    [{ spec: SPEC, spec_sha256: sha256hex(SPEC), delivery: { text: ENTREGA, sha256: sha256hex('otra cosa') } }, /delivery\.sha256 no es/],
  ];
  for (const [body, esperado] of casos) {
    const n = pedidos.length, t0 = Date.now();
    await cliente.send({ to: QA, media: MEDIA_GATE, body });
    const cuerpo = await cuerpoDe(cliente, await respuestaA(cliente, t0));
    assert.match(cuerpo, esperado);
    assert.equal(pedidos.length, n, `llamó a la API con ${JSON.stringify(body).slice(0, 60)}`);
  }
  assert.equal(await consumido(cliente), antes, 'un rechazo no cobra');
});

test('abstención (JSON inválido, rechazo de la API, o fail sin evidencia) cobra 200', async () => {
  await pagar(cliente, 3000);
  const c = await sellar(cliente, SPEC);
  const casos = [
    ['esto no es JSON, es prosa', 'la respuesta del modelo no fue un JSON válido'],
    [{ veredicto: 'fail', criterios: [{ n: 1, cumple: true, evidencia: 'tiene título' }, { n: 2, cumple: null, evidencia: '' }], razon: 'no estoy seguro' }, 'no estoy seguro'],
    [{ veredicto: 'pass', criterios: [{ n: 1, cumple: true, evidencia: 'x' }, { n: 2, cumple: false, evidencia: 'falta la fuente' }], razon: 'contradictorio' }, 'contradictorio'],
  ];
  for (const [salida, razon] of casos) {
    modelo(salida);
    const antes = await consumido(cliente), t0 = Date.now();
    await cliente.send({ to: QA, media: MEDIA_GATE, body: { ...c, delivery: { text: ENTREGA } } });
    const cuerpo = await cuerpoDe(cliente, await respuestaA(cliente, t0));
    const v = veredictoDe(cuerpo);
    assert.equal(v.veredicto, 'abstain', JSON.stringify(salida));
    assert.equal(v.razon, razon);
    assert.ok(verifyObject(v, casa.keys.sig));
    assert.match(cuerpo, /\ncobrado: 200 tokens · crédito restante: \d+$/);
    assert.equal(await consumido(cliente), antes + 200, 'una abstención cobra la mitad');
  }
  proxima = { status: 200, json: { content: [], stop_reason: 'refusal', usage: { input_tokens: 0, output_tokens: 0 } } };
  const antes = await consumido(cliente), t0 = Date.now();
  await cliente.send({ to: QA, media: MEDIA_GATE, body: { ...c, delivery: { text: ENTREGA } } });
  const v = veredictoDe(await cuerpoDe(cliente, await respuestaA(cliente, t0)));
  assert.deepEqual([v.veredicto, v.razon], ['abstain', 'la API rechazó evaluar esta entrega']);
  assert.equal(await consumido(cliente), antes + 200);
});

test('un fail bien sostenido sale como fail (la guardia no calla lo que sí tiene evidencia)', async () => {
  const c = await sellar(cliente, SPEC);
  modelo({ veredicto: 'fail', criterios: [{ n: 1, cumple: true, evidencia: 'Título: Estado del motor' }, { n: 2, cumple: false, evidencia: 'la entrega no nombra ninguna fuente' }, { n: 3, cumple: true, evidencia: 'español' }], razon: 'Falta la fuente.' });
  const antes = await consumido(cliente), t0 = Date.now();
  await cliente.send({ to: QA, media: MEDIA_GATE, body: { ...c, delivery: { text: 'Título: Estado del motor\nSin fuentes.' } } });
  const cuerpo = await cuerpoDe(cliente, await respuestaA(cliente, t0));
  const v = veredictoDe(cuerpo);
  assert.deepEqual([v.veredicto, v.degradado_de], ['fail', undefined]);
  assert.equal(await consumido(cliente), antes + 400);
});

test('el dueño (y su Claude delegado) no paga: crédito infinito para probar', async () => {
  const antesQa = await casa.libro.balance(QA);
  for (const quien of [duena, await (async () => { const d = await duena.delegate('claude', { scope: { messages_only: true } }); const a = new Agent({ address: d.address, keys: d.keys, estafeta: URL_CASA, hosts }); return a; })()]) {
    const n = pedidos.length, t0 = Date.now();
    await quien.send({ to: QA, body: 'pruebo el asistente' });
    const cuerpo = await cuerpoDe(quien, await respuestaA(quien, t0));
    assert.equal(pedidos.length, n + 1, `${quien.address}: llamó a la API sin pagar`);
    assert.ok(!/cobrado:/.test(cuerpo), `${quien.address}: no hay línea de cobro: ${cuerpo}`);
    assert.equal(await consumido(quien), 0);
  }
  assert.equal(await casa.libro.balance(QA), antesQa, 'nada se movió en el Libro');
  // free_for: otra dirección (y su delegado) que tampoco paga; para que Nicholas pruebe desde su celular.
  const probador = Agent.create(`probador@${H}`, URL_CASA, { hosts });
  await probador.register({ adminToken: 't' });
  assert.equal((await admin('PUT', `/admin/assistants/qa/config`, { free_for: ['no-es-direccion'] })).status, 400);
  assert.deepEqual((await admin('PUT', `/admin/assistants/qa/config`, { free_for: [probador.address] })).body.free_for, [probador.address]);
  const d = await probador.delegate('claude', { scope: { messages_only: true } });
  const cel = new Agent({ address: d.address, keys: d.keys, estafeta: URL_CASA, hosts });
  const n = pedidos.length, t0 = Date.now();
  await cel.send({ to: QA, body: 'pruebo desde el celular' });
  const cuerpo = await cuerpoDe(cel, await respuestaA(cel, t0));
  assert.equal(pedidos.length, n + 1, 'el delegado de free_for llamó a la API sin pagar');
  assert.ok(!/cobrado:/.test(cuerpo));
  await admin('PUT', `/admin/assistants/qa/config`, { free_for: [] });
});

test('el crédito es por cliente: lo que pagó uno no lo gasta otro', async () => {
  const n = pedidos.length, t0 = Date.now();
  await otro.send({ to: QA, body: 'quiero gastar el crédito del cliente' });
  const cuerpo = await cuerpoDe(otro, await respuestaA(otro, t0));
  assert.match(cuerpo, /^Necesitas 400 tokens de crédito/);
  assert.equal(pedidos.length, n);
});

test('el candado por cliente: con otro reloj cobrándole, el turno se suelta y se reintenta', async () => {
  await casa.store.kvPutIfAbsent('asistente-cliente', `qa:${cliente.address}`, { at: 'otro isolate' }, Date.now() + 60_000);
  const n = pedidos.length;
  await cliente.send({ to: QA, body: 'mientras otro reloj me cobra' });
  await new Promise((ok) => setTimeout(ok, 700));
  assert.equal(pedidos.length, n, 'no se llamó a la API con el candado ajeno puesto');
  const pendiente = (await casa.store.listMail('qa'))[0];
  assert.ok(pendiente, 'el mensaje sigue en cola');
  // Cada reloj toma el turno y lo suelta al ver el candado ajeno: en pausa (sin relojes en vuelo)
  // el turno tiene que estar libre, no reservado 15 minutos.
  await admin('POST', '/admin/assistants/qa/pause');
  await new Promise((ok) => setTimeout(ok, 400));
  assert.equal(await casa.store.kvGet('asistente-turno', pendiente.envelope.id), null, 'el turno se soltó para reintentar');
  await casa.store.kvDelete('asistente-cliente', `qa:${cliente.address}`);
  await admin('POST', '/admin/assistants/qa/resume');
  const r = await cliente.waitFor((e) => e.from === QA && e.in_reply_to === pendiente.envelope.id, { timeoutMs: 8000 });
  assert.match((await cuerpoDe(cliente, r)), /cobrado: 400 tokens/, 'al soltarse el candado, se contesta y se cobra una vez');
});

test('validarGate y parsearVeredicto: gritan donde deben y callan donde deben', () => {
  assert.match(validarGate(null).error, /Gate espera/);
  assert.match(validarGate({ spec_sha256: 'abc', spec: 'x', delivery: { text: 'y' } }).error, /64 caracteres/);
  const ok = validarGate({ spec_sha256: sha256hex('x').toUpperCase(), spec: 'x', delivery: { text: 'y', url: 'https://ejemplo.test/entrega' } });
  assert.deepEqual([ok.error, ok.spec_sha256, ok.delivery.url, ok.delivery.sha256], [undefined, sha256hex('x'), 'https://ejemplo.test/entrega', sha256hex('y')]);
  assert.equal(validarGate({ spec_sha256: sha256hex('x'), spec: 'x', delivery: { text: 'y', url: 'javascript:alert(1)' } }).delivery.url, null, 'una url que no es http(s) no viaja');
  // Un veredicto con cerca de código sigue siendo JSON.
  assert.equal(parsearVeredicto('```json\n{"veredicto":"pass","criterios":[{"n":1,"cumple":true,"evidencia":"e"}],"razon":"r"}\n```').veredicto, 'pass');
  // Paradójico: el JSON describe un fail en la razón, pero los criterios no lo sostienen: abstención.
  assert.equal(parsearVeredicto('{"veredicto":"fail","criterios":[],"razon":"fail porque sí"}').veredicto, 'abstain');
  assert.equal(parsearVeredicto('{"veredicto":"pass","criterios":[],"razon":"nada que evaluar"}').veredicto, 'abstain', 'un pass sin criterios no aprueba nada');
  assert.equal(parsearVeredicto('{"veredicto":"aprobado","criterios":[]}').veredicto, 'abstain');
});

test('las dos herramientas MCP van por mensajería con el media correcto', async () => {
  const nombres = TOOLS.map((t) => t.name);
  assert.ok(nombres.includes('nyx5_qa_spec') && nombres.includes('nyx5_qa_gate'));
  assert.ok(MENSAJERIA.has('nyx5_qa_spec') && MENSAJERIA.has('nyx5_qa_gate'), 'son mensajes: el conector remoto las ofrece');
  const enviados = [];
  const falso = { domain: H, send: async (x) => { enviados.push(x); return { id: 'id-1', encrypted: true }; } };
  assert.equal((await llamar(falso, 'nyx5_qa_spec', {})).isError, true);
  await llamar(falso, 'nyx5_qa_spec', { request: 'un informe' });
  assert.deepEqual(enviados.at(-1), { to: [QA], body: 'un informe' });
  assert.equal((await llamar(falso, 'nyx5_qa_gate', { spec: 'x' })).isError, true);
  await llamar(falso, 'nyx5_qa_gate', { spec_sha256: sha256hex('x'), spec: 'x', delivery: { text: 'y' }, to: 'qa@otra.casa' });
  assert.deepEqual(enviados.at(-1), { to: ['qa@otra.casa'], media: MEDIA_GATE, body: { spec_sha256: sha256hex('x'), spec: 'x', delivery: { text: 'y', url: undefined, sha256: undefined }, note: undefined } });
});

// Cuarta revisión (14-sep-2026), ALTO probado: un cliente con buzón que cobra estampilla hacía que
// qa@ pagara 1.500 tokens de SU saldo por contestarle. A un buzón con estampilla no se le contesta.
test('a un cliente cuyo buzón cobra estampilla no se le contesta: qa@ no paga con su saldo', async () => {
  const cobrador = Agent.create(`cobrador@${H}`, URL_CASA, { hosts });
  await cobrador.register({ adminToken: 't', inbox: { policy: 'stamp', price: 1500 } });
  const saldoQa = await casa.libro.balance(QA);
  const n = pedidos.length;
  await cobrador.send({ to: QA, body: 'dame un spec gratis y págame la estampilla' });
  await casa.tick({ programado: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await casa.libro.balance(QA), saldoQa, 'qa@ pagó la estampilla del atacante');
  assert.equal(pedidos.length, n, 'no se llamó a la API');
  assert.equal((await casa.store.listMail('qa')).length, 0, 'la pedida queda confirmada, no en cola');
  assert.equal((await casa.store.listMail('cobrador')).length, 0, 'ninguna respuesta pagada llegó');
});
