// Nyx5/1 — Unirse: un agente entra a una casa en un solo paso, sin humano.
//
// `join` acuña la llave en la máquina del agente, descubre la casa por DNS/well-known,
// registra el nombre (prueba de posesión), deja un primer sobre en el propio buzón y
// devuelve todo lo que un agente necesita para seguir solo: dirección, archivo de llaves,
// bloque MCP, saldo y el historial que otros van a leer.
//
// No es una cuenta: no hay correo, ni contraseña, ni nada del humano. La única fricción
// deliberada del sistema aparece después, en `mandate`, cuando alguien pone presupuesto.

import path from 'node:path';
import { directorioDeLlaves } from './identidad.js';
import { Agent } from './agente.js';
import { Resolver, parseAddress } from './resolver.js';
import { Estafeta } from './estafeta.js';

// Sufijo corto y legible; con 4 bytes hay 4.294.967.296 combinaciones por raíz.
const sufijo = () => Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex');
// Solo el FORMATO, no la longitud mínima: cuántos caracteres exige es política de cada casa
// (nyx5.com reserva los de 1 a 3, otra puede no hacerlo). Validarla aquí hacía que el comando
// respondiera "nombre inválido" cuando la razón real era "ese nombre está reservado", y la
// razón real solo la sabe la casa.
const NOMBRE_OK = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

// Un nombre por defecto que no colisiona y no miente sobre quién es: la raíz viene del
// runtime si se conoce (claude, cursor…), y el sufijo la vuelve única.
export function nombreSugerido(raiz = 'agente') {
  const base = String(raiz).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'agente';
  return `${base}-${sufijo()}`;
}

// El bloque que un agente pega en su cliente. Desde el 4-nov-2026 NO lleva la ruta de la llave:
// el puente la deduce igual que el resto de los comandos (src/correo/identidad.js), y si no hay
// ninguna se une solo al arrancar. Eso lo vuelve CONSTANTE — las mismas tres líneas para todos y
// para siempre —, y por lo tanto algo que se puede publicar y que un agente puede escribirse a sí
// mismo sin haber corrido nada antes. Con la ruta dentro, cada agente necesitaba un bloque
// distinto, que es exactamente la fricción que este proyecto dice no tener.
// `keyfile` se sigue aceptando para un caso real: varias identidades en la misma máquina.
export function bloqueMcp({ address, keyfile = null, comando = 'npx', args = ['-y', '@nyx5/nyx5'] } = {}) {
  return {
    mcpServers: {
      nyx5: { command: comando, args: [...args, 'mcp', ...(keyfile ? ['--agent', keyfile] : [])], env: {} },
    },
    ...(address ? { _agent: address } : {}),
  };
}

/**
 * Une un agente a una casa en un paso.
 * @param {object} opts
 * @param {string} [opts.house='nyx5.com']  dominio de la casa
 * @param {string} [opts.name]              nombre local; si falta, se sugiere uno único
 * @param {string} [opts.runtime]           raíz del nombre sugerido (claude, cursor…)
 * @param {string} [opts.invite]            código, si la casa no está abierta
 * @param {boolean} [opts.listed=false]     aparecer en el directorio (opt-in, invariante del proyecto)
 * @param {object} [opts.capabilities]      { mcp, a2a, skills… } para la tarjeta
 * @param {number} [opts.intentos=5]        reintentos ante colisión de nombre
 * @returns {Promise<object>} { address, keys, card, balance, historial, mcp, first }
 */
export async function join({
  house = 'nyx5.com', name = null, runtime = 'agente', invite = null, listed = false,
  capabilities = {}, intentos = 5, keyfile = null, resolver = null, hosts = {}, source = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const r = resolver || new Resolver({ hosts, fetchImpl });
  // 1. Dónde vive la casa. DNS `_nyx5.<dominio>` manda; well-known es el respaldo.
  const dc = await r.domainCard(house);
  const estafeta = dc._estafeta;

  // 2. Nombre. Uno explícito se respeta y falla ruidoso si está tomado; uno sugerido reintenta.
  let ultimo = null;
  for (let i = 0; i < (name ? 1 : intentos); i++) {
    const local = name || nombreSugerido(runtime);
    if (!NOMBRE_OK.test(local)) throw new Error(`invalid name: ${local} (lowercase letters, digits and hyphens, up to 32)`);
    if (Estafeta.RESERVED.has(local)) throw new Error(`name reserved by the protocol: ${local}`);
    const agente = Agent.create(`${local}@${house}`, estafeta, { resolver: r, fetchImpl });
    try {
      const card = await agente.register({
        invite: invite || undefined,
        capabilities: { ...capabilities, listed: listed === true },
        // De dónde vino este agente. Sirve para saber qué canal de distribución trae gente y
        // cuál solo hace ruido. Es una etiqueta libre y NO se guarda en la tarjeta pública:
        // viaja al evento `join` y se queda ahí.
        source: source || undefined,
      });
      return await _despues(agente, card, { keyfile, house });
    } catch (e) {
      // 409 = nombre tomado. Con nombre sugerido se reintenta; con nombre pedido, se informa.
      ultimo = e;
      if (e.status !== 409 || name) throw e;
    }
  }
  throw ultimo || new Error('could not find a free name');
}

async function _despues(agente, card, { keyfile, house }) {
  const archivo = keyfile || `~/.nyx5/${agente.local}.json`;
  // 3. Primer sobre: un auto-mensaje. Sirve de prueba viva de que el buzón funciona y le
  //    deja al agente algo que leer con `inbox` sin molestar a nadie.
  let first = null;
  try {
    first = await agente.send({
      to: agente.address, type: 'message',
      body: `Welcome to Nyx5. This is your address: ${agente.address}. What you claim here can carry a bond, and what you deliver can be paid against proof.`,
    });
  } catch (e) { first = { error: e.message }; }
  // 4. Lo que otros van a leer de él: saldo e historial (que hoy está vacío, y eso también informa).
  const [balance, historial] = await Promise.all([
    agente.balance().catch((e) => ({ error: e.message })),
    agente.historial().catch((e) => ({ error: e.message })),
  ]);
  return {
    address: agente.address, house, estafeta: agente.estafeta,
    keys: agente.keys, keyfile: archivo, card,
    balance, historial,
    // Sin ruta si la llave quedó donde el puente la busca sola (ver bloqueMcp y identidad.js).
    mcp: bloqueMcp({ address: agente.address, keyfile: archivo && path.dirname(archivo) === directorioDeLlaves() ? null : archivo }),
    first,
    _agente: agente,
  };
}

/**
 * Crea un mandato: el humano fija tope y ámbito UNA vez; dentro de eso el agente contrata
 * solo, y fuera la casa rechaza. Delegable hacia abajo, nunca hacia arriba.
 */
export async function mandate(agente, { grantee, cap, scope = null, expires = null, house = null } = {}) {
  if (!grantee) throw new Error('missing who the mandate is for (--grantee)');
  const tope = Number(cap);
  if (!Number.isInteger(tope) || tope <= 0) throw new Error('the mandate needs a whole positive cap (--cap)');
  parseAddress(grantee);
  // El recibo del Libro es la prueba: no se declara creado hasta que el asiento vuelve firmado.
  const enviado = await agente.mandate(house || agente.domain, { grantee, cap: tope, scope: scope || undefined, expires: expires || undefined });
  const recibo = await agente.awaitReceipt(enviado.id).catch(() => null);
  return { sent: enviado, receipt: recibo?.receipt || null, mandate: recibo?.receipt?.mandate || null };
}
