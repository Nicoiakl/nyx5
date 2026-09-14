// Nyx5/1 — Keccak-256 en JavaScript puro, sin dependencias.
//
// Por qué existe: Ethereum usa Keccak-256 (el Keccak ORIGINAL de la competencia SHA-3, con relleno
// pad10*1 puro), y Node sólo trae `sha3-256`, que es FIPS 202: mismo permutador, distinto relleno
// (FIPS 202 añade el sufijo 0x06 antes del pad10*1). Los dos dan resultados distintos para la
// misma entrada, y `crypto.createHash('sha3-256')` NO sirve para calcular una dirección, un
// dominio EIP-712 ni un digest que un contrato vaya a comprobar. Sin esto, un agente de Nyx5
// puede COBRAR por x402 pero no PAGAR (ver src/puentes/x402-pagador.js).
//
// Parámetros de Keccak-256: estado de 1600 bits (25 carriles de 64 bits), tasa r = 1088 bits
// (136 bytes por bloque), capacidad c = 512, 24 rondas, salida de 32 bytes.
//
// Los carriles son BigInt de 64 bits. Es más lento que partir cada carril en dos enteros de 32
// bits, pero aquí se hashean decenas de bytes por pago, no megabytes, y la claridad vale más que
// el ciclo. Verificado contra los vectores oficiales del equipo Keccak (ver test/x402-pagador.test.js).

const RONDAS = 24;
const TASA = 136; // bytes por bloque para Keccak-256
const MASCARA = (1n << 64n) - 1n;

// Constantes de ronda (iota), RC[0..23] de la especificación de Keccak.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Desplazamientos de rho, indexados por x + 5*y.
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const rotl = (v, n) => n === 0 ? v : (((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASCARA);

// Keccak-f[1600] sobre un arreglo de 25 BigInt (se muta en el lugar).
function keccakF(A) {
  const C = new Array(5), B = new Array(25);
  for (let r = 0; r < RONDAS; r++) {
    // theta
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    // rho y pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        A[x + y] = B[x + y] ^ ((~B[(x + 1) % 5 + y] & MASCARA) & B[(x + 2) % 5 + y]);
      }
    }
    // iota
    A[0] ^= RC[r];
  }
}

const aBytes = (entrada) => {
  if (entrada instanceof Uint8Array) return entrada;
  if (typeof entrada === 'string') return new TextEncoder().encode(entrada);
  if (ArrayBuffer.isView(entrada)) return new Uint8Array(entrada.buffer, entrada.byteOffset, entrada.byteLength);
  throw new TypeError('keccak256: se esperaba Uint8Array o string');
};

// keccak256(bytes | string utf-8) → Uint8Array de 32 bytes.
export function keccak256(entrada) {
  const msg = aBytes(entrada);
  // Relleno pad10*1 del Keccak original: 0x01 en el primer byte libre, 0x80 en el último del
  // bloque (si el mensaje llena el bloque exacto, se añade un bloque entero de relleno).
  const bloques = Math.floor(msg.length / TASA) + 1;
  const buf = new Uint8Array(bloques * TASA);
  buf.set(msg);
  buf[msg.length] ^= 0x01;
  buf[buf.length - 1] ^= 0x80;

  const A = new Array(25).fill(0n);
  for (let b = 0; b < bloques; b++) {
    const base = b * TASA;
    for (let i = 0; i < TASA / 8; i++) {
      // Carriles little-endian: el byte 0 es el menos significativo.
      let carril = 0n;
      for (let j = 7; j >= 0; j--) carril = (carril << 8n) | BigInt(buf[base + i * 8 + j]);
      A[i] ^= carril;
    }
    keccakF(A);
  }
  const salida = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let carril = A[i];
    for (let j = 0; j < 8; j++) { salida[i * 8 + j] = Number(carril & 0xffn); carril >>= 8n; }
  }
  return salida;
}

export const aHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// keccak256 en hexadecimal sin prefijo, minúsculas.
export const keccak256Hex = (entrada) => aHex(keccak256(entrada));

// Hex (con o sin 0x) → Uint8Array. Falla cerrado: un hex de largo impar o con basura no se adivina.
export function deHex(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`hex inválido: ${String(hex).slice(0, 20)}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
