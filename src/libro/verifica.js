// Nyx5/1 — verifica@: el evaluador de referencia de la casa.
//
// Pruebas DETERMINISTAS y nada más. Sin juicio de modelo, a propósito: un verificador
// que se equivoca castiga a un inocente y quema la credibilidad del sistema en un día. Si
// una prueba no puede decidir sola y sin ambigüedad, este verificador no la acepta.
//
//   http_status  GET a una URL -> el código es el esperado (200 por defecto)
//   sha256       el cuerpo de una URL (o el texto entregado) hashea a lo declarado
//   json_path    un campo de un JSON servido en una URL vale exactamente lo esperado, o existe
//   regex        el cuerpo de una URL (primer MB) casa con una expresión regular acotada
//   size         el cuerpo de una URL pesa a lo sumo / al menos tantos bytes
//   header       una cabecera de la respuesta vale exactamente lo esperado
//   exit_0       un comando termina con código 0        [solo fuera del edge: necesita shell]
//
// El veredicto es una función pura de (prueba, mundo): dos corridas con el mismo mundo dan
// lo mismo, y la razón siempre viaja con el resultado. Nada de "se ve bien".

import { sha256hex, canonical } from '../nucleo/crypto.js';

export const PRUEBAS = ['http_status', 'sha256', 'json_path', 'regex', 'size', 'header', 'exit_0'];
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

// Tope de lo que se descarga para mirar un cuerpo (regex, size). Un cuerpo más grande no se lee
// entero: el verificador no es un espejo, y un servidor hostil no puede hacerle tragar gigas.
export const CUERPO_MAX = 1_048_576;
export const PATRON_MAX = 256;
const BANDERAS = /^[imsu]{0,4}$/;

const recorta = (s, n = 300) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
const esHttps = (u) => /^https:\/\//.test(u || '');

// Lee el cuerpo de una respuesta hasta `max` bytes y dice si había más. Con un cuerpo en flujo
// (fetch real) corta la descarga; con un doble de pruebas que sólo tiene `text()` recorta lo leído.
async function leerCuerpo(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const lector = res.body.getReader();
    const partes = []; let bytes = 0; let truncado = false;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      const sobra = bytes + value.byteLength - max;
      if (sobra > 0) { partes.push(value.subarray(0, value.byteLength - sobra)); bytes = max; truncado = true; try { await lector.cancel(); } catch { /* ya se leyó lo que se necesitaba */ } break; }
      partes.push(value); bytes += value.byteLength;
    }
    const buf = new Uint8Array(bytes); let o = 0;
    for (const p of partes) { buf.set(p, o); o += p.byteLength; }
    return { texto: new TextDecoder().decode(buf), bytes, truncado };
  }
  const texto = String(await res.text());
  const codificado = new TextEncoder().encode(texto);
  if (codificado.byteLength > max) return { texto: new TextDecoder().decode(codificado.subarray(0, max)), bytes: max, truncado: true };
  return { texto, bytes: codificado.byteLength, truncado: false };
}

// Camino literal de json_path: `a.b.0.c` o `a.b[0].c`. Sin comodines ni expresiones. Devuelve
// la lista de segmentos, o null si la forma no es ésa.
export function segmentosDe(path) {
  if (typeof path !== 'string' || !/^[^.[\]]+(\[\d+\])*(\.[^.[\]]+(\[\d+\])*)*$/.test(path)) return null;
  return path.split('.').flatMap((s) => { const [cabeza, ...idx] = s.split('['); return [cabeza, ...idx.map((i) => i.slice(0, -1))]; });
}

// Lo que se acepta como patrón de `regex`. Un motor de expresiones regulares con retroceso puede
// tardar tiempo exponencial con ciertas formas, y el verificador no puede interrumpir una prueba a
// medias: el edge lo mataría por CPU y el contrato quedaría indeciso para siempre. En vez de medir
// el tiempo se RESTRINGE la sintaxis a lo que no lo sufre:
//   - sin referencias hacia atrás (\1, \k<n>);
//   - ningún cuantificador sobre un grupo que por dentro tiene otro cuantificador o una
//     alternancia: (a+)+, (a|ab)*, (?:x*)? quedan fuera; [ab]+ y (ab)+ entran;
//   - largo máximo PATRON_MAX y banderas sólo i, m, s, u.
// Lo que NO cubre: no es una prueba formal de linealidad; deja fuera patrones inocentes con esa
// forma (falso positivo visible al cotizar, nunca silencioso) y no acota patrones largos sin
// grupos, que sobre 1 MB siguen siendo lineales.
export function patronSeguro(pattern, flags = '') {
  if (typeof pattern !== 'string' || !pattern.length) return { ok: false, razon: 'regex needs a non-empty pattern' };
  if (pattern.length > PATRON_MAX) return { ok: false, razon: `pattern is longer than ${PATRON_MAX} characters` };
  if (typeof flags !== 'string' || !BANDERAS.test(flags)) return { ok: false, razon: 'flags may only combine i, m, s and u' };
  if (/\\[1-9]|\\k</.test(pattern)) return { ok: false, razon: 'backreferences are not accepted: they can backtrack exponentially' };
  const pila = []; let enClase = false;
  const cuant = (ch) => ch !== undefined && /[*+?{]/.test(ch);
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (enClase) { if (c === ']') enClase = false; continue; }
    if (c === '[') { enClase = true; continue; }
    if (c === '(') {
      pila.push({ cuant: false, alt: false });
      // Prefijos de grupo: (?:  (?=  (?!  (?<=  (?<!  (?<nombre>. El `?` de ahí no es un cuantificador.
      if (pattern[i + 1] === '?') { i += 2; if (pattern[i] === '<' && !/[=!]/.test(pattern[i + 1] || '')) i = pattern.indexOf('>', i); if (i < 0) return { ok: false, razon: 'malformed group' }; }
      continue;
    }
    if (c === ')') {
      const g = pila.pop();
      if (!g) return { ok: false, razon: 'unbalanced parentheses' };
      const sigue = cuant(pattern[i + 1]);
      if (sigue && (g.cuant || g.alt)) return { ok: false, razon: 'a quantifier over a group that contains a quantifier or an alternation is not accepted (it can backtrack exponentially); use a character class like [ab]+' };
      if (pila.length) { const p = pila.at(-1); p.cuant = p.cuant || g.cuant || sigue; p.alt = p.alt || g.alt; }
      continue;
    }
    if (c === '|') { if (pila.length) pila.at(-1).alt = true; continue; }
    if (cuant(c) && pila.length) pila.at(-1).cuant = true;
  }
  if (pila.length) return { ok: false, razon: 'unbalanced parentheses' };
  try { new RegExp(pattern, flags); } catch (e) { return { ok: false, razon: `invalid pattern: ${e.message}` }; }
  return { ok: true };
}

/**
 * Corre UNA prueba y devuelve un veredicto con su evidencia.
 * @returns {Promise<{pasa:boolean, prueba:string, razon:string, evidencia:object, indeciso?:boolean}>}
 */
export async function correrPrueba(prueba, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, entregado = null, entregadoSha256 = null } = {}) {
  const tipo = prueba?.type;
  if (!PRUEBAS.includes(tipo)) {
    return { pasa: false, prueba: tipo || '(sin tipo)', razon: `prueba desconocida: ${tipo}. Las que este verificador acepta: ${pruebasDisponibles().join(', ')}`, evidencia: {} };
  }
  if (tipo === 'exit_0' && !conShell) {
    return { pasa: false, prueba: tipo, razon: 'este verificador corre en el edge y no tiene shell; usa http_status, sha256, json_path, regex, size o header', evidencia: {} };
  }
  const falla = (razon, evidencia = {}) => ({ pasa: false, prueba: tipo, razon, evidencia });
  // Un 52x no lo emite el servidor que se está comprobando: lo emite la infraestructura que
  // hay delante cuando no logra llegar. Tratarlo como "la afirmación es falsa" castiga al
  // agente por una red que no controla — pasó de verdad: una tarea sembrada apuntaba a la
  // propia casa, el borde devolvió 522 y el trabajo se devolvió como si fuera mentira.
  const delBorde = (res) => (res.status >= 520 && res.status <= 527
    ? { pasa: false, indeciso: true, prueba: tipo, razon: `could not reach ${prueba.url} (${res.status} from the edge, not from the server being checked)`, evidencia: { url: prueba.url, status: res.status } }
    : null);
  try {
    if (tipo === 'http_status') {
      const esperado = Number(prueba.expect ?? 200);
      if (!esHttps(prueba.url)) return falla('la URL a verificar debe ser https', { url: prueba.url });
      const res = await fetchImpl(prueba.url, { method: prueba.method || 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const borde = delBorde(res); if (borde) return borde;
      const pasa = res.status === esperado;
      return { pasa, prueba: tipo, razon: pasa ? `${prueba.url} responded ${res.status}` : `${prueba.url} responded ${res.status}, expected ${esperado}`, evidencia: { url: prueba.url, status: res.status, expect: esperado } };
    }
    if (tipo === 'sha256') {
      const esperado = String(prueba.expect || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(esperado)) return falla('expect debe ser un sha256 en hexadecimal (64 caracteres)');
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
        if (!esHttps(prueba.url)) return falla('la URL a verificar debe ser https', { url: prueba.url });
        const res = await fetchImpl(prueba.url, { signal: AbortSignal.timeout(timeoutMs) });
        const borde = delBorde(res); if (borde) return borde;
        if (!res.ok) return falla(`${prueba.url} respondió ${res.status}: no hay qué hashear`, { url: prueba.url, status: res.status });
        texto = await res.text();
      }
      if (texto == null) return { pasa: false, prueba: tipo, razon: 'no hay contenido que hashear: la prueba necesita una url, o la entrega debe declarar evidence_sha256', evidencia: {}, indeciso: true };
      const visto = sha256hex(texto);
      const pasa = visto === esperado;
      return { pasa, prueba: tipo, razon: pasa ? `el hash coincide (${visto.slice(0, 12)}…)` : `el hash no coincide: se vio ${visto.slice(0, 12)}…, se esperaba ${esperado.slice(0, 12)}…`, evidencia: { sha256: visto, expect: esperado, url: prueba.url || null } };
    }
    if (tipo === 'json_path') {
      // Un campo de un JSON, comparado por IGUALDAD ESTRICTA contra un valor esperado, o su
      // mera EXISTENCIA. Es lo que permite arbitrar trabajo de verdad ("tu endpoint debe
      // responder {ok:true, version:3}") sin abrir la puerta a criterios que opinan. El camino
      // es literal y sin comodines: `a.b.0.c` o `a.b[0].c`. Nada de expresiones — una consulta
      // que hay que interpretar deja de ser determinista, y este verificador solo acepta lo que
      // decide igual dos veces.
      if (!esHttps(prueba.url)) return falla('the URL to verify must be https', { url: prueba.url });
      const segmentos = segmentosDe(prueba.path);
      if (!segmentos) return falla('json_path needs a path: literal, for example "status", "data.0.id" or "data[0].id"');
      const conValor = 'expect' in prueba || 'equals' in prueba;
      const conExiste = 'exists' in prueba;
      if (conValor && conExiste) return falla('json_path takes either expect (or equals) or exists, not both');
      if (!conValor && !conExiste) return falla('json_path needs an expect value to compare against, or exists: true|false');
      if (conExiste && typeof prueba.exists !== 'boolean') return falla('json_path exists must be true or false');
      const esperado = 'expect' in prueba ? prueba.expect : prueba.equals;
      const res = await fetchImpl(prueba.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      const borde = delBorde(res); if (borde) return borde;
      if (!res.ok) return falla(`${prueba.url} responded ${res.status}: nothing to read`, { url: prueba.url, status: res.status });
      let doc;
      try { doc = JSON.parse((await leerCuerpo(res, CUERPO_MAX)).texto); }
      catch { return falla(`${prueba.url} did not return valid JSON`, { url: prueba.url }); }
      let visto = doc;
      for (const seg of segmentos) {
        if (visto == null || typeof visto !== 'object') { visto = undefined; break; }
        visto = Array.isArray(visto) ? visto[Number(seg)] : visto[seg];
      }
      const corto = (v) => recorta(JSON.stringify(v ?? null), 120);
      if (conExiste) {
        const hay = visto !== undefined;
        const pasa = hay === prueba.exists;
        return { pasa, prueba: tipo, razon: `${prueba.path} ${hay ? 'exists' : 'does not exist'}${pasa ? '' : `, expected it ${prueba.exists ? 'to exist' : 'not to exist'}`}`, evidencia: { url: prueba.url, path: prueba.path, exists: hay, expect_exists: prueba.exists } };
      }
      // La comparación es por forma canónica: {a:1,b:2} y {b:2,a:1} son el mismo valor.
      const igual = visto !== undefined && canonical(visto ?? null) === canonical(esperado ?? null);
      return { pasa: igual, prueba: tipo, razon: igual ? `${prueba.path} is ${corto(visto)}` : `${prueba.path} is ${visto === undefined ? 'missing' : corto(visto)}, expected ${corto(esperado)}`, evidencia: { url: prueba.url, path: prueba.path, seen: visto ?? null, expect: esperado ?? null } };
    }
    if (tipo === 'regex') {
      // Sobre el primer MB del cuerpo, con un patrón acotado (ver patronSeguro). Si el cuerpo
      // era más largo, el veredicto lo dice: lo que se miró es lo que se descargó.
      if (!esHttps(prueba.url)) return falla('the URL to verify must be https', { url: prueba.url });
      const flags = prueba.flags ?? '';
      const seguro = patronSeguro(prueba.pattern, flags);
      if (!seguro.ok) return falla(seguro.razon, { pattern: recorta(String(prueba.pattern ?? ''), 80) });
      const res = await fetchImpl(prueba.url, { signal: AbortSignal.timeout(timeoutMs) });
      const borde = delBorde(res); if (borde) return borde;
      if (!res.ok) return falla(`${prueba.url} responded ${res.status}: nothing to read`, { url: prueba.url, status: res.status });
      const { texto, bytes, truncado } = await leerCuerpo(res, CUERPO_MAX);
      const pasa = new RegExp(prueba.pattern, flags).test(texto);
      const alcance = truncado ? ` (only the first ${CUERPO_MAX} bytes were read)` : '';
      return { pasa, prueba: tipo, razon: pasa ? `the body of ${prueba.url} matches /${prueba.pattern}/${flags}${alcance}` : `the body of ${prueba.url} does not match /${prueba.pattern}/${flags}${alcance}`, evidencia: { url: prueba.url, pattern: prueba.pattern, flags, bytes_read: bytes, truncated: truncado } };
    }
    if (tipo === 'size') {
      if (!esHttps(prueba.url)) return falla('the URL to verify must be https', { url: prueba.url });
      const max = prueba.max_bytes, min = prueba.min_bytes;
      const entero = (v) => v === undefined || (Number.isInteger(v) && v >= 0);
      if (!entero(max) || !entero(min) || (max === undefined && min === undefined)) return falla('size needs max_bytes and/or min_bytes as non-negative integers');
      if (max !== undefined && min !== undefined && min > max) return falla('size: min_bytes cannot exceed max_bytes');
      const res = await fetchImpl(prueba.url, { signal: AbortSignal.timeout(timeoutMs) });
      const borde = delBorde(res); if (borde) return borde;
      if (!res.ok) return falla(`${prueba.url} responded ${res.status}: nothing to measure`, { url: prueba.url, status: res.status });
      // Se cuenta lo que llega, no lo que dice content-length (que puede faltar o mentir). Se
      // lee hasta un byte más que el tope más alto que importa: con eso ya se sabe de qué lado cae.
      const tope = Math.max(CUERPO_MAX, max ?? 0, min ?? 0) + 1;
      const { bytes, truncado } = await leerCuerpo(res, tope);
      const visto = truncado ? `more than ${tope - 1}` : String(bytes);
      const bajoMax = max === undefined || (!truncado && bytes <= max);
      const sobreMin = min === undefined || bytes >= min;
      const pasa = bajoMax && sobreMin;
      const limites = [max !== undefined ? `at most ${max}` : null, min !== undefined ? `at least ${min}` : null].filter(Boolean).join(' and ');
      return { pasa, prueba: tipo, razon: pasa ? `${prueba.url} is ${visto} bytes (${limites})` : `${prueba.url} is ${visto} bytes, expected ${limites}`, evidencia: { url: prueba.url, bytes: truncado ? null : bytes, more_than: truncado ? tope - 1 : null, max_bytes: max ?? null, min_bytes: min ?? null } };
    }
    if (tipo === 'header') {
      if (!esHttps(prueba.url)) return falla('the URL to verify must be https', { url: prueba.url });
      if (typeof prueba.name !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(prueba.name)) return falla('header needs a name (letters, digits and dashes)');
      if (typeof prueba.equals !== 'string') return falla('header needs equals: the exact value expected, as a string');
      const res = await fetchImpl(prueba.url, { method: prueba.method || 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const borde = delBorde(res); if (borde) return borde;
      const nombre = prueba.name.toLowerCase();
      const visto = typeof res.headers?.get === 'function' ? res.headers.get(nombre) : (res.headers?.[nombre] ?? null);
      const pasa = visto === prueba.equals;
      return { pasa, prueba: tipo, razon: pasa ? `${prueba.url} sends ${nombre}: ${recorta(visto, 120)}` : (visto == null ? `${prueba.url} does not send the ${nombre} header, expected ${recorta(prueba.equals, 120)}` : `${prueba.url} sends ${nombre}: ${recorta(visto, 120)}, expected ${recorta(prueba.equals, 120)}`), evidencia: { url: prueba.url, name: nombre, seen: visto, equals: prueba.equals, status: res.status } };
    }
    // exit_0: solo en Node, sin shell interpretado (nada de `sh -c`), con timeout y sin heredar stdio.
    const { spawn } = await import('node:child_process');
    const argv = Array.isArray(prueba.argv) ? prueba.argv : null;
    if (!argv || !argv.length || typeof argv[0] !== 'string') {
      return falla('exit_0 necesita argv: ["comando","arg1",…]; no se acepta una línea de shell');
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

// Un contrato es verificable por la casa si declara pruebas en sus términos y nombra
// como árbitro al verificador de la casa. Sin ambas cosas, nadie toca ese escrow.
export function pruebasDe(contrato) {
  const t = contrato?.terms || {};
  const p = t.verify ?? t.pruebas ?? null;
  if (!p) return null;
  return Array.isArray(p) ? p : [p];
}
