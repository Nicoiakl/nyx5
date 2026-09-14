// node --test test/
// NX-502 · Pedido de pago por transferencia (Chile): dinero REAL fuera del Libro. Lo que se prueba:
// que el RUT y el monto se validan antes de firmar (con los textos aprobados), que el sobre viaja
// CIFRADO y la casa no puede leer el RUT ni la cuenta (se mira el almacén, no la respuesta), que la
// confirmación referencia al pedido, que los eventos de la casa quedan SIN monto aunque el remitente
// intente meterlo, que un cobro a una dirección custodiada por la casa se rechaza en el cliente, que
// las dos herramientas existen y NO están en el remoto, y que la tarjeta de la app escapa todo lo que
// llega y sólo reconoce un cobro que llegó cifrado. Pruebas de grito (falla si se quita el guardia) y
// de silencio (lo bueno sigue pasando).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { generateKeys } from '../src/nucleo/crypto.js';
import { TOOLS, MENSAJERIA, llamar } from '../src/puentes/herramientas.js';
import { MEDIA_COBRO, MEDIA_COBRO_CONFIRMACION, EXT_COBRO, TEXTOS, validarCobro, validarConfirmacion, normalizarRut, formatearRut, digitoVerificador, eventoDeCobro, razonParaNoCobrar, extensionDeCobro } from '../src/correo/cobro.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4791;
const H = 'cobro.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
let tmp, casa, nico, pauli;
const eventos = async (name) => (await casa.store.listEvents({ name })) || [];

// Un cobro real: la Pauli le debe $15.000 a Nico por la cena.
const COBRO = { amount: 15000, currency: 'CLP', name: 'Nicholas Iakl', rut: '11.111.111-1', bank: 'Banco Estado', account_type: 'checking', account_number: '12345678', reference: 'Cena del viernes' };
const RUT_PLANO = '11111111-1';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-cobro-'));
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 60_000, libro: { welcome: 0 }, eventos: true, log: () => {} }).start();
  nico = Agent.create(`nico@${H}`, URL_CASA, { hosts });
  pauli = Agent.create(`pauli@${H}`, URL_CASA, { hosts });
  for (const a of [nico, pauli]) await a.register({ adminToken: 't' });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- validación ----------
test('RUT: módulo 11 acepta el válido con o sin puntos, normaliza, y rechaza el dígito malo', () => {
  assert.equal(digitoVerificador('11111111'), '1');
  assert.equal(digitoVerificador('12345678'), '5');
  for (const r of ['11.111.111-1', '11111111-1', '111111111', ' 11.111.111-1 ']) assert.equal(normalizarRut(r), RUT_PLANO, r);
  assert.equal(formatearRut('11111111-1'), '11.111.111-1');
  // Un RUT con K: el primer cuerpo cuyo dígito es K (se calcula, no se recuerda), en minúscula también.
  const cuerpoK = [...Array(30)].map((_, i) => String(1000000 + i)).find((c) => digitoVerificador(c) === 'K');
  assert.equal(normalizarRut(`${cuerpoK}-k`), `${cuerpoK}-K`);
  for (const r of ['11.111.111-2', '11.111.111-K', '1234-5', '', null, 42, 'abc']) assert.equal(normalizarRut(r), null, String(r));
  const v = validarCobro({ ...COBRO, rut: '11.111.111-2' });
  assert.equal(v.ok, false); assert.equal(v.field, 'rut'); assert.equal(v.error, TEXTOS.rut);
  assert.equal(TEXTOS.rut, 'RUT looks wrong (check the digit).');
});

test('ATAQUE 1 · un RUT con caracteres de control o invisibles NO se limpia: se rechaza', () => {
  // Los invisibles se escriben con escapes, nunca literales (CLAUDE.md: se corrompen en silencio).
  for (const r of ['11.111.111\u200b-1', '11.111.111-1\u0000', '\u202e11.111.111-1', '11\u00ad111111-1', '11.111.111-1;', '11.111.111-1\u2060', '11.111.111-\u0031\u0301']) {
    assert.equal(normalizarRut(r), null, JSON.stringify(r));
    assert.equal(validarCobro({ ...COBRO, rut: r }).error, TEXTOS.rut, JSON.stringify(r));
  }
});

test('monto: CLP entero > 0; un decimal o un texto con coma se rechaza con el texto aprobado', () => {
  for (const a of [15000, '15000', '1']) assert.equal(validarCobro({ ...COBRO, amount: a }).ok, true, String(a));
  assert.equal(validarCobro({ ...COBRO, amount: '15000' }).cobro.amount, 15000, 'el texto de dígitos se normaliza a número');
  for (const a of [1500.5, '1.500', '1,500', '15000.00', 0, -5, '', null, '1e3', ' 15 000 ', Infinity]) {
    const v = validarCobro({ ...COBRO, amount: a });
    assert.equal(v.ok, false, String(a)); assert.equal(v.field, 'amount'); assert.equal(v.error, TEXTOS.monto_clp);
  }
  assert.equal(TEXTOS.monto_clp, 'Amount must be a whole number of pesos.');
});

test('monto: USD con hasta dos decimales como texto; tres decimales se rechazan', () => {
  for (const a of ['12.50', '12.5', '12', 12.5, '0.01']) { const v = validarCobro({ ...COBRO, currency: 'USD', amount: a }); assert.equal(v.ok, true, String(a)); assert.equal(typeof v.cobro.amount, 'string'); }
  assert.equal(validarCobro({ ...COBRO, currency: 'USD', amount: 12.5 }).cobro.amount, '12.5');
  for (const a of ['12.345', 12.345, '12,50', '0', '0.00', '-1', '1e2', '']) { const v = validarCobro({ ...COBRO, currency: 'USD', amount: a }); assert.equal(v.ok, false, String(a)); assert.equal(v.field, 'amount'); }
  assert.equal(validarCobro({ ...COBRO, currency: 'EUR' }).field, 'currency');
  assert.equal(validarCobro({ ...COBRO, currency: 'usd', amount: '3.10' }).cobro.currency, 'USD', 'la moneda se normaliza a mayúsculas');
});

test('los demás campos: nombre y banco acotados y limpios, tipo de cuenta cerrado, número de cuenta dígitos y guiones, referencia opcional ≤140', () => {
  const ok = validarCobro(COBRO);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.cobro, { amount: 15000, currency: 'CLP', name: 'Nicholas Iakl', rut: RUT_PLANO, bank: 'Banco Estado', account_type: 'checking', account_number: '12345678', reference: 'Cena del viernes' });
  assert.equal(validarCobro({ ...COBRO, name: 'Nicho\u200blas  Iakl' }).cobro.name, 'Nicholas Iakl', 'invisibles fuera, espacios colapsados');
  assert.equal(validarCobro({ ...COBRO, name: 'x'.repeat(121) }).field, 'name');
  assert.equal(validarCobro({ ...COBRO, name: '' }).field, 'name');
  assert.equal(validarCobro({ ...COBRO, bank: 'b'.repeat(61) }).field, 'bank');
  assert.equal(validarCobro({ ...COBRO, account_type: 'corriente' }).field, 'account_type');
  for (const t of ['checking', 'savings', 'vista', 'Vista ']) assert.equal(validarCobro({ ...COBRO, account_type: t }).ok, true, t);
  assert.equal(validarCobro({ ...COBRO, account_number: '1234 5678' }).cobro.account_number, '12345678');
  assert.equal(validarCobro({ ...COBRO, account_number: '00-1234-5' }).ok, true);
  for (const n of ['12a', '1'.repeat(31), '', 'DROP TABLE']) assert.equal(validarCobro({ ...COBRO, account_number: n }).field, 'account_number', n);
  assert.equal(validarCobro({ ...COBRO, reference: undefined }).cobro.reference, '', 'la referencia es opcional');
  assert.equal(validarCobro({ ...COBRO, reference: 'r'.repeat(141) }).field, 'reference');
  assert.equal(validarCobro({ ...COBRO, request_id: 'x' }).field, 'request_id');
  assert.equal(validarCobro(null).ok, false);
  // La confirmación: referencia bancaria obligatoria y acotada; el request_id con la forma de un id.
  assert.deepEqual(validarConfirmacion({ request_id: 'abcdefgh', bank_reference: ' TRX-001 ' }), { ok: true, confirmacion: { request_id: 'abcdefgh', bank_reference: 'TRX-001' } });
  assert.equal(validarConfirmacion({ request_id: 'abcdefgh', bank_reference: '' }).field, 'bank_reference');
  assert.equal(validarConfirmacion({ request_id: 'abcdefgh', bank_reference: 'x'.repeat(81) }).field, 'bank_reference');
  assert.equal(validarConfirmacion({ request_id: 'ab', bank_reference: 'x' }).field, 'request_id');
});

// ---------- el evento que la casa anota ----------
test('GRITO · eventoDeCobro copia campo por campo: un monto o un RUT metidos en la extensión no llegan al evento', () => {
  const env = { extensions: { [EXT_COBRO]: { kind: 'request', request_id: 'abcdefgh-1', currency: 'CLP', amount: 15000, rut: RUT_PLANO, account_number: '12345678' } } };
  const ev = eventoDeCobro(env);
  assert.deepEqual(ev, { name: 'payment_requested', data: { request_id: 'abcdefgh-1', currency: 'CLP' } });
  assert.ok(!JSON.stringify(ev).includes('15000') && !JSON.stringify(ev).includes(RUT_PLANO));
  assert.equal(eventoDeCobro({ extensions: { [EXT_COBRO]: { kind: 'confirmation', request_id: 'abcdefgh-1', currency: 'USD' } } }).name, 'payment_confirmed');
  // Forma exacta o nada: kind ajeno, moneda ajena, id malformado, extensión ausente.
  for (const x of [{ kind: 'refund', request_id: 'abcdefgh-1', currency: 'CLP' }, { kind: 'request', request_id: 'abcdefgh-1', currency: 'EUR' }, { kind: 'request', request_id: 'a b', currency: 'CLP' }, 'texto', null, ['request']]) {
    assert.equal(eventoDeCobro({ extensions: { [EXT_COBRO]: x } }), null, JSON.stringify(x));
  }
  assert.equal(eventoDeCobro({}), null);
  assert.deepEqual(extensionDeCobro('request', { request_id: 'r', currency: 'CLP', amount: 9 }), { [EXT_COBRO]: { kind: 'request', request_id: 'r', currency: 'CLP' } });
});

// ---------- de punta a punta ----------
let pedido, pedidoAbierto;
test('el pedido viaja CIFRADO: la casa no puede leer el RUT ni la cuenta (se mira el almacén en disco), y anota payment_requested sin monto', async () => {
  pedido = await nico.paymentRequest({ to: pauli.address, ...COBRO });
  assert.equal(pedido.encrypted, true);
  assert.equal(pedido.to, pauli.address);
  assert.match(pedido.request_id, /^[0-9a-f-]{36}$/);
  const m = await pauli.waitFor((e) => e.id === pedido.id);
  assert.ok(m.envelope.encrypted && !m.envelope.content, 'el sobre en el buzón tiene encrypted y no content');
  // Lo que la casa ve: la extensión en claro con tres campos, ninguno es dinero.
  assert.deepEqual(m.envelope.extensions[EXT_COBRO], { kind: 'request', request_id: pedido.request_id, currency: 'CLP' });
  // El almacén ENTERO (buzones, bandeja de salida, cola, eventos): ni el RUT, ni la cuenta, ni el monto.
  const disco = leerTodo(path.join(tmp, H));
  for (const secreto of [RUT_PLANO, '11.111.111-1', '12345678', 'Banco Estado', 'Nicholas Iakl', '"amount":15000', 'Cena del viernes']) {
    assert.ok(!disco.includes(secreto), `el almacén contiene en claro: ${secreto}`);
  }
  // La Pauli sí lo lee, entero y validado.
  pedidoAbierto = await pauli.open(m.envelope);
  assert.equal(pedidoAbierto.encrypted, true);
  assert.equal(pedidoAbierto.content.media, MEDIA_COBRO);
  assert.deepEqual(pedidoAbierto.content.body, { request_id: pedido.request_id, amount: 15000, currency: 'CLP', name: 'Nicholas Iakl', rut: RUT_PLANO, bank: 'Banco Estado', account_type: 'checking', account_number: '12345678', reference: 'Cena del viernes' });
  // Y Nico también puede leer lo que mandó (entra al cifrado).
  const propio = (await nico.conversation(pauli.address)).find((x) => x.envelope.id === pedido.id);
  assert.equal((await nico.open(propio.envelope)).content.body.rut, RUT_PLANO);
  // El evento: actor, destinatario, id y moneda. Nada más.
  const ev = (await eventos('payment_requested')).find((e) => e.data.request_id === pedido.request_id);
  assert.ok(ev, 'la casa anotó payment_requested');
  assert.equal(ev.actor, nico.address);
  assert.deepEqual(ev.data, { request_id: pedido.request_id, currency: 'CLP', to: pauli.address });
});

test('la confirmación referencia al pedido (in_reply_to, hilo y request_id), viaja cifrada y anota payment_confirmed sin monto', async () => {
  const conf = await pauli.paymentConfirm(pedidoAbierto, { bank_reference: 'TRX-2026-0914-77' });
  assert.equal(conf.encrypted, true);
  assert.equal(conf.in_reply_to, pedido.id);
  assert.equal(conf.request_id, pedido.request_id);
  const m = await nico.waitFor((e) => e.id === conf.id);
  assert.equal(m.envelope.in_reply_to, pedido.id);
  assert.equal(m.envelope.thread, pedido.id, 'la confirmación va en el hilo del pedido');
  assert.equal(m.envelope.type, 'result');
  assert.deepEqual(m.envelope.extensions[EXT_COBRO], { kind: 'confirmation', request_id: pedido.request_id, currency: 'CLP' });
  const o = await nico.open(m.envelope);
  assert.equal(o.content.media, MEDIA_COBRO_CONFIRMACION);
  assert.deepEqual(o.content.body, { request_id: pedido.request_id, bank_reference: 'TRX-2026-0914-77' });
  assert.ok(!leerTodo(path.join(tmp, H)).includes('TRX-2026-0914-77'), 'la referencia bancaria tampoco queda en claro en el almacén');
  const ev = (await eventos('payment_confirmed')).find((e) => e.data.request_id === pedido.request_id);
  assert.ok(ev); assert.equal(ev.actor, pauli.address);
  assert.deepEqual(ev.data, { request_id: pedido.request_id, currency: 'CLP', to: nico.address });
  // Ningún evento de la casa lleva el monto.
  for (const e of [...await eventos('payment_requested'), ...await eventos('payment_confirmed')]) assert.ok(!('amount' in e.data) && !JSON.stringify(e).includes('15000'), JSON.stringify(e));
});

test('GRITO · un remitente que mete monto y RUT en la extensión en claro no los cuela al evento de la casa (se ataca la puerta real, no la función)', async () => {
  const forjado = await nico.send({ to: pauli.address, media: MEDIA_COBRO, body: { ...COBRO, rut: RUT_PLANO, request_id: 'forjado-0001' }, encrypt: true, extensions: { [EXT_COBRO]: { kind: 'request', request_id: 'forjado-0001', currency: 'CLP', amount: 99999, rut: RUT_PLANO, account_number: '12345678' } } });
  await pauli.waitFor((e) => e.id === forjado.id);
  const ev = (await eventos('payment_requested')).find((e) => e.data.request_id === 'forjado-0001');
  assert.ok(ev, 'el evento se anota igual (la forma mínima estaba)');
  assert.deepEqual(ev.data, { request_id: 'forjado-0001', currency: 'CLP', to: pauli.address });
  assert.ok(!JSON.stringify(ev).includes('99999') && !JSON.stringify(ev).includes(RUT_PLANO));
  // Y una extensión con moneda inventada no anota nada.
  const eur = await nico.send({ to: pauli.address, body: 'hola', encrypt: true, extensions: { [EXT_COBRO]: { kind: 'request', request_id: 'eur-00000001', currency: 'EUR' } } });
  await pauli.waitFor((e) => e.id === eur.id);
  assert.equal((await eventos('payment_requested')).some((e) => e.data.request_id === 'eur-00000001'), false);
});

test('ATAQUE 3 · confirmar un pedido ajeno: paymentConfirm exige que el pedido esté dirigido a quien confirma, y sólo un cobro cifrado cuenta', async () => {
  const otra = Agent.create(`otra@${H}`, URL_CASA, { hosts }); await otra.register({ adminToken: 't' });
  // `otra` tiene el sobre (se lo pasaron) pero no era para ella: no puede confirmar en nombre de la Pauli.
  await assert.rejects(() => otra.paymentConfirm(pedidoAbierto, { bank_reference: 'X' }), /was not addressed to otra@/);
  // Un mensaje que no es un cobro no se confirma.
  await assert.rejects(() => pauli.paymentConfirm({ ...pedidoAbierto, content: { media: 'text/plain', body: 'hola' } }, { bank_reference: 'X' }), /not a payment request/);
  // Un "cobro" que llegó EN CLARO (alguien lo mandó con nyx5_send sin cifrar) no se toma como pedido.
  const claro = await nico.send({ to: pauli.address, media: MEDIA_COBRO, body: { ...COBRO, rut: RUT_PLANO, request_id: 'claro-0001' }, encrypt: false });
  await pauli.waitFor((e) => e.id === claro.id);
  await assert.rejects(() => pauli.cobro(claro.id), /arrived in the clear/);
  // Y una referencia vacía tampoco sale.
  await assert.rejects(() => pauli.paymentConfirm(pedidoAbierto, { bank_reference: '   ' }), /bank_reference is required/);
});

test('un cobro con RUT inválido o monto no entero NO sale: falla antes de firmar, con el texto aprobado, y nada llega al buzón', async () => {
  const antes = (await pauli.inbox({ limit: 200 })).length, eventosAntes = (await eventos('payment_requested')).length;
  await assert.rejects(() => nico.paymentRequest({ to: pauli.address, ...COBRO, rut: '11.111.111-2' }), { message: TEXTOS.rut });
  await assert.rejects(() => nico.paymentRequest({ to: pauli.address, ...COBRO, amount: 1500.5 }), { message: TEXTOS.monto_clp });
  await assert.rejects(() => nico.paymentRequest({ to: pauli.address, ...COBRO, currency: 'USD', amount: '1.234' }), /two decimals/);
  assert.equal((await pauli.inbox({ limit: 200 })).length, antes, 'nada salió');
  assert.equal((await eventos('payment_requested')).length, eventosAntes, 'ningún evento nuevo');
});

test('un cobro a una dirección cuya llave guarda la casa (custody.keys = house) se rechaza en el cliente, con el motivo y el dueño', async () => {
  // Un asistente de sistema y un Claude conectado llevan custody.keys = house: la casa descifra por ellos.
  const k = generateKeys();
  await casa.registerAgent({ local: 'robot', sig: k.sig, enc: k.enc, custody: { keys: 'house', via: 'test' } });
  await assert.rejects(() => nico.paymentRequest({ to: `robot@${H}`, ...COBRO }), /key the house holds.*would read the bank details/);
  assert.equal(razonParaNoCobrar({ address: 'x@h', custody: { keys: 'house' }, delegation: { by: 'dueno@h' }, enc: 'k' }), 'x@h is an address whose key the house holds (a connected Claude): the house would read the bank details. Send the request to dueno@h instead');
  assert.match(razonParaNoCobrar({ address: 'x@h', enc: null }), /no encryption key/);
  assert.match(razonParaNoCobrar({ address: 'g.x@h', group: { members: [] } }), /is a group/);
  assert.equal(razonParaNoCobrar({ address: 'x@h', enc: 'k' }), null);
  // Sin llave de cifrado tampoco: el cobro no viaja en claro nunca.
  const sinLlave = generateKeys(); delete sinLlave.enc;
  await casa.registerAgent({ local: 'sinllave', sig: sinLlave.sig });
  await assert.rejects(() => nico.paymentRequest({ to: `sinllave@${H}`, ...COBRO }), /no encryption key/);
});

// ---------- herramientas MCP ----------
test('herramientas: nyx5_payment_request y nyx5_payment_confirm existen (29 en total), NO están en el remoto, y el remoto las niega', async () => {
  assert.equal(TOOLS.length, 29);
  const req = TOOLS.find((t) => t.name === 'nyx5_payment_request'), conf = TOOLS.find((t) => t.name === 'nyx5_payment_confirm');
  assert.ok(req && conf);
  assert.equal(req.title, 'Request a payment');
  assert.deepEqual(req.inputSchema.properties.currency.enum, ['CLP', 'USD']);
  assert.deepEqual(req.inputSchema.properties.account_type.enum, ['checking', 'savings', 'vista']);
  assert.ok(!MENSAJERIA.has('nyx5_payment_request') && !MENSAJERIA.has('nyx5_payment_confirm'), 'la llave del remoto la guarda la casa: los datos pasarían por ella en claro');
  assert.equal(MENSAJERIA.size, 15);
  for (const n of ['nyx5_payment_request', 'nyx5_payment_confirm']) {
    const negada = await llamar(nico, n, {}, { permitidas: MENSAJERIA });
    assert.equal(negada.isError, true); assert.match(negada.content[0].text, /messages-only/);
  }
});

test('herramientas: el recorrido entero por llamar(): pedir (validado), leer, confirmar con in_reply_to', async () => {
  const mal = await llamar(nico, 'nyx5_payment_request', { to: pauli.address, ...COBRO, rut: '11.111.111-9' }).catch((e) => e);
  assert.equal(mal.message, TEXTOS.rut);
  const r = JSON.parse((await llamar(nico, 'nyx5_payment_request', { to: pauli.address, ...COBRO, amount: '2500', reference: 'Café' })).content[0].text);
  assert.equal(r.encrypted, true); assert.equal(r.currency, 'CLP'); assert.match(r.note, /never touches the money/);
  const bandeja = JSON.parse((await llamar(pauli, 'nyx5_inbox', { limit: 50 })).content[0].text);
  const p = bandeja.find((x) => x.id === r.id);
  assert.equal(p.content.media, MEDIA_COBRO); assert.equal(p.content.body.amount, 2500); assert.equal(p.encrypted, true);
  const c = JSON.parse((await llamar(pauli, 'nyx5_payment_confirm', { in_reply_to: r.id, bank_reference: 'ABC-1' })).content[0].text);
  assert.equal(c.in_reply_to, r.id); assert.equal(c.request_id, r.request_id); assert.equal(c.encrypted, true);
  const m = await nico.waitFor((e) => e.id === c.id);
  assert.equal((await nico.open(m.envelope)).content.body.bank_reference, 'ABC-1');
  const inexistente = await llamar(pauli, 'nyx5_payment_confirm', { in_reply_to: 'no-existe-1', bank_reference: 'x' });
  assert.equal(inexistente.isError, true);
});

// ---------- la app: las funciones REALES de web/app.html, extraídas, no copiadas ----------
const html = fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
const bloque = (desde, hasta) => { const i = html.indexOf(desde), j = html.indexOf(hasta, i); assert.ok(i > 0 && j > i, `no encuentro ${desde}`); return html.slice(i, j); };
const escapar = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const app = new Function('escapar', `${bloque('const MEDIA_COBRO = ', 'const COBROS = new Map();')}; return { rutValido, rutNormal, rutBonito, montoNormal, cobroDe, lineasCobro, tarjetaCobro, PIE_COBRO };`)(escapar);
const CONTENIDO = { media: MEDIA_COBRO, body: { request_id: 'req-00000001', ...COBRO } };

test('app: el RUT y el monto se validan en el navegador con la misma regla que el cliente', () => {
  assert.equal(app.rutValido('11.111.111-1'), true);
  assert.equal(app.rutValido('11.111.111-2'), false);
  assert.equal(app.rutValido('11.111.111\u200b-1'), false);
  assert.equal(app.rutBonito('11111111-1'), '11.111.111-1');
  assert.equal(app.montoNormal('15000', 'CLP'), 15000);
  assert.equal(app.montoNormal('1500.5', 'CLP'), null);
  assert.equal(app.montoNormal('12.50', 'USD'), '12.50');
  assert.equal(app.montoNormal('12.345', 'USD'), null);
});

test('app: la tarjeta lleva los rótulos aprobados en su orden, los botones, y el pie fijo', () => {
  const c = app.cobroDe(CONTENIDO, true);
  assert.equal(c.kind, 'request');
  assert.deepEqual(app.lineasCobro(c), ['Amount: $15.000 CLP', 'To: Nicholas Iakl', 'RUT: 11.111.111-1', 'Bank: Banco Estado', 'Account: Checking 12345678', 'Reference: Cena del viernes']);
  const h = app.tarjetaCobro('env-1', c, false, null, 'encrypted');
  assert.match(h, /<div class="cobro-t">Payment request<\/div>/);
  assert.ok(h.indexOf('Amount: $15.000 CLP') < h.indexOf('To: Nicholas Iakl') && h.indexOf('RUT: 11.111.111-1') < h.indexOf('Bank: Banco Estado') && h.indexOf('Account: Checking 12345678') < h.indexOf('Reference: Cena del viernes'));
  assert.match(h, />Copy details</); assert.match(h, />I paid — confirm</); assert.match(h, /<label>Bank reference<\/label>/); assert.match(h, />Confirm</);
  assert.equal(app.PIE_COBRO, 'Nyx5 never touches the money. Pay from your own bank; this card only carries the details, encrypted, between the two of you.');
  assert.ok(h.includes(app.PIE_COBRO));
  // Los textos de estado los lleva la fuente de la app tal cual fueron aprobados.
  for (const t of ["toast('Copied.')", 'Confirmation sent. Nyx5 does not move money: it only carries your confirmation.', 'Request sent, encrypted. You will get a message when they confirm.', 'RUT looks wrong (check the digit).', 'Amount must be a whole number of pesos.', '<h1>Request a payment</h1>', 'Amount (CLP)', '>Name on the account<', '>RUT<', '>Bank<', '>Account type<', '>Checking<', '>Savings<', '>Vista<', '>Account number<', '>Reference (what is this for)<', '>Send request<', '>Request a payment<']) {
    assert.ok(html.includes(t), `la app no lleva el texto aprobado: ${t}`);
  }
  // USD y confirmada: una tarjeta propia confirmada muestra la referencia; una recibida y confirmada, la frase.
  const u = app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, currency: 'USD', amount: '12.50' } }, true);
  assert.equal(app.lineasCobro(u)[0], 'Amount: $12.50 USD');
  const mia = app.tarjetaCobro('env-2', c, true, 'TRX-9', 'sent');
  assert.match(mia, /Bank reference: TRX-9/); assert.doesNotMatch(mia, /Copy details|Confirmation sent/);
  const pagada = app.tarjetaCobro('env-3', c, false, 'TRX-9', 'encrypted');
  assert.match(pagada, /Confirmation sent\. Nyx5 does not move money: it only carries your confirmation\./); assert.match(pagada, /Bank reference: TRX-9/); assert.doesNotMatch(pagada, /I paid/);
});

test('ATAQUE 2 · XSS en reference, name y bank: todo lo que llega se escapa; y un cobro sin cifrar o malformado NO es una tarjeta', () => {
  const malo = { media: MEDIA_COBRO, body: { ...CONTENIDO.body, reference: '<img src=x onerror=alert(1)>', name: '"><script>x</script>', bank: '&lt;b&gt;' } };
  const c = app.cobroDe(malo, true);
  const h = app.tarjetaCobro('"><b>', c, false, null, '<i>');
  assert.ok(!h.includes('<img'), 'la referencia quedó sin escapar');
  assert.ok(!h.includes('<script'), 'el nombre quedó sin escapar');
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;') && h.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(h.includes('&amp;lt;b&amp;gt;'), 'un & ya escapado se vuelve a escapar, no se interpreta');
  assert.ok(h.includes('data-copiar="&quot;&gt;&lt;b&gt;"'), 'el id del sobre también se escapa en el atributo');
  assert.ok(!h.includes('<i>'), 'la meta se escapa');
  // GRITO: en claro no es tarjeta (la casa pudo leerlo y cambiarlo); tampoco con RUT malo, monto malo o tipo ajeno.
  assert.equal(app.cobroDe(CONTENIDO, false), null);
  assert.equal(app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, rut: '11.111.111-2' } }, true), null);
  assert.equal(app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, amount: '1.5' } }, true), null);
  assert.equal(app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, account_type: 'bitcoin' } }, true), null);
  assert.equal(app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, request_id: '<x>' } }, true), null);
  assert.equal(app.cobroDe({ media: 'text/plain', body: 'hola' }, true), null, 'SILENCIO: un texto normal sigue siendo texto');
  const conf = app.cobroDe({ media: MEDIA_COBRO_CONFIRMACION, body: { request_id: 'req-00000001', bank_reference: '<b>x</b>' } }, true);
  assert.deepEqual(conf, { kind: 'confirmation', request_id: 'req-00000001', bank_reference: '<b>x</b>' });
  assert.equal(app.cobroDe({ media: MEDIA_COBRO_CONFIRMACION, body: { request_id: 'req-00000001', bank_reference: '' } }, true), null);
});

test('app: nada del cobro va a localStorage, y el formulario no es un <form> (la CSP dice form-action none)', () => {
  const desde = html.indexOf('// ---------- payment request');
  const zona = html.slice(desde, html.indexOf('function hora(t)', desde));
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(zona));
  assert.ok(!/<form/.test(html));
  assert.match(html, /<section id="cobrar" class="scroll" hidden>/);
});

function leerTodo(dir) {
  let out = '';
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    out += f.isDirectory() ? leerTodo(p) : fs.readFileSync(p, 'utf8') + '\n';
  }
  return out;
}

// ---------- revisión adversarial (14-sep-2026): lo que la primera pasada no cubría ----------
test('ATAQUE 4 · la app no pinta tarjeta con account_type de prototipo, ni con campos más largos que el tope (misma regla que el servidor), ni de una contraparte cuya llave guarda la casa', () => {
  // `TIPOS_CUENTA[b.account_type]` encontraba `constructor` en el prototipo y pintaba
  // "Account: function Object() { [native code] } 12345678" como tarjeta válida.
  for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 42, null]) {
    assert.equal(app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, account_type: t } }, true), null, String(t));
    assert.equal(validarCobro({ ...COBRO, account_type: t }).ok, false, 'el servidor también: ' + String(t));
  }
  // La app recortaba a 120/60/140 y pintaba tarjeta donde el servidor rechaza: ahora divergir es imposible.
  for (const [k, max] of [['name', 120], ['bank', 60], ['reference', 140]]) {
    assert.equal(app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, [k]: 'x'.repeat(max + 1) } }, true), null, `${k} de ${max + 1}`);
    assert.equal(validarCobro({ ...COBRO, [k]: 'x'.repeat(max + 1) }).ok, false, `servidor: ${k} de ${max + 1}`);
    assert.ok(app.cobroDe({ media: MEDIA_COBRO, body: { ...CONTENIDO.body, [k]: 'x'.repeat(max) } }, true), `SILENCIO: ${k} en el tope sigue siendo tarjeta`);
    assert.equal(validarCobro({ ...COBRO, [k]: 'x'.repeat(max) }).ok, true, `SILENCIO servidor: ${k} en el tope`);
  }
  assert.equal(app.cobroDe({ media: MEDIA_COBRO_CONFIRMACION, body: { request_id: 'req-00000001', bank_reference: 'x'.repeat(81) } }, true), null);
  assert.ok(app.cobroDe({ media: MEDIA_COBRO_CONFIRMACION, body: { request_id: 'req-00000001', bank_reference: 'x'.repeat(80) } }, true));
  // Una contraparte con custody.keys = house: la casa firmó y cifró por ella, pudo escribir la cuenta. No es tarjeta.
  assert.equal(app.cobroDe(CONTENIDO, true, { address: 'claude.x@h', enc: 'k', custody: { keys: 'house', via: 'connector' } }), null);
  assert.ok(app.cobroDe(CONTENIDO, true, { address: 'x@h', enc: 'k' }), 'SILENCIO: una contraparte raíz sigue viendo la tarjeta');
  assert.ok(app.cobroDe(CONTENIDO, true, null), 'SILENCIO: contraparte desconocida (no resuelta) no bloquea');
  // El cableado: refrescarChat resuelve la tarjeta de la contraparte y se la pasa a abrir(). Sin esto, el guardia es prosa.
  assert.match(html, /const contra = await tarjeta\(CON\)\.catch\(\(\) => null\);/);
  assert.match(html, /await abrir\(m, contra\)/);
  assert.match(html, /function abrir\(m, contra\)/);
});
