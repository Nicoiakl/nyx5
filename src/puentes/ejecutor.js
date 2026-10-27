// Nyx5/1 — El lado CI del ejecutor (NX-412, 27-oct-2026): lo que corre DENTRO del job.
//
// La casa dispara el CI con un aviso de nueve campos y sin el contenido del sobre (ver
// `src/correo/ci.js`). Este módulo es lo que el job hace con ese aviso, y son tres pasos:
//
//   1. VERIFICAR el aviso. Un `repository_dispatch` lo puede lanzar cualquiera que tenga el token
//      del repositorio, y el payload lo escribe quien dispara. Así que el aviso se comprueba contra
//      la tarjeta de la casa: `sig` tiene que ser una firma Ed25519 de `ci:<sobre>:<dirección>` por
//      una de las llaves que la casa publica. Un aviso que no verifica NO se trabaja: ni se lee el
//      buzón, ni se gasta un minuto de runner.
//   2. RECOGER el encargo. El aviso no trae el contenido: el job lee `GET /mailbox/<local>` con la
//      llave del rol (un secret del repositorio) y descifra el sobre. La llave nunca pasó por la
//      casa ni por el chat.
//   3. RESPONDER y CONFIRMAR. La respuesta va firmada por la dirección del rol, en el mismo hilo, y
//      recién entonces se confirma el sobre: si el job muere a mitad, el sobre sigue pendiente y la
//      casa lo vuelve a despachar. Confirmar antes de responder perdería el encargo en silencio.
//
// Cero dependencias y nada propio de GitHub: el aviso es un objeto JSON y de dónde salió es asunto
// del workflow.

import { Agent } from '../correo/agente.js';
import { verifyBytes } from '../nucleo/crypto.js';

const CAMPOS = ['nyx5', 'house', 'to', 'envelope', 'from', 'type', 'at', 'sig'];

export function parsearAviso(texto) {
  let a;
  try { a = typeof texto === 'string' ? JSON.parse(texto) : texto; } catch { throw new Error('the notice is not JSON'); }
  if (!a || typeof a !== 'object') throw new Error('the notice is not an object');
  const faltan = CAMPOS.filter((c) => typeof a[c] !== 'string' || !a[c]);
  if (faltan.length) throw new Error(`the notice is missing: ${faltan.join(', ')}`);
  if (a.nyx5 !== '1') throw new Error(`unknown protocol version: ${a.nyx5}`);
  if (!a.to.endsWith(`@${a.house}`)) throw new Error(`the notice says house ${a.house} but address ${a.to}`);
  return a;
}

// La tarjeta de la casa, pedida a la casa misma. `estafeta` se pasa cuando no se quiere resolver por
// DNS (pruebas, o una casa que todavía no publica su TXT).
export async function tarjetaDeCasa(house, { estafeta = null, fetchImpl = globalThis.fetch } = {}) {
  const base = (estafeta || `https://${house}`).replace(/\/$/, '');
  const r = await fetchImpl(`${base}/.well-known/nyx5.json`);
  if (!r.ok) throw new Error(`the house card of ${house} answered ${r.status}`);
  const card = await r.json();
  if (card.domain !== house) throw new Error(`that card says domain ${card.domain}, not ${house}`);
  if (!Array.isArray(card.keys) || !card.keys.length) throw new Error(`the card of ${house} publishes no keys`);
  return card;
}

// Verifica el aviso contra las llaves que la casa publica. Cualquiera de ellas sirve: una casa que
// rota su llave firma con la nueva y sigue publicando la vieja un tiempo.
export function verificarAviso(aviso, tarjeta) {
  const mensaje = `ci:${aviso.envelope}:${aviso.to}`;
  return tarjeta.keys.some((k) => { try { return verifyBytes(mensaje, aviso.sig, k.sig); } catch { return false; } });
}

function agenteDe(aviso, llaves, { estafeta = null, hosts = {}, fetchImpl = globalThis.fetch } = {}) {
  if (!llaves?.sig || !llaves?.sigPriv || !llaves?.enc || !llaves?.encPriv) {
    throw new Error('the role key must carry sig, sigPriv, enc and encPriv');
  }
  const dir = String(llaves.address || aviso.to).toLowerCase();
  if (dir !== String(aviso.to).toLowerCase()) throw new Error(`that key is of ${dir}, and the notice is for ${aviso.to}`);
  return new Agent({ address: dir, keys: llaves, estafeta: estafeta || `https://${aviso.house}`, hosts, fetchImpl });
}

// Paso 1 + 2: verificar y recoger. Devuelve el sobre y el encargo ya descifrado.
export async function recoger({ aviso, keys, estafeta = null, hosts = {}, fetchImpl = globalThis.fetch }) {
  const a = parsearAviso(aviso);
  const tarjeta = await tarjetaDeCasa(a.house, { estafeta, fetchImpl });
  if (!verificarAviso(a, tarjeta)) throw new Error(`the notice is not signed by ${a.house}: nothing was read and nothing was done`);
  const agente = agenteDe(a, keys, { estafeta, hosts, fetchImpl });
  const bandeja = await agente.inbox({ limit: 200 });
  const m = bandeja.find((x) => x.envelope?.id === a.envelope);
  // Que no esté no es un error del aviso: el sobre pudo ser confirmado por una corrida anterior.
  if (!m) return { aviso: a, agente, envelope: null, abierto: null, encargo: null, reason: 'that envelope is no longer in the mailbox: another run already took it' };
  if (m.envelope.from !== a.from) throw new Error(`the notice says ${a.from} and the envelope in the mailbox is from ${m.envelope.from}`);
  const abierto = await agente.open(m.envelope);
  // `encargo` es lo normalizado: el workflow no tiene por que saber que el cuerpo vive bajo
  // `content` ni que un sobre en claro y uno cifrado llegan por caminos distintos.
  const encargo = { media: abierto.content?.media ?? null, body: abierto.content?.body ?? null, project: abierto.project || null, role: abierto.role || null };
  return { aviso: a, agente, envelope: m.envelope, abierto, encargo, reason: null };
}

// Paso 3: responder y recién entonces confirmar. El orden importa: si el job muere entre las dos
// cosas, el sobre sigue pendiente y la casa lo vuelve a despachar. Al revés se perdería callado.
export async function responder({ aviso, keys, texto, estafeta = null, hosts = {}, fetchImpl = globalThis.fetch, ack = true, type = 'result' }) {
  const a = parsearAviso(aviso);
  if (typeof texto !== 'string' || !texto.trim()) throw new Error('an empty answer is not an answer');
  const agente = agenteDe(a, keys, { estafeta, hosts, fetchImpl });
  const env = await agente.send({ to: a.from, type, body: texto, thread: a.envelope, inReplyTo: a.envelope, project: a.project || undefined });
  const acked = ack ? await agente.ack([a.envelope]) : [];
  return { sent: env.id, acked };
}
