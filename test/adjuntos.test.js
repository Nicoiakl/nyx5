// node --test test/
// NX-413 — adjuntos cifrados en el sobre (2-nov-2026).
//
// Nace de un síntoma de Nicholas: un agente de cowork le manda archivos a un agente de code, el de
// code acusa recibo del mensaje y los archivos no están. El campo `attachments` llevaba meses
// publicado en la spec (§5) y NINGUNA casa alojaba un byte: lo único que podía viajar eran rutas de
// la máquina del remitente, que la otra máquina no ve.
//
// La prueba que importa más que las otras es la primera, y se escribió ANTES del código: una cadena
// testigo va DENTRO del archivo, y no aparece ni en el objeto crudo del almacén, ni en sus
// metadatos, ni en el sobre que quedó en el buzón, ni en ningún archivo de ninguna de las dos
// casas. Si esa prueba falla, los adjuntos son el agujero por donde la casa lee lo que el
// invariante 8 promete no leer, y lo que está mal es el código, no la prueba.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { LIMITES, RETENCION, RETENCION_BAJADO, NS, NS_CUPO, claveObjeto, aadDe, limpiarAdjuntos } from '../src/correo/adjuntos.js';
import { decryptBlob, generateBlobKey, encryptBlob, sha256hex, uuid } from '../src/nucleo/crypto.js';
import { TOOLS, MENSAJERIA } from '../src/puentes/herramientas.js';

// Puertos propios de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P1 = 4861, P2 = 4862;
const H1 = 'cowork.adjuntos.test';
const H2 = 'code.adjuntos.test';
const URL1 = `http://127.0.0.1:${P1}`;
const URL2 = `http://127.0.0.1:${P2}`;
const hosts = { [H1]: { url: URL1 }, [H2]: { url: URL2 } };

// La cadena testigo: va dentro del archivo y no puede aparecer en ninguna otra parte por casualidad.
const TESTIGO = 'TESTIGO-9d0c1f3b-balance-despido-javier-NO-DEBE-APARECER';

let tmp, casa1, casa2, ana, carla, beto;

// Todos los archivos de un directorio (recursivo) que contengan estos bytes.
function archivosCon(dir, texto) {
  const aguja = Buffer.from(texto);
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, String(f));
    if (!fs.statSync(p).isFile()) continue;
    if (fs.readFileSync(p).includes(aguja)) out.push(p);
  }
  return out;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-adjuntos-'));
  casa1 = await new Estafeta({ domain: H1, port: P1, dataDir: path.join(tmp, H1), adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {} }).start();
  casa2 = await new Estafeta({ domain: H2, port: P2, dataDir: path.join(tmp, H2), adminToken: 't', hosts, workerIntervalMs: 60, libro: { welcome: 0, feeBps: 0 }, log: () => {} }).start();
  ana = Agent.create(`ana-cowork@${H1}`, URL1, { hosts });
  carla = Agent.create(`carla-fuera@${H1}`, URL1, { hosts });
  beto = Agent.create(`beto-code@${H2}`, URL2, { hosts });
  await ana.register({ adminToken: 't' });
  await carla.register({ adminToken: 't' });
  await beto.register({ adminToken: 't' });
});
after(async () => { await casa1?.stop(); await casa2?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------
// LA QUE IMPORTA: invariante 8
// ---------------------------------------------------------------------------------------------
test('invariante 8 · la casa guarda el adjunto y NO puede leerlo: la cadena testigo no aparece en el objeto crudo, ni en sus metadatos, ni en el sobre', async () => {
  const claro = Buffer.concat([Buffer.from('informe trimestral\n'), Buffer.from(TESTIGO), Buffer.from('\nfin\n')]);
  const att = await ana.subirAdjunto(claro, { name: 'balance-despido-javier.pdf', media: 'application/pdf', to: [beto.address] });
  await ana.send({ to: beto.address, body: 'te adjunto el balance', attachments: [att] });
  const llegado = await beto.waitFor((x) => x.from === ana.address, { timeoutMs: 6000 });

  // 1) El objeto CRUDO del almacén de la casa que lo aloja.
  const crudo = await casa1.objetos.get(claveObjeto(att.blob));
  assert.ok(crudo && crudo.length > 0, 'la casa no guardó ningún objeto');
  assert.ok(!Buffer.from(crudo).includes(Buffer.from(TESTIGO)), 'EL OBJETO CRUDO CONTIENE LA CADENA TESTIGO: el adjunto está en claro');
  assert.ok(!Buffer.from(crudo).includes(Buffer.from('informe trimestral')), 'el objeto crudo tiene texto del archivo en claro');
  // Y no es un objeto vacío ni basura: con la llave y el AAD correctos vuelve el claro exacto.
  assert.deepEqual(Buffer.from(decryptBlob(crudo, att.key, aadDe(att.blob, ana.address))), claro);

  // 2) Los metadatos que la casa guarda junto al objeto: sobre, no contenido. Ni el nombre del
  //    archivo (`balance-despido-javier.pdf` dice casi todo sin abrirlo) ni la llave.
  const meta = await casa1.store.kvGet(NS, att.blob);
  assert.ok(meta, 'la casa no guardó metadatos del objeto');
  assert.equal(meta.bytes, crudo.length);
  assert.deepEqual([...meta.allow].sort(), [ana.address, beto.address].sort(), 'la lista de autorizados es el from y los to');
  const metaTexto = JSON.stringify(meta);
  assert.ok(!metaTexto.includes(TESTIGO), 'los metadatos contienen la cadena testigo');
  assert.ok(!metaTexto.includes('balance-despido-javier'), 'los metadatos guardan el NOMBRE del archivo, que es contenido');
  assert.ok(!metaTexto.includes(att.key), 'los metadatos guardan la LLAVE del adjunto');
  assert.ok(!metaTexto.includes('application/pdf'), 'los metadatos guardan el tipo del archivo, que es contenido');

  // 3) El sobre que quedó en el buzón del destinatario: afuera sólo blob y bytes.
  const fuera = llegado.envelope.attachments;
  assert.equal(fuera.length, 1);
  assert.deepEqual(Object.keys(fuera[0]).sort(), ['blob', 'bytes']);
  assert.equal(fuera[0].blob, att.blob);
  const sobreTexto = JSON.stringify(llegado.envelope);
  assert.ok(!sobreTexto.includes(TESTIGO), 'el sobre lleva la cadena testigo');
  assert.ok(!sobreTexto.includes('balance-despido-javier'), 'el sobre lleva el nombre del archivo AFUERA del cifrado');
  assert.ok(!sobreTexto.includes(att.key), 'el sobre lleva la llave AFUERA del cifrado');

  // 4) Y en NINGÚN archivo de NINGUNA de las dos casas.
  for (const [nombre, dir] of [[H1, path.join(tmp, H1)], [H2, path.join(tmp, H2)]]) {
    assert.deepEqual(archivosCon(dir, TESTIGO), [], `la casa ${nombre} tiene la cadena testigo en disco`);
    assert.deepEqual(archivosCon(dir, 'balance-despido-javier'), [], `la casa ${nombre} tiene el nombre del archivo en disco`);
  }

  // 5) Y el destinatario SÍ lo lee: el nombre, el tipo y la llave viajan dentro del cifrado.
  const abierto = await beto.open(llegado.envelope);
  assert.equal(abierto.attachments.length, 1);
  assert.equal(abierto.attachments[0].name, 'balance-despido-javier.pdf');
  assert.equal(abierto.attachments[0].media, 'application/pdf');
  assert.equal(abierto.attachments[0].key, att.key);
  const bajado = await beto.bajarAdjunto(abierto.attachments[0], { from: abierto.from });
  assert.deepEqual(Buffer.from(bajado), claro);
  assert.ok(Buffer.from(bajado).includes(Buffer.from(TESTIGO)), 'el destinatario tiene que ver el testigo: es su archivo');
});

// ---------------------------------------------------------------------------------------------
// SILENCIO
// ---------------------------------------------------------------------------------------------
test('silencio · un adjunto de 1 MB va de una casa a otra y vuelve: el hash del CLARO cuadra en el otro extremo', async () => {
  const claro = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < claro.length; i++) claro[i] = (i * 31 + 7) & 0xff;
  const sha = sha256hex(claro);
  const att = await ana.subirAdjunto(claro, { name: 'datos.bin', media: 'application/octet-stream', to: [beto.address] });
  assert.equal(att.sha256, sha, 'el sha256 del descriptor es el del CLARO');
  assert.equal(att.bytes, claro.length, 'bytes es el tamaño del claro');
  assert.match(att.url, new RegExp(`/blob/${att.blob}$`), 'la url se deriva de la casa del remitente');

  const r = await ana.send({ to: beto.address, body: 'un mega', attachments: [att] });
  assert.equal(r.encrypted, true);
  const llegado = await beto.waitFor((x) => x.id === r.id, { timeoutMs: 8000 });
  const abierto = await beto.open(llegado.envelope);
  const bajado = await beto.bajarAdjunto(abierto.attachments[0], { from: abierto.from });
  assert.equal(sha256hex(bajado), sha, 'el hash del claro no cuadra en el otro extremo');
  // La respuesta del remitente también puede llevar adjunto: la ida y la vuelta usan el mismo camino.
  const vuelta = await beto.subirAdjunto(bajado, { name: 'datos-vuelta.bin', media: 'application/octet-stream', to: [ana.address] });
  await beto.send({ to: ana.address, body: 'de vuelta', attachments: [vuelta], inReplyTo: llegado.envelope.id });
  const devuelto = await ana.waitFor((x) => x.from === beto.address, { timeoutMs: 8000 });
  const ab2 = await ana.open(devuelto.envelope);
  assert.equal(sha256hex(await ana.bajarAdjunto(ab2.attachments[0], { from: ab2.from })), sha);
});

test('silencio · un sobre sin adjuntos sigue siendo exactamente lo que era', async () => {
  const r = await ana.send({ to: beto.address, body: 'sin nada adjunto' });
  const llegado = await beto.waitFor((x) => x.id === r.id, { timeoutMs: 6000 });
  assert.equal(llegado.envelope.attachments, undefined, 'un sobre sin adjuntos no gana el campo');
  const abierto = await beto.open(llegado.envelope);
  assert.equal(abierto.content.body, 'sin nada adjunto');
  assert.equal(abierto.attachments, null);
});

// ---------------------------------------------------------------------------------------------
// GRITO — cada uno tiene que fallar por SU razón, no por «falta firma»
// ---------------------------------------------------------------------------------------------
test('grito · un adjunto de 11 MB no se sube (413, nombrando el límite) y no gasta el cupo del día', async () => {
  const antes = Number(await casa1.store.kvGet(NS_CUPO, `${ana.address}:${new Date().toISOString().slice(0, 10)}:bytes`)) || 0;
  const grande = Buffer.alloc(LIMITES.porAdjunto + 1024 * 1024);
  await assert.rejects(
    () => ana.subirAdjunto(grande, { name: 'enorme.bin', media: 'application/octet-stream', to: [beto.address] }),
    (e) => {
      assert.equal(e.status, 413, `se esperaba 413, vino ${e.status}: ${e.message}`);
      assert.match(e.message, /10485760|10 MB/, `el motivo no nombra el límite: ${e.message}`);
      return true;
    });
  const despues = Number(await casa1.store.kvGet(NS_CUPO, `${ana.address}:${new Date().toISOString().slice(0, 10)}:bytes`)) || 0;
  assert.equal(despues, antes, 'un adjunto rechazado por tamaño gastó cupo del día');
});

// La verificación por mutación dijo que el tope de la CASA no gritaba: el cliente rechaza antes,
// así que ninguna prueba llegaba a la puerta. Un cliente viejo, o uno que no sea el nuestro, sí
// llega. El guardia que importa es el de la casa, y se prueba golpeando la ruta.
test('grito · el tope de 10 MB lo aplica la CASA, no sólo el cliente: 11 MB directo a la ruta da 413', async () => {
  const dia = new Date().toISOString().slice(0, 10);
  const antes = Number(await casa1.store.kvGet(NS_CUPO, `${ana.address}:${dia}:bytes`)) || 0;
  const blob = uuid();
  const r = await fetch(`${URL1}/blob/${blob}?to=${encodeURIComponent(beto.address)}`, {
    method: 'PUT', headers: { authorization: ana._auth('PUT', `/blob/${blob}`) },
    body: Buffer.alloc(LIMITES.porAdjunto + 1024 * 1024),
  });
  assert.equal(r.status, 413, `la casa aceptó 11 MB: ${r.status}`);
  assert.match((await r.json()).reason, /10485760|10 MB/);
  assert.equal(await casa1.objetos.get(claveObjeto(blob)), null, 'la casa guardó el objeto que rechazó');
  assert.equal(await casa1.store.kvGet(NS_CUPO, `${ana.address}:${dia}:bytes`), antes || null, 'un rechazo por tamaño gastó cupo del día');
});

test('grito · un sobre con 11 adjuntos se rechaza, y 26 MB declarados también', async () => {
  const uno = await ana.subirAdjunto(Buffer.from('x'), { name: 'uno.txt', media: 'text/plain', to: [beto.address] });
  const once = Array.from({ length: LIMITES.adjuntosPorSobre + 1 }, () => ({ ...uno, blob: uuid() }));
  await assert.rejects(() => ana.send({ to: beto.address, body: 'muchos', attachments: once }), (e) => {
    assert.match(e.message, new RegExp(`${LIMITES.adjuntosPorSobre}`), `el motivo no nombra el tope de adjuntos: ${e.message}`);
    return true;
  });
  // 25 MB por sobre: tres adjuntos de 9 MB DECLARADOS pasan el tope del sobre.
  const gordos = [1, 2, 3].map(() => ({ ...uno, blob: uuid(), bytes: 9 * 1024 * 1024 }));
  await assert.rejects(() => ana.send({ to: beto.address, body: 'gordos', attachments: gordos }), (e) => {
    assert.match(e.message, /26214400|25 MB/, `el motivo no nombra el tope del sobre: ${e.message}`);
    return true;
  });
});

test('grito · bajar sin firma es 401, y da EXACTAMENTE lo mismo que un blob que no existe', async () => {
  const att = await ana.subirAdjunto(Buffer.from('secreto'), { name: 'a.txt', media: 'text/plain', to: [beto.address] });
  const existe = await fetch(`${URL1}/blob/${att.blob}`);
  const noExiste = await fetch(`${URL1}/blob/${uuid()}`);
  assert.equal(existe.status, 401);
  assert.equal(noExiste.status, 401, 'un blob inexistente contesta otra cosa: es un oráculo de existencia');
  assert.equal(await existe.text(), await noExiste.text(), 'el cuerpo distingue un blob que existe de uno que no');
  const cab = (r) => [...r.headers].filter(([k]) => k !== 'date').map(([k, v]) => `${k}:${v}`).sort().join('\n');
  assert.equal(cab(existe), cab(noExiste), 'las cabeceras distinguen un blob que existe de uno que no');
});

test('grito · un tercero con firma válida recibe 403: sólo el remitente y los destinatarios bajan', async () => {
  const att = await ana.subirAdjunto(Buffer.from('sólo para beto'), { name: 'b.txt', media: 'text/plain', to: [beto.address] });
  await assert.rejects(() => carla.bajarAdjunto(att, { from: ana.address }), (e) => {
    assert.equal(e.status, 403, `se esperaba 403, vino ${e.status}: ${e.message}`);
    return true;
  });
  // El remitente sí, y el destinatario de otra casa también.
  assert.equal(String(await ana.bajarAdjunto(att, { from: ana.address })), 'sólo para beto');
  assert.equal(String(await beto.bajarAdjunto(att, { from: ana.address })), 'sólo para beto');
});

test('grito · el AAD ata el adjunto al blob y al remitente: con otra dirección o otro blob no se descifra', async () => {
  const att = await ana.subirAdjunto(Buffer.from('atado'), { name: 'c.txt', media: 'text/plain', to: [beto.address] });
  const crudo = await casa1.objetos.get(claveObjeto(att.blob));
  assert.throws(() => decryptBlob(crudo, att.key, aadDe(att.blob, carla.address)), /./, 'el AAD de otro remitente descifró');
  assert.throws(() => decryptBlob(crudo, att.key, aadDe(uuid(), ana.address)), /./, 'el AAD de otro blob descifró');
  assert.throws(() => decryptBlob(crudo, generateBlobKey(), aadDe(att.blob, ana.address)), /./, 'otra llave descifró');
  assert.deepEqual(Buffer.from(decryptBlob(crudo, att.key, aadDe(att.blob, ana.address))), Buffer.from('atado'));
});

test('grito · un sha256 del CLARO que no cuadra se rechaza y dice CUÁL adjunto', async () => {
  const att = await ana.subirAdjunto(Buffer.from('contenido verdadero'), { name: 'contrato-final.pdf', media: 'application/pdf', to: [beto.address] });
  const falseado = { ...att, sha256: 'f'.repeat(64) };
  await assert.rejects(() => beto.bajarAdjunto(falseado, { from: ana.address }), (e) => {
    assert.match(e.message, /contrato-final\.pdf/, `el error no nombra el adjunto: ${e.message}`);
    assert.match(e.message, /sha256|hash/i, `el error no dice que falló el hash: ${e.message}`);
    return true;
  });
});

test('grito · el cupo del remitente corta en 100 MB por día UTC, y el de la casa en 1 GB, con la razón', async () => {
  const dia = new Date().toISOString().slice(0, 10);
  // Se precarga el contador a su tope: así la prueba usa la constante REAL sin mover 100 MB.
  await casa1.store.kvIncrement(NS_CUPO, `${carla.address}:${dia}:bytes`, null, Date.now(), LIMITES.porRemitenteDia);
  await assert.rejects(() => carla.subirAdjunto(Buffer.from('uno más'), { name: 'd.txt', media: 'text/plain', to: [ana.address] }), (e) => {
    assert.equal(e.status, 403, `se esperaba 403, vino ${e.status}: ${e.message}`);
    assert.match(e.message, /100 MB|104857600/, `el motivo no nombra el cupo del remitente: ${e.message}`);
    assert.match(e.message, /day|día/i, `el motivo no dice que es por día: ${e.message}`);
    return true;
  });
  await casa1.store.kvDelete(NS_CUPO, `${carla.address}:${dia}:bytes`);
  // El de la casa, igual: se precarga y el siguiente no entra, sea quien sea.
  await casa1.store.kvIncrement(NS_CUPO, 'casa:bytes', null, Date.now(), LIMITES.porCasa);
  await assert.rejects(() => ana.subirAdjunto(Buffer.from('uno más'), { name: 'e.txt', media: 'text/plain', to: [beto.address] }), (e) => {
    assert.equal(e.status, 507, `se esperaba 507, vino ${e.status}: ${e.message}`);
    assert.match(e.message, /1 GB|1073741824/, `el motivo no nombra el cupo de la casa: ${e.message}`);
    return true;
  });
  await casa1.store.kvIncrement(NS_CUPO, 'casa:bytes', null, Date.now(), -LIMITES.porCasa);
  // Y después de liberarlo, se vuelve a poder subir: el cupo de la casa es lo GUARDADO, no lo histórico.
  const ok = await ana.subirAdjunto(Buffer.from('ya se puede'), { name: 'f.txt', media: 'text/plain', to: [beto.address] });
  assert.ok(ok.blob);
});

test('grito · el nombre del archivo nunca es la clave del objeto, y un blobId que no es uuid se rechaza', async () => {
  const att = await ana.subirAdjunto(Buffer.from('ruta'), { name: '../../etc/passwd', media: 'text/plain', to: [beto.address] });
  assert.match(att.blob, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'el blobId no es un uuid');
  assert.equal(claveObjeto(att.blob), `blobs/${att.blob}`);
  assert.deepEqual(archivosCon(path.join(tmp, H1), 'etc/passwd'), [], 'el nombre del archivo llegó al disco de la casa');
  // Una clave que no es uuid no se acepta ni para subir ni para bajar.
  for (const malo of ['../domain', 'no-es-uuid', 'a'.repeat(200)]) {
    const r = await fetch(`${URL1}/blob/${encodeURIComponent(malo)}`, { method: 'PUT', headers: { authorization: ana._auth('PUT', `/blob/${encodeURIComponent(malo)}`) }, body: Buffer.from('x') });
    assert.ok(r.status === 400 || r.status === 404, `${malo}: se esperaba 400/404, vino ${r.status}`);
  }
});

test('grito · un blobId ya usado no se pisa', async () => {
  const att = await ana.subirAdjunto(Buffer.from('primero'), { name: 'g.txt', media: 'text/plain', to: [beto.address] });
  const r = await fetch(`${URL1}/blob/${att.blob}?to=${encodeURIComponent(beto.address)}`, {
    method: 'PUT', headers: { authorization: ana._auth('PUT', `/blob/${att.blob}`) }, body: Buffer.from('segundo'),
  });
  assert.equal(r.status, 409, `se esperaba 409, vino ${r.status}`);
  assert.equal(String(await casa1.objetos.get(claveObjeto(att.blob))).length > 0, true);
  assert.equal(String(await ana.bajarAdjunto(att, { from: ana.address })), 'primero', 'el segundo PUT pisó el objeto');
});

// ---------------------------------------------------------------------------------------------
// Borrar y retención
// ---------------------------------------------------------------------------------------------
test('borrar: sólo el dueño, y el cupo de la casa baja con lo que se fue', async () => {
  const att = await ana.subirAdjunto(Buffer.from('para borrar'), { name: 'h.txt', media: 'text/plain', to: [beto.address] });
  const casaAntes = Number(await casa1.store.kvGet(NS_CUPO, 'casa:bytes')) || 0;
  await assert.rejects(() => beto.borrarAdjunto(att.blob, { house: H1 }), (e) => (assert.equal(e.status, 403), true));
  assert.ok(await casa1.objetos.get(claveObjeto(att.blob)), 'un destinatario borró un adjunto ajeno');
  await ana.borrarAdjunto(att.blob);
  assert.equal(await casa1.objetos.get(claveObjeto(att.blob)), null, 'el objeto sigue ahí');
  assert.equal(await casa1.store.kvGet(NS, att.blob), null, 'los metadatos siguen ahí');
  const casaDespues = Number(await casa1.store.kvGet(NS_CUPO, 'casa:bytes')) || 0;
  assert.ok(casaDespues < casaAntes, `el cupo de la casa no bajó: ${casaAntes} -> ${casaDespues}`);
  // Y el destinatario ya no lo baja: 404, no un error de cifrado.
  await assert.rejects(() => beto.bajarAdjunto(att, { from: ana.address }), (e) => (assert.equal(e.status, 404), true));
});

test('retención: 30 días, 7 cuando todos los destinatarios ya lo bajaron, y el reloj limpia lo vencido', async () => {
  const att = await ana.subirAdjunto(Buffer.from('retención'), { name: 'i.txt', media: 'text/plain', to: [beto.address] });
  const m0 = await casa1.store.kvGet(NS, att.blob);
  const dias = (iso) => Math.round((Date.parse(iso) - Date.parse(m0.created)) / 86400000);
  assert.equal(dias(m0.until), RETENCION / 86400000, 'la retención inicial no es de 30 días');
  // Cuando todos los destinatarios lo tienen, la casa no necesita guardarlo un mes.
  await beto.bajarAdjunto(att, { from: ana.address });
  const m1 = await casa1.store.kvGet(NS, att.blob);
  assert.deepEqual(m1.got, [beto.address], 'la casa no anotó quién lo bajó');
  assert.ok(Date.parse(m1.until) < Date.parse(m0.until), 'la retención no se acortó al bajarlo el último destinatario');
  assert.ok(Math.abs(Date.parse(m1.until) - (Date.now() + RETENCION_BAJADO)) < 60_000, 'la retención acortada no es de 7 días');
  // La retención se aplica al LEER, antes de que el reloj pase: si el reloj se cae, un adjunto
  // vencido no se baja igual. La mutación dijo que esto no gritaba, porque la prueba de abajo
  // borra el objeto antes de pedirlo y el 404 venía de que no estaba, no de la retención.
  const otro = await ana.subirAdjunto(Buffer.from('vencido pero presente'), { name: 'viejo.txt', media: 'text/plain', to: [beto.address] });
  const mv = await casa1.store.kvGet(NS, otro.blob);
  await casa1.store.kvPut(NS, otro.blob, { ...mv, until: new Date(Date.now() - 1000).toISOString() });
  assert.ok(await casa1.objetos.get(claveObjeto(otro.blob)), 'el objeto tiene que seguir ahí para que la prueba signifique algo');
  await assert.rejects(() => beto.bajarAdjunto(otro, { from: ana.address }), (e) => (assert.equal(e.status, 404), true), 'un adjunto vencido se bajó porque el reloj no había pasado');
  // El reloj limpia lo vencido: objeto y metadatos se van juntos, y el cupo de la casa baja.
  await casa1.store.kvPut(NS, att.blob, { ...m1, until: new Date(Date.now() - 1000).toISOString() });
  const n = await limpiarAdjuntos(casa1, { nowMs: Date.now() });
  assert.ok(n >= 1, 'el reloj no limpió nada');
  assert.equal(await casa1.objetos.get(claveObjeto(att.blob)), null, 'el objeto vencido sigue en el almacén');
  assert.equal(await casa1.store.kvGet(NS, att.blob), null, 'los metadatos del objeto vencido siguen ahí');
  // Lo que NO está vencido no se toca.
  const vivo = await ana.subirAdjunto(Buffer.from('vivo'), { name: 'j.txt', media: 'text/plain', to: [beto.address] });
  await limpiarAdjuntos(casa1, { nowMs: Date.now() });
  assert.ok(await casa1.objetos.get(claveObjeto(vivo.blob)), 'el reloj se llevó un objeto vivo');
});

// ---------------------------------------------------------------------------------------------
// Lo que un agente lee antes de decidir qué expone
// ---------------------------------------------------------------------------------------------
test('las herramientas MCP dicen el límite y que la llave nunca sale del bloque cifrado, y no las ofrece el conector remoto', () => {
  const subir = TOOLS.find((t) => t.name === 'nyx5_attach');
  const bajar = TOOLS.find((t) => t.name === 'nyx5_attachment');
  assert.ok(subir, 'falta nyx5_attach');
  assert.ok(bajar, 'falta nyx5_attachment');
  assert.match(subir.description, /10 MB/, 'nyx5_attach no dice el límite por adjunto');
  assert.match(subir.description, /key never leaves|never leaves the encrypted/i, 'nyx5_attach no dice que la llave no sale del bloque cifrado');
  assert.match(bajar.description, /sha256|hash/i, 'nyx5_attachment no dice que se comprueba el hash');
  for (const t of [subir, bajar]) assert.ok(!/[áéíóúñ¿¡]/.test(t.description), `${t.name} quedó en español`);
  // La llave del subagente del conector remoto vive en la bóveda: la casa cifraría en su nombre y
  // el archivo pasaría por la casa en claro. Va sólo por el puente local, como el pedido de pago.
  assert.ok(!MENSAJERIA.has('nyx5_attach'), 'el conector remoto no ofrece subir adjuntos');
  assert.ok(!MENSAJERIA.has('nyx5_attachment'), 'el conector remoto no ofrece bajar adjuntos');
});

test('la tarjeta del dominio publica los cupos SÓLO si la casa aloja adjuntos de verdad', async () => {
  const card = await casa1.domainCard();
  assert.equal(card.attachments.max_bytes, LIMITES.porAdjunto);
  assert.equal(card.attachments.max_per_envelope, LIMITES.adjuntosPorSobre);
  assert.equal(card.attachments.max_bytes_per_envelope, LIMITES.porSobre);
  assert.equal(card.attachments.retention_days, 30);
  // Y una casa sin almacén NO los anuncia: un límite anunciado es la promesa de que hay dónde
  // guardar, y una promesa sin nada detrás es el defecto que este ítem vino a cerrar.
  const sin = new Estafeta({ domain: 'sin-tarjeta.adjuntos.test', port: P1 + 101, dataDir: path.join(tmp, 'sin-tarjeta'), adminToken: 't', hosts, sinObjetos: true, log: () => {} });
  await sin.init();
  assert.equal((await sin.domainCard()).attachments, undefined, 'una casa sin almacén anuncia cupos que no puede cumplir');
});

test('una casa sin almacén de objetos lo dice, en vez de aceptar y perder el archivo', async () => {
  const sin = new Estafeta({ domain: 'sin.adjuntos.test', port: P1 + 100, dataDir: path.join(tmp, 'sin'), adminToken: 't', hosts, objetos: null, sinObjetos: true, log: () => {} });
  await sin.init();
  const r = await sin.handleRequest({ method: 'GET', path: `/blob/${uuid()}`, query: new URLSearchParams(), headers: {}, body: null, ip: 'x' });
  assert.equal(r.status, 503);
  assert.match(r.body.reason, /attachment/i);
});

test('el cifrado del adjunto es AES-256-GCM con iv y tag en el objeto, y una llave por adjunto', async () => {
  const a = await ana.subirAdjunto(Buffer.from('mismo contenido'), { name: 'k.txt', media: 'text/plain', to: [beto.address] });
  const b = await ana.subirAdjunto(Buffer.from('mismo contenido'), { name: 'k.txt', media: 'text/plain', to: [beto.address] });
  assert.notEqual(a.key, b.key, 'dos adjuntos comparten llave');
  assert.notEqual(a.blob, b.blob);
  const ca = await casa1.objetos.get(claveObjeto(a.blob));
  const cb = await casa1.objetos.get(claveObjeto(b.blob));
  assert.ok(!Buffer.from(ca).equals(Buffer.from(cb)), 'el mismo contenido dio el mismo cifrado: la casa deduce igualdad');
  assert.equal(ca.length, 12 + 'mismo contenido'.length + 16, 'el objeto es iv(12) + ct + tag(16)');
  // Y un bit cambiado en el objeto no se descifra: el tag lo caza.
  const roto = Buffer.from(ca); roto[20] ^= 0x01;
  assert.throws(() => decryptBlob(roto, a.key, aadDe(a.blob, ana.address)), /./, 'un objeto alterado se descifró');
  // La llave es de 32 bytes, y encryptBlob/decryptBlob son simétricos fuera de la casa.
  const k = generateBlobKey();
  assert.equal(Buffer.from(k, 'base64url').length, 32);
  assert.deepEqual(Buffer.from(decryptBlob(encryptBlob(Buffer.from('ida'), k, 'aad'), k, 'aad')), Buffer.from('ida'));
});
