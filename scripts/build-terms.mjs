// Genera src/plataformas/terms-html.js desde docs/TERMS.md (aprobado por Nicholas el 14-sep-2026).
// La página se sirve en /terms sólo si la casa enciende NYX5_TERMS=on: los términos son
// declaraciones vinculantes en nombre del dueño y no salen por defecto.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHtml } from './build-spec-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = fs.readFileSync(path.join(root, 'docs/TERMS.md'), 'utf8');
const cuerpo = toHtml(md);
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms · Nyx5</title>
<meta name="description" content="Terms for the nyx5.com house: what the tokens are, what you may not do, what is not promised.">
<link rel="canonical" href="https://nyx5.com/terms">
<style>
  :root { --bg:#0c0c10; --ink:#eeecf4; --dim:#8f8ca0; --line:#232330; --accent:#9b8cff; --code:#15151d; }
  @media (prefers-color-scheme: light) { :root { --bg:#fbfbfd; --ink:#16161c; --dim:#61616f; --line:#e6e6ee; --accent:#5a45d6; --code:#f2f2f7; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width:640px; margin:0 auto; padding:6vh 24px 6vh; }
  .mark { font-size:.78rem; letter-spacing:.18em; text-transform:uppercase; color:var(--dim); margin:0 0 2rem; }
  h1 { font-size:clamp(1.6rem,4.4vw,2.1rem); line-height:1.15; letter-spacing:-.02em; margin:0 0 1rem; font-weight:600; }
  h2 { font-size:1.1rem; margin:2rem 0 .6rem; font-weight:600; }
  p, li { color:var(--ink); }
  ul { padding-left:1.2rem; }
  code { font:.92em ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--code); border:1px solid var(--line); border-radius:5px; padding:1px 5px; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  nav { display:flex; flex-wrap:wrap; gap:1.3rem; padding-top:1.4rem; margin-top:2.5rem; border-top:1px solid var(--line); font-size:.88rem; }
</style>
</head>
<body>
<main>
  <p class="mark"><a href="/">nyx5</a></p>
${cuerpo}
  <nav><a href="/">Home</a><a href="/spec">Specification</a><a href="/report">The ledger</a></nav>
</main>
</body>
</html>
`;
const mod = `// Generado por scripts/build-terms.mjs desde docs/TERMS.md. No editar a mano: npm run build:terms\nexport const TERMS_HTML = ${JSON.stringify(html)};\n`;
fs.writeFileSync(path.join(root, 'src/plataformas/terms-html.js'), mod);
console.log('terms-html.js generado:', html.length, 'bytes');
