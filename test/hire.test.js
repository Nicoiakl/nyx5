// node --test test/
// NX-305 · Contratar desde el directorio en un paso. El comprador PIDE un servicio publicado
// (sobre `task`, media nyx5.pedido); el vendedor contesta con la cotización de su propia ficha
// TAL CUAL (quoteFromCatalog); el comprador la acepta sola SOLO si coincide con el catálogo que
// leyó. Lo que se prueba: que el escrow lleva el precio publicado y verifica@ de árbitro, que
// cualquier diferencia se nombra y NO se acepta, que un vendedor sólo-mensajes se declara como
// tal, y que el contrato así nacido se verifica, se libera y cuenta como arbitrado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { Libro, MEDIA } from '../src/libro/libro.js';
import { pruebaDeAceptacion, CAMPOS_PRUEBA, PRUEBAS } from '../src/libro/verifica.js';
import { TOOLS, MENSAJERIA, llamar } from '../src/puentes/herramientas.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4721;
const H = 'hire.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
let tmp, casa, vende, compra;
// El "mundo" que verifica@ mira: un servidor local que responde lo que se le pida.
let mundo, mundoPort, estado = 200;
const urlMundo = () => `https://127.0.0.1:${mundoPort}/health`;

const CATALOGO = [
  { id: 'informe', name: 'Informe de mercado', summary: 'En 24 h', price: { tokens: 300 }, unit: 'job', contract: 'escrow', acceptance: { kind: 'http_status', template: 'the url you give in input answers 200 when the report is up' } },
  { id: 'saludo', name: 'Saludo', price: { tokens: 40 }, unit: 'call', contract: 'spot' },
  { id: 'hash', name: 'Hash a secret', price: { tokens: 60 }, unit: 'job', contract: 'escrow', acceptance: { kind: 'sha256', template: 'expect: the sha256 of the deliverable' } },
];

// El vendedor atendido por su agente: espera el pedido del comprador y cotiza desde su ficha.
const atiende = async (vendedor, desde) => {
  const m = await vendedor.wait({ from: desde, seconds: 10 });
  assert.ok(m, 'el pedido tiene que llegar al buzón del vendedor');
  const pedido = await vendedor.open(m.envelope);
  assert.equal(pedido.content.media, MEDIA.pedido);
  await vendedor.ack(m.envelope.id);
  return vendedor.quoteFromCatalog(pedido);
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-hire-'));
  mundo = http.createServer((req, res) => { res.writeHead(estado, { 'content-type': 'text/plain' }); res.end('ok'); });
  await new Promise((r) => mundo.listen(0, '127.0.0.1', r));
  mundoPort = mundo.address().port;
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 60_000, libro: { welcome: 0, feeBps: 1000 }, verifica: { enabled: true }, log: () => {} }).start();
  // La URL de la prueba es https (verifica@ no acepta otra) y el mundo local es http: se sustituye.
  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  vende = Agent.create(`vende@${H}`, URL_CASA, { hosts });
  compra = Agent.create(`compra@${H}`, URL_CASA, { hosts });
  for (const a of [vende, compra]) await a.register({ adminToken: 't' });
  await vende.setProfile({ display_name: 'Vende', services: CATALOGO });
  await casa.libro.topup(compra.address, 5000, 'carga');
});
after(async () => { await casa?.stop(); await new Promise((r) => mundo.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('pruebaDeAceptacion: la prueba sale del kind publicado y del input; falta un campo, grita; exit_0 no se deriva', () => {
  assert.deepEqual(pruebaDeAceptacion({ kind: 'http_status', template: 't' }, { url: 'https://x/', expect: 204, ajeno: 1 }), { type: 'http_status', url: 'https://x/', expect: 204 });
  assert.deepEqual(pruebaDeAceptacion({ kind: 'json_path', template: 't' }, { url: 'https://x/', path: 'a.b', expect: false }), { type: 'json_path', url: 'https://x/', path: 'a.b', expect: false });
  assert.throws(() => pruebaDeAceptacion({ kind: 'http_status', template: 'give me the url' }, {}), /needs url in the request input \(give me the url\)/);
  assert.throws(() => pruebaDeAceptacion({ kind: 'http_status', template: 't' }, { url: 'http://x/' }), /https url/);
  assert.throws(() => pruebaDeAceptacion({ kind: 'sha256', template: 't' }, { expect: 'no-hash' }), /64 hex/);
  assert.throws(() => pruebaDeAceptacion({ kind: 'json_path', template: 't' }, { url: 'https://x/', expect: 1 }), /needs path/);
  // exit_0 existe como prueba, pero un pedido no puede escribir el argv que la casa del vendedor correría.
  assert.ok(PRUEBAS.includes('exit_0'));
  assert.equal(CAMPOS_PRUEBA.exit_0, undefined);
  assert.throws(() => pruebaDeAceptacion({ kind: 'exit_0', template: 't' }, { argv: ['rm', '-rf', '/'] }), /cannot be derived from a request/);
});

test('hire: el escrow nace con el precio publicado, verifica@ de árbitro y la prueba con el input; se verifica, se libera y cuenta como arbitrado', async () => {
  estado = 200;
  const antesC = await casa.libro.balance(compra.address);
  const antesV = await casa.libro.balance(vende.address);
  const [r] = await Promise.all([
    compra.hire({ agent: vende.address, service: 'informe', input: { url: urlMundo() }, note: 'para el lunes', wait: 10 }),
    atiende(vende, compra.address),
  ]);
  assert.equal(r.accepted, true, JSON.stringify(r));
  assert.equal(r.status, 'hired');
  const c = r.contract;
  assert.equal(c.kind, 'escrow'); assert.equal(c.amount, 300); assert.equal(c.state, 'held');
  assert.equal(c.seller, vende.address); assert.equal(c.buyer, compra.address);
  assert.equal(c.arbiter, `verifica@${H}`);
  assert.equal(c.service, 'informe');
  assert.deepEqual(c.terms.verify, { type: 'http_status', url: urlMundo() });
  assert.deepEqual(c.terms.input, { url: urlMundo() });
  assert.equal(c.terms.acceptance, CATALOGO[0].acceptance.template);
  assert.equal(c.terms.note, 'para el lunes');
  assert.equal(r.verification.arbiter, `verifica@${H}`);
  assert.equal(await casa.libro.balance(compra.address), antesC - 300, 'el escrow retuvo el precio publicado');
  // La cotización viajó en el hilo del pedido: la conversación es un historial, no sobres sueltos.
  const conv = await compra.conversation(vende.address);
  const cot = conv.find((m) => m.envelope.thread === r.request && m.dir === 'in');
  assert.ok(cot, 'la cotización responde en el hilo del pedido');
  assert.equal(cot.envelope.in_reply_to, r.request);

  // El vendedor entrega; nadie libera a mano: verifica@ corre la prueba contra el mundo.
  await vende.awaitReceipt((await vende.deliver(H, c.id, { note: 'publicado' })).id);
  await casa.tick();
  await vende.waitFor((e) => e.thread === c.id && e.from === `libro@${H}`, { timeoutMs: 5000 });
  const fin = await vende.contract(H, c.id);
  assert.equal(fin.state, 'released');
  assert.equal(fin.history.find((h) => h.op === 'release').by, `verifica@${H}`);
  assert.equal(await casa.libro.balance(vende.address), antesV + 270, '300 menos el 10 % de la casa');
  // Reputación = el libro: un contrato hecho por hire cuenta como arbitrado.
  const h = await compra.historial(vende.address);
  assert.equal(h.arbitrados.liberados.n, 1);
  assert.equal(h.arbitrados.liberados.tokens, 300);
  assert.equal(h.resumen.puntaje_arbitrado, 1);
});

test('hire: si la prueba falla, verifica@ devuelve el escrow y el comprador recupera todo', async () => {
  estado = 500;
  const antesC = await casa.libro.balance(compra.address);
  const [r] = await Promise.all([
    compra.hire({ agent: vende.address, service: 'informe', input: { url: urlMundo() }, wait: 10 }),
    atiende(vende, compra.address),
  ]);
  assert.equal(r.accepted, true);
  await vende.awaitReceipt((await vende.deliver(H, r.contract.id, { note: 'listo (mentira)' })).id);
  await casa.tick();
  await compra.waitFor((e) => e.thread === r.contract.id && e.from === `libro@${H}`, { timeoutMs: 5000 });
  const fin = await compra.contract(H, r.contract.id);
  assert.equal(fin.state, 'refunded');
  assert.match(fin.history.find((h) => h.op === 'refund').note, /responded 500, expected 200/);
  assert.equal(await casa.libro.balance(compra.address), antesC);
  assert.equal((await compra.historial(vende.address)).arbitrados.devueltos.n, 1);
  estado = 200;
});

test('hire: un servicio inexistente se rechaza nombrando los publicados; un precio distinto del catálogo no se acepta y no mueve un token', async () => {
  await assert.rejects(() => compra.hire({ agent: vende.address, service: 'nada', input: {} }), /does not publish service "nada"; it publishes: informe, saludo, hash/);
  // Un vendedor que contesta con una cotización firmada a mano a 250: la diferencia se nombra y no se acepta.
  const antes = await casa.libro.balance(compra.address);
  const contestaBarato = async () => {
    const m = await vende.wait({ from: compra.address, seconds: 10 });
    const pedido = await vende.open(m.envelope);
    await vende.ack(m.envelope.id);
    const q = Libro.buildQuote({ seller: vende.address, buyer: compra.address, house: H, contract: 'escrow', price: 250, concept: 'x', service: 'informe', arbiter: `verifica@${H}`, terms: { input: pedido.content.body.input, verify: { type: 'http_status', url: urlMundo() } } }, vende.keys);
    return vende.send({ to: compra.address, type: 'message', media: MEDIA.cotizacion, body: q, thread: pedido.id, inReplyTo: pedido.id });
  };
  const [r] = await Promise.all([compra.hire({ agent: vende.address, service: 'informe', input: { url: urlMundo() }, wait: 10 }), contestaBarato()]);
  assert.equal(r.accepted, false);
  assert.equal(r.status, 'rejected');
  assert.match(r.reason, /published at 300 tok as escrow; the quote says 250 as escrow/);
  assert.equal(r.quote.price, 250, 'la cotización rechazada se devuelve para que el comprador decida');
  assert.equal(await casa.libro.balance(compra.address), antes, 'nada se aceptó: el saldo no se movió');
  // Una cotización que cambia la prueba publicada (sha256 donde la ficha dice http_status) tampoco pasa.
  const contestaOtraPrueba = async () => {
    const m = await vende.wait({ from: compra.address, seconds: 10 });
    const pedido = await vende.open(m.envelope);
    await vende.ack(m.envelope.id);
    const q = Libro.buildQuote({ seller: vende.address, buyer: compra.address, house: H, contract: 'escrow', price: 300, concept: 'x', service: 'informe', arbiter: `verifica@${H}`, terms: { input: pedido.content.body.input, verify: { type: 'sha256', expect: 'a'.repeat(64) } } }, vende.keys);
    return vende.send({ to: compra.address, type: 'message', media: MEDIA.cotizacion, body: q, thread: pedido.id, inReplyTo: pedido.id });
  };
  const [r2] = await Promise.all([compra.hire({ agent: vende.address, service: 'informe', input: { url: urlMundo() }, wait: 10 }), contestaOtraPrueba()]);
  assert.equal(r2.accepted, false);
  assert.match(r2.reason, /publishes a http_status test; the quote carries sha256/);
  // Y una que no lleva el input pedido (el vendedor cambió la URL a una que sí responde) tampoco.
  const contestaOtroInput = async () => {
    const m = await vende.wait({ from: compra.address, seconds: 10 });
    const pedido = await vende.open(m.envelope);
    await vende.ack(m.envelope.id);
    const q = Libro.buildQuote({ seller: vende.address, buyer: compra.address, house: H, contract: 'escrow', price: 300, concept: 'x', service: 'informe', arbiter: `verifica@${H}`, terms: { input: { url: 'https://otra.invalid/' }, verify: { type: 'http_status', url: 'https://otra.invalid/' } } }, vende.keys);
    return vende.send({ to: compra.address, type: 'message', media: MEDIA.cotizacion, body: q, thread: pedido.id, inReplyTo: pedido.id });
  };
  const [r3] = await Promise.all([compra.hire({ agent: vende.address, service: 'informe', input: { url: urlMundo() }, wait: 10 }), contestaOtroInput()]);
  assert.equal(r3.accepted, false);
  assert.match(r3.reason, /does not carry the input you sent/);
  assert.equal(await casa.libro.balance(compra.address), antes);
});

test('hire: max_price por debajo del publicado no pide nada; sin cotización a tiempo, no acepta; sin auto_accept, sólo pide', async () => {
  const bandejaAntes = (await vende.inbox({ limit: 200 })).length;
  await assert.rejects(() => compra.hire({ agent: vende.address, service: 'informe', input: { url: urlMundo() }, maxPrice: 250 }), /published at 300 tok; your max_price is 250\. Nothing was requested/);
  assert.equal((await vende.inbox({ limit: 200 })).length, bandejaAntes, 'no llegó ningún pedido al vendedor');
  // Nadie atiende: el comprador espera 1 s y vuelve sin aceptar nada, con el pedido en camino.
  const r = await compra.hire({ agent: vende.address, service: 'informe', input: { url: urlMundo() }, wait: 1 });
  assert.equal(r.accepted, false); assert.equal(r.status, 'no_quote');
  // Sin auto_accept: se pide y se devuelve el id del pedido.
  const r2 = await compra.hire({ agent: vende.address, service: 'saludo', autoAccept: false });
  assert.equal(r2.status, 'requested');
  assert.ok(r2.request);
  // Los dos pedidos están en el buzón del vendedor, con el input que se mandó.
  const pendientes = await vende.inbox({ limit: 200 });
  const ids = pendientes.map((m) => m.envelope.id);
  assert.ok(ids.includes(r.request) && ids.includes(r2.request));
  await vende.ack([r.request, r2.request]);
});

test('hire: un vendedor sólo-mensajes (un Claude conectado) no vende por sí mismo, y se dice claro', async () => {
  const claude = await vende.delegate('claude', { scope: { messages_only: true } });
  await assert.rejects(() => compra.hire({ agent: claude.address, service: 'informe', input: {} }), /does not sell by itself: it is a messages-only address .* write to it, or to its owner vende@hire\.test/);
  // Un agente sin ficha tampoco: se dice que no publica nada, en vez de esperar una cotización que no llega.
  await assert.rejects(() => compra.hire({ agent: compra.address, service: 'informe' }), /publishes no services/);
});

test('hire: un servicio spot sin prueba publicada se cobra al aceptar, sin árbitro', async () => {
  const antesV = await casa.libro.balance(vende.address);
  const [r] = await Promise.all([compra.hire({ agent: vende.address, service: 'saludo', input: { name: 'Nico' }, wait: 10 }), atiende(vende, compra.address)]);
  assert.equal(r.accepted, true);
  assert.equal(r.contract.kind, 'spot'); assert.equal(r.contract.state, 'settled'); assert.equal(r.contract.amount, 40);
  assert.equal(r.contract.arbiter ?? null, null);
  assert.equal(r.verification, null);
  assert.equal(await casa.libro.balance(vende.address), antesV + 36);
});

test('quoteFromCatalog: sin el campo que la prueba exige no se cotiza, y se nombra lo que falta', async () => {
  const [pedido] = await Promise.all([
    (async () => { const m = await vende.wait({ from: compra.address, seconds: 10 }); const o = await vende.open(m.envelope); await vende.ack(m.envelope.id); return o; })(),
    compra.hire({ agent: vende.address, service: 'hash', input: { texto: 'sin expect' }, autoAccept: false }),
  ]);
  await assert.rejects(() => vende.quoteFromCatalog(pedido), /the sha256 test needs expect in the request input \(expect: the sha256 of the deliverable\)/);
  // Un sobre que no es un pedido tampoco se cotiza.
  await assert.rejects(() => vende.quoteFromCatalog({ ...pedido, content: { media: 'text/plain', body: 'hola' } }), /not a service request/);
});

test('herramientas: nyx5_hire mueve dinero (no está en el remoto), y un Claude vendedor contesta el pedido con nyx5_quote {service, to, in_reply_to}', async () => {
  assert.equal(TOOLS.length, 25);
  const t = TOOLS.find((x) => x.name === 'nyx5_hire');
  assert.equal(t.annotations.destructiveHint, true);
  assert.ok(!MENSAJERIA.has('nyx5_hire'), 'contratar mueve saldo: el conector sólo-mensajes no la ofrece');
  const negada = await llamar(vende, 'nyx5_hire', { agent: compra.address, service: 'x' }, { permitidas: MENSAJERIA });
  assert.equal(negada.isError, true);
  assert.match(negada.content[0].text, /messages-only/);
  // La descripción de la bandeja le dice al vendedor cómo contestar un pedido.
  assert.match(TOOLS.find((x) => x.name === 'nyx5_inbox').description, /nyx5\.pedido.*nyx5_quote \{service, to, in_reply_to\}/);

  const vendedorClaude = async () => {
    const espera = JSON.parse((await llamar(vende, 'nyx5_wait', { from: compra.address, seconds: 10 })).content[0].text);
    assert.equal(espera.content.media, MEDIA.pedido);
    const r = JSON.parse((await llamar(vende, 'nyx5_quote', { service: espera.content.body.service, to: espera.from, in_reply_to: espera.id })).content[0].text);
    assert.equal(r.price, 300); assert.equal(r.arbiter, `verifica@${H}`); assert.equal(r.in_reply_to, espera.id);
    await llamar(vende, 'nyx5_ack', { ids: [espera.id] });
    return r;
  };
  const [res] = await Promise.all([
    llamar(compra, 'nyx5_hire', { agent: vende.address, service: 'informe', input: { url: urlMundo() }, wait: 10 }),
    vendedorClaude(),
  ]);
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.accepted, true, res.content[0].text);
  assert.equal(r.contract.amount, 300);
  assert.equal(r.contract.arbiter, `verifica@${H}`);
  // Un id que no es un pedido: la herramienta lo dice en vez de cotizar cualquier cosa.
  const nada = await llamar(vende, 'nyx5_quote', { service: 'informe', to: compra.address, in_reply_to: 'no-existe' });
  assert.equal(nada.isError, true);
  assert.match(nada.content[0].text, /no service request with id no-existe/);
});
