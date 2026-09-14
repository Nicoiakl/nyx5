// Nyx5/1 — Pagador x402: que un agente PAGUE un recurso que cobra en USDC sobre una red EVM.
//
// La casa ya sabía cobrar (src/puentes/x402.js): anunciar el precio en un 402, preguntarle al
// facilitador si la firma sirve y pedir que liquide. Eso no necesita criptografía de cadena.
// Pagar sí: el pagador firma una autorización EIP-3009 (`TransferWithAuthorization`) sobre el
// contrato del token, con tipado EIP-712, y esa firma exige keccak256 y secp256k1 con
// recuperación, que Node no trae. Ahora están en src/nucleo/keccak.js y src/nucleo/secp256k1.js.
//
// Cómo se protege el que paga, porque una firma es dinero:
//   - `tope` es OBLIGATORIO y va en unidades atómicas. Si el 402 pide más, no se firma. Es el
//     `max_per_charge` de un mandato, pero del lado de la cadena: el agente no decide cuánto vale
//     el recurso, decide cuánto está dispuesto a perder si el servidor miente.
//   - El nonce son 32 bytes aleatorios por autorización. El contrato de USDC rechaza un nonce
//     repetido, así que una autorización sólo puede liquidarse UNA vez, aunque el servidor la
//     reintente o la filtre.
//   - `validBefore` nunca pasa de ahora + 5 minutos. Una autorización firmada es un cheque al
//     portador hasta que vence; cuanto menos viva, menos vale robarla.
//   - El dominio EIP-712 (name, version, chainId, contrato) sale de `TOKEN_USD`, la tabla que ya
//     está LEÍDA de cada contrato. No se copia ni se acepta lo que diga el 402: si el servidor
//     anuncia un `asset` o un `name` que no coincide con el USDC de esa red, se rechaza ANTES de
//     firmar. Firmar contra un dominio que dicta el cobrador es firmar lo que él quiera.
//   - `from` tiene que ser la dirección de la llave. Firmar una autorización con otro `from` no
//     mueve la plata del otro; sólo produce una firma inválida, y el error no diría por qué.
//
// Este módulo NO habla con ninguna red ni facilitador: firma y manda cabeceras HTTP al servidor
// del recurso. Quien difunde la transacción y paga el gas es el facilitador del cobrador.

import { randomBytes } from 'node:crypto';
import { keccak256, aHex, deHex } from '../nucleo/keccak.js';
import { firmar, direccionDe, recuperarDireccion } from '../nucleo/secp256k1.js';
import { TOKEN_USD, X402_VERSION } from './x402.js';

export const TIPO_DOMINIO = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export const TIPO_TRANSFER = 'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)';
export const VIGENCIA_MAX_S = 300;   // validBefore ≤ ahora + 5 min
export const TOLERANCIA_RELOJ_S = 600; // validAfter = ahora − 10 min, como el cliente de referencia de x402

const DIRECCION = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const ENTERO = /^\d+$/;

// ---- codificación EIP-712 ----
const concat = (...partes) => {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
};
const uint256 = (n) => deHex(BigInt(n).toString(16).padStart(64, '0'));
const direccion32 = (a) => {
  if (!DIRECCION.test(String(a))) throw new Error(`x402 pagador: dirección inválida "${String(a).slice(0, 20)}"`);
  return deHex(String(a).slice(2).padStart(64, '0'));
};
const entero = (v, nombre) => {
  const s = typeof v === 'bigint' ? v.toString() : String(v);
  if (!ENTERO.test(s)) throw new Error(`x402 pagador: ${nombre} debe ser un entero sin signo en unidades atómicas`);
  return s;
};

// La entrada de TOKEN_USD para una red, o null. `Object.hasOwn`: una red llamada `constructor` o
// `__proto__` no es una red, y `TOKEN_USD[red]` la encontraría en el prototipo.
const tokenDe = (network) => (typeof network === 'string' && Object.hasOwn(TOKEN_USD, network)) ? TOKEN_USD[network] : null;

// El dominio EIP-712 del contrato de USDC en una red. Sale de la tabla leída de los contratos.
export function dominioDe(network) {
  const t = tokenDe(network);
  if (!t) throw new Error(`x402 pagador: no sé pagar en ${network}; conozco: ${Object.keys(TOKEN_USD).join(', ')}`);
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`x402 pagador: ${network} no es una red EVM`);
  return { name: t.name, version: t.version, chainId: BigInt(m[1]), verifyingContract: t.asset };
}

export function separadorDeDominio({ name, version, chainId, verifyingContract }) {
  return keccak256(concat(
    keccak256(TIPO_DOMINIO),
    keccak256(String(name)),
    keccak256(String(version)),
    uint256(chainId),
    direccion32(verifyingContract),
  ));
}

export function hashAutorizacion({ from, to, value, validAfter, validBefore, nonce }) {
  if (!NONCE.test(String(nonce))) throw new Error('x402 pagador: nonce debe ser 0x + 32 bytes en hex');
  return keccak256(concat(
    keccak256(TIPO_TRANSFER),
    direccion32(from),
    direccion32(to),
    uint256(entero(value, 'value')),
    uint256(entero(validAfter, 'validAfter')),
    uint256(entero(validBefore, 'validBefore')),
    deHex(nonce),
  ));
}

// El digest que firma el pagador: keccak256(0x19 0x01 ‖ dominio ‖ hashStruct(mensaje)).
export function digestAutorizacion({ network, dominio, ...auth }) {
  const dom = dominio || dominioDe(network);
  return keccak256(concat(new Uint8Array([0x19, 0x01]), separadorDeDominio(dom), hashAutorizacion(auth)));
}

// ---- firmar ----
// Devuelve { authorization, signature, digest }, con `authorization` en el formato exacto que el
// esquema `exact` de x402 sobre EVM pone en `payload.authorization` (todo cadenas).
export function firmarAutorizacion({ network, from, to, value, validAfter, validBefore, nonce, privKey }) {
  if (!privKey) throw new Error('x402 pagador: falta privKey');
  const propia = direccionDe(privKey);
  if (String(from).toLowerCase() !== propia.toLowerCase()) throw new Error(`x402 pagador: from (${from}) no es la dirección de la llave (${propia})`);
  const authorization = {
    from: propia, to: String(to),
    value: entero(value, 'value'),
    validAfter: entero(validAfter, 'validAfter'),
    validBefore: entero(validBefore, 'validBefore'),
    nonce: String(nonce).toLowerCase(),
  };
  if (BigInt(authorization.validBefore) <= BigInt(authorization.validAfter)) throw new Error('x402 pagador: validBefore debe ser mayor que validAfter');
  const digest = digestAutorizacion({ network, ...authorization });
  const { firmaHex } = firmar(digest, privKey);
  return { authorization, signature: firmaHex, digest: '0x' + aHex(digest) };
}

// La contraparte de firmar: qué dirección produjo esta autorización en esta red. Es lo que hace
// un facilitador en `/verify`, y lo que usa la prueba para demostrar que la firma es de `from`.
export function recuperarPagador({ network, authorization, signature }) {
  return recuperarDireccion(digestAutorizacion({ network, ...authorization }), signature);
}

// ---- elegir qué pagar ----
// De un PAYMENT-REQUIRED, la primera entrada `exact` en una red EVM que sabemos pagar (y que esté
// en `redes`, si se acotó). Se comprueba que el 402 describa el USDC REAL de esa red: `asset` y el
// dominio del token (`extra.name`/`extra.version`) tienen que coincidir con la tabla leída de los
// contratos. Un servidor que anuncie otro contrato u otro nombre no consigue una firma.
export function elegirRequisito(pr, { redes } = {}) {
  if (pr?.x402Version !== X402_VERSION) throw new Error(`x402 pagador: x402Version ${pr?.x402Version}, se esperaba ${X402_VERSION}`);
  if (!Array.isArray(pr.accepts) || !pr.accepts.length) throw new Error('x402 pagador: el 402 no trae accepts');
  const permitidas = redes ? new Set(redes) : null;
  const motivos = [];
  for (const a of pr.accepts) {
    if (a?.scheme !== 'exact') { motivos.push(`${a?.network}: scheme ${a?.scheme}`); continue; }
    const t = tokenDe(a.network);
    if (!t) { motivos.push(`${a.network}: red que no sé pagar`); continue; }
    if (permitidas && !permitidas.has(a.network)) { motivos.push(`${a.network}: fuera de las redes permitidas`); continue; }
    if (String(a.asset).toLowerCase() !== t.asset.toLowerCase()) { motivos.push(`${a.network}: asset ${a.asset} no es el USDC de esa red`); continue; }
    const nombre = a.extra?.name, version = a.extra?.version;
    if ((nombre != null && nombre !== t.name) || (version != null && String(version) !== t.version)) { motivos.push(`${a.network}: dominio del token ${nombre}/${version} no es ${t.name}/${t.version}`); continue; }
    if (!DIRECCION.test(String(a.payTo))) { motivos.push(`${a.network}: payTo no es una dirección EVM`); continue; }
    if (typeof a.amount !== 'string' || !ENTERO.test(a.amount)) { motivos.push(`${a.network}: amount no es una cadena de unidades atómicas`); continue; }
    return a;
  }
  throw new Error(`x402 pagador: ninguna forma de pago sirve: ${motivos.join('; ') || 'accepts vacío'}`);
}

// ---- armar el PAYMENT-SIGNATURE ----
// `tope` es obligatorio: la decisión de cuánto se está dispuesto a pagar es del agente, no del 402.
export function armarPago({ requisito, privKey, tope, ahora = Math.floor(Date.now() / 1000), nonce }) {
  if (tope == null) throw new Error('x402 pagador: tope (unidades atómicas) es obligatorio');
  const limite = BigInt(entero(tope, 'tope'));
  const monto = BigInt(entero(requisito?.amount, 'amount'));
  if (monto > limite) throw new Error(`x402 pagador: el precio (${monto}) supera el tope (${limite}); no se firma`);
  if (!tokenDe(requisito.network)) throw new Error(`x402 pagador: no sé pagar en ${requisito.network}`);
  // La vigencia que pide el servidor sólo puede ACORTAR los 5 minutos: un `maxTimeoutSeconds`
  // negativo, no numérico o fraccionario no se obedece (un negativo firmaba un cheque ya vencido).
  const pedida = Number(requisito.maxTimeoutSeconds);
  const vigencia = Number.isFinite(pedida) && pedida >= 1 ? Math.min(Math.floor(pedida), VIGENCIA_MAX_S) : VIGENCIA_MAX_S;
  const from = direccionDe(privKey);
  const { authorization, signature } = firmarAutorizacion({
    network: requisito.network,
    from, to: requisito.payTo, value: monto,
    validAfter: Math.max(0, ahora - TOLERANCIA_RELOJ_S),
    validBefore: ahora + vigencia,
    nonce: nonce || '0x' + randomBytes(32).toString('hex'),
    privKey,
  });
  // `accepted` viaja tal cual llegó: el servidor compara contra lo que publicó.
  return { x402Version: X402_VERSION, accepted: requisito, payload: { signature, authorization } };
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
// El mismo pago con la forma de la v1 de x402 (scheme y network en la raíz): lo que leen los servidores
// que sólo miran X-PAYMENT. `accepted` viaja igual: un lector v2 lo encuentra donde lo espera.
export const cabeceraV1 = (pago) => ({ x402Version: 1, scheme: pago.accepted.scheme, network: pago.accepted.network, payload: pago.payload, accepted: pago.accepted });
const deB64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

async function leerCuerpo(r) {
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

// ---- pagar ----
// GET url → 402 con PAYMENT-REQUIRED → elegir → firmar → GET con PAYMENT-SIGNATURE → cuerpo y
// PAYMENT-RESPONSE. Si la primera respuesta no es 402, se devuelve tal cual sin firmar nada.
//
// Se firma UNA vez, contra el primer 402. Si el servidor contesta con otro 402 (otro `payTo`, otro
// precio, "sin fondos"), no se vuelve a firmar: se lanza. Y como la firma ya salió del proceso, es
// un cheque que el servidor puede cobrar hasta que venza aunque haya dicho que no: todo error que
// ocurra DESPUÉS de entregarla lleva `firmado: true`, `nonce`, `red`, `monto`, `destinatario` y
// `pagador`, para que quien paga lo anote y concilie. `alFirmar(entregado)` se llama ANTES de
// mandar la firma: es el sitio para escribir el registro antes del paso, no después.
export async function pagar({ url, privKey, tope, fetch: fetchImpl = globalThis.fetch, redes, method = 'GET', headers = {}, body, timeoutMs = 30_000, alFirmar = null }) {
  if (!url) throw new Error('x402 pagador: falta url');
  if (tope == null) throw new Error('x402 pagador: tope (unidades atómicas) es obligatorio');
  const pedir = (extra = {}) => fetchImpl(url, { method, headers: { ...headers, ...extra }, body, signal: AbortSignal.timeout(timeoutMs) });

  const primera = await pedir();
  if (primera.status !== 402) return { pagado: false, status: primera.status, body: await leerCuerpo(primera) };

  const cabecera = primera.headers.get('payment-required');
  if (!cabecera) throw new Error('x402 pagador: 402 sin cabecera PAYMENT-REQUIRED');
  let pr;
  try { pr = deB64(cabecera); } catch { throw new Error('x402 pagador: PAYMENT-REQUIRED no es JSON en base64'); }
  const requisito = elegirRequisito(pr, { redes });
  const pago = armarPago({ requisito, privKey, tope });
  const entregado = {
    firmado: true,
    red: requisito.network,
    monto: requisito.amount,
    destinatario: requisito.payTo,
    pagador: pago.payload.authorization.from,
    nonce: pago.payload.authorization.nonce,
    validBefore: pago.payload.authorization.validBefore,
  };
  if (alFirmar) await alFirmar(entregado);

  try {
    // Dos cabeceras con el mismo cheque: PAYMENT-SIGNATURE (v2, con accepted) y X-PAYMENT con el cuerpo de
    // la v1 (scheme y network arriba). Medido el 14-sep-2026 contra 402milly: un servidor que lee X-PAYMENT
    // contesta el MISMO 402 sin motivo si sólo va la v2. Mandar las dos no cuesta nada y la firma es una.
    const segunda = await pedir({ 'PAYMENT-SIGNATURE': b64(pago), 'X-PAYMENT': b64(cabeceraV1(pago)) });
    const cuerpo = await leerCuerpo(segunda);
    let liquidacion = null;
    const respuesta = segunda.headers.get('payment-response');
    if (respuesta) { try { liquidacion = deB64(respuesta); } catch { liquidacion = null; } }
    if (segunda.status === 402) {
      let motivo = '';
      try { motivo = deB64(segunda.headers.get('payment-required') || '').error || ''; } catch { /* sin motivo */ }
      // El motivo puede venir en el cuerpo JSON (details/error), no en la cabecera: 402milly lo hace así.
      // El cuerpo con `details` manda: la cabecera suele repetir el genérico «Payment required».
      const detalle = cuerpo && typeof cuerpo === 'object' ? [cuerpo.error, cuerpo.details].filter((x) => typeof x === 'string' && x).join(': ') : '';
      if (detalle && (typeof cuerpo.details === 'string' || !motivo)) motivo = detalle;
      throw new Error(`x402 pagador: el servidor rechazó el pago${motivo ? `: ${motivo}` : ''}`);
    }
    return { pagado: true, status: segunda.status, body: cuerpo, liquidacion, ...entregado };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw Object.assign(err, entregado);
  }
}
