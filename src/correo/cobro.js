// Nyx5/1 — Pedido de pago por transferencia (NX-502): dinero REAL, fuera del Libro.
//
// Un agente le pide a otro una transferencia bancaria (Chile: CLP o USD) con un sobre CIFRADO cuyo
// contenido es el cobro: monto, moneda, nombre, RUT, banco, tipo y número de cuenta, referencia.
// Quien pagó contesta con una confirmación (la referencia bancaria) en el hilo del pedido.
//
// Tres reglas que este módulo hace cumplir y que no se relajan:
//   1. Los datos bancarios NUNCA pasan por la casa en claro: el sobre va cifrado (`encrypt: 'required'`)
//      y jamás a una dirección cuya llave guarda la casa (`custody.keys = house`), porque la casa
//      descifraría en su nombre. Tampoco se guardan en la tarjeta ni en la ficha: cada pedido los lleva.
//   2. La casa NO mueve dinero ni lo ve: anota `payment_requested` / `payment_confirmed` como eventos
//      (instrumentación) a partir de una extensión firmada EN CLARO que sólo lleva `{ kind, request_id,
//      currency }`. Ni monto ni cuenta: `eventoDeCobro` copia campo por campo, no el objeto.
//   3. El RUT se valida aquí (módulo 11) y en la app: la casa no puede hacerlo porque va cifrado
//      (invariante 8). Falla CERRADO ante cualquier carácter que no sea dígito, punto, guion o K.
//
// Los textos de `TEXTOS` los aprobó Nicholas el 14-sep-2026 (plan/textos-app-borrador.md, NX-502):
// se usan literales en la app y en la herramienta. Los demás mensajes de validación los lee un
// modelo (herramienta MCP) o un formulario que ya acota el campo; no son texto aprobado.

import { limpio } from './politica.js';

export const MEDIA_COBRO = 'application/nyx5.cobro+json';
export const MEDIA_COBRO_CONFIRMACION = 'application/nyx5.cobro-confirmacion+json';
// Extensión en claro, firmada por el remitente: lo único del cobro que la casa ve.
export const EXT_COBRO = 'urn:nyx5:ext:cobro';
export const MONEDAS = ['CLP', 'USD'];
export const TIPOS_CUENTA = ['checking', 'savings', 'vista'];
export const EVENTOS_COBRO = { request: 'payment_requested', confirmation: 'payment_confirmed' };

// Textos aprobados (14-sep-2026). No se cambian sin volver a mostrarlos.
export const TEXTOS = {
  rut: 'RUT looks wrong (check the digit).',
  monto_clp: 'Amount must be a whole number of pesos.',
};

const LIMITES = { name: 120, bank: 60, account_number: 30, reference: 140, bank_reference: 80 };
const ID_PEDIDO = /^[A-Za-z0-9._:-]{8,128}$/;

// ---------- RUT ----------
// Dígito verificador, módulo 11: multiplicadores 2..7 de derecha a izquierda; 11 -> 0, 10 -> K.
export function digitoVerificador(cuerpo) {
  let suma = 0, m = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { suma += Number(cuerpo[i]) * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (suma % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}
// Normaliza `12.345.678-5`, `12345678-5`, `123456785` a `12345678-5`; null si no es un RUT válido.
// Sólo se aceptan dígitos, puntos, un guion y K: un carácter de control o invisible NO se limpia,
// invalida (un RUT con basura adentro no es un RUT con el que alguien pueda transferir).
export function normalizarRut(rut) {
  if (typeof rut !== 'string') return null;
  const s = rut.trim().toUpperCase().replace(/\./g, '');
  const m = /^(\d{7,8})-?([0-9K])$/.exec(s);
  if (!m) return null;
  const [, cuerpo, dv] = m;
  return digitoVerificador(cuerpo) === dv ? `${cuerpo}-${dv}` : null;
}
export const rutValido = (rut) => normalizarRut(rut) !== null;
// Para mostrar: `12.345.678-5`.
export function formatearRut(rut) {
  const n = normalizarRut(rut); if (!n) return String(rut ?? '');
  const [cuerpo, dv] = n.split('-');
  return `${cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`;
}

// ---------- monto ----------
// CLP: entero en pesos (número o texto de dígitos). USD: texto con hasta dos decimales.
// Devuelve el monto normalizado (CLP: Number; USD: string como "12.50") o null.
export function normalizarMonto(amount, currency) {
  const s = typeof amount === 'number' ? (Number.isFinite(amount) ? String(amount) : '') : typeof amount === 'string' ? amount.trim() : '';
  if (currency === 'CLP') {
    if (!/^\d{1,15}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  if (currency === 'USD') {
    if (!/^\d{1,15}(\.\d{1,2})?$/.test(s)) return null;
    return Number(s) > 0 ? s : null;
  }
  return null;
}

// ---------- el pedido ----------
// { ok: true, cobro } con todos los campos normalizados, o { ok: false, field, error }.
export function validarCobro(x) {
  const mal = (field, error) => ({ ok: false, field, error });
  if (!x || typeof x !== 'object' || Array.isArray(x)) return mal('cobro', 'the payment request must be an object');
  const currency = typeof x.currency === 'string' ? x.currency.trim().toUpperCase() : 'CLP';
  if (!MONEDAS.includes(currency)) return mal('currency', `currency must be one of ${MONEDAS.join(', ')}`);
  const amount = normalizarMonto(x.amount, currency);
  if (amount === null) return mal('amount', currency === 'CLP' ? TEXTOS.monto_clp : 'Amount must be a number of dollars with up to two decimals.');
  const rut = normalizarRut(x.rut);
  if (!rut) return mal('rut', TEXTOS.rut);
  const texto = (k, requerido) => {
    const v = x[k] == null ? '' : typeof x[k] === 'string' ? limpio(x[k], LIMITES[k] + 1) : null;
    if (v === null) return { error: `${k} must be text` };
    if (requerido && !v) return { error: `${k} is required` };
    if (v.length > LIMITES[k]) return { error: `${k}: up to ${LIMITES[k]} characters` };
    return { v };
  };
  const name = texto('name', true); if (name.error) return mal('name', name.error);
  const bank = texto('bank', true); if (bank.error) return mal('bank', bank.error);
  const account_type = typeof x.account_type === 'string' ? x.account_type.trim().toLowerCase() : '';
  if (!TIPOS_CUENTA.includes(account_type)) return mal('account_type', `account_type must be one of ${TIPOS_CUENTA.join(', ')}`);
  const account_number = typeof x.account_number === 'string' || typeof x.account_number === 'number' ? String(x.account_number).replace(/\s+/g, '') : '';
  if (!/^[0-9-]{1,30}$/.test(account_number)) return mal('account_number', 'account_number: digits and dashes, up to 30 characters');
  const reference = texto('reference', false); if (reference.error) return mal('reference', reference.error);
  let request_id = x.request_id == null ? undefined : x.request_id;
  if (request_id !== undefined && (typeof request_id !== 'string' || !ID_PEDIDO.test(request_id))) return mal('request_id', 'request_id must be [A-Za-z0-9._:-]{8,128}');
  return { ok: true, cobro: { ...(request_id ? { request_id } : {}), amount, currency, name: name.v, rut, bank: bank.v, account_type, account_number, reference: reference.v } };
}
// Igual que validarCobro, pero lanza: para el cliente y la herramienta.
export function cobroValido(x) {
  const r = validarCobro(x);
  if (!r.ok) throw Object.assign(new Error(r.error), { field: r.field });
  return r.cobro;
}

// ---------- la confirmación ----------
export function validarConfirmacion(x) {
  const mal = (field, error) => ({ ok: false, field, error });
  if (!x || typeof x !== 'object' || Array.isArray(x)) return mal('confirmacion', 'the confirmation must be an object');
  if (typeof x.request_id !== 'string' || !ID_PEDIDO.test(x.request_id)) return mal('request_id', 'request_id must be [A-Za-z0-9._:-]{8,128}');
  const bank_reference = typeof x.bank_reference === 'string' ? limpio(x.bank_reference, LIMITES.bank_reference + 1) : null;
  if (bank_reference === null || !bank_reference) return mal('bank_reference', 'bank_reference is required');
  if (bank_reference.length > LIMITES.bank_reference) return mal('bank_reference', `bank_reference: up to ${LIMITES.bank_reference} characters`);
  return { ok: true, confirmacion: { request_id: x.request_id, bank_reference } };
}
export function confirmacionValida(x) {
  const r = validarConfirmacion(x);
  if (!r.ok) throw Object.assign(new Error(r.error), { field: r.field });
  return r.confirmacion;
}

// ---------- lo que la casa ve ----------
// La extensión en claro que viaja firmada con el sobre. Sólo tres campos, y ninguno es dinero.
export function extensionDeCobro(kind, { request_id, currency }) {
  return { [EXT_COBRO]: { kind, request_id, currency } };
}
// El evento que la casa anota al recibir un sobre con la extensión: { name, data } o null si la
// extensión no tiene la forma exacta. Se copian los campos UNO A UNO: si el remitente mete
// `amount` o `rut` en la extensión, no llegan al diario de eventos.
export function eventoDeCobro(env) {
  const x = env?.extensions?.[EXT_COBRO];
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const name = EVENTOS_COBRO[x.kind];
  if (!name) return null;
  if (typeof x.request_id !== 'string' || !ID_PEDIDO.test(x.request_id)) return null;
  if (!MONEDAS.includes(x.currency)) return null;
  return { name, data: { request_id: x.request_id, currency: x.currency } };
}

// ¿Puede esta tarjeta recibir un cobro? Devuelve la razón por la que no, o null.
// No a la casa (libro@, postmaster@...), no a un grupo, no sin llave de cifrado, y no a una
// dirección cuya llave guarda la casa: ahí la casa descifra, y los datos bancarios pasarían por
// ella en claro (decisión del ítem NX-502: «un cobro a claude.nico se rechaza en el cliente»).
export function razonParaNoCobrar(card) {
  if (!card) return 'the recipient card could not be resolved';
  if (card.group) return `${card.address} is a group: a payment request goes to one person`;
  if (card.custody?.keys === 'house') return `${card.address} is an address whose key the house holds (a connected Claude): the house would read the bank details. Send the request to ${card.delegation?.by || 'its owner'} instead`;
  if (!card.enc) return `${card.address} publishes no encryption key: a payment request only travels encrypted`;
  return null;
}
