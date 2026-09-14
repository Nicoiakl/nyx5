// node --test test/
// Ningún archivo fuente lleva un carácter invisible (ancho cero, bidi, BOM) ni un NUL literal: se
// escriben con escapes (barra, u, cuatro hexadecimales), porque el carácter literal se corrompe en
// silencio al editar y las herramientas lo pierden al reescribir (pasó el 13-sep-2026 dos veces, y el
// 14-sep otra vez: un NUL literal en test/perfil.test.js vivía en main sin que nadie lo viera).
//
// Por qué es una prueba y no un `grep` en la guía: en esta máquina `grep` es una función de shell
// que envuelve otro buscador y NO encontró ni el NUL ni los U+200B literales (dio 0 con los
// caracteres presentes). Un control que depende de qué `grep` haya en el PATH no es un control.
//
// Los caracteres se construyen con `String.fromCodePoint`, no se escriben: la herramienta que
// escribió este archivo convierte un escape tipeado en el carácter literal, y este archivo se barre
// a sí mismo.
//
// Qué NO cubre: los documentos fuera de docs/SPEC.md (bitácoras y planes pueden citar caracteres
// para describirlos), y los archivos binarios. El barrido es sobre lo que se ejecuta o se publica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cp = (n) => String.fromCodePoint(n);
// Rangos: ancho cero y marcas (200B–200F), bidi (202A–202E, 2066–2069), invisibles (2060–2064), BOM, NUL.
const CLASE = `[${cp(0x200b)}-${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2069)}${cp(0xfeff)}${cp(0)}]`;
const INVISIBLE = new RegExp(CLASE);
const TODOS = new RegExp(CLASE, 'g');
const EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.md', '.sql', '.json', '.txt', '.css']);
const DIRS = ['src', 'test', 'scripts', 'web', 'bin', 'migrations', 'demo'];
const ARCHIVOS = ['docs/SPEC.md', 'docs/SPEC.en.md', 'README.md', 'README.es.md'];

function* archivos(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* archivos(p); } else if (EXT.has(path.extname(e.name))) yield p;
  }
}
const marcado = (l) => l.replace(TODOS, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
export const hallazgos = (texto) => texto.split('\n').map((l, i) => (INVISIBLE.test(l) ? `${i + 1}: ${marcado(l).slice(0, 120)}` : null)).filter(Boolean);

test('la fuente no lleva caracteres invisibles ni NUL literales (se escriben con escapes)', () => {
  // El detector se comprueba contra un caso que tiene que gritar y uno que tiene que callar, en
  // memoria: si esta parte falla, la lista de abajo no vale nada.
  assert.equal(hallazgos(`a${cp(0x200b)}b\nc`).length, 1, 'el detector no ve un ancho cero');
  assert.equal(hallazgos(`x${cp(0)}y`).length, 1, 'el detector no ve un NUL');
  assert.equal(hallazgos(`a${cp(0x202e)}b`).length, 1, 'el detector no ve una marca bidi');
  const barra = cp(0x5c);
  assert.equal(hallazgos(`con escape: '${barra}u200b' y '${barra}u0000'`).length, 0, 'un escape escrito con barra NO es un invisible');
  const lista = [];
  for (const d of DIRS) { const p = path.join(raiz, d); if (fs.existsSync(p)) lista.push(...archivos(p)); }
  for (const f of ARCHIVOS) { const p = path.join(raiz, f); if (fs.existsSync(p)) lista.push(p); }
  assert.ok(lista.length > 50, `se esperaban los archivos del repo, se vieron ${lista.length}`);
  const sucios = [];
  for (const f of lista) { const h = hallazgos(fs.readFileSync(f, 'utf8')); if (h.length) sucios.push(`${path.relative(raiz, f)} ${h.join(' | ')}`); }
  assert.deepEqual(sucios, [], `archivos con invisibles o NUL literales (${sucios.length} de ${lista.length} revisados):\n${sucios.join('\n')}`);
});
