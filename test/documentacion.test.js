// node --test test/
// La documentación pública promete comandos y herramientas. Este guard comprueba que lo prometido
// EXISTE. Nació del defecto más caro de la distribución: el README decía `npx @nyx5/nyx5 join` y
// npm servía una versión sin join. Ese fallo no rompe ninguna prueba: rompe al primer agente que
// lo intenta, y no se entera nadie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => fs.readFileSync(path.join(raiz, f), 'utf8');
const cli = leer('bin/nyx5.js');
// Las herramientas viven en un módulo que sirven los dos puentes (stdio y el remoto por HTTP).
const mcp = leer('src/puentes/herramientas.js');
const docs = ['README.md', 'agents.md'];

test('todo comando que la documentación promete existe en el CLI', () => {
  const implementados = new Set([...cli.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
  assert.ok(implementados.size >= 10, `se esperaban comandos, se vieron ${implementados.size}`);
  for (const doc of docs) {
    const texto = leer(doc);
    const prometidos = new Set([...texto.matchAll(/(?:npx @nyx5\/nyx5|node bin\/nyx5\.js)\s+([a-z]+)/g)].map((m) => m[1]));
    assert.ok(prometidos.size, `${doc} no muestra ningún comando`);
    for (const c of prometidos) assert.ok(implementados.has(c), `${doc} promete "${c}" y el CLI no lo implementa`);
  }
});

test('toda herramienta MCP que la documentación nombra existe en el puente', () => {
  const reales = new Set([...mcp.matchAll(/\{ name: '(nyx5_[a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(reales.size >= 17, `se esperaban al menos 17 herramientas, hay ${reales.size}`);
  for (const doc of docs) {
    for (const m of leer(doc).matchAll(/`(nyx5_[a-z0-9_]+)`/g)) {
      assert.ok(reales.has(m[1]), `${doc} nombra la herramienta "${m[1]}" y no existe`);
    }
  }
});

test('la versión del paquete es la que la documentación asume, y el bin apunta a un archivo real', () => {
  const pkg = JSON.parse(leer('package.json'));
  // El servidor declara su versión desde src/version.js (el edge no tiene sistema de archivos para
  // leer package.json). Si alguien sube la versión del paquete y no ésta, el conector miente.
  const declarada = /VERSION = '([^']+)'/.exec(leer('src/version.js'))?.[1];
  assert.equal(declarada, pkg.version, `src/version.js dice ${declarada} y package.json ${pkg.version}`);
  assert.equal(pkg.name, '@nyx5/nyx5');
  for (const destino of Object.values(pkg.bin)) assert.ok(fs.existsSync(path.join(raiz, destino)), `bin apunta a ${destino}, que no existe`);
  // Todo lo que la documentación menciona como archivo del repo tiene que estar publicado.
  for (const f of ['src/', 'bin/', 'examples/', 'README.md']) {
    assert.ok(pkg.files.includes(f), `${f} no está en package.files: quien instale el paquete no lo recibe`);
  }
  // El número de pruebas que anuncia el README no puede ser inventado.
  const suites = fs.readdirSync(path.join(raiz, 'test')).filter((f) => f.endsWith('.test.js'));
  assert.ok(suites.length >= 15, `se esperaban al menos 15 suites, hay ${suites.length}`);
});

test('ningún documento público quedó con el nombre viejo ni con rutas de ejemplo rotas', () => {
  for (const doc of [...docs, 'CONTRIBUTING.md', 'SECURITY.md']) {
    const texto = leer(doc);
    assert.ok(!/chasqui/i.test(texto), `${doc} menciona el nombre viejo`);
    assert.ok(!/\/ruta\/a\/chasqui|CHASQUI_HOSTS/.test(texto), `${doc} tiene una ruta de ejemplo del nombre viejo`);
  }
  // Todo lo público está en inglés: ni una palabra en español en las superficies que se leen.
  for (const doc of docs) {
    const acentos = (leer(doc).match(/[áéíóúñ¡¿]/g) || []).length;
    assert.ok(acentos === 0, `${doc} tiene ${acentos} caracteres del español: lo público va en inglés`);
  }
});

// El registro oficial de MCP exige que package.json y server.json digan EXACTAMENTE lo mismo, y
// que el namespace respete las mayúsculas del usuario de GitHub. Los dos fallos que costaron un
// intento cada uno: descripción sobre 100 caracteres, y "nicoiakl" en vez de "Nicoiakl".
test('server.json y package.json coinciden, y cumplen lo que el registro oficial exige', () => {
  const pkg = JSON.parse(leer('package.json'));
  const srv = JSON.parse(leer('server.json'));
  assert.equal(srv.name, pkg.mcpName, 'el registro rechaza la publicación si no coinciden');
  assert.match(srv.name, /^io\.github\.Nicoiakl\/[a-z0-9-]+$/, 'el namespace respeta las mayúsculas del usuario de GitHub');
  assert.ok(srv.description.length <= 100, `la descripción tiene ${srv.description.length} caracteres; el registro corta en 100`);
  const p = srv.packages[0];
  assert.equal(p.identifier, pkg.name);
  assert.equal(p.version, srv.version, 'la versión del paquete y la del servidor son la misma');
  assert.equal(p.transport.type, 'stdio');
  // El comando que declara el registro tiene que ser el que el CLI implementa. Se comprueba el
  // OBJETO, no la letra: esto exigia literalmente ['mcp','--agent'] y el 4-nov-2026, cuando la
  // entrada dejo de pedir la llave (se crea sola en la primera llamada), la guardia fallo por la
  // letra con la intencion intacta. Ahora lee lo que la entrada declara y exige que exista.
  const posicionales = p.packageArguments.filter((a) => a.type === 'positional').map((a) => a.value);
  assert.deepEqual(posicionales, ['mcp'], 'el subcomando que declara el registro');
  assert.match(cli, new RegExp(`case '${posicionales[0]}':`), 'el registro declara un subcomando que el CLI no implementa');
  for (const a of p.packageArguments.filter((x) => x.type === 'named')) {
    const bandera = a.name.replace(/^--/, '');
    assert.match(cli, new RegExp(`${bandera}: \\{ type:`), `el registro declara --${bandera} y el CLI no lo acepta`);
  }
  // Versiones concretas: el schema rechaza rangos y "latest".
  for (const v of [srv.version, p.version]) assert.match(v, /^\d+\.\d+\.\d+$/, `"${v}" no es una versión concreta`);
});

// Todo lo que un agente o un humano LEE va en inglés (decisión de Nicholas, 8-sep-2026); el
// repositorio por dentro sigue en español. La frontera es fácil de cruzar sin darse cuenta —un
// mensaje de error nuevo, un console.log— y nadie se entera hasta que un extranjero lo ve.
test('ningún mensaje que sale al usuario quedó en español', () => {
  const fuentes = ['src/correo/estafeta.js', 'src/correo/politica.js', 'src/correo/agente.js', 'src/correo/resolver.js',
    'src/correo/unirse.js', 'src/libro/libro.js', 'src/libro/contratos.js', 'src/libro/tareas.js', 'src/libro/verifica.js',
    'src/puentes/email.js', 'src/nucleo/almacen.js', 'src/nucleo/crypto.js', 'src/plataformas/node.js', 'bin/nyx5.js'];
  // Sale al usuario: reason:, los Error que se lanzan, y lo que el CLI imprime.
  const salida = /(?:reason:\s*|new (?:Libro)?Error\(|console\.log\(|console\.error\(|fail\(\d+,\s*|must\([^,]+,\s*\d+,\s*)(['`])([^'`]{8,})\1/g;
  const tilde = /[áéíóúñ¿¡]/;
  // Dos o más palabras funcionales del español seguidas es la señal; una sola da falsos positivos
  // (`la` y `de` existen en nombres propios y en inglés técnico).
  const funcion = /\b(el|la|los|las|una?|del|para|por|sin|que|con|debe|puede|tiene|está|son|hay|más|ya|solo|desde|cada|este|esta|no se)\b/gi;
  const sospechosos = [];
  for (const f of fuentes) {
    const src = leer(f);
    for (const m of src.matchAll(salida)) {
      const t = m[2];
      if (tilde.test(t) || (t.match(funcion) || []).length >= 2) sospechosos.push(`${f}: ${t.slice(0, 70)}`);
    }
  }
  assert.deepEqual(sospechosos, [], `mensajes en español que ve el usuario:\n  ${sospechosos.join('\n  ')}`);
});

// Cero dependencias es una promesa del README, del CLAUDE.md y de la Constitución, y hasta hoy
// no la vigilaba nada: `dependencies: {}` era verdad por costumbre. Un `npm install` distraído
// la volvía mentira en silencio, y ninguna prueba se enteraba.
test('el paquete no tiene ni una dependencia de npm', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  const runtime = Object.keys(pkg.dependencies || {});
  assert.deepEqual(runtime, [], `cero dependencias es una promesa pública; aparecieron: ${runtime.join(', ')}`);
  assert.deepEqual(Object.keys(pkg.peerDependencies || {}), [], 'una peerDependency también obliga a instalar');
  assert.deepEqual(Object.keys(pkg.optionalDependencies || {}), [], 'una optionalDependency igual entra al árbol');
  // El árbol instalado tiene que decir lo mismo que el manifiesto: un paquete metido a mano
  // sin guardar en package.json funciona en esta máquina y falla en la de cualquier otro.
  const mods = path.join(raiz, 'node_modules');
  if (fs.existsSync(mods)) {
    const dev = new Set(Object.keys(pkg.devDependencies || {}));
    const sueltos = fs.readdirSync(mods)
      .filter((d) => !d.startsWith('.') && !d.startsWith('@') && !dev.has(d));
    assert.deepEqual(sueltos, [], `node_modules trae paquetes que package.json no declara: ${sueltos.join(', ')}`);
  }
});

// El bloque que alguien COPIA tiene que ser el que el registro declara (4-nov-2026). Nació de un
// defecto medido: Glama servía `--agent` y culpé a su caché; era nuestro README, que en la portada
// dice «no hay paso de instalación» y veinte líneas más abajo trae un bloque MCP con `--agent` y
// una ruta que rellenar, más la frase «join imprime el bloque exacto con tus rutas». Tres
// superficies diciendo tres cosas. El guardia compara contra server.json, que es la receta que un
// cliente ejecuta de verdad, no contra un literal que yo escriba aquí.
test('todo bloque mcpServers con npx dice exactamente lo que declara el registro', async () => {
  const fs = await import('node:fs');
  const registro = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  const paquete = registro.packages.find((p) => p.registryType === 'npm');
  // El nombre del paquete NO está en los argumentos: vive en `identifier`, y `npx` lo necesita en
  // medio. Olvidarlo hacía que este guardia marcara como malo el bloque correcto de agents.md —
  // un falso positivo retiene trabajo bueno, que es peor que dejar pasar un caso.
  const arg = (a) => a.value ?? a.name;
  const esperado = [...(paquete.runtimeArguments || []).map(arg), paquete.identifier, ...(paquete.packageArguments || []).map(arg)];
  const malos = [];
  for (const archivo of ['README.md', 'agents.md']) {
    const texto = fs.readFileSync(new URL(`../${archivo}`, import.meta.url), 'utf8');
    for (const m of texto.matchAll(/```json\n([\s\S]*?)```/g)) {
      let bloque;
      try { bloque = JSON.parse(m[1]); } catch { continue; }
      for (const [nombre, cfg] of Object.entries(bloque.mcpServers || {})) {
        // El bloque de desarrollo local corre el repo con una llave elegida: ahí la ruta es el punto.
        if (cfg.command !== 'npx') continue;
        if (JSON.stringify(cfg.args) !== JSON.stringify(esperado)) {
          malos.push(`${archivo} · ${nombre}: ${JSON.stringify(cfg.args)}\n      el registro declara: ${JSON.stringify(esperado)}`);
        }
      }
    }
  }
  assert.deepEqual(malos, [], `un bloque que alguien va a copiar no coincide con la receta publicada:\n    ${malos.join('\n    ')}`);
});

// La misma trampa en prosa: la portada promete que no hay paso previo, así que ningún comando de
// ejemplo con `npx` puede pedir la llave a mano. Dentro del repo, con varias identidades en
// `keys/`, `--agent` sigue siendo necesario y legítimo: por eso se mira sólo lo que empieza con npx.
test('ningún ejemplo con npx le pide al lector la ruta de su llave', async () => {
  const fs = await import('node:fs');
  const malos = [];
  for (const archivo of ['README.md', 'agents.md']) {
    const texto = fs.readFileSync(new URL(`../${archivo}`, import.meta.url), 'utf8');
    for (const m of texto.matchAll(/^.*npx @nyx5\/nyx5 .*--agent.*$/gm)) malos.push(`${archivo}: ${m[0].trim()}`);
  }
  assert.deepEqual(malos, [], `la llave se encuentra sola desde 0.9.0; estos ejemplos siguen pidiéndola:\n    ${malos.join('\n    ')}`);
});
