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
//     y espiando las salidas de la casa durante el tick.
//   - Sólo registra sobres FIRMADOS de quien está en la lista del buzón. La política del buzón ya
//     rechaza al resto en la puerta, pero deja pasar un `intro` corto de un desconocido (§9): ése
//     se confirma como leído y se descarta, sin registro y sin respuesta.
//   - El contenido no se guarda aparte: sigue cifrado en el buzón de ideas@. El registro lleva
//     sólo el número, quién, cuándo, el hash del sobre, el hilo y el proyecto.
//   - El texto de la confirmación es FIJO (aprobado con el pedido: «registra y confirma, nunca
//     ejecuta») y vive en un solo lugar: `CONFIRMACION`.
import { parseAddress } from './resolver.js';
import { sha256hex, canonical } from '../nucleo/crypto.js';
import { proyectoDe, rolDe } from './politica.js';

export const LOCAL = 'ideas';
export const NS = 'ideas';           // nyx5_kv: `_n` (contador), `n:<000001>` (registro), `sobre:<id>` (idempotencia)
export const VIA = 'ideas';          // custody.via de la tarjeta: la casa firma y descifra en su nombre
const SISTEMA = new Set(['postmaster', 'libro', 'verifica', 'tareas']);
const TURNO_MS = 15 * 60_000;

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

// El registro ordenado por número, para GET /ideas.
export async function listarIdeas(est, { limit = 1000 } = {}) {
  const filas = await est.store.kvList(NS, { prefix: 'n:', limit });
  return filas.map((f) => f.doc).sort((a, b) => a.n - b.n);
}

// Un tick: cada sobre pendiente del buzón se registra (número correlativo durable) y se confirma.
// Devuelve cuántas ideas registró. Dos relojes sobre el mismo almacén no repiten número ni
// confirmación: un turno por sobre (`kvPutIfAbsent`) y un número por sobre (`sobre:<id>`).
// `maxPorTick` acota las ideas registradas por pasada; `maxDescartesPorTick`, lo que se cierra sin
// registrar (intros de extraños, correo sin firma): una inundación de intros no puede comerse el
// minuto del reloj, y tampoco puede dejar sin turno a las ideas de verdad (son cupos separados).
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
    // Sin firma (un correo) o fuera de la lista (un intro que la política deja pasar): se cierra sin
    // registrar y sin contestar. Contestarle a un desconocido sería la salida que este buzón no tiene.
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
      const at = new Date().toISOString();
      // Un número por sobre: si un tick anterior registró y no llegó a confirmar, se reutiliza.
      let n = Number((await est.store.kvGet(NS, `sobre:${e.id}`))?.n) || 0;
      if (!n) {
        n = await est.store.kvIncrement(NS, '_n');
        await est.store.kvPut(NS, `sobre:${e.id}`, { n });
        // Si el sobre no se puede abrir, se registra igual por su hash: el registro no depende del contenido.
        let abierto = false;
        try { await agente.open(e); abierto = true; } catch { abierto = false; }
        await est.store.kvPut(NS, claveDe(n), { n, id: idDeIdea(n), id_sobre: e.id, from: e.from, at, sha256_sobre: sha256hex(canonical(e)), thread: e.thread || e.id, project: proyectoDe(e), role: rolDe(e), opened: abierto });
      }
      const registro = (await est.store.kvGet(NS, claveDe(n))) || { id: idDeIdea(n), at };
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
