// Nyx5/1 — Resolver: de una dirección agente@dominio a una tarjeta verificada.
//
// Orden de resolución del dominio (equivalente al registro MX del correo):
//   1. Override local (hosts.json / opción hosts)    -> pruebas y redes privadas
//   2. DNS TXT en _nyx5.<dominio>                  -> ancla pública de confianza
//   3. https://<dominio>/.well-known/nyx5.json     -> fallback sin DNS
//
// Cadena de confianza: clave del dominio (anclada en DNS o pineada) -> certifica la tarjeta
// del agente -> la clave del agente firma cada sobre.

import dns from 'node:dns/promises';
import { verifyObject } from '../nucleo/crypto.js';

export function parseAddress(address) {
  const m = /^([a-z0-9][a-z0-9._-]{0,63})@([a-z0-9.-]+)$/i.exec(String(address || ''));
  if (!m) throw new Error(`invalid address: ${address}`);
  return { local: m[1].toLowerCase(), domain: m[2].toLowerCase() };
}

export function parseTxtRecord(txt) {
  const out = {};
  for (const part of txt.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k && rest.length) out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

export class Resolver {
  constructor({ hosts = {}, fetchImpl = globalThis.fetch, cacheTtlMs = 5 * 60 * 1000, pins = {}, timeoutMs = 5000, onPin = null, self = null, auth = null } = {}) {
    // auth = { domain, header(method, path) }: un CLIENTE (Agent) firma la petición a su propia casa
    // cuando una tarjeta no aparece sin autenticar; así un contacto resuelve a un agente secreto.
    this.auth = auth;
    this.hosts = { ...hosts };          // { "beta.local": { url: "http://localhost:4002", sig?: "<pub>" } }
    this.fetch = (...a) => fetchImpl(...a); // envuelto: workerd exige fetch con this=globalThis
    this.cacheTtlMs = cacheTtlMs;
    this.pins = { ...pins };            // dominio -> clave pública pineada (TOFU o DNS)
    this.timeoutMs = timeoutMs;
    this.onPin = onPin;                 // callback(pins) para PERSISTIR un pin nuevo: un pin solo en memoria no protege entre procesos/isolates
    // La propia casa se sirve sin red: un Worker no puede pedirse su propia URL pública
    // (Cloudflare corta la conexión: 522) y en cualquier runtime sería una vuelta inútil.
    // self = { domain, estafeta, domainCard(), agentCard(local) }
    this.self = self;
    this.cache = new Map();
  }

  setHost(domain, entry) { this.hosts[domain] = entry; this.cache.clear(); }
  // Invalidar `agent:x@casa` borra también lo recordado «para» alguien de esa misma tarjeta.
  invalidate(key) { if (!key) { this.cache.clear(); return; } for (const k of this.cache.keys()) if (k === key || k.startsWith(`${key}|for:`)) this.cache.delete(k); }

  _cached(key) {
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    return null;
  }
  _remember(key, value) { this.cache.set(key, { value, until: Date.now() + this.cacheTtlMs }); }

  async _get(url, headers = {}) {
    const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw Object.assign(new Error(`GET ${url} -> ${res.status}`), { permanent: res.status === 404 || res.status === 410 });
    return res.json();
  }

  // Devuelve { url, sig? } donde vive la estafeta del dominio.
  async locate(domain) {
    domain = domain.toLowerCase();
    if (this.hosts[domain]) return { source: 'override', ...this.hosts[domain] };
    try {
      const records = await dns.resolveTxt(`_nyx5.${domain}`);
      for (const chunks of records) {
        const rec = parseTxtRecord(chunks.join(''));
        if (rec.v === 'nyx51' && rec.url) return { source: 'dns', url: rec.url, sig: rec.sig };
      }
    } catch (e) {
      // "No existe el registro" (NXDOMAIN/sin datos) es el fallback legítimo a well-known.
      // Cualquier OTRA falla de DNS (red, timeout, servfail) NO degrada el ancla en silencio:
      // un atacante que bloquee la respuesta DNS no puede empujarnos a well-known + TOFU.
      if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') {
        throw Object.assign(new Error(`DNS unavailable for ${domain}: ${e.message}`), { permanent: false });
      }
    }
    return { source: 'well-known', url: `https://${domain}` };
  }

  // Tarjeta del dominio, verificada y (si corresponde) contrastada con la clave anclada.
  async domainCard(domain) {
    domain = domain.toLowerCase();
    if (this.self && domain === this.self.domain) {
      const card = await this.self.domainCard();
      return { ...card, _estafeta: this.self.estafeta, _source: 'local' };
    }
    const cached = this._cached(`domain:${domain}`);
    if (cached) return cached;

    const loc = await this.locate(domain);
    const card = await this._get(`${loc.url.replace(/\/$/, '')}/.well-known/nyx5.json`);
    if (card.nyx5 !== '1' || card.domain !== domain) throw Object.assign(new Error(`invalid domain card for ${domain}`), { permanent: true });
    const keyIds = (card.keys || []).map((k) => k.sig);
    if (!keyIds.includes(card.signature?.kid) || !verifyObject(card, card.signature.kid)) {
      throw Object.assign(new Error(`invalid domain signature for ${domain}`), { permanent: true });
    }
    // Ancla: DNS/override dice qué clave debe tener el dominio. Si no hay ancla, TOFU (pin en primer uso).
    const anchor = loc.sig || this.pins[domain];
    if (anchor && !keyIds.includes(anchor)) throw Object.assign(new Error(`the key for domain ${domain} does not match the anchored one`), { permanent: true });
    if (!anchor) {
      this.pins[domain] = card.signature.kid;
      // Se persiste ESE pin, no el mapa entero: escribir el mapa desde la memoria de un proceso
      // borraba los pines que otro había aprendido.
      try { await this.onPin?.(domain, card.signature.kid); } catch { /* mejor-esfuerzo; el pin en memoria ya rige */ }
    }

    const value = { ...card, _estafeta: loc.url.replace(/\/$/, ''), _source: loc.source };
    this._remember(`domain:${domain}`, value);
    return value;
  }

  // Tarjeta del agente, certificada por la clave del dominio.
  // `onBehalfOf` (NX-202): para quién se pide. Un agente SECRETO sólo se sirve a quien está en su
  // lista, así que la casa que pregunta firma «lo pido para bob@mi-casa» con su llave de dominio, y
  // un cliente firma con la suya ante su propia casa. Sin eso, un secreto se ve como inexistente.
  async agentCard(address, { onBehalfOf = null } = {}) {
    const { local, domain } = parseAddress(address);
    // La propia casa sirve la tarjeta sin red, pero pasa por la MISMA verificación que una ajena:
    // venir de casa no la exime de estar certificada por el dominio y firmada por su padre.
    if (this.self && domain === this.self.domain) {
      const card = await this.self.agentCard(local);
      if (!card) throw Object.assign(new Error(`agente inexistente: ${address}`), { permanent: true });
      const dc = await this.domainCard(domain);
      return this._verifyAgentCard(card, dc, address, local, domain);
    }
    const key = `agent:${local}@${domain}`;
    // Una tarjeta secreta se recuerda SÓLO para quien la pidió: servida a otro, sería una fuga.
    const keyPara = onBehalfOf ? `${key}|for:${String(onBehalfOf).toLowerCase()}` : null;
    const cached = this._cached(key) || (keyPara && this._cached(keyPara));
    if (cached) return cached;

    const dc = await this.domainCard(domain);
    const url = `${dc._estafeta}/agents/${encodeURIComponent(local)}`;
    const headers = {};
    let paraDom = null; try { paraDom = onBehalfOf ? parseAddress(onBehalfOf).domain : null; } catch { paraDom = null; }
    if (onBehalfOf && this.self?.firmarPara && paraDom === this.self.domain) headers['x-nyx5-for'] = this.self.firmarPara(String(onBehalfOf).toLowerCase(), domain);
    let card;
    try { card = await this._get(url, headers); }
    catch (e) {
      // Un cliente que no la ve sin autenticar la vuelve a pedir firmando: a su propia casa si el
      // agente es de ahí; si es de otra casa, le pide a la suya que resuelva «para» él (la casa
      // firma con su llave de dominio y la otra decide). La tarjeta se verifica igual al llegar.
      if (!(e.permanent && this.auth)) throw e;
      if (domain === this.auth.domain) card = await this._get(url, { authorization: this.auth.header('GET', `/agents/${encodeURIComponent(local)}`) });
      else if (this.auth.url) { const p = `/resolve/${encodeURIComponent(`${local}@${domain}`)}`; const { presence: _p, ...c } = await this._get(`${this.auth.url}${p}`, { authorization: this.auth.header('GET', p) }); card = c; }
      else throw e;
    }
    const value = await this._verifyAgentCard(card, dc, address, local, domain);
    this._remember(value.visibility === 'secret' ? (keyPara || `${key}|for:${this.auth?.domain || 'self'}`) : key, value);
    return value;
  }

  // La verificación de una tarjeta de agente, en un solo lugar: certificación del dominio,
  // vigencia y cadena de delegación. La usan el camino local y el remoto por igual.
  async _verifyAgentCard(card, dc, address, local, domain) {
    if (card.nyx5 !== '1' || card.address !== `${local}@${domain}`) throw Object.assign(new Error(`invalid agent card: ${address}`), { permanent: true });
    const domainKeys = dc.keys.map((k) => k.sig);
    if (!domainKeys.includes(card.certification?.kid) || !verifyObject(card, card.certification.kid, 'certification')) {
      throw Object.assign(new Error(`invalid certification for ${address}`), { permanent: true });
    }
    if (card.valid_until && Date.parse(card.valid_until) < Date.now()) throw Object.assign(new Error(`tarjeta vencida: ${address}`), { permanent: true });
    if (card.delegation) {
      // Cadena de delegación: el padre (ya certificado por el dominio) firmó esta tarjeta.
      const d = card.delegation;
      const { local: parentLocal, domain: parentDomain } = parseAddress(d.by);
      if (parentDomain !== domain || !local.endsWith(`.${parentLocal}`) || d.address !== card.address || d.sig !== card.sig) throw Object.assign(new Error(`inconsistent delegation on ${address}`), { permanent: true });
      const parent = await this.agentCard(d.by);
      if (!Resolver.acceptedKids(parent).includes(d.signature?.kid) || !verifyObject(d, d.signature.kid)) throw Object.assign(new Error(`delegation not signed by ${d.by}`), { permanent: true });
      card = { ...card, delegation: { ...d, _parent: parent } };
    }
    return { ...card, _estafeta: dc._estafeta, _domain: dc };
  }

  // Claves aceptables de una tarjeta: la vigente más las anteriores dentro del período de gracia.
  // Una clave previa SIN vencimiento no cuenta: la gracia es acotada o no es gracia (falla cerrado).
  static acceptedKids(card) {
    return [card.sig, ...(card.previous || []).filter((p) => p.until && Date.parse(p.until) > Date.now()).map((p) => p.sig)];
  }

  // Igual que agentCard, pero si el sobre viene firmado con una clave que la tarjeta en caché no
  // reconoce (rotación reciente), refresca la tarjeta una vez antes de rechazar.
  async agentCardForKid(address, kid, opts = {}) {
    let card = await this.agentCard(address, opts);
    if (!Resolver.acceptedKids(card).includes(kid)) {
      const { local, domain } = parseAddress(address);
      this.invalidate(`agent:${local}@${domain}`);
      if (opts.onBehalfOf) this.invalidate(`agent:${local}@${domain}|for:${String(opts.onBehalfOf).toLowerCase()}`);
      card = await this.agentCard(address, opts);
    }
    return card;
  }
}
