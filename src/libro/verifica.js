// Nyx5/1 — verifica@: el evaluador de referencia de la casa.
//
// Tres pruebas DETERMINISTAS y nada más. Sin juicio de modelo, a propósito: un verificador
// que se equivoca castiga a un inocente y quema la credibilidad del sistema en un día. Si
// una prueba no puede decidir sola y sin ambigüedad, este verificador no la acepta.
//
//   http_status  GET a una URL -> el código es el esperado (200 por defecto)
//   sha256       el cuerpo de una URL (o el texto entregado) hashea a lo declarado
//   json_path    un campo de un JSON servido en una URL vale exactamente lo esperado
//   exit_0       un comando termina con código 0        [solo fuera del edge: necesita shell]
//
// El veredicto es una función pura de (prueba, mundo): dos corridas con el mismo mundo dan
// lo mismo, y la razón siempre viaja con el resultado. Nada de "se ve bien".

import { sha256hex, canonical } from '../nucleo/crypto.js';

export const PRUEBAS = ['http_status', 'sha256', 'json_path', 'exit_0'];
// En el edge no hay shell. Dos señales, porque una sola engañaba:
//   - con nodejs_compat, Workers expone `process` Y deja importar node:child_process, así que
//     ni la variable ni el import distinguen el runtime; la casa anunciaba exit_0 y luego no
//     podía correrla, que es peor que no anunciarla.
//   - workerd se identifica en navigator.userAgent, y ahí no hay proceso que lanzar.
// Ante la duda se declara SIN shell: una capacidad ausente decepciona menos que una incumplida.
const enWorkers = typeof navigator !== 'undefined' && /Cloudflare-Workers/i.test(navigator.userAgent || '');
// SIN `await` en el nivel superior del módulo: un import dinámico ahí retrasa (o cuelga) la carga
// del módulo entero, y el módulo lo carga el servidor al arrancar. En el edge eso se vio como
// peticiones que conectaban por TLS en 0,2 s y luego no respondían nunca, la mitad de las veces.
//
// La señal es el runtime, no el módulo: en el edge no hay proceso que lanzar, y fuera del edge
// (Node) siempre lo hay. Ante la duda se declara SIN shell: una capacidad ausente decepciona
// menos que una incumplida.
export const conShell = !enWorkers && typeof process !== 'undefined' && !!process?.versions?.node;
export const pruebasDisponibles = () => (conShell ? PRUEBAS : PRUEBAS.filter((p) => p !== 'exit_0'));

const recorta = (s, n = 300) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Corre UNA prueba y devuelve un veredicto con su evidencia.
 * @returns {Promise<{pasa:boolean, prueba:string, razon:string, evidencia:object}>}
 */
export async function correrPrueba(prueba, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, entregado = null, entregadoSha256 = null } = {}) {
  const tipo = prueba?.type;
  if (!PRUEBAS.includes(tipo)) {
    return { pasa: false, prueba: tipo || '(sin tipo)', razon: `prueba desconocida: ${tipo}. Las que este verificador acepta: ${pruebasDisponibles().join(', ')}`, evidencia: {} };
  }
  if (tipo === 'exit_0' && !conShell) {
    return { pasa: false, prueba: tipo, razon: 'este verificador corre en el edge y no tiene shell; usa http_status o sha256', evidencia: {} };
  }
  try {
    if (tipo === 'http_status') {
      const esperado = Number(prueba.expect ?? 200);
      if (!/^https:\/\//.test(prueba.url || '')) return { pasa: false, prueba: tipo, razon: 'la URL a verificar debe ser https', evidencia: { url: prueba.url } };
      const res = await fetchImpl(prueba.url, { method: prueba.method || 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      // Un 52x no lo emite el servidor que se está comprobando: lo emite la infraestructura que
      // hay delante cuando no logra llegar. Tratarlo como "la afirmación es falsa" castiga al
      // agente por una red que no controla — pasó de verdad: una tarea sembrada apuntaba a la
      // propia casa, el borde devolvió 522 y el trabajo se devolvió como si fuera mentira.
      if (res.status >= 520 && res.status <= 527) {
        return { pasa: false, indeciso: true, prueba: tipo, razon: `could not reach ${prueba.url} (${res.status} from the edge, not from the server being checked)`, evidencia: { url: prueba.url, status: res.status } };
      }
      const pasa = res.status === esperado;
      return { pasa, prueba: tipo, razon: pasa ? `${prueba.url} responded ${res.status}` : `${prueba.url} responded ${res.status}, expected ${esperado}`, evidencia: { url: prueba.url, status: res.status, expect: esperado } };
    }
    if (tipo === 'sha256') {
      const esperado = String(prueba.expect || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(esperado)) return { pasa: false, prueba: tipo, razon: 'expect debe ser un sha256 en hexadecimal (64 caracteres)', evidencia: {} };
      // El agente pudo declarar el hash de su resultado al entregar (deliver.evidence_sha256).
      // Ese es el caso normal cuando el trabajo no vive en una URL: se compara lo que DIJO
      // contra lo que la tarea exige. Si además hay url, gana lo que se puede descargar.
      if (!prueba.url && entregado == null && entregadoSha256) {
        const visto = String(entregadoSha256).toLowerCase();
        const pasa = visto === esperado;
        return { pasa, prueba: tipo, razon: pasa ? `el hash entregado coincide (${visto.slice(0, 12)}…)` : `el hash entregado (${visto.slice(0, 12)}…) no es el esperado (${esperado.slice(0, 12)}…)`, evidencia: { sha256: visto, expect: esperado, fuente: 'evidence_sha256' } };
      }
      let texto = entregado;
      if (prueba.url) {
        if (!/^https:\/\//.test(prueba.url)) return { pasa: false, prueba: tipo, razon: 'la URL a verificar debe ser https', evidencia: { url: prueba.url } };
        const res = await fetchImpl(prueba.url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { pasa: false, prueba: tipo, razon: `${prueba.url} respondió ${res.status}: no hay qué hashear`, evidencia: { url: prueba.url, status: res.status } };
        texto = await res.text();
      }
      if (texto == null) return { pasa: false, prueba: tipo, razon: 'no hay contenido que hashear: la prueba necesita una url, o la entrega debe declarar evidence_sha256', evidencia: {}, indeciso: true };
      const visto = sha256hex(texto);
      const pasa = visto === esperado;
      return { pasa, prueba: tipo, razon: pasa ? `el hash coincide (${visto.slice(0, 12)}…)` : `el hash no coincide: se vio ${visto.slice(0, 12)}…, se esperaba ${esperado.slice(0, 12)}…`, evidencia: { sha256: visto, expect: esperado, url: prueba.url || null } };
    }
    if (tipo === 'json_path') {
      // Un campo de un JSON, comparado por IGUALDAD ESTRICTA contra un valor esperado. Es lo que
      // permite arbitrar trabajo de verdad ("tu endpoint debe responder {ok:true, version:3}")
      // sin abrir la puerta a criterios que opinan. El camino es literal y sin comodines:
      // `a.b.0.c`. Nada de expresiones — una consulta que hay que interpretar deja de ser
      // determinista, y este verificador solo acepta lo que decide igual dos veces.
      if (!/^https:\/\//.test(prueba.url || '')) return { pasa: false, prueba: tipo, razon: 'the URL to verify must be https', evidencia: { url: prueba.url } };
      if (typeof prueba.path !== 'string' || !prueba.path.length) return { pasa: false, prueba: tipo, razon: 'json_path needs a path, for example "status" or "data.0.id"', evidencia: {} };
      if (!('expect' in prueba)) return { pasa: false, prueba: tipo, razon: 'json_path needs an expect value to compare against', evidencia: {} };
      const res = await fetchImpl(prueba.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { pasa: false, prueba: tipo, razon: `${prueba.url} responded ${res.status}: nothing to read`, evidencia: { url: prueba.url, status: res.status } };
      let doc;
      try { doc = JSON.parse(await res.text()); }
      catch (e) { return { pasa: false, prueba: tipo, razon: `${prueba.url} did not return valid JSON`, evidencia: { url: prueba.url } }; }
      let visto = doc;
      for (const seg of prueba.path.split('.')) {
        if (visto == null || typeof visto !== 'object') { visto = undefined; break; }
        visto = Array.isArray(visto) ? visto[Number(seg)] : visto[seg];
      }
      // La comparación es por forma canónica: {a:1,b:2} y {b:2,a:1} son el mismo valor.
      const igual = canonical(visto ?? null) === canonical(prueba.expect ?? null);
      const corto = (v) => recorta(JSON.stringify(v ?? null), 120);
      return { pasa: igual, prueba: tipo, razon: igual ? `${prueba.path} is ${corto(visto)}` : `${prueba.path} is ${corto(visto)}, expected ${corto(prueba.expect)}`, evidencia: { url: prueba.url, path: prueba.path, seen: visto ?? null, expect: prueba.expect ?? null } };
    }
    // exit_0: solo en Node, sin shell interpretado (nada de `sh -c`), con timeout y sin heredar stdio.
    const { spawn } = await import('node:child_process');
    const argv = Array.isArray(prueba.argv) ? prueba.argv : null;
    if (!argv || !argv.length || typeof argv[0] !== 'string') {
      return { pasa: false, prueba: tipo, razon: 'exit_0 necesita argv: ["comando","arg1",…]; no se acepta una línea de shell', evidencia: {} };
    }
    const res = await new Promise((resolve) => {
      const p = spawn(argv[0], argv.slice(1), { cwd: prueba.cwd || undefined, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: { PATH: process.env.PATH } });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => resolve({ code: null, out, err: e.message }));
      p.on('close', (code) => resolve({ code, out, err }));
    });
    const pasa = res.code === 0;
    return { pasa, prueba: tipo, razon: pasa ? `\`${argv.join(' ')}\` salió con 0` : `\`${argv.join(' ')}\` salió con ${res.code ?? 'error'}: ${recorta(res.err || res.out, 200) || 'sin salida'}`, evidencia: { argv, code: res.code, stderr: recorta(res.err, 200) } };
  } catch (e) {
    // Un fallo de red no es "la afirmación es falsa": es "no se pudo verificar". Se distingue.
    return { pasa: false, prueba: tipo, razon: `no se pudo verificar: ${e.message}`, evidencia: { error: e.message }, indeciso: true };
  }
}

/**
 * Corre todas las pruebas de un contrato. Veredicto conjunto: pasa solo si TODAS pasan.
 * Si alguna quedó indecisa (red caída, timeout), el conjunto queda indeciso y NO se decide:
 * ni liberar ni devolver. Un verificador que decide sin poder mirar es peor que ninguno.
 */
export async function veredicto(pruebas, opts = {}) {
  const lista = Array.isArray(pruebas) ? pruebas : [pruebas];
  if (!lista.length) return { pasa: false, indeciso: true, razon: 'el contrato no declara pruebas de aceptación', resultados: [] };
  const resultados = [];
  for (const p of lista) resultados.push(await correrPrueba(p, opts));
  const indeciso = resultados.some((r) => r.indeciso);
  const pasa = !indeciso && resultados.every((r) => r.pasa);
  const razon = indeciso
    ? `no se pudo verificar: ${resultados.find((r) => r.indeciso).razon}`
    : resultados.map((r) => `${r.pasa ? 'OK' : 'FALLA'} ${r.prueba}: ${r.razon}`).join(' · ');
  return { pasa, indeciso, razon, resultados };
}

// NX-305 — La prueba de un contrato que nace de un PEDIDO al catálogo. La ficha publica el
// `kind` y una descripción en prosa (`template`); los valores concretos (la URL, el hash, el
// camino) los pone quien contrata, en el `input` del pedido. Sólo entran los campos que la
// prueba lee: ni el comprador cuela uno ajeno ni el vendedor uno que la debilite.
//
// `exit_0` NO se deriva de un pedido a propósito: el `argv` lo escribiría el comprador y lo
// correría la casa del vendedor, que cotiza sola. Un vendedor que auto-cotiza sería el proxy
// de cualquiera para ejecutar comandos en la casa. Se cotiza a mano o no se cotiza.
export const CAMPOS_PRUEBA = {
  http_status: { requiere: ['url'], opcionales: ['expect', 'method'] },
  sha256: { requiere: ['expect'], opcionales: ['url'] },
  json_path: { requiere: ['url', 'path', 'expect'], opcionales: [] },
};
export function pruebaDeAceptacion(acceptance, input = {}) {
  const kind = acceptance?.kind;
  const campos = CAMPOS_PRUEBA[kind];
  if (!campos) throw new Error(`acceptance.kind "${kind}" cannot be derived from a request; a request can only fill: ${Object.keys(CAMPOS_PRUEBA).join(', ')}`);
  const dado = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const faltan = campos.requiere.filter((k) => dado[k] === undefined);
  if (faltan.length) throw new Error(`the ${kind} test needs ${faltan.join(', ')} in the request input (${acceptance.template})`);
  const verify = { type: kind };
  for (const k of [...campos.requiere, ...campos.opcionales]) if (dado[k] !== undefined) verify[k] = dado[k];
  // Lo que verifica@ va a rechazar al correr se rechaza AQUÍ, antes de firmar: una prueba que
  // nunca puede pasar castigaría al vendedor por lo que escribió el comprador.
  if (verify.url !== undefined && !/^https:\/\//.test(String(verify.url))) throw new Error(`the ${kind} test needs an https url; the request gave ${JSON.stringify(verify.url)}`);
  if (kind === 'sha256' && !/^[0-9a-f]{64}$/.test(String(verify.expect).toLowerCase())) throw new Error('the sha256 test needs expect as 64 hex characters');
  if (kind === 'json_path' && (typeof verify.path !== 'string' || !verify.path.length)) throw new Error('the json_path test needs path as a non-empty string');
  return verify;
}

// Un contrato es verificable por la casa si declara pruebas en sus términos y nombra
// como árbitro al verificador de la casa. Sin ambas cosas, nadie toca ese escrow.
export function pruebasDe(contrato) {
  const t = contrato?.terms || {};
  const p = t.verify ?? t.pruebas ?? null;
  if (!p) return null;
  return Array.isArray(p) ? p : [p];
}
