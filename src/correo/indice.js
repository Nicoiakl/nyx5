// Nyx5/1 — búsqueda del índice federado con reputación y precio (NX-302).
//
// UNA definición para los dos almacenes: qué columnas se extraen de una tarjeta, cómo se
// codifica el cursor, qué filtros se aceptan y cómo se pagina. FileStore usa `buscarEnMemoria`
// tal cual; D1Store traduce las mismas reglas a SQL. Si las dos implementaciones divergen, el
// test de paginación (test/busqueda.test.js) corre sobre ambas y lo dice.
//
// Orden: (puntaje DESC, los sin puntaje al FINAL, dirección ASC). Cursor opaco = base64url de
// JSON { s, a, g }: el puntaje y la dirección de la última fila servida, y la GENERACIÓN del
// índice en la que empezó el recorrido. Nunca un offset: un offset sobre un conjunto que cambia
// entre páginas salta o repite filas (trampa «ventana horneada e isla»).
//
// Por qué la generación: el puntaje CAMBIA con cada rastreo, y un cursor por (puntaje,
// dirección) sobre un puntaje que se mueve repite al que bajó y se salta al que subió. Cada
// fila guarda, además del puntaje actual, un historial corto de sus cambios: `hist` =
// [{ g, s }] (generación en que el puntaje pasó a valer s), los últimos HIST_MAX cambios, y
// `first_gen`, la generación en que la dirección entró al índice. Un recorrido que empezó en
// la generación g ordena cada fila por el puntaje que tenía en g: la última entrada de `hist`
// con g' <= g. Si esa entrada ya se descartó (más de HIST_MAX cambios desde que empezó el
// recorrido), el puntaje congelado no existe: el recorrido se declara caduco (410) y quien
// recorre vuelve a empezar; nunca se sirve una página en silencio con otro orden.
// Lo que NO cubre: un agente que ENTRA al índice después de empezar el recorrido va al final
// (clave nula) y se ve sólo si el recorrido no pasó ya por los nulos; uno que SALE deja de
// verse; y los filtros de etiqueta/idioma/precio miran la fila ACTUAL (quien cambió de ficha a
// mitad del recorrido entra o sale del conjunto según su ficha de hoy).

import { puntajeArbitrado } from '../libro/libro.js';

const fallo = (status, message) => Object.assign(new Error(message), { status });

// ---------- columnas que el índice extrae de una tarjeta ----------
// El precio sale de `profile.services[].price.tokens` (la ficha con servicios la agrega otro
// frente; aquí sólo se lee si existe). Sin servicios con precio en tokens, `price_min` es null
// y el agente NO pasa un filtro `price_max`: no anunciar precio no es ser gratis.
export function precioMinimo(card) {
  const servicios = card?.profile?.services;
  if (!Array.isArray(servicios)) return null;
  const precios = servicios.map((s) => s?.price?.tokens).filter((t) => Number.isInteger(t) && t >= 0);
  return precios.length ? Math.min(...precios) : null;
}

export function columnasDeIndice(card) {
  const tags = Array.isArray(card?.profile?.tags) ? card.profile.tags.filter((t) => typeof t === 'string') : [];
  const langs = Array.isArray(card?.profile?.languages) ? card.profile.languages.filter((l) => typeof l === 'string').map((l) => l.toLowerCase()) : [];
  const score = typeof card?._score === 'number' && Number.isFinite(card._score) ? card._score : null;
  const jobs_done = Number.isInteger(card?._jobs_done) ? card._jobs_done : null;
  return { tags, langs, price_min: precioMinimo(card), score, jobs_done };
}

// El puntaje de un agente a partir de su historial público (§21). Sólo cuenta lo arbitrado por
// `verifica@` de su casa; una casa que no distingue arbitrados (versión anterior) no da puntaje.
// Devuelve también el motivo cuando no hay puntaje, para que el rastreo cuente su denominador.
export function puntajeDe(historial) {
  if (!historial || typeof historial !== 'object') return { score: null, jobs_done: null, motivo: 'sin_historial' };
  if (!historial.arbitrados || typeof historial.arbitrados !== 'object') return { score: null, jobs_done: null, motivo: 'sin_arbitrados' };
  const score = puntajeArbitrado(historial.arbitrados);
  if (score == null) return { score: null, jobs_done: 0, motivo: 'sin_historial' };
  return { score, jobs_done: Number(historial.arbitrados.liberados?.n) || 0, motivo: null };
}

// ---------- cursor ----------
export function codificarCursor({ s, a, g }) {
  return Buffer.from(JSON.stringify({ s: s ?? null, a, g })).toString('base64url');
}
export function decodificarCursor(texto) {
  const invalido = () => fallo(400, 'invalid cursor: use the next_cursor the index gave you, or none for the first page');
  if (typeof texto !== 'string' || !/^[A-Za-z0-9_-]{1,600}$/.test(texto)) throw invalido();
  let c;
  try { c = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8')); } catch { throw invalido(); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw invalido();
  if (Object.keys(c).some((k) => !['s', 'a', 'g'].includes(k))) throw invalido();
  if (!(c.s === null || (typeof c.s === 'number' && Number.isFinite(c.s) && c.s >= 0 && c.s <= 1))) throw invalido();
  if (typeof c.a !== 'string' || !c.a || c.a.length > 320) throw invalido();
  if (!Number.isSafeInteger(c.g) || c.g < 0) throw invalido();
  return c;
}

// ---------- filtros de la consulta ----------
// `p` son los parámetros crudos (strings de la URL o valores de la herramienta MCP). Falla con
// 400 ante lo que no se puede interpretar; `limit` se acota como siempre (nunca fue un 400).
export const FILTROS = ['q', 'tag', 'lang', 'capability', 'accepts', 'house', 'price_max', 'min_score', 'limit', 'cursor'];
export function validarFiltros(p = {}) {
  const vacio = (v) => v == null || v === '';
  if (!vacio(p.offset)) throw fallo(400, 'offset is not supported: page with cursor (next_cursor of the previous page)');
  const f = {};
  for (const k of ['q', 'capability', 'accepts', 'house']) {
    if (vacio(p[k])) continue;
    if (typeof p[k] !== 'string' || p[k].length > 200) throw fallo(400, `${k} must be a string of up to 200 characters`);
    if (k === 'capability' && !/^[a-z0-9_-]{1,64}$/.test(p[k])) throw fallo(400, 'capability must be 1-64 lowercase letters, digits, dashes or underscores');
    f[k] = k === 'house' ? p[k].toLowerCase() : p[k];
  }
  if (!vacio(p.tag)) {
    if (typeof p.tag !== 'string' || !/^[a-z0-9-]{1,32}$/.test(p.tag)) throw fallo(400, 'tag must be 1-32 lowercase letters, digits and dashes');
    f.tag = p.tag;
  }
  if (!vacio(p.lang)) {
    const l = String(p.lang).toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(l)) throw fallo(400, 'lang must be a language tag like "es" or "en-US"');
    f.lang = l;
  }
  if (!vacio(p.price_max)) {
    const n = Number(p.price_max);
    if (!Number.isInteger(n) || n < 0) throw fallo(400, 'price_max must be a non-negative integer (tokens)');
    f.price_max = n;
  }
  if (!vacio(p.min_score)) {
    const n = Number(p.min_score);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw fallo(400, 'min_score must be a number between 0 and 1');
    f.min_score = n;
  }
  const lim = Number(p.limit);
  f.limit = Number.isInteger(lim) && lim > 0 ? Math.min(lim, 200) : 50;
  if (!vacio(p.cursor)) f.cursor = decodificarCursor(p.cursor);
  return f;
}

// ---------- filas: historial de puntajes ----------
export const HIST_MAX = 16;
// La fila nueva de una tarjeta al reemplazar la casa en la generación `gen`, dada la fila previa
// de esa dirección (o null si es nueva). Sólo se anota un cambio cuando el puntaje cambia.
export function filaDeIndice(house, card, gen, previa) {
  const col = columnasDeIndice(card);
  const hist = Array.isArray(previa?.hist) ? previa.hist.slice() : [];
  if (!hist.length || (hist[hist.length - 1].s ?? null) !== col.score) hist.push({ g: gen, s: col.score });
  return { house, address: card.address, doc: card, ...col, gen, first_gen: previa?.first_gen ?? gen, hist: hist.slice(-HIST_MAX) };
}
// Puntaje congelado de una fila para un recorrido que empezó en g. `undefined` = caduco.
export function claveCongelada(r, g) {
  if ((r.first_gen ?? 0) > g) return null;
  const e = (r.hist || []).filter((x) => x.g <= g).at(-1);
  if (!e) return undefined;
  return e.s ?? null;
}

// ---------- la búsqueda, en memoria (FileStore y referencia para D1) ----------
// `filas`: [{ house, address, doc, tags, langs, price_min, score, jobs_done, gen, first_gen, hist }]
export function buscarEnMemoria(filas, f) {
  const gActual = filas.reduce((m, r) => Math.max(m, r.gen || 0), 0);
  if (f.cursor && f.cursor.g > gActual) throw fallo(400, 'invalid cursor: it names a generation of the index that does not exist');
  const g = f.cursor ? f.cursor.g : gActual;
  let sel = filas.filter((r) => filtraFila(r, f)).map((r) => ({ r, k: claveCongelada(r, g) }));
  if (sel.some((x) => x.k === undefined)) throw fallo(410, CADUCO);
  if (f.min_score != null) sel = sel.filter((x) => x.k != null && x.k >= f.min_score);
  const total = sel.length;
  if (f.cursor) sel = sel.filter((x) => despuesDelCursor(x.k, x.r.address, f.cursor));
  sel.sort((x, y) => compararFilas(x.k, x.r.address, y.k, y.r.address));
  const pagina = sel.slice(0, f.limit);
  const ultima = pagina[pagina.length - 1];
  const next_cursor = sel.length > f.limit ? codificarCursor({ s: ultima.k, a: ultima.r.address, g }) : null;
  return { total, agents: pagina.map((x) => x.r.doc), next_cursor };
}
export const CADUCO = 'cursor expired: the scores this walk was ordered by are no longer kept by the index; start again without cursor';

export function filtraFila(r, f) {
  const c = r.doc || {};
  if (f.house && r.house !== f.house) return false;
  if (f.capability && !c.capabilities?.[f.capability]) return false;
  if (f.accepts && !c.capabilities?.accepts?.includes(f.accepts)) return false;
  if (f.tag && !(r.tags || []).includes(f.tag)) return false;
  if (f.lang && !(r.langs || []).some((l) => l === f.lang || l.startsWith(`${f.lang}-`))) return false;
  if (f.price_max != null && !(r.price_min != null && r.price_min <= f.price_max)) return false;
  if (f.q && !JSON.stringify(c).toLowerCase().includes(String(f.q).toLowerCase())) return false;
  return true;
}

// Mismo orden que el SQL: puntaje DESC con nulos al final, dirección ASC (comparación binaria).
export function compararFilas(kx, ax, ky, ay) {
  if (kx == null && ky == null) return ax < ay ? -1 : ax > ay ? 1 : 0;
  if (kx == null) return 1;
  if (ky == null) return -1;
  if (kx !== ky) return ky - kx;
  return ax < ay ? -1 : ax > ay ? 1 : 0;
}

export function despuesDelCursor(k, address, cur) {
  if (cur.s == null) return k == null && address > cur.a;
  return (k != null && k < cur.s) || (k === cur.s && address > cur.a) || k == null;
}
