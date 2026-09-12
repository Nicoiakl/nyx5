// Nyx5/1 — Servidor de autorización OAuth 2.1 para el conector MCP remoto.
//
// Para qué existe: que el Claude de un teléfono (claude.ai web, Desktop, móvil) use Nyx5 sin
// instalar nada y SIN copiar la llave de nadie. El dueño autoriza desde su navegador, donde vive su
// llave raíz, y esa llave firma una delegación para un SUBAGENTE: claude.<dueño>@<casa>. La casa
// guarda la llave de ese subagente, y sólo la de ese, cifrada en la bóveda. El subagente:
//   - sólo manda y lee mensajes: no opera el Libro ni paga estampillas (scope.messages_only);
//   - vence (30 días) y el dueño lo revoca desde su teléfono cuando quiera;
//   - lo declara en su tarjeta (custody.keys = house): quien le escribe sabe que la casa puede leer
//     lo que le llega, porque la casa tiene su llave.
// Aprobado por Nicholas el 10-sep-2026 con esos tres límites.
//
// Lo que se cumple del spec (MCP 2025-06-18 y 2025-11-25) y de lo que Claude exige en la práctica:
//   RFC 9728 metadatos del recurso · RFC 8414 metadatos del servidor · RFC 7591 registro dinámico
//   PKCE S256 obligatorio · RFC 8707 `resource` amarrado al token · refresh con rotación (Claude es
//   cliente público) · /oauth/token acepta form-urlencoded · errores RFC 6749 (`invalid_grant`).
import { createHash, randomBytes } from 'node:crypto';
import { b64u, generateKeys, verifyObject } from '../nucleo/crypto.js';
import { parseAddress } from '../correo/resolver.js';

export const ALCANCE = 'messages';
const DIA = 86_400_000;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const aleatorio = () => b64u(randomBytes(32));
const s256 = (verifier) => b64u(createHash('sha256').update(String(verifier)).digest());
const iso = (t = Date.now()) => new Date(t).toISOString();
const err = (status, error, error_description) => ({ status, body: { error, error_description } });

export function urlsDe(est, ruta = '/mcp') {
  const base = est.publicUrl.replace(/\/+$/, '');
  return { base, recurso: `${base}${ruta}`, prm: `${base}/.well-known/oauth-protected-resource${ruta}` };
}
// Una invitación viaja DENTRO de la URL del conector: /mcp/i/<código>. Claude la devuelve sola como
// `resource` al pedir autorización, así que la pantalla de consentimiento sabe quién invitó sin
// depender de lo que haya guardado el navegador (en iPhone, la ventana de autorización y Safari
// pueden no compartir almacenamiento). La URL sigue siendo el conector de la persona para siempre,
// aunque la invitación ya se haya usado: el código sólo decide el prellenado, no el acceso.
export const RUTA_INVITACION = /^\/mcp\/i\/([A-Za-z0-9_-]{16,64})$/;

export function metadatosRecurso(est, ruta = '/mcp') {
  const { base, recurso } = urlsDe(est, ruta);
  return { resource: recurso, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: [ALCANCE], resource_name: `Nyx5 (${est.domain})`, resource_documentation: `${base}/spec` };
}

export function metadatosServidor(est) {
  const { base } = urlsDe(est);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [ALCANCE, 'offline_access'],
    service_documentation: `${base}/spec`,
  };
}

// ---------- URIs de retorno ----------
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
function redirectValida(u) {
  let x; try { x = new URL(u); } catch { return false; }
  if (x.hash) return false;
  if (x.protocol === 'https:') return true;
  return x.protocol === 'http:' && LOOPBACK.has(x.hostname);
}
// Exacta, salvo en loopback: ahí el puerto lo elige el cliente en cada sesión (RFC 8252 §7.3), y
// Claude Code declara http://localhost/callback sin puerto.
function coincideRedirect(registradas, pedida) {
  if (registradas.includes(pedida)) return true;
  let p; try { p = new URL(pedida); } catch { return false; }
  if (p.protocol !== 'http:' || !LOOPBACK.has(p.hostname)) return false;
  return registradas.some((r) => {
    try { const u = new URL(r); return u.protocol === 'http:' && u.hostname === p.hostname && u.pathname === p.pathname && u.search === p.search; }
    catch { return false; }
  });
}

function normalizarUrl(u) {
  try { const x = new URL(u); if (x.hash) return null; return `${x.protocol.toLowerCase()}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`; }
  catch { return null; }
}
// La ruta de NUESTRO recurso a la que apunta una URL (el conector, el de una invitación, o la casa
// misma), o null si no es nuestra. El token vale sólo para nuestros recursos (RFC 8707).
export function rutaDeRecurso(est, r) {
  const n = normalizarUrl(r);
  const b = normalizarUrl(urlsDe(est).base);
  if (!n || !b) return null;
  if (n === b) return '/mcp';
  if (!n.startsWith(`${b}/`)) return null;
  const ruta = n.slice(b.length);
  return ruta === '/mcp' || RUTA_INVITACION.test(ruta) ? ruta : null;
}
export function recursoValido(est, r) {
  if (r == null || r === '') return true;
  return rutaDeRecurso(est, r) !== null;
}

// ---------- registro dinámico de clientes (RFC 7591) ----------
export async function registrar(est, body, ip) {
  if (!est.remotoRate.allow(`dcr:${ip || 'x'}`)) return err(429, 'invalid_client_metadata', 'too many client registrations from this address; try again in a minute');
  const b = body && typeof body === 'object' ? body : {};
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every((u) => typeof u === 'string' && u.length <= 512 && redirectValida(u))) {
    return err(400, 'invalid_redirect_uri', 'redirect_uris: 1 to 5 URIs, https or loopback http, without fragment');
  }
  const grants = b.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grants) || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) return err(400, 'invalid_client_metadata', 'grant_types: only authorization_code and refresh_token');
  const respuestas = b.response_types ?? ['code'];
  if (!Array.isArray(respuestas) || respuestas.some((r) => r !== 'code')) return err(400, 'invalid_client_metadata', 'response_types: only code');
  const nombre = typeof b.client_name === 'string' ? b.client_name.replace(/[\u0000-\u001f<>"]/g, '').trim().slice(0, 80) : '';
  const cliente = {
    client_id: `nyx5c_${aleatorio()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris,
    grant_types: grants,
    response_types: ['code'],
    // Siempre público: Claude se registra así y PKCE es lo que protege el canje.
    token_endpoint_auth_method: 'none',
    ...(nombre ? { client_name: nombre } : {}),
  };
  await est.store.kvPut('cliente', cliente.client_id, cliente, Date.now() + 90 * DIA);
  return { status: 201, body: cliente };
}

// ---------- la solicitud de autorización ----------
async function validarPedido(est, q) {
  const g = (k) => { const v = q instanceof URLSearchParams ? q.get(k) : q?.[k]; return typeof v === 'string' ? v : null; };
  const client_id = g('client_id');
  const cliente = client_id ? await est.store.kvGet('cliente', client_id) : null;
  if (!cliente) return { ok: false, redirigible: false, error: 'invalid_client', description: 'unknown client_id: register the client first' };
  let redirect_uri = g('redirect_uri');
  if (!redirect_uri && cliente.redirect_uris.length === 1) redirect_uri = cliente.redirect_uris[0];
  if (!redirect_uri || !coincideRedirect(cliente.redirect_uris, redirect_uri)) return { ok: false, redirigible: false, error: 'invalid_request', description: 'redirect_uri does not match any registered for this client' };
  const state = g('state');
  const pedido = { client_id, cliente, redirect_uri, state: state && state.length <= 1024 ? state : null };
  const mal = (error, description) => ({ ok: false, redirigible: true, error, description, pedido });
  if (g('response_type') !== 'code') return mal('unsupported_response_type', 'only response_type=code');
  const reto = g('code_challenge');
  if (!reto || !/^[A-Za-z0-9_-]{43,128}$/.test(reto) || g('code_challenge_method') !== 'S256') return mal('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  const resource = g('resource');
  if (!recursoValido(est, resource)) return mal('invalid_target', `this server only issues tokens for ${urlsDe(est).recurso}`);
  // Una invitación vigente y sin usar prellena la pantalla. Sale del recurso, no del navegador.
  let invitacion = null;
  const mi = RUTA_INVITACION.exec(resource ? rutaDeRecurso(est, resource) || '' : '');
  if (mi) { const inv = await est.store.kvGet('invitacion', mi[1]); if (inv && !inv.used_by) invitacion = inv; }
  return { ok: true, pedido: { ...pedido, code_challenge: reto, resource: resource || urlsDe(est).recurso, scope: ALCANCE, invitacion } };
}

const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function paginaError(texto) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nyx5 · authorization</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:480px;margin:3rem auto;padding:0 1.2rem;color:#1A1712}h1{font-family:Georgia,serif;font-weight:400}</style></head><body><h1>This authorization cannot continue</h1><p>${escapar(texto)}</p><p>Go back to Claude and add the connector again.</p></body></html>`;
}
function volver(redirect_uri, params) {
  const u = new URL(redirect_uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return { status: 302, headers: { location: u.toString() }, contentType: 'text/plain; charset=utf-8', body: '' };
}

// El nombre que sugiere una invitación se mira AL MOSTRAR, no al crearla: puede tomarse entre medio.
// Defecto real (11-sep-2026): la invitación de la Pauli prellenaba "pauli", que existía desde el 7-sep,
// y su primer toque en "Connect" iba a rebotar con "that name is taken".
async function sugerible(est, hint) {
  return hint && (await est.nombreDisponible(hint)) ? hint : null;
}

// GET /oauth/authorize: la pantalla de consentimiento es la misma app, en modo "autorizar". La
// solicitud llega VALIDADA a la página: el navegador nunca decide a qué URI se redirige.
export async function paginaAutorizar(est, query, appHtml) {
  const v = await validarPedido(est, query);
  if (!v.ok && !v.redirigible) return { status: 400, contentType: 'text/html; charset=utf-8', body: paginaError(v.description) };
  if (!v.ok) return volver(v.pedido.redirect_uri, { error: v.error, error_description: v.description, state: v.pedido.state });
  const p = v.pedido;
  const destino = new URL(p.redirect_uri);
  const datos = {
    client_id: p.client_id, redirect_uri: p.redirect_uri, state: p.state, code_challenge: p.code_challenge, resource: p.resource,
    client_name: p.cliente.client_name || null, redirect_host: destino.host,
    // El spec pide mostrar con claridad a dónde vuelve el permiso, y advertir si es sólo loopback.
    loopback: LOOPBACK.has(destino.hostname), house: est.domain, days: est.remoto.dias,
    invite: p.invitacion ? { inviter: p.invitacion.inviter, inviter_claude: p.invitacion.inviter_claude || null, contacts: p.invitacion.contacts || [], name_hint: await sugerible(est, p.invitacion.name_hint) } : null,
  };
  const inyectado = `<script>window.NYX5_OAUTH=${JSON.stringify(datos).replace(/</g, '\\u003c')}</script>`;
  return { status: 200, contentType: 'text/html; charset=utf-8', body: appHtml.replace('<!--OAUTH-->', inyectado) };
}

const nombreSub = (raiz) => { const n = `claude.${raiz}`; return n.length <= 64 ? n : null; };
const DOMINIO = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
function listaDeEscritura(entrada, dueno, propia) {
  if (entrada === 'open') return null;
  const lista = new Set([dueno, propia]);
  for (const x of (Array.isArray(entrada) ? entrada : []).slice(0, 50)) {
    const v = String(x || '').trim().toLowerCase();
    if (!v) continue;
    if (v.includes('@')) { try { parseAddress(v); } catch { throw Object.assign(new Error(`not a valid address: ${v}`), { status: 400 }); } lista.add(v); }
    else if (DOMINIO.test(v)) lista.add(v);
    else throw Object.assign(new Error(`not an address or a domain: ${v}`), { status: 400 });
  }
  return [...lista];
}

// POST /oauth/prepare (firmado por la llave raíz del dueño): la casa entrega la llave PÚBLICA del
// subagente para que el navegador firme la delegación. Si ese Claude ya existe y está vigente, se
// reusa: autorizar desde otro dispositivo no debe cambiarle la identidad a tu Claude.
export async function preparar(est, rx) {
  const who = await est._authenticate(rx, rx.path);
  if (who.record.delegation) return { status: 403, body: { reason: 'a delegated address cannot authorize another one; use your own address' } };
  const v = await validarPedido(est, rx.body || {});
  if (!v.ok) return { status: 400, body: { reason: v.description } };
  const sub = nombreSub(who.local);
  if (!sub) return { status: 400, body: { reason: 'your address is too long to hold a Claude subaddress' } };
  let keys = await est.llavesDeBoveda(sub);
  if (!keys) {
    const pend = await est.store.kvGet('pendiente', sub);
    if (pend) { try { keys = est.boveda.abrir(pend.sellado, sub); } catch { keys = null; } }
    if (!keys) {
      keys = generateKeys();
      await est.store.kvPut('pendiente', sub, { sellado: est.boveda.sellar(keys, sub), root: who.address }, Date.now() + 15 * 60_000);
    }
  }
  return {
    status: 200,
    body: {
      address: `${sub}@${est.domain}`, sig: keys.sig, enc: keys.enc, parent: who.address,
      scope: { messages_only: true }, valid_until: iso(Date.now() + est.remoto.dias * DIA),
      client_name: v.pedido.cliente.client_name || null, redirect_host: new URL(v.pedido.redirect_uri).host,
    },
  };
}

// POST /oauth/approve (firmado por la llave raíz): la delegación que firmó el navegador se inscribe,
// la llave del subagente pasa de "pendiente" a la bóveda, y sale el código de un uso.
export async function aprobar(est, rx) {
  const who = await est._authenticate(rx, rx.path);
  if (who.record.delegation) return { status: 403, body: { reason: 'a delegated address cannot authorize another one; use your own address' } };
  const b = rx.body || {};
  const v = await validarPedido(est, b);
  if (!v.ok) return { status: 400, body: { reason: v.description } };
  const sub = nombreSub(who.local);
  const address = `${sub}@${est.domain}`;
  let keys = await est.llavesDeBoveda(sub);
  let dePendiente = false;
  if (!keys) {
    const pend = await est.store.kvGet('pendiente', sub);
    if (pend) { try { keys = est.boveda.abrir(pend.sellado, sub); dePendiente = true; } catch { keys = null; } }
  }
  if (!keys) return { status: 400, body: { reason: 'this authorization expired; add the connector again from Claude' } };
  // La delegación la firma el navegador del dueño con su llave raíz. La casa no puede fabricarla.
  const d = b.delegation;
  if (!d || d.by !== who.address || d.address !== address || d.sig !== keys.sig || d.scope?.messages_only !== true || !verifyObject(d, who.record.sig)) {
    return { status: 400, body: { reason: 'the delegation must be signed by your own key, for this address and this key, and limited to messages' } };
  }
  const tope = Date.now() + est.remoto.dias * DIA + 5 * 60_000;
  if (!d.valid_until || Number.isNaN(Date.parse(d.valid_until)) || Date.parse(d.valid_until) > tope || Date.parse(d.valid_until) < Date.now()) {
    return { status: 400, body: { reason: `valid_until must be in the future and at most ${est.remoto.dias} days away` } };
  }
  let allowlist = listaDeEscritura(b.allowlist, who.address, address);
  // Reconectar no borra contactos (12-sep-2026). La pantalla viene marcada en "sólo tú", y quien
  // reconectaba su Claude perdía a quienes podían escribirle: a Basti le habría cortado las respuestas
  // del agente de Sigo. Si ya había una lista viva, se suma a la nueva; "cualquiera" sigue abierto.
  const previo = await est.store.getAgent(sub);
  if (allowlist && previo?.inbox?.policy === 'allowlist' && !previo.revoked) allowlist = [...new Set([...allowlist, ...(previo.inbox.allowlist || [])])];
  // Invitación: se toma en UN paso (dos aprobaciones simultáneas no la usan las dos) y sus contactos
  // entran a la lista. Quién invitó lo dice la casa, no el navegador.
  let inv = v.pedido.invitacion ? await est.store.kvTake('invitacion', v.pedido.invitacion.code) : null;
  if (inv && inv.inviter === who.address) { await est.store.kvPut('invitacion', inv.code, inv, Date.parse(inv.expires)); inv = null; }
  if (inv && allowlist) allowlist = [...new Set([...allowlist, inv.inviter, ...(inv.inviter_claude ? [inv.inviter_claude] : []), ...(inv.contacts || [])])];
  const card = await est.registerAgent({
    local: sub, sig: keys.sig, enc: keys.enc, delegation: d, valid_until: d.valid_until,
    capabilities: { accepts: ['text/plain', 'application/json'] },
    inbox: allowlist ? { policy: 'allowlist', allowlist } : { policy: 'open' },
    custody: { keys: 'house', via: 'oauth', since: iso() },
  });
  await est.store.kvPut('boveda', sub, { sellado: est.boveda.sellar(keys, sub), root: who.address, since: iso() });
  if (dePendiente) await est.store.kvDelete('pendiente', sub);
  if (inv) {
    // El contacto queda en los dos sentidos: el Claude de quien invitó acepta al nuevo. Sin esto, la
    // primera respuesta del Claude invitado rebotaba contra la lista del que invitó.
    await est.store.kvPut('invitacion', inv.code, { ...inv, used_by: who.address, used_at: iso(), claude: address }, Date.now() + 30 * DIA);
    for (const c of [inv.inviter_claude, ...(inv.contacts || [])].filter(Boolean)) await est.agregarContactos(parseAddress(c).local, [address, who.address]);
    await est._evento('invitation_accepted', who.address, { by: inv.inviter });
  }
  const code = aleatorio();
  const p = v.pedido;
  await est.store.kvPut('codigo', sha(code), { client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, resource: p.resource, scope: p.scope, sub, root: who.address }, Date.now() + 5 * 60_000);
  await est._evento('connector_authorized', who.address, { client: p.cliente.client_name || null, open: !allowlist });
  const u = new URL(p.redirect_uri);
  u.searchParams.set('code', code);
  if (p.state) u.searchParams.set('state', p.state);
  return { status: 200, body: { redirect: u.toString(), address: card.address, invited_by: inv?.inviter || null } };
}

// ---------- /oauth/token ----------
async function vigente(est, sub) {
  const card = await est.store.getAgent(sub);
  if (!card || card.revoked || (card.valid_until && Date.parse(card.valid_until) <= Date.now())) return null;
  if (!(await est.store.kvGet('boveda', sub))) return null;
  return card;
}

async function emitir(est, base, cliente) {
  const card = await vigente(est, base.sub);
  if (!card) return err(400, 'invalid_grant', 'this Claude address was revoked or expired; authorize the connector again');
  const acceso = aleatorio(), refresco = aleatorio();
  const doc = { sub: base.sub, root: base.root, client_id: base.client_id, resource: base.resource, scope: ALCANCE };
  const hasta = Math.min(Date.now() + est.remoto.refrescoMs, card.valid_until ? Date.parse(card.valid_until) : Infinity);
  await est.store.kvPut('acceso', sha(acceso), doc, Date.now() + est.remoto.accesoS * 1000);
  await est.store.kvPut('refresco', sha(refresco), doc, hasta);
  // El cliente vive mientras se usa: uno que refresca no debe vencer a los 90 días de registrado.
  await est.store.kvPut('cliente', cliente.client_id, cliente, Date.now() + 90 * DIA);
  return { status: 200, headers: { pragma: 'no-cache' }, body: { access_token: acceso, token_type: 'Bearer', expires_in: est.remoto.accesoS, refresh_token: refresco, scope: ALCANCE } };
}

export async function token(est, body) {
  const b = body && typeof body === 'object' ? body : {};
  const cliente = typeof b.client_id === 'string' ? await est.store.kvGet('cliente', b.client_id) : null;
  if (b.grant_type === 'authorization_code') {
    if (!cliente) return err(401, 'invalid_client', 'unknown client_id');
    if (!b.code || !b.code_verifier) return err(400, 'invalid_request', 'code and code_verifier are required');
    const c = await est.store.kvTake('codigo', sha(b.code)); // un solo uso
    if (!c) return err(400, 'invalid_grant', 'the code is invalid, expired or already used');
    if (c.client_id !== b.client_id) return err(400, 'invalid_grant', 'the code was issued to another client');
    if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return err(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (s256(b.code_verifier) !== c.code_challenge) return err(400, 'invalid_grant', 'PKCE verification failed');
    if (b.resource && !recursoValido(est, b.resource)) return err(400, 'invalid_target', 'token requested for another resource');
    return emitir(est, c, cliente);
  }
  if (b.grant_type === 'refresh_token') {
    if (!cliente) return err(401, 'invalid_client', 'unknown client_id');
    // Rotación: el refresco viejo muere en el mismo paso en que nace el nuevo.
    const r = b.refresh_token ? await est.store.kvTake('refresco', sha(b.refresh_token)) : null;
    if (!r || r.client_id !== b.client_id) return err(400, 'invalid_grant', 'the refresh token is invalid, expired, revoked or already used');
    return emitir(est, r, cliente);
  }
  return err(400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
}

// ---------- el recurso: validar el token en /mcp ----------
export async function validarAcceso(est, rx) {
  // El 401 apunta a los metadatos de la MISMA URL que el usuario pegó: Claude exige que coincidan.
  const { prm } = urlsDe(est, RUTA_INVITACION.test(rx.path || '') ? rx.path : '/mcp');
  const negar = (desc) => ({
    ok: false,
    out: {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${prm}", scope="${ALCANCE}"${desc ? `, error="invalid_token", error_description="${desc}"` : ''}` },
      body: { error: desc ? 'invalid_token' : 'unauthorized', error_description: desc || 'this endpoint needs an OAuth access token; see resource_metadata in WWW-Authenticate' },
    },
  });
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(rx.headers.authorization || '');
  if (!m) return negar(null);
  const t = await est.store.kvGet('acceso', sha(m[1]));
  if (!t) return negar('the access token is invalid or expired');
  if (!recursoValido(est, t.resource)) return negar('the token was issued for another resource');
  if (!(await vigente(est, t.sub))) return negar('this Claude address was revoked or expired');
  return { ok: true, token: t };
}
