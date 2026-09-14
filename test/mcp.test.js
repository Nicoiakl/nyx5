// node --test test/
// Las descripciones del conector MCP son lo único que el modelo lee para decidir si usa Nyx5.
// No son documentación: son la capacidad + la garantía + el momento de uso (brief D1).
// Este test es la guardia que impide que vuelvan a ser "documentación de API".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Las herramientas viven en UN módulo que sirven los dos puentes (stdio y remoto por HTTP).
const src = fs.readFileSync(new URL('../src/puentes/herramientas.js', import.meta.url), 'utf8');
// extrae { name, description } de cada herramienta
const tools = [...src.matchAll(/\{ name: '([a-z0-9_]+)', description: '((?:[^'\\]|\\.)*)'/g)]
  .map((m) => ({ name: m[1], description: m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\') }));

// una garantía del sistema que un modelo no obtiene de otra forma
// Las descriptions las lee un MODELO y ahora van en inglés, como todo lo público. Lo que el
// guard protege no cambia: cada una debe declarar una garantía del sistema (por qué creerle) y
// decir cuándo conviene usarla, no describir el mecanismo.
const GARANTIA = /signed|signature|mailbox|entry|ledger|receipt|held|hold|verif|certif|encrypt|decrypt|irreversible|hash|deny|proof|bond/i;
// palabra que ancla el MOMENTO de uso o la capacidad (no el mecanismo)
const CAPACIDAD = /use it|when you|find|delegate|offer|accept|check it|check|move|even if|do not know|before |take |leave yourself/i;

test('D1 · hay 29 herramientas y ninguna description quedó como la vieja documentación de API', () => {
  assert.equal(tools.length, 29, `se esperaban 29 herramientas, hay ${tools.length}`);
  // ninguna debe empezar describiendo el mecanismo ("Envía un sobre...", "Operación genérica...")
  for (const t of tools) {
    assert.ok(!/^(Envía un sobre|Operación genérica del Libro|Lee los sobres pendientes)/.test(t.description),
      `${t.name} sigue describiendo el mecanismo, no la capacidad`);
  }
});

test('D1 · cada description declara una garantía del sistema', () => {
  for (const t of tools) {
    assert.ok(GARANTIA.test(t.description), `${t.name} no menciona ninguna garantía (firma/buzón/asiento/recibo/retención/verificación/hash)`);
  }
});

test('D1 · cada description nombra el momento de uso o la capacidad, no solo el mecanismo', () => {
  for (const t of tools) {
    assert.ok(CAPACIDAD.test(t.description), `${t.name} no nombra cuándo usarla ni qué desbloquea`);
  }
});

test('D1 · las descripciones son cortas (presupuesto de atención); libro es la única router', () => {
  for (const t of tools) {
    const tope = t.name === 'nyx5_libro' ? 650 : 340; // libro lleva la lista de ops
    assert.ok(t.description.length <= tope, `${t.name}: ${t.description.length} chars supera ${tope}`);
  }
});

test('D1 · instructions describe el sistema en pocas frases con capacidad y garantía, sin listar herramientas', () => {
  const m = src.match(/INSTRUCCIONES = `([^`]*)`/);
  assert.ok(m, 'falta instructions');
  const inst = m[1];
  assert.ok(GARANTIA.test(inst), 'instructions no menciona una garantía');
  assert.ok(CAPACIDAD.test(inst), 'instructions no dice cuándo conviene usarlo');
  assert.ok(!/nyx5_send|nyx5_inbox|tools\/list/.test(inst), 'instructions no debe listar herramientas (eso lo hace tools/list)');
  // Todo lo que lee un modelo va en inglés, igual que el resto de lo público.
  assert.ok(!/[áéíóúñ¿¡]/.test(inst), 'instructions quedó en español');
  for (const t of tools) assert.ok(!/[áéíóúñ¿¡]/.test(t.description), `${t.name} quedó en español`);
  assert.ok(inst.length <= 700, `instructions demasiado largo: ${inst.length}`);
});

// La spec pública en dos idiomas, con el inglés como canónico (decisión de Nicholas, 8-sep-2026).
// El guard existe porque el fallo sería invisible: /es sirviendo inglés se ve igual de bien.
test('la spec y la portada se sirven SOLO en inglés, y no queda rastro del español', async () => {
  const { SPEC_HTML, LLMS_TXT } = await import('../src/plataformas/spec-html.js');
  const { HOME_HTML } = await import('../src/plataformas/home-html.js');
  for (const [nombre, h] of [['spec', SPEC_HTML], ['portada', HOME_HTML]]) {
    assert.match(h, /<html lang="en">/, `${nombre} debe declararse en inglés`);
    assert.ok(!/hreflang="es"|\/es-home|>Español</.test(h), `${nombre} sigue enlazando a una versión española que ya no existe`);
    assert.ok(!/chasqui/i.test(h), `${nombre} menciona el nombre viejo`);
  }
  assert.match(SPEC_HTML, /<link rel="canonical" href="https:\/\/nyx5\.com\/spec">/);
  assert.match(HOME_HTML, /<link rel="canonical" href="https:\/\/nyx5\.com\/">/);
  assert.match(SPEC_HTML, /Mail and Libro for agents/);
  assert.match(SPEC_HTML, /reputation is a query on the ledger/);
  // El JSON-LD tiene que declarar el idioma real, o los rastreadores indexan mal.
  assert.match(SPEC_HTML, /"inLanguage":"en"/);
  assert.ok(!/Especificación \(español\)/.test(LLMS_TXT));
});

test('la portada apunta a que un agente se una', async () => {
  const { HOME_HTML } = await import('../src/plataformas/home-html.js');
  assert.match(HOME_HTML, /Give your agent an address/);
  const fs = await import('node:fs');
  const cli = fs.readFileSync(new URL('../bin/nyx5.js', import.meta.url), 'utf8');
  for (const h of [HOME_HTML]) {
    // El comando es lo único que la portada pide hacer, y tiene que existir de verdad.
    assert.match(h, /npx @nyx5\/nyx5 join/);
    assert.ok(!/chasqui/i.test(h), 'quedó una mención al nombre viejo');
    // Minimalista de verdad, medido: una sola llamada a la acción y una portada que cabe.
    assert.equal((h.match(/npx @nyx5\/nyx5/g) || []).length, 1, 'un solo comando; dos ya es un menú');
    assert.ok(h.length < 9000, `la portada pesa ${h.length} bytes: está creciendo`);
    assert.equal((h.match(/<h1/g) || []).length, 1);
    assert.ok(!/<h2|<h3/.test(h), 'sin secciones: si necesita subtítulos, ya no es una portada');
  }
  assert.match(cli, /case 'join':/, 'el CLI implementa lo que la portada promete');
  assert.match(HOME_HTML, /href="\/spec"/);
});

// Nació de dos roturas idénticas: "the parent's grantee" y "An agent's reputation" dentro de
// comillas simples tiraron el archivo completo. En inglés los apóstrofos aparecen solos.
test('ningún archivo fuente tiene un apóstrofo dentro de comillas simples', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dirs = ['src/correo', 'src/libro', 'src/nucleo', 'src/puentes', 'src/plataformas', 'bin'];
  const malos = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(raiz, d)).filter((x) => x.endsWith('.js') && !x.includes('html'))) {
      const rel = `${d}/${f}`;
      const src = fs.readFileSync(path.join(raiz, rel), 'utf8');
      // Una comilla simple abierta, texto sin comillas, un apóstrofo entre letras, más texto.
      for (const m of src.matchAll(/'[^'\n\\]*[a-zA-Z]'[a-z]/g)) malos.push(`${rel}: …${m[0]}…`);
    }
  }
  assert.deepEqual(malos, [], `apóstrofo dentro de comillas simples:\n  ${malos.join('\n  ')}`);
});
