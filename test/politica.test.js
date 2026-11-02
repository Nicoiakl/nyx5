// node --test test/
// La validación de `attachments` (NX-413), contra un adjunto PRODUCIDO POR EL CÓDIGO QUE SUBE.
//
// Por qué así y no con un literal escrito a mano: ese defecto ya pasó dos veces en esta casa (las
// `li_cards` de Rosetta y la llave del rol en `ejecutor`). El lector y su prueba comparten el
// supuesto equivocado, y la suite da verde con el defecto vivo. Aquí el sobre lo arma `send()` de
// verdad, con un archivo que subió `subirAdjunto()` de verdad, y la prueba MUTA ese sobre real
// para comprobar cada rechazo.
//
// Lo que estas pruebas cuidaron primero: la verificación por mutación dijo que el vocabulario
// CERRADO del array de afuera no gritaba al quitarlo. No gritaba porque ningún test mandaba un
// sobre cifrado con un campo prohibido afuera — el cliente de la casa nunca lo hace. Un cliente
// viejo, o uno hostil, sí. Eso es lo que se prueba acá.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { validateEnvelope, validarAdjuntos, ADJUNTO_CIFRADO, ADJUNTO_CLARO, ADJUNTOS } from '../src/correo/politica.js';
import { signObject, uuid } from '../src/nucleo/crypto.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4863;
const H = 'politica.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
let tmp, casa, emi, recibe;
// El adjunto y el sobre REALES de esta suite: los produce el código que sube y el que envía.
let att, sobre;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-politica-'));
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {} }).start();
  emi = Agent.create(`emisora@${H}`, URL_CASA, { hosts });
  recibe = Agent.create(`receptora@${H}`, URL_CASA, { hosts });
  await emi.register({ adminToken: 't' });
  await recibe.register({ adminToken: 't' });
  att = await emi.subirAdjunto(Buffer.from('el contenido real del archivo'), { name: 'informe.pdf', media: 'application/pdf', to: [recibe.address] });
  sobre = (await emi.send({ to: recibe.address, body: 'con adjunto', attachments: [att] })).envelope;
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Vuelve a firmar un sobre modificado: así entra por la puerta de todos con firma válida, que es
// como llegaría el de un cliente viejo o el de alguien que quiere colar un campo.
const refirmar = (env) => signObject(env, emi.keys);
// Lo que contesta la casa a un sobre que su dueño le entrega en /outbound.
async function entregar(env) {
  const res = await fetch(`${URL_CASA}/outbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: emi._auth('POST', '/outbound') },
    body: JSON.stringify(refirmar(env)),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('el sobre que produce el código es válido, y afuera del cifrado lleva SÓLO blob y bytes', () => {
  // No es un literal: es lo que `send()` armó con lo que `subirAdjunto()` devolvió.
  assert.equal(validateEnvelope(sobre).ok, true, `el sobre real no pasa su propia validación: ${validateEnvelope(sobre).reason}`);
  assert.ok(sobre.encrypted, 'este sobre tiene que ir cifrado para que la prueba signifique algo');
  assert.deepEqual(Object.keys(sobre.attachments[0]).sort(), ADJUNTO_CIFRADO.slice().sort());
  assert.equal(sobre.attachments[0].blob, att.blob);
  assert.equal(sobre.attachments[0].bytes, att.bytes);
  // Y lo que el emisor subió trae todo lo que el receptor necesita, que es lo que va ADENTRO.
  for (const k of ADJUNTO_CLARO) assert.ok(att[k] != null, `el descriptor real no trae ${k}`);
  // La `url` es del DESCRIPTOR, para quien sube, y NO del sobre: se deriva de la casa del
  // remitente al bajar. Una url firmada en el sobre sería una url que alguien puede cambiar por
  // otra, y `url` no está en el vocabulario de ninguno de los dos arrays.
  assert.ok(att.url, 'el descriptor le dice a quien subió dónde quedó');
  assert.ok(!ADJUNTO_CLARO.includes('url') && !ADJUNTO_CIFRADO.includes('url'), 'la url no es un campo del sobre');
  assert.equal(JSON.stringify(sobre).includes(att.url), false, 'la url viajó en el sobre');
});

test('un sobre CIFRADO con la ficha completa afuera se rechaza, y nombra el campo: la casa no ve el nombre del archivo', async () => {
  // El caso real: un cliente que mete el descriptor entero afuera. `name` afuera del cifrado le
  // cuenta a la casa y a cada estafeta del camino casi todo el contenido.
  const entero = { ...sobre, attachments: [{ ...att }] };
  const motivo = validarAdjuntos(entero.attachments, { cifrado: true });
  assert.ok(motivo, 'la ficha completa afuera de un sobre cifrado pasó la validación');
  assert.match(motivo, /name/, `el motivo no nombra el campo: ${motivo}`);
  assert.match(motivo, /encrypted block|outside/i, `el motivo no dice dónde va: ${motivo}`);
  assert.equal(validateEnvelope(entero).ok, false);
  // Y la casa lo rechaza de verdad, no sólo la función: el sobre va firmado y entra por /outbound.
  const r = await entregar(entero);
  assert.equal(r.status, 400, `la casa aceptó un sobre con la ficha afuera: ${JSON.stringify(r.body)}`);
  assert.match(r.body.reason, /name/);
  // Cada campo de contenido, uno por uno: ninguno puede viajar afuera de un sobre cifrado.
  for (const k of ['name', 'media', 'sha256', 'key']) {
    const uno = { ...sobre, attachments: [{ blob: att.blob, bytes: att.bytes, [k]: att[k] }] };
    const m = validarAdjuntos(uno.attachments, { cifrado: true });
    assert.ok(m && m.includes(k), `${k} afuera del cifrado no se rechaza por nombre: ${m}`);
    const res = await entregar(uno);
    assert.equal(res.status, 400, `la casa aceptó ${k} afuera del cifrado`);
  }
  // Un campo inventado también: el vocabulario es CERRADO, no una lista de prohibidos.
  const raro = validarAdjuntos([{ blob: att.blob, bytes: att.bytes, preview: 'una miniatura' }], { cifrado: true });
  assert.ok(raro && raro.includes('preview'), `un campo desconocido afuera pasó: ${raro}`);
});

test('en un sobre EN CLARO la ficha completa sí viaja, llave incluida: se permite y la casa lo ve', async () => {
  const claro = (await emi.send({ to: recibe.address, body: 'a la vista', attachments: [att], encrypt: false })).envelope;
  assert.ok(claro.content, 'este sobre tiene que ir en claro para que la prueba signifique algo');
  assert.equal(validateEnvelope(claro).ok, true, validateEnvelope(claro).reason);
  assert.equal(claro.attachments[0].name, 'informe.pdf');
  assert.equal(claro.attachments[0].key, att.key, 'sin la llave afuera, un sobre en claro no se puede abrir');
  // Lo que NO cambia: el objeto del almacén sigue cifrado. Lo que cambia es quién tiene la llave.
  assert.equal(validarAdjuntos(claro.attachments, { cifrado: false }), null);
});

test('los topes del sobre se cuentan sobre adjuntos reales: 11 adjuntos y 26 MB declarados', () => {
  const once = Array.from({ length: ADJUNTOS.max + 1 }, () => ({ blob: uuid(), bytes: att.bytes }));
  assert.match(validarAdjuntos(once, { cifrado: true }), new RegExp(`${ADJUNTOS.max}`));
  const diez = Array.from({ length: ADJUNTOS.max }, () => ({ blob: uuid(), bytes: att.bytes }));
  assert.equal(validarAdjuntos(diez, { cifrado: true }), null, 'diez adjuntos pequeños tienen que pasar');
  const gordos = [1, 2, 3].map(() => ({ blob: uuid(), bytes: 9 * 1024 * 1024 }));
  assert.match(validarAdjuntos(gordos, { cifrado: true }), /26214400|25 MB/);
  // Un adjunto solo que se pasa del tope por adjunto, aunque el sobre no se pase.
  assert.match(validarAdjuntos([{ blob: uuid(), bytes: ADJUNTOS.bytesPorAdjunto + 1 }], { cifrado: true }), /10485760|10 MB/);
  // El mismo blob dos veces en un sobre: no es un adjunto, es el mismo contado dos veces.
  assert.match(validarAdjuntos([{ blob: att.blob, bytes: att.bytes }, { blob: att.blob, bytes: att.bytes }], { cifrado: true }), /repeats/);
});

test('cada campo de la ficha se valida contra el valor real, mutándolo', () => {
  // La ficha tal como viaja: la del descriptor menos `url`, que no es un campo del sobre.
  const { url: _fuera, ...bueno } = att;
  assert.equal(validarAdjuntos([bueno], { cifrado: false }), null, 'el adjunto real no pasa su propia validación');
  const casos = [
    ['blob', 'no-es-un-uuid', /blob must be the uuid/],
    ['blob', '../../etc/passwd', /blob must be the uuid/],
    ['bytes', 0, /bytes must be an integer/],
    ['bytes', -1, /bytes must be an integer/],
    ['bytes', 1.5, /bytes must be an integer/],
    ['bytes', '100', /bytes must be an integer/],
    ['name', '', /name must be/],
    ['name', 'x'.repeat(ADJUNTOS.nombreMax + 1), null],      // se recorta, no se rechaza
    ['media', 'no-es-un-tipo', /media must be/],
    ['media', 'application/pdf; rm -rf', /media must be/],
    ['sha256', 'abc', /sha256 must be/],
    ['sha256', 'g'.repeat(64), /sha256 must be/],
    ['key', 'corta', /key must be/],
  ];
  for (const [campo, valor, espera] of casos) {
    const motivo = validarAdjuntos([{ ...bueno, [campo]: valor }], { cifrado: false });
    if (espera === null) { assert.equal(motivo, null, `${campo}=${String(valor).slice(0, 20)} debería pasar y dio: ${motivo}`); continue; }
    assert.ok(motivo, `${campo}=${String(valor).slice(0, 20)} pasó la validación`);
    assert.match(motivo, espera, `${campo}: ${motivo}`);
  }
  // Y lo que no es una ficha: la lista tiene que ser una lista de objetos.
  assert.match(validarAdjuntos('informe.pdf', { cifrado: true }), /must be a list/);
  assert.match(validarAdjuntos([null], { cifrado: true }), /must be an object/);
  assert.match(validarAdjuntos(['informe.pdf'], { cifrado: true }), /must be an object/);
  assert.match(validarAdjuntos([[att.blob]], { cifrado: true }), /must be an object/);
});

test('un sobre sin adjuntos no cambió: la validación de antes sigue valiendo igual', async () => {
  const simple = (await emi.send({ to: recibe.address, body: 'nada adjunto' })).envelope;
  assert.equal(simple.attachments, undefined);
  assert.equal(validateEnvelope(simple).ok, true);
  // Y los rechazos de siempre siguen ahí (una muestra: versión, id, destinatarios, firma).
  assert.equal(validateEnvelope({ ...simple, nyx5: '2' }).ok, false);
  assert.equal(validateEnvelope({ ...simple, id: 'corto' }).ok, false);
  assert.equal(validateEnvelope({ ...simple, to: [] }).ok, false);
  assert.equal(validateEnvelope({ ...simple, signature: undefined }).ok, false);
});
