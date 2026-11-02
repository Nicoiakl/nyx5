// Nyx5/1 — Adjuntos cifrados (NX-413, 2-nov-2026): el sobre lleva archivos de verdad.
//
// POR QUÉ EXISTE: `attachments` estaba en la spec desde la fase 0 y NINGUNA casa alojaba un byte.
// En la práctica un agente que dice «te adjunto los archivos» manda rutas de SU máquina, y el que
// recibe —otra máquina— no las ve. Le pasó varias veces a Nicholas entre un agente de cowork y uno
// de code. No es una función nueva: es cerrar una promesa publicada.
//
// CÓMO, en una línea: el remitente cifra el archivo con una llave suya, lo sube al almacén de
// objetos de su casa, y el sobre lleva la referencia. La casa aloja bytes que no puede abrir.
//
// Lo que la casa SABE de un adjunto (metadatos, espacio `adjuntos` del kv) es SOBRE, no contenido:
//   { blob, by, allow, bytes, sha256, created, until, got }
// Lo que la casa NO sabe y no puede deducir: el nombre del archivo, su tipo y la llave. Eso viaja
// dentro del bloque cifrado del sobre (`attachments[]` del contenido). `balance-despido-javier.pdf`
// dice casi todo sin abrirlo: el nombre es contenido, y por eso no está aquí.
//
// Tres decisiones que no se reabren (encargo del 2-nov-2026):
//   1. El archivo va CIFRADO. Un adjunto en claro sería el agujero por donde la estafeta lee lo que
//      el invariante 8 promete no leer. Lo cuida la primera prueba de test/adjuntos.test.js.
//   2. La `url` NO viaja en el sobre: se deriva (`https://<casa del remitente>/blob/<blobId>`).
//      Una url en el sobre es una url que alguien puede cambiar por otra.
//   3. En un sobre cifrado, el array de AFUERA lleva sólo `blob` y `bytes` (lo valida politica.js).
//
// Y una del método: el cupo se incrementa ANTES de comparar, como `puertaIdeas()`. Dos relojes que
// suben a la vez pueden pasarse por uno, nunca por mucho.

import { parseAddress } from './resolver.js';
import { sha256hex, IV_BLOB, TAG_BLOB } from '../nucleo/crypto.js';

// Cupos, decididos en el encargo. Son del OBJETO guardado (lo que la casa paga), no del claro:
// el objeto cifrado mide 28 bytes más (iv + tag), y por eso el tope por adjunto los suma, para que
// un archivo de exactamente 10 MB quepa.
export const LIMITES = {
  porAdjunto: 10 * 1024 * 1024,
  adjuntosPorSobre: 10,
  porSobre: 25 * 1024 * 1024,
  porRemitenteDia: 100 * 1024 * 1024,
  porCasa: 1024 * 1024 * 1024,
};
export const NS = 'adjuntos';            // metadatos: clave = blobId
export const NS_CUPO = 'adjuntos-cupo';  // `<from>:<día>:bytes` (vence) y `casa:bytes` (permanente)
export const RETENCION = 30 * 24 * 3600 * 1000;        // lo normal
export const RETENCION_BAJADO = 7 * 24 * 3600 * 1000;  // una vez que todos los destinatarios lo tienen
const DIA_MS = 24 * 3600 * 1000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// La clave del objeto. NUNCA el nombre del archivo: un nombre trae `../` y revela contenido.
export const claveObjeto = (blobId) => `blobs/${String(blobId).toLowerCase()}`;
// El AAD ata el cifrado a ESTE objeto y a ESTE remitente: un adjunto no se reusa desde otra
// dirección ni se hace pasar por otro objeto, aunque alguien tenga la llave.
export const aadDe = (blobId, from) => `nyx5:blob:${String(blobId).toLowerCase()}:${String(from).toLowerCase()}`;
// La url se DERIVA; no viaja en el sobre.
export const urlDe = (estafeta, blobId) => `${String(estafeta).replace(/\/$/, '')}/blob/${String(blobId).toLowerCase()}`;

const minus = (x) => String(x || '').toLowerCase();
const iso = (t) => new Date(t).toISOString();
const dia = (nowMs) => iso(nowMs).slice(0, 10);
const venceDia = (nowMs) => (Math.floor(nowMs / DIA_MS) + 2) * DIA_MS;
const MB = (n) => `${Math.round(n / 1024 / 1024)} MB`;

// Lo que la casa anuncia de su almacén de objetos, para la tarjeta del dominio y la spec.
export const capacidadAdjuntos = () => ({
  max_bytes: LIMITES.porAdjunto,
  max_per_envelope: LIMITES.adjuntosPorSobre,
  max_bytes_per_envelope: LIMITES.porSobre,
  retention_days: RETENCION / DIA_MS,
  encryption: 'A256GCM',
});

// ---------- subir ----------
// PUT /blob/<blobId>?to=a@casa,b@otra · cuerpo = el objeto CIFRADO, tal cual.
// La casa no mira dentro, no sabe de qué archivo es, y guarda el sha256 del CIFRADO para su propia
// integridad (el del CLARO viaja en el sobre, para que el receptor compruebe que descifró lo correcto).
export async function subirAdjunto(est, who, blobId, objeto, { to = '', nowMs = Date.now() } = {}) {
  if (!UUID.test(String(blobId))) return { status: 400, body: { reason: 'the blob id must be a uuid: the house never names an object after the file' } };
  const bytes = objeto ? objeto.length : 0;
  if (!bytes) return { status: 400, body: { reason: 'empty body: the request carries the encrypted object as raw bytes' } };
  // El tope por adjunto se comprueba ANTES de tocar un contador: un archivo demasiado grande no
  // gasta el cupo del día de quien lo intentó (no hay carrera que lo justifique, es aritmética).
  if (bytes > LIMITES.porAdjunto + IV_BLOB + TAG_BLOB) {
    return { status: 413, body: { reason: `attachment of ${bytes} bytes exceeds the maximum ${LIMITES.porAdjunto} (${MB(LIMITES.porAdjunto)}) per attachment` } };
  }
  const destinos = [];
  for (const t of String(to).split(',').map((s) => s.trim()).filter(Boolean)) {
    try { const { local, domain } = parseAddress(t); destinos.push(`${local}@${domain}`); } catch { return { status: 400, body: { reason: `invalid recipient: ${t}` } }; }
  }
  if (destinos.length > 50) return { status: 400, body: { reason: 'an attachment authorizes at most 50 recipients' } };

  const clave = `${minus(who.address)}:${dia(nowMs)}:bytes`;
  // Se suma ANTES de comparar: con dos relojes subiendo a la vez, el que se pasa cierra el día.
  // Un intento rechazado por cupo SÍ gasta cupo: es lo que corta una inundación.
  const delDia = await est.store.kvIncrement(NS_CUPO, clave, venceDia(nowMs), nowMs, bytes);
  if (delDia > LIMITES.porRemitenteDia) {
    return { status: 403, body: { reason: `this sender reached its attachment quota of ${MB(LIMITES.porRemitenteDia)} (${LIMITES.porRemitenteDia} bytes) per UTC day` } };
  }
  // El de la casa es un cupo de lo GUARDADO, no de lo histórico: sube al guardar y BAJA al borrar.
  // Por eso, a diferencia del diario, un intento que no llega a guardar se devuelve (si no, el
  // 1 GB de la casa se erosionaría con cada rechazo y acabaría bloqueando a todo el mundo).
  // Ojo con el contrato del almacén: FileStore implementa en SÍNCRONO y D1Store en async real, así
  // que un `.catch()` pegado al resultado reventaría en local y andaría en producción. Se espera
  // con await, siempre, y lo que falle al devolver el cupo se anota (no puede tapar el motivo real).
  const devolver = async () => { try { await est.store.kvIncrement(NS_CUPO, 'casa:bytes', null, nowMs, -bytes); } catch (e) { est.log(`adjuntos: no se pudo devolver el cupo de la casa: ${e.message}`); } };
  const deLaCasa = await est.store.kvIncrement(NS_CUPO, 'casa:bytes', null, nowMs, bytes);
  if (deLaCasa > LIMITES.porCasa) {
    await devolver();
    return { status: 507, body: { reason: `this house reached its attachment storage of ${LIMITES.porCasa / (1024 * 1024 * 1024)} GB (${LIMITES.porCasa} bytes)` } };
  }

  const meta = {
    blob: minus(blobId), by: minus(who.address),
    allow: [...new Set([minus(who.address), ...destinos.map(minus)])],
    bytes, sha256: sha256hex(objeto), created: iso(nowMs), until: iso(nowMs + RETENCION), got: [],
  };
  // Un blobId ya usado no se pisa: el candado es el kv, no una lectura previa (dos isolates).
  if (!await est.store.kvPutIfAbsent(NS, meta.blob, meta, null, nowMs)) {
    await devolver();
    return { status: 409, body: { reason: 'that blob id is already taken: generate another' } };
  }
  try {
    await est.objetos.put(claveObjeto(meta.blob), objeto);
  } catch (e) {
    // Metadatos sin objeto es un adjunto que el destinatario no puede bajar y nadie limpia: se
    // deshace el alta completa antes de contestar.
    try { await est.store.kvDelete(NS, meta.blob); } catch (e2) { est.log(`adjuntos: metadatos huérfanos de ${meta.blob}: ${e2.message}`); }
    await devolver();
    throw e;
  }
  return { status: 201, body: { blob: meta.blob, bytes, sha256: meta.sha256, url: urlDe(est.publicUrl, meta.blob), until: meta.until, allow: meta.allow } };
}

// ---------- bajar ----------
// GET /blob/<blobId>, con firma Ed25519 como el buzón. Sin firma 401 (exista o no el objeto: la
// autenticación va ANTES de mirar si existe, para no ser un oráculo). Firma de un tercero, 403.
export async function bajarAdjunto(est, who, blobId, { nowMs = Date.now() } = {}) {
  if (!UUID.test(String(blobId))) return { status: 404, body: { reason: 'no such attachment' } };
  const meta = await est.store.kvGet(NS, minus(blobId), nowMs);
  // La retención se aplica al LEER, no sólo cuando el reloj pasa: si el reloj se cae, un adjunto
  // vencido sigue sin poder bajarse. El reloj recupera el espacio; esto cumple la promesa.
  if (!meta || Date.parse(meta.until) <= nowMs) return { status: 404, body: { reason: 'no such attachment' } };
  if (!meta.allow.includes(minus(who.address))) return { status: 403, body: { reason: 'this attachment was sent to someone else' } };
  const objeto = await est.objetos.get(claveObjeto(meta.blob));
  if (!objeto) return { status: 404, body: { reason: 'no such attachment' } };

  // Quién ya lo tiene. Cuando TODOS los destinatarios lo bajaron, la casa no necesita guardarlo un
  // mes: la retención se acorta a 7 días. «Confirmar» aquí es haberlo bajado — es lo único que esta
  // puerta puede medir, y la spec lo dice con esas palabras en vez de prometer otra cosa.
  if (minus(who.address) !== meta.by && !meta.got.includes(minus(who.address))) {
    const got = [...meta.got, minus(who.address)];
    const faltan = meta.allow.filter((a) => a !== meta.by && !got.includes(a));
    const until = faltan.length ? meta.until : iso(Math.min(Date.parse(meta.until), nowMs + RETENCION_BAJADO));
    await est.store.kvPut(NS, meta.blob, { ...meta, got, until });
  }
  return { status: 200, contentType: 'application/octet-stream', body: Buffer.from(objeto), headers: { 'x-nyx5-blob-sha256': meta.sha256 } };
}

// ---------- borrar ----------
// Sólo quien lo subió. Un destinatario no borra un adjunto ajeno: la copia es del remitente.
export async function borrarAdjunto(est, who, blobId, { nowMs = Date.now() } = {}) {
  if (!UUID.test(String(blobId))) return { status: 404, body: { reason: 'no such attachment' } };
  const meta = await est.store.kvGet(NS, minus(blobId), nowMs);
  if (!meta) return { status: 404, body: { reason: 'no such attachment' } };
  if (minus(who.address) !== meta.by) return { status: 403, body: { reason: 'only the sender deletes an attachment' } };
  await _retirar(est, meta, nowMs);
  return { status: 200, body: { blob: meta.blob, deleted: true, bytes: meta.bytes } };
}

async function _retirar(est, meta, nowMs) {
  await est.objetos.delete(claveObjeto(meta.blob));
  await est.store.kvDelete(NS, meta.blob);
  await est.store.kvIncrement(NS_CUPO, 'casa:bytes', null, nowMs, -meta.bytes);
}

// ---------- limpieza por reloj ----------
// La retención se cumple borrando: 30 días, o 7 desde que el último destinatario lo bajó. Se
// recorre por METADATOS, no por el bucket: en R2 listar es paginado y caro, y la fila es la verdad.
export async function limpiarAdjuntos(est, { nowMs = Date.now(), max = 100 } = {}) {
  if (!est.objetos || !est.store.kvList) return 0;
  let n = 0;
  for (const { doc } of await est.store.kvList(NS, { limit: max }, nowMs)) {
    if (!doc?.until || Date.parse(doc.until) > nowMs) continue;
    await _retirar(est, doc, nowMs);
    n++;
  }
  return n;
}
