// Nyx5/1 — Notaría (NX-601): la casa sella el hash de un documento con fecha y firma.
//
// Qué certifica un sello: que en el instante `at` la casa recibió un sobre firmado (hash
// `op_sha256`) en el que `by` declaró el hash `sha256`. Nada más. La casa no ve el documento, no
// afirma que exista ni qué contiene: quien lo tenga puede demostrar que ya existía a esa fecha
// presentando el documento (su hash coincide) y el sello (la firma de la casa verifica con la
// tarjeta del dominio, sin cuenta).
//
// No mueve dinero: no hay asiento. El candado contra el doble sello es el índice único
// (sha256, by) del almacén, no el número de asiento: dos sobres distintos del mismo agente con el
// mismo hash producen UN sello (el primero) y la segunda petición recibe ese mismo sello. Dos
// agentes distintos sí producen dos sellos: cada uno atestigua que ÉL lo declaró.
//
// Dos versiones firmadas del mismo sello, con el mismo id: `sello` (con `by`) y `anonimo` (con
// `by: null`). La pública sirve la primera si el agente es visible y la segunda si es secreto,
// para que un secreto no quede confirmado por su propio sello (NX-202) y aun así la firma
// verifique. Las dos comparten id, sha256, at y op_sha256: son el mismo hecho, con o sin nombre.
//
// Qué NO cubre: no prueba autoría del documento (prueba quién lo DECLARÓ), no prueba que el
// documento sea anterior a `at` (sólo que no es posterior), y no verifica que `media` o `name`
// describan al documento: son lo que el declarante dijo.

import { signObject, uuid } from '../nucleo/crypto.js';
import { limpio } from '../correo/politica.js';
import { LibroError } from './errores.js';

export const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
export const LIMITES = Object.freeze({ name: 120, media: 100, note: 500 });

const fail = (code, msg) => { throw new LibroError(code, msg); };

// Valida el cuerpo de la op. Campos desconocidos se ignoran (invariante 7). El hash se normaliza
// a minúsculas: el mismo documento no puede tener dos sellos por cómo se escribió su hash.
export function validarNotarize(body = {}) {
  if (typeof body.sha256 !== 'string' || !SHA256_HEX.test(body.sha256)) fail(400, 'sha256 must be the hex digest of the document: 64 hexadecimal characters');
  const texto = (k) => {
    if (body[k] == null) return null;
    if (typeof body[k] !== 'string') fail(400, `${k} must be a string`);
    return limpio(body[k], LIMITES[k]) || null;
  };
  return { sha256: body.sha256.toLowerCase(), name: texto('name'), media: texto('media'), note: texto('note') };
}

// Construye el registro firmado. `keys` son las llaves del dominio (las mismas que firman recibos).
export function sellar({ sha256, name, media, note, by, house, at, op_sha256, secret = false }, keys) {
  const cuerpo = { nyx5: '1', tipo: 'sello', id: uuid(), sha256, name, media, note, by, house, at, op_sha256 };
  return {
    id: cuerpo.id, sha256, by, at,
    // `secret` es la visibilidad del declarante cuando selló: un agente de OTRA casa no se puede
    // re-consultar en vivo desde aquí, así que lo que se supo al sellar es lo que manda para él.
    secret: !!secret,
    sello: signObject(cuerpo, keys),
    anonimo: signObject({ ...cuerpo, by: null }, keys),
  };
}

// Lo que se sirve al público por un registro: la versión con nombre si el declarante es
// visible para «nadie» (quien pregunta sin cuenta), la anónima si no.
export function selloPublico(doc, visible) { return visible ? doc.sello : doc.anonimo; }

// La op del Libro. Corre dentro de la transacción de Libro.handle(): escribe con libro.putSello.
export async function notarize(ctx) {
  const { libro, from, body, senderCard, opHash } = ctx;
  const v = validarNotarize(body);
  const previo = await libro.store.notariaFind(v.sha256, from);
  if (previo) {
    // El mismo declarante ya selló este hash: se le devuelve ESE sello, no se crea otro. La
    // receta lleva el hash del sobre que la pidió (invariante 5) aunque el sello sea anterior.
    return { result: { seal: previo.sello, existing: true }, recibos: [{ to: [from], body: { seal: previo.sello, existing: true } }] };
  }
  const doc = sellar({ ...v, by: from, house: libro.domain, at: new Date().toISOString(), op_sha256: opHash, secret: senderCard?.visibility === 'secret' }, libro.keys);
  libro.putSello(doc);
  return { result: { seal: doc.sello, existing: false }, recibos: [{ to: [from], body: { seal: doc.sello, existing: false } }] };
}
