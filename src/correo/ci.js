// Nyx5/1 — El EJECUTOR: el aviso de la casa hacia CI, para los roles que trabajan sobre archivos.
//
// Por qué existe (NX-412, 27-oct-2026). `asistente.js` + `acciones.js` despiertan a los agentes que
// PIENSAN: viven en el Worker, contestan solos y sus cinco manos no tocan un disco. Un rol de la
// fábrica de Rosetta no cabe ahí: lee un repositorio, escribe archivos, corre python. Medido con
// Rosetta: 7 de sus 8 roles ejecutan. Para esos, la casa no hace el trabajo — AVISA a un ejecutor
// de fuera (hoy, un workflow de GitHub Actions) y el ejecutor contesta firmando con la llave del
// propio rol, que vive en los secrets de CI y nunca pasa por la casa ni por el chat.
//
// Tres decisiones que no son detalle:
//
// 1. **El aviso NO lleva el contenido.** Viaja sólo el sobre: quién escribió, qué tipo, qué
//    proyecto, su id y la firma de la casa. El cuerpo va cifrado y lo abre el ejecutor con la llave
//    del rol, leyendo `GET /mailbox/<local>` como cualquier agente. Así el invariante 8 queda
//    intacto y el texto de un encargo no aparece en el registro de un tercero (el payload de un
//    `repository_dispatch` queda en la pantalla de Actions, legible para quien tenga el repo).
//
// 2. **El destino se DERIVA, nunca se recibe.** La casa guarda un token con permiso de disparar CI;
//    si además aceptara una URL libre, sería un diputado confundido que manda ese token a donde le
//    digan. `PROVEEDORES` es una lista CERRADA, la URL se arma del `repo` validado por sintaxis, y
//    el token no vuelve por ninguna lectura (como los secrets de Cloudflare: se rota, no se lee).
//
// 3. **El aviso no se cierra el sobre.** La casa avisa; el sobre sigue pendiente hasta que el
//    ejecutor lo confirme. Un despacho perdido se reintenta con espera creciente y, agotados los
//    intentos, el dueño recibe un aviso NOMBRADO: el `task` que estuvo seis semanas en silencio en
//    el buzón de qa@ nació justo de un camino que fallaba sin decirlo.

import { parseAddress } from './resolver.js';
import { signBytes } from '../nucleo/crypto.js';
import { proyectoDe } from './politica.js';

// Direcciones de sistema de esta casa: sus recibos y rebotes no son un encargo.
const SISTEMA = new Set(['postmaster', 'libro', 'verifica', 'tareas']);
// Los tipos que son «te encargo esto» o su resultado. Lo demás no despierta a un ejecutor.
export const TIPOS_DESPACHADOS = Object.freeze(['message', 'task', 'result']);
// Despachos por dirección y día UTC. Cada despacho arranca un job de CI, o sea PLATA: el cupo es
// el freno, igual que el tope mensual lo es para un cerebro.
export const CUPO_DESPACHOS_DIA = 20;
// Intentos por sobre y espera antes de cada reintento (el primero sale al entregar, sin esperar).
export const INTENTOS = 3;
export const ESPERAS = Object.freeze([60_000, 300_000, 1_500_000]);
// Lo que se guarda de un despacho fallido, recortado: un cuerpo de error ajeno no crece sin tope.
const RAZON_MAX = 300;

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EVENTO = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const dia = (ms) => new Date(ms).toISOString().slice(0, 10);

// Un token de CI no se cita nunca, ni en un log ni en el estado de un despacho. Nació de una
// lección medida en el pagador x402: un error que repetía la llave malformada entregaba 72 bits
// del secreto. Aquí el riesgo es el cuerpo que devuelve el proveedor, que no controlamos.
export function sinSecretos(texto, token = null) {
  const crudo = String(texto == null ? '' : texto);
  // El valor exacto primero: la redacción por FORMA no conoce la del token de un proveedor nuevo.
  return (token ? crudo.split(String(token)).join('[token]') : crudo)
    .replace(/gh[pousr]_[A-Za-z0-9_]{10,}/g, '[token]')
    .replace(/github_pat_[A-Za-z0-9_]{10,}/g, '[token]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [token]')
    .slice(0, RAZON_MAX);
}

// La lista CERRADA de proveedores. Agregar uno es una decisión, no una configuración: se le da a la
// casa un token con permiso de arrancar trabajo, y el host al que ese token puede viajar se escribe
// aquí o no existe.
export const PROVEEDORES = Object.freeze({
  github: Object.freeze({
    url: (cfg) => `https://api.github.com/repos/${cfg.repo}/dispatches`,
    cabeceras: (token) => ({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'nyx5/1',
      'x-github-api-version': '2022-11-28',
    }),
    cuerpo: (cfg, aviso) => JSON.stringify({ event_type: cfg.event_type, client_payload: aviso }),
    ok: (status) => status === 204,
  }),
});

// Valida la configuración de un ejecutor. Falla CERRADO: lo que no se entiende no se guarda, y un
// campo ajeno se NOMBRA en vez de ignorarse — es autoridad de gasto, no un mensaje (el mismo
// motivo por el que `ALCANCE_MANDATO` es un vocabulario cerrado y contradice el invariante 7).
export function validarConfig(b = {}, previa = null) {
  const conocidos = new Set(['provider', 'repo', 'event_type', 'owner', 'cupo_dia', 'enabled', 'token']);
  const ajenos = Object.keys(b).filter((k) => !conocidos.has(k));
  if (ajenos.length) return { error: `unknown field(s) for an executor: ${ajenos.join(', ')}. This house applies: ${[...conocidos].join(', ')}` };

  const provider = b.provider ?? previa?.provider;
  if (!provider || !Object.hasOwn(PROVEEDORES, provider)) {
    return { error: `provider must be one of: ${Object.keys(PROVEEDORES).join(', ')}` };
  }
  const repo = String(b.repo ?? previa?.repo ?? '');
  if (!REPO.test(repo) || repo.includes('..')) return { error: 'repo must be owner/name (letters, digits, dot, dash, underscore)' };
  const event_type = String(b.event_type ?? previa?.event_type ?? 'nyx5');
  if (!EVENTO.test(event_type)) return { error: 'event_type must be lowercase letters, digits, dot, dash or underscore (max 100)' };
  const owner = String(b.owner ?? previa?.owner ?? '').toLowerCase();
  try { if (!owner || !parseAddress(owner)) return { error: 'owner must be the address that gets told when CI never takes the work' }; }
  catch { return { error: 'owner must be the address that gets told when CI never takes the work' }; }
  const cupo = b.cupo_dia ?? previa?.cupo_dia ?? CUPO_DESPACHOS_DIA;
  if (!Number.isInteger(cupo) || cupo < 1 || cupo > 500) return { error: 'cupo_dia must be a whole number between 1 and 500' };
  if (b.enabled != null && typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false' };
  if (b.token != null && (typeof b.token !== 'string' || !b.token.trim() || b.token.length > 500)) {
    return { error: 'token must be a non-empty string of at most 500 characters' };
  }
  if (!previa && !b.token) return { error: 'a token is needed to dispatch: it is write-only, it is never read back' };
  return { provider, repo, event_type, owner, cupo_dia: cupo };
}

export function urlDe(cfg) { return PROVEEDORES[cfg.provider].url(cfg); }

// El aviso: nueve campos. `client_payload` de GitHub admite diez propiedades de primer nivel, y el
// décimo que podría faltar no vale lo que costaría (el contenido no viaja: ver cabecera).
export function avisoDe(est, local, env) {
  const to = `${local}@${est.domain}`;
  return {
    nyx5: '1',
    house: est.domain,
    to,
    envelope: env.id,
    from: env.from,
    type: env.type || 'message',
    project: proyectoDe(env) || '',
    at: env.created || new Date().toISOString(),
    // La firma viaja DENTRO del payload porque un `repository_dispatch` no conserva cabeceras: es lo
    // que deja al workflow comprobar que el disparo salió de esta casa y no de cualquiera con el token.
    sig: signBytes(`ci:${env.id}:${to}`, est.keys),
  };
}

// ¿Este sobre despierta a un ejecutor? Las razones son las mismas que ya filtran a un cerebro
// (revisiones del 13-sep y del 26-oct), por los mismos motivos: cada despacho arranca un job que se
// paga, y lo que la lista del buzón no eligió no manda trabajo.
export function despachable(est, local, rec, m) {
  const env = m?.envelope || {};
  // Correo que entró por el puente: sin firma no se sabe quién pide. No se despacha y no se cierra.
  if (!env.signature || m.from_verified === false) return false;
  let de; try { de = parseAddress(env.from); } catch { return false; }
  if (de.domain === est.domain && SISTEMA.has(de.local)) return false;
  // Un grupo es un camino que la lista del buzón no eligió (el mismo criterio que para un cerebro).
  if ((env.to || []).some((t) => { try { return parseAddress(t).local.startsWith('g.'); } catch { return false; } })) return false;
  if (!TIPOS_DESPACHADOS.includes(env.type)) return false;
  if (env.from === `${local}@${est.domain}`) return true; // un recordatorio propio: despertarse a sí mismo
  // Un `intro` de 4 KB o un avalado entran a un buzón por lista SIN estar en la lista (§9).
  if (rec?.inbox?.policy === 'allowlist') {
    const lista = new Set((rec.inbox.allowlist || []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase()));
    if (!lista.has(String(env.from).toLowerCase()) && !lista.has(de.domain)) return false;
  }
  return true;
}

// Despacha UN sobre. Devuelve `{ ok, status, reason, skipped }`. No confirma el sobre: eso es del
// ejecutor. El cupo se cobra al DESPACHAR (no al mirar: el cupo de despertares se gastaba sin
// despertar a nadie, medido el 26-oct) y el turno es por intento, para que dos relojes —dos
// isolates del edge— no arranquen dos veces el mismo job.
export async function despachar(est, local, env, { cfg = null, nowMs = Date.now() } = {}) {
  const conf = cfg || await est.store.kvGet('ci', local);
  if (!conf?.enabled) return { ok: false, skipped: 'disabled' };
  const clave = `${local}:${env.id}`;
  const estado = await est.store.kvGet('ci-despacho', clave);
  if (estado?.estado === 'ok') return { ok: false, skipped: 'already dispatched' };
  const intentos = Number(estado?.intentos || 0);
  if (intentos >= INTENTOS) return { ok: false, skipped: 'attempts exhausted' };
  // Un turno por (sobre, intento): dos relojes que vean el mismo pendiente no disparan dos jobs.
  if (!await est.store.kvPutIfAbsent('ci-turno', `${clave}:${intentos}`, { at: new Date(nowMs).toISOString() }, nowMs + 15 * 60_000, nowMs)) {
    return { ok: false, skipped: 'another clock took this turn' };
  }
  // El token ANTES del cupo: sin token no sale nada a la red, así que cobrar el despacho del día
  // sería gastar el freno de plata en algo que nunca pasó.
  const sello = await est.store.kvGet('boveda', `ci:${local}`);
  let token = null;
  try { token = est.boveda && sello ? est.boveda.abrir(sello.sellado, `ci:${local}`).token : null; } catch { token = null; }
  if (!token) {
    const razon = 'this house has no readable CI token for that address';
    await est.store.kvPut('ci-despacho', clave, { intentos: INTENTOS, ultimo: new Date(nowMs).toISOString(), estado: 'fallo', razon }, nowMs + 7 * 24 * 3600_000);
    await avisarAgotado(est, local, env, conf, razon);
    return { ok: false, reason: razon };
  }

  const cupoClave = `${local}:${dia(nowMs)}`;
  const usado = await est.store.kvIncrement('ci-cupo', cupoClave, nowMs + 36 * 3600_000, nowMs, 1);
  if (usado > conf.cupo_dia) {
    const razon = `the daily dispatch quota (${conf.cupo_dia}) for ${dia(nowMs)} is used up`;
    await est.store.kvPut('ci-despacho', clave, { intentos, ultimo: new Date(nowMs).toISOString(), estado: 'cupo', razon }, nowMs + 7 * 24 * 3600_000);
    est.log(`ci ${local}: ${razon}`);
    return { ok: false, skipped: 'quota', reason: razon };
  }

  const prov = PROVEEDORES[conf.provider];
  let status = 0, razon = '';
  try {
    const r = await est.fetch(urlDe(conf), {
      method: 'POST',
      headers: prov.cabeceras(token),
      body: prov.cuerpo(conf, avisoDe(est, local, env)),
      signal: AbortSignal.timeout(10_000),
    });
    status = r.status || 0;
    if (!prov.ok(status)) razon = sinSecretos(`${status} ${await r.text().catch(() => '')}`, token);
  } catch (e) {
    razon = sinSecretos(`${e.message}${e.cause?.message ? ` / ${e.cause.message}` : ''}`, token);
  }
  const ok = !razon;
  const nuevos = intentos + 1;
  await est.store.kvPut('ci-despacho', clave, {
    intentos: nuevos, ultimo: new Date(nowMs).toISOString(), estado: ok ? 'ok' : 'fallo', status, razon,
  }, nowMs + 7 * 24 * 3600_000);
  if (ok) {
    est.log(`ci ${local}: sobre ${env.id} despachado a ${conf.provider} ${conf.repo} (${conf.event_type})`);
    await est._evento?.('ci_dispatched', `${local}@${est.domain}`, { provider: conf.provider, repo: conf.repo, envelope: env.id });
  } else {
    est.log(`ci ${local}: despacho ${nuevos}/${INTENTOS} del sobre ${env.id} falló: ${razon}`);
    if (nuevos >= INTENTOS) await avisarAgotado(est, local, env, conf, razon);
  }
  return { ok, status, reason: razon || undefined };
}

// Agotados los intentos, el dueño se entera. Un sobre que nadie toma no se queda en silencio: es
// exactamente el defecto que costó seis semanas en el buzón de qa@. El aviso se reserva con
// `kvPutIfAbsent` para que dos relojes no manden dos.
async function avisarAgotado(est, local, env, conf, razon) {
  if (!await est.store.kvPutIfAbsent('ci-aviso', `${local}:${env.id}`, { at: new Date().toISOString() }, Date.now() + 30 * 24 * 3600_000)) return;
  await est._systemSend('postmaster', [conf.owner], {
    type: 'message',
    thread: env.thread || env.id,
    content: {
      media: 'text/plain',
      body: `The executor of ${local}@${est.domain} never took envelope ${env.id} from ${env.from}. ${INTENTOS} dispatches to ${conf.provider} ${conf.repo} failed: ${razon}. The envelope is still in the mailbox, unanswered; nothing was lost. Fix the executor or the token and dispatch it again with POST /admin/executors/${local}/dispatch.`,
    },
  }).catch((e) => est.log(`ci ${local}: no se pudo avisar a ${conf.owner}: ${e.message}`));
}

// El reloj: recorre los ejecutores encendidos y reintenta lo que no se despachó. El primer intento
// sale al entregar (desde `_push`); esto es la red que atrapa lo que se perdió.
export async function atenderEjecutores(est, { nowMs = Date.now(), maxPorTick = 20 } = {}) {
  if (!est.store.kvGet) return 0;
  const indice = (await est.store.kvGet('ci', '_indice')) || [];
  let n = 0;
  for (const local of indice) {
    const cfg = await est.store.kvGet('ci', local);
    if (!cfg?.enabled) continue;
    const rec = await est.store.getAgent(local);
    if (!rec || rec.revoked) continue;
    for (const m of await est.store.listMail(local)) {
      if (n >= maxPorTick) return n;
      const env = m.envelope || {};
      if (!despachable(est, local, rec, m)) continue;
      const estado = await est.store.kvGet('ci-despacho', `${local}:${env.id}`);
      if (estado?.estado === 'ok') continue;
      const intentos = Number(estado?.intentos || 0);
      if (intentos >= INTENTOS) continue;
      // La espera crece con el número de intentos: un CI caído no se golpea cada minuto.
      if (intentos > 0 && nowMs - Date.parse(estado?.ultimo || 0) < ESPERAS[Math.min(intentos - 1, ESPERAS.length - 1)]) continue;
      const r = await despachar(est, local, env, { cfg, nowMs });
      if (!r.skipped) n++;
    }
  }
  return n;
}
