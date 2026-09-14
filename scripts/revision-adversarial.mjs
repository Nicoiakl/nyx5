#!/usr/bin/env node
// Revisión adversarial automatizable (NX-903): lo que las tres revisiones del 13/14-sep probaron
// a mano y NO exige juicio, corrido contra una Estafeta LOCAL (o la URL que se le dé).
//
//   npm run revision                                  # levanta una casa local en 4759 y la revisa
//   node scripts/revision-adversarial.mjs --url http://127.0.0.1:4001 --admin-token t
//   node scripts/revision-adversarial.mjs --url https://nyx5.com --sin-inundar   # sin provocar 429
//
// Cada comprobación termina en uno de tres estados, como las pruebas de verifica@:
//   ok        se ejercitó y se cumplió
//   falla     se ejercitó y NO se cumplió (el proceso sale con 1)
//   indecisa  no se pudo ejercitar (registro cerrado, ruta ausente, sin 429 en N intentos): se
//             reporta con su razón y NO cuenta como verde. Un verde sin base no dice qué midió.
// El guion completo, con lo que exige juicio, está en scripts/revision-adversarial.md.
//
// Qué NO cubre: nada que necesite dos isolates (idempotencia bajo carrera se prueba en
// test/concurrencia.test.js), nada que exija leer texto (homógrafos, CSV con fórmulas, textos
// públicos), ni el tope real de subpeticiones del edge. Y no es prueba de carga.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyObject } from '../src/nucleo/crypto.js';
import { TOOLS, MENSAJERIA } from '../src/puentes/herramientas.js';
import { PRUEBAS } from '../src/libro/verifica.js';

// Un segmento que no se puede decodificar: `decodeURIComponent` lanza URIError con él. Antes del
// 14-sep tres rutas contestaban 500 (revisión tercera). Se prueba en TODAS las rutas GET públicas.
export const SEGMENTO_ROTO = '%E0%A4%A';
// Topes de descripción por herramienta MCP: los mismos que cuida test/mcp.test.js. Si cambian
// allá, cambian aquí: son la misma regla, no dos.
export const TOPE_DESCRIPCION = { por_defecto: 340, nyx5_libro: 650 };

// Rutas públicas que nombran un agente: la respuesta a un nombre SECRETO tiene que ser byte a byte
// la de un inexistente (cuerpo y cabeceras salvo la fecha). Cada una recibe el nombre y la casa.
export const RUTAS_CON_NOMBRE = [
  (n) => `/agents/${n}`,
  (n) => `/agents/${n}/historial`,
  (n) => `/agents/${n}/presence`,
  (n) => `/x402/inbox/${n}`,
  (n, casa) => `/resolve/${encodeURIComponent(`${n}@${casa}`)}`,
  (n) => `/agents/historial?addresses=${n}`,
  (n) => `/mailbox/${n}`,
  (n) => `/conversations/${n}`,
  (n) => `/delegations/${n}`,
  (n) => `/outbox/${n}`,
  (n, casa) => `/libro/cuenta/${encodeURIComponent(`${n}@${casa}`)}`,
];
// Rutas GET públicas que reciben un segmento o un parámetro: con SEGMENTO_ROTO ninguna puede dar 500.
export const RUTAS_GET = [
  ...RUTAS_CON_NOMBRE,
  (n) => `/notaria/sello/${n}`,
  (n) => `/notaria/${n}`,
  (n) => `/libro/contrato/${n}`,
  (n) => `/libro/estado?since=${n}`,
  (n) => `/i/${n}`,
  (n) => `/agents?q=${n}&capability=${n}`,
  (n) => `/index/agents?q=${n}&cursor=${n}&tag=${n}`,
  (n) => `/tareas?x=${n}`,
  (n) => `/${n}`,
  (n) => `/agents/${n}/groups`,
  (n) => `/mailbox/${n}/wait?since=${n}`,
];

const argumentos = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { out[k] = argv[++i]; } else out[k] = true;
  }
  return out;
};

const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
// Foto comparable de una respuesta: estado, cabeceras (sin fecha) y cuerpo con el nombre neutralizado.
async function foto(fetchImpl, url, nombres) {
  const r = await fetchImpl(url);
  const headers = Object.fromEntries([...r.headers].filter(([k]) => k !== 'date').sort());
  let body = await r.text();
  for (const n of nombres) body = body.split(n).join('N');
  return { status: r.status, headers, body };
}

/**
 * Corre las comprobaciones contra `url`. Devuelve { total, ok, fallas, indecisas, comprobaciones }.
 * `adminToken` sirve para registrar el agente secreto donde el registro no es abierto.
 * `inundar: false` salta la provocación de 429 (contra producción cuesta el minuto de todos).
 */
export async function revisar({ url, adminToken = null, inundar = true, intentos = 200, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  url = String(url).replace(/\/$/, '');
  const comprobaciones = [];
  const anota = (id, estado, detalle) => { comprobaciones.push({ id, estado, detalle }); log(`${estado === 'ok' ? 'OK      ' : estado === 'falla' ? 'FALLA   ' : 'INDECISA'} ${id}: ${detalle}`); };
  const ok = (id, d) => anota(id, 'ok', d);
  const falla = (id, d) => anota(id, 'falla', d);
  const indecisa = (id, d) => anota(id, 'indecisa', d);

  // La casa: su tarjeta de dominio dice cómo se llama y con qué llaves firma.
  let dominio, llaves;
  try {
    const dc = await (await fetchImpl(`${url}/.well-known/nyx5.json`)).json();
    dominio = dc.domain; llaves = (dc.keys || []).map((k) => k.sig).filter(Boolean);
    if (!dominio || !llaves.length) throw new Error('la tarjeta del dominio no trae dominio o llaves');
    ok('casa', `${dominio} con ${llaves.length} llave(s) de firma`);
  } catch (e) {
    falla('casa', `no se pudo leer ${url}/.well-known/nyx5.json: ${e.message}`);
    return resumen(comprobaciones);
  }

  // 1. Un secreto se ve como inexistente, en todas las rutas públicas que nombran un agente.
  //    Los dos nombres miden lo mismo, así content-length no delata cuál existe.
  const sufijo = hex(8);
  const secreto = `rev-s-${sufijo}`, nadie = `rev-n-${sufijo}`;
  let registrado = false;
  try {
    const { Agent } = await import('../src/correo/agente.js');
    const a = Agent.create(`${secreto}@${dominio}`, url, { fetchImpl });
    await a.register({ ...(adminToken ? { adminToken } : {}), visibility: 'secret', inbox: { policy: 'allowlist', allowlist: [] } });
    registrado = true;
  } catch (e) { indecisa('404-secreto', `no se pudo registrar un agente secreto para comparar (${e.message}); pasa --admin-token o usa una casa de registro abierto`); }
  if (registrado) {
    const distintas = [];
    for (const ruta of RUTAS_CON_NOMBRE) {
      const s = await foto(fetchImpl, `${url}${ruta(secreto, dominio)}`, [secreto, nadie]);
      const n = await foto(fetchImpl, `${url}${ruta(nadie, dominio)}`, [secreto, nadie]);
      if (JSON.stringify(s) !== JSON.stringify(n)) distintas.push(`${ruta('<nombre>', dominio)} (${s.status} vs ${n.status})`);
    }
    if (distintas.length) falla('404-secreto', `un secreto se distingue de un inexistente en: ${distintas.join(', ')}`);
    else ok('404-secreto', `${RUTAS_CON_NOMBRE.length} rutas contestan lo mismo (cuerpo y cabeceras) a un secreto y a un inexistente`);
  }

  // 2. Ningún GET público contesta 500 ante un segmento que no se puede decodificar.
  const quinientos = [];
  for (const ruta of RUTAS_GET) {
    const r = await fetchImpl(`${url}${ruta(SEGMENTO_ROTO, dominio)}`);
    await r.text();
    if (r.status >= 500) quinientos.push(`${ruta('<roto>', dominio)} -> ${r.status}`);
  }
  if (quinientos.length) falla('500-decode', `con ${SEGMENTO_ROTO} responden 5xx: ${quinientos.join(', ')}`);
  else ok('500-decode', `${RUTAS_GET.length} rutas GET aguantan ${SEGMENTO_ROTO} sin 5xx`);

  // 3. Cada 429 lleva Retry-After (un entero positivo en segundos). Se provoca en cada cubeta
  //    pública por IP; si en `intentos` no aparece, queda indecisa: no se afirma lo que no se vio.
  if (!inundar) indecisa('429-retry-after', 'saltada por --sin-inundar');
  else {
    const cubetas = [
      ['resolve', () => fetchImpl(`${url}/resolve/${encodeURIComponent(`postmaster@${dominio}`)}`)],
      ['notaria', () => fetchImpl(`${url}/notaria/${'0'.repeat(64)}`)],
      ['historial-lote', () => fetchImpl(`${url}/agents/historial?addresses=postmaster`)],
      ['registro', () => fetchImpl(`${url}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })],
    ];
    const sinCabecera = [], sinLimite = [];
    for (const [nombre, pedir] of cubetas) {
      let visto = null;
      for (let i = 0; i < intentos; i++) {
        const r = await pedir(); await r.text();
        if (r.status === 429) { visto = r; break; }
      }
      if (!visto) { sinLimite.push(nombre); continue; }
      const ra = visto.headers.get('retry-after');
      if (!/^\d+$/.test(ra || '') || Number(ra) <= 0) sinCabecera.push(`${nombre} (retry-after: ${JSON.stringify(ra)})`);
    }
    if (sinCabecera.length) falla('429-retry-after', `429 sin Retry-After válido en: ${sinCabecera.join(', ')}`);
    else if (sinLimite.length === cubetas.length) indecisa('429-retry-after', `ninguna cubeta llegó a 429 en ${intentos} intentos: el límite es más alto o no existe`);
    else ok('429-retry-after', `Retry-After presente en ${cubetas.length - sinLimite.length} cubeta(s) que llegaron a 429${sinLimite.length ? `; sin 429 en ${intentos} intentos: ${sinLimite.join(', ')}` : ''}`);
  }

  // 4. Las tarjetas de sistema las certifica el dominio y verifican con una de sus llaves.
  const malas = [];
  let sistema = 0;
  for (const nombre of ['postmaster', 'libro', 'verifica', 'tareas']) {
    const r = await fetchImpl(`${url}/agents/${nombre}`);
    if (r.status === 404) { await r.text(); continue; } // tareas@ sólo existe con catálogo
    const card = await r.json().catch(() => null);
    sistema += 1;
    const kid = card?.certification?.kid;
    if (!card || !kid) { malas.push(`${nombre}@ sin certificación`); continue; }
    if (!llaves.includes(kid)) { malas.push(`${nombre}@ certificada con una llave que no es del dominio`); continue; }
    if (!verifyObject(card, kid, 'certification')) malas.push(`${nombre}@ no verifica`);
    if (nombre === 'verifica') {
      const anuncia = card.capabilities?.verifica?.pruebas || [];
      const ajenas = anuncia.filter((p) => !PRUEBAS.includes(p));
      if (ajenas.length) malas.push(`verifica@ anuncia pruebas que no existen: ${ajenas.join(', ')}`);
    }
  }
  if (malas.length) falla('tarjetas-sistema', malas.join('; '));
  else ok('tarjetas-sistema', `${sistema} tarjetas de sistema certificadas por el dominio y verificadas`);

  // 5. Cada herramienta MCP dentro de su tope de descripción, nombres únicos, MENSAJERIA ⊆ TOOLS.
  const fuera = TOOLS.filter((t) => t.description.length > (TOPE_DESCRIPCION[t.name] ?? TOPE_DESCRIPCION.por_defecto)).map((t) => `${t.name} (${t.description.length})`);
  const nombres = TOOLS.map((t) => t.name);
  const repetidos = nombres.filter((n, i) => nombres.indexOf(n) !== i);
  const huerfanas = [...MENSAJERIA].filter((n) => !nombres.includes(n));
  if (fuera.length || repetidos.length || huerfanas.length) falla('tools-tope', [fuera.length ? `sobre el tope: ${fuera.join(', ')}` : '', repetidos.length ? `repetidas: ${repetidos.join(', ')}` : '', huerfanas.length ? `en MENSAJERIA sin herramienta: ${huerfanas.join(', ')}` : ''].filter(Boolean).join('; '));
  else ok('tools-tope', `${TOOLS.length} herramientas ≤ tope, nombres únicos, ${MENSAJERIA.size} de mensajería existen`);

  // 6. Cursores fabricados y offsets: 400, nunca 500 ni una página en silencio.
  {
    const r1 = await fetchImpl(`${url}/index/agents?cursor=abc`); await r1.text();
    if (r1.status === 404) indecisa('cursor-fabricado', 'la casa no tiene índice federado');
    else {
      const r2 = await fetchImpl(`${url}/index/agents?offset=1`); await r2.text();
      const r3 = await fetchImpl(`${url}/index/agents?cursor=${encodeURIComponent(Buffer.from('{"s":1,"a":"x","g":999999}').toString('base64url'))}`); await r3.text();
      const malos = [[r1, 'cursor=abc', [400]], [r2, 'offset=1', [400]], [r3, 'cursor de otra generación', [400, 410]]].filter(([r, , esperados]) => !esperados.includes(r.status)).map(([r, q]) => `${q} -> ${r.status}`);
      if (malos.length) falla('cursor-fabricado', malos.join(', '));
      else ok('cursor-fabricado', 'cursor inválido 400, offset 400, cursor de otra generación 400/410');
    }
  }

  // 7. Un cuerpo gigante no tumba la ruta: 4xx, o la conexión cerrada a medio subir (el adaptador
  //    de Node corta en 2 MB sin leer el resto; el edge contesta 413). Nunca 5xx ni aceptado.
  {
    const grande = JSON.stringify({ local: 'x', relleno: 'a'.repeat(2 * 1_048_576) });
    const malos = [], vistos = [];
    for (const ruta of ['/agents', '/inbound']) {
      const r = await fetchImpl(`${url}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: grande }).catch(() => ({ status: 'conexión cerrada', text: async () => '' }));
      await r.text();
      vistos.push(`${ruta} -> ${r.status}`);
      if (typeof r.status === 'number' && (r.status >= 500 || r.status < 400)) malos.push(`POST ${ruta} -> ${r.status}`);
    }
    if (malos.length) falla('cuerpo-gigante', malos.join(', '));
    else ok('cuerpo-gigante', `2 MB rechazados: ${vistos.join(', ')}`);
  }

  return resumen(comprobaciones);
}

function resumen(comprobaciones) {
  const cuenta = (e) => comprobaciones.filter((c) => c.estado === e).length;
  return { total: comprobaciones.length, ok: cuenta('ok'), fallas: cuenta('falla'), indecisas: cuenta('indecisa'), comprobaciones };
}

// Casa local para revisar sin depender de nada: registro abierto (para el agente secreto), tasa
// baja (para provocar 429 rápido), índice, verifica@ y un catálogo sembrado (para tareas@).
export async function casaLocal({ puerto = 4759 } = {}) {
  const { Estafeta } = await import('../src/correo/estafeta.js');
  const dominio = 'revision.local';
  const url = `http://127.0.0.1:${puerto}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-revision-'));
  const casa = new Estafeta({
    domain: dominio, port: puerto, dataDir: path.join(tmp, dominio), adminToken: 'revision', hosts: { [dominio]: { url } },
    workerIntervalMs: 60_000, log: () => {},
    policy: { registration: 'open', registrations_per_minute: 20, rate_per_minute: 20 },
    index: { enabled: true, crawlMinutes: 999 }, verifica: { enabled: true },
    tareas: { catalogo: [{ id: 'hola', concept: 'decir hola', price: 10, verify: { type: 'sha256', expect: '0'.repeat(64) } }] },
  });
  await casa.start();
  return { casa, url, adminToken: 'revision', cerrar: async () => { await casa.stop(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = argumentos(process.argv.slice(2));
  let local = null;
  const url = a.url || (local = await casaLocal({ puerto: Number(a.puerto || 4759) })).url;
  const adminToken = a['admin-token'] || local?.adminToken || null;
  console.log(`revisión adversarial contra ${url}${local ? ' (casa local levantada para esto)' : ''}`);
  const r = await revisar({ url, adminToken, inundar: !a['sin-inundar'], intentos: Number(a.intentos || 200), log: (m) => console.log(`  ${m}`) });
  await local?.cerrar();
  console.log(`\n${r.total} comprobaciones: ${r.ok} ok · ${r.fallas} fallas · ${r.indecisas} indecisas`);
  process.exit(r.fallas ? 1 : 0);
}
