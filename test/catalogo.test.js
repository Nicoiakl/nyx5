// node --test test/
// Catálogo de servicios en la ficha (NX-301): un agente publica lo que vende (id, precio, unidad,
// contrato, prueba de aceptación) dentro de su ficha certificada, y una cotización que nombre un
// `service` se compara contra lo publicado al aceptar. El precio y el contrato de la cotización
// tienen que ser los de la ficha; si no, la casa rechaza NOMBRANDO la diferencia. Mismo espíritu
// que las tareas sembradas: los términos publicados no se negocian en la cotización.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { Libro, MEDIA } from '../src/libro/libro.js';
import { PRUEBAS } from '../src/libro/verifica.js';
import { validarPerfil, usdSinBilletera } from '../src/correo/politica.js';
import { TOOLS, llamar } from '../src/puentes/herramientas.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4641;
const H = 'catalogo.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
let tmp, casa, vende, compra;
// Mismos helpers que test/libro.test.js: el rebote del postmaster trae la razón del Libro.
const bounce = async (agent, sentId) => (await agent.open((await agent.waitFor((e) => e.type === 'receipt' && e.from === `postmaster@${H}` && e.in_reply_to === sentId, { timeoutMs: 6000 })).envelope)).content.body;
const receiveQuote = async (buyer, q) => (await buyer.open((await buyer.waitFor((e) => e.id === q.id)).envelope)).content.body;

const servicio = (extra = {}) => ({ id: 'informe', name: 'Informe de mercado', summary: 'En 24 h', price: { tokens: 300 }, unit: 'job', contract: 'escrow', acceptance: { kind: 'sha256', template: 'el hash del informe entregado' }, ...extra });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-catalogo-'));
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {} }).start();
  vende = Agent.create(`vende@${H}`, URL_CASA, { hosts });
  compra = Agent.create(`compra@${H}`, URL_CASA, { hosts });
  for (const a of [vende, compra]) await a.register({ adminToken: 't' });
  await casa.libro.topup(compra.address, 2000, 'carga');
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('validarPerfil: hasta 20 servicios, precio entero, vocabulario cerrado, y sólo pruebas que verifica@ sabe correr', () => {
  const ok = validarPerfil({ services: [servicio()] });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.perfil.services[0], servicio());
  // Tope de 20: el 21 se rechaza nombrando el tope.
  const veinte = Array.from({ length: 20 }, (_, i) => servicio({ id: `s-${i}` }));
  assert.equal(validarPerfil({ services: veinte }).perfil.services.length, 20);
  assert.match(validarPerfil({ services: [...veinte, servicio({ id: 's-20' })] }).error, /up to 20/);
  // Precio: entero positivo en tokens; nada de flotantes ni de cero.
  assert.match(validarPerfil({ services: [servicio({ price: { tokens: 2.5 } })] }).error, /price\.tokens must be a positive integer/);
  assert.match(validarPerfil({ services: [servicio({ price: { tokens: 0 } })] }).error, /positive integer/);
  assert.match(validarPerfil({ services: [servicio({ price: { tokens: 300, usd: 1.5 } })] }).error, /decimal string/);
  assert.match(validarPerfil({ services: [servicio({ price: { tokens: 300, usd: '0' } })] }).error, /decimal string/);
  assert.equal(validarPerfil({ services: [servicio({ price: { tokens: 300, usd: '1.50' } })] }).perfil.services[0].price.usd, '1.50');
  // Vocabulario cerrado: una clave ajena se nombra; unidad y contrato de lista fija.
  assert.match(validarPerfil({ services: [servicio({ color: 'rojo' })] }).error, /"color"/);
  assert.match(validarPerfil({ services: [servicio({ unit: 'week' })] }).error, /unit must be one of job, call, hour/);
  assert.match(validarPerfil({ services: [servicio({ contract: 'bond' })] }).error, /contract must be one of/);
  assert.match(validarPerfil({ services: [servicio({ id: 'Informe' })] }).error, /id must be/);
  assert.match(validarPerfil({ services: [servicio(), servicio()] }).error, /appears twice/);
  // La prueba de aceptación sólo puede ser una que verifica@ corre de verdad: la lista es la de verifica.js.
  const e = validarPerfil({ services: [servicio({ acceptance: { kind: 'llm_judge', template: 'x' } })] }).error;
  assert.match(e, /acceptance\.kind/);
  for (const k of PRUEBAS) assert.ok(e.includes(k), `el error tiene que listar ${k}`);
  for (const k of PRUEBAS) assert.equal(validarPerfil({ services: [servicio({ acceptance: { kind: k, template: 'x' } })] }).error, undefined);
  // Un servicio sin nombre o con texto invisible: se limpia como el resto de la ficha.
  assert.match(validarPerfil({ services: [servicio({ name: '' })] }).error, /name must be/);
  assert.equal(validarPerfil({ services: [servicio({ name: 'Infor\u200bme  X' })] }).perfil.services[0].name, 'Informe X');
});

test('usd sin billetera se rechaza en la ruta de la ficha y en el registro; con billetera pasa', async () => {
  assert.match(usdSinBilletera({ services: [servicio({ price: { tokens: 300, usd: '1.50' } })] }, null), /"informe" declares a usd price but the card has no wallet/);
  assert.equal(usdSinBilletera({ services: [servicio({ price: { tokens: 300, usd: '1.50' } })] }, [{ network: 'eip155:8453', address: '0x' + 'a'.repeat(40) }]), null);
  assert.equal(usdSinBilletera({ services: [servicio()] }, null), null);
  // Por la ruta: vende no declaró billetera.
  await assert.rejects(() => vende.setProfile({ services: [servicio({ price: { tokens: 300, usd: '1.50' } })] }), /no wallet/);
  // Por el registro: la ficha y la billetera viajan juntas al registrar; sin billetera, 400.
  const sin = Agent.create(`sin-billetera@${H}`, URL_CASA, { hosts });
  await assert.rejects(() => sin.register({ adminToken: 't', profile: { services: [servicio({ price: { tokens: 300, usd: '1.50' } })] } }), /no wallet/);
  const con = Agent.create(`con-billetera@${H}`, URL_CASA, { hosts });
  const card = await con.register({ adminToken: 't', wallets: [{ network: 'eip155:8453', address: '0x' + 'b'.repeat(40) }], profile: { services: [servicio({ price: { tokens: 300, usd: '1.50' } })] } });
  assert.equal(card.profile.services[0].price.usd, '1.50');
  // La ficha con servicios queda certificada y se lee en la tarjeta (directorio y /resolve la sirven entera).
  assert.equal((await compra.profile(con.address)).profile.services[0].id, 'informe');
});

test('cotizar con `service` sin escribir precio: el contrato sale con el precio y el contrato publicados', async () => {
  await vende.setProfile({ display_name: 'Vende', services: [servicio()] });
  const antes = await casa.libro.balance(compra.address);
  const q = await vende.quote({ to: compra.address, service: 'informe' });
  assert.equal(q.quote.price, 300); assert.equal(q.quote.contract, 'escrow'); assert.equal(q.quote.concept, 'Informe de mercado'); assert.equal(q.quote.service, 'informe');
  const cot = await receiveQuote(compra, q);
  const r = await compra.awaitReceipt((await compra.accept(cot)).id);
  assert.equal(r.receipt.contract.kind, 'escrow');
  assert.equal(r.receipt.contract.amount, 300);
  assert.equal(r.receipt.contract.state, 'held');
  assert.equal(await casa.libro.balance(compra.address), antes - 300, 'el escrow retuvo el precio publicado');
  await vende.awaitReceipt((await vende.deliver(H, r.receipt.contract.id, { note: 'listo' })).id);
  await compra.awaitReceipt((await compra.release(H, r.receipt.contract.id)).id);
});

test('una cotización con precio o contrato distintos del publicado se rechaza nombrando la diferencia', async () => {
  const q = await vende.quote({ to: compra.address, service: 'informe', price: 250, contract: 'spot' });
  const cot = await receiveQuote(compra, q);
  const razon = (await bounce(compra, (await compra.accept(cot)).id)).reason;
  assert.match(razon, /service informe is published at 300 tok as escrow; the quote says 250 as spot/);
  // Sólo el precio distinto también se nombra, con el contrato correcto.
  const q2 = await vende.quote({ to: compra.address, service: 'informe', price: 299 });
  assert.match((await bounce(compra, (await compra.accept(await receiveQuote(compra, q2))).id)).reason, /published at 300 tok as escrow; the quote says 299 as escrow/);
  // El guardia vive en la casa, no en el cliente: si el vendedor cambia el catálogo DESPUÉS de cotizar,
  // la cotización vieja ya no coincide con la ficha certificada de hoy y se rechaza igual.
  const q3 = await vende.quote({ to: compra.address, service: 'informe' });
  const cot3 = await receiveQuote(compra, q3);
  await vende.setProfile({ display_name: 'Vende', services: [servicio({ price: { tokens: 350 } })] });
  assert.match((await bounce(compra, (await compra.accept(cot3)).id)).reason, /published at 350 tok as escrow; the quote says 300 as escrow/);
  await vende.setProfile({ display_name: 'Vende', services: [servicio()] });
});

test('una cotización a un servicio que no está en la ficha se rechaza, en el cliente y en la casa', async () => {
  await assert.rejects(() => vende.quote({ to: compra.address, service: 'nada' }), /"nada" is not published/);
  // Una cotización firmada a mano con un service inexistente: el cliente no la para, la casa sí.
  const q = Libro.buildQuote({ seller: vende.address, buyer: compra.address, house: H, contract: 'spot', price: 300, concept: 'x', service: 'nada' }, vende.keys);
  const enviado = await vende.send({ to: compra.address, type: 'message', media: MEDIA.cotizacion, body: q });
  const cot = await receiveQuote(compra, enviado);
  assert.match((await bounce(compra, (await compra.accept(cot)).id)).reason, /service "nada" is not published in the profile of vende@catalogo\.test/);
  // Sin `service`, la cotización libre sigue funcionando como siempre: el catálogo no obliga a usarlo.
  const libre = await vende.quote({ to: compra.address, price: 10, concept: 'suelto' });
  const r = await compra.awaitReceipt((await compra.accept(await receiveQuote(compra, libre))).id);
  assert.equal(r.receipt.contract.state, 'settled');
  // Un id de servicio que no es un id (forma inválida) no llega a firmarse.
  assert.throws(() => Libro.buildQuote({ seller: vende.address, buyer: compra.address, house: H, price: 1, concept: 'x', service: 'Con Espacios' }, vende.keys), /service debe ser/);
});

test('herramientas: nyx5_quote acepta `service`, nyx5_profile set/get muestran services, y el conteo no cambió', async () => {
  assert.equal(TOOLS.length, 22, 'no se agregó ninguna herramienta: el catálogo va por las que ya existen');
  const puesto = JSON.parse((await llamar(vende, 'nyx5_profile', { op: 'set', profile: { services: [servicio({ id: 'lema', name: 'Lema', price: { tokens: 40 }, contract: 'spot', acceptance: undefined })] } })).content[0].text);
  assert.equal(puesto.profile.services[0].id, 'lema');
  const leido = JSON.parse((await llamar(compra, 'nyx5_profile', { op: 'get', address: vende.address })).content[0].text);
  assert.deepEqual(leido.profile.services.map((s) => s.id), ['lema']);
  const r = JSON.parse((await llamar(vende, 'nyx5_quote', { to: compra.address, service: 'lema' })).content[0].text);
  assert.equal(r.price, 40); assert.equal(r.contract, 'spot'); assert.equal(r.service, 'lema');
  // Sin service hay que dar precio y concepto: la herramienta lo dice en vez de firmar una cotización sin precio.
  const err = await llamar(vende, 'nyx5_quote', { to: compra.address });
  assert.equal(err.isError, true); assert.match(err.content[0].text, /price and concept, or a service/);
});
