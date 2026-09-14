// Nyx5/1 — Boleta del asiento y estado de cuenta (NX-501).
//
// Dos lecturas del mismo diario, sin tocar el kernel:
//   boletaDe(asiento)    -> qué parte del movimiento fue fee de la casa y qué parte comisión de
//                           referido, LEÍDO de las líneas del asiento. No se recalcula: si el
//                           asiento y una tasa discreparan, gana la línea, que es lo que movió.
//   estadoDeCuenta(...)  -> el extracto de una cuenta en un rango de fechas: saldo inicial,
//                           movimientos, saldo final y totales que cuadran. JSON o CSV (RFC 4180).
//
// Modelo de las filas: el fee y la comisión son filas PROPIAS, atribuidas a quien recibe el monto
// bruto. El fee sale de lo que recibe el vendedor (el comprador paga el precio, ni más ni menos).
// Para el vendedor de un spot de 200 con fee 10 % y comisión 15 %:
//   in 200 (bruto, contraparte el comprador) · out 20 fee 20 (casa@) · out 30 (referidor)
// y siempre opening + Σin − Σout = closing. `fee` es un subconjunto de `out`: marca qué salida
// fue para la casa. Las filas de un mismo asiento comparten `entry`; el saldo tras la última
// fila del asiento es el del Libro (los intermedios son de presentación).
//
// Qué NO cubre, dicho antes de que alguien lo suponga:
//   - Movimientos donde la cuenta no aparece en una línea. Una fianza ejecutada mueve
//     escrow → beneficiario: el afianzado salió del diario al depositarla.
//   - El fee de una estampilla no pasa por un recibo del Libro (viaja en la respuesta x402 como
//     `transaction`); sí aparece en el estado de cuenta del que la cobró.
//   - Si la cuenta es a la vez referidor y pagador (net negativo), no se desglosa: una sola fila.

import { LibroError } from './errores.js';

export const CSV_CABECERA = Object.freeze(['date', 'entry', 'concept', 'counterparty', 'in', 'out', 'fee', 'balance']);

// Fee y comisión de un asiento, leídos de sus líneas. `feeBps` (tasa de la casa) y `share` (bps
// del referido) son contexto para que la boleta diga la tasa; el MONTO es siempre el de la línea.
// `meta.fee > 0` distingue un fee de otra entrada positiva de la casa (una fianza ejecutada a su
// favor no es fee). Nunca lanza: corre dentro de Libro.handle después de que la op ya decidió.
export function boletaDe(asiento, { casa, feeBps = null, share = null } = {}) {
  if (!asiento || !Array.isArray(asiento.lines)) return {};
  const meta = asiento.meta || {};
  const out = {};
  const fee = meta.fee > 0 ? asiento.lines.find((l) => l.account === casa && l.delta > 0) : null;
  if (fee) out.fee = { account: casa, amount: fee.delta, ...(feeBps != null ? { bps: feeBps } : {}) };
  const com = meta.commission > 0 && meta.referrer ? asiento.lines.find((l) => l.account === meta.referrer && l.delta > 0) : null;
  if (com) out.commission = { account: meta.referrer, amount: com.delta, ...(share != null ? { bps: share } : {}) };
  return out;
}

// Las filas de UNA cuenta en UN asiento. [] si la cuenta no aparece en ninguna línea.
export function filasDe(asiento, account, casa) {
  const mias = asiento.lines.filter((l) => l.account === account);
  if (!mias.length) return [];
  const propio = mias.reduce((s, l) => s + l.delta, 0);
  const meta = asiento.meta || {};
  const { fee, commission } = boletaDe(asiento, { casa });
  // Contraparte: las líneas del signo contrario que no son el fee ni la comisión (salvo que la
  // cuenta sea justamente la casa o el referidor: entonces esas líneas son las suyas).
  const excluidas = new Set([account, ...(fee ? [casa] : []), ...(commission ? [meta.referrer] : [])]);
  const contra = asiento.lines.filter((l) => !excluidas.has(l.account) && Math.sign(l.delta) === -Math.sign(propio)).map((l) => l.account);
  const base = { date: asiento.at, entry: asiento.id, n: asiento.n, concept: asiento.concept, counterparty: contra.join(';') };
  // Quien recibe el bruto: net positivo, no es la casa ni el referidor, y el asiento repartió.
  const bruto = propio > 0 && account !== casa && account !== meta.referrer && (fee || commission);
  if (!bruto) return [{ ...base, kind: 'movement', in: propio > 0 ? propio : 0, out: propio < 0 ? -propio : 0, fee: 0 }];
  const filas = [{ ...base, kind: 'movement', in: propio + (fee?.amount || 0) + (commission?.amount || 0), out: 0, fee: 0 }];
  if (fee) filas.push({ ...base, kind: 'fee', concept: 'house fee', counterparty: casa, in: 0, out: fee.amount, fee: fee.amount });
  if (commission) filas.push({ ...base, kind: 'commission', concept: 'referral commission', counterparty: meta.referrer, in: 0, out: commission.amount, fee: 0 });
  return filas;
}

// Fecha ISO normalizada al formato exacto de `asiento.at` (toISOString), para que la comparación
// lexicográfica en el almacén sea la misma que la numérica. Una fecha sola ("2026-09-13") es la
// medianoche UTC de ese día: como `until` es exclusivo, `hasta=2026-09-14` cubre el 13 entero.
function fechaIso(v, nombre) {
  if (v == null || v === '') return null;
  // Sin zona horaria, Node la interpreta en la del proceso y workerd en UTC: se exige Z u offset
  // (una fecha sola, sin hora, es UTC en las dos).
  const t = typeof v === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(v) || /(Z|[+-]\d{2}:?\d{2})$/.test(v)) ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new LibroError(400, `${nombre} must be an ISO-8601 date, got ${JSON.stringify(v)}`);
  return new Date(t).toISOString();
}

// El estado de cuenta de `account` en [since, until). `limit` acota cuántos asientos se listan
// (se conservan los MÁS RECIENTES, como el statement de siempre); `max` es el techo que pone el
// llamador (200 por correo, 1000 por HTTP). Sin rango, el límite por defecto sigue siendo 20.
//
// opening_balance es el saldo justo antes del primer asiento listado (sumado de sus líneas, no
// leído de saldos), así que cuadra también cuando la lista está truncada. `ledger_balance` es lo
// que dice el estado de saldos hoy: cuando el extracto llega hasta ahora, los dos tienen que
// coincidir, y `reconciled` los resta. Si un día no coinciden, el diario y los saldos divergieron
// y esto es lo primero que lo dice.
export async function estadoDeCuenta(libro, account, { since = null, until = null, limit = null, max = 200 } = {}) {
  const desde = fechaIso(since, 'since'), hasta = fechaIso(until, 'until');
  if (desde && hasta && desde > hasta) throw new LibroError(400, `since (${desde}) is after until (${hasta})`);
  const raw = Number(limit);
  const n = Number.isInteger(raw) && raw > 0 ? Math.min(raw, max) : (desde || hasta ? max : 20);
  const store = libro.store, casa = libro.casa;
  const ledger = await libro.balance(account);
  const { entries, total } = await store.libroStatementRange(account, { since: desde, until: hasta, limit: n });
  const opening = entries.length
    ? await store.libroBalanceBefore(account, { n: entries[0].n })
    : (desde ? await store.libroBalanceBefore(account, { at: desde }) : 0);
  const totals = { in: 0, out: 0, fees: 0, commissions: 0 };
  const rows = [];
  let saldo = opening;
  for (const a of entries) {
    for (const r of filasDe(a, account, casa)) {
      saldo += r.in - r.out;
      totals.in += r.in; totals.out += r.out; totals.fees += r.fee;
      if (r.kind === 'commission') totals.commissions += r.out;
      rows.push({ ...r, balance: saldo });
    }
  }
  // Cuadre interno: lo que dicen las filas tiene que ser lo que dicen las líneas del diario.
  const neto = entries.reduce((s, a) => s + a.lines.filter((l) => l.account === account).reduce((t, l) => t + l.delta, 0), 0);
  if (opening + neto !== saldo) throw new LibroError(500, `statement does not reconcile with the journal (${opening} + ${neto} != ${saldo})`);
  // Sin `until` la lista termina en el último asiento de la cuenta (se conservan los más
  // recientes): el saldo final tiene que ser el saldo de hoy, esté o no truncada la lista.
  const reconciled = hasta ? null : saldo === ledger;
  return {
    account, house: libro.domain, since: desde, until: hasta,
    opening_balance: opening, entries: rows, closing_balance: saldo, totals,
    rows: rows.length, entries_shown: entries.length, entries_total: total, truncated: total > entries.length,
    ledger_balance: ledger, reconciled,
  };
}

// ---------- CSV (RFC 4180) ----------
// Un campo con coma, comillas o salto de línea va entre comillas, y las comillas se doblan.
export function campoCsv(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Texto que escribió otro agente (concepto, contraparte) y que una hoja de cálculo podría tomar
// por fórmula: se antepone un apóstrofo, como recomienda OWASP. Los números son nuestros.
function textoCsv(s) {
  const t = s == null ? '' : String(s);
  return /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
}
export function csvDe(estado) {
  const num = (x) => (x ? String(x) : '');
  const lineas = [CSV_CABECERA.join(',')];
  for (const r of estado.entries) {
    lineas.push([r.date, r.entry, textoCsv(r.concept), textoCsv(r.counterparty), num(r.in), num(r.out), num(r.fee), String(r.balance)].map(campoCsv).join(','));
  }
  return `${lineas.join('\r\n')}\r\n`;
}
// estado-<local>-<desde>-<hasta>.csv; sin rango: inicio / la fecha de hoy. Sólo caracteres seguros
// para un nombre de archivo en una cabecera.
export function nombreCsv(estado, hoy = new Date()) {
  const [local, domain] = String(estado.account).split('@');
  const quien = domain && domain !== estado.house ? `${local}.${domain}` : local;
  const desde = estado.since ? estado.since.slice(0, 10) : 'inicio';
  const hasta = estado.until ? estado.until.slice(0, 10) : hoy.toISOString().slice(0, 10);
  return `estado-${quien}-${desde}-${hasta}.csv`.replace(/[^A-Za-z0-9._-]/g, '-');
}
