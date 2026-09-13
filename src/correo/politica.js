// Nyx5/1 — Validación de sobres y política de entrada (anti-spam y anti-abuso).
//
// Toda estafeta receptora aplica, en este orden:
//   1. forma del sobre (schema mínimo) y tamaño
//   2. vigencia (expires) y duplicados (id)
//   3. cadena de firma: dominio -> agente -> sobre   (obligatoria; sin firma no hay entrega)
//   4. política del agente destino: open | allowlist | pow | stamp (+ límite de tasa por dominio emisor)

import { checkPow } from '../nucleo/crypto.js';
import { parseAddress } from './resolver.js';

export const TYPES = new Set(['message', 'task', 'result', 'receipt', 'intro']);

// Proyecto y rol de un sobre (13-sep-2026): un mismo dueño con varios chats sobre un solo conector
// distingue «Sigo Main» de «Rosetta Lab» con una extensión firmada dentro del sobre, y el buzón
// filtra por ella. Va en claro (las extensiones no se cifran): el nombre de un proyecto no es secreto.
export const EXT_PROYECTO = 'urn:nyx5:ext:proyecto';
export const proyectoDe = (env) => { const p = env?.extensions?.[EXT_PROYECTO]?.project; return typeof p === 'string' ? p.trim().toLowerCase() : null; };
export const rolDe = (env) => { const r = env?.extensions?.[EXT_PROYECTO]?.role; return typeof r === 'string' ? r.trim().slice(0, 40) : null; };

// Ficha pública del agente (13-sep-2026): qué hace, en qué idiomas, de quién es, con qué etiquetas.
// Va DENTRO de la tarjeta certificada, la firma el dueño al declararla y la casa al certificarla.
// Vocabulario CERRADO, como el alcance de un mandato: una clave desconocida se rechaza nombrándola,
// porque una ficha es lo que otros agentes leen antes de contratar, y no puede llevar de todo.
// Lo declarado NO está verificado (eso es el sello de dueño, otra pieza): es lo que el dueño dice.
const PERFIL_CLAVES = ['display_name', 'summary', 'description', 'languages', 'tags', 'owner', 'links'];
const limpio = (s, max) => String(s).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
export function validarPerfil(p) {
  if (p === null) return { perfil: null };
  if (typeof p !== 'object' || Array.isArray(p)) return { error: 'profile must be an object' };
  const ajenas = Object.keys(p).filter((k) => !PERFIL_CLAVES.includes(k));
  if (ajenas.length) return { error: `profile carries ${ajenas.map((k) => JSON.stringify(k)).join(', ')}, which this house does not publish; it accepts: ${PERFIL_CLAVES.join(', ')}` };
  const out = {};
  for (const [k, max] of [['display_name', 80], ['summary', 280], ['description', 2000]]) {
    if (p[k] == null) continue;
    if (typeof p[k] !== 'string') return { error: `profile.${k} must be a string` };
    const v = limpio(p[k], max); if (v) out[k] = v;
  }
  if (p.languages != null) {
    if (!Array.isArray(p.languages) || p.languages.length > 10 || !p.languages.every((l) => typeof l === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l))) return { error: 'profile.languages must be up to 10 language tags like "es", "en-US"' };
    out.languages = [...new Set(p.languages)];
  }
  if (p.tags != null) {
    if (!Array.isArray(p.tags) || p.tags.length > 20 || !p.tags.every((t) => typeof t === 'string' && /^[a-z0-9-]{1,32}$/.test(t))) return { error: 'profile.tags must be up to 20 tags of lowercase letters, digits and dashes' };
    out.tags = [...new Set(p.tags)];
  }
  if (p.owner != null) {
    const o = p.owner;
    if (typeof o !== 'object' || Array.isArray(o) || !['person', 'org'].includes(o.kind) || typeof o.name !== 'string' || Object.keys(o).some((k) => !['kind', 'name'].includes(k))) return { error: 'profile.owner must be { kind: person|org, name }' };
    out.owner = { kind: o.kind, name: limpio(o.name, 120) };
  }
  if (p.links != null) {
    if (!Array.isArray(p.links) || p.links.length > 5) return { error: 'profile.links must be up to 5 https URLs' };
    for (const l of p.links) { let u; try { u = new URL(String(l)); } catch { u = null; } if (!u || u.protocol !== 'https:' || String(l).length > 200) return { error: `profile.links: not an https URL: ${String(l).slice(0, 60)}` }; }
    out.links = [...new Set(p.links.map(String))];
  }
  return { perfil: out };
}

export function validateEnvelope(env, { maxBytes = 1_048_576 } = {}) {
  const fail = (reason) => ({ ok: false, code: 400, reason });
  if (!env || typeof env !== 'object') return fail('sobre no es un objeto');
  if (env.nyx5 !== '1') return fail('versión no soportada (se espera nyx5="1")');
  // Charset acotado: el id viaja como clave al almacenamiento (dedupe, buzones); nada de traversal.
  if (typeof env.id !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(env.id)) return fail('id inválido (se espera [A-Za-z0-9._:-]{8,128})');
  try { parseAddress(env.from); } catch { return fail('from inválido'); }
  if (!Array.isArray(env.to) || env.to.length < 1 || env.to.length > 50) return fail('to debe ser una lista de 1 a 50 direcciones');
  for (const t of env.to) { try { parseAddress(t); } catch { return fail(`invalid recipient: ${t}`); } }
  if (!TYPES.has(env.type)) return fail(`type inválido: ${env.type}`);
  if (Number.isNaN(Date.parse(env.created))) return fail('created debe ser ISO-8601');
  if (env.expires != null && Number.isNaN(Date.parse(env.expires))) return fail('expires debe ser ISO-8601');
  // Entrega diferida: el sobre espera en la cola hasta esta fecha (la cola ya programa por next_attempt).
  if (env.deliver_after != null) {
    if (Number.isNaN(Date.parse(env.deliver_after))) return fail('deliver_after debe ser ISO-8601');
    // Un sobre que vence antes de la fecha en que debe entregarse jamás llegaría: se rechaza al enviar.
    if (env.expires != null && Date.parse(env.expires) <= Date.parse(env.deliver_after)) return fail('deliver_after es posterior a expires: el sobre vencería antes de entregarse');
  }
  const hasPlain = env.content && typeof env.content === 'object' && typeof env.content.media === 'string';
  const hasEnc = env.encrypted && typeof env.encrypted === 'object' && typeof env.encrypted.ct === 'string';
  if (!hasPlain && !hasEnc) return fail('el sobre necesita content o encrypted');
  if (hasPlain && hasEnc) return fail('content y encrypted son excluyentes');
  if (env.attachments != null) {
    if (!Array.isArray(env.attachments)) return fail('attachments debe ser lista');
    for (const a of env.attachments) if (!a?.name || !a?.media || !a?.sha256 || !a?.url) return fail('adjunto incompleto (name, media, sha256, url)');
  }
  if (!env.signature || env.signature.alg !== 'Ed25519' || !env.signature.kid || !env.signature.value) return fail('sobre sin firma');
  const bytes = Buffer.byteLength(JSON.stringify(env));
  if (bytes > maxBytes) return { ok: false, code: 413, reason: `envelope of ${bytes} bytes exceeds the maximum ${maxBytes}` };
  return { ok: true };
}

// ---------- la puerta del correo ----------
// Un correo entra al buzón SIN firma y sin cuenta en el Libro. Durante un tiempo entró además sin
// pasar por ninguna política: un buzón que cobraba 500 y otro con lista blanca cerrada aceptaban
// los dos un correo de cualquier desconocido, gratis. O sea que la estampilla, la lista y la
// prueba de trabajo defendían una puerta mientras la de al lado quedaba abierta, y el precio que
// la casa anuncia por x402 era evitable escribiendo un correo.
//
// Esta función es esa puerta. Falla CERRADO: si la política del buzón no se puede expresar sobre
// correo, no se deja pasar. Un mecanismo que no existe en este canal no es un permiso.
//
// Se compara contra el remitente REAL del correo, no contra `email@<casa>`, que es la pasarela y
// sería la misma para todo el mundo.
export function applyEmailPolicy(agentRecord, emailFrom) {
  const inbox = agentRecord.inbox || { policy: 'open' };
  const dominio = String(emailFrom).slice(String(emailFrom).lastIndexOf('@') + 1).toLowerCase();
  const de = String(emailFrom).toLowerCase();
  switch (inbox.policy) {
    case undefined:
    case 'open':
      return { ok: true };
    case 'allowlist': {
      const ok = inbox.allowlist?.some((x) => String(x).toLowerCase() === de || String(x).toLowerCase() === dominio);
      // El "intro" y el aval del canal firmado NO tienen equivalente aquí: uno se apoya en el tipo
      // de sobre y el otro en una fianza del Libro, y un correo no trae ninguno de los dos.
      return ok ? { ok: true } : { ok: false, code: 403, reason: 'this mailbox only accepts listed senders' };
    }
    case 'pow':
      return { ok: false, code: 403, reason: `this mailbox requires proof-of-work, which an email cannot carry; write to ${agentRecord.address} with the protocol instead` };
    case 'stamp':
      return { ok: false, code: 402, reason: `this mailbox charges ${inbox.price ?? 1} tok for delivery, and an email carries no payment; join the house and send a signed envelope with a stamp` };
    default:
      return { ok: false, code: 403, reason: `unknown mailbox policy (${inbox.policy})` };
  }
}

// Limitador de tasa por clave (dominio emisor), ventana deslizante simple.
export class RateLimiter {
  constructor({ perMinute = 120 } = {}) { this.perMinute = perMinute; this.hits = new Map(); }
  allow(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < 60_000);
    if (arr.length >= this.perMinute) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr); return true;
  }
  retryAfter() { return 60; }
}

// Límite de tasa DURABLE (13-sep-2026, NX-901): el contador vive en el almacén, no en la memoria del
// proceso. En el edge cada isolate contaba por su lado, así que el límite real era N veces el
// declarado y nadie sabía cuánto era N. Ventana fija de un minuto por clave: una fila por clave y
// minuto, que vence sola dos minutos después. La misma interfaz que el de memoria (`allow` se
// espera con await en los dos: en el de memoria el await no cuesta nada).
// Si el almacén falla, DEJA PASAR y lo anota: un límite de tasa caído no puede tumbar el correo de
// todos. Precisión sobre cobertura: retener trabajo bueno es peor que dejar pasar un minuto.
export class RateLimiterDurable {
  constructor({ store, perMinute = 120, ns = 'tasa', log = () => {} } = {}) {
    if (!store?.kvIncrement) throw new Error('RateLimiterDurable needs a store with kvIncrement');
    this.store = store; this.perMinute = perMinute; this.ns = ns; this.log = log;
  }
  static ventana(nowMs = Date.now()) { return Math.floor(nowMs / 60_000); }
  async allow(key, nowMs = Date.now()) {
    const v = RateLimiterDurable.ventana(nowMs);
    try {
      const n = await this.store.kvIncrement(this.ns, `${key}:${v}`, (v + 2) * 60_000, nowMs);
      return n <= this.perMinute;
    } catch (e) { this.log(`tasa: el almacén no contó (${e.message}); se deja pasar`); return true; }
  }
  // Segundos hasta que abra la ventana siguiente: es lo que va en Retry-After.
  retryAfter(nowMs = Date.now()) { return Math.max(1, 60 - Math.floor((nowMs % 60_000) / 1000)); }
}

// Política del agente destino sobre un sobre ya verificado criptográficamente.
export function applyInboxPolicy(env, agentRecord, senderDomain) {
  const inbox = agentRecord.inbox || { policy: 'open' };
  const { domain: fromDomain } = parseAddress(env.from);
  const permanent = (reason) => ({ ok: false, code: 403, reason });

  if (inbox.blocklist?.some((x) => x === env.from || x === fromDomain)) return permanent('remitente bloqueado');
  // La promesa "sealed" del dominio emisor se hace cumplir ANTES de cualquier política:
  // si fuera después, la rama stamp (que retorna temprano) la saltaría — y justo en los buzones pagados.
  // Única excepción: sobres a libro@ (operaciones del Libro), que exigen claro por diseño (la casa debe leerlos).
  const esLibro = String(agentRecord.address || '').startsWith('libro@');
  if (!esLibro && senderDomain?.policy?.outbound === 'sealed' && !env.encrypted) return permanent('el dominio emisor exige cifrado y el sobre viene en claro');

  switch (inbox.policy) {
    case 'open':
      break;
    case 'allowlist': {
      const ok = inbox.allowlist?.some((x) => x === env.from || x === fromDomain);
      if (ok) break;
      // Un desconocido puede presentarse con un "intro" pequeño.
      if (env.type === 'intro' && Buffer.byteLength(JSON.stringify(env)) <= 4096) break;
      // O con un AVAL: un tercero de la allowlist lo respalda con una fianza en la casa del receptor.
      // Aquí solo comprobamos que el avalador esté en la allowlist; la estafeta verifica la fianza
      // contra su Libro (existe, activa, avala a este remitente, con el receptor como beneficiario).
      const aval = env.extensions?.['urn:nyx5:ext:aval'];
      if (aval && aval.voucher && aval.bond) {
        let voucherDomain; try { voucherDomain = parseAddress(aval.voucher).domain; } catch { voucherDomain = null; }
        if (inbox.allowlist?.some((x) => x === aval.voucher || x === voucherDomain)) {
          return { ok: true, vouch: { voucher: aval.voucher, bond: aval.bond, vouchee: env.from, beneficiary: agentRecord.address } };
        }
        return permanent('el avalador de la presentación no está en la allowlist');
      }
      return permanent('remitente no está en la allowlist (se acepta un intro ≤4 KB o un aval con fianza de un avalador de la allowlist)');
    }
    case 'pow': {
      const bits = inbox.pow_bits ?? 16;
      const exempt = inbox.allowlist?.some((x) => x === env.from || x === fromDomain);
      if (!exempt && !checkPow(env.id, env.pow, bits)) return { ok: false, code: 402, reason: `proof-of-work of ${bits} bits is required`, pow_bits: bits };
      break;
    }
    case 'stamp': {
      // Estampilla pagada en el Libro de la casa del receptor. La cobra la estafeta al aceptar.
      const exempt = inbox.allowlist?.some((x) => x === env.from || x === fromDomain);
      if (!exempt) return { ok: true, stamp: { price: inbox.price ?? 1, house: inbox.house } };
      break;
    }
    default:
      return permanent(`política de buzón desconocida: ${inbox.policy}`);
  }
  return { ok: true };
}
