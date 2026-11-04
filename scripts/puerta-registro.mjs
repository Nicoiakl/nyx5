// La OTRA puerta: el registro oficial de MCP, que es por donde un agente nos encuentra.
//
// Nació de un defecto real (4-nov-2026), el mismo patrón que la puerta de npm y peor consecuencia.
// El registro servía 0.7.0 del 14 de septiembre y, dentro de la entrada, declaraba `--agent` como
// `isRequired: true` con un texto que mandaba a correr `join` primero y pegar la ruta de la llave.
// Esa misma tarde habíamos borrado justamente esa fricción: la identidad se crea sola en la primera
// llamada. O sea que el canal por el que se supone que nos descubren le estaba ENSEÑANDO a un
// desconocido el paso que ya no existe, y además el único que podía hacerlo renunciar.
//
// La entrada del registro no es documentación: es la RECETA con la que un cliente arma el comando.
// Un campo requerido ahí es un campo que el desconocido tiene que rellenar antes de ver nada.
//
// Cuatro reglas, cada una de un defecto medido:
//   1. la versión que el registro da por última es la de este repo       (la entrada vieja de 7 semanas)
//   2. la entrada no exige NADA al que llega                             (`--agent` requerido)
//   3. todo identificador que sea una URL existe y no apunta a una       (el .mcpb de v0.4.0)
//      versión que ya no es la actual
//   4. la versión de npm que declara es la que npm sirve                 (declarar lo que no existe)
//
// Falla cerrado: si no se puede leer el registro, es rojo (2), porque «no pude mirar» no es «está
// bien». Y reclama con precisión: dice qué campo, con qué valor, y qué habría que hacer.
//
//   node scripts/puerta-registro.mjs
//   node scripts/puerta-registro.mjs --json

import { readFileSync } from 'node:fs';

export const SERVIDOR = 'io.github.Nicoiakl/nyx5';
export const REGISTRO = 'https://registry.modelcontextprotocol.io';

// Todo argumento de la entrada, de los dos arrays que un cliente concatena.
const argumentos = (paquete) => [...(paquete.runtimeArguments || []), ...(paquete.packageArguments || [])];

// Una URL que lleva la versión dentro (…/v0.4.0/nyx5-0.4.0.mcpb) envejece sin avisar: sigue
// devolviendo 200 para siempre y sirve código viejo con buena cara.
export const versionEnLaUrl = (url) => (/\bv?(\d+\.\d+\.\d+)\b/.exec(url) || [])[1] || null;

// La comparación, aparte de la red, para poder probarla contra la entrada que de verdad falló.
export function revisar({ entrada, versionRepo, npmLatest = null }) {
  const problemas = [];
  if (!entrada) {
    problemas.push({ regla: 1, que: 'el registro no tiene ninguna entrada para este servidor', arreglo: `publicar: node scripts/publicar-registro.mjs` });
    return problemas;
  }
  const sv = entrada.server || entrada;

  if (sv.version !== versionRepo) {
    problemas.push({
      regla: 1,
      que: `el registro da por última la ${sv.version} y este repo es la ${versionRepo}`,
      arreglo: 'publicar la entrada nueva: node scripts/publicar-registro.mjs',
    });
  }

  for (const pk of sv.packages || []) {
    for (const a of argumentos(pk)) {
      if (a.isRequired) {
        problemas.push({
          regla: 2,
          que: `la entrada exige ${a.name || a.valueHint || a.value} antes de poder usar nada`,
          arreglo: 'quitarlo de server.json: lo que el que llega tiene que rellenar es fricción, y la identidad se crea sola',
        });
      }
    }
    if (/^https?:\/\//.test(pk.identifier || '')) {
      const v = versionEnLaUrl(pk.identifier);
      if (v && v !== versionRepo) {
        problemas.push({
          regla: 3,
          que: `el paquete ${pk.registryType} apunta a ${pk.identifier} (versión ${v}, el repo es ${versionRepo})`,
          arreglo: 'subir el artefacto de esta versión o quitar ese paquete de server.json: un artefacto viejo servido como actual es peor que ninguno',
        });
      }
    } else if (pk.registryType === 'npm' && npmLatest && pk.version !== npmLatest) {
      problemas.push({
        regla: 4,
        que: `la entrada declara npm ${pk.version} y npm sirve ${npmLatest}`,
        arreglo: 'publicar la entrada con la versión que npm sirve de verdad',
      });
    }
  }
  return problemas;
}

async function json(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function urlExiste(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return r.status;
  } catch (e) {
    return `error: ${e.message}`;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raiz = new URL('..', import.meta.url).pathname;
  const versionRepo = JSON.parse(readFileSync(`${raiz}package.json`, 'utf8')).version;

  let entrada = null;
  let npmLatest = null;
  try {
    const d = await json(`${REGISTRO}/v0/servers?search=nyx5&version=latest`);
    entrada = (d.servers || []).find((s) => (s.server || s).name === SERVIDOR) || null;
    const p = await json('https://registry.npmjs.org/@nyx5/nyx5');
    npmLatest = p['dist-tags']?.latest || null;
  } catch (e) {
    console.error(`no se pudo leer el registro: ${e.message}`);
    process.exit(2);
  }

  const problemas = revisar({ entrada, versionRepo, npmLatest });

  // Regla 3, la parte que sólo sabe la red: que la URL exista.
  for (const pk of (entrada?.server || entrada)?.packages || []) {
    if (/^https?:\/\//.test(pk.identifier || '')) {
      const estado = await urlExiste(pk.identifier);
      if (estado !== 200) problemas.push({ regla: 3, que: `${pk.identifier} contesta ${estado}`, arreglo: 'quitar o reponer ese artefacto' });
    }
  }

  const informe = {
    servidor: SERVIDOR,
    version_en_el_registro: (entrada?.server || entrada)?.version ?? null,
    version_del_repo: versionRepo,
    npm_latest: npmLatest,
    problemas,
    puerta: problemas.length ? 'ATRASADA' : 'al dia',
  };

  if (process.argv.includes('--json')) console.log(JSON.stringify(informe, null, 2));
  else {
    console.log(`${SERVIDOR}: el registro da ${informe.version_en_el_registro}, el repo es ${versionRepo}, npm sirve ${npmLatest}`);
    if (!problemas.length) console.log('puerta al dia: el registro no le pide nada a quien llega y apunta a lo que existe');
    else {
      console.log('PUERTA DEL REGISTRO ATRASADA — esto es lo que ve un agente que nos descubre:');
      for (const p of problemas) console.log(`  [regla ${p.regla}] ${p.que}\n              -> ${p.arreglo}`);
    }
  }
  process.exit(problemas.length ? 1 : 0);
}
