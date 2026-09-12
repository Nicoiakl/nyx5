// Nyx5/1 — Adaptador Cloudflare Workers: la misma Estafeta, en el edge.
//
//   fetch     -> handleRequest(rx); los ticks post-respuesta van por ctx.waitUntil
//   scheduled -> tick() (cola de reintentos + rastreo del índice federado)
//
// Configuración por variables (wrangler.toml / secrets). Los nombres NYX5_* mandan;
// los CHASQUI_* se siguen leyendo como respaldo para no romper un despliegue viejo.
//   NYX5_DOMAIN        dominio de la casa (ej: nyx5.com)
//   NYX5_PUBLIC_URL    URL pública de la estafeta (https://<NYX5_DOMAIN>)
//   NYX5_ADMIN_TOKEN   token de administración (secret; write-only)
//   NYX5_REGISTRATION  admin | invite | open        (default invite)
//   NYX5_WELCOME       tokens de regalo de bienvenida (default 0)
//   NYX5_FEE_BPS       fee de la casa en basis points (default 1000 = 10%)
//   NYX5_INDEX         'on' para operar el índice federado (default off)
//   NYX5_EMAIL         'on' para habilitar el puente de correo
//   DB                    binding D1

import { Estafeta } from '../correo/estafeta.js';
import { D1Store } from '../nucleo/almacen-d1.js';
import { extractText, resendProvider, addressFromHeader, decodeMimeWords } from '../puentes/email.js';

// El catálogo sembrado de esta casa. Tres tareas deterministas y baratas: su función NO es
// producir valor, es enseñar el ciclo completo (tomar, entregar, cobrar contra prueba) y dejarle
// al agente su primer historial, que es lo único que otro agente puede leer para confiar.
//
// Las de tipo sha256 se declaran con UN literal y nada más: el enunciado, las instrucciones y
// el hash se derivan de él. Así no pueden desincronizarse — un enunciado que pide hashear un
// texto y un hash que espera otro deja la tarea imposible de cumplir, y ese fallo es silencioso:
// ningún agente cobra nunca y nada grita. Ver test/tareas.test.js.
export function tareaDeHash({ id, price, literal, expect }) {
  return {
    id, price,
    concept: `deliver the exact sha256 of: ${literal}`,
    instructions: `Compute the sha256 of the exact string ${JSON.stringify(literal)} (no quotes, no trailing newline) and deliver it with --op deliver --args '{"contract":"<id>","evidence_sha256":"<hash>"}'.`,
    literal,
    verify: [{ type: 'sha256', expect }],
  };
}

export const NYX5_TAREAS = {
  porAgenteDia: 2,
  porDia: 200,
  catalogo: [
    tareaDeHash({ id: 'hola', price: 200, literal: 'nyx5', expect: '4c8e1f7f014a3fd84f70f52fa2861d6fbcaab3be0e64a90c6bfe5c312c2e36b5' }),
    tareaDeHash({ id: 'lema', price: 300, literal: 'una afirmacion cuesta algo', expect: '5c4cd161c3ee94a71f944b3a78c40733e6cf15d20c19bbbeb8b1e920a67d6a68' }),
  ],
};

let instancia = null;
function estafetaDesde(env) {
  if (instancia) return instancia;
  // Salida de correo: solo si hay proveedor + remitente verificado. Sin eso, la salida queda pendiente.
  const provider = resendProvider({ apiKey: env.RESEND_KEY, sender: env.EMAIL_SENDER });
  // NYX5_* manda; CHASQUI_* queda como respaldo (rename de sep-2026, ver docs/ARQUITECTURA.md).
  const cfg = (nombre) => env[`NYX5_${nombre}`] ?? env[`CHASQUI_${nombre}`];
  const domain = cfg('DOMAIN');
  instancia = new Estafeta({
    domain,
    publicUrl: cfg('PUBLIC_URL') || `https://${domain}`,
    adminToken: cfg('ADMIN_TOKEN'),
    store: new D1Store(env.DB),
    policy: { registration: cfg('REGISTRATION') || 'invite' },
    libro: { welcome: Number(cfg('WELCOME') || 0), feeBps: Number(cfg('FEE_BPS') || 1000) },
    index: { enabled: cfg('INDEX') === 'on' },
    email: { enabled: cfg('EMAIL') === 'on' || !!provider, provider, footer: cfg('EMAIL_FOOTER') === 'on', senders: String(cfg('EMAIL_SENDERS') || '').split(',') },
    // Trabajo sembrado: lo que la casa publica para que un agente recién unido tenga algo
    // que hacer y salga con historial. El catálogo vive en el código (cambiarlo es un
    // despliegue, con revisión y vuelta atrás) pero se ENCIENDE por casa: las dos casas
    // comparten este archivo, y una casa sin presupuesto que publica tareas solo frustra.
    tareas: cfg('SEED') === 'on' ? NYX5_TAREAS : {},
    // Conector MCP remoto (OAuth + subagentes delegados). Se enciende por casa y exige la llave de
    // la bóveda (secret NYX5_VAULT_KEY): sin ella no hay dónde guardar una llave, y /mcp no existe.
    remoto: { enabled: cfg('MCP_REMOTE') === 'on', vaultKey: env.NYX5_VAULT_KEY, dias: Number(cfg('REMOTE_DAYS')) || 30 },
    // Asistentes que contestan solos (src/correo/asistente.js). Sin clave de la API, no existen.
    asistente: { apiKey: env.ANTHROPIC_API_KEY },
    log: (...a) => console.log(...a),
  });
  return instancia;
}

// Cabeceras que acompañan a TODA respuesta. Van aquí, en la única puerta de salida, y no
// repartidas por las rutas: una cabecera de seguridad que solo cubre algunas respuestas da una
// falsa sensación de estar puesta.
//   - HSTS: el sitio ya es https; sin esto, la primera visita por http viaja en claro.
//   - nosniff / DENY / no-referrer: la casa sirve JSON y una página estática; nada necesita ser
//     interpretado como otro tipo, ni embebido en un iframe ajeno, ni filtrar de dónde vino.
//   - CSP: la portada y la spec traen su CSS y un script inline propios y NADA externo, así que
//     se declara exactamente eso. Si algún día se añade un recurso de fuera, esto grita.
//     `connect-src 'self'` es OBLIGATORIO: sin él, `default-src 'none'` bloquea todo fetch y la app
//     de /app no podía crear una dirección ni mandar un mensaje. Estuvo así en producción hasta el
//     10-sep-2026 y nadie lo vio: la página cargaba bien y fallaba en silencio al primer botón.
//     `manifest-src` e `img-src 'self'` son para instalarla en la pantalla de inicio.
const SEGURIDAD = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; connect-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

// Cuánto puede cachear cada superficie. La tarjeta del dominio y la spec son estables y se
// piden mucho; los buzones y el Libro no se cachean NUNCA (dos agentes distintos no pueden
// compartir una respuesta autenticada).
function cacheDe(path, method) {
  if (method !== 'GET' && method !== 'HEAD') return 'no-store';
  if (path === '/.well-known/nyx5.json') return 'public, max-age=300, stale-while-revalidate=600';
  if (path === '/' || path === '/spec' || path === '/spec/' || path === '/llms.txt' || path === '/robots.txt' || path === '/sitemap.xml' || path === '/favicon.ico') return 'public, max-age=3600';
  if (path === '/tareas' || path.startsWith('/agents') || path === '/report' || path === '/report.json') return 'public, max-age=60';
  if (path === '/manifest.webmanifest' || /^\/(icon-\d+|apple-touch-icon)\.png$/.test(path)) return 'public, max-age=86400';
  if (path.startsWith('/.well-known/oauth-')) return 'public, max-age=300';
  return 'no-store';
}

// Un ETag débil sobre el cuerpo: deja que el cliente revalide con 304 en vez de bajar todo otra
// vez. Débil porque el cuerpo puede diferir en bytes sin diferir en significado (JSON reordenado).
async function etagDe(cuerpo) {
  const datos = new TextEncoder().encode(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
  const hash = await crypto.subtle.digest('SHA-256', datos);
  return `W/"${[...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

export default {
  async fetch(request, env, ctx) {
    const estafeta = estafetaDesde(env);
    const url = new URL(request.url);
    let body = null;
    if (request.method === 'POST' || request.method === 'PUT') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > 2 * 1024 * 1024) return Response.json({ reason: 'cuerpo demasiado grande' }, { status: 413 });
      // /oauth/token recibe form-urlencoded (RFC 6749 §4.1.3): Claude manda el canje y el refresco
      // así. Leerlo todo como JSON devolvía 400 y el conector no llegaba nunca a tener token.
      const texto = await request.text();
      if ((request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(texto));
      else if (!texto.trim()) body = {};
      else { try { body = JSON.parse(texto); } catch { return Response.json({ reason: 'invalid JSON' }, { status: 400 }); } }
    }
    // www redirige al apex con 301. Existe como registro para que el nombre no dé NXDOMAIN
    // (quien lo teclea o lo pega en un chat llegaba a la nada), pero la casa vive en el apex:
    // dos orígenes servidores del mismo contenido parten el caché y confunden a los rastreadores.
    if (url.hostname.startsWith('www.')) {
      const destino = new URL(url); destino.hostname = url.hostname.slice(4); destino.protocol = 'https:';
      return new Response(null, { status: 301, headers: { ...SEGURIDAD, location: destino.toString(), 'cache-control': 'public, max-age=3600' } });
    }
    // HEAD se atiende como GET y se devuelve sin cuerpo. Sin esto, todo respondía 404 a HEAD:
    // rompía las vistas previas de enlaces (WhatsApp, Slack, LinkedIn), los monitores de uptime
    // y cualquier comprobador de enlaces, que es como se descubre si un sitio está vivo.
    const esHead = request.method === 'HEAD';
    const rx = {
      method: esHead ? 'GET' : request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v])),
      body,
      ip: request.headers.get('cf-connecting-ip') || null,
    };
    const out = await estafeta.handleRequest(rx);
    if (out.pending) ctx.waitUntil(out.pending);
    // Un tick disparado por una petición no atiende asistentes (programado: false): tras responder,
    // el edge sólo da 30 segundos y una respuesta de Claude puede tardar más. Los atiende el cron.
    if (out.kick) ctx.waitUntil(estafeta.tick({ programado: false }).catch((e) => console.log('tick error', e.message)));
    // Un cuerpo binario (la imagen de compartir) llega como Buffer; el edge quiere bytes.
    // 204 y 304 no llevan cuerpo: un Response con cuerpo (aunque sea '') y uno de esos estados revienta.
    const cuerpo = out.status === 204 || out.status === 304 ? null : out.contentType ? (Buffer.isBuffer(out.body) ? new Uint8Array(out.body) : out.body) : JSON.stringify(out.body);
    const headers = {
      // Cabeceras que pone la ruta (hoy: el sobre x402 en PAYMENT-REQUIRED / PAYMENT-RESPONSE).
      // Van PRIMERO para que una ruta no pueda pisar por descuido una cabecera de seguridad ni el
      // content-type: lo que va debajo gana siempre.
      ...(out.headers || {}),
      ...SEGURIDAD,
      'content-type': out.contentType || 'application/json',
      'cache-control': cacheDe(url.pathname, request.method),
    };
    if (out.status === 200 && headers['cache-control'] !== 'no-store') {
      headers.etag = await etagDe(cuerpo);
      // Si el cliente ya tiene esta versión, 304 y nada de cuerpo.
      if (request.headers.get('if-none-match') === headers.etag) return new Response(null, { status: 304, headers });
    }
    return new Response(esHead ? null : cuerpo, { status: out.status, headers });
  },

  async scheduled(_event, env, ctx) {
    const estafeta = estafetaDesde(env);
    ctx.waitUntil(estafeta.tick().catch((e) => console.log('tick error', e.message)));
  },

  // ENTRADA del puente de correo (Cloudflare Email Workers): un email real a agente@casa entra al
  // buzón como sobre sin firma, marcado from_verified:false. Se activa cuando la casa enruta su
  // dominio a este Worker en Email Routing; hasta entonces, este handler no se invoca.
  async email(message, env, ctx) {
    const estafeta = estafetaDesde(env);
    let raw = '';
    try { raw = await new Response(message.raw).text(); } catch { /* sin cuerpo legible */ }
    const r = await estafeta.receiveEmail({
      // El remitente que se muestra es el del header From (el humano real); message.from es el
      // return-path del envelope (a veces la dirección de rebote del proveedor), sirve de respaldo.
      from: addressFromHeader(message.headers.get('from')) || message.from,
      to: message.to,
      subject: decodeMimeWords(message.headers.get('subject') || ''),
      text: extractText(raw),
      messageId: (message.headers.get('message-id') || '').replace(/[<>]/g, '').slice(0, 128) || undefined,
    });
    if (!r.ok && !r.duplicate) message.setReject(r.reason || 'no aceptado');
  },
};
