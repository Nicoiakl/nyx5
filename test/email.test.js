// node --test test/
// D3: puente de correo (urn:nyx5:ext:email). Entrada: un email real entra al buzón como sobre
// SIN FIRMA, marcado no verificado, sin disfrazarse. Salida: el agente le escribe a un humano;
// sin proveedor configurado queda pendiente (no se inventa canal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { extractText } from '../src/puentes/email.js';

let puerto = 4260;
async function casa(email = {}) {
  const p = puerto++;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-email-'));
  const dom = `d${p}.test`;
  const e = new Estafeta({ domain: dom, port: p, dataDir: path.join(tmp, dom), adminToken: 't', publicUrl: `http://127.0.0.1:${p}`, hosts: { [dom]: { url: `http://127.0.0.1:${p}` } }, workerIntervalMs: 60, email, log: () => {} });
  await e.start();
  return { e, p, dom, url: `http://127.0.0.1:${p}` };
}

test('D3 · un email entrante cae al buzón como sobre SIN FIRMA, marcado no verificado', async () => {
  const { e, url, dom } = await casa();
  try {
    e.email.senders.add(`botsy@${dom}`); // la casa autoriza a este remitente (la salida está cerrada por defecto)
    const bot = Agent.create(`botsy@${dom}`, url, { hosts: { [dom]: { url } } });
    await bot.register({ adminToken: 't' });
    const r = await e.receiveEmail({ from: 'alice@gmail.com', to: `botsy@${dom}`, subject: 'hola', text: 'te escribo desde el correo de siempre', messageId: 'msg-abc-123' });
    assert.equal(r.code, 202);
    const inbox = await bot.inbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from_verified, false, 'el buzón marca que NO viene verificado');
    assert.equal(inbox[0].via, 'email');
    const abierto = await bot.open(inbox[0].envelope);
    assert.equal(abierto.verified, false, 'open() no lo disfraza de firmado');
    assert.equal(abierto.via, 'email');
    assert.equal(abierto.from, 'alice@gmail.com', 'el remitente real es legible');
    assert.equal(abierto.subject, 'hola');
    assert.equal(abierto.content.body, 'te escribo desde el correo de siempre');
    // dedupe por message-id: reentregar no duplica
    const dup = await e.receiveEmail({ from: 'alice@gmail.com', to: `botsy@${dom}`, text: 'otra vez', messageId: 'msg-abc-123' });
    assert.ok(dup.duplicate);
    assert.equal((await bot.inbox()).length, 1);
  } finally { await e.stop(); }
});

test('D3 · un email a un agente inexistente o de un remitente inválido se rechaza', async () => {
  const { e, dom } = await casa();
  try {
    assert.equal((await e.receiveEmail({ from: 'x@y.com', to: `nadie@${dom}`, text: 'x' })).code, 404);
    assert.equal((await e.receiveEmail({ from: 'no-es-email', to: `nadie@${dom}`, text: 'x' })).code, 400);
  } finally { await e.stop(); }
});

test('la puerta del correo respeta la política del buzón, igual que la puerta firmada', async () => {
  // Defecto real del 9-sep-2026: `receiveEmail` iba de getAgent directo a putMail sin consultar la
  // política. Un buzón que cobraba 500 y otro con lista blanca cerrada aceptaban los dos un correo
  // de un desconocido, gratis. La estampilla, la lista y la prueba de trabajo defendían una puerta
  // mientras la de al lado quedaba abierta, y el precio que la casa anuncia por x402 era evitable
  // escribiendo un correo.
  const { e, url, dom } = await casa();
  try {
    const mk = async (nombre, inbox) => {
      const a = Agent.create(`${nombre}@${dom}`, url, { hosts: { [dom]: { url } } });
      await a.register({ adminToken: 't', inbox });
      return a;
    };
    const caro = await mk('caro', { policy: 'stamp', price: 500 });
    const lista = await mk('lista', { policy: 'allowlist', allowlist: ['amigo@conocido.example'] });
    const trabajo = await mk('trabajo', { policy: 'pow', pow_bits: 12 });
    const abierto = await mk('abierto', { policy: 'open' });
    const buzon = async (n) => (await e.store.listMail(n)).length;

    // Cobra: el correo no trae pago, así que no entra, y el rechazo dice el precio.
    const r1 = await e.receiveEmail({ from: 'x@internet.example', to: caro.address, subject: 'h', text: 'entro?' });
    assert.equal(r1.code, 402);
    assert.match(r1.reason, /charges 500 tok/);
    assert.equal(await buzon('caro'), 0, 'no debe quedar nada en el buzón que cobra');

    // Lista blanca: se compara contra el remitente REAL, no contra la pasarela email@<casa>, que
    // sería la misma para todo el mundo y dejaría entrar a cualquiera.
    assert.equal((await e.receiveEmail({ from: 'x@internet.example', to: lista.address, subject: 'h', text: 'y yo?' })).code, 403);
    assert.equal(await buzon('lista'), 0);
    assert.equal((await e.receiveEmail({ from: 'amigo@conocido.example', to: lista.address, subject: 'h', text: 'soy yo' })).code, 202);
    assert.equal(await buzon('lista'), 1, 'el remitente de la lista sí entra');

    // Prueba de trabajo: no existe sobre correo, así que se falla cerrado en vez de dejar pasar.
    assert.equal((await e.receiveEmail({ from: 'x@internet.example', to: trabajo.address, subject: 'h', text: 'x' })).code, 403);
    assert.equal(await buzon('trabajo'), 0);

    // Y un buzón abierto sigue abierto: cerrar la puerta no puede romper el caso normal.
    assert.equal((await e.receiveEmail({ from: 'quien.sea@internet.example', to: abierto.address, subject: 'h', text: 'hola' })).code, 202);
    assert.equal(await buzon('abierto'), 1);
  } finally { await e.stop(); }
});

test('una política de buzón que no sepamos aplicar sobre correo no deja pasar', async () => {
  // Falla cerrado: si mañana alguien agrega una política nueva y olvida enseñarle esta puerta,
  // el olvido tiene que cerrar la puerta, no abrirla.
  const { e, url, dom } = await casa();
  try {
    const a = Agent.create(`raro@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't' });
    const rec = await e.store.getAgent('raro');
    await e.store.putAgent('raro', { ...rec, inbox: { policy: 'inventada-mañana' } });
    const r = await e.receiveEmail({ from: 'x@internet.example', to: a.address, subject: 'h', text: 'x' });
    assert.equal(r.code, 403);
    assert.match(r.reason, /unknown mailbox policy/);
    assert.equal((await e.store.listMail('raro')).length, 0);
  } finally { await e.stop(); }
});

test('D3 · salida SIN proveedor queda pendiente (no se inventa canal)', async () => {
  const { e, url, dom } = await casa();
  try {
    e.email.senders.add(`botsy@${dom}`); // la casa autoriza a este remitente (la salida está cerrada por defecto)
    const bot = Agent.create(`botsy@${dom}`, url, { hosts: { [dom]: { url } } });
    await bot.register({ adminToken: 't' });
    const r = await bot.email({ to: 'humano@ejemplo.com', subject: 'hey', body: 'primer contacto' });
    assert.equal(r.pending, true);
    assert.match(r.reason, /provider/);
  } finally { await e.stop(); }
});

test('D3 · salida CON proveedor envía, con Reply-To = la dirección del agente', async () => {
  let captured = null;
  const provider = async (payload) => { captured = payload; return { id: 'prov-1' }; };
  const { e, url, dom } = await casa({ provider });
  try {
    e.email.senders.add(`botsy@${dom}`); // la casa autoriza a este remitente (la salida está cerrada por defecto)
    const bot = Agent.create(`botsy@${dom}`, url, { hosts: { [dom]: { url } } });
    await bot.register({ adminToken: 't' });
    const r = await bot.email({ to: 'humano@ejemplo.com', subject: 'hey', body: 'primer contacto' });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'prov-1');
    assert.deepEqual(captured.to, ['humano@ejemplo.com']);
    assert.equal(captured.reply_to, `botsy@${dom}`, 'la respuesta del humano vuelve al buzón del agente');
    assert.equal(captured.text, 'primer contacto');
  } finally { await e.stop(); }
});

test('D3 · extractText saca el texto de multipart, quoted-printable y base64', () => {
  const mp = ['Content-Type: multipart/alternative; boundary="B"', '', '--B', 'Content-Type: text/plain', 'Content-Transfer-Encoding: quoted-printable', '', 'Hola=20mundo=3D caf=C3=A9', '--B', 'Content-Type: text/html', '', '<p>ignorar</p>', '--B--'].join('\r\n');
  assert.equal(extractText(mp), 'Hola mundo= café');
  const b64 = ['Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '', Buffer.from('cuerpo en base64', 'utf8').toString('base64')].join('\r\n');
  assert.equal(extractText(b64), 'cuerpo en base64');
  const plain = ['Content-Type: text/plain', '', 'texto simple'].join('\n');
  assert.equal(extractText(plain), 'texto simple');
});

test('D3 · decodeMimeWords y addressFromHeader limpian header y remitente', async () => {
  const { decodeMimeWords, addressFromHeader } = await import('../src/puentes/email.js');
  assert.equal(decodeMimeWords('=?UTF-8?Q?Prueba_de_ENTRADA_=C2=B7_ok?='), 'Prueba de ENTRADA · ok');
  assert.equal(decodeMimeWords('=?UTF-8?B?' + Buffer.from('café','utf8').toString('base64') + '?='), 'café');
  assert.equal(decodeMimeWords('asunto simple'), 'asunto simple');
  assert.equal(addressFromHeader('Nicholas <nicholasiakl@gmail.com>'), 'nicholasiakl@gmail.com');
  assert.equal(addressFromHeader('bot@nyx5.com'), 'bot@nyx5.com');
  assert.equal(addressFromHeader('sin direccion'), null);
});

test('D3 · notify_email: quien registró un correo recibe un aviso cuando le escriben (no por recibos)', async () => {
  let captured = null;
  const provider = async (p) => { captured = p; return { id: 'n1' }; };
  const { e, url, dom } = await casa({ provider });
  try {
    const a = Agent.create(`agentea@${dom}`, url, { hosts: { [dom]: { url } } });
    const b = Agent.create(`agenteb@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't', notify_email: 'nicholas@gmail.test' });
    e.email.senders.add(a.address); // el aviso sale como correo del agente: la casa tiene que autorizarlo
    await b.register({ adminToken: 't' });
    await b.send({ to: a.address, body: 'hola a', project: 'viaje' });
    const until = Date.now() + 6000;
    while (!captured && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
    assert.ok(captured, 'se disparó el aviso por email');
    assert.deepEqual(captured.to, ['nicholas@gmail.test']);
    // Texto aprobado por Nicholas (14-sep-2026): remitente, proyecto, hora y dónde leerlo; nunca el contenido.
    assert.equal(captured.subject, `${b.address} wrote to you on Nyx5 (project viaje)`);
    assert.match(captured.text, /project: viaje · .* UTC\. The content is encrypted/);
    assert.ok(!captured.text.includes('hola a'), 'el aviso no lleva el contenido');
  } finally { await e.stop(); }
});

// Cerrado por defecto (11-sep-2026): con el registro abierto, "cualquier agente le escribe a
// cualquier correo" era un relé de spam con nuestra cuenta de envío y nuestro dominio, y el aviso a
// una dirección que anotó cualquiera era el mismo relé por la puerta de al lado.
test('D3 · la salida de correo está cerrada salvo para quien la casa autoriza, y el aviso también', async () => {
  let enviados = 0;
  const { e, url, dom } = await casa({ provider: async () => { enviados++; return { id: 'x' }; } });
  try {
    const intruso = Agent.create(`intruso@${dom}`, url, { hosts: { [dom]: { url } } });
    await intruso.register({ adminToken: 't', notify_email: 'victima@ejemplo.com' });
    await assert.rejects(() => intruso.email({ to: 'victima@ejemplo.com', subject: 'oferta', body: 'spam' }), /outbound email is closed/);
    const otro = Agent.create(`otroagente@${dom}`, url, { hosts: { [dom]: { url } } });
    await otro.register({ adminToken: 't' });
    await otro.send({ to: intruso.address, body: 'esto dispararía el aviso' });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(enviados, 0, 'ni el correo directo ni el aviso salieron');
  } finally { await e.stop(); }
});

// El pie de la carta que sale hacia un humano. La regla que prueba este test no es de estilo:
// un correo que le dice a un agente "corre esto" es exactamente lo que parece una inyección de
// prompt, y el canal de distribución del sistema no puede enseñar esa costumbre.
test('el pie informa y no instruye, y solo sale si la casa lo enciende', async () => {
  const { outboundPayload, pieDeCarta } = await import('../src/puentes/email.js');
  const pie = pieDeCarta({ fromAgent: 'ana@nyx5.com', domain: 'nyx5.com' });
  // Dice qué es y qué pasa si respondes.
  assert.match(pie, /ana@nyx5\.com/);
  assert.match(pie, /reply to this email/);
  assert.match(pie, /https:\/\/nyx5\.com/);
  // No manda hacer nada: ni comandos, ni imperativos de instalación, ni urgencia.
  for (const prohibido of [/npx /, /npm i/, /corre /i, /ejecuta/i, /instala/i, /haz clic/i, /urgente/i, /debes /i, /ahora mismo/i]) {
    assert.ok(!prohibido.test(pie), `el pie instruye o presiona: ${prohibido}`);
  }
  // Apagado por defecto: el texto que ve un tercero lo decide el operador, no el código.
  const sin = outboundPayload({ fromAgent: 'ana@nyx5.com', to: 'x@gmail.com', subject: 's', text: 'hola' });
  assert.equal(sin.text, 'hola');
  const con = outboundPayload({ fromAgent: 'ana@nyx5.com', to: 'x@gmail.com', subject: 's', text: 'hola', footer: true });
  assert.match(con.text, /^hola\n/);
  assert.match(con.text, /open protocol/);
  // Y el Reply-To sigue siendo el agente, con o sin pie: la respuesta vuelve a su buzón.
  assert.equal(con.reply_to, 'ana@nyx5.com');
});

// Nació de un rebote real: Nicholas respondió un correo de un agente y le volvió
// "555 5.7.1 agente inexistente", porque el From era no-reply@ (un nombre reservado) y su cliente
// respondió al From en vez de al Reply-To. Depender del Reply-To no basta: el From tiene que ser
// una dirección que la casa sepa recibir.
test('el remitente es el agente, no la dirección reservada, así responder llega a su buzón', async () => {
  const { resendProvider, outboundPayload } = await import('../src/puentes/email.js');
  let enviado = null;
  const proveedor = resendProvider({
    apiKey: 'k', sender: 'no-reply@nyx5.com',
    fetchImpl: async (_u, o) => { enviado = JSON.parse(o.body); return { ok: true, json: async () => ({ id: 'x' }) }; },
  });
  await proveedor(outboundPayload({ fromAgent: 'ana@nyx5.com', to: 'x@gmail.com', subject: 's', text: 't' }));
  assert.equal(enviado.from, 'ana@nyx5.com', 'quien responda al From llega al agente');
  assert.deepEqual(enviado.reply_to, 'ana@nyx5.com');
  // El nombre reservado nunca puede quedar como remitente de un agente de la misma casa.
  assert.ok(!/no-reply/.test(enviado.from));

  // Un agente de OTRA casa no puede usurpar el remitente verificado: cae a la dirección de la casa.
  await proveedor(outboundPayload({ fromAgent: 'ajeno@otracasa.test', to: 'x@gmail.com', subject: 's', text: 't' }));
  assert.equal(enviado.from, 'no-reply@nyx5.com', 'solo el dominio verificado puede firmar el From');
  assert.equal(enviado.reply_to, 'ajeno@otracasa.test', 'pero la respuesta sigue apuntando a quien escribió');
});

// ---------------------------------------------------------------------------------------------
// EL RESUMEN EN CLARO (29-oct-2026, decisión de Nicholas). El aviso sólo podía decir QUIÉN le
// escribió, nunca QUÉ: el cuerpo va cifrado y la casa no lo lee. Un timbre que no dice quién está
// en la puerta es ruido. Ahora el REMITENTE adjunta una línea sin cifrar y la casa la pone en el
// asunto. Lo que no cambia: sin resumen, el aviso es el mismo byte a byte que él aprobó el 14-sep.
test('D3 · el resumen del remitente llega al asunto, viaja EN CLARO, y no se puede partir el asunto en dos', async () => {
  let captured = null;
  const provider = async (p) => { captured = p; return { id: 'r1' }; };
  const { e, url, dom } = await casa({ provider });
  try {
    const a = Agent.create(`avisada@${dom}`, url, { hosts: { [dom]: { url } } });
    const b = Agent.create(`remitente@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't', notify_email: 'nicholas@gmail.test' });
    e.email.senders.add(a.address);
    await b.register({ adminToken: 't' });
    // El sobre va CIFRADO y el resumen NO: eso es justo el punto, y justo el riesgo.
    const env = await b.send({ to: a.address, body: 'el cuerpo secreto que nadie más abre', project: 'santander', summary: 'T3 contestado; falta el ensayo del lunes' });
    const until = Date.now() + 6000;
    while (!captured && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
    assert.ok(captured, 'se disparó el aviso');
    assert.equal(captured.subject, `${b.address} · santander: T3 contestado; falta el ensayo del lunes`);
    assert.match(captured.text, /They summarised it as: T3 contestado; falta el ensayo del lunes — that line comes from the sender, in the clear/);
    assert.ok(!captured.text.includes('el cuerpo secreto'), 'el aviso no lleva el contenido');
    // El resumen va en la extensión, EN CLARO, con el sobre cifrado. Si alguien lo "arregla"
    // metiéndolo dentro del cifrado, el aviso vuelve a no poder decir nada: por eso se fija aquí.
    const bandeja = await e.store.listMail('avisada');
    const guardado = bandeja.find((m) => m.envelope?.id === env.id)?.envelope || {};
    assert.ok(guardado.id, `el sobre no está en el buzón: ${bandeja.map((m) => m.envelope?.id).join(', ')}`);
    assert.ok(guardado.encrypted, 'el sobre tiene que ir cifrado');
    assert.equal(guardado.extensions['urn:nyx5:ext:resumen'].text, 'T3 contestado; falta el ensayo del lunes');
    assert.equal(env.envelope.extensions['urn:nyx5:ext:resumen'].text, 'T3 contestado; falta el ensayo del lunes');
  } finally { await e.stop(); }
});

test('D3 · un resumen hostil no parte el asunto, no esconde texto y no crece sin tope', async () => {
  const { resumenDe, RESUMEN_MAX } = await import('../src/correo/politica.js');
  const cp = (n) => String.fromCodePoint(n);   // los invisibles se construyen, nunca se escriben
  const ext = (text) => ({ extensions: { 'urn:nyx5:ext:resumen': { text } } });
  // Un salto de línea en el asunto de un correo es una cabecera nueva. `limpio` cambia los
  // controles por espacios ANTES de que el texto llegue al proveedor.
  assert.equal(resumenDe(ext('linea uno\r\nSubject: asunto falso')), 'linea uno Subject: asunto falso');
  assert.ok(!resumenDe(ext('a\nb')).includes('\n'));
  // Invisibles y bidi: un resumen no puede esconder texto ni dar vuelta lo que se lee.
  assert.equal(resumenDe(ext(`pa${cp(0x200b)}go ${cp(0x202e)}oditebed`)), 'pago oditebed');
  // Tope duro, y lo que no deja nada legible no viaja como vacío: no viaja.
  assert.equal(resumenDe(ext('x'.repeat(500))).length, RESUMEN_MAX);
  for (const basura of [42, null, {}, [], '   ', cp(0x200b) + cp(0x200b)]) assert.equal(resumenDe(ext(basura)), null, JSON.stringify(basura));
  assert.equal(resumenDe({}), null);
  assert.equal(resumenDe({ extensions: {} }), null);
});

test('D3 · `send` rechaza un resumen que no deja nada legible, en vez de mandarlo vacío', async () => {
  const { e, url, dom } = await casa({});
  try {
    const b = Agent.create(`remitente2@${dom}`, url, { hosts: { [dom]: { url } } });
    const c = Agent.create(`destino2@${dom}`, url, { hosts: { [dom]: { url } } });
    await b.register({ adminToken: 't' });
    await c.register({ adminToken: 't' });
    // Mismo criterio que `project`: etiquetar y que no viaje es peor que no etiquetar.
    await assert.rejects(() => b.send({ to: c.address, body: 'x', summary: `${String.fromCodePoint(0x200b)} ${String.fromCodePoint(0x200b)}` }), /invalid summary/);
    // Y sin resumen no se agrega ninguna extensión: lo que no se pide, no viaja.
    const env = await b.send({ to: c.address, body: 'x' });
    assert.ok(!env.extensions || !env.extensions['urn:nyx5:ext:resumen']);
  } finally { await e.stop(); }
});
