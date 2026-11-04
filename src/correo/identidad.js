// Nyx5/1 — qué identidad usa un comando cuando nadie la nombró.
//
// La premisa de Nyx5 es cero fricción: un agente decide usarlo y lo usa, sin pasos previos. Hasta
// el 4-nov-2026 los 16 comandos del cliente exigían `--agent /ruta/larga/a/la/llave.json`, así que
// el primer contacto eran DOS comandos y una ruta que el agente tenía que acarrear entre turnos.
// Una ruta que hay que recordar es estado, y el estado entre turnos es justo donde un modelo
// falla. Aquí no hay estado: la identidad se deduce.
//
// El orden, de lo más explícito a lo más implícito:
//   1. `--agent <ruta>`        quien lo dice, manda. No cambia nada de lo que ya funcionaba.
//   2. `NYX5_AGENT`            para CI y contenedores, donde no hay home del usuario.
//   3. una sola llave en el directorio   el caso normal: tienes una identidad, es ésa.
//   4. el puntero `default`    cuando tienes varias y elegiste una con `nyx5 use`.
//   5. ninguna                 quien llama decide: la CLI se une sola y sigue.
//
// Y lo PROGRESIVO: nada de esto se le pide al que llega. La ruta aparece cuando tienes dos
// identidades, no antes; la casa, cuando quieres otra; la llave explícita, cuando automatizas.
// Tener dos nunca se adivina: dos identidades es ambigüedad, y adivinar ahí firma con la que no
// era. Se devuelve `varias` y el que llama lo dice con los nombres.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// `NYX5_HOME` existe para las pruebas y para un contenedor sin home: un test que escribiera en
// el ~/.nyx5 de quien lo corre le pisaría sus llaves de verdad.
export const directorioDeLlaves = (env = process.env) => env.NYX5_HOME || path.join(os.homedir(), '.nyx5');

// El puntero a la identidad elegida cuando hay varias. Es un archivo de texto con el nombre del
// archivo de llave, no un enlace: un enlace roto es invisible y esto se lee de un vistazo.
export const PUNTERO = 'default';

// Una llave es un archivo que TIENE dirección, no cualquier `.json`. Nació de un borde que
// encontró su propia prueba: un `hosts.json` en el mismo directorio se contaba como identidad, y
// con eso una máquina con una sola llave parecía tener dos y quedaba preguntando.
export function listarLlaves(dir) {
  let entradas;
  try { entradas = fs.readdirSync(dir); } catch { return []; }
  return entradas.filter((f) => f.endsWith('.json') && direccionDe(path.join(dir, f))).sort();
}

export function leerPuntero(dir) {
  try { return fs.readFileSync(path.join(dir, PUNTERO), 'utf8').trim() || null; } catch { return null; }
}

export function escribirPuntero(dir, archivo) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PUNTERO), `${archivo}\n`, { mode: 0o600 });
}

// La dirección que hay dentro de un archivo de llave, para poder elegir por dirección y no por
// nombre de archivo. Un archivo ilegible no tumba la elección: devuelve null y se ignora.
export function direccionDe(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')).address || null; } catch { return null; }
}

// -> { ruta } | { ninguna: true, dir } | { varias: [{ archivo, address }], dir }
export function elegirLlave({ flag = null, env = process.env, dir = null } = {}) {
  if (flag) return { ruta: flag };
  if (env.NYX5_AGENT) return { ruta: env.NYX5_AGENT };
  const d = dir || directorioDeLlaves(env);
  const llaves = listarLlaves(d);
  if (llaves.length === 0) return { ninguna: true, dir: d };
  if (llaves.length === 1) return { ruta: path.join(d, llaves[0]) };
  const elegido = leerPuntero(d);
  if (elegido && llaves.includes(elegido)) return { ruta: path.join(d, elegido) };
  return { varias: llaves.map((archivo) => ({ archivo, address: direccionDe(path.join(d, archivo)) })), dir: d };
}

// El archivo que corresponde a una dirección (o a un nombre de archivo), para `nyx5 use`.
export function archivoDe(dir, quien) {
  const llaves = listarLlaves(dir);
  const q = String(quien || '').toLowerCase();
  if (llaves.includes(q)) return q;
  if (llaves.includes(`${q}.json`)) return `${q}.json`;
  for (const f of llaves) {
    const a = direccionDe(path.join(dir, f));
    if (a && (a.toLowerCase() === q || a.toLowerCase().split('@')[0] === q)) return f;
  }
  return null;
}
