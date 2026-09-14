// Genera el sitio de la spec DESDE docs/SPEC.md (el documento no pasa por ninguna mano ni por
// el contexto de un modelo: se lee del disco y se convierte). Produce:
//   docs/site/index.html   — la spec en una página, indexable (meta + JSON-LD para LLMs)
//   docs/site/llms.txt      — pista para rastreadores LLM
//   src/plataformas/spec-html.js — el mismo HTML embebido, para GET /spec
//
// Todo lo público está en inglés (decisión de Nicholas, 8-sep-2026): una sola superficie, una
// sola fuente. El repositorio por dentro sigue en español.
//
//   node scripts/build-spec-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fuentes = {
  en: { md: 'docs/SPEC.md', lang: 'en', url: 'https://nyx5.com/spec',
        pie: 'Nyx5/1 · reference implementation under <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache-2.0</a>. This page is generated from <code>docs/SPEC.md</code>. The standard and the code say the same thing.',
        sufijo: 'the specification' },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);

// Conversor markdown -> HTML acotado al subconjunto que usa la spec: encabezados, tablas, code
// fences, listas, citas, párrafos. Sin dependencias.
export function toHtml(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^(\s*)```(.*)$/.exec(line);                 // code fence (aun indentado bajo una lista)
    if (fence) {
      const indent = fence[1].length; const lang = fence[2].trim();
      const buf = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(esc(lines[i].slice(indent))); i++; }
      i++;
      out.push(`<pre class="lang-${lang || 'text'}"><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const n = h[1].length; const t = h[2]; out.push(`<h${n} id="${slug(t)}">${inline(t)}</h${n}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) { // tabla
      // Un `\|` dentro de una celda es un pipe literal (así se escribe una alternancia en una
      // tabla de markdown). Se protege antes de partir y se restituye después: partir por `|`
      // a secas rompía la celda en dos y dejaba los backticks sueltos a la vista.
      const row = (l) => l.trim().replace(/^\||\|$/g, '').replace(/\\\|/g, '\u0000')
        .split('|').map((c) => c.trim().replace(/\u0000/g, '|'));
      const head = row(line); i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(row(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {                            // lista con viñetas
      // Una viñeta que sigue en la línea de abajo (indentada) es la MISMA viñeta: antes el conversor
      // cerraba el <ul> en cada salto de línea y la continuación salía como <p> suelto, con el
      // `código` partido por la mitad (34 casos en el sitio el 14-sep-2026). Misma regla que la lista
      // numerada: continuación indentada, un bloque de código dentro del ítem, y una línea en blanco
      // sólo si lo que sigue es continuación u otra viñeta.
      // Cada ítem junta su texto CRUDO y se convierte al final: un `código` partido entre dos líneas
      // sólo cierra si las dos mitades se ven juntas. `html` es lo ya convertido (un bloque de código).
      const items = [];
      const cerrar = (it) => it.html + (it.raw ? inline(it.raw) : '');
      while (i < lines.length) {
        if (/^\s*[-*]\s+/.test(lines[i])) { items.push({ html: '', raw: lines[i].replace(/^\s*[-*]\s+/, '') }); i++; continue; }
        const sig = lines[i + 1] ?? '';
        if (lines[i].trim() === '' && (/^\s{2,}\S/.test(sig) || /^\s*[-*]\s+/.test(sig))) { i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          const it = items[items.length - 1];
          if (/^\s*```/.test(lines[i])) {
            const indent = /^(\s*)/.exec(lines[i])[1].length; const cb = []; i++;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { cb.push(esc(lines[i].slice(indent))); i++; }
            i++;
            it.html = cerrar(it) + `<pre><code>${cb.join('\n')}</code></pre>`; it.raw = '';
          } else { it.raw += ' ' + lines[i].trim(); i++; }
          continue;
        }
        break;
      }
      out.push(`<ul>${items.map((it) => `<li>${cerrar(it)}</li>`).join('')}</ul>`); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {                           // lista numerada
      // Un bloque indentado entre dos ítems (un ejemplo de código, un párrafo de continuación)
      // NO cierra la lista: antes la partía en dos <ol> y la numeración volvía a empezar en 1,
      // que en una especificación con pasos ordenados dice algo falso.
      const buf = [];
      const inicio = Number(/^\s*(\d+)\./.exec(line)[1]) || 1;
      while (i < lines.length) {
        if (/^\s*\d+\.\s+/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`); i++; continue; }
        // Continuación: indentada, o una línea en blanco seguida de indentación o de otro ítem.
        const sig = lines[i + 1] ?? '';
        if (lines[i].trim() === '' && (/^\s{2,}\S/.test(sig) || /^\s*\d+\.\s+/.test(sig))) { i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && buf.length) {
          const fence = /^\s*```/.test(lines[i]);
          if (fence) { // el bloque de código de dentro del ítem se emite tal cual, sin cerrar la lista
            const indent = /^(\s*)/.exec(lines[i])[1].length; const cb = []; i++;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { cb.push(esc(lines[i].slice(indent))); i++; }
            i++;
            buf[buf.length - 1] += `<pre><code>${cb.join('\n')}</code></pre>`;
          } else { buf[buf.length - 1] += ` ${inline(lines[i].trim())}`; i++; }
          continue;
        }
        break;
      }
      out.push(`<ol${inicio !== 1 ? ` start="${inicio}"` : ''}>${buf.join('')}</ol>`); continue;
    }
    if (/^\s*>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    const buf = [line];                                        // párrafo (hasta línea en blanco)
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// Título y descripción para <meta> y JSON-LD, tomados del propio documento.
function construir(clave) {
  const cfg = fuentes[clave];
  const md = fs.readFileSync(path.join(root, cfg.md), 'utf8');
  const titulo = (/^#\s+(.*)$/m.exec(md) || [, 'Nyx5/1'])[1].trim();
// Descripción para <meta>/JSON-LD/llms: el primer párrafo de contenido, tomado DESPUÉS del primer
// encabezado de sección (así se salta el "Estado:" y el "Implementación de referencia:" del preámbulo).
const _ls = md.split('\n');
const _desde = _ls.findIndex((l) => /^##\s/.test(l));
const primerParrafo = (_ls.slice(_desde + 1).find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('-')) || 'Correo y libro para agentes de IA.').trim();
const desc = primerParrafo.replace(/[`*]/g, '').replace(/[:\s]+$/, '.').slice(0, 300);
const body = toHtml(md);

const jsonld = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'TechArticle',
  name: titulo, headline: titulo, description: desc,
  inLanguage: cfg.lang, url: cfg.url, license: 'https://www.apache.org/licenses/LICENSE-2.0',
  about: ['agent communication protocol', 'signed messaging', 'double-entry ledger for AI agents'],
});

// La cáscara (estilos + meta) es código de esta herramienta, no contenido del documento.
const html = `<!doctype html>
<html lang="${cfg.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} — ${cfg.sufijo}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${cfg.url}">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${cfg.url}">
<meta property="og:site_name" content="Nyx5">
<meta property="og:image" content="https://nyx5.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(titulo)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="https://nyx5.com/og.png">
<script type="application/ld+json">${jsonld}</script>
<style>
  :root { --ink:#1a1a1a; --dim:#666; --bg:#fff; --soft:#f6f6f4; --line:#e5e5e0; --accent:#7a4d1d; --code:#f0efe9; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e8e6e0; --dim:#9a978f; --bg:#151513; --soft:#1e1e1b; --line:#33322d; --accent:#d6a86a; --code:#222220; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 22px 120px; }
  h1 { font-size: 2.1rem; line-height:1.15; margin: 0 0 .2em; letter-spacing:-.01em; }
  h2 { font-size: 1.45rem; margin: 2.4em 0 .5em; padding-top:.4em; border-top:1px solid var(--line); }
  h3 { font-size: 1.12rem; margin: 1.8em 0 .4em; }
  h2:first-of-type { border-top:none; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  code { background: var(--code); padding: .1em .35em; border-radius: 4px; font: .88em ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background: var(--soft); border:1px solid var(--line); border-radius: 8px; padding: 14px 16px; overflow-x:auto; }
  pre code { background:none; padding:0; font-size:.82rem; line-height:1.5; }
  table { border-collapse: collapse; width:100%; margin: 1.2em 0; font-size:.92rem; display:block; overflow-x:auto; }
  th, td { border:1px solid var(--line); padding: 7px 11px; text-align:left; vertical-align:top; }
  th { background: var(--soft); }
  blockquote { margin:1em 0; padding:.2em 1em; border-left:3px solid var(--accent); color:var(--dim); }
  ul, ol { padding-left: 1.3em; }
  li { margin:.25em 0; }
  .tag { display:inline-block; margin-top:14px; color:var(--dim); font-size:.85rem; }
  footer { max-width:760px; margin:0 auto; padding: 0 22px 60px; color:var(--dim); font-size:.85rem; border-top:1px solid var(--line); padding-top:22px; }
</style>
</head>
<body>
<main>
${body}
</main>
<footer>
${cfg.pie}
</footer>
</body>
</html>
`;

  return { html, desc, titulo, body };
}

// Generar es el efecto; se corre sólo cuando este archivo es el programa principal, para que
// `test/superficie.test.js` pueda importar `toHtml` sin reescribir el sitio.
export function generar() {
const en = construir('en');

// llms.txt en inglés: es lo que lee un rastreador, y el inglés es la versión canónica.
const llms = `# Nyx5/1

> ${en.desc}

Nyx5 is a communication protocol for AI agents: agent@domain addresses, a store-and-forward
mailbox, signed (Ed25519) and encrypted (X25519+AES-GCM) envelopes, and a per-house double-entry
ledger with contracts (escrow, bond, metered) and chained mandates.

What makes it different from every other agent protocol: **a claim costs something**. Escrow is
released only when a deterministic check passes, a false assertion forfeits its bond, and an
agent's reputation is not a score but a public query on the ledger — every point of it cost tokens
and is tied to a verified delivery.

- Specification: https://nyx5.com/spec
- Join in one command: \`npx @nyx5/nyx5 join\`
- Package: https://www.npmjs.com/package/@nyx5/nyx5
- Source: https://github.com/Nicoiakl/nyx5
- License: Apache-2.0
- No dependencies. Reference implementation on Node and Cloudflare Workers.
`;

const outDir = path.join(root, 'docs/site');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), en.html);
fs.writeFileSync(path.join(outDir, 'llms.txt'), llms);

// El módulo que sirve la casa: los HTML embebidos como string (tampoco pasan por el chat).
const mod = `// GENERADO por scripts/build-spec-site.mjs desde docs/SPEC.md — no editar a mano.\n` +
  `export const SPEC_HTML = ${JSON.stringify(en.html)};\n` +
  `export const LLMS_TXT = ${JSON.stringify(llms)};\n`;
fs.writeFileSync(path.join(root, 'src/plataformas/spec-html.js'), mod);

console.log(`sitio generado: ${(en.html.length / 1024).toFixed(1)} KB, ${en.body.match(/<h2/g)?.length || 0} secciones`);
return en;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) generar();
