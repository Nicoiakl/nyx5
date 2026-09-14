// Nyx5/1 — ECDSA sobre secp256k1 en JavaScript puro (BigInt), sin dependencias.
//
// Qué hace: firma determinista (RFC 6979 con HMAC-SHA256), con `recid` para recuperar la clave
// pública desde la firma (ecrecover), y la derivación de dirección de Ethereum. Es lo mínimo para
// que un agente PAGUE por x402 sobre una red EVM: firmar la autorización EIP-3009 con la llave de
// su billetera. La identidad Nyx5 sigue siendo Ed25519; esta llave es OTRA, la de la plata.
//
// Qué NO hace, y se dice porque importa:
//   - No es de tiempo constante. La multiplicación escalar es doblar-y-sumar sobre BigInt, y el
//     tiempo depende del escalar. Contra un atacante que mida el reloj de la máquina que firma,
//     esto filtra bits de la llave. Es aceptable para una billetera de agente que firma pocas
//     veces en un proceso propio; NO lo es para un servidor que firme con una llave valiosa a
//     pedido de extraños. Si esa necesidad aparece, se cambia el módulo, no se parcha.
//   - No hace verificación clásica (r, s) contra una clave pública: lo que un pagador necesita es
//     comprobar que de su firma se recupera SU dirección, y eso es `recuperarDireccion`.
//
// Vectores públicos con los que se comprobó: la dirección conocida de la llave privada 1,
// y la firma RFC 6979 de sha256("Satoshi Nakamoto") con llave 1 (ver test/x402-pagador.test.js).

import { createHmac } from 'node:crypto';
import { keccak256, aHex, deHex } from './keccak.js';

// Parámetros de la curva y^2 = x^3 + 7 sobre F_p. Se escriben SIN el prefijo 0x pegado a los
// dígitos a propósito: test/custodia.test.js barre el código fuente buscando `0x` + 40 hex para
// que ninguna dirección EVM viva en el código, y los primeros 40 dígitos de una constante de 64
// parecen una dirección. Los valores son los de SEC 2 §2.4.1.
const hex = (s) => BigInt('0x' + s);
export const P = hex('fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f');
export const N = hex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const Gx = hex('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const Gy = hex('483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8');

const mod = (a, m) => { const r = a % m; return r >= 0n ? r : r + m; };

// Inverso modular por Fermat (m primo). Sirve para P y para N.
function modPow(b, e, m) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const inv = (a, m) => {
  if (mod(a, m) === 0n) throw new Error('secp256k1: inverso de cero');
  return modPow(a, m - 2n, m);
};

// ---- aritmética de puntos en coordenadas jacobianas (X, Y, Z) con x = X/Z^2, y = Y/Z^3 ----
const INF = null;

function doblar(Pt) {
  if (Pt === INF) return INF;
  const [X, Y, Z] = Pt;
  if (Y === 0n) return INF;
  const S = mod(4n * X * Y * Y, P);
  const M = mod(3n * X * X, P);            // a = 0 en secp256k1
  const X2 = mod(M * M - 2n * S, P);
  const Y2 = mod(M * (S - X2) - 8n * Y * Y * Y * Y, P);
  const Z2 = mod(2n * Y * Z, P);
  return [X2, Y2, Z2];
}

function sumar(A, B) {
  if (A === INF) return B;
  if (B === INF) return A;
  const [X1, Y1, Z1] = A, [X2, Y2, Z2] = B;
  const Z1Z1 = mod(Z1 * Z1, P), Z2Z2 = mod(Z2 * Z2, P);
  const U1 = mod(X1 * Z2Z2, P), U2 = mod(X2 * Z1Z1, P);
  const S1 = mod(Y1 * Z2 * Z2Z2, P), S2 = mod(Y2 * Z1 * Z1Z1, P);
  const H = mod(U2 - U1, P), R = mod(S2 - S1, P);
  if (H === 0n) return R === 0n ? doblar(A) : INF;
  const HH = mod(H * H, P), HHH = mod(H * HH, P);
  const V = mod(U1 * HH, P);
  const X3 = mod(R * R - HHH - 2n * V, P);
  const Y3 = mod(R * (V - X3) - S1 * HHH, P);
  const Z3 = mod(H * Z1 * Z2, P);
  return [X3, Y3, Z3];
}

function multiplicar(Pt, k) {
  let R = INF, Q = Pt;
  k = mod(k, N);
  while (k > 0n) {
    if (k & 1n) R = sumar(R, Q);
    Q = doblar(Q);
    k >>= 1n;
  }
  return R;
}

function afin(Pt) {
  if (Pt === INF) throw new Error('secp256k1: punto en el infinito');
  const [X, Y, Z] = Pt;
  const zi = inv(Z, P), zi2 = (zi * zi) % P;
  return { x: mod(X * zi2, P), y: mod(Y * zi2 * zi, P) };
}

const G = [Gx, Gy, 1n];

// ---- conversiones ----
const aBig = (bytes) => { let r = 0n; for (const b of bytes) r = (r << 8n) | BigInt(b); return r; };
const a32 = (n) => deHex(n.toString(16).padStart(64, '0'));

function llavePrivada(privKey) {
  const bytes = privKey instanceof Uint8Array ? privKey : deHex(privKey);
  if (bytes.length !== 32) throw new Error('secp256k1: la llave privada son 32 bytes');
  const d = aBig(bytes);
  if (d === 0n || d >= N) throw new Error('secp256k1: llave privada fuera de rango');
  return { d, bytes };
}

// Clave pública sin comprimir (64 bytes: x || y, sin el 0x04) de una llave privada.
export function clavePublica(privKey) {
  const { d } = llavePrivada(privKey);
  const { x, y } = afin(multiplicar(G, d));
  const out = new Uint8Array(64);
  out.set(a32(x), 0); out.set(a32(y), 32);
  return out;
}

// Dirección de Ethereum: los últimos 20 bytes de keccak256(x || y), con la mayúscula de EIP-55.
export const direccionDe = (privKey) => direccionDeClavePublica(clavePublica(privKey));

export function direccionDeClavePublica(pub64) {
  const h = keccak256(pub64);
  return checksum(aHex(h.subarray(12)));
}

// EIP-55: cada letra del hex va en mayúscula si el nibble correspondiente del keccak de la
// dirección en minúsculas es ≥ 8. Es un checksum, no una dirección distinta.
export function checksum(hex40) {
  const bajo = String(hex40).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(bajo)) throw new Error('secp256k1: dirección inválida');
  const h = aHex(keccak256(bajo));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? bajo[i].toUpperCase() : bajo[i];
  return out;
}

// ---- RFC 6979: nonce determinista ----
// Sin esto, k saldría de un generador aleatorio, y un k repetido o sesgado entrega la llave. Con
// esto, la misma llave y el mismo mensaje dan SIEMPRE la misma firma, y no hay generador que
// pueda fallar en silencio.
const hmac = (k, ...partes) => { const h = createHmac('sha256', k); for (const p of partes) h.update(p); return new Uint8Array(h.digest()); };

function nonceRfc6979(hash32, privBytes) {
  // bits2octets(h1): el hash como entero módulo n, de vuelta a 32 bytes. Para secp256k1 la
  // longitud del hash y de n coinciden, así que bits2int es leer los 32 bytes tal cual.
  const h1 = a32(mod(aBig(hash32), N));
  let V = new Uint8Array(32).fill(0x01);
  let K = new Uint8Array(32).fill(0x00);
  K = hmac(K, V, new Uint8Array([0x00]), privBytes, h1);
  V = hmac(K, V);
  K = hmac(K, V, new Uint8Array([0x01]), privBytes, h1);
  V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = aBig(V);
    if (k >= 1n && k < N) return k;
    K = hmac(K, V, new Uint8Array([0x00]));
    V = hmac(K, V);
  }
}

// ---- firmar ----
// firmar(hash32, privKey) → { r, s, recid, v, firma } donde `firma` son 65 bytes r||s||v con
// v = 27 + recid, que es lo que Ethereum (y USDC vía EIP-3009) esperan. `s` va en forma baja
// (s ≤ n/2): los contratos de Ethereum rechazan la forma alta desde EIP-2, y así cada mensaje
// tiene UNA firma válida y no dos.
export function firmar(hash, privKey) {
  const h = hash instanceof Uint8Array ? hash : deHex(hash);
  if (h.length !== 32) throw new Error('secp256k1: se firma un hash de 32 bytes, no un mensaje');
  const { d, bytes } = llavePrivada(privKey);
  const z = aBig(h);
  let k = nonceRfc6979(h, bytes);
  for (;;) {
    const R = afin(multiplicar(G, k));
    const r = mod(R.x, N);
    if (r === 0n) { k = mod(k + 1n, N); continue; }
    let s = mod(inv(k, N) * mod(z + r * d, N), N);
    if (s === 0n) { k = mod(k + 1n, N); continue; }
    // recid: bit 0 = paridad de R.y; bit 1 = R.x ≥ n (sucede con probabilidad ~2^-128).
    let recid = Number(R.y & 1n) | (R.x >= N ? 2 : 0);
    if (s > N / 2n) { s = N - s; recid ^= 1; }
    const firma = new Uint8Array(65);
    firma.set(a32(r), 0); firma.set(a32(s), 32); firma[64] = 27 + recid;
    return { r, s, recid, v: 27 + recid, firma, firmaHex: '0x' + aHex(firma) };
  }
}

// ---- recuperar (ecrecover) ----
// Del hash y la firma de 65 bytes, la clave pública que la produjo. Falla cerrado ante r, s fuera
// de rango, v desconocido o un punto que no está en la curva: nada de eso "recupera" una
// dirección de todos ceros, que es el error clásico de `ecrecover` en Solidity.
export function recuperarClavePublica(hash, firma) {
  const h = hash instanceof Uint8Array ? hash : deHex(hash);
  const f = firma instanceof Uint8Array ? firma : deHex(firma);
  if (h.length !== 32) throw new Error('secp256k1: el hash son 32 bytes');
  if (f.length !== 65) throw new Error('secp256k1: la firma son 65 bytes (r || s || v)');
  const r = aBig(f.subarray(0, 32)), s = aBig(f.subarray(32, 64));
  let v = f[64];
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw new Error(`secp256k1: v inválido (${f[64]})`);
  if (r === 0n || r >= N || s === 0n || s >= N) throw new Error('secp256k1: r o s fuera de rango');
  if (s > N / 2n) throw new Error('secp256k1: s en forma alta; se exige s ≤ n/2');
  const recid = v - 27;
  const x = r + (recid & 2 ? N : 0n);
  if (x >= P) throw new Error('secp256k1: r fuera de la curva');
  // y = sqrt(x^3 + 7) mod p; como p ≡ 3 (mod 4), la raíz es a^((p+1)/4).
  const alfa = mod(x * x * x + 7n, P);
  let y = modPow(alfa, (P + 1n) / 4n, P);
  if ((y * y) % P !== alfa) throw new Error('secp256k1: el punto no está en la curva');
  if (Number(y & 1n) !== (recid & 1)) y = P - y;
  const z = aBig(h);
  const ri = inv(r, N);
  // Q = r^-1 (s·R − z·G)
  const sR = multiplicar([x, y, 1n], s);
  const zG = multiplicar(G, mod(N - z, N));
  const Q = multiplicar(sumar(sR, zG), ri);
  const { x: qx, y: qy } = afin(Q);
  const out = new Uint8Array(64);
  out.set(a32(qx), 0); out.set(a32(qy), 32);
  return out;
}

export const recuperarDireccion = (hash, firma) => direccionDeClavePublica(recuperarClavePublica(hash, firma));
