// Nyx5/1 — primitivas criptográficas (solo node:crypto, sin dependencias)
//
// Firma:     Ed25519 (identidad del agente y del dominio)
// Cifrado:   X25519 (ECDH efímero) + HKDF-SHA256 + AES-256-GCM (extremo a extremo)
// Anti-spam: proof-of-work tipo hashcash (opcional, lo exige el receptor)
// Canónico:  JSON con claves ordenadas y sin espacios, para que la firma sea determinista

import {
  generateKeyPairSync, createPrivateKey, createPublicKey,
  sign as nodeSign, verify as nodeVerify,
  randomBytes, randomUUID, createHash, hkdfSync,
  createCipheriv, createDecipheriv,
} from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(s, 'base64url');
export const uuid = () => randomUUID();
export const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

// ---------- JSON canónico ----------
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// ---------- Claves ----------
export function generateSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { sig: publicKey.export({ format: 'jwk' }).x, sigPriv: privateKey.export({ format: 'jwk' }).d };
}
export function generateEncryptionKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { enc: publicKey.export({ format: 'jwk' }).x, encPriv: privateKey.export({ format: 'jwk' }).d };
}
export function generateKeys() {
  return { ...generateSigningKeys(), ...generateEncryptionKeys() };
}

const sigPrivateKey = (d, x) => createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d, x }, format: 'jwk' });
const sigPublicKey = (x) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
// El acuerdo de claves X25519 va por WebCrypto, NO por node:crypto. Medido el 10-sep-2026 en el
// runtime real de Cloudflare (workerd, scripts/sonda-workerd.mjs): `diffieHellman` no existe allá,
// ni con objetos de llave ni desde JWK, mientras que `crypto.subtle` X25519 sí, e importa las
// mismas JWK que genera Node. En Node y en los tests todo andaba: el defecto sólo se veía cuando
// el edge mismo cifraba, que es justo lo que hace el conector remoto. El secreto es el mismo
// (X25519 es estándar), así que el formato de los sobres no cambia y lo cifrado antes se abre igual.
async function x25519(d, x, publico) {
  const s = globalThis.crypto.subtle;
  const priv = await s.importKey('jwk', { kty: 'OKP', crv: 'X25519', x, d }, { name: 'X25519' }, false, ['deriveBits']);
  const pub = await s.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: publico }, { name: 'X25519' }, true, []);
  return Buffer.from(await s.deriveBits({ name: 'X25519', public: pub }, priv, 256));
}

// ---------- Firma de objetos ----------
// Firma todo el objeto menos el campo indicado (por defecto "signature").
export function signObject(obj, keys, field = 'signature') {
  const { [field]: _omit, ...body } = obj;
  const value = b64u(nodeSign(null, Buffer.from(canonical(body)), sigPrivateKey(keys.sigPriv, keys.sig)));
  return { ...body, [field]: { alg: 'Ed25519', kid: keys.sig, value } };
}

export function verifyObject(obj, expectedPub, field = 'signature') {
  const sig = obj?.[field];
  if (!sig || sig.alg !== 'Ed25519' || typeof sig.value !== 'string') return false;
  if (expectedPub && sig.kid !== expectedPub) return false;
  const { [field]: _omit, ...body } = obj;
  try {
    return nodeVerify(null, Buffer.from(canonical(body)), sigPublicKey(sig.kid), unb64u(sig.value));
  } catch {
    return false;
  }
}

// Firma "suelta" de bytes (para el header de relay entre estafetas y tokens de auth)
export function signBytes(data, keys) {
  return b64u(nodeSign(null, Buffer.from(data), sigPrivateKey(keys.sigPriv, keys.sig)));
}
export function verifyBytes(data, signature, pub) {
  try { return nodeVerify(null, Buffer.from(data), sigPublicKey(pub), unb64u(signature)); } catch { return false; }
}

// ---------- Cifrado extremo a extremo ----------
// Estructura tipo JWE: una clave de contenido (CEK) aleatoria cifra el cuerpo con AES-256-GCM;
// la CEK se envuelve para cada destinatario con X25519(ephemeral, destinatario) -> HKDF -> AES-GCM.
// El AAD amarra el cifrado al sobre (id/from/to) para impedir reenvíos con otro remitente.
const INFO = Buffer.from('nyx5/1 cek-wrap');

export async function encryptContent(content, recipients, aad) {
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(content))), cipher.final()]);
  const tag = cipher.getAuthTag();

  const eph = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  const epk = eph.x;
  const keys = {};
  for (const r of recipients) {
    const shared = await x25519(eph.d, eph.x, r.enc);
    const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.from(epk), INFO, 32));
    const wiv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', kek, wiv);
    const wrapped = Buffer.concat([c.update(cek), c.final()]);
    keys[r.address] = { iv: b64u(wiv), ct: b64u(wrapped), tag: b64u(c.getAuthTag()) };
  }
  return { alg: 'X25519+HKDF-SHA256+A256GCM', epk, iv: b64u(iv), ct: b64u(ct), tag: b64u(tag), keys };
}

export async function decryptContent(encrypted, address, keys, aad) {
  const slot = encrypted?.keys?.[address];
  if (!slot) throw new Error(`no wrapped key for ${address}`);
  const shared = await x25519(keys.encPriv, keys.enc, encrypted.epk);
  const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.from(encrypted.epk), INFO, 32));
  const d = createDecipheriv('aes-256-gcm', kek, unb64u(slot.iv));
  d.setAuthTag(unb64u(slot.tag));
  const cek = Buffer.concat([d.update(unb64u(slot.ct)), d.final()]);
  const d2 = createDecipheriv('aes-256-gcm', cek, unb64u(encrypted.iv));
  d2.setAAD(Buffer.from(aad));
  d2.setAuthTag(unb64u(encrypted.tag));
  const plain = Buffer.concat([d2.update(unb64u(encrypted.ct)), d2.final()]);
  return JSON.parse(plain.toString());
}

// ---------- Adjuntos: un archivo cifrado que la casa guarda sin poder leer ----------
// Un adjunto NO viaja en el sobre: viaja al almacén de objetos de la casa, cifrado, y el sobre
// lleva su referencia. La llave es ALEATORIA Y POR ADJUNTO y viaja en `attachments[].key` DENTRO
// del bloque cifrado del sobre: la casa aloja el objeto y no tiene con qué abrirlo (invariante 8).
//
// El objeto es autocontenido: iv(12) || ciphertext || tag(16). No hay cabecera, ni nombre, ni
// tipo: todo eso es contenido y vive dentro del bloque cifrado del sobre.
//
// El AAD lo pone quien llama y es `nyx5:blob:<blobId>:<from>` (ver src/correo/adjuntos.js): ata
// el cifrado a ESTE objeto y a ESTE remitente, así que un adjunto no se reusa desde otra
// dirección ni se hace pasar por otro objeto.
export const IV_BLOB = 12;
export const TAG_BLOB = 16;
export const generateBlobKey = () => b64u(randomBytes(32));

export function encryptBlob(datos, key, aad) {
  const k = unb64u(key);
  if (k.length !== 32) throw new Error('an attachment key is 32 bytes in base64url');
  const iv = randomBytes(IV_BLOB);
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(datos)), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

export function decryptBlob(objeto, key, aad) {
  const buf = Buffer.from(objeto);
  if (buf.length < IV_BLOB + TAG_BLOB) throw new Error('object too short to be an encrypted attachment');
  const k = unb64u(key);
  if (k.length !== 32) throw new Error('an attachment key is 32 bytes in base64url');
  const d = createDecipheriv('aes-256-gcm', k, buf.subarray(0, IV_BLOB));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - TAG_BLOB));
  return Buffer.concat([d.update(buf.subarray(IV_BLOB, buf.length - TAG_BLOB)), d.final()]);
}

// ---------- Proof-of-work (hashcash) ----------
function leadingZeroBits(hex) {
  let bits = 0;
  for (const ch of hex) {
    const n = parseInt(ch, 16);
    if (n === 0) { bits += 4; continue; }
    bits += Math.clz32(n) - 28;
    break;
  }
  return bits;
}
export function mintPow(id, bits) {
  if (!bits) return null;
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(sha256hex(`${id}:${nonce}`)) >= bits) return { bits, nonce: String(nonce) };
  }
}
export function checkPow(id, pow, requiredBits) {
  if (!requiredBits) return true;
  if (!pow || pow.bits < requiredBits) return false;
  return leadingZeroBits(sha256hex(`${id}:${pow.nonce}`)) >= requiredBits;
}
