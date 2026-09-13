// Nyx5/1 — Asistentes: una dirección que contesta SOLA, con la API de Anthropic, dentro de un tope.
//
// Nació de una necesidad concreta: Nicholas se va un mes (desde el 14-sep-2026) y Bastián, el
// desarrollador de Sigo, necesita preguntarle al agente de Sigo a cualquier hora. Un Claude en una
// app sólo contesta cuando alguien lo abre; un asistente contesta aunque nadie esté mirando.
//
// Límites, y por qué cada uno:
//   - Sólo contesta a quien está en SU lista (la política del buzón ya rechaza al resto antes de
//     que llegue). Un asistente abierto sería un grifo de gasto para cualquiera.
//   - Nunca a sí mismo ni a los agentes de sistema (rebotes, recibos): un asistente que le contesta
//     a un rebote genera otro rebote, y el bucle se come el presupuesto.
//   - Cada respuesta se descuenta de un tope mensual en dólares, calculado del `usage` real que
//     devuelve la API. Al llegar al tope deja de llamar a la API, avisa a quien pregunta y, una vez,
//     a su dueño. El tope también se pone en la consola de Anthropic (el workspace): dos candados.
//   - Contesta desde el reloj programado, no dentro de una petición: en el edge, lo que corre
//     después de responder una petición tiene 30 s, y una respuesta de Claude puede tardar más.
//   - Su llave vive en la bóveda (custodia de la casa, declarada en su tarjeta), igual que la de
//     un Claude conectado. Sólo mensajes: no toca el Libro.
// La llamada va por HTTP directo porque este repo no admite dependencias.
import { parseAddress } from './resolver.js';

export const API_MENSAJES = 'https://api.anthropic.com/v1/messages';
// Dólares por millón de tokens. La escritura en caché de 5 minutos cuesta 1,25x la entrada y la
// lectura 0,1x. Si la API responde con otro modelo (respaldo ante un rechazo), se cobra igual.
// Un modelo que no está aquí NO se puede configurar (la alta y el cambio de config lo rechazan):
// sin su precio el tope mensual se calcularía con el de otro.
export const PRECIOS = {
  'claude-opus-5': { entrada: 5, salida: 25, escrituraCache: 6.25, lecturaCache: 0.5 },
  'claude-sonnet-5': { entrada: 2, salida: 10, escrituraCache: 2.5, lecturaCache: 0.2 },
};
// Modelos cuyo respaldo del servidor (`fallbacks: "default"`, beta server-side-fallback-2026-07-01)
// está documentado. A otro modelo no se le manda: si la API no lo aceptara, CADA pregunta fallaría.
// Sin respaldo, un rechazo llega como stop_reason "refusal" y se contesta como rechazo.
export const CON_RESPALDO = new Set(['claude-opus-5']);
const SISTEMA = new Set(['postmaster', 'libro', 'verifica', 'tareas']);
const mesDe = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

export function costoDe(modelo, u = {}) {
  const p = PRECIOS[modelo] || PRECIOS['claude-opus-5'];
  return ((u.input_tokens || 0) * p.entrada + (u.cache_creation_input_tokens || 0) * p.escrituraCache
    + (u.cache_read_input_tokens || 0) * p.lecturaCache + (u.output_tokens || 0) * p.salida) / 1e6;
}
function textoDe(c) {
  const b = c?.body;
  if (typeof b === 'string') return b;
  return b == null ? '' : JSON.stringify(b);
}

export async function atenderAsistentes(est, { maxPorTick = 3 } = {}) {
  if (!est.asistente?.apiKey || !est.store.kvGet) return 0;
  const indice = (await est.store.kvGet('asistente', '_indice')) || [];
  let atendidos = 0;
  for (const local of indice) {
    const cfg = await est.store.kvGet('asistente', local);
    if (!cfg?.enabled) continue;
    const propia = `${local}@${est.domain}`;
    const pendientes = (await est.store.listMail(local)).filter((m) => {
      const e = m.envelope || {};
      if (!e.signature || e.from === propia || !['message', 'result'].includes(e.type)) return false;
      // Un asistente contesta correo directo, nunca un grupo: su tope en dólares es de su dueño, y un
      // grupo es un sobre que llega por un camino que su lista no eligió (revisión del 13-sep-2026).
      if ((e.to || []).some((t) => { try { return parseAddress(t).local.startsWith('g.'); } catch { return false; } })) return false;
      try { const { local: l, domain } = parseAddress(e.from); return !(domain === est.domain && SISTEMA.has(l)); } catch { return false; }
    }).slice(0, maxPorTick);
    for (const m of pendientes) {
      // Un turno por mensaje: dos relojes que se pisan no contestan dos veces. Si la respuesta falla,
      // el turno vence a los 15 minutos y se reintenta; a la tercera falla se avisa y se cierra.
      if (!(await est.store.kvPutIfAbsent('asistente-turno', m.envelope.id, { at: new Date().toISOString() }, Date.now() + 15 * 60_000))) continue;
      try { await responder(est, local, cfg, m); atendidos++; }
      catch (e) {
        est.log(`asistente ${local}: ${e.message}`);
        const fallas = ((await est.store.kvGet('asistente-fallas', m.envelope.id)) || 0) + 1;
        await est.store.kvPut('asistente-fallas', m.envelope.id, fallas, Date.now() + 24 * 3600_000);
        if (fallas >= 3) {
          const agente = await est.agenteDeBoveda(local);
          await agente?.send({ to: m.envelope.from, body: 'No pude contestar este mensaje después de tres intentos. Quedó guardado; si es urgente, escríbelo de nuevo más tarde.', thread: m.envelope.thread || m.envelope.id, inReplyTo: m.envelope.id }).catch(() => {});
          await est.store.ackMail(local, m.envelope.id);
        }
      }
    }
  }
  return atendidos;
}

async function responder(est, local, cfg, m) {
  const agente = await est.agenteDeBoveda(local);
  if (!agente) throw new Error('la bóveda no tiene la llave de este asistente');
  const de = m.envelope.from;
  const hilo = { thread: m.envelope.thread || m.envelope.id, inReplyTo: m.envelope.id };
  const pregunta = textoDe((await agente.open(m.envelope)).content);  // verifica la firma y descifra
  const clave = `${local}:${mesDe()}`;
  const gasto = (await est.store.kvGet('asistente-gasto', clave)) || { usd: 0, llamadas: 0, avisado: false };
  if (gasto.usd >= cfg.budget_usd) {
    await agente.send({ to: de, body: `Llegué a mi tope de gasto de este mes (US$${cfg.budget_usd}) y no puedo contestar hasta el próximo. Tu mensaje quedó guardado.`, ...hilo });
    if (!gasto.avisado && cfg.owner) {
      await agente.send({ to: cfg.owner, body: `Tu asistente ${local}@${est.domain} llegó al tope de US$${cfg.budget_usd} de ${mesDe()} y dejó de contestar.` }).catch(() => {});
      gasto.avisado = true;
      await est.store.kvPut('asistente-gasto', clave, gasto);
    }
    await est.store.ackMail(local, m.envelope.id);
    return;
  }
  // La conversación con esa persona, en orden: los turnos se alternan y el primero es suyo.
  const mensajes = [];
  for (const h of await est.conversacion(local, { con: de, limit: 13 })) {
    if (h.id === m.envelope.id) continue;
    let t; try { t = textoDe((await agente.open(h.envelope)).content); } catch { continue; }
    const rol = h.dir === 'in' ? 'user' : 'assistant';
    if (mensajes.length && mensajes[mensajes.length - 1].role === rol) mensajes[mensajes.length - 1].content += `\n\n${t}`;
    else mensajes.push({ role: rol, content: t });
  }
  while (mensajes.length && mensajes[0].role !== 'user') mensajes.shift();
  const actual = `(Te escribe ${de})\n\n${pregunta}`;
  if (mensajes.length && mensajes[mensajes.length - 1].role === 'user') mensajes[mensajes.length - 1].content += `\n\n${actual}`;
  else mensajes.push({ role: 'user', content: actual });
  const conocimiento = (await est.store.kvGet('asistente-conocimiento', local))?.texto || '';
  // Lo estable primero y en caché (la persona y la base de conocimiento); lo que cambia, después.
  const cuerpo = {
    model: cfg.model || 'claude-opus-5',
    max_tokens: cfg.max_tokens || 8000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.effort || 'medium' },
    system: [{ type: 'text', text: cfg.persona || '' }, ...(conocimiento ? [{ type: 'text', text: conocimiento, cache_control: { type: 'ephemeral' } }] : [])],
    messages: mensajes,
  };
  // Si un clasificador de seguridad rechaza la pregunta, la API la corre en otro modelo en vez de
  // devolver un rechazo; un rechazo final llega igual como stop_reason "refusal".
  const respaldo = CON_RESPALDO.has(cuerpo.model);
  if (respaldo) cuerpo.fallbacks = 'default';
  const r = await est.asistente.fetch(API_MENSAJES, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': est.asistente.apiKey, 'anthropic-version': '2023-06-01', ...(respaldo ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`la API respondió ${r.status}: ${j?.error?.message || 'sin detalle'}`);
  const usd = costoDe(cuerpo.model, j.usage);
  gasto.usd += usd; gasto.llamadas += 1;
  await est.store.kvPut('asistente-gasto', clave, gasto);
  let respuesta = j.stop_reason === 'refusal' ? 'No puedo responder eso.' : (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!respuesta) respuesta = 'No tengo una respuesta para eso.';
  if (j.stop_reason === 'max_tokens') respuesta += '\n\n(La respuesta quedó cortada por largo. Pídeme que siga.)';
  await agente.send({ to: de, body: respuesta, ...hilo });
  await est.store.ackMail(local, m.envelope.id);
  await est._evento('assistant_answered', `${local}@${est.domain}`, { usd: Math.round(usd * 10000) / 10000 });
}
