// Ataque 7: el texto exacto, un solo lugar, sin invisibles.
import fs from 'node:fs';
import { CONFIRMACION } from '../../src/correo/ideas.js';
const ESPERADO = 'Saved as IDEA-007 on 2026-09-15 10:22 UTC. Nothing was executed: this mailbox only records and confirms. Nicholas reads it when he is back.';
const real = CONFIRMACION('IDEA-007', '2026-09-15T10:22:31.123Z');
console.log('texto exacto:', real === ESPERADO ? 'IGUAL' : `DISTINTO\n  ${JSON.stringify(real)}\n  ${JSON.stringify(ESPERADO)}`);
console.log('bytes:', Buffer.byteLength(real), 'ASCII puro:', /^[\x20-\x7e]+$/.test(real));
// ¿Cuántos archivos de src/ contienen el texto (código, no prosa)?
const hits = [];
for (const f of fs.readdirSync('src', { recursive: true })) { const p = `src/${f}`; if (!p.endsWith('.js')) continue; const s = fs.readFileSync(p, 'utf8'); if (s.includes('Nothing was executed')) hits.push(p); }
console.log('archivos de src con el texto:', hits);
// Fecha: distintos ISO -> misma forma; y una fecha rara no rompe la forma.
for (const at of ['2026-09-15T10:22:31.123Z', '2026-09-15T10:22:31Z', '2026-12-31T23:59:59.999Z']) console.log(' ', at, '->', CONFIRMACION('IDEA-001', at));
