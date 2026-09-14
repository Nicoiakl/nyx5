// Nyx5/1 — ideas@: el buzón automático de vacaciones. RECIBE, GUARDA y CONFIRMA. NUNCA EJECUTA.
//
// Nació del pedido de Nicholas del 14-sep-2026 (se va un mes): un lugar donde dejar una idea desde
// el teléfono y saber que quedó anotada, sin que nadie la ejecute ni la interprete. Corre desde el
// reloj programado de la casa, sin el Mac y sin ningún modelo de lenguaje.
//
// Límites, y son DE CÓDIGO, no de configuración:
//   - Este módulo no importa nada que hable con la API de Anthropic ni con el Libro, y no tiene
//     `fetch`. Lo único que sabe mandar es la confirmación a quien escribió (`agente.send` una vez,
//     al `from` del sobre recibido). `test/ideas.test.js` lo comprueba por inspección de la fuente
//     (lista CERRADA de lo que puede tocar de la estafeta, del almacén y del agente) y espiando las
//     salidas de la casa durante el tick.
//   - Sólo registra sobres FIRMADOS de quien está en la lista del buzón. La puerta (`puertaIdeas`,
//     que `inbound` consulta para este buzón) rechaza al resto ANTES de guardar nada: ni el `intro`
//     corto ni el aval con fianza que la política general deja pasar (§9) sirven aquí, porque este
//     buzón no tiene a nadie que los lea. El tick vuelve a mirar la lista por si algo entró por
//     otra puerta (un correo, un sobre anterior al alta): se cierra sin registrar y sin contestar.
//   - Cupo diario por remitente en la puerta (revisión adversarial del 14-sep-2026: una dirección
//     de la lista podía meter 112 MB por minuto en el buzón, que no se borra nunca): 200 ideas y
//     5 MB por día UTC; lo que sobra rebota con motivo desde la puerta, no desde este módulo.
//   - El contenido no se guarda aparte: sigue cifrado en el buzón de ideas@. El registro lleva
//     sólo el número, quién, cuándo, el hash del sobre, el hilo y el proyecto.
//   - El texto de la confirmación es FIJO (aprobado con el pedido: «registra y confirma, nunca
//     ejecuta») y vive en un solo lugar: `CONFIRMACION`.
import { parseAddress } from './resolver.js';
import { sha256hex, canonical } from '../nucleo/crypto.js';
import { proyectoDe, rolDe } from './politica.js';

export const LOCAL = 'ideas';
export const NS = 'ideas';           // nyx5_kv: `_n` (contador), `n:<000001>` (registro), `sobre:<id>` (idempotencia)
export const NS_CUPO = 'ideas-cupo'; // nyx5_kv: `<from>:<día>:n` y `<from>:<día>:bytes`, vencen al día siguiente
export const VIA = 'ideas';          // custody.via de la tarjeta: la casa firma y descifra en su nombre
export const CUPO_DIARIO = { ideas: 200, bytes: 5 * 1024 * 1024 };
export const PAGINA = 1000;          // GET /ideas devuelve hasta esto por página, con `next`
const SISTEMA = new Set(['postmaster', 'libro', 'verifica', 'tareas']);
const TURNO_MS = 15 * 60_000;
const DIA_MS = 24 * 3600 * 1000;

export const idDeIdea = (n) => `IDEA-${String(n).padStart(3, '0')}`;
const claveDe = (n) => `n:${String(n).padStart(6, '0')}`;
// «2026-09-15 10:22» a partir de una fecha ISO (siempre UTC).
export const fechaCorta = (isoStr) => String(isoStr).slice(0, 16).replace('T', ' ');
export const CONFIRMACION = (id, at) => `Saved as ${id} on ${fechaCorta(at)} UTC. Nothing was executed: this mailbox only records and confirms. Nicholas reads it when he is back.`;

const minus = (x) => String(x || '').toLowerCase();
function enLista(lista, from) {
  const f = minus(from);
  let dominio = ''; try { dominio = parseAddress(f).domain; } catch { dominio = ''; }
  return lista.some((x) => x === f || (dominio && x === dominio));
}

// La puerta de ideas@, consultada por `inbound` DESPUÉS de la política general y ANTES de guardar.
// Devuelve null si el sobre puede entrar, o `{ code, reason }` para rechazarlo (el rebote lo hace la
// estafeta emisora, como con cualquier rechazo de la puerta: no es una salida de este módulo).
// Rechaza (403, permanente) a quien no está en la lista y a quien agotó su cupo del día: un
// rechazo transitorio (429) dejaría los sobres reintentando en la cola de la otra casa un día entero.
// Lo que NO cubre: el cupo se cuenta al aceptar en la puerta, así que dos casas emisoras que
// entreguen a la vez pueden pasarse por uno; y sólo protege el buzón de ideas@, no el resto de la casa.
export async function puertaIdeas(est, env, rec, { cupo = CUPO_DIARIO, nowMs = Date.now() } = {}) {
  const lista = (rec?.inbox?.allowlist || []).map(minus);
  if (!enLista(lista, env.from)) return { code: 403, reason: 'the ideas mailbox records only signed envelopes from its list: not recorded' };
  if (!est.store.kvIncrement) return null;
  const dia = new Date(nowMs).toISOString().slice(0, 10);
  const vence = (Math.floor(nowMs / DIA_MS) + 2) * DIA_MS;
  const clave = `${minus(env.from)}:${dia}`;
  const bytes = Buffer.byteLength(JSON.stringify(env));
  // Se suma ANTES de comparar: con dos relojes contando a la vez, el que se pasa cierra el día.
  const n = await est.store.kvIncrement(NS_CUPO, `${clave}:n`, vence, nowMs);
  const total = await est.store.kvIncrement(NS_CUPO, `${clave}:bytes`, vence, nowMs, bytes);
  if (n > cupo.ideas || total > cupo.bytes) return { code: 403, reason: `daily limit of the ideas mailbox reached for this sender (${cupo.ideas} ideas or ${Math.round(cupo.bytes / 1024 / 1024)} MB per UTC day): not recorded` };
  return null;
}

// El registro ordenado por número, para GET /ideas: hasta `limit` registros con número > `after`.
export async function listarIdeas(est, { after = 0, limit = PAGINA } = {}) {
  const filas = await est.store.kvList(NS, { prefix: 'n:', after: after > 0 ? claveDe(after) : undefined, limit });
  return filas.map((f) => f.doc).sort((a, b) => a.n - b.n);
}
// Lo que contesta GET /ideas: `total` es el último número asignado (puede superar a los registros
// si un reloj cayó entre asignar el número y escribir el registro), `next` es el número desde el
// que sigue la página siguiente, o null si ésta es la última.
export async function paginaDeIdeas(est, { after = 0 } = {}) {
  const ideas = await listarIdeas(est, { after, limit: PAGINA });
  const total = Number(await est.store.kvGet(NS, '_n')) || 0;
  return { total, count: ideas.length, ideas, next: ideas.length === PAGINA ? ideas[ideas.length - 1].n : null };
}

// Un tick: cada sobre pendiente del buzón se registra (número correlativo durable) y se confirma.
// Devuelve cuántas ideas registró. Dos relojes sobre el mismo almacén no repiten número ni
// confirmación: un turno por sobre (`kvPutIfAbsent`) y un número por sobre (`sobre:<id>`).
// `maxPorTick` acota las ideas registradas por pasada; `maxDescartesPorTick`, lo que se cierra sin
// registrar (correo sin firma, rebotes del postmaster, algo anterior al alta): un buzón lleno de
// eso no puede comerse el minuto del reloj, y tampoco puede dejar sin turno a las ideas de verdad
// (son cupos separados).
export async function atenderIdeas(est, { maxPorTick = 20, maxDescartesPorTick = 200 } = {}) {
  if (!est.ideas?.enabled || !est.store.kvIncrement) return 0;
  const rec = await est.store.getAgent(LOCAL);
  if (!rec || rec.revoked || rec.custody?.via !== VIA) return 0;
  const lista = (rec.inbox?.allowlist || []).map(minus);
  const propia = `${LOCAL}@${est.domain}`;
  let registradas = 0;
  let vistos = 0, descartes = 0;
  for (const m of await est.store.listMail(LOCAL)) {
    if (vistos >= maxPorTick && descartes >= maxDescartesPorTick) break;
    const e = m.envelope || {};
    let de; try { de = parseAddress(e.from); } catch { continue; }
    // Lo que manda la casa (un rebote, un recibo) o el propio buzón no es una idea: se cierra y sigue.
    const deSistema = (de.domain === est.domain && SISTEMA.has(de.local)) || e.from === propia || e.type === 'receipt';
    // Sin firma (un correo) o fuera de la lista (algo que entró antes del alta o por otra puerta): se
    // cierra sin registrar y sin contestar. Contestarle a un desconocido sería la salida que este
    // buzón no tiene.
    const ajeno = !e.signature || m.from_verified === false || !enLista(lista, e.from);
    if (deSistema || ajeno) {
      if (descartes >= maxDescartesPorTick) continue;
      descartes++;
      if (!deSistema) est.log(`ideas@: sobre ${e.id} de ${e.from} descartado (${!e.signature || m.from_verified === false ? 'sin firma' : 'fuera de la lista'})`);
      await est.store.ackMail(LOCAL, e.id);
      continue;
    }
    if (vistos >= maxPorTick) continue;
    vistos++;
    if (!(await est.store.kvPutIfAbsent('ideas-turno', e.id, { at: new Date().toISOString() }, Date.now() + TURNO_MS))) continue;
    try {
      const agente = await est.agenteDeBoveda(LOCAL);
      if (!agente) throw new Error('la bóveda no tiene la llave de ideas@');
      // Un número por sobre: si un tick anterior asignó número y no llegó a confirmar, se reutiliza.
      let n = Number((await est.store.kvGet(NS, `sobre:${e.id}`))?.n) || 0;
      if (!n) {
        n = await est.store.kvIncrement(NS, '_n');
        await est.store.kvPut(NS, `sobre:${e.id}`, { n });
      }
      // El registro se escribe si no está, aunque el número ya estuviera asignado: un reloj que cayó
      // entre asignar el número y escribir el registro no puede dejar una idea confirmada y sin
      // registro (revisión adversarial del 14-sep-2026). No depende del contenido: si el sobre no se
      // puede abrir, se registra igual por su hash.
      let registro = await est.store.kvGet(NS, claveDe(n));
      if (!registro) {
        let abierto = false;
        try { await agente.open(e); abierto = true; } catch { abierto = false; }
        registro = { n, id: idDeIdea(n), id_sobre: e.id, from: e.from, at: new Date().toISOString(), sha256_sobre: sha256hex(canonical(e)), thread: e.thread || e.id, project: proyectoDe(e), role: rolDe(e), opened: abierto };
        await est.store.kvPut(NS, claveDe(n), registro);
      }
      // La ÚNICA salida de este módulo: la confirmación a quien escribió, en su hilo y su proyecto.
      await agente.send({ to: e.from, body: CONFIRMACION(registro.id, registro.at), thread: e.thread || e.id, inReplyTo: e.id, project: registro.project || undefined, role: registro.role || undefined });
      await est.store.ackMail(LOCAL, e.id);
      registradas++;
      await est._evento('idea_saved', e.from, { idea: registro.id, sobre: e.id });
    } catch (err) {
      // El turno queda tomado 15 minutos y se reintenta; el número, si ya salió, se conserva.
      est.log(`ideas@: ${e.id} no se pudo confirmar: ${err.message}`);
    }
  }
  return registradas;
}
