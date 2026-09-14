// Nyx5/1 — Cliente de agente: la app de correo y la billetera en una sola pieza.
// Correo: firma, cifra, envía, lee, confirma. Libro: cotiza, acepta, entrega, libera, afianza, manda, cobra.
// Las operaciones del Libro son sobres firmados a libro@<casa>; las respuestas vuelven como recibos al buzón.

import { Resolver, parseAddress } from './resolver.js';
import { EXT_PROYECTO, proyectoDe, rolDe, nombreDeProyecto } from './politica.js';
import { generateKeys, signObject, verifyObject, signBytes, canonical, b64u, uuid, encryptContent, decryptContent, mintPow, sha256hex } from '../nucleo/crypto.js';
import { Libro, MEDIA } from '../libro/libro.js';
import { pruebaDeAceptacion } from '../libro/verifica.js';
import { MEDIA_COBRO, MEDIA_COBRO_CONFIRMACION, cobroValido, confirmacionValida, extensionDeCobro, razonParaNoCobrar } from './cobro.js';

const iso = (t = Date.now()) => new Date(t).toISOString();

export class Agent {
  constructor({ address, keys, estafeta, resolver, hosts = {}, fetchImpl = globalThis.fetch }) {
    const { local, domain } = parseAddress(address);
    this.address = `${local}@${domain}`; this.local = local; this.domain = domain;
    this.keys = keys;
    this.estafeta = estafeta.replace(/\/$/, '');
    this.fetch = (...a) => fetchImpl(...a); // envuelto: workerd exige fetch con this=globalThis
    // El cliente firma ante su propia casa cuando una tarjeta no aparece sin autenticar (NX-202):
    // así un contacto de un agente secreto lo resuelve, y un extraño ve lo mismo que si no existiera.
    this.resolver = resolver || new Resolver({ hosts: { [domain]: { url: this.estafeta }, ...hosts }, fetchImpl, auth: { domain, url: this.estafeta, header: (method, path) => this._auth(method, path) } });
  }

  static create(address, estafeta, opts = {}) { return new Agent({ address, estafeta, keys: generateKeys(), ...opts }); }
  // load/save usan node:fs por import dinámico: el módulo carga limpio en Workers (donde no se usan).
  static async load(file, opts = {}) { const fs = await import('node:fs'); const j = JSON.parse(fs.readFileSync(file, 'utf8')); return new Agent({ ...j, ...opts }); }
  async save(file) { const fs = await import('node:fs'); fs.mkdirSync(require_dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ address: this.address, estafeta: this.estafeta, keys: this.keys }, null, 2), { mode: 0o600 }); }

  // ---------- auth ante la propia estafeta ----------
  _auth(method, path, keys = this.keys, base = this.estafeta) {
    // `host` amarra el token a la casa destino: capturado, no sirve contra otra estafeta.
    const claims = { address: this.address, ts: iso(), nonce: uuid(), method, path, host: new URL(base).host };
    const token = b64u(canonical(claims));
    return `Nyx5 ${token}.${signBytes(canonical(claims), keys)}`;
  }
  async _call(method, path, body, { admin, noAuth, authKeys, timeoutMs = 10_000 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (admin) headers.authorization = `Bearer ${admin}`; else if (!noAuth) headers.authorization = this._auth(method, path.split('?')[0], authKeys);
    const res = await this.fetch(`${this.estafeta}${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status, body: json });
    return json;
  }

  // ---------- registro ----------
  // Tres caminos: adminToken (la casa inscribe), invite (código de la casa) o abierto si la casa lo permite.
  // Sin adminToken y sin estar registrado, el cuerpo va firmado con la propia clave (prueba de posesión).
  async register({ adminToken, invite, capabilities, inbox, wallet, wallets, webhook, notify_email, valid_until, source, visibility, profile } = {}) {
    // `source` es atribución de distribución: viaja al alta, se registra en el evento `join`
    // y NO entra en la tarjeta. Nadie puede leer de dónde vino un agente mirando su tarjeta.
    // `wallet` es la dirección a la que este agente quiere que le paguen en dinero real. Es
    // PÚBLICA y va en la tarjeta: la casa no la controla ni puede mover nada de ella.
    const body = { local: this.local, sig: this.keys.sig, enc: this.keys.enc, capabilities, inbox, wallet, wallets, webhook, notify_email, valid_until, source, visibility, profile };
    if (adminToken) this.card = await this._call('POST', '/agents', body, { admin: adminToken });
    else if (this.card) this.card = await this._call('POST', '/agents', body);
    else this.card = await this._call('POST', '/agents', signObject({ ...body, invite: invite || undefined, ts: iso() }, this.keys), { noAuth: true });
    this.resolver.invalidate(`agent:${this.address}`);
    return this.card;
  }
  // Directorio público de una casa (por defecto la propia): filtra por capacidad, media aceptado o texto.
  async directory(house, { capability, accepts, q, limit, offset } = {}) {
    const params = new URLSearchParams(Object.entries({ capability, accepts, q, limit, offset }).filter(([, v]) => v != null));
    const base = !house || house === this.domain ? this.estafeta : (await this.resolver.domainCard(house))._estafeta;
    const res = await this.fetch(`${base}/agents?${params}`, { signal: AbortSignal.timeout(10_000) });
    return res.json();
  }
  // Rotación: el cuerpo lleva las claves nuevas; la autenticación se firma con las viejas (o usa adminToken).
  async rotateKeys({ adminToken } = {}) {
    const old = this.keys;
    const fresh = { ...this.keys, ...generateKeys() };
    const body = { local: this.local, sig: fresh.sig, enc: fresh.enc, capabilities: this.card?.capabilities, inbox: this.card?.inbox };
    // Las claves nuevas se adoptan DESPUÉS de que la estafeta confirma: si el POST falla,
    // este agente sigue firmando con las viejas y no queda inutilizable.
    this.card = await this._call('POST', '/agents', body, adminToken ? { admin: adminToken } : { authKeys: old });
    this.keys = fresh;
    this.resolver.invalidate(`agent:${this.address}`);
    return this.card;
  }

  // ---------- envío ----------
  async send({ to, type = 'message', body, media, encrypt = true, thread, inReplyTo, expires, deliverAfter, attachments, extensions, receipt, project, role }) {
    const recipients = Array.isArray(to) ? to : [to];
    const id = uuid();
    // Proyecto y rol viajan como extensión firmada: el buzón del otro lado filtra por proyecto.
    // Un proyecto que no normaliza a un nombre (sólo invisibles, o `__proto__`/`constructor`) se
    // rechaza aquí, con nombre: antes viajaba como `project: null` y el remitente creía haberlo etiquetado.
    const proyecto = project ? nombreDeProyecto(project) : null;
    if (project && !proyecto) throw new Error(`invalid project name: ${JSON.stringify(String(project).slice(0, 40))} (empty after normalization, or a reserved word)`);
    if (proyecto || role) extensions = { ...(extensions || {}), [EXT_PROYECTO]: { ...(proyecto ? { project: proyecto } : {}), ...(role ? { role: String(role).trim().slice(0, 40) } : {}) } };
    // Un sobre que responde a otro hereda su hilo. Defecto real (12-sep-2026): las respuestas iban con
    // in_reply_to y thread null, y la conversación quedaba como mensajes sueltos; el historial firmado
    // es el producto, y sin hilo no es historial. La casa no puede rellenarlo: el sobre va firmado.
    if (inReplyTo && thread == null) thread = await this._hiloDe(inReplyTo, recipients[0]);
    const base = {
      nyx5: '1', id, from: this.address, to: recipients, created: iso(),
      expires: expires ?? null, deliver_after: deliverAfter ?? undefined, thread: thread ?? null, in_reply_to: inReplyTo ?? null, type,
      attachments, extensions, receipt,
    };
    const content = { media: media || (typeof body === 'string' ? 'text/plain' : 'application/json'), body };

    // Tarjetas de los destinatarios: para cifrar (clave enc) y para saber si exigen proof-of-work.
    // La tarjeta de un grupo cambia cada vez que entra o sale alguien: se pide fresca, siempre.
    // Defecto real de la primera prueba: con la tarjeta en caché, el miembro nuevo recibía un sobre
    // que no podía abrir.
    for (const r of recipients) { try { if (parseAddress(r).local.startsWith('g.')) this.resolver.invalidate(`agent:${r}`); } catch { /* dirección inválida: la resolución lo dirá */ } }
    const cards = await Promise.all(recipients.map((r) => this.resolver.agentCard(r, { onBehalfOf: this.address }).catch((e) => ({ address: r, _error: e.message }))));
    const missing = cards.filter((c) => c._error);
    if (missing.length) throw new Error(`could not resolve: ${missing.map((c) => `${c.address} (${c._error})`).join(', ')}`);

    // Un grupo no tiene llave: se cifra para cada uno de sus miembros, que sí la publican. La casa
    // reparte el sobre tal cual y nunca puede abrirlo.
    const lectores = [];
    for (const c of cards) {
      if (!c.group) { lectores.push({ address: c.address, enc: c.enc }); continue; }
      for (const dir of c.group.members) {
        if (dir === this.address) continue;
        const mc = await this.resolver.agentCard(dir, { onBehalfOf: this.address }).catch(() => null);
        lectores.push({ address: dir, enc: mc?.enc || null });
      }
    }
    let env;
    if (encrypt && lectores.every((l) => l.enc)) {
      // El remitente también recibe una copia de la llave del contenido. No es un destinatario más:
      // `to` no cambia y la AAD tampoco. Sin esto, lo que uno mismo mandó cifrado es ilegible para
      // uno mismo, y el historial de una conversación queda con la mitad de los mensajes en blanco.
      if (this.keys.enc && !lectores.some((l) => l.address === this.address)) lectores.push({ address: this.address, enc: this.keys.enc });
      env = { ...base, encrypted: await encryptContent(content, lectores, aad(base)) };
    } else {
      if (encrypt === 'required') throw new Error('a recipient does not publish an encryption key');
      env = { ...base, content };
    }
    const powBits = Math.max(0, ...cards.map((c) => (c.inbox?.policy === 'pow' ? c.inbox.pow_bits ?? 16 : 0)));
    if (powBits) env.pow = mintPow(id, powBits);
    const stamped = cards.find((c) => c.inbox?.policy === 'stamp');
    if (stamped) {
      if (recipients.length > 1) throw new Error('a stamped envelope carries a single recipient');
      env.stamp = { house: stamped.inbox.house || parseAddress(stamped.address).domain, amount: stamped.inbox.price ?? 1 };
    }

    const signed = signObject(env, this.keys);
    const r = await this._call('POST', '/outbound', signed);
    // `encrypted` dice lo que de verdad pasó: un destinatario sin llave de cifrado recibe en claro,
    // y quien manda tiene que poder saberlo en vez de creer que se cifró.
    return { id, envelope: signed, jobs: r.jobs, encrypted: !!env.encrypted };
  }
  // Un mensaje a tu yo futuro: llega a tu propio buzón en la fecha indicada, cifrado (solo tú lo abres).
  // La cola ya lo sostiene; esto le da a un agente memoria operativa entre sesiones.
  recordar({ cuando, body, thread, type = 'message' } = {}) {
    return this.send({ to: this.address, body, type, thread, deliverAfter: cuando, encrypt: true });
  }
  // Escribirle a una dirección de correo del mundo real por el puente de la casa. Si el humano
  // responde, su respuesta vuelve a tu buzón (Reply-To = tu dirección). Sin proveedor de salida
  // configurado, devuelve { pending: true } en vez de fallar: el canal aún no existe.
  async email({ to, subject, body }) {
    try { return await this._call('POST', '/email/out', { to, subject, body }); }
    catch (e) { if (e.status === 503 && e.body?.pending) return e.body; throw e; }
  }
  // El hilo del sobre al que se responde: el suyo si lo tenía, si no su propio id. Se busca en la
  // conversación con el destinatario (lo recibido y lo enviado); si la casa no lo conoce, el id.
  async _hiloDe(inReplyTo, con) {
    try {
      const msgs = await this.conversation(con, { limit: 200 });
      const m = msgs.find((x) => (x.envelope || x).id === inReplyTo);
      if (m) return (m.envelope || m).thread || inReplyTo;
    } catch { /* sin historial disponible: el id basta como raíz del hilo */ }
    return inReplyTo;
  }
  reply(envelope, body, opts = {}) {
    return this.send({ to: envelope.from, thread: envelope.thread || envelope.id, inReplyTo: envelope.id, type: opts.type || 'result', body, ...opts });
  }
  // Recibo no repudiable: firmado por este agente e incluye el hash del sobre original.
  receipt(envelope, status, reason) {
    return this.send({ to: envelope.from, type: 'receipt', inReplyTo: envelope.id, thread: envelope.thread || envelope.id, body: { of: envelope.id, sha256: sha256hex(canonical(envelope)), status, reason }, encrypt: false });
  }

  // ---------- delegación de identidad: un subagente con tarjeta firmada por este agente ----------
  // El subagente genera sus propias claves; este agente firma { by, address, sig, scope, valid_until };
  // la estafeta certifica la tarjeta. scope: { types?: [...], to_domains?: [...], cap?: tokens }.
  async delegate(name, { scope = {}, valid_until = null, capabilities, inbox } = {}) {
    const sub = Agent.create(`${name}.${this.local}@${this.domain}`, this.estafeta, { resolver: this.resolver, fetchImpl: this.fetch });
    const delegation = signObject({ by: this.address, address: sub.address, sig: sub.keys.sig, scope, valid_until, issued: iso() }, this.keys);
    const body = { local: sub.local, sig: sub.keys.sig, enc: sub.keys.enc, capabilities, inbox, delegation };
    sub.card = await this._call('POST', '/agents', body);
    return sub;
  }

  // ---------- Libro: cotizaciones y contratos ----------
  // Una cotización es un documento firmado por el vendedor; viaja dentro de un sobre (cifrado) al comprador.
  // Con `service` (NX-301) el precio, el contrato y el concepto se leen de la propia ficha publicada
  // si no vienen; lo que venga explícito viaja igual y la casa lo cruza con la ficha al aceptar.
  // `thread`/`inReplyTo`: cuando la cotización contesta un pedido (NX-305) viaja en su hilo.
  async quote({ to, contract, price, concept, terms, expires, arbiter, house, referrer, service, thread, inReplyTo }) {
    if (service != null) {
      const s = await this._servicioPropio(service);
      price ??= s.price.tokens; contract ??= s.contract; concept ??= s.name;
    }
    const q = Libro.buildQuote({ seller: this.address, buyer: to, house: house || parseAddress(to).domain, contract: contract ?? 'spot', price, concept, terms, expires, arbiter, referrer, service }, this.keys);
    const sent = await this.send({ to, type: 'message', media: MEDIA.cotizacion, body: q, expires: expires ?? null, thread, inReplyTo });
    return { quote: q, ...sent };
  }
  async _servicioPropio(service) {
    this.resolver.invalidate(`agent:${this.address}`);
    const s = ((await this.resolver.agentCard(this.address)).profile?.services || []).find((x) => x.id === service);
    if (!s) throw new Error(`service "${service}" is not published in your profile; publish it with setProfile first`);
    return s;
  }

  // ---------- NX-305: contratar desde el catálogo en un paso ----------
  // El comprador PIDE (sobre `task` con media pedido: { service, input, note }); el vendedor
  // contesta con la cotización de su propia ficha TAL CUAL; el comprador la acepta si coincide.
  // Lado vendedor: la cotización que responde a un pedido, armada desde la ficha publicada. El
  // precio y el contrato son los de la ficha (la casa los cruza al aceptar); la prueba sale de
  // `acceptance` + el `input` del pedido; el árbitro es verifica@ de la casa del contrato.
  // `pedido` es el sobre ya abierto (lo que devuelve `open`).
  async quoteFromCatalog(pedido, { service = null } = {}) {
    if (pedido?.content?.media !== MEDIA.pedido) throw new Error(`not a service request: media is ${pedido?.content?.media || '(none)'}, expected ${MEDIA.pedido}`);
    const b = pedido.content.body || {};
    if (typeof b.service !== 'string' || !b.service) throw new Error('the request does not name a service');
    if (service != null && service !== b.service) throw new Error(`the request asks for "${b.service}", not "${service}"`);
    const s = await this._servicioPropio(b.service);
    const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {};
    const house = parseAddress(pedido.from).domain;
    // Sin prueba publicada no hay árbitro: un escrow queda como pago diferido (SPEC §16, `expire`).
    const verify = s.acceptance ? pruebaDeAceptacion(s.acceptance, input) : null;
    const terms = { input, ...(s.acceptance ? { acceptance: s.acceptance.template, verify } : {}), ...(typeof b.note === 'string' && b.note ? { note: b.note.slice(0, 500) } : {}) };
    return this.quote({ to: pedido.from, service: s.id, terms, arbiter: verify ? `verifica@${house}` : undefined, house, thread: pedido.thread || pedido.id, inReplyTo: pedido.id });
  }
  // Un pedido recibido, por id: en la bandeja o, si ya se confirmó, en la conversación con `from`.
  async pedido(id, from = null) {
    let m = (await this.inbox({ limit: 200 })).find((x) => x.envelope?.id === id);
    if (!m && from) m = (await this.conversation(from, { limit: 200 })).find((x) => x.dir === 'in' && x.envelope?.id === id);
    if (!m) return null;
    const o = await this.open(m.envelope);
    if (o.content?.media !== MEDIA.pedido) throw new Error(`envelope ${id} is not a service request (media ${o.content?.media || '(none)'})`);
    return o;
  }
  // Lado comprador. Manda el pedido y, con `autoAccept`, espera la cotización hasta `wait`
  // segundos y la acepta SOLO si es la del catálogo que este cliente leyó: mismo servicio, mismo
  // vendedor, precio y contrato publicados, precio <= maxPrice, el mismo input, y con prueba
  // publicada, verifica@ de árbitro y la prueba del `kind` publicado. Cualquier diferencia se
  // devuelve nombrada y NO se acepta. Lo que impide siquiera pedir (no vende, servicio
  // inexistente, precio sobre el tope) se lanza como error.
  async hire({ agent, service, input = {}, note, autoAccept = true, maxPrice = null, wait = 25 } = {}) {
    if (typeof agent !== 'string' || typeof service !== 'string' || !service) throw new Error('hire needs agent (address) and service (id)');
    if (input == null) input = {};
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object');
    this.resolver.invalidate(`agent:${String(agent).toLowerCase()}`);
    const card = await this.resolver.agentCard(agent, { onBehalfOf: this.address });
    if (card.delegation?.scope?.messages_only) throw new Error(`${card.address} does not sell by itself: it is a messages-only address (a connected Claude) and cannot quote; write to it, or to its owner ${card.delegation.by}`);
    const publicados = card.profile?.services || [];
    const s = publicados.find((x) => x.id === service);
    if (!s) throw new Error(publicados.length ? `${card.address} does not publish service "${service}"; it publishes: ${publicados.map((x) => x.id).join(', ')}` : `${card.address} publishes no services; write to it instead`);
    if (maxPrice != null && s.price.tokens > maxPrice) throw new Error(`service "${service}" is published at ${s.price.tokens} tok; your max_price is ${maxPrice}. Nothing was requested`);
    const pedido = await this.send({ to: card.address, type: 'task', media: MEDIA.pedido, body: { service, input, ...(note ? { note: String(note) } : {}) }, encrypt: true });
    const base = { request: pedido.id, agent: card.address, service, published: { price: s.price.tokens, contract: s.contract, acceptance: s.acceptance || null } };
    if (!autoAccept) return { ...base, accepted: false, status: 'requested', note: 'the quote will arrive in your mailbox; accept it yourself' };
    const m = await this.wait({ from: card.address, thread: pedido.id, seconds: Math.max(1, Math.min(Number(wait) || 25, 90)) });
    if (!m) return { ...base, accepted: false, status: 'no_quote', reason: `no quote arrived within ${wait} s; the request waits in ${card.address}'s mailbox and the quote, if any, will land in yours` };
    const o = await this.open(m.envelope);
    if (o.content?.media !== MEDIA.cotizacion) { await this.ack(m.envelope.id).catch(() => {}); return { ...base, accepted: false, status: 'declined', reason: 'the seller answered without a quote', reply: o.content }; }
    const q = o.content.body || {};
    const rechazo = (reason) => ({ ...base, accepted: false, status: 'rejected', reason, quote: q });
    const cotizado = await (async () => {
      if (q.seller !== card.address) return `the quote is signed by ${q.seller}, not by ${card.address}`;
      if (q.buyer !== this.address) return `the quote names ${q.buyer} as buyer, not you`;
      if (q.service !== service) return `the quote is for service ${JSON.stringify(q.service ?? null)}, you asked for "${service}"`;
      if (q.price !== s.price.tokens || q.contract !== s.contract) return `service ${service} is published at ${s.price.tokens} tok as ${s.contract}; the quote says ${q.price} as ${q.contract}`;
      if (maxPrice != null && q.price > maxPrice) return `the quote is ${q.price} tok, above your max_price of ${maxPrice}`;
      if (canonical(q.terms?.input ?? {}) !== canonical(input)) return 'the quote does not carry the input you sent';
      if (s.acceptance) {
        const v = q.terms?.verify;
        if (q.arbiter !== `verifica@${q.house}`) return `the service publishes a ${s.acceptance.kind} test but the quote names ${q.arbiter || 'no'} arbiter instead of verifica@${q.house}`;
        if (!v || v.type !== s.acceptance.kind) return `the service publishes a ${s.acceptance.kind} test; the quote carries ${v?.type || 'none'}`;
        // La prueba ENTERA tiene que ser la que sale de la ficha y de este input (revisión del 14-sep:
        // un vendedor cotizaba con el tipo correcto y su propia URL siempre-200, y cobraba sin tocar el trabajo).
        let esperada; try { esperada = pruebaDeAceptacion(s.acceptance, input); } catch (e) { return `the published test cannot be derived from your input: ${e.message}`; }
        if (canonical(v) !== canonical(esperada)) return `the quote's test differs from the published one applied to your input: expected ${JSON.stringify(esperada)}, got ${JSON.stringify(v)}`;
      }
      return null;
    })();
    await this.ack(m.envelope.id).catch(() => {});
    if (cotizado) return rechazo(cotizado);
    const enviada = await this.accept(q);
    const r = await this.awaitReceipt(enviada.id, { timeoutMs: 15_000 });
    if (r.from !== `libro@${q.house}`) return { ...base, accepted: false, status: 'rejected', reason: `the house rejected the acceptance: ${r.receipt?.reason || 'no reason given'}`, quote: q };
    const c = r.receipt.contract;
    return { ...base, accepted: true, status: 'hired', quote_id: q.id, contract: c, price: c.amount, verification: c.arbiter && c.terms?.verify ? { arbiter: c.arbiter, verify: c.terms.verify, when: 'after the seller delivers (nyx5_libro op=deliver), verifica@ runs the test and releases or refunds' } : null };
  }
  // ---------- NX-502: pedido de pago por transferencia (dinero real, fuera del Libro) ----------
  // Manda a UNA persona un cobro cifrado (monto, moneda, nombre, RUT, banco, cuenta, referencia).
  // Se valida antes de firmar (RUT módulo 11, monto por moneda); el sobre va cifrado o no va; y
  // nunca a una dirección cuya llave guarda la casa (razonParaNoCobrar). Lo que la casa ve es la
  // extensión en claro { kind, request_id, currency }: con eso anota `payment_requested`, sin monto.
  async paymentRequest({ to, thread, ...datos } = {}) {
    if (typeof to !== 'string' || !to) throw new Error('paymentRequest needs to: the address of who pays');
    const cobro = cobroValido({ ...datos, request_id: datos.request_id ?? uuid() });
    this.resolver.invalidate(`agent:${String(to).toLowerCase()}`);
    const card = await this.resolver.agentCard(to, { onBehalfOf: this.address });
    const razon = razonParaNoCobrar(card);
    if (razon) throw new Error(razon);
    const r = await this.send({ to: card.address, type: 'message', media: MEDIA_COBRO, body: cobro, encrypt: 'required', thread, extensions: extensionDeCobro('request', cobro) });
    return { id: r.id, request_id: cobro.request_id, to: card.address, currency: cobro.currency, encrypted: r.encrypted, jobs: r.jobs };
  }
  // Un cobro recibido, por id de sobre: en la bandeja o, si ya se confirmó, en la conversación con `from`.
  async cobro(id, from = null) {
    let m = (await this.inbox({ limit: 200 })).find((x) => x.envelope?.id === id);
    if (!m && from) m = (await this.conversation(from, { limit: 200 })).find((x) => x.dir === 'in' && x.envelope?.id === id);
    if (!m) return null;
    const o = await this.open(m.envelope);
    if (!o.encrypted) throw new Error(`envelope ${id} arrived in the clear: a payment request only counts encrypted`);
    if (o.content?.media !== MEDIA_COBRO) throw new Error(`envelope ${id} is not a payment request (media ${o.content?.media || '(none)'})`);
    return o;
  }
  // Quien pagó desde su banco le contesta a quien pidió, en el hilo del pedido, con la referencia
  // bancaria. Cifrado o nada, y con la misma regla de destino que el pedido. `pedido` es el sobre
  // abierto (lo que devuelve `cobro`). Nyx5 no comprueba el pago: lleva la palabra del pagador.
  async paymentConfirm(pedido, { bank_reference } = {}) {
    if (pedido?.content?.media !== MEDIA_COBRO) throw new Error(`not a payment request: media is ${pedido?.content?.media || '(none)'}, expected ${MEDIA_COBRO}`);
    if (!pedido.to.includes(this.address)) throw new Error(`payment request ${pedido.id} was not addressed to ${this.address}`);
    const confirmacion = confirmacionValida({ request_id: pedido.content.body?.request_id, bank_reference });
    const card = await this.resolver.agentCard(pedido.from, { onBehalfOf: this.address });
    const razon = razonParaNoCobrar(card);
    if (razon) throw new Error(razon);
    const currency = pedido.content.body?.currency;
    const r = await this.send({ to: card.address, type: 'result', media: MEDIA_COBRO_CONFIRMACION, body: confirmacion, encrypt: 'required', thread: pedido.thread || pedido.id, inReplyTo: pedido.id, extensions: extensionDeCobro('confirmation', { request_id: confirmacion.request_id, currency }) });
    return { id: r.id, request_id: confirmacion.request_id, to: card.address, in_reply_to: pedido.id, encrypted: r.encrypted, jobs: r.jobs };
  }

  // Operación genérica: sobre firmado, sin cifrar, a libro@<casa>. La respuesta llega como recibo.
  libroOp(house, body, opts = {}) {
    return this.send({ to: `libro@${house}`, type: 'task', media: MEDIA.op, body, encrypt: false, ...opts });
  }
  accept(quote) { return this.libroOp(quote.house, { op: 'accept', quote }); }
  deliver(house, contract, { evidence_sha256, note } = {}) { return this.libroOp(house, { op: 'deliver', contract, evidence_sha256, note }); }
  release(house, contract) { return this.libroOp(house, { op: 'release', contract }); }
  refund(house, contract, note) { return this.libroOp(house, { op: 'refund', contract, note }); }
  reclaim(house, contract) { return this.libroOp(house, { op: 'reclaim', contract }); }
  bond(house, { amount, claim, verifier, beneficiary, arbiter, evidence_sha256, expires, vouchee }) { return this.libroOp(house, { op: 'bond', amount, claim, verifier, beneficiary, arbiter, evidence_sha256, expires, vouchee }); }
  // Avalar a un desconocido para que entre a un buzón con lista blanca: una fianza en la casa del
  // receptor, con el receptor como verificador y beneficiario. Si la presentación es basura, la ejecuta.
  vouch(house, { forAddress, receiver, amount, claim, expires }) {
    return this.bond(house, { amount, claim: claim || `avalo a ${forAddress} ante ${receiver}`, verifier: receiver, beneficiary: receiver, vouchee: forAddress, expires });
  }
  forfeit(house, contract, reason) { return this.libroOp(house, { op: 'forfeit', contract, reason }); }
  mandate(house, { grantee, cap, scope, expires, parent }) { return this.libroOp(house, { op: 'mandate', grantee, cap, scope, expires, parent }); }
  charge(house, { mandate, amount, concept }) { return this.libroOp(house, { op: 'charge', mandate, amount, concept }); }
  revoke(house, mandate) { return this.libroOp(house, { op: 'revoke', mandate }); }
  pay(house, { to, amount, concept }) { return this.libroOp(house, { op: 'pay', to, amount, concept }); }
  // Notaría (NX-601): la casa sella el hash de un documento con fecha y firma; el sello llega como
  // recibo. Gratis; el mismo hash sellado dos veces por el mismo agente devuelve el mismo sello.
  notarize(house, { sha256, name, media, note }) { return this.libroOp(house, { op: 'notarize', sha256, name, media, note }); }

  // Lecturas directas (sin pasar por correo) en la casa indicada; por defecto, la propia estafeta.
  async balance(house) { return this._callAt(house, 'GET', `/libro/cuenta/${encodeURIComponent(this.address)}`); }
  // Estado de cuenta por rango (NX-501), lectura directa firmada: opening + in − out = closing.
  // `since`/`until` ISO-8601 ([since, until)); `limit` acota cuántos asientos, los más recientes.
  async statement(house, { since, until, limit } = {}) {
    const q = new URLSearchParams(Object.entries({ desde: since, hasta: until, limit }).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    return this._callAt(house, 'GET', `/libro/estado${q.size ? `?${q}` : ''}`);
  }
  async contract(house, id) { return this._callAt(house, 'GET', `/libro/contrato/${encodeURIComponent(id)}`); }
  // Historial público de cualquier agente (por defecto, el propio): la reputación es el libro.
  async historial(address = this.address) {
    const { local, domain } = parseAddress(address);
    const base = domain === this.domain ? this.estafeta : (await this.resolver.domainCard(domain))._estafeta;
    const res = await this.fetch(`${base}/agents/${encodeURIComponent(local)}/historial`, { signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status });
    return json;
  }
  // Sellos PÚBLICOS de un hash en una casa (sin cuenta): null si no hay ninguno. Cada sello se
  // verifica contra la tarjeta del dominio; si la casa sirviera uno que no firmó, se rechaza entero.
  async notarized(sha256, house = this.domain) {
    const dc = await this.resolver.domainCard(house);
    const res = await this.fetch(`${dc._estafeta}/notaria/${encodeURIComponent(String(sha256).toLowerCase())}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status });
    const kids = (dc.keys || []).map((k) => k.sig);
    for (const s of json.seals || []) {
      if (!kids.includes(s.signature?.kid) || !verifyObject(s, s.signature.kid)) throw new Error(`seal ${s.id} is not signed by ${house}`);
    }
    return json;
  }
  async _callAt(house, method, path) {
    if (!house || house === this.domain) return this._call(method, path);
    const dc = await this.resolver.domainCard(house);
    const res = await this.fetch(`${dc._estafeta}${path}`, { method, headers: { authorization: this._auth(method, path.split('?')[0], this.keys, dc._estafeta) }, signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status });
    return json;
  }

  // Espera el recibo del Libro que responde a una operación (por in_reply_to) y lo abre.
  async awaitReceipt(sentId, { timeoutMs = 10_000 } = {}) {
    const m = await this.waitFor((e) => e.type === 'receipt' && e.in_reply_to === sentId, { timeoutMs });
    const opened = await this.open(m.envelope);
    return { ...opened, receipt: opened.content.body, envelope: m.envelope };
  }

  // Búsqueda en un índice federado (urn:nyx5:ext:indice): por casa que lo opera o URL directa.
  // El índice es una pista: cada tarjeta se re-verifica por la cadena normal al usarla.
  // Filtros: q, tag, lang, capability, accepts, house, price_max, min_score, limit; y `cursor`
  // (el next_cursor de la página anterior). No hay offset: el índice lo rechaza con 400.
  async search(index, { q, tag, lang, capability, accepts, house, price_max, min_score, limit, cursor } = {}) {
    const params = new URLSearchParams(Object.entries({ q, tag, lang, capability, accepts, house, price_max, min_score, limit, cursor }).filter(([, v]) => v != null));
    const base = index.startsWith('http') ? index.replace(/\/$/, '') : (await this.resolver.domainCard(index))._estafeta;
    const res = await this.fetch(`${base}/index/agents?${params}`, { signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status });
    return json;
  }

  // ---------- lectura ----------
  async inbox({ limit = 50 } = {}) { return (await this._call('GET', `/mailbox/${this.local}?limit=${limit}`)).messages; }
  async ack(ids) { return (await this._call('POST', `/mailbox/${this.local}/ack`, { ids: Array.isArray(ids) ? ids : [ids] })).acked; }
  async outbox() { return (await this._call('GET', `/outbox/${this.local}`)).sent; }

  // ---------- conversación y tiempo real ----------
  // El historial vive en la casa, no en la sesión: desde otro dispositivo se retoma igual.
  async conversation(withAddress, { limit = 30, project = null } = {}) {
    const q = new URLSearchParams({ with: String(withAddress), limit: String(limit), ...(project ? { project } : {}) });
    return (await this._call('GET', `/conversations/${this.local}?${q}`)).messages;
  }
  async conversations({ project = null } = {}) { const q = project ? `?${new URLSearchParams({ project })}` : ''; return (await this._call('GET', `/conversations/${this.local}${q}`)).conversations; }
  // Ficha pública: la propia (o la de un delegado propio) se declara; la de cualquiera se lee de su tarjeta.
  setProfile(profile, { of = null } = {}) { const l = of ? parseAddress(of).local : this.local; return this._call('POST', `/agents/${encodeURIComponent(l)}/profile`, { profile }); }
  async profile(address) { this.resolver.invalidate(`agent:${String(address).toLowerCase()}`); const c = await this.resolver.agentCard(address, { onBehalfOf: this.address }); return { address: c.address, profile: c.profile || null, capabilities: c.capabilities || {} }; }
  // «Visto por última vez» de una dirección de una casa (null si el dueño no lo activó).
  async presence(address) {
    const { local, domain } = parseAddress(address);
    const r = await this._callAt(domain, 'GET', `/agents/${encodeURIComponent(local)}/presence`).catch(() => null);
    return r?.last_seen || null;
  }
  // ---------- grupos ----------
  // `g` acepta la dirección completa (g.equipo@casa) o el nombre (equipo). Los miembros son de la casa.
  static _localDeGrupo(g) { const s = String(g || '').toLowerCase(); const l = s.includes('@') ? parseAddress(s).local : s; return l.startsWith('g.') ? l : `g.${l}`; }
  createGroup(name, { members = [], post = 'members' } = {}) { return this._call('POST', '/groups', { name: String(name).replace(/^g\./, ''), members, post }); }
  group(g) { return this._call('GET', `/groups/${encodeURIComponent(Agent._localDeGrupo(g))}/members`); }
  editGroup(g, { add = [], remove = [], admins = [] } = {}) { return this._call('POST', `/groups/${encodeURIComponent(Agent._localDeGrupo(g))}/members`, { add, remove, admins }); }
  leaveGroup(g) { return this.editGroup(g, { remove: [this.address] }); }
  // Espera el próximo sobre pendiente que cumpla el filtro. No sondea desde aquí: la casa responde
  // apenas llega. Devuelve null si se acabó el tiempo sin nada.
  async wait({ from, thread, since, project, seconds = 25 } = {}) {
    const q = new URLSearchParams(Object.entries({ from, thread, since, project, timeout: String(seconds) }).filter(([, v]) => v != null && v !== ''));
    return (await this._call('GET', `/mailbox/${this.local}/wait?${q}`, undefined, { timeoutMs: (Number(seconds) + 15) * 1000 })).message;
  }
  // Quién soy y qué puedo hacer: la tarjeta certificada, resumida.
  async whoami() {
    const c = await this.resolver.agentCard(this.address);
    return { address: c.address, delegated_by: c.delegation?.by || null, valid_until: c.valid_until || null, scope: c.delegation?.scope || null, custody: c.custody || null, inbox: c.inbox || null, encryption: !!c.enc };
  }

  // Verifica la cadena de confianza del remitente y descifra si corresponde.
  async open(envelope) {
    // Correo entrante por el puente (urn:nyx5:ext:email): sin firma, en claro, marcado como NO
    // verificado. No se disfraza de sobre firmado: se abre explícitamente como lo que es.
    const em = envelope.extensions?.['urn:nyx5:ext:email'];
    if (em && !envelope.signature) {
      return { id: envelope.id, from: em.from, to: envelope.to, type: envelope.type, created: envelope.created, verified: false, via: 'email', subject: em.subject || null, content: envelope.content };
    }
    const card = await this.resolver.agentCardForKid(envelope.from, envelope.signature?.kid, { onBehalfOf: this.address });
    const verified = Resolver.acceptedKids(card).includes(envelope.signature?.kid) && verifyObject(envelope, envelope.signature.kid);
    if (!verified) throw new Error(`invalid signature on envelope ${envelope.id} from ${envelope.from}`);
    if (envelope.expires && Date.parse(envelope.expires) < Date.now()) throw new Error(`sobre vencido: ${envelope.id}`);
    // Un sobre a un grupo llega con la dirección del grupo, no la del miembro que lo abre.
    const aGrupo = envelope.to.some((t) => { try { return parseAddress(t).local.startsWith('g.'); } catch { return false; } });
    if (!envelope.encrypted && !aGrupo && !envelope.to.includes(this.address) && envelope.from !== this.address) throw new Error(`envelope ${envelope.id} is not addressed to ${this.address}`);
    const content = envelope.encrypted ? await decryptContent(envelope.encrypted, this.address, this.keys, aad(envelope)) : envelope.content;
    return { id: envelope.id, from: envelope.from, to: envelope.to, type: envelope.type, thread: envelope.thread, in_reply_to: envelope.in_reply_to, created: envelope.created, encrypted: !!envelope.encrypted, project: proyectoDe(envelope), role: rolDe(envelope), sender: card, content };
  }

  // Espera hasta que llegue un sobre que cumpla el filtro (útil para pruebas y flujos síncronos).
  async waitFor(predicate = () => true, { timeoutMs = 10_000, everyMs = 250 } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      for (const m of await this.inbox({ limit: 200 })) if (predicate(m.envelope, m)) return m;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    throw new Error(`timeout esperando sobre en ${this.address}`);
  }
}

// AAD del cifrado: amarra el contenido a id/from/to para que un relay no pueda re-dirigir el sobre.
function aad(env) { return canonical({ id: env.id, from: env.from, to: env.to }); }
function require_dirname(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'; }
