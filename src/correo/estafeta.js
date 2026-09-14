// Nyx5/1 — Estafeta: el servidor de un dominio (equivale al servidor de correo de gmail.com).
// Aloja los dos componentes del sistema: el Correo (sobres, buzones, cola) y el Libro (ledger y
// contratos). El Libro no tiene puerta propia: se opera escribiéndole a libro@<dominio>.
//
// Responsabilidades:
//   - publicar la tarjeta del dominio y certificar las tarjetas de sus agentes
//   - servicio de registro: alta por administrador, por invitación o abierta (con prueba de posesión
//     de la clave), nombres reservados, y un directorio público de los agentes de la casa
//   - recibir sobres de agentes propios (/outbound) y encolarlos: store-and-forward con reintentos
//   - recibir sobres de otras estafetas (/inbound), verificar la cadena de firmas y aplicar política
//   - guardar cada sobre en el buzón del destinatario hasta que el agente lo confirme (ack)
//   - avisar por webhook si el agente registró uno (push); si no, el agente hace poll
//   - entregar a libro@ los sobres de operación del Libro y repartir los recibos resultantes
//   - cobrar estampillas en buzones con política `stamp`
//   - opcionalmente, operar un índice federado de agentes (urn:nyx5:ext:indice)
//
// RUNTIME: esta clase no conoce node:http ni Workers. El transporte vive en src/plataformas/
// (node.js y worker.js) y habla con `handleRequest(rx)`: rx = { method, path, query, headers,
// body, ip } -> { status, body }. El almacenamiento es async (FileStore local, D1Store en el edge).

import { FileStore } from '../nucleo/almacen.js';
import { Resolver, parseAddress } from './resolver.js';
import { validateEnvelope, applyInboxPolicy, applyEmailPolicy, RateLimiter, RateLimiterDurable, proyectoDe, nombreDeProyecto, validarPerfil, usdSinBilletera } from './politica.js';
import { generateSigningKeys, signObject, verifyObject, signBytes, verifyBytes, canonical, uuid, unb64u, sha256hex } from '../nucleo/crypto.js';
import { Libro, MEDIA, LibroError } from '../libro/libro.js';
import { veredicto, pruebasDe, pruebasDisponibles } from '../libro/verifica.js';
import { contratoPublico, ACP } from '../libro/contratos.js';
import { estadoDeCuenta, csvDe, nombreCsv } from '../libro/estado.js';
import { selloPublico } from '../libro/notaria.js';
import { Tareas } from '../libro/tareas.js';
import { datosInforme, datosEmbudo, informeHtml } from '../libro/informe.js';
import { APP_HTML } from '../plataformas/app-html.js';
import { SPEC_HTML, LLMS_TXT } from '../plataformas/spec-html.js';
import { HOME_HTML } from '../plataformas/home-html.js';
import { OG_PNG_B64 } from '../plataformas/og-png.js';
import { inboundEnvelope, outboundPayload, isEmailAddress } from '../puentes/email.js';
import * as x402 from '../puentes/x402.js';
import * as oauth from '../puentes/oauth.js';
import { atenderMcp } from '../puentes/mcp-remoto.js';
import { abrirBoveda } from '../nucleo/boveda.js';
import { ICONOS } from '../plataformas/iconos.js';
import { Agent } from './agente.js';
import { eventoDeCobro } from './cobro.js';
import { atenderAsistentes, PRECIOS, MEDIA_GATE } from './asistente.js';
import { validarFiltros, puntajeDe, precioMinimo, FILTROS } from './indice.js';

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString();
const RETRYABLE = new Set([408, 421, 425, 429, 500, 502, 503, 504]);
// CORS sólo donde lo necesita un cliente MCP que corre en un navegador (el MCP Inspector, por
// ejemplo): descubrimiento, registro, token y /mcp. El resto de la casa sigue siendo mismo-origen.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '600',
};
const rutaCors = (p) => p.startsWith('/.well-known/oauth-') || p === '/oauth/register' || p === '/oauth/token' || p === '/mcp' || oauth.RUTA_INVITACION.test(p);
// La app se instala en la pantalla de inicio: en iPhone es lo que evita que Safari borre la llave
// del usuario a los siete días sin abrirla.
const MANIFIESTO = { name: 'Nyx5', short_name: 'Nyx5', start_url: '/app', scope: '/', display: 'standalone', background_color: '#FFFFFF', theme_color: '#12A594', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] };

// Direcciones por petición en GET /agents/historial?addresses=… (NX-905). El rastreo del índice
// pide lotes de este tamaño y una casa que no tenga la ruta (versión anterior) contesta 404.
export const HISTORIAL_LOTE_MAX = 50;
// Proyectos que la lista de conversaciones devuelve por contacto (14-sep-2026): los de último uso.
export const PROYECTOS_POR_CONTACTO = 20;

export class Estafeta {
  constructor({
    domain, dataDir, store, adminToken,
    port = 4000, host = '127.0.0.1', publicUrl,
    hosts = {}, fetchImpl = globalThis.fetch,
    policy = {}, retry = {}, workerIntervalMs = 1000, libro = {},
    index = {}, email = {}, verifica = {}, eventos = true, tareas = {}, terms = null, remoto = {}, asistente = {},
    extensions = null,
    log = (...a) => console.log(`[estafeta ${domain}]`, ...a),
  }) {
    if (!domain || !adminToken || (!dataDir && !store)) throw new Error('domain, adminToken y (dataDir o store) son obligatorios');
    this.domain = domain.toLowerCase();
    this.port = port; this.host = host;
    this.publicUrl = (publicUrl || `http://${host}:${port}`).replace(/\/$/, '');
    this.authHost = new URL(this.publicUrl).host;
    this.adminToken = adminToken;
    this.fetch = (...a) => fetchImpl(...a); // envuelto: workerd exige fetch con this=globalThis
    // fetch que resuelve la propia casa EN PROCESO. Un Worker no puede pedirse su propia URL
    // pública (522): el agente de un subagente delegado (el conector remoto) habla por aquí con su
    // estafeta, pasando por las mismas rutas, la misma firma y la misma política que cualquiera.
    this.fetchPropio = async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.host !== this.authHost) return this.fetch(url, init);
      const headers = {};
      new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
      let body = null;
      if (init.body != null) { try { body = JSON.parse(init.body); } catch { body = null; } }
      const out = await this.handleRequest({ method: String(init.method || 'GET').toUpperCase(), path: u.pathname, query: u.searchParams, headers, body, ip: 'local' });
      if (out.pending) out.pending.catch(() => {});
      const texto = out.contentType ? String(out.body ?? '') : JSON.stringify(out.body);
      return new Response(out.status === 204 || out.status === 304 ? null : texto, { status: out.status, headers: { 'content-type': out.contentType || 'application/json' } });
    };
    this.log = log;
    // registration: 'admin' (solo la casa inscribe) | 'invite' (código emitido por la casa) | 'open' (cualquiera, con prueba de posesión de clave)
    this.policy = { inbound: 'verified', max_bytes: 1_048_576, rate_per_minute: 120, registration: 'admin', registrations_per_minute: 10, min_name_length: 4, ...policy };
    this.retry = { baseMs: 1000, maxMs: 60_000, giveUpMs: 3 * 24 * 3600 * 1000, ...retry };
    this.workerIntervalMs = workerIntervalMs;
    this.index = { enabled: false, crawlMinutes: 15, maxHouses: 500, ...index };
    // verifica@: el evaluador de referencia. `enabled` lo enciende; `maxPorTick` acota lo que
    // el cron hace en una pasada para no comerse el minuto entero verificando.
    this.verifica = { enabled: true, maxPorTick: 10, timeoutMs: 10_000, ...verifica };
    this.eventos = eventos !== false;
    this._primeros = new Set();   // raíces cuyo `first_message` esta instancia ya vio (ver _primerMensaje)
    this.terms = terms || null;   // HTML de los términos; sin esto, /terms no existe
    // Trabajo sembrado: la casa es el primer comprador. Sin catálogo, apagado.
    this.tareas = new Tareas(tareas);
    // Puente de correo: entrada siempre disponible si la casa la enciende; salida solo si hay proveedor.
    // `email.provider` es una función async(payload) (ver src/puentes/email.js); sin ella, la salida queda pendiente.
    // `senders`: las únicas direcciones que pueden escribirle a una persona por correo. Vacío = cerrado.
    this.email = { footer: email.footer === true, enabled: !!(email.enabled || email.provider), provider: email.provider || null, senders: new Set((email.senders || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)) };
    this.extensions = extensions || [
      'urn:nyx5:ext:mcp', 'urn:nyx5:ext:a2a', 'urn:nyx5:ext:libro',
      ...(this.index.enabled ? ['urn:nyx5:ext:indice'] : []),
      ...(this.email.enabled ? ['urn:nyx5:ext:email'] : []),
    ];
    this.libroOpts = libro;
    this.hostsOverride = hosts;

    this.store = store || new FileStore(dataDir);
    // Límites de tasa durables (NX-901): cuentan en el almacén, así que valen para toda la casa y
    // no por isolate. Un almacén sin contador (uno ajeno, mínimo) cae al de memoria.
    const limitador = (perMinute, ns) => (this.store.kvIncrement ? new RateLimiterDurable({ store: this.store, perMinute, ns, log: (m) => this.log(m) }) : new RateLimiter({ perMinute }));
    this.rate = limitador(this.policy.rate_per_minute, 'tasa');
    this.regRate = limitador(this.policy.registrations_per_minute, 'tasa-alta');
    // Conector MCP remoto (src/puentes/oauth.js + mcp-remoto.js). Existe sólo si la casa lo enciende
    // Y tiene llave de bóveda: sin un lugar cifrado donde guardar la llave de un subagente, no hay
    // conector. La llave de la bóveda no se guarda en `this.remoto`: sólo la bóveda la conoce.
    const { vaultKey, ...remotoSinLlave } = remoto;
    this.boveda = abrirBoveda(vaultKey || null);
    this.remoto = { dias: 30, accesoS: 3600, refrescoMs: 30 * 24 * 3600 * 1000, ...remotoSinLlave, enabled: !!(remoto.enabled && this.boveda) };
    this.remotoRate = limitador(240, 'tasa-remoto');
    // Asistentes (src/correo/asistente.js): existen sólo si la casa tiene una clave de la API de
    // Anthropic. La clave no se guarda aparte: sólo el asistente la usa, al llamar.
    this.asistente = asistente.apiKey ? { apiKey: asistente.apiKey, fetch: (...a) => (asistente.fetchImpl || this.fetch)(...a) } : null;
    this._ready = null;
    this._domainCardCache = null; // { value, until }
    this._pushes = [];            // avisos por webhook en vuelo (los espera flushPushes)
    this._lastCrawl = 0;
  }

  // Inicialización perezosa e idempotente (los adaptadores y cada request la esperan).
  async init() {
    if (!this._ready) this._ready = this._init();
    return this._ready;
  }
  async _init() {
    this.keys = await this._loadOrCreateDomainKeys();
    this.resolver = new Resolver({
      hosts: { [this.domain]: { url: this.publicUrl }, ...this.hostsOverride },
      pins: await this.store.getPins(),
      fetchImpl: this.fetch,
      onPin: (domain, kid) => this.store.putPin(domain, kid),
      // Resolución local de la propia casa: sin esto, verificar a un vendedor de casa exige un
      // fetch del Worker a su propio dominio público, que Cloudflare corta (522) y deja la
      // operación reintentando para siempre.
      self: { domain: this.domain, estafeta: this.publicUrl, domainCard: () => this.domainCard(), agentCard: (local) => this.agentCard(local), firmarPara: (addr, dom) => this._firmarPara(addr, dom) },
    });
    this.libro = new Libro({ domain: this.domain, store: this.store, keys: this.keys, resolver: this.resolver, log: this.log, ...this.libroOpts });
    await this._ensureSystemAgents();
    return this;
  }

  // ---------- identidad del dominio ----------
  async _loadOrCreateDomainKeys() {
    let rec = await this.store.getDomain();
    if (!rec) {
      const k = generateSigningKeys();
      rec = { domain: this.domain, keys: [{ ...k, created: iso() }], created: iso() };
      // Si otro proceso/isolate llegó primero, sus claves mandan (putDomainIfAbsent falla cerrado).
      const won = await (this.store.putDomainIfAbsent ? this.store.putDomainIfAbsent(rec) : (this.store.putDomain(rec), true));
      if (!won) rec = await this.store.getDomain();
    }
    return rec.keys[0];
  }
  async _ensureSystemAgents() {
    // Agentes de sistema, firman con la clave del dominio:
    //   postmaster@ -> avisos de entrega y rebotes    libro@ -> operaciones y recibos del Libro
    if (!await this.store.getAgent('postmaster')) await this.registerAgent({ local: 'postmaster', sig: this.keys.sig, capabilities: { accepts: [] }, inbox: { policy: 'allowlist', allowlist: [] } });
    // La tarjeta de libro@ anuncia las operaciones y el fee: se re-certifica cuando cambian (en
    // producción decía las ops de hace una semana: ni pay, ni reclaim, ni expire).
    const libroRec = await this.store.getAgent('libro');
    const libroCaps = { accepts: [MEDIA.op], libro: { fee_bps: this.libro.feeBps, ops: this.libro.ops } };
    if (!libroRec || canonical(libroRec.capabilities?.libro || {}) !== canonical(libroCaps.libro)) await this.registerAgent({ local: 'libro', sig: this.keys.sig, capabilities: libroCaps, inbox: { policy: 'open' } });
    // verifica@ — el evaluador de referencia de la casa. Pruebas deterministas y nada más: un
    // verificador que se equivoca castiga a un inocente. Su tarjeta declara cuáles puede correr
    // en ESTE runtime (en el edge no hay shell) y se REESCRIBE si eso cambia: al añadir una
    // prueba nueva, la tarjeta vieja seguiría anunciando las de antes para siempre, y un agente
    // que la lee para pactar una verificación creería que no existe.
    if (this.verifica.enabled) {
      const actual = await this.store.getAgent('verifica');
      const declaradas = actual?.capabilities?.verifica?.pruebas || [];
      const reales = pruebasDisponibles();
      if (!actual || declaradas.join(',') !== reales.join(',')) {
        await this.registerAgent({ local: 'verifica', sig: this.keys.sig, capabilities: { accepts: [MEDIA.op], verifica: { pruebas: reales }, listed: true }, inbox: { policy: 'open' } });
        if (actual) this.log(`verifica@: tarjeta actualizada (${declaradas.join(',') || 'ninguna'} -> ${reales.join(',')})`);
      }
    }
    // tareas@ — el mostrador del trabajo sembrado. Existe solo si la casa publicó tareas.
    if (this.tareas.enabled && !await this.store.getAgent('tareas')) {
      await this.registerAgent({ local: 'tareas', sig: this.keys.sig, capabilities: { accepts: [MEDIA.cotizacion], tareas: { por_agente_dia: this.tareas.porAgenteDia }, listed: true }, inbox: { policy: 'open' } });
    }
  }
  // Instrumentación: nombre, fecha, actor y números. Nunca contenido de sobres ni datos del
  // humano. Un fallo al registrar un evento JAMÁS puede voltear la operación que lo produjo:
  // medir es secundario, mover tokens no.
  async _evento(name, actor, data = {}) {
    if (!this.eventos || !this.store.putEvent) return;
    try { await this.store.putEvent({ id: uuid(), name, ts: iso(), actor: actor || null, data }); }
    catch (e) { this.log(`evento ${name} no registrado: ${e.message}`); }
  }
  // La fuente de atribución (`source`) es texto ajeno: se recorta y se sanea antes de entrar a
  // un evento. Una sola definición para el join, la invitación y el enlace abierto.
  static fuenteLimpia(x) { return typeof x === 'string' ? (x.slice(0, 64).replace(/[^\w.:@/-]/g, '') || null) : null; }
  // Embudo (NX-801): `first_message` es la primera vez que una dirección raíz, o su Claude
  // conectado `claude.<raíz>`, le escribe a OTRA dirección (no a sí misma, no a libro@). Se
  // recuerda en el almacén por raíz (ns `primer_mensaje`, sin vencimiento) y en memoria por
  // instancia: cuesta a lo sumo una escritura condicional por raíz, nunca una lectura de todos
  // los eventos por sobre. Otros delegados no cuentan: un asistente que contesta solo no es el
  // humano escribiendo. Un fallo aquí jamás detiene el envío.
  async _primerMensaje(submitter, env) {
    if (!this.eventos || !this.store.kvPutIfAbsent) return;
    let raiz = submitter.address, via = 'root';
    const del = submitter.record.delegation;
    if (del) {
      const padre = parseAddress(del.by);
      if (padre.domain !== this.domain || submitter.local !== `claude.${padre.local}`) return;
      raiz = del.by; via = 'claude';
    }
    if (this._primeros.has(raiz)) return;
    const propias = new Set([env.from, raiz]);
    if (!env.to.some((t) => !propias.has(t) && !String(t).startsWith('libro@'))) return;
    try {
      if (await this.store.kvPutIfAbsent('primer_mensaje', raiz, { ts: iso(), via })) await this._evento('first_message', raiz, { via });
      this._primeros.add(raiz);
    } catch (e) { this.log(`first_message ${raiz} no registrado: ${e.message}`); }
  }
  // `eventoDeCobro` copia campo por campo: aunque el remitente meta `amount` en la extensión, no entra.
  async _eventoDeCobro(env, local) {
    const ev = eventoDeCobro(env);
    if (ev) await this._evento(ev.name, env.from, { ...ev.data, to: `${local}@${this.domain}` });
  }
  isSystem(local) { return ['postmaster', 'libro', 'verifica', 'tareas'].includes(local); }
  // ¿Podría alguien registrarse HOY con este nombre? Mismas reglas que registerAgent, sin registrar nada.
  async nombreDisponible(local) {
    if (!local || Estafeta.RESERVED.has(local) || local.length < (this.policy.min_name_length || 0)) return false;
    return !(await this.store.getAgent(local));
  }
  // `qa` es de la casa (NX-606): sólo un asistente de sistema puede vivir ahí, nunca un registro.
  static RESERVED = new Set(['postmaster', 'libro', 'verifica', 'tareas', 'casa', 'admin', 'root', 'abuse', 'security', 'hostmaster', 'noreply', 'no-reply', 'support', 'estafeta', 'nyx5', 'indice', 'historial', 'qa']);

  // ---------- servicio de registro ----------
  // Invitaciones: la casa emite códigos con usos y vencimiento; un agente los presenta al inscribirse.
  async createInvite({ uses = 1, expires = null, note = null, welcome = null } = {}) {
    const inv = { code: uuid().replace(/-/g, '').slice(0, 20), uses, used: 0, expires, note, welcome, created: iso(), by: 'admin' };
    await this.store.putInvite(inv);
    return inv;
  }
  // El consumo es atómico: leer-comprobar-escribir dejaba que un solo código de un uso sirviera
  // N veces en paralelo, multiplicando el regalo de bienvenida (emisión no autorizada).
  async _consumeInvite(code) {
    const inv = code && await this.store.getInvite(String(code));
    if (!inv) throw Object.assign(new Error('no such invitation'), { status: 403 });
    if (inv.expires && Date.parse(inv.expires) < now()) throw Object.assign(new Error('invitation expired'), { status: 403 });
    const usada = await this.store.consumeInvite(String(code), iso());
    if (!usada) throw Object.assign(new Error('invitation used up'), { status: 403 });
    return usada;
  }
  // Directorio público de la casa: tarjetas sin datos privados, con filtros por capacidad.
  async directory({ capability, accepts, q, limit = 50, offset = 0 } = {}) {
    limit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
    offset = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const locals = (await this.store.listAgents()).sort();
    const cards = [];
    for (const l of locals) { const c = await this.agentCard(l); if (c) cards.push(c); }
    // Opt-in: nadie aparece en el directorio (ni, por lo tanto, en el índice federado que lo rastrea)
    // sin haberlo pedido con `capabilities.listed: true`. El default es no figurar. El lookup directo
    // por dirección (`/agents/:local`) sigue disponible: no listar no es esconder a quien ya te conoce.
    let out = cards.filter((c) => c.visibility !== 'secret' && (c.visibility === 'public' || c.capabilities?.listed === true));
    if (capability) out = out.filter((c) => c.capabilities?.[capability]);
    if (accepts) out = out.filter((c) => c.capabilities?.accepts?.includes(accepts));
    if (q) { const needle = String(q).toLowerCase(); out = out.filter((c) => c.address.includes(needle) || JSON.stringify(c.capabilities).toLowerCase().includes(needle)); }
    return { total: out.length, offset, agents: out.slice(offset, offset + limit).map(({ delegation, ...c }) => ({ ...c, delegated_by: delegation?.by })) };
  }
  async domainCard() {
    // La tarjeta se firma UNA vez y se guarda con el dominio. Antes se firmaba por instancia del
    // servidor: en el edge, donde hay muchas instancias vivas a la vez, cada una servía un
    // documento distinto (otro `issued`, otra firma) para el mismo contenido. Eso hacía que
    // `issued` no significara nada, impedía cachear la tarjeta en el borde y gastaba una firma
    // Ed25519 por arranque. Ahora solo se re-firma cuando el CONTENIDO cambia: claves, política
    // o extensiones. Dos casas con el mismo estado sirven byte a byte lo mismo.
    if (this._domainCardCache && this._domainCardCache.until > now()) return this._domainCardCache.value;
    const rec = await this.store.getDomain();
    const cuerpo = {
      nyx5: '1', domain: this.domain, estafeta: this.publicUrl,
      keys: rec.keys.map((k) => ({ sig: k.sig, created: k.created })),
      policy: { inbound: this.policy.inbound, max_bytes: this.policy.max_bytes, registration: this.policy.registration, ...(this.policy.outbound ? { outbound: this.policy.outbound } : {}) },
      extensions: this.extensions,
    };
    const guardada = rec.card;
    // Se compara el contenido SIN issued ni signature: si es el mismo, la tarjeta guardada vale.
    if (guardada) {
      const { issued: _i, signature: _s, ...previo } = guardada;
      if (canonical(previo) === canonical(cuerpo)) {
        this._domainCardCache = { value: guardada, until: now() + 300_000 };
        return guardada;
      }
    }
    const card = signObject({ ...cuerpo, issued: iso() }, this.keys);
    // Persistir puede fallar (D1 caído, permisos): la tarjeta se sirve igual, solo que sin la
    // estabilidad. Firmar y no poder guardar es peor que no firmar.
    try { await this.store.putDomain({ ...rec, card }); }
    catch (e) { this.log(`no se pudo guardar la tarjeta del dominio: ${e.message}`); }
    this._domainCardCache = { value: card, until: now() + 300_000 };
    return card;
  }

  // ---------- agentes ----------
  static VISIBILIDADES = ['public', 'private', 'secret'];
  // `system`: una dirección de sistema con llaves propias (un asistente de la casa, NX-606). Sólo
  // la pone `_adminAsistente` (ruta de la casa): salta la lista de reservados y el largo mínimo,
  // como verifica@ y tareas@, y no recibe regalo de bienvenida.
  async registerAgent({ local, sig, enc = null, capabilities = {}, inbox = { policy: 'open' }, wallet = null, wallets = null, webhook = null, notify_email = null, valid_until = null, delegation = null, welcome = null, custody = null, group = null, profile = undefined, visibility = undefined, system = false }) {
    // Visibilidad (NX-202): public = en el directorio; private = existe, lo encuentra quien sabe la
    // dirección (lo de siempre; es el defecto); secret = a quien no está en su lista se le responde
    // exactamente lo que a un nombre inexistente. Se conserva entre re-certificaciones.
    if (visibility !== undefined && visibility !== null && !Estafeta.VISIBILIDADES.includes(visibility)) throw Object.assign(new Error(`visibility must be one of ${Estafeta.VISIBILIDADES.join(', ')}`), { status: 400 });
    // La ficha viaja validada o no viaja: una clave ajena o un link que no es https la rechazan.
    let perfil;
    if (profile !== undefined) { const v = validarPerfil(profile); if (v.error) throw Object.assign(new Error(v.error), { status: 400 }); perfil = v.perfil ? { ...v.perfil, updated: iso() } : null; }
    // Grupos (13-sep-2026): g.<nombre> es una dirección de grupo. La firma la casa, no tiene llave
    // de cifrado (los miembros publican las suyas) y sólo nace por crearGrupo. Nadie registra un
    // nombre g.* por la puerta normal, así que un grupo nunca puede ser suplantado por un agente.
    if (String(local).startsWith('g.') && !group) throw Object.assign(new Error('names starting with g. are groups: create one with POST /groups'), { status: 409 });
    if (group && !String(local).startsWith('g.')) throw Object.assign(new Error('a group name starts with g.'), { status: 400 });
    local = String(local).toLowerCase();
    const address = `${local}@${this.domain}`;
    parseAddress(address);
    if (Estafeta.RESERVED.has(local) && !this.isSystem(local) && !system) throw Object.assign(new Error(`name reserved by the protocol: ${local}`), { status: 409 });
    // Nombres de 1 a 3 caracteres: reservados en una casa de registro abierto. Son lo primero
    // que alguien acapara para revender o para suplantar (a@casa se confunde con cualquiera), y
    // un agente que llega no necesita un nombre corto: necesita uno suyo. Los de sistema pasan.
    if (local.length <= this.policy.min_name_length - 1 && !this.isSystem(local) && !delegation && !system) {
      throw Object.assign(new Error(`names shorter than ${this.policy.min_name_length} characters are reserved in this house`), { status: 409 });
    }
    if (delegation) {
      // Tarjeta delegada: el agente padre firma { by, address, sig, scope, valid_until }; el dominio la certifica igual.
      const { local: parentLocal, domain: parentDomain } = parseAddress(delegation.by);
      if (parentDomain !== this.domain || !local.endsWith(`.${parentLocal}`)) throw Object.assign(new Error(`a subagent of ${delegation.by} must be named <name>.${parentLocal}@${this.domain}`), { status: 400 });
      const parent = await this.store.getAgent(parentLocal);
      if (!parent) throw Object.assign(new Error('agente padre inexistente'), { status: 404 });
      if (delegation.address !== address || delegation.sig !== sig || !verifyObject(delegation, parent.sig)) throw Object.assign(new Error('invalid delegation: it must be signed by the parent and match the card'), { status: 403 });
      // Un delegado nunca tiene más ámbito que su padre (invariante 6). Lo que el hijo no declara
      // lo HEREDA: declarar menos no puede ser una forma de escapar del tope de la cadena.
      const ps = parent.delegation?.scope;
      if (ps) {
        const hs = delegation.scope || {};
        if (ps.cap != null && (hs.cap == null || hs.cap > ps.cap)) {
          if (hs.cap != null) throw Object.assign(new Error(`a subagent cannot have a higher cap than its parent (${ps.cap})`), { status: 403 });
          hs.cap = ps.cap; // sin tope declarado: hereda el del padre
        }
        for (const campo of ['types', 'to_domains']) {
          if (ps[campo]?.length) {
            if (!hs[campo]?.length) hs[campo] = [...ps[campo]];
            else if (!hs[campo].every((x) => ps[campo].includes(x))) throw Object.assign(new Error(`a subagent cannot widen ${campo} beyond its parent`), { status: 403 });
          }
        }
        // Sólo-mensajes no se hereda reescribiendo la delegación (quedaría con una firma que ya no
        // cubre lo que dice): se exige. Un hijo de un subagente de sólo mensajes, también lo es.
        if (ps.messages_only && hs.messages_only !== true) throw Object.assign(new Error('a subagent of a messages-only address must itself be messages-only'), { status: 403 });
        delegation = { ...delegation, scope: hs };
      }
      valid_until = valid_until || delegation.valid_until || null;
    }
    const prev = await this.store.getAgent(local);
    // `<algo>.<agente existente>` es la forma de un subagente: sin la delegación de ese agente no se
    // registra (revisión del 13-sep: `evil.alicia` parecía delegado de alicia sin serlo).
    if (!prev && !delegation && !group && local.includes('.')) {
      const padre = local.slice(local.indexOf('.') + 1);
      if (await this.store.getAgent(padre)) throw Object.assign(new Error(`names of the form <name>.${padre} are subagents of ${padre}@${this.domain}: they need its delegation`), { status: 409 });
    }
    const previous = [];
    // Una llave revocada no vuelve por la ventana de gracia: si su dueño la revocó fue porque no
    // debía seguir firmando, y los siete días de `previous` la resucitarían.
    if (prev && prev.sig !== sig && !prev.revoked) previous.push({ sig: prev.sig, until: iso(now() + 7 * 24 * 3600 * 1000) }, ...(prev.previous || []));
    // La billetera es PÚBLICA y va en la tarjeta: es sólo la dirección a la que se le cobra. La
    // casa no la controla ni puede mover nada de ella, igual que no controla la llave del agente.
    let billeteras; try { billeteras = x402.validarBilleteras(wallets ?? wallet ?? prev?.wallets ?? prev?.wallet ?? null); }
    catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    // Un servicio con precio en dólares sin billetera a la que cobrarlo es una promesa gratis (NX-301).
    { const e = usdSinBilletera(profile === undefined ? prev?.profile : perfil, billeteras); if (e) throw Object.assign(new Error(e), { status: 400 }); }
    const card = signObject({
      nyx5: '1', address, sig, enc,
      capabilities: { accepts: ['text/plain', 'application/json'], ...capabilities },
      inbox: { policy: 'open', ...inbox },
      ...(billeteras ? { wallets: billeteras } : {}),
      valid_from: iso(), valid_until, previous: previous.slice(0, 3),
      delegation: delegation || undefined,
      group: group || undefined,
      // La ficha se conserva entre re-certificaciones salvo que esta llamada la traiga (o la borre con null).
      profile: profile === undefined ? (prev?.profile || undefined) : (perfil || undefined),
      visibility: visibility === undefined ? (prev?.visibility || undefined) : (visibility || undefined),
      // Quién guarda las llaves de esta dirección. Sólo lo pone la casa (el conector remoto) y se
      // publica: quien le escribe a una dirección cuya llave guarda la casa tiene derecho a saber
      // que la casa puede leer lo que le llega. Se conserva mientras la llave no cambie.
      custody: custody || (prev && prev.sig === sig ? prev.custody : undefined) || undefined,
    }, this.keys, 'certification');
    // Alta atómica cuando el nombre es nuevo: dos altas concurrentes del mismo nombre no pueden
    // pisarse la clave (el perdedor cree tener el nombre y su correo iría al otro), ni cobrar el
    // regalo de bienvenida dos veces por la misma dirección.
    let creado = true;
    if (!prev) {
      creado = await (this.store.putAgentIfAbsent
        ? this.store.putAgentIfAbsent(local, { ...card, webhook, notify_email })
        : (this.store.putAgent(local, { ...card, webhook, notify_email }), true));
      if (!creado) throw Object.assign(new Error('that name was just taken; only its owner or the house can update it'), { status: 409 });
    } else {
      await this.store.putAgent(local, { ...card, webhook, notify_email });
    }
    const gift = welcome ?? this.libro.welcome;
    if (creado && !prev && !this.isSystem(local) && !delegation && !group && !system && gift > 0) await this.libro.topup(address, gift, 'regalo de bienvenida', { agent: address });
    return card;
  }

  // ---------- acuse de lectura y presencia (13-sep-2026), los dos opt-in en la tarjeta ----------
  async _acusesDeLectura(who, ids) {
    const historial = await this.store.listMailHistory(who.local, { limit: 1000 });
    for (const id of ids) {
      const m = historial.find((x) => x.envelope?.id === id);
      const e = m?.envelope;
      if (!e || e.type === 'receipt') continue;
      let fromLocal = ''; try { fromLocal = parseAddress(e.from).local; } catch { continue; }
      if (e.from === who.address || this.isSystem(fromLocal)) continue;
      await this._systemSend('postmaster', [e.from], { type: 'receipt', in_reply_to: e.id, thread: e.thread || e.id, content: { media: 'application/nyx5.recibo+json', body: { read_of: e.id, read_by: who.address, read_at: iso() } } });
    }
  }
  // Presencia: «visto por última vez», redondeado a la hora, sólo si la tarjeta declara presence:true.
  // Un dato por hora y por dirección, en memoria por isolate: cuesta una escritura por hora, no una
  // por petición. Sin opt-in no se anota nada: presencia sin consentimiento sería vigilancia.
  _presencia = new Map();
  async _anotarPresencia(who) {
    if (who.record?.capabilities?.presence !== true) return;
    const hora = iso().slice(0, 13) + ':00:00.000Z';
    if (this._presencia.get(who.local) === hora) return;
    this._presencia.set(who.local, hora);
    await this.store.kvPut('presencia', who.local, { last_seen: hora }, now() + 90 * 86_400_000);
  }
  async presenciaDe(local) {
    const rec = await this.store.getAgent(local);
    if (!rec || rec.revoked || rec.capabilities?.presence !== true) return null;
    return (await this.store.kvGet('presencia', local))?.last_seen || null;
  }

  // ---------- grupos: una dirección que reparte el mismo sobre a cada miembro ----------
  // Nació el 13-sep-2026 del pedido de Nicholas de conversar de a varios (una sala de proyecto con
  // su Claude, el de Basti y el agente de Sigo). Primera versión: miembros de esta casa. Un sobre
  // firmado lleva la dirección del grupo, y otra casa no sabría a quién entregarlo sin reescribirlo.
  static NOMBRE_GRUPO = /^[a-z0-9][a-z0-9._-]{2,40}$/;
  static MAX_MIEMBROS = 50;
  // ¿El buzón de `rec` acepta un mensaje normal de `de`? Sólo abierto o lista blanca cuentan: una
  // estampilla o una prueba de trabajo no se pagan por cada miembro, y un `intro` o un aval no abren
  // un grupo. Es la regla de consentimiento de los grupos (revisión adversarial del 13-sep-2026: sin
  // ella, cualquiera metía a cualquiera en un grupo y le saltaba la lista blanca, incluso al
  // asistente de Sigo, gastándole presupuesto).
  _aceptaDe(rec, de) {
    const inbox = rec?.inbox || { policy: 'open' };
    if (inbox.policy === 'open') return true;
    if (inbox.policy !== 'allowlist') return false;
    let dominio = ''; try { dominio = parseAddress(de).domain; } catch { return false; }
    return (inbox.allowlist || []).some((x) => x === de || x === dominio);
  }
  // `nuevos` son los que entran ahora: cada uno tiene que aceptar ya a quien lo agrega.
  async _miembrosValidos(direcciones, { agregadoPor = null, nuevos = null } = {}) {
    const lista = [];
    for (const raw of direcciones) {
      const dir = String(raw || '').toLowerCase();
      let p; try { p = parseAddress(dir); } catch { return { error: `not an address: ${dir}` }; }
      if (p.domain !== this.domain) return { error: `${dir} is not in this house: groups hold members of ${this.domain} only, for now` };
      const rec = await this.store.getAgent(p.local);
      if (!rec || rec.revoked || (agregadoPor && !await this._visibleA(rec, agregadoPor))) return { error: `${dir} does not exist or is revoked` };
      if (rec.group || this.isSystem(p.local)) return { error: `${dir} cannot be a member (it is a group or a system address)` };
      if (agregadoPor && dir !== agregadoPor && (!nuevos || nuevos.has(dir)) && !this._aceptaDe(rec, agregadoPor)) return { error: `${dir} does not accept messages from you: only someone who already lists you as a contact can be added to a group` };
      if (!lista.includes(dir)) lista.push(dir);
    }
    if (lista.length > Estafeta.MAX_MIEMBROS) return { error: `a group holds at most ${Estafeta.MAX_MIEMBROS} members` };
    return { lista };
  }
  _tarjetaDeGrupo(local, group) {
    return this.registerAgent({
      local, sig: this.keys.sig, group,
      capabilities: { accepts: ['text/plain', 'application/json'], group: true },
      // Sólo quien puede publicar entra al buzón: la política del buzón es la primera puerta y el
      // reparto vuelve a comprobarlo (un `intro` o un aval no abren un grupo).
      inbox: { policy: 'allowlist', allowlist: group.post === 'admins' ? group.admins : group.members },
    });
  }
  async crearGrupo(who, b) {
    const nombre = String(b.name || '').toLowerCase();
    if (!Estafeta.NOMBRE_GRUPO.test(nombre)) return { status: 400, body: { reason: 'a group name has 3 to 41 characters: letters, digits, . _ -' } };
    const local = `g.${nombre}`;
    if (await this.store.getAgent(local)) return { status: 409, body: { reason: `${local}@${this.domain} already exists` } };
    if (!await this.remotoRate.allow(`grupo:${who.address}`)) return { status: 429, body: { reason: 'too many groups; try again in a minute' }, headers: this._retryAfter() };
    const v = await this._miembrosValidos([who.address, ...(Array.isArray(b.members) ? b.members : [])], { agregadoPor: who.address });
    if (v.error) return { status: 400, body: { reason: v.error } };
    const group = { admins: [who.address], members: v.lista, post: b.post === 'admins' ? 'admins' : 'members', max: Estafeta.MAX_MIEMBROS, created: iso() };
    const card = await this._tarjetaDeGrupo(local, group);
    await this._evento('group_created', who.address, { group: card.address, members: group.members.length });
    return { status: 201, body: { address: card.address, group } };
  }
  async miembrosGrupo(who, local) {
    const rec = await this.store.getAgent(local);
    if (!rec?.group || rec.revoked) return { status: 404, body: { reason: 'no such group' } };
    if (!rec.group.members.includes(who.address)) return { status: 403, body: { reason: 'only members see who is in a group' } };
    return { status: 200, body: { address: `${local}@${this.domain}`, group: rec.group } };
  }
  async editarGrupo(who, local, b) {
    const rec = await this.store.getAgent(local);
    if (!rec?.group || rec.revoked) return { status: 404, body: { reason: 'no such group' } };
    const g = rec.group;
    const admin = g.admins.includes(who.address);
    const add = Array.isArray(b.add) ? b.add.map((x) => String(x).toLowerCase()) : [];
    const remove = Array.isArray(b.remove) ? b.remove.map((x) => String(x).toLowerCase()) : [];
    const admins = Array.isArray(b.admins) ? b.admins.map((x) => String(x).toLowerCase()) : [];
    // Un miembro sólo puede irse; agregar, quitar a otros y nombrar admins es de los admins.
    if (!admin && (add.length || admins.length || remove.some((x) => x !== who.address))) return { status: 403, body: { reason: 'only an admin changes the members of a group; a member can only leave' } };
    if (!admin && !g.members.includes(who.address)) return { status: 403, body: { reason: 'not a member of this group' } };
    const v = await this._miembrosValidos([...g.members.filter((m) => !remove.includes(m)), ...add], { agregadoPor: who.address, nuevos: new Set(add.filter((a) => !g.members.includes(a))) });
    if (v.error) return { status: 400, body: { reason: v.error } };
    const nuevosAdmins = [...new Set([...g.admins.filter((a) => v.lista.includes(a)), ...admins.filter((a) => v.lista.includes(a))])];
    if (!nuevosAdmins.length) return { status: 409, body: { reason: 'a group needs at least one admin: name another admin before leaving' } };
    const group = { ...g, members: v.lista, admins: nuevosAdmins, updated: iso() };
    const card = await this._tarjetaDeGrupo(local, group);
    await this._evento('group_changed', who.address, { group: card.address, members: group.members.length });
    return { status: 200, body: { address: card.address, group } };
  }
  // El nombre local viaja como clave al almacenamiento: se valida SIEMPRE aquí, no se confía en
  // que el store lo sanee. Sin esto, `GET /agents/..%2Fdomain` leía el archivo del dominio y
  // devolvía la clave PRIVADA de la casa (compromiso total).
  _retryAfter() { return { 'retry-after': String(this.rate.retryAfter()) }; }

  // ---------- visibilidad (NX-202): a quién se le confirma que un agente secreto existe ----------
  // Lo ve: él mismo, quien lo delegó, sus propios delegados, y quien está en su lista (dirección o
  // dominio). Nadie más: ni autenticado, ni la app, ni otra casa que no diga para quién pregunta.
  // «Sus delegados» se comprueba leyendo la tarjeta del que pregunta: el sufijo del nombre no basta
  // (revisión del 13-sep: `evil.alicia` registrado por un extraño veía a alicia).
  async _visibleA(rec, quien) {
    if (!rec || rec.visibility !== 'secret') return true;
    if (!quien) return false;
    quien = String(quien).toLowerCase();
    if (quien === rec.address || quien === rec.delegation?.by) return true;
    let q; try { q = parseAddress(quien); } catch { q = null; }
    if (q && q.domain === this.domain) {
      const del = await this.store.getAgent(q.local);
      if (del && !del.revoked && del.delegation?.by === rec.address) return true;
    }
    const dominio = q ? q.domain : (quien.includes('@') ? quien.slice(quien.lastIndexOf('@') + 1) : '');
    return (rec.inbox?.allowlist || []).some((x) => String(x).toLowerCase() === quien || String(x).toLowerCase() === dominio);
  }
  // Si el que selló (NX-601) puede nombrarse en público: uno de esta casa se consulta en vivo
  // (su visibilidad puede haber cambiado); uno de otra casa, por lo que se supo al sellar.
  async _declaranteVisible(doc) {
    let p; try { p = parseAddress(doc.by); } catch { return false; }
    if (p.domain !== this.domain) return !doc.secret;
    return this._visibleA(await this.store.getAgent(p.local), null);
  }
  // Quién pregunta por una tarjeta: un agente de esta casa autenticado, o una casa ajena que firma
  // «lo pido para bob@su-casa» con su llave de dominio. Se evalúa SIEMPRE, exista o no lo que se
  // pide, y antes de tocar el almacén (revisión del 13-sep: evaluarlo sólo cuando había tarjeta
  // convertía un 401, o la latencia del fetch a la otra casa, en un oráculo de existencia). Un
  // token inválido cuenta como nadie, no como error. Una petición que trae credencial cuesta (una
  // firma o una tarjeta de dominio ajena): se limita por IP igual que /resolve.
  async _quienPregunta(rx, path) {
    const auth = rx.headers.authorization?.startsWith('Nyx5 ');
    const h = rx.headers['x-nyx5-for'];
    if (!auth && !h) return null;
    if (!await this.rate.allow(`resolve:${rx.ip || 'x'}`)) throw Object.assign(new Error('too many requests'), { status: 429, headers: this._retryAfter() });
    if (auth) { try { return (await this._authenticate(rx, path)).address; } catch { return null; } }
    const r = Object.fromEntries(String(h).replace(/^nyx51\s*/, '').split(';').map((p) => p.trim().split('=').map((x) => x.trim())).filter((p) => p[0]));
    try {
      const { domain } = parseAddress(r.for || '');
      if (domain !== r.domain || domain === this.domain) return null;
      if (Math.abs(now() - Date.parse(r.ts || 0)) > 300_000) return null;
      const dc = await this.resolver.domainCard(domain);
      if (!dc.keys.some((k) => k.sig === r.kid)) return null;
      return verifyBytes(`for:${r.for}:${this.domain}:${r.ts}`, r.sig, r.kid) ? String(r.for).toLowerCase() : null;
    } catch { return null; }
  }
  _firmarPara(addr, dom) {
    const ts = iso();
    return `nyx51 domain=${this.domain}; for=${addr}; ts=${ts}; kid=${this.keys.sig}; sig=${signBytes(`for:${addr}:${dom}:${ts}`, this.keys)}`;
  }
  static LOCAL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  static validLocal(local) { return typeof local === 'string' && Estafeta.LOCAL.test(local); }
  async agentCard(local) {
    if (!Estafeta.validLocal(local)) return null;
    const rec = await this.store.getAgent(local);
    if (!rec) return null;
    const { webhook, notify_email, ...card } = rec;
    return card;
  }

  // ---------- conector remoto: la bóveda y el agente en proceso ----------
  async llavesDeBoveda(local) {
    if (!this.boveda || !this.store.kvGet) return null;
    const v = await this.store.kvGet('boveda', local);
    if (!v) return null;
    try { return this.boveda.abrir(v.sellado, local); }
    catch (e) { this.log(`bóveda: no abre la llave de ${local}: ${e.message}`); return null; }
  }
  // El agente de un subagente delegado, armado en este proceso con la llave de la bóveda. Firma y
  // pasa por /outbound como cualquiera: no hay atajo que se salte la política ni el alcance.
  async agenteDeBoveda(local) {
    await this.init();
    const keys = await this.llavesDeBoveda(local);
    if (!keys) return null;
    return new Agent({ address: `${local}@${this.domain}`, keys, estafeta: this.publicUrl, resolver: this.resolver, fetchImpl: this.fetchPropio });
  }

  // ---------- tiempo real e historial ----------
  // Espera el primer sobre PENDIENTE que cumpla el filtro, preguntando cada segundo. Pendiente y no
  // "nuevo": si la respuesta llegó entre que uno mandó y empezó a esperar, se entrega igual.
  async esperarCorreo(local, { from = null, thread = null, since = null, project = null, timeoutMs = 25_000, everyMs = 1000 } = {}) {
    const hasta = now() + Math.max(0, timeoutMs);
    const cumple = (m) => {
      const e = m.envelope || {};
      const de = e.extensions?.['urn:nyx5:ext:email']?.from || e.from;
      return (!from || de === from) && (!thread || e.thread === thread || e.id === thread) && (!project || proyectoDe(e) === project);
    };
    for (;;) {
      const lista = this.store.listMailSince ? await this.store.listMailSince(local, since) : (await this.store.listMail(local)).filter((m) => !since || String(m.received) > since);
      const m = lista.find(cumple);
      if (m) return m;
      if (now() >= hasta) return null;
      await new Promise((r) => setTimeout(r, Math.min(everyMs, Math.max(1, hasta - now()))));
    }
  }
  // La conversación con una dirección (o, sin dirección, la lista de conversaciones): lo recibido,
  // incluido lo confirmado, y lo enviado, que ahora queda en la bandeja con su sobre.
  async conversacion(local, { con = null, limit = 50, project = null } = {}) {
    const propia = `${local}@${this.domain}`;
    const delProyecto = (x) => !project || proyectoDe(x.envelope) === project;
    const recibidos = (await this.store.listMailHistory(local, { limit: 1000 })).map((m) => ({ id: m.envelope.id, dir: 'in', at: m.received, acked: !!m.acked, envelope: m.envelope }));
    const enviados = [];
    const vistos = new Set();
    for (const e of await this.store.listOutbox(local)) {
      if (!e.envelope || vistos.has(e.envelope.id)) continue;
      vistos.add(e.envelope.id);
      // Lo que uno se manda a sí mismo (un recordatorio) ya aparece como recibido: una sola vez.
      if (e.envelope.to.includes(propia)) continue;
      enviados.push({ id: e.envelope.id, dir: 'out', at: e.envelope.created, status: e.status, envelope: e.envelope });
    }
    // Lo enviado sabe si fue leído: el acuse de lectura llegó como recibo de postmaster@ con read_of.
    // Sólo vale si lo firmó el postmaster de la casa de quien leyó (revisión del 13-sep-2026: antes
    // cualquier sobre `receipt` con read_of marcaba leído lo que fuera) y si ese lector era
    // destinatario del sobre, o miembro de su casa cuando el sobre iba a un grupo.
    const leidos = new Map();
    for (const r of recibidos) {
      const b = r.envelope?.content?.body;
      if (r.envelope?.type !== 'receipt' || typeof b?.read_of !== 'string' || typeof b?.read_by !== 'string') continue;
      let lector; try { lector = parseAddress(b.read_by); } catch { continue; }
      if (r.envelope.from !== `postmaster@${lector.domain}`) continue;
      leidos.set(b.read_of, { by: b.read_by, at: b.read_at });
    }
    for (const e of enviados) {
      const l = leidos.get(e.id); if (!l) continue;
      const destinos = e.envelope.to.map((t) => String(t).toLowerCase());
      const lectorDom = parseAddress(l.by).domain;
      if (destinos.includes(l.by) || destinos.some((t) => t.startsWith('g.') && parseAddress(t).domain === lectorDom)) e.read = l;
    }
    const todos = [...recibidos, ...enviados].filter(delProyecto);
    // Un mensaje de grupo se conversa con el GRUPO, no con quien lo escribió.
    const grupo = (x) => x.envelope.to.find((t) => { try { const p = parseAddress(t); return p.domain === this.domain && p.local.startsWith('g.'); } catch { return false; } });
    const contraparte = (x) => grupo(x) || (x.dir === 'in' ? (x.envelope.extensions?.['urn:nyx5:ext:email']?.from || x.envelope.from) : (x.envelope.to.find((t) => t !== propia) || x.envelope.to[0]));
    const orden = (a, b) => String(a.at).localeCompare(String(b.at));
    if (con) return todos.filter((x) => contraparte(x) === con || (x.dir === 'out' && x.envelope.to.includes(con))).sort(orden).slice(-limit);
    // La lista trae, por contacto, los proyectos vistos (14-sep-2026, decisión de Nicholas): la app
    // filtra por proyecto sin leer cada hilo. Sale de la MISMA pasada, no de otra consulta: el
    // proyecto real es `proyectoDe` (NFKC, sin invisibles, minúsculas), que SQLite no sabe calcular
    // (su `lower()` es sólo ASCII y no hay NFKC), y el contacto tampoco es una columna (grupo,
    // pasarela de correo o primer destinatario). Con `?project=` todo se calcula sobre ese proyecto.
    const mapa = new Map();
    for (const x of todos) {
      const c = contraparte(x);
      const r = mapa.get(c) || { with: c, count: 0, pending: 0, last_at: '', last_dir: null, last_id: null, proyectos: new Map(), pendientes: new Map() };
      r.count++;
      const pendiente = x.dir === 'in' && !x.acked;
      if (pendiente) r.pending++;
      if (String(x.at) > r.last_at) { r.last_at = String(x.at); r.last_dir = x.dir; r.last_id = x.id; }
      const p = proyectoDe(x.envelope);
      if (p) {
        // Sin proyecto no hay entrada: no se inventa un «(none)».
        if (String(x.at) > (r.proyectos.get(p) || '')) r.proyectos.set(p, String(x.at));
        if (pendiente) r.pendientes.set(p, (r.pendientes.get(p) || 0) + 1);
      }
      mapa.set(c, r);
    }
    return [...mapa.values()].sort((a, b) => b.last_at.localeCompare(a.last_at)).map(({ proyectos, pendientes, ...r }) => {
      // Por último uso, a lo sumo 20: un contacto que etiquetó 10.000 proyectos distintos no
      // devuelve 10.000 nombres; `pending_by_project` sólo cuando hay algo pendiente.
      r.projects = [...proyectos.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, PROYECTOS_POR_CONTACTO).map(([p]) => p);
      if (pendientes.size) r.pending_by_project = Object.fromEntries(pendientes);
      return r;
    });
  }
  // Los subagentes que un dueño delegó (sus Claude conectados), con lo necesario para revocarlos.
  async delegados(local) {
    const padre = `${local}@${this.domain}`;
    const out = [];
    for (const l of await this.store.listAgents()) {
      if (!l.endsWith(`.${local}`)) continue;
      const r = await this.store.getAgent(l);
      if (r?.delegation?.by !== padre) continue;
      out.push({ address: r.address, sig: r.sig, enc: r.enc || null, since: r.valid_from || null, valid_until: r.valid_until || null, revoked: r.revoked || null, custody: r.custody || null, scope: r.delegation.scope || null, inbox: r.inbox || null });
    }
    return out;
  }
  // Revocar es definitivo para esa llave: la tarjeta vence ahora (el resolver deja de aceptarla),
  // la llave sale de la bóveda y ningún token vuelve a servir, porque cada uno se valida contra esto.
  async revocarDelegado(subLocal, por) {
    const rec = await this.store.getAgent(subLocal);
    if (!rec?.delegation) throw Object.assign(new Error('no such subagent'), { status: 404 });
    const { certification: _c, webhook, notify_email, ...cuerpo } = rec;
    const card = signObject({ ...cuerpo, valid_until: iso(), revoked: { at: iso(), by: por } }, this.keys, 'certification');
    await this.store.putAgent(subLocal, { ...card, webhook, notify_email });
    await this.store.kvDelete?.('boveda', subLocal);
    await this.store.kvDelete?.('pendiente', subLocal);
    await this._evento('delegation_revoked', rec.address, { by: por });
    return card;
  }
  // ---------- invitaciones de contacto ----------
  // Quien invita (su llave raíz, o la casa en su nombre) genera un link. El invitado conecta su
  // Claude con la URL que trae el link, la pantalla llega prellenada, y los dos Claude quedan como
  // contactos: cada uno en la lista del otro. Un solo uso, siete días.
  async crearInvitacion(rx) {
    const b = rx.body || {};
    let inviter;
    if ((rx.headers.authorization || '') === `Bearer ${this.adminToken}`) {
      inviter = String(b.inviter || '').toLowerCase();
      let local, domain;
      try { ({ local, domain } = parseAddress(inviter)); } catch { return { status: 400, body: { reason: 'inviter must be an address' } }; }
      const rec = domain === this.domain ? await this.store.getAgent(local) : null;
      if (!rec || rec.delegation) return { status: 404, body: { reason: 'the inviter must be an own (not delegated) address of this house' } };
    } else {
      const who = await this._authenticate(rx, rx.path);
      if (who.record.delegation) return { status: 403, body: { reason: 'a delegated address cannot invite; use your own address' } };
      inviter = who.address;
    }
    if (!await this.remotoRate.allow(`invitar:${inviter}`)) return { status: 429, body: { reason: 'too many invitations; try again in a minute' }, headers: this._retryAfter() };
    const suClaude = await this.store.getAgent(`claude.${parseAddress(inviter).local}`);
    const viva = suClaude && !suClaude.revoked && suClaude.delegation?.by === inviter && (!suClaude.valid_until || Date.parse(suClaude.valid_until) > now());
    const hint = typeof b.name === 'string' ? b.name.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30) : '';
    // Contactos extra: sólo direcciones PROPIAS de quien invita (sus delegados vigentes). Así Nicholas
    // invita a Basti y lo deja conectado con su agente de Sigo, no sólo consigo mismo.
    const contactos = [];
    for (const c of (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 10)) {
      const dir = String(c || '').toLowerCase();
      let pc; try { pc = parseAddress(dir); } catch { return { status: 400, body: { reason: `not an address: ${dir}` } }; }
      const rc = pc.domain === this.domain ? await this.store.getAgent(pc.local) : null;
      if (!rc || rc.revoked || rc.delegation?.by !== inviter) return { status: 400, body: { reason: `contacts must be your own delegated addresses: ${dir}` } };
      contactos.push(dir);
    }
    const code = uuid().replace(/-/g, '');
    const greet = typeof b.greet === 'string' && [inviter, ...contactos].includes(b.greet.toLowerCase()) ? b.greet.toLowerCase() : null;
    // `source`: por qué canal se va a mandar el enlace (whatsapp, correo...). Atribución del embudo;
    // nunca entra a una tarjeta. Al abrir el enlace, `?source=` puede precisarla.
    const inv = { code, inviter, inviter_claude: viva ? suClaude.address : null, contacts: contactos, greet, name_hint: hint || null, source: Estafeta.fuenteLimpia(b.source), created: iso(), expires: iso(now() + 7 * 86_400_000) };
    await this.store.kvPut('invitacion', code, inv, now() + 7 * 86_400_000);
    await this._evento('invitation_created', inviter, { with_claude: !!inv.inviter_claude });
    return { status: 201, body: { link: `${this.publicUrl}/i/${code}`, connector_url: `${this.publicUrl}/mcp/i/${code}`, inviter, inviter_claude: inv.inviter_claude, contacts: contactos, expires: inv.expires } };
  }
  async _paginaInvitacion(code, fuente = null, ip = null) {
    const inv = await this.store.kvGet('invitacion', code);
    const datos = inv && !inv.used_by
      ? { code, inviter: inv.inviter, inviter_claude: inv.inviter_claude, contacts: inv.contacts || [], greet: inv.greet || null, name_hint: inv.name_hint, connector_url: `${this.publicUrl}/mcp/i/${code}` }
      : { error: inv ? 'used' : 'unknown' };
    // Embudo, etapa 1: el enlace se abrió (una invitación viva). Cuenta visitas, no personas: una
    // vista previa de WhatsApp o un bot también abren. Actor = quien invitó; el invitado aún no existe.
    // Una visita por código, canal, IP y hora: la revisión del 14-sep inundó el embudo con 80 GET en
    // 43 ms. Otro canal (`?source=`) sí cuenta: es otra puerta, no la misma vista previa repetida.
    const canal = Estafeta.fuenteLimpia(fuente) || inv?.source || '';
    if (!datos.error && await this.store.kvPutIfAbsent?.('open_invite', `${code}:${canal}:${ip || 'x'}:${iso().slice(0, 13)}`, 1, now() + 2 * 3600_000)) await this._evento('open_invite', inv.inviter, { code, source: Estafeta.fuenteLimpia(fuente) || inv.source || null });
    const html = APP_HTML.replace('<!--OAUTH-->', `<script>window.NYX5_INVITE=${JSON.stringify(datos).replace(/</g, '\\u003c')}</script>`);
    return { status: inv ? 200 : 404, contentType: 'text/html; charset=utf-8', body: html };
  }
  // ---------- asistentes: alta, conocimiento, config, pausa y estado ----------
  // Qué se puede configurar y con qué límites. Un modelo sin precio conocido se rechaza: el tope
  // mensual se calcula con ese precio (PRECIOS en src/correo/asistente.js), y sin él mentiría.
  _configAsistente(c = {}, base = {}) {
    const model = c.model ?? base.model ?? 'claude-opus-5';
    if (!PRECIOS[model]) return { error: `unknown model ${model}; this house knows the price of: ${Object.keys(PRECIOS).join(', ')}` };
    const effort = c.effort ?? base.effort ?? 'medium';
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return { error: 'effort must be low, medium, high, xhigh or max' };
    const max_tokens = Number(c.max_tokens ?? base.max_tokens ?? 8000);
    if (!Number.isInteger(max_tokens) || max_tokens < 256 || max_tokens > 64000) return { error: 'max_tokens must be an integer between 256 and 64000' };
    const budget_usd = Number(c.budget_usd ?? base.budget_usd ?? 30);
    if (!(budget_usd > 0 && budget_usd <= 1000)) return { error: 'budget_usd must be above 0 and at most 1000' };
    // seal: cada respuesta termina con su sha256, para sellarla en la notaría (qa@, NX-606).
    const seal = c.seal ?? base.seal ?? false;
    if (typeof seal !== 'boolean') return { error: 'seal must be true or false' };
    const free_for = c.free_for ?? base.free_for ?? [];
    if (!Array.isArray(free_for) || free_for.length > 10 || !free_for.every((a) => { try { parseAddress(a); return true; } catch { return false; } })) return { error: 'free_for must be a list of up to 10 addresses that do not pay' };
    // Cobro por crédito (NX-606 fase 1): tokens por respuesta de Spec, por veredicto de Gate y por
    // abstención de Gate. 0 = gratis (el asistente de Sigo). Decisión de Nicholas (14-sep-2026):
    // Spec 400, Gate 400 si dictamina y 200 si se abstiene.
    const entero = (k, def, max = 1_000_000) => { const v = Number(c[k] ?? base[k] ?? def); return Number.isInteger(v) && v >= 0 && v <= max ? v : null; };
    const price_tokens = entero('price_tokens', 0);
    if (price_tokens === null) return { error: 'price_tokens must be an integer between 0 and 1000000' };
    const gate_price_tokens = entero('gate_price_tokens', price_tokens);
    if (gate_price_tokens === null) return { error: 'gate_price_tokens must be an integer between 0 and 1000000' };
    const gate_abstain_tokens = entero('gate_abstain_tokens', Math.floor(gate_price_tokens / 2));
    if (gate_abstain_tokens === null || gate_abstain_tokens > gate_price_tokens) return { error: 'gate_abstain_tokens must be an integer between 0 and gate_price_tokens' };
    const gate = c.gate ?? base.gate ?? false;
    if (typeof gate !== 'boolean') return { error: 'gate must be true or false' };
    const persona_gate = c.persona_gate ?? base.persona_gate ?? '';
    if (typeof persona_gate !== 'string' || persona_gate.length > 20_000) return { error: 'persona_gate must be a string of at most 20000 characters' };
    return { model, effort, max_tokens, budget_usd, seal, price_tokens, gate_price_tokens, gate_abstain_tokens, gate, persona_gate, free_for };
  }
  // Alta de un asistente de SISTEMA (NX-606): `<local>@<casa>` con llaves propias guardadas en la
  // bóveda, tarjeta certificada por la casa, buzón abierto y cuenta en el Libro (recibe `pay`).
  // A diferencia del modo delegado, no cuelga de nadie: su dueño es quien diga `config.owner`.
  async _altaAsistenteSistema(b) {
    const l = String(b.local || '').toLowerCase();
    if (!Estafeta.validLocal(l) || l.startsWith('g.')) return { status: 400, body: { reason: 'local must be a valid address name' } };
    if (this.isSystem(l)) return { status: 409, body: { reason: `${l}@ is a protocol address, not an assistant` } };
    if (await this.store.getAgent(l)) return { status: 409, body: { reason: `${l}@${this.domain} already exists` } };
    const k = b.keys || {};
    if (![k.sig, k.sigPriv, k.enc, k.encPriv].every((x) => typeof x === 'string' && x)) return { status: 400, body: { reason: 'keys must bring sig, sigPriv, enc and encPriv' } };
    // Prueba de posesión (invariante 9): la llave privada firma y la pública verifica.
    let posee = false; try { posee = verifyObject(signObject({ nyx5: '1', prueba: l }, k), k.sig); } catch { posee = false; }
    if (!posee) return { status: 400, body: { reason: 'sigPriv does not match sig' } };
    const c = b.config || {};
    const v = this._configAsistente(c);
    if (v.error) return { status: 400, body: { reason: v.error } };
    let owner = null;
    if (c.owner != null) {
      try { const p = parseAddress(String(c.owner)); owner = `${p.local}@${p.domain}`; } catch { return { status: 400, body: { reason: 'owner must be an address' } }; }
    }
    const since = iso();
    let card;
    try {
      card = await this.registerAgent({ local: l, sig: k.sig, enc: k.enc, system: true, welcome: 0, inbox: { policy: 'open' },
        capabilities: { accepts: ['text/plain', 'application/json', ...(v.gate ? [MEDIA_GATE] : [])], listed: true, assistant: { spec_tokens: v.price_tokens, ...(v.gate ? { gate_tokens: v.gate_price_tokens, gate_abstain_tokens: v.gate_abstain_tokens } : {}) } },
        custody: { keys: 'house', via: 'assistant', since } });
    } catch (e) { return { status: e.status || 400, body: { reason: e.message } }; }
    await this.store.kvPut('boveda', l, { sellado: this.boveda.sellar({ sig: k.sig, sigPriv: k.sigPriv, enc: k.enc, encPriv: k.encPriv }, l), root: null, since });
    const cfg = { local: l, owner, system: true, ...v, persona: String(c.persona || ''), enabled: true, created: since };
    await this.store.kvPut('asistente', l, cfg);
    const i = (await this.store.kvGet('asistente', '_indice')) || [];
    if (!i.includes(l)) await this.store.kvPut('asistente', '_indice', [...i, l]);
    await this._evento('assistant_created', card.address, { budget_usd: cfg.budget_usd, system: true, price_tokens: cfg.price_tokens });
    return { status: 201, body: { address: card.address, custody: card.custody, system: true, config: { ...cfg, persona: `${cfg.persona.length} chars`, persona_gate: `${cfg.persona_gate.length} chars` } } };
  }
  async _adminAsistente(rx, local, accion) {
    const b = rx.body || {};
    const indice = async () => (await this.store.kvGet('asistente', '_indice')) || [];
    if (rx.method === 'POST' && !local && !accion) {
      if (!this.boveda) return { status: 503, body: { reason: 'this house has no vault key' } };
      if (b.system === true) return this._altaAsistenteSistema(b);
      const l = String(b.local || '').toLowerCase();
      const rec = Estafeta.validLocal(l) ? await this.store.getAgent(l) : null;
      if (!rec?.delegation || rec.revoked) return { status: 404, body: { reason: 'an assistant must be an existing delegated address' } };
      if (rec.delegation.scope?.messages_only !== true) return { status: 400, body: { reason: 'an assistant must be messages-only: it answers, it does not move money' } };
      const k = b.keys || {};
      if (k.sig !== rec.sig || !k.sigPriv || !k.enc || !k.encPriv || k.enc !== rec.enc) return { status: 400, body: { reason: 'keys do not match the card of that address' } };
      const v = this._configAsistente(b.config || {});
      if (v.error) return { status: 400, body: { reason: v.error } };
      await this.store.kvPut('boveda', l, { sellado: this.boveda.sellar({ sig: k.sig, sigPriv: k.sigPriv, enc: k.enc, encPriv: k.encPriv }, l), root: rec.delegation.by, since: iso() });
      // La tarjeta declara que la casa guarda su llave, igual que la de un Claude conectado.
      const { certification: _c, webhook, notify_email, ...cuerpo } = rec;
      const card = signObject({ ...cuerpo, custody: { keys: 'house', via: 'assistant', since: iso() } }, this.keys, 'certification');
      await this.store.putAgent(l, { ...card, webhook, notify_email });
      const c = b.config || {};
      const cfg = { local: l, owner: rec.delegation.by, ...v, persona: String(c.persona || ''), enabled: true, created: iso() };
      await this.store.kvPut('asistente', l, cfg);
      const i = await indice();
      if (!i.includes(l)) await this.store.kvPut('asistente', '_indice', [...i, l]);
      await this._evento('assistant_created', card.address, { budget_usd: cfg.budget_usd });
      return { status: 201, body: { address: card.address, custody: card.custody, config: { ...cfg, persona: `${cfg.persona.length} chars` } } };
    }
    const cfg = local ? await this.store.kvGet('asistente', local) : null;
    if (!cfg) return { status: 404, body: { reason: 'no such assistant' } };
    if (rx.method === 'PUT' && accion === 'knowledge') {
      const texto = typeof b.texto === 'string' ? b.texto : '';
      if (!texto || Buffer.byteLength(texto) > 1_500_000) return { status: 400, body: { reason: 'knowledge must be text up to 1.5 MB' } };
      await this.store.kvPut('asistente-conocimiento', local, { texto, updated: iso() });
      return { status: 200, body: { bytes: Buffer.byteLength(texto), updated: iso() } };
    }
    // Cambiar modelo, esfuerzo, tope o persona sin volver a dar de alta (11-sep-2026: Nicholas pidió
    // un modelo más barato para el agente de Sigo). Lo que no se manda, queda como estaba.
    if (rx.method === 'PUT' && accion === 'config') {
      const v = this._configAsistente(b, cfg);
      if (v.error) return { status: 400, body: { reason: v.error } };
      const nueva = { ...cfg, ...v, ...(typeof b.persona === 'string' ? { persona: b.persona } : {}), updated: iso() };
      await this.store.kvPut('asistente', local, nueva);
      return { status: 200, body: { model: nueva.model, effort: nueva.effort, max_tokens: nueva.max_tokens, budget_usd: nueva.budget_usd, seal: nueva.seal === true, price_tokens: nueva.price_tokens, gate: nueva.gate === true, gate_price_tokens: nueva.gate_price_tokens, gate_abstain_tokens: nueva.gate_abstain_tokens, free_for: nueva.free_for || [] } };
    }
    if (rx.method === 'POST' && (accion === 'pause' || accion === 'resume')) {
      await this.store.kvPut('asistente', local, { ...cfg, enabled: accion === 'resume' });
      return { status: 200, body: { enabled: accion === 'resume' } };
    }
    if (rx.method === 'GET' && !accion) {
      const mes = new Date().toISOString().slice(0, 7);
      const gasto = (await this.store.kvGet('asistente-gasto', `${local}:${mes}`)) || { usd: 0, llamadas: 0 };
      const con = await this.store.kvGet('asistente-conocimiento', local);
      return { status: 200, body: { address: `${local}@${this.domain}`, enabled: cfg.enabled, system: cfg.system === true, owner: cfg.owner || null, free_for: cfg.free_for || [], model: cfg.model, effort: cfg.effort, budget_usd: cfg.budget_usd, price_tokens: cfg.price_tokens ?? 0, gate: cfg.gate === true, gate_price_tokens: cfg.gate_price_tokens ?? 0, gate_abstain_tokens: cfg.gate_abstain_tokens ?? 0, month: mes, spent_usd: Math.round(gasto.usd * 10000) / 10000, calls: gasto.llamadas, knowledge_bytes: con ? Buffer.byteLength(con.texto) : 0, knowledge_updated: con?.updated || null, api_key: !!this.asistente, pending: (await this.store.listMail(local)).length } };
    }
    return { status: 405, body: { reason: 'method not allowed here' } };
  }

  // Suma direcciones a la lista de quién puede escribirle a una dirección (la re-certifica la casa).
  // Sólo agrega, y sólo si esa dirección ya filtra por lista: una abierta sigue abierta.
  async agregarContactos(local, direcciones) {
    const rec = await this.store.getAgent(local);
    if (!rec || rec.revoked || rec.inbox?.policy !== 'allowlist') return null;
    const lista = [...new Set([...(rec.inbox.allowlist || []), ...direcciones])];
    const { certification: _c, webhook, notify_email, ...cuerpo } = rec;
    const card = signObject({ ...cuerpo, inbox: { ...rec.inbox, allowlist: lista } }, this.keys, 'certification');
    await this.store.putAgent(local, { ...card, webhook, notify_email });
    return card;
  }
  // Conecta dos direcciones de esta casa en los DOS sentidos. Nació el 11-sep-2026: Nicholas pidió
  // que su Claude del teléfono y el de Basti quedaran como contactos sin que Basti volviera a
  // conectar el suyo (el plan gratis de Claude admite un solo conector). Sólo la casa lo hace, y
  // revisa los dos lados ANTES de escribir: nunca queda una conexión en un solo sentido.
  async conectarContactos(a, b) {
    const dirs = [a, b].map((x) => String(x || '').toLowerCase());
    let pa, pb; try { pa = parseAddress(dirs[0]); pb = parseAddress(dirs[1]); } catch { return { status: 400, body: { reason: 'two addresses of this house are needed' } }; }
    if (pa.domain !== this.domain || pb.domain !== this.domain) return { status: 400, body: { reason: `both addresses must belong to ${this.domain}` } };
    if (dirs[0] === dirs[1]) return { status: 400, body: { reason: 'an address is already its own contact' } };
    for (const l of [pa.local, pb.local]) {
      const rec = await this.store.getAgent(l);
      if (!rec || rec.revoked || rec.inbox?.policy !== 'allowlist') return { status: 409, body: { reason: `${l}@${this.domain} does not exist, is revoked, or does not filter by list` } };
    }
    await this.agregarContactos(pa.local, [dirs[1]]);
    await this.agregarContactos(pb.local, [dirs[0]]);
    await this._evento('contacts_connected', dirs[0], { with: dirs[1] });
    return { status: 200, body: { connected: dirs } };
  }

  // Rutas del conector que un cliente MCP pide con CORS: descubrimiento, registro, token y /mcp.
  async _rutaRemota(rx) {
    const p = rx.path;
    if (rx.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) {
      const ruta = p.slice('/.well-known/oauth-protected-resource'.length) || '/mcp';
      if (ruta === '/mcp' || oauth.RUTA_INVITACION.test(ruta)) return { status: 200, body: oauth.metadatosRecurso(this, ruta) };
      return null;
    }
    if (rx.method === 'GET' && p === '/.well-known/oauth-authorization-server') return { status: 200, body: oauth.metadatosServidor(this) };
    if (rx.method === 'POST' && p === '/oauth/register') return oauth.registrar(this, rx.body, rx.ip);
    if (rx.method === 'POST' && p === '/oauth/token') return oauth.token(this, rx.body);
    if (p === '/mcp' || oauth.RUTA_INVITACION.test(p)) return atenderMcp(this, rx);
    return null;
  }

  // ---------- autenticación de agentes propios ----------
  // Authorization: Nyx5 <b64u(canonical({address,ts,nonce,method,path,host}))>.<firma Ed25519>
  // `host` amarra el token a ESTA estafeta: el mismo header no sirve contra otra casa.
  // Con allowForeign, un agente de otra casa también puede autenticarse: su clave se obtiene por el
  // resolver (cadena DNS -> dominio -> agente). Así un foráneo consulta su cuenta en este Libro sin login.
  async _authenticate(rx, path, { allowForeign = false } = {}) {
    const h = rx.headers.authorization || '';
    const m = /^Nyx5\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(h);
    if (!m) throw Object.assign(new Error('falta Authorization: Nyx5 <token>.<firma>'), { status: 401 });
    let claims;
    try { claims = JSON.parse(unb64u(m[1]).toString()); } catch { throw Object.assign(new Error('token ilegible'), { status: 401 }); }
    const { local, domain } = parseAddress(claims.address);
    let rec;
    if (domain === this.domain) {
      rec = await this.store.getAgent(local);
      if (!rec) throw Object.assign(new Error('agent not registered'), { status: 401 });
    } else {
      if (!allowForeign) throw Object.assign(new Error('the agent does not belong to this domain'), { status: 401 });
      try { rec = await this.resolver.agentCard(claims.address); } catch (e) { throw Object.assign(new Error(`foreign agent could not be verified: ${e.message}`), { status: 401 }); }
    }
    if (rec.revoked) throw Object.assign(new Error('this address was revoked by its owner'), { status: 401 });
    if (rec.valid_until && Date.parse(rec.valid_until) <= now()) throw Object.assign(new Error('this address expired'), { status: 401 });
    if (Math.abs(now() - Date.parse(claims.ts)) > 300_000) throw Object.assign(new Error('token expired (5 minute window)'), { status: 401 });
    if (claims.method !== rx.method || claims.path !== path) throw Object.assign(new Error('token does not match this request'), { status: 401 });
    if (claims.host !== this.authHost) throw Object.assign(new Error(`token issued for another house (host ${claims.host || 'missing'}, expected ${this.authHost})`), { status: 401 });
    if (!verifyBytes(canonical(claims), m[2], rec.sig)) throw Object.assign(new Error('invalid token signature'), { status: 401 });
    if (!await this.store.useNonce(`${claims.address}:${claims.nonce}`, now())) throw Object.assign(new Error('nonce reutilizado'), { status: 401 });
    const who = { local, address: claims.address, record: rec };
    if (domain === this.domain) this._anotarPresencia(who).catch((e) => this.log(`presencia: ${e.message}`));
    return who;
  }

  // ---------- salida: el agente entrega un sobre a su estafeta ----------
  // Los límites de un delegado (types, to_domains, sólo mensajes) valen por DONDE entre el sobre.
  // Defecto real (11-sep-2026, revisión antes de publicar el botón de tokens): sólo se aplicaban en
  // /outbound, y un subagente de sólo mensajes pagaba entregando su sobre firmado directo a /inbound,
  // que es público porque por ahí entra la federación. Ahora los aplican las dos puertas y el Libro.
  _limiteDeAlcance(env, scope) {
    if (!scope) return null;
    if (scope.types?.length && !scope.types.includes(env.type)) return `agente delegado: solo puede enviar type ${scope.types.join('|')}`;
    if (scope.to_domains?.length && !env.to.every((t) => scope.to_domains.includes(parseAddress(t).domain))) return `agente delegado: solo puede escribir a ${scope.to_domains.join(', ')}`;
    // Sólo mensajes: la dirección que guarda la casa para el Claude de un teléfono no toca el Libro
    // ni paga estampillas. Aunque el puente no le ofrezca esas herramientas, la casa lo niega igual.
    if (scope.messages_only) {
      if (!['message', 'result', 'receipt'].includes(env.type)) return 'this is a messages-only address: it can send message, result or receipt';
      if (env.to.some((t) => parseAddress(t).local === 'libro')) return 'this is a messages-only address: it cannot operate the ledger';
      if (env.stamp) return 'this is a messages-only address: it cannot pay stamps';
    }
    return null;
  }
  async outbound(env, submitter) {
    const v = validateEnvelope(env, { maxBytes: this.policy.max_bytes });
    if (!v.ok) return v;
    if (env.from !== submitter.address) return { ok: false, code: 403, reason: 'from does not match the authenticated agent' };
    if (env.signature.kid !== submitter.record.sig || !verifyObject(env, submitter.record.sig)) return { ok: false, code: 403, reason: 'invalid envelope signature' };
    const fuera = this._limiteDeAlcance(env, submitter.record.delegation?.scope);
    if (fuera) return { ok: false, code: 403, reason: fuera };

    const byDomain = new Map();
    for (const to of env.to) { const { domain } = parseAddress(to); byDomain.set(domain, [...(byDomain.get(domain) || []), to]); }
    const jobs = [];
    for (const [domain, to] of byDomain) {
      // Entrega diferida: si el sobre trae deliver_after futuro, el job espera en la cola hasta esa
      // fecha (claimDueJobs no lo reclama antes). En el pasado o ausente, se entrega de inmediato.
      const first = (env.deliver_after && Date.parse(env.deliver_after) > now()) ? iso(Date.parse(env.deliver_after)) : iso();
      const job = { id: uuid(), envelope: env, domain, to, from_local: submitter.local, attempts: 0, next_attempt: first, created: iso(), status: 'queued', log: [] };
      await this.store.enqueue(job);
      await this._outbox(job);
      jobs.push({ job: job.id, domain, to });
    }
    await this._primerMensaje(submitter, env);
    return { ok: true, code: 202, id: env.id, jobs };
  }
  async _outbox(job, extra = {}) {
    // El sobre viaja con el estado: la bandeja guardaba sólo cómo iba el envío, y así lo que uno
    // mandó desaparecía de su propio historial en cuanto se entregaba.
    await this.store.putOutbox(job.from_local, { job: job.id, id: job.envelope.id, domain: job.domain, to: job.to, status: job.status, attempts: job.attempts, next_attempt: job.next_attempt, updated: iso(), log: job.log, envelope: job.envelope, ...extra });
  }

  // ---------- trabajador de entrega (store-and-forward) ----------
  // El reclamo es exclusivo (claimDueJobs): dos ticks concurrentes (cron solapado, multi-isolate)
  // no toman el mismo trabajo. Un trabajo reclamado y no resuelto vuelve a ser reclamable al minuto.
  // `programado`: el reloj de la casa (cron en el edge, intervalo en Node). Un tick disparado por una
  // petición (kick) NO atiende asistentes: después de responder, el edge sólo da 30 segundos.
  async tick({ programado = true } = {}) {
    await this.init();
    const due = await this.store.claimDueJobs(now(), 20);
    for (const job of due) await this._deliver(job);
    await this.store.pruneNonces?.(now() - 600_000);
    // La purga de lo vencido es limpieza: si falla (una casa cuya base aún no tiene la tabla 0006),
    // no puede tumbar el ciclo que entrega el correo de todos.
    try { await this.store.kvPurge?.(now()); } catch (e) { this.log(`kv: no se pudo purgar lo vencido: ${e.message}`); }
    if (this.index.enabled) await this._indexCrawlIfDue();
    if (this.verifica.enabled) await this._verificarPendientes();
    // Sólo desde el reloj programado: recorre la tabla de contratos, y el tick que sigue a cada
    // petición no tiene por qué pagarlo.
    if (programado) await this._liberarVencidos();
    if (programado) { try { await atenderAsistentes(this); } catch (e) { this.log(`asistentes: ${e.message}`); } }
    await this.flushPushes();
  }
  async _deliver(job) {
    // Un sobre diferido pudo vencer mientras esperaba: no desaparece en silencio, rebota al remitente.
    if (job.envelope.expires && Date.parse(job.envelope.expires) < now()) {
      for (const to of job.to) await this._bounce(job, to, 'the envelope expired while waiting in the queue');
      job.status = 'failed'; await this.store.removeJob(job.id); await this._outbox(job); return;
    }
    job.attempts += 1;
    let outcome;
    if (job.domain === this.domain) {
      // Entrega local: sin red, directo a inbound (misma verificación, cero riesgo de auto-fetch).
      const relay = `nyx51 domain=${this.domain}; kid=${this.keys.sig}; sig=${signBytes(`relay:${job.envelope.id}:${this.domain}`, this.keys)}`;
      try {
        const r = await this.inbound(job.envelope, relay);
        outcome = { status: r.code, body: r };
      } catch (e) {
        outcome = { status: 500, error: e.message };
      }
    } else {
      try {
        const dc = await this.resolver.domainCard(job.domain);
        const relay = `nyx51 domain=${this.domain}; kid=${this.keys.sig}; sig=${signBytes(`relay:${job.envelope.id}:${job.domain}`, this.keys)}`;
        const res = await this.fetch(`${dc._estafeta}/inbound`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-nyx5-relay': relay },
          body: JSON.stringify(job.envelope), signal: AbortSignal.timeout(10_000),
        });
        const body = await res.json().catch(() => null);
        // Un 200/202 sin cuerpo interpretable NO es una entrega: es un intermediario contestando
        // por la estafeta. Se trata como transitorio; jamás se declara entregado sin evidencia.
        if ((res.status === 200 || res.status === 202) && (!body || (!Array.isArray(body.accepted) && !Array.isArray(body.rejected)))) {
          outcome = { status: 502, error: 'respuesta sin forma de estafeta (¿intermediario?)' };
        } else {
          outcome = { status: res.status, body: body || {} };
        }
      } catch (e) {
        outcome = { status: 0, error: e.message };
      }
    }
    job.log.push({ at: iso(), attempt: job.attempts, status: outcome.status, detail: outcome.error || outcome.body?.reason || outcome.body?.rejected || 'ok' });

    // Clasificación por destinatario
    const delivered = [], failed = [], retry = [];
    if (outcome.status === 200 || outcome.status === 202) {
      for (const a of outcome.body.accepted || []) delivered.push(a);
      for (const r of outcome.body.rejected || []) (RETRYABLE.has(r.code) ? retry : failed).push(r);
      // Destinatarios que la respuesta no menciona: transitorio, no éxito silencioso.
      const mentioned = new Set([...delivered, ...(outcome.body.rejected || []).map((r) => r.to)]);
      for (const to of job.to) if (!mentioned.has(to)) retry.push({ to, code: outcome.status, reason: 'recipient missing a verdict in the response' });
    } else if (outcome.status === 0 || RETRYABLE.has(outcome.status)) {
      retry.push(...job.to.map((to) => ({ to, code: outcome.status, reason: outcome.error || outcome.body?.reason })));
    } else {
      failed.push(...job.to.map((to) => ({ to, code: outcome.status, reason: outcome.body?.reason || 'rechazo permanente' })));
    }

    for (const f of failed) await this._bounce(job, f.to, `rejected (${f.code}): ${f.reason}`);
    if (delivered.length && job.envelope.receipt === 'delivered') for (const to of delivered) await this._notify(job, to, 'delivered', 'delivered to the destination estafeta');

    if (retry.length) {
      const age = now() - Date.parse(job.created);
      if (age > this.retry.giveUpMs) {
        for (const r of retry) await this._bounce(job, r.to, `no answer after ${job.attempts} attempts: ${r.reason}`);
        job.status = 'failed'; await this.store.removeJob(job.id); await this._outbox(job); return;
      }
      const backoff = Math.min(this.retry.baseMs * 2 ** (job.attempts - 1), this.retry.maxMs) * (0.8 + Math.random() * 0.4);
      job.to = retry.map((r) => r.to); job.status = 'retrying'; job.next_attempt = iso(now() + backoff); job.claimed_until = 0;
      await this.store.updateJob(job); await this._outbox(job);
      return;
    }
    job.status = failed.length && !delivered.length ? 'failed' : 'delivered';
    await this.store.removeJob(job.id); await this._outbox(job, { delivered: delivered.length, failed: failed.length });
  }

  // ----- verifica@: escrows que declararon prueba y nombraron árbitro a la casa -----
  // El asiento no se mueve por lo que alguien dijo, sino por lo que la prueba devolvió. Y si
  // la prueba no pudo correr (red caída, timeout), NO se decide: el escrow queda como estaba.
  async _verificarPendientes() {
    const arbitro = `verifica@${this.domain}`;
    let contratos;
    try { contratos = await this.store.libroListContracts({ state: ['held', 'delivered'] }); } catch { return; }
    const candidatos = contratos.filter((c) => c.kind === 'escrow' && ['held', 'delivered'].includes(c.state) && c.arbiter === arbitro && pruebasDe(c));
    for (const c of candidatos.slice(0, this.verifica.maxPorTick)) {
      // Solo se verifica lo que ya se declaró entregado, salvo que el contrato pida verificar
      // desde el arranque (terms.verify_on: 'accept'), útil para un endpoint que ya debía estar en pie.
      if (c.state === 'held' && (c.terms?.verify_on || 'deliver') !== 'accept') continue;
      const v = await veredicto(pruebasDe(c), { fetchImpl: this.fetch, timeoutMs: this.verifica.timeoutMs, privados: this.verifica.privados === true, entregado: c.evidence ?? null, entregadoSha256: c.evidence_sha256 ?? null });
      if (v.indeciso) { this.log(`verifica ${c.id}: sin veredicto (${v.razon})`); continue; }
      // La decisión viaja como sobre firmado a libro@ y entra por `inbound`, la MISMA puerta
      // que usa cualquier agente (invariante 2). No se toca el Libro por dentro: si la firma
      // de verifica@ no verifica, la casa se rechaza a sí misma. El veredicto va en el
      // contenido, así que el porqué queda escrito y auditable en el contrato.
      const env = signObject({
        nyx5: '1', id: uuid(), from: `verifica@${this.domain}`, to: [`libro@${this.domain}`],
        created: iso(), expires: null, thread: c.id, in_reply_to: null, type: 'task',
        content: { media: MEDIA.op, body: { op: v.pasa ? 'release' : 'refund', contract: c.id, note: v.razon, veredicto: { pasa: v.pasa, razon: v.razon, resultados: v.resultados } } },
      }, this.keys);
      // Se espera el resultado antes de mirar el siguiente: así el estado ya cambió y este
      // contrato no vuelve a elegirse en el mismo tick ni en el siguiente.
      const r = await this.inbound(env);
      if (!r.ok) this.log(`verifica ${c.id}: la casa rechazó su propia decisión (${r.code}): ${r.reason}`);
      else {
        this.log(`verifica ${c.id}: ${v.pasa ? 'libera' : 'devuelve'} — ${v.razon}`);
        await this._evento('verificado', `verifica@${this.domain}`, { contract: c.id, pasa: v.pasa, pruebas: (pruebasDe(c) || []).map((x) => x.type), amount: c.amount });
      }
    }
  }

  // ----- escrow que vence (NX-503): entregado, con plazo vencido y ventana de revisión cerrada -----
  // La casa se lo dice a sí misma como sobre firmado de libro@ a libro@ y entra por `inbound`,
  // igual que verifica@ (invariante 2): nada toca el Libro por dentro. La op `expire` vuelve a
  // comprobar las fechas; aquí sólo se elige a quién mirar.
  async _liberarVencidos() {
    let contratos;
    try { contratos = await this.store.libroListContracts({ state: 'delivered' }); } catch { return; }
    const ahora = now();
    const vencidos = contratos.filter((c) => {
      if (c.kind !== 'escrow' || c.state !== 'delivered') return false;
      const plazo = Date.parse(c.terms?.deadline || ''); if (Number.isNaN(plazo)) return false;
      const entregado = Date.parse(c.history?.filter((h) => h.op === 'deliver').at(-1)?.at || '') || 0;
      return ahora >= Math.max(plazo, entregado) + this.libro.reviewWindowMs;
    });
    for (const c of vencidos.slice(0, 10)) {
      const env = signObject({
        nyx5: '1', id: uuid(), from: `libro@${this.domain}`, to: [`libro@${this.domain}`],
        created: iso(), expires: null, thread: c.id, in_reply_to: null, type: 'task',
        content: { media: MEDIA.op, body: { op: 'expire', contract: c.id } },
      }, this.keys);
      const r = await this.inbound(env);
      if (!r.ok) this.log(`expire ${c.id}: la casa rechazó su propia liquidación (${r.code}): ${r.reason}`);
      else { this.log(`expire ${c.id}: liberado al vendedor por ventana vencida`); await this._evento('escrow_expired', `libro@${this.domain}`, { contract: c.id, amount: c.amount }); }
    }
  }

  // Sobres emitidos por los agentes de sistema (postmaster@, libro@), firmados con la clave del dominio.
  // Destinatarios locales: directo al buzón. Remotos: por la cola, como cualquier envío.
  async _systemSend(fromLocal, to, { type = 'receipt', content, thread = null, in_reply_to = null, deliverAfter = null }) {
    const env = signObject({ nyx5: '1', id: uuid(), from: `${fromLocal}@${this.domain}`, to, created: iso(), expires: null, deliver_after: deliverAfter ?? undefined, thread, in_reply_to, type, content }, this.keys);
    // Un aviso diferido (deliver_after futuro) SIEMPRE va por la cola, aunque el destino sea local:
    // la cola es lo único que respeta la fecha. Sin fecha, el destinatario local recibe al instante.
    const diferido = deliverAfter && Date.parse(deliverAfter) > now();
    const byDomain = new Map();
    for (const t of to) {
      const { local, domain } = parseAddress(t);
      if (domain === this.domain && !diferido) {
        if (await this.store.getAgent(local)) { await this.store.putMail(local, env, { via: fromLocal, from_verified: true }); this._push(local, env); }
        else this.log(`recibo de ${fromLocal}@ a ${t} descartado: agente inexistente`);
      } else byDomain.set(domain, [...(byDomain.get(domain) || []), t]);
    }
    for (const [domain, dest] of byDomain) await this.store.enqueue({ id: uuid(), envelope: env, domain, to: dest, from_local: fromLocal, attempts: 0, next_attempt: diferido ? iso(Date.parse(deliverAfter)) : iso(), created: iso(), status: 'queued', log: [] });
    return env;
  }

  // ----- tareas@: la casa toma el lado comprador de una tarea sembrada -----
  // El agente manda su cotización firmada; la casa la compara contra el catálogo publicado y,
  // si coincide y hay cupo, la acepta operando el Libro como cualquier comprador. La casa NO
  // firma por el agente: el vendedor de ese escrow es él, con su propia llave.
  async _tomarTarea(env, senderCard) {
    const q = env.content?.body;
    if (env.content?.media !== MEDIA.cotizacion || q?.tipo !== 'cotizacion') {
      return { ok: false, code: 400, reason: `tareas@ accepts a quote (${MEDIA.cotizacion}) for a published task; see GET /tareas` };
    }
    const tarea = this.tareas.tarea(q.terms?.seed_task);
    if (!tarea) return { ok: false, code: 404, reason: `no seeded task with id ${q.terms?.seed_task}. The published ones are at GET /tareas` };
    if (q.seller !== env.from) return { ok: false, code: 403, reason: 'the seller of the quote must be whoever sends it' };
    if (q.buyer !== `tareas@${this.domain}`) return { ok: false, code: 400, reason: `the quote must be addressed to tareas@${this.domain}` };
    const encaja = this.tareas.coincide(q, tarea, { arbitro: `verifica@${this.domain}` });
    if (!encaja.ok) return { ok: false, code: 409, reason: encaja.reason };
    const contratos = await this.store.libroListContracts();
    const cupo = this.tareas.cupo(tarea, env.from, contratos);
    // 409, no 429: un 429 es transitorio y la estafeta lo reintentaría durante tres días, así
    // que el agente se quedaría esperando sin saber por qué. Sin cupo, se le dice ahora.
    if (!cupo.ok) return { ok: false, code: 409, reason: cupo.reason };

    // La casa acepta con un sobre firmado a libro@, por la misma puerta que todos.
    const aceptacion = signObject({
      nyx5: '1', id: uuid(), from: `tareas@${this.domain}`, to: [`libro@${this.domain}`],
      created: iso(), expires: null, thread: q.id, in_reply_to: env.id, type: 'task',
      content: { media: MEDIA.op, body: { op: 'accept', quote: q } },
    }, this.keys);
    const r = await this.inbound(aceptacion);
    if (!r.ok) return { ok: false, code: r.code || 409, reason: `the house could not take the task: ${r.reason}` };
    const contrato = Object.values(r.results || {})[0]?.contract || null;
    this.log(`tarea ${tarea.id} tomada por ${env.from} (contrato ${contrato?.id})`);
    await this._evento('seed_task_taken', env.from, { task: tarea.id, contract: contrato?.id || null, price: tarea.price });
    return { ok: true, code: 202, result: { contract: contratoPublico(contrato), task: tarea.id }, recibos: [] };
  }

  // Los cinco eventos que dicen si el mecanismo se está ejerciendo de verdad, leídos del
  // resultado de la op (no de lo que alguien dijo que iba a pasar).
  async _eventoDeOp(env, result) {
    if (!this.eventos) return;
    const op = env.content?.body?.op;
    const c = result?.contract;
    const m = result?.mandate;
    if (op === 'mandate' && m) return this._evento('mandate_created', m.grantor, { mandate: m.id, grantee: m.grantee, cap: m.cap, parent: m.parent || null });
    if (op === 'accept' && c) return this._evento('first_quote', c.buyer, { contract: c.id, kind: c.kind, amount: c.amount, seller: c.seller });
    if (op === 'release' && c?.kind === 'escrow') return this._evento('escrow_released', c.seller, { contract: c.id, amount: c.amount, by: env.from, arbitrado: env.from === `verifica@${this.domain}` });
    if (op === 'refund' && c) return this._evento('escrow_refunded', c.buyer, { contract: c.id, amount: c.amount, by: env.from });
    if (op === 'reclaim' && c) return this._evento('escrow_refunded', c.buyer, { contract: c.id, amount: c.amount, by: env.from, reclaimed: true });
    if (op === 'expire' && c) return this._evento('escrow_released', c.seller, { contract: c.id, amount: c.amount, by: env.from, expired: true });
    if (op === 'forfeit' && c) return this._evento('bond_forfeited', c.seller, { contract: c.id, amount: c.amount, by: env.from, vouchee: c.vouchee || null });
    if (op === 'notarize' && result?.seal && !result.existing) return this._evento('notarized', env.from, { seal: result.seal.id, sha256: result.seal.sha256 });
  }

  // Avisos del postmaster al remitente (rebotes y acuses de entrega). Llevan el hash del sobre original.
  async _notify(job, to, status, reason) {
    await this._systemSend('postmaster', [job.envelope.from], {
      in_reply_to: job.envelope.id, thread: job.envelope.thread || job.envelope.id,
      content: { media: 'application/json', body: { of: job.envelope.id, sha256: sha256hex(canonical(job.envelope)), to, status, reason } },
    });
  }
  async _bounce(job, to, reason) { this.log(`rebote ${job.envelope.id} -> ${to}: ${reason}`); await this._notify(job, to, 'failed', reason); }

  // ---------- entrada: otra estafeta nos entrega un sobre ----------
  async inbound(env, relayHeader) {
    const v = validateEnvelope(env, { maxBytes: this.policy.max_bytes });
    if (!v.ok) return v;
    if (env.expires && Date.parse(env.expires) < now()) return { ok: false, code: 410, reason: 'sobre vencido' };

    // Dedupe POR DESTINATARIO: lo ya aceptado no se re-procesa ni se re-cobra; lo pendiente
    // (una entrega parcial que la estafeta emisora reintenta) SÍ se procesa. La respuesta de un
    // duplicado dice la verdad: solo lo que de verdad se aceptó.
    const seen = await this.store.getSeen(env.id);
    const yaAceptados = new Set(seen?.accepted || []);

    const locals = env.to.filter((t) => parseAddress(t).domain === this.domain);
    if (!locals.length) return { ok: false, code: 404, reason: 'no recipient belongs to this domain' };
    const pendientes = locals.filter((t) => !yaAceptados.has(t));
    if (!pendientes.length) return { ok: true, code: 200, duplicate: true, accepted: [...yaAceptados], rejected: [] };

    // Cadena de confianza: dominio emisor -> agente emisor -> firma del sobre
    let senderCard;
    // Se pide «para» el primer destinatario de esta casa: si el remitente es secreto en la suya, su
    // casa sólo entrega la tarjeta a quien él tiene en su lista (NX-202).
    const paraQuien = pendientes.map((t) => t.toLowerCase()).find((t) => { try { return parseAddress(t).domain === this.domain; } catch { return false; } }) || null;
    try { senderCard = await this.resolver.agentCardForKid(env.from, env.signature.kid, { onBehalfOf: paraQuien }); }
    catch (e) { return { ok: false, code: e.permanent ? 403 : 421, reason: `could not verify the sender: ${e.message}` }; }
    const validKids = Resolver.acceptedKids(senderCard);
    if (!validKids.includes(env.signature.kid) || !verifyObject(env, env.signature.kid)) return { ok: false, code: 403, reason: 'the envelope signature does not match the sender' };
    const fuera = this._limiteDeAlcance(env, senderCard.delegation?.scope);
    if (fuera) return { ok: false, code: 403, reason: fuera };

    // Firma de relay (segunda capa: la estafeta emisora también firma, análogo a SPF/DKIM)
    const { domain: fromDomain } = parseAddress(env.from);
    let relayVerified = false;
    if (relayHeader) {
      const r = Object.fromEntries(relayHeader.replace(/^nyx51\s*/, '').split(';').map((p) => p.trim().split('=').map((x) => x.trim())).filter((p) => p[0]));
      relayVerified = r.domain === fromDomain && senderCard._domain.keys.some((k) => k.sig === r.kid) && verifyBytes(`relay:${env.id}:${this.domain}`, r.sig, r.kid);
    }
    if (this.policy.require_relay && !relayVerified) return { ok: false, code: 403, reason: 'this domain requires a valid relay signature' };
    // La clave del límite: cada agente de ESTA casa cuenta por su cuenta (uno solo no frena a los
    // demás); los de otra casa cuentan por dominio, que es lo único verificado de ellos aquí.
    const claveTasa = fromDomain === this.domain ? env.from : fromDomain;
    if (!await this.rate.allow(claveTasa)) return { ok: false, code: 429, reason: fromDomain === this.domain ? 'rate limit for this sender' : 'rate limit for the sending domain' };

    const accepted = [], rejected = [], results = {};
    const mails = [], libroBundles = [];
    const recibosPendientes = [];
    const avisosPendientes = [];
    let stampUsed = false;
    // Sobre x402 de esta entrega. Un buzón con estampilla ES un recurso de pago: si falta la
    // estampilla se responde 402 anunciando el precio, y si se cobró se responde con el recibo de
    // liquidación. No es un camino paralelo para mover tokens: el pago lo hizo el Libro igual.
    let x402req = null, x402pago = null;
    for (const to of pendientes) {
      const { local } = parseAddress(to);
      const rec = await this.store.getAgent(local);
      // Un secreto le contesta a quien no está en su lista lo mismo que un inexistente: ni el
      // rebote del postmaster confirma que la dirección existe.
      if (!rec || !await this._visibleA(rec, env.from)) { rejected.push({ to, code: 404, reason: 'no such agent' }); continue; }
      const p = applyInboxPolicy(env, rec, senderCard._domain);
      if (!p.ok) { rejected.push({ to, ...p, ok: undefined }); continue; }
      try {
        if (local === 'libro') {
          // Operación del Libro: se ejecuta (idempotente por id de sobre), no se almacena;
          // los recibos salen firmados por la casa después del commit del sobre.
          const r = await this.libro.handle(env, senderCard);
          if (!r.ok) { rejected.push({ to, code: r.code, reason: r.reason }); continue; }
          for (const rc of r.recibos || []) recibosPendientes.push(rc);
          for (const av of r.avisos || []) avisosPendientes.push(av);
          results[to] = r.result;
          if (!r.duplicate) await this._eventoDeOp(env, r.result);
        } else if (local === 'tareas' && this.tareas.enabled) {
          // Mostrador del trabajo sembrado: el agente cotiza la tarea publicada y la casa la
          // acepta si coincide EXACTAMENTE con el catálogo y hay cupo. Nada se negocia aquí.
          const r = await this._tomarTarea(env, senderCard);
          if (!r.ok) { rejected.push({ to, code: r.code, reason: r.reason }); continue; }
          for (const rc of r.recibos || []) recibosPendientes.push(rc);
          results[to] = r.result;
        } else if (rec.group) {
          // Grupo: la casa NO descifra. Deja el MISMO sobre firmado en el buzón de cada miembro (menos
          // el remitente, que lo tiene en su bandeja de salida) y en el del grupo, que es su historial.
          // La membresía se comprueba aquí otra vez: la política del buzón deja pasar un `intro` o un
          // aval, y eso no puede abrir un grupo.
          const posters = rec.group.post === 'admins' ? rec.group.admins : rec.group.members;
          if (!posters.includes(env.from)) { rejected.push({ to, code: 403, reason: 'only members post to this group' }); continue; }
          const meta = { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid, group: to };
          // Cada miembro recibe sólo si SU buzón acepta a quien escribe: el grupo no es una puerta
          // trasera a una lista blanca. Y cada entrega extra cuenta en el límite de tasa del remitente:
          // un grupo de 50 no multiplica por 50 lo que un dominio puede mandar por minuto.
          let omitidos = 0;
          for (const dir of rec.group.members) {
            if (dir === env.from) continue;
            const recM = await this.store.getAgent(parseAddress(dir).local);
            if (!recM || recM.revoked || !this._aceptaDe(recM, env.from)) { omitidos++; continue; }
            if (mails.length && !await this.rate.allow(claveTasa)) { rejected.push({ to, code: 429, reason: 'rate limit for the sender (group delivery)' }); break; }
            mails.push({ local: parseAddress(dir).local, envelope: env, meta });
          }
          mails.push({ local, envelope: env, meta });
          results[to] = { members: rec.group.members.length, skipped: omitidos };
        } else if (p.stamp) {
          // Una estampilla paga UN buzón: el sobre declara un monto, no un monto por destinatario.
          if (stampUsed) { rejected.push({ to, code: 402, reason: 'the envelope stamp was already spent on another recipient' }); continue; }
          const { asiento, bundle } = await this.libro.stamp(env, to, p.stamp.price);
          stampUsed = true;
          x402pago = { to, price: p.stamp.price, asiento: asiento.id, payer: env.from };
          libroBundles.push(bundle);
          mails.push({ local, envelope: env, meta: { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid, stamp: asiento.id } });
        } else if (p.vouch) {
          // Aval con fianza: la política vio un avalador de la allowlist; aquí se comprueba la fianza
          // contra el Libro de ESTA casa. Sin fianza válida (activa, para este remitente, con el
          // receptor como beneficiario y verificador), no entra. Avalar no es gratis.
          const b = await this.libro.getContract(p.vouch.bond);
          const malo = !b ? 'la fianza del aval no existe'
            : b.kind !== 'bond' ? 'el contrato del aval no es una fianza'
            : b.state !== 'posted' ? `la fianza del aval está ${b.state}, no activa`
            : b.seller !== p.vouch.voucher ? 'la fianza no la puso el avalador declarado'
            : b.vouchee !== p.vouch.vouchee ? 'la fianza no avala a este remitente'
            : b.beneficiary !== p.vouch.beneficiary ? 'la fianza no tiene al receptor como beneficiario'
            : b.verifier !== p.vouch.beneficiary ? 'el receptor no puede ejecutar la fianza (no es su verificador)'
            : null;
          if (malo) { rejected.push({ to, code: 403, reason: `invalid vouch: ${malo}` }); continue; }
          mails.push({ local, envelope: env, meta: { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid, vouched_by: b.seller, vouch_bond: b.id } });
        } else {
          mails.push({ local, envelope: env, meta: { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid } });
        }
      } catch (e) {
        if (e instanceof LibroError) {
          if (e.code === 402 && p.stamp && !x402req) x402req = { to, price: p.stamp.price };
          rejected.push({ to, code: e.code, reason: e.message }); continue;
        }
        throw e;
      }
      accepted.push(to);
    }

    // Un solo commit: buzones + estampillas + dedupe, juntos. En D1 es un batch atómico:
    // una reentrega concurrente no duplica buzón ni cobra la estampilla dos veces (invariante 4).
    const union = [...yaAceptados, ...accepted];
    if (accepted.length) {
      await this.store.inboundCommit({
        seen: { id: env.id, rec: { from: env.from, accepted: union } },
        mails, libro: libroBundles,
      });
      for (const m of mails) { this._push(m.local, env); this._notifyEmail(m.local, env); }
      // NX-502: un pedido de pago o su confirmación declaran EN CLARO { kind, request_id, currency }
      // (extensión firmada); el contenido con el monto y la cuenta va cifrado y la casa no lo ve.
      // Se anota como evento, nunca como asiento: es dinero real fuera del Libro.
      if (mails.length) await this._eventoDeCobro(env, mails[0].local);
    }
    for (const rc of recibosPendientes) await this._systemSend('libro', rc.to, { in_reply_to: env.id, thread: rc.thread || env.thread || null, content: { media: MEDIA.recibo, body: rc.body } });
    // Avisos de plazo: sobres del Libro programados para el futuro (un escrow que llega a su
    // deadline, una fianza que vence). No desaparecen mudos: llegan a las partes en la fecha.
    for (const av of avisosPendientes) await this._systemSend('libro', av.to, { thread: av.thread || null, content: { media: MEDIA.recibo, body: av.body }, deliverAfter: av.deliver_after });

    if (!union.length) return { ok: false, code: rejected[0].code, reason: rejected[0].reason, rejected, accepted: [], ...(x402req ? { x402: { required: x402req } } : {}) };
    return { ok: true, code: 202, accepted: union, rejected, results, ...(seen ? { duplicate: true } : {}), ...(x402pago ? { x402: { settled: x402pago } } : x402req ? { x402: { required: x402req } } : {}) };
  }

  // Traduce el resultado de `inbound` al cable de x402. Dos casos y nada más:
  //   se cobró estampilla  -> PAYMENT-RESPONSE con el id del asiento como `transaction`
  //   faltaba la estampilla -> PAYMENT-REQUIRED con el precio del buzón
  // El id del asiento no es adorno: cualquiera puede pedirlo al Libro, que es lo que un explorador
  // hace con un hash de transacción. Si no hay nada que decir, no se pone ninguna cabecera.
  _cabecerasX402(r) {
    try {
      if (r.x402?.settled) {
        const s = r.x402.settled;
        return { headers: { 'payment-response': x402.cabeceraLiquidacion(x402.liquidacion({ transaction: s.asiento, payer: s.payer, amount: s.price })) } };
      }
      if (r.x402?.required) {
        const q = r.x402.required;
        const { local } = parseAddress(q.to);
        return { headers: { 'payment-required': x402.cabeceraRequerido(x402.requisitos({
          url: `https://${this.domain}/x402/inbox/${encodeURIComponent(local)}`, amount: q.price, payTo: q.to, flow: 'upfront',
          description: `Delivery of one signed envelope into the mailbox of ${q.to}`,
          serviceName: this.domain, tags: ['nyx5', 'mailbox'],
          error: `delivery into ${q.to} costs ${q.price} tok; the envelope carried no valid stamp`,
        })) } };
      }
    } catch (e) { this.log(`x402: no se pudo armar la cabecera: ${e.message}`); }
    return {};
  }

  // Los avisos por webhook se acumulan para que el ciclo (y ctx.waitUntil en el edge) los espere:
  // una promesa suelta la cancela el runtime al cerrar el request y el aviso nunca sale.
  _push(local, env) {
    const pendiente = Promise.resolve(this.store.getAgent(local)).then((rec) => {
      if (!rec?.webhook) return;
      const body = JSON.stringify({ envelope: env });
      const sig = signBytes(`push:${env.id}`, this.keys);
      return this.fetch(rec.webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nyx5-push': `domain=${this.domain}; kid=${this.keys.sig}; sig=${sig}` }, body, signal: AbortSignal.timeout(5000) });
    }).catch((e) => this.log(`webhook ${local} falló: ${e.message} / ${e.cause?.message}`));
    this._pushes.push(pendiente);
    return pendiente;
  }
  // Aviso por email: si el agente registró `notify_email` y la casa tiene proveedor de salida, le
  // llega un correo cuando alguien le escribe un mensaje real. No avisa por recibos del Libro ni
  // rebotes del postmaster (ruido), ni por lo que el propio destinatario se manda por el puente.
  _notifyEmail(local, env) {
    if (!this.email.provider) return;
    const pendiente = Promise.resolve(this.store.getAgent(local)).then(async (rec) => {
      if (!rec?.notify_email) return;
      let fromLocal = ''; try { fromLocal = parseAddress(env.from).local; } catch { /* remitente de pasarela */ }
      if (env.type === 'receipt' || fromLocal === 'libro' || fromLocal === 'postmaster') return;
      const emailOrig = env.extensions?.['urn:nyx5:ext:email']?.from;
      if (emailOrig && emailOrig === rec.notify_email) return; // no te avises de tu propio correo
      const quien = emailOrig || env.from;
      // Texto aprobado por Nicholas el 14-sep-2026: remitente, proyecto y hora (lo único que la casa
      // sabe: el contenido va cifrado), y dónde leerlo según el aparato. Sin avisos de recibos.
      const proyecto = proyectoDe(env);
      const cuando = new Date(env.created || Date.now()).toUTCString().replace(/:\d\d GMT$/, ' UTC');
      await this.emailOut({ fromAgent: `${local}@${this.domain}`, to: rec.notify_email,
        subject: `${quien} wrote to you on Nyx5${proyecto ? ` (project ${proyecto})` : ''}`,
        text: `${quien} wrote to ${local}@${this.domain}${proyecto ? ` · project: ${proyecto}` : ''} · ${cuando}. The content is encrypted and only your key opens it. On your Mac: https://${this.domain}/app. From your phone, ask your Claude for your mailbox (replies to what your phone Claude sends arrive there, not here).` });
    }).catch((e) => this.log(`notify_email ${local} falló: ${e.message}`));
    this._pushes.push(pendiente);
    return pendiente;
  }
  // Espera los avisos en vuelo y vacía la lista.
  flushPushes() { const p = this._pushes; this._pushes = []; return Promise.allSettled(p); }

  // ---------- índice federado (opcional) ----------
  // Cualquier casa puede correr un índice: registra casas verificables, rastrea sus directorios
  // públicos y sirve la búsqueda. El índice es una PISTA, no una autoridad: cada tarjeta se
  // verifica igual por la cadena normal (DNS -> dominio -> agente) al momento de usarla.
  async indexAddHouse(domain) {
    domain = String(domain || '').toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain)) throw Object.assign(new Error('invalid domain'), { status: 400 });
    const houses = await this.store.indexListHouses();
    if (houses.length >= this.index.maxHouses && !houses.some((h) => h.domain === domain)) throw Object.assign(new Error('index full'), { status: 507 });
    // La verificación ES la puerta: solo se lista lo que resuelve y firma como casa Nyx5.
    const dc = await this.resolver.domainCard(domain).catch((e) => { throw Object.assign(new Error(`house could not be verified: ${e.message}`), { status: 422 }); });
    const h = { domain, estafeta: dc._estafeta, added: iso(), last_ok: null, fails: 0 };
    await this.store.indexPutHouse(h);
    await this._indexCrawlHouse(h);
    return h;
  }
  async _indexCrawlIfDue() {
    if (now() - this._lastCrawl < this.index.crawlMinutes * 60_000) return;
    this._lastCrawl = now();
    for (const h of await this.store.indexListHouses()) await this._indexCrawlHouse(h).catch((e) => this.log(`índice: ${h.domain} falló: ${e.message}`));
  }
  async _indexCrawlHouse(h) {
    try {
      const dc = await this.resolver.domainCard(h.domain); // re-verifica firma y ancla en cada pasada
      const cards = [];
      // La casa del índice también es una casa: su directorio se lee local. Pedírselo por su
      // propia URL pública no funciona (el Worker no puede llamarse a sí mismo) y además sobra.
      const propia = h.domain === this.domain;
      for (let offset = 0; offset < 2000;) {
        let page;
        if (propia) {
          page = await this.directory({ limit: 200, offset });
        } else {
          const res = await this.fetch(`${dc._estafeta}/agents?limit=200&offset=${offset}`, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`GET /agents -> ${res.status}`);
          page = await res.json();
        }
        const batch = page.agents || [];
        // Solo tarjetas cuya certificación firma el dominio: el índice no ingiere lo que no verifica.
        const domainKeys = dc.keys.map((k) => k.sig);
        for (const c of batch) if (domainKeys.includes(c.certification?.kid) && verifyObject(c, c.certification.kid, 'certification')) cards.push({ ...c, _house: h.domain });
        offset += batch.length;
        if (batch.length < 200 || offset >= page.total) break;
      }
      // Reputación y precio (NX-302): cada tarjeta lleva su puntaje arbitrado, leído del historial
      // público de SU casa (§21). La propia casa se lee local; las ajenas por HTTP, de a pocas.
      h.reputacion = await this._indexReputacion(cards, dc, propia);
      for (const c of cards) c._price_min = precioMinimo(c);
      await this.store.indexReplaceAgents(h.domain, cards);
      h.last_ok = iso(); h.fails = 0; h.agents = cards.length;
      await this.store.indexPutHouse(h);
    } catch (e) {
      h.fails = (h.fails || 0) + 1; h.last_error = `${iso()} ${e.message}`;
      await this.store.indexPutHouse(h);
      throw e;
    }
  }
  // Puntaje de cada tarjeta a partir del historial de su casa. Devuelve el DENOMINADOR: cuántas
  // se pidieron, cuántas quedaron con puntaje, cuántas sin historial, cuántas de una casa que no
  // distingue arbitrados (versión anterior de Nyx5) y cuántas fallaron al pedirse. Una falla no
  // tumba el rastreo: esa tarjeta entra sin puntaje (al final del orden), y el número queda escrito.
  async _indexReputacion(cards, dc, propia) {
    const cuenta = { pedidas: cards.length, con_puntaje: 0, sin_historial: 0, sin_arbitrados: 0, fallidas: 0 };
    const anotar = (c, hist) => { const r = puntajeDe(hist); c._score = r.score; c._jobs_done = r.jobs_done; if (r.motivo) cuenta[r.motivo] += 1; else cuenta.con_puntaje += 1; };
    const localDe = (c) => String(c.address).slice(0, String(c.address).lastIndexOf('@'));
    const fallo = (c, e) => { cuenta.fallidas += 1; this.log(`índice: sin historial de ${c.address}: ${e.message}`); };
    for (const c of cards) { c._score = null; c._jobs_done = null; }
    if (propia) {
      // Local, y los contratos se leen una vez para todas las tarjetas.
      const contratos = await this.store.libroListContracts();
      for (const c of cards) { try { anotar(c, await this.libro.historial(c.address, { contratos })); } catch (e) { fallo(c, e); } }
      return cuenta;
    }
    // Casa ajena: en lotes por GET /agents/historial?addresses=… (NX-905), una subpetición por cada
    // HISTORIAL_LOTE_MAX tarjetas en vez de una por tarjeta. Una casa de una versión anterior no
    // tiene la ruta (404): desde ahí se pide de a una, como antes, de a pocas a la vez.
    let enLote = true;
    for (let i = 0; i < cards.length; i += HISTORIAL_LOTE_MAX) {
      const lote = cards.slice(i, i + HISTORIAL_LOTE_MAX);
      if (enLote) {
        let respuesta = null;
        try {
          const res = await this.fetch(`${dc._estafeta}/agents/historial?addresses=${encodeURIComponent(lote.map(localDe).join(','))}`, { signal: AbortSignal.timeout(10_000) });
          if (res.status === 404) enLote = false;
          else if (!res.ok) throw new Error(`historial en lote -> ${res.status}`);
          else respuesta = await res.json();
        } catch (e) { this.log(`índice: el lote de historiales de ${dc.domain || ''} falló (${e.message}); se pide de a uno`); }
        if (respuesta) {
          for (const c of lote) { const h = respuesta.historiales?.[localDe(c)]; if (h) anotar(c, h); else fallo(c, new Error('missing from the batch reply')); }
          continue;
        }
      }
      const POCAS = 4;
      for (let j = 0; j < lote.length; j += POCAS) {
        await Promise.all(lote.slice(j, j + POCAS).map(async (c) => {
          try {
            const res = await this.fetch(`${dc._estafeta}/agents/${encodeURIComponent(localDe(c))}/historial`, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`historial -> ${res.status}`);
            anotar(c, await res.json());
          } catch (e) { fallo(c, e); }
        }));
      }
    }
    return cuenta;
  }
  // ---------- puente de correo (urn:nyx5:ext:email) ----------
  // ENTRADA: un email real entra al buzón del destinatario como sobre SIN FIRMA, marcado
  // from_verified:false y via:'email'. No pasa por /inbound ni finge estar firmado (invariante 1).
  async receiveEmail({ from, to, subject, text, messageId } = {}) {
    await this.init();
    if (!isEmailAddress(from)) return { ok: false, code: 400, reason: 'invalid email sender' };
    let local, dom;
    try { ({ local, domain: dom } = parseAddress(to)); } catch { return { ok: false, code: 400, reason: 'invalid recipient' }; }
    if (dom !== this.domain) return { ok: false, code: 400, reason: `the email is for ${dom}, not ${this.domain}` };
    const rec = await this.store.getAgent(local);
    if (!rec || !await this._visibleA(rec, from)) return { ok: false, code: 404, reason: 'no such agent' };
    // La política del buzón manda también aquí. Antes no: la puerta del correo se saltaba la
    // estampilla, la lista blanca y la prueba de trabajo. El adaptador del edge convierte este
    // rechazo en un rechazo SMTP, así que el remitente recibe un rebote de su propio proveedor y
    // la casa no manda correo a una dirección que no verificó (nada de backscatter).
    const pol = applyEmailPolicy(rec, from);
    if (!pol.ok) return { ok: false, code: pol.code, reason: pol.reason };
    // Y un buzón abierto tampoco es un embudo infinito: se limita por dominio del remitente.
    if (!await this.rate.allow(`email:${String(from).slice(String(from).lastIndexOf('@') + 1).toLowerCase()}`)) {
      return { ok: false, code: 429, reason: 'rate limit for the sending domain' };
    }
    const env = inboundEnvelope({ from, to: `${local}@${this.domain}`, subject, text, messageId });
    // dedupe por id (message-id del correo o uuid) igual que un sobre normal
    const nuevo = await this.store.markSeenIfNew(env.id, { from: `email:${from}`, accepted: [to] });
    if (!nuevo) return { ok: true, code: 200, duplicate: true };
    await this.store.putMail(local, env, { from_verified: false, via: 'email', email_from: from });
    this._push(local, env);
    return { ok: true, code: 202, to: `${local}@${this.domain}` };
  }
  // SALIDA: un agente le escribe a una dirección de correo. Con proveedor, se envía (Reply-To = el
  // agente, para que la respuesta vuelva por ENTRADA). Sin proveedor, queda pendiente: no se inventa canal.
  async emailOut({ fromAgent, to, subject, text }) {
    // Cerrado por defecto (11-sep-2026, revisión antes de que Nicholas se fuera un mes): con el
    // registro abierto, "cualquier agente le escribe a cualquier correo" era un relé de spam con
    // nuestra cuenta de envío y nuestro dominio. Sólo escriben las direcciones que la casa autoriza.
    if (!this.email.senders.has(String(fromAgent || '').toLowerCase())) return { ok: false, code: 403, reason: 'outbound email is closed in this house: only addresses the house authorizes can write to people by email' };
    if (!isEmailAddress(to)) return { ok: false, code: 400, reason: 'invalid email destination' };
    // El pie viaja solo si la casa lo enciende (`email.footer`). Apagado por defecto: el texto
    // que un tercero recibe es decisión del operador de la casa, no del código.
    const payload = outboundPayload({ fromAgent, to, subject, text, footer: this.email.footer === true, domain: this.domain });
    if (!this.email.provider) return { ok: false, code: 503, pending: true, reason: 'the email bridge has no outbound provider configured' };
    try { const r = await this.email.provider(payload); return { ok: true, code: 202, provider: r?.id || null }; }
    catch (e) { return { ok: false, code: 502, reason: `the email provider failed: ${e.message}` }; }
  }

  // `params` crudos (strings de URL o argumentos de la herramienta): se validan aquí, así el
  // método y la ruta rechazan lo mismo (400 cursor/filtro inválido, 410 recorrido caduco).
  async indexSearch(params) {
    const out = await this.store.indexSearch(validarFiltros(params));
    // Respuesta firmada por la casa del índice: otro índice (u otra casa) puede ingerirla verificada.
    // `total` es lo que cumple los filtros hoy; `next_cursor` es null en la última página.
    return signObject({ nyx5: '1', index: this.domain, issued: iso(), ...out }, this.keys);
  }

  // ---------- HTTP (agnóstico de runtime) ----------
  // rx = { method, path, query: URLSearchParams, headers: {minúsculas}, body: objeto|null, ip }
  async handleRequest(rx) {
    await this.init();
    const path = rx.path;
    const send = (status, body, headers = null) => (headers ? { status, body, headers } : { status, body });
    // Un 429 dice cuándo volver: Retry-After en segundos hasta la ventana siguiente.
    const tarde = (body) => send(429, body, this._retryAfter());
    // Un segmento que no se puede decodificar (`%E0%A4%A`) se usa TAL CUAL: nunca es un nombre
    // válido, así que cae al mismo 404/400 que un inexistente. Antes decodeURIComponent lanzaba
    // URIError y la ruta contestaba 500 (revisión adversarial del 14-sep).
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    let m;
    try {
      if (rx.method === 'GET' && path === '/health') return send(200, { ok: true, domain: this.domain, agents: (await this.store.listAgents()).length, queue: (await this.store.listQueue()).length });
      // ----- Conector MCP remoto: OAuth + /mcp -----
      if (this.remoto.enabled && rutaCors(path)) {
        if (rx.method === 'OPTIONS') return { status: 204, headers: CORS, contentType: 'text/plain', body: '' };
        const r = await this._rutaRemota(rx);
        if (r) return { ...r, headers: { ...CORS, ...(r.headers || {}) } };
      }
      if (this.remoto.enabled && rx.method === 'GET' && path === '/oauth/authorize') return oauth.paginaAutorizar(this, rx.query, APP_HTML);
      if (this.remoto.enabled && rx.method === 'POST' && path === '/oauth/prepare') return oauth.preparar(this, rx);
      if (this.remoto.enabled && rx.method === 'POST' && path === '/oauth/approve') return oauth.aprobar(this, rx);
      // ----- Invitaciones de contacto: un link que se manda por WhatsApp -----
      if (this.remoto.enabled && rx.method === 'POST' && path === '/contact-invites') return this.crearInvitacion(rx);
      if (this.remoto.enabled && rx.method === 'GET' && (m = /^\/i\/([A-Za-z0-9_-]{16,64})$/.exec(path))) return this._paginaInvitacion(m[1], rx.query.get('source'), rx.ip);
      // ----- Asistentes (sólo la casa los configura; el dueño los pide) -----
      if ((m = /^\/admin\/assistants(?:\/([^/]+))?(?:\/(knowledge|config|pause|resume))?$/.exec(path))) {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house configures assistants' });
        return this._adminAsistente(rx, m[1] ? dec(m[1]).toLowerCase() : null, m[2] || null);
      }
      // ----- Ficha pública: la edita el dueño de la dirección o el dueño de su delegación -----
      if (rx.method === 'POST' && (m = /^\/agents\/([^/]+)\/profile$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        const l = dec(m[1]).toLowerCase();
        const rec = Estafeta.validLocal(l) ? await this.store.getAgent(l) : null;
        if (!rec || rec.revoked) return send(404, { reason: 'no such agent' });
        // Una dirección de sólo mensajes no edita ficha alguna, ni la suya: lo que se publica en
        // nombre del dueño lo escribe el dueño (revisión del 13-sep-2026).
        if (who.record.delegation?.scope?.messages_only) return send(403, { reason: 'a messages-only address cannot edit a profile' });
        if (who.local !== l && who.address !== rec.delegation?.by) return send(403, { reason: 'only the owner of an address (or of its delegation) edits its profile' });
        const v = validarPerfil(rx.body?.profile === undefined ? null : rx.body.profile);
        if (v.error) return send(400, { reason: v.error });
        // El validador no ve la tarjeta: el precio en dólares se cruza aquí con la billetera declarada.
        { const e = usdSinBilletera(v.perfil, rec.wallets || (rec.wallet ? [rec.wallet] : [])); if (e) return send(400, { reason: e }); }
        // Re-certificar sin tocar nada más: mismas llaves, misma delegación, mismo buzón.
        const { certification: _c, webhook, notify_email, ...cuerpo } = rec;
        const card = signObject({ ...cuerpo, profile: v.perfil ? { ...v.perfil, updated: iso() } : undefined }, this.keys, 'certification');
        await this.store.putAgent(l, { ...card, webhook, notify_email });
        this.resolver.invalidate(`agent:${l}@${this.domain}`);
        return send(200, { address: card.address, profile: card.profile || null });
      }
      // ----- Presencia: «visto por última vez», sólo con opt-in del dueño -----
      if (rx.method === 'GET' && (m = /^\/agents\/([^/]+)\/presence$/.exec(path))) {
        if (!await this.rate.allow(`resolve:${rx.ip || 'x'}`)) return tarde({ reason: 'too many requests' });
        const l = dec(m[1]).toLowerCase();
        if (!Estafeta.validLocal(l)) return send(400, { reason: 'invalid agent name' });
        // Un inexistente contesta «sin presencia»; un secreto, a quien no lo ve, exactamente lo mismo.
        const quien = await this._quienPregunta(rx, path);
        const visible = await this._visibleA(await this.store.getAgent(l), quien);
        return send(200, { address: `${l}@${this.domain}`, last_seen: visible ? await this.presenciaDe(l) : null });
      }
      // ----- Grupos: crear, ver miembros, agregar, quitar, irse -----
      if (rx.method === 'POST' && path === '/groups') {
        const who = await this._authenticate(rx, path);
        const r = await this.crearGrupo(who, rx.body || {});
        return send(r.status, r.body);
      }
      if ((m = /^\/groups\/([^/]+)\/members$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        const l = dec(m[1]).toLowerCase();
        if (!Estafeta.validLocal(l)) return send(400, { reason: 'invalid group name' });
        const r = rx.method === 'GET' ? await this.miembrosGrupo(who, l) : rx.method === 'POST' ? await this.editarGrupo(who, l, rx.body || {}) : { status: 405, body: { reason: 'method not allowed here' } };
        return send(r.status, r.body);
      }
      // ----- Contactos: la casa conecta dos direcciones suyas en los dos sentidos -----
      if (rx.method === 'POST' && path === '/admin/contacts') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house connects contacts' });
        const between = Array.isArray(rx.body?.between) ? rx.body.between : [];
        const r = await this.conectarContactos(between[0], between[1]);
        return send(r.status, r.body);
      }
      // ----- La app en la pantalla de inicio -----
      if (rx.method === 'GET' && path === '/manifest.webmanifest') return { status: 200, contentType: 'application/manifest+json', body: JSON.stringify(MANIFIESTO) };
      if (rx.method === 'GET' && (m = /^\/(?:icon-(180|192|512)|apple-touch-icon)\.png$/.exec(path))) return { status: 200, contentType: 'image/png', body: Buffer.from(ICONOS[m[1] || 180], 'base64') };
      // Cliente web para personas: se sirve desde la propia casa (mismo origen, sin CORS).
      // El HTML genera las llaves en el navegador del usuario; la casa nunca las ve.
      // La portada muestra prueba de vida REAL, leída del libro en el momento: cuántos agentes
      // hay y cuánto trabajo pagado está abierto. Un número inventado convertiría igual de bien
      // y sería mentira; uno real puede decir "1 agent" y eso también informa. Si no se puede
      // leer, la línea simplemente no aparece: la portada nunca se cae por un adorno.
      if (rx.method === 'GET' && path === '/') {
        let vivo = '';
        try {
          const agentes = (await this.store.listAgents()).filter((a) => !this.isSystem(a)).length;
          const tareas = this.tareas.enabled ? this.tareas.publicadas().length : 0;
          const partes = [`<b>${agentes}</b> agent${agentes === 1 ? '' : 's'} in this house`];
          if (tareas) partes.push(`<b>${tareas}</b> paid task${tareas === 1 ? '' : 's'} open`);
          vivo = partes.join(' · ');
        } catch (e) { this.log(`prueba de vida no disponible: ${e.message}`); vivo = ''; }
        return { status: 200, body: HOME_HTML.replace('<!--VIVO-->', vivo), contentType: 'text/html; charset=utf-8' };
      }
      if (rx.method === 'GET' && (path === '/app' || path === '/app/')) return { status: 200, body: APP_HTML, contentType: 'text/html; charset=utf-8' };
      // La especificación en una página, indexable. Se genera desde docs/SPEC.md (build:spec).
      if (rx.method === 'GET' && (path === '/spec' || path === '/spec/')) return { status: 200, body: SPEC_HTML, contentType: 'text/html; charset=utf-8' };
      // Términos de ESTA casa. Se sirven solo si el operador los enciende (`terms.enabled`):
      // son declaraciones vinculantes en su nombre, así que no se publican por defecto. La casa
      // tiene registro abierto y emite tokens; sin términos, el primero que la use para spam o
      // el primero que pregunte qué es el token encuentra la nada.
      if (rx.method === 'GET' && (path === '/terms' || path === '/terms/') && this.terms) {
        return { status: 200, contentType: 'text/html; charset=utf-8', body: this.terms };
      }
      // El libro de la casa, en público. Se calcula al pedirlo: así nunca está viejo, y no hay
      // un trabajo de fondo que pueda fallar en silencio dejando publicado un número de hace un
      // mes. Sin nombres, sin contrapartes y sin contenido: solo cuántos y cuánto.
      if (rx.method === 'GET' && (path === '/report' || path === '/report/')) {
        try {
          const dias = Math.min(90, Math.max(1, Number(rx.query.get('days') || 7) || 7));
          return { status: 200, contentType: 'text/html; charset=utf-8', body: informeHtml(this.domain, await datosInforme(this, { dias })) };
        } catch (e) {
          // Un informe que no se puede calcular se dice, no se inventa.
          this.log(`informe no disponible: ${e.message}`);
          return send(503, { reason: 'the ledger could not be read right now' });
        }
      }
      if (rx.method === 'GET' && path === '/report.json') {
        try { return send(200, await datosInforme(this, { dias: Math.min(90, Math.max(1, Number(rx.query.get('days') || 7) || 7)) })); }
        catch { return send(503, { reason: 'the ledger could not be read right now' }); }
      }
      // La imagen de la vista previa al compartir un enlace. Se sirve desde la casa y no desde
      // un CDN externo para no depender de nadie: si esta URL falla, el enlace se comparte pelado.
      if (rx.method === 'GET' && path === '/og.png') {
        return { status: 200, contentType: 'image/png', body: Buffer.from(OG_PNG_B64, 'base64') };
      }
      // Un favicon en línea: sin esto el navegador pide /favicon.ico en cada visita y se lleva
      // un 404. SVG porque pesa 200 bytes y escala en cualquier pantalla.
      if (rx.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.svg')) {
        return { status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0c0c10"/><text x="32" y="43" font-family="ui-monospace,Menlo,monospace" font-size="30" font-weight="600" fill="#9b8cff" text-anchor="middle">n5</text></svg>' };
      }
      if (rx.method === 'GET' && path === '/robots.txt') {
        return { status: 200, contentType: 'text/plain; charset=utf-8', body: `User-agent: *\nAllow: /\n# Los buzones y el Libro exigen firma; no hay nada que rastrear ahí.\nDisallow: /mailbox/\nDisallow: /libro/\nDisallow: /outbox/\nSitemap: https://${this.domain}/sitemap.xml\n` };
      }
      if (rx.method === 'GET' && path === '/sitemap.xml') {
        const paginas = ['/', '/spec', '/app', '/report', '/llms.txt'].concat(this.tareas.enabled ? ['/tareas'] : []);
        const hoy = iso().slice(0, 10);
        return { status: 200, contentType: 'application/xml; charset=utf-8',
          body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paginas.map((u) => `  <url><loc>https://${this.domain}${u}</loc><lastmod>${hoy}</lastmod></url>`).join('\n')}\n</urlset>\n` };
      }
      if (rx.method === 'GET' && path === '/llms.txt') return { status: 200, body: LLMS_TXT, contentType: 'text/plain; charset=utf-8' };
      // ---------- x402: el estándar de "402 Payment Required" para agentes ----------
      // La casa es su propio facilitador: verifica y liquida contra su propio Libro. El spec lo
      // permite ("or host the endpoints themselves"), y así no hay un tercero en el camino del
      // dinero. Ver docs/interop/x402.md, que dice también qué NO reclamamos.
      if (rx.method === 'GET' && (path === '/x402/supported' || path === '/x402/supported/')) {
        const card = await this.domainCard();
        return send(200, x402.soportado(this.domain, (card.keys || []).map((k) => k.sig).filter(Boolean)));
      }
      // El recurso pagable que esta casa ya tenía: entregar en un buzón con estampilla. Un cliente
      // x402 hace GET aquí y lee el precio antes de componer nada. Un buzón gratis contesta 200 y
      // lo dice: "no hay nada que pagar" es una respuesta, no un error.
      const mX402 = rx.method === 'GET' ? /^\/x402\/inbox\/([^/]+)$/.exec(path) : null;
      if (mX402) {
        const local = dec(mX402[1]).toLowerCase();
        const quien = await this._quienPregunta(rx, path);
        const rec = await this.store.getAgent(local);
        if (!rec || !await this._visibleA(rec, quien)) return send(404, { reason: 'no such agent' });
        const precio = rec.inbox?.policy === 'stamp' ? (rec.inbox.price ?? 1) : 0;
        const url = `https://${this.domain}/x402/inbox/${encodeURIComponent(local)}`;
        if (!precio) return send(200, { x402Version: x402.X402_VERSION, free: true, resource: { url }, reason: `${local}@${this.domain} does not charge for delivery` });
        const pr = x402.requisitos({
          url, amount: precio, payTo: `${local}@${this.domain}`, flow: 'upfront',
          description: `Delivery of one signed envelope into the mailbox of ${local}@${this.domain}`,
          serviceName: this.domain, tags: ['nyx5', 'mailbox'],
          error: `delivery into this mailbox costs ${precio} tok; send the envelope to POST /inbound with a stamp field`,
        });
        // Segunda forma de pago: dólares de verdad, si el agente declaró a dónde cobrarlos y a qué
        // precio. NO convertimos tokens a dólares: inventar un tipo de cambio sería justo la cifra
        // sin respaldo que este protocolo existe para encarecer. El precio en dólares lo pone el
        // agente o no hay opción en dólares.
        // Una entrada por cada red que el agente declaró Y que sabemos liquidar. El estándar dice
        // que `accepts` es una lista y que el cliente elige, así que ofrecer una sola red sería
        // desperdiciar el mecanismo: quien sólo puede pagar en una cadena encuentra la suya.
        const ws = rec.wallets || (rec.wallet ? [rec.wallet] : []);
        if (ws.length && Number.isInteger(rec.inbox?.price_usd) && rec.inbox.price_usd > 0) {
          for (const w of ws) {
            const t = x402.TOKEN_USD[w?.network];
            if (!t || !w?.address) continue;
            pr.accepts.push(...x402.requisitosEvm({
              url, amount: rec.inbox.price_usd, payTo: w.address, network: w.network,
              asset: t.asset, tokenName: t.name, tokenVersion: t.version,
            }).accepts);
          }
        }
        // Catalogable: el facilitador que vea este 402 puede publicarlo en su directorio, que es
        // donde un agente busca. Se declara lo que se vende de verdad, no una promesa más grande.
        pr.extensions = { bazaar: x402.bazaarBuzon({ url, direccion: `${local}@${this.domain}` }) };
        return { status: 402, body: pr, headers: { 'payment-required': x402.cabeceraRequerido(pr) } };
      }
      if (rx.method === 'GET' && path === '/.well-known/nyx5.json') return send(200, await this.domainCard());
      // Reputación = una consulta al libro. Es PÚBLICA a propósito: sirve justamente para que
      // un desconocido decida antes de contratar, igual que la tarjeta. No expone contenido ni
      // contrapartes: solo cuántas entregas, cuántas fianzas y cuántos tokens se movieron.
      // Historial en LOTE (NX-905): el rastreo del índice pedía uno por agente, 1+N subpeticiones
      // por casa ajena, y el edge las tiene contadas. Público como el individual, hasta 50
      // direcciones por petición, limitado por IP. Una dirección que no existe, que es de otra
      // casa o que es secreta para quien pregunta vale `null`: la misma respuesta, sin oráculo.
      // `requested`/`found` son el denominador: cuántas se pidieron y cuántas se resolvieron.
      if (rx.method === 'GET' && path === '/agents/historial' && rx.query.has('addresses')) {
        if (!await this.rate.allow(`historial:${rx.ip || 'x'}`)) return tarde({ reason: 'too many requests' });
        const pedidas = [...new Set(String(rx.query.get('addresses')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
        if (!pedidas.length) return send(400, { reason: 'addresses must list at least one address, separated by commas' });
        if (pedidas.length > HISTORIAL_LOTE_MAX) return send(400, { reason: `addresses: at most ${HISTORIAL_LOTE_MAX} per request, got ${pedidas.length}` });
        const quien = await this._quienPregunta(rx, path);
        // Los contratos se leen UNA vez para todo el lote, no una por dirección.
        const contratos = await this.store.libroListContracts();
        const historiales = {};
        for (const dir of pedidas) {
          let local = dir, dom = this.domain;
          if (dir.includes('@')) { try { ({ local, domain: dom } = parseAddress(dir)); } catch { historiales[dir] = null; continue; } }
          const rec = dom === this.domain && Estafeta.validLocal(local) ? await this.store.getAgent(local) : null;
          historiales[dir] = rec && await this._visibleA(rec, quien) ? await this.libro.historial(`${local}@${this.domain}`, { contratos }) : null;
        }
        return send(200, { house: this.domain, requested: pedidas.length, found: Object.values(historiales).filter(Boolean).length, historiales });
      }
      if (rx.method === 'GET' && (m = /^\/agents\/([^/]+)\/historial$/.exec(path))) {
        const local = dec(m[1]).toLowerCase();
        const quien = await this._quienPregunta(rx, path);
        const rec = Estafeta.validLocal(local) ? await this.store.getAgent(local) : null;
        if (!rec || !await this._visibleA(rec, quien)) return send(404, { reason: 'no such agent' });
        return send(200, await this.libro.historial(`${local}@${this.domain}`));
      }
      // ----- Notaría (NX-601): verificación PÚBLICA de sellos, sin cuenta. Se limita por IP como
      // /resolve. Un hash sin sellos y un id inexistente contestan el mismo 404. El nombre del
      // declarante se muestra sólo si «nadie» lo vería (_visibleA con quien = null).
      if (rx.method === 'GET' && (m = /^\/notaria\/(?:sello\/([^/]+)|([0-9a-fA-F]{64}))$/.exec(path))) {
        if (!await this.rate.allow(`notaria:${rx.ip || 'x'}`)) return tarde({ reason: 'too many requests' });
        let idSello = null; if (m[1]) { idSello = dec(m[1]); }
        const docs = idSello ? [await this.store.notariaGet(idSello)].filter(Boolean) : await this.store.notariaList(m[2].toLowerCase());
        if (!docs.length) return send(404, { reason: 'no such seal' });
        const seals = [];
        for (const d of docs) seals.push(selloPublico(d, await this._declaranteVisible(d)));
        return m[1] ? send(200, seals[0]) : send(200, { sha256: m[2].toLowerCase(), house: this.domain, seals });
      }
      if (rx.method === 'GET' && (m = /^\/agents\/([^/]+)$/.exec(path))) {
        // Un secreto responde a quien no lo ve EXACTAMENTE lo que un inexistente: mismo cuerpo,
        // mismas cabeceras. Lo cuida test/visibilidad.test.js comparando los dos byte a byte.
        // Quién pregunta se resuelve ANTES de mirar si existe: el orden es parte de la igualdad.
        const quien = await this._quienPregunta(rx, path);
        const card = await this.agentCard(dec(m[1]).toLowerCase());
        if (!card || !await this._visibleA(card, quien)) return send(404, { reason: 'no such agent' });
        return send(200, card);
      }
      if (rx.method === 'GET' && path === '/agents') {
        const p = Object.fromEntries(rx.query);
        return send(200, await this.directory({ capability: p.capability, accepts: p.accepts, q: p.q, limit: p.limit ?? 50, offset: p.offset ?? 0 }));
      }
      if (rx.method === 'POST' && path === '/agents') {
        const body = rx.body || {};
        const local = String(body.local || '').toLowerCase();
        if (!Estafeta.validLocal(local)) return send(400, { reason: 'invalid agent name' });
        const previo = await this.store.getAgent(local);
        const exists = !!previo;
        const isAdmin = (rx.headers.authorization || '') === `Bearer ${this.adminToken}`;
        let ok = isAdmin, via = 'admin';
        if (!ok && rx.headers.authorization?.startsWith('Nyx5 ')) {
          const who = await this._authenticate(rx, path);
          ok = who.local === local || (body.delegation && who.address === body.delegation.by);
          via = body.delegation ? 'delegation' : 'self';
        }
        if (!ok) {
          // Auto-registro: el cuerpo viene firmado por la clave que se inscribe (prueba de posesión).
          // «Nombre tomado» también confirma existencia: un secreto recorre el MISMO camino que un
          // nombre que no existe (firma, fecha, tasa, invitación) y recién al final recibe el 409 de
          // un nombre reservado por el protocolo, que es donde lo recibiría un reservado de verdad.
          const secreto = exists && previo.visibility === 'secret';
          if (exists && !secreto) return send(409, { reason: 'that name is taken; only its owner or the house can update it' });
          if (!body.signature || body.signature.kid !== body.sig || !verifyObject(body, body.sig)) return send(401, { reason: 'to self-register, sign the body with the same sig key you are enrolling (proof of possession)' });
          if (Math.abs(now() - Date.parse(body.ts || 0)) > 300_000) return send(401, { reason: 'the signed request needs a ts (ISO) within 5 minutes' });
          if (!await this.regRate.allow(rx.ip || 'x')) return tarde({ reason: 'too many registrations from this address' });
          if (this.policy.registration === 'open') via = 'open';
          else if (this.policy.registration === 'invite') { const inv = await this._consumeInvite(body.invite); via = `invite:${inv.code}`; if (inv.welcome != null) body._welcome = inv.welcome; }
          else return send(403, { reason: `this house does not accept self-registration (registration=${this.policy.registration}); ask for an invitation` });
          if (secreto) return send(409, { reason: `name reserved by the protocol: ${local}` });
        }
        // `source` es atribución y NO entra en la tarjeta: se descarta aquí y viaja al evento.
        // `custody` y `revoked` los pone sólo la casa: nadie se declara custodiado ni des-revocado.
        const { signature: _s, ts: _t, invite: _i, _welcome, source: _src, custody: _cu, revoked: _rv, ...clean } = body;
        const card = await this.registerAgent({ ...clean, welcome: _welcome });
        this.log(`registro ${card.address} via ${via}`);
        if (!card.delegation) {
          await this._evento('join', card.address, { via, listed: card.capabilities?.listed === true, source: Estafeta.fuenteLimpia(_src) });
        }
        return send(201, { ...card, registered_via: via });
      }
      if (rx.method === 'POST' && path === '/invitations') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house issues invitations' });
        return send(201, await this.createInvite(rx.body || {}));
      }
      if (rx.method === 'GET' && path === '/invitations') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house lists invitations' });
        return send(200, { invitations: await this.store.listInvites() });
      }
      if (rx.method === 'POST' && path === '/outbound') {
        const who = await this._authenticate(rx, path);
        const r = await this.outbound(rx.body, who);
        // kick: el adaptador dispara un tick tras responder (setImmediate en Node, waitUntil en Workers)
        return { ...send(r.code || 400, r), kick: true };
      }
      if (rx.method === 'POST' && path === '/email/out') {
        // El agente autenticado le escribe a una dirección de correo del mundo real.
        const who = await this._authenticate(rx, path);
        const { to, subject, body } = rx.body || {};
        const r = await this.emailOut({ fromAgent: who.address, to, subject, text: typeof body === 'string' ? body : JSON.stringify(body) });
        return send(r.code || 400, r);
      }
      if (rx.method === 'POST' && path === '/inbound') {
        const r = await this.inbound(rx.body, rx.headers['x-nyx5-relay']);
        // pending: los avisos por webhook que nacieron aquí. El adaptador los pasa a waitUntil;
        // sin eso el runtime cancela el fetch al cerrar la respuesta y el aviso nunca sale.
        return { ...send(r.code || 400, r, r.code === 429 ? this._retryAfter() : null), ...this._cabecerasX402(r), kick: true, pending: this.flushPushes() };
      }
      if (rx.method === 'GET' && (m = /^\/mailbox\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== dec(m[1]).toLowerCase()) return send(403, { reason: 'not your mailbox' });
        const limit = Number(rx.query.get('limit') || 50);
        // los N más recientes (listMail viene en orden cronológico): con muchos mensajes viejos
        // sin ackear, slice(0,limit) escondía justo los nuevos. slice(-limit) muestra los últimos.
        return send(200, { messages: (await this.store.listMail(who.local)).slice(-limit) });
      }
      if (rx.method === 'POST' && (m = /^\/mailbox\/([^/]+)\/ack$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== dec(m[1]).toLowerCase()) return send(403, { reason: 'not your mailbox' });
        const { ids = [] } = rx.body || {};
        const acked = [];
        for (const id of ids) if (await this.store.ackMail(who.local, id)) acked.push(id);
        // Acuse de lectura (13-sep-2026), opt-in del que lee: «entregado» no decía si alguien leyó.
        // Sale de la casa, que da fe de la hora en que ese buzón confirmó; sólo la primera vez.
        if (acked.length && who.record.capabilities?.read_receipts === true) await this._acusesDeLectura(who, acked);
        return send(200, { acked });
      }
      // ----- Tiempo real, historial, conectores y tarjetas ajenas -----
      if (rx.method === 'GET' && (m = /^\/mailbox\/([^/]+)\/wait$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== dec(m[1]).toLowerCase()) return send(403, { reason: 'not your mailbox' });
        const q = Object.fromEntries(rx.query);
        const segundos = Math.max(0, Math.min(Number(q.timeout ?? 25) || 0, 90));
        const msg = await this.esperarCorreo(who.local, { from: q.from || null, thread: q.thread || null, since: q.since || null, project: q.project ? nombreDeProyecto(q.project) : null, timeoutMs: segundos * 1000 });
        return send(200, { message: msg });
      }
      if (rx.method === 'GET' && (m = /^\/conversations\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== dec(m[1]).toLowerCase()) return send(403, { reason: 'not your conversations' });
        const con = rx.query.get('with');
        const limit = Math.max(1, Math.min(Number(rx.query.get('limit') || 50) || 50, 500));
        const project = rx.query.get("project") ? nombreDeProyecto(rx.query.get("project")) : null;
        if (con) return send(200, { with: con.toLowerCase(), messages: await this.conversacion(who.local, { con: con.toLowerCase(), limit, project }) });
        return send(200, { conversations: await this.conversacion(who.local, { project }) });
      }
      if (rx.method === 'GET' && (m = /^\/delegations\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== dec(m[1]).toLowerCase()) return send(403, { reason: 'not your delegations' });
        return send(200, { delegations: await this.delegados(who.local) });
      }
      if (rx.method === 'POST' && (m = /^\/agents\/([^/]+)\/revoke$/.exec(path))) {
        const sub = dec(m[1]).toLowerCase();
        if (!Estafeta.validLocal(sub)) return send(400, { reason: 'invalid agent name' });
        const rec = await this.store.getAgent(sub);
        if (!rec?.delegation) return send(404, { reason: 'no such subagent' });
        let por;
        if ((rx.headers.authorization || '') === `Bearer ${this.adminToken}`) por = `casa@${this.domain}`;
        else {
          const who = await this._authenticate(rx, path);
          if (who.address !== rec.delegation.by && who.local !== sub) return send(403, { reason: 'only the owner who delegated it can revoke it' });
          por = who.address;
        }
        if (rec.revoked) return send(200, { address: rec.address, revoked: rec.revoked, already: true });
        const card = await this.revocarDelegado(sub, por);
        return send(200, { address: card.address, revoked: card.revoked });
      }
      // La tarjeta verificada de CUALQUIER dirección, resuelta por la casa. La app del navegador no
      // puede pedirle la tarjeta a otra casa (CSP y CORS lo impiden, y está bien), y sin la llave de
      // cifrado del destinatario tendría que mandar en claro.
      if (rx.method === 'GET' && (m = /^\/resolve\/([^/]+)$/.exec(path))) {
        if (!await this.rate.allow(`resolve:${rx.ip || 'x'}`)) return tarde({ reason: 'too many requests' });
        let addr; try { addr = dec(m[1]).toLowerCase(); parseAddress(addr); } catch { return send(400, { reason: 'invalid address' }); }
        // Para quién se resuelve: el agente de esta casa que firma la petición, si alguno. A una
        // dirección secreta de esta casa se le aplica la misma regla que en /agents/<l>; a una de
        // otra casa, la casa pregunta «para» ese agente y la otra decide.
        const quien = await this._quienPregunta(rx, path);
        try {
          if (parseAddress(addr).domain === this.domain) {
            const rec = Estafeta.validLocal(parseAddress(addr).local) ? await this.store.getAgent(parseAddress(addr).local) : null;
            if (!rec || !await this._visibleA(rec, quien)) return send(404, { reason: 'no such agent' });
          }
          const { _estafeta, _domain, delegation, ...card } = await this.resolver.agentCard(addr, { onBehalfOf: quien });
          const { _parent, ...d } = delegation || {};
          // La presencia va FUERA de la tarjeta firmada (no altera la certificación) y sólo si es de
          // esta casa y el dueño la activó.
          const p = parseAddress(addr);
          const last_seen = p.domain === this.domain ? await this.presenciaDe(p.local) : null;
          return send(200, { ...card, ...(delegation ? { delegation: d } : {}), ...(last_seen ? { presence: { last_seen } } : {}) });
        } catch (e) { return send(e.permanent ? 404 : 502, { reason: e.message }); }
      }
      // ----- Libro (lecturas directas; las operaciones van por correo a libro@) -----
      // Estado de cuenta por rango (NX-501): ?desde&hasta ISO-8601, ?formato=json|csv, ?limit.
      // La misma firma que /libro/cuenta; el dueño sólo ve su cuenta (?account= ajena → 403).
      if (rx.method === 'GET' && path === '/libro/estado') {
        const who = await this._authenticate(rx, path, { allowForeign: true });
        const p = Object.fromEntries(rx.query || []);
        const cuenta = String(p.account || who.address).toLowerCase();
        if (cuenta !== who.address) return send(403, { reason: 'not your account' });
        const formato = p.formato || 'json';
        if (!['json', 'csv'].includes(formato)) return send(400, { reason: 'formato must be json or csv' });
        const estado = await estadoDeCuenta(this.libro, cuenta, { since: p.desde, until: p.hasta, limit: p.limit, max: 1000 });
        // Diario y saldos que no cuadran es la primera señal de un libro corrompido: se anota y se
        // registra como evento, no se devuelve en silencio dentro del JSON.
        if (estado.reconciled === false) { this.log(`libro: el diario y los saldos de ${cuenta} divergen (${estado.closing_balance} vs ${estado.ledger_balance})`); await this._evento('ledger_divergence', cuenta, { closing_balance: estado.closing_balance, ledger_balance: estado.ledger_balance }); }
        if (formato === 'json') return send(200, estado);
        return { status: 200, contentType: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${nombreCsv(estado)}"` }, body: csvDe(estado) };
      }
      if (rx.method === 'GET' && (m = /^\/libro\/cuenta\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path, { allowForeign: true });
        const address = dec(m[1]).toLowerCase();
        if (who.address !== address) return send(403, { reason: 'cuenta ajena' });
        return send(200, await this.libro.account(address));
      }
      if (rx.method === 'GET' && (m = /^\/libro\/contrato\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path, { allowForeign: true });
        const c = await this.store.libroGetContract(dec(m[1]));
        if (!c) return send(404, { reason: 'contrato inexistente' });
        if (![c.seller, c.buyer, c.verifier, c.arbiter].includes(who.address)) return send(403, { reason: 'you are not a party to this' });
        return send(200, contratoPublico(c));
      }
      if (rx.method === 'POST' && path === '/libro/topup') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house tops up balances' });
        const { account, amount, concept } = rx.body || {};
        return send(201, await this.libro.topup(account, amount, concept || 'carga de la casa'));
      }
      // Los eventos son de la casa: dicen cuántos agentes llegaron y si el mecanismo se ejerce.
      // No son públicos porque juntos dibujan la actividad de la casa; el historial de cada
      // agente, que es lo que un desconocido necesita, sí lo es.
      // El catálogo es público: un agente que acaba de unirse tiene que poder leer qué hay
      // que hacer, cuánto paga y con qué prueba se comprueba, sin autenticarse.
      if (rx.method === 'GET' && path === '/tareas') {
        if (!this.tareas.enabled) return send(404, { reason: 'this house does not seed work' });
        const publicadas = this.tareas.publicadas().map((t) => ({ ...t, terms: this.tareas.terminosDe(this.tareas.tarea(t.id)) }));
        const desk = `tareas@${this.domain}`, arbiter = `verifica@${this.domain}`;
        // Los nombres viejos viajan junto a los nuevos. Renombrar un campo público rompe a TODO
        // cliente ya instalado, en silencio y sin que ninguna prueba se entere: el agente ve
        // "no hay tareas" y se va. Se mantienen hasta que ninguna versión publicada los use.
        return send(200, {
          desk, arbiter, per_agent_per_day: this.tareas.porAgenteDia,
          how: `quote the task to ${desk} as an escrow, with arbiter=${arbiter} and terms exactly equal to the published ones`,
          tasks: publicadas,
          mostrador: desk, arbitro: arbiter, tareas: publicadas, _deprecated: ['mostrador', 'arbitro', 'tareas'],
        });
      }
      // El embudo (NX-801), en PRIVADO: lleva direcciones y la fecha de cada etapa por persona,
      // así que nunca va en /report, que es público y promete no nombrar a nadie. Misma llave
      // que /eventos. Se calcula al pedirlo; si el almacén no responde, se dice, no se inventa.
      if (rx.method === 'GET' && (path === '/informe' || path === '/informe.json')) {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house reads its funnel' });
        try {
          const dias = Math.min(90, Math.max(1, Number(rx.query.get('days') || 7) || 7));
          const [d, embudo] = await Promise.all([datosInforme(this, { dias }), datosEmbudo(this)]);
          if (path === '/informe.json') return send(200, { ...d, embudo });
          return { status: 200, contentType: 'text/html; charset=utf-8', body: informeHtml(this.domain, d, { embudo }) };
        } catch (e) {
          this.log(`embudo no disponible: ${e.message}`);
          return send(503, { reason: 'the ledger could not be read right now' });
        }
      }
      if (rx.method === 'GET' && path === '/eventos') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house reads its events' });
        const p = Object.fromEntries(rx.query);
        const eventos = (await this.store.listEvents?.({ name: p.name || null, since: p.since || null, limit: Number(p.limit || 500) })) || [];
        const conteo = {};
        for (const e of eventos) conteo[e.name] = (conteo[e.name] || 0) + 1;
        return send(200, { conteo, eventos });
      }
      if (rx.method === 'GET' && path === '/libro/diario') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'only the house reads the full journal' });
        return send(200, { balances: (await this.store.libroState()).balances, journal: await this.libro.journal() });
      }
      if (rx.method === 'GET' && (m = /^\/outbox\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== dec(m[1]).toLowerCase()) return send(403, { reason: 'bandeja ajena' });
        return send(200, { sent: await this.store.listOutbox(who.local) });
      }
      // ----- Índice federado -----
      if (this.index.enabled && rx.method === 'POST' && path === '/index/houses') {
        if (!await this.rate.allow(`index:${rx.ip || 'x'}`)) return tarde({ reason: 'too many requests' });
        const h = await this.indexAddHouse((rx.body || {}).domain);
        return send(201, h);
      }
      if (this.index.enabled && rx.method === 'GET' && path === '/index/houses') {
        const houses = (await this.store.indexListHouses()).map(({ domain, estafeta, last_ok, agents }) => ({ domain, estafeta, last_ok, agents }));
        return send(200, { total: houses.length, houses });
      }
      if (this.index.enabled && rx.method === 'GET' && path === '/index/agents') {
        // Paginación por cursor opaco, nunca por offset; los filtros se validan en indexSearch.
        const p = Object.fromEntries(rx.query);
        return send(200, await this.indexSearch({ ...Object.fromEntries(FILTROS.map((k) => [k, p[k]])), offset: p.offset }));
      }
      return send(404, { reason: 'unknown route' });
    } catch (e) {
      // Falla cerrado y con código HTTP válido: e.code puede ser un string del sistema ('ENOENT').
      const status = Number.isInteger(e.status) ? e.status : (Number.isInteger(e.code) ? e.code : 500);
      if (status >= 500) this.log(`error ${rx.method} ${path}: ${e.message}`);
      return send(status, { reason: e.message }, e.headers || null);
    }
  }

  // ---------- ciclo de vida en Node (los tests, demos y la CLI lo usan tal cual) ----------
  async start() {
    await this.init();
    const { startNodeServer } = await import('../plataformas/node.js');
    this._node = await startNodeServer(this, { port: this.port, host: this.host });
    this.timer = setInterval(() => this.tick().catch((e) => this.log('tick error', e.message)), this.workerIntervalMs);
    this.timer.unref?.();
    this.log(`escuchando en ${this.publicUrl}`);
    return this;
  }
  async stop() {
    clearInterval(this.timer);
    if (this._node) await this._node.close();
    this._node = null;
  }
}
