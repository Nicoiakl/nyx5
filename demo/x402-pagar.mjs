// Un agente de Nyx5 PAGA un recurso x402 con USDC real, firmando desde su propia llave.
//
//   node demo/x402-pagar.mjs --llave <archivo> --tope <unidades-atómicas> [--red eip155:84532] <url>
//
// Esto MUEVE DINERO si la llave tiene fondos y la url cobra de verdad. No se corre sin
// autorización explícita. Lo que hace: GET a la url, lee el 402, elige una red que sabemos pagar,
// firma una autorización EIP-3009 con la llave y vuelve con PAYMENT-SIGNATURE. Quien difunde la
// transacción y paga el gas es el facilitador del que cobra; nosotros no tocamos ninguna cadena.
//
// La llave se lee de un archivo (hex de 32 bytes, con o sin 0x) y NUNCA se imprime: ni entera, ni
// en parte, ni en un error. Lo único que sale por pantalla es la red, el monto, el destinatario y
// el hash de transacción del PAYMENT-RESPONSE, que es lo que se anota después en el Libro.
//
// `--tope` es obligatorio y va en unidades atómicas de USDC (6 decimales: 10000 = US$0,01). Si el
// 402 pide más, no se firma nada. Es la única defensa del que paga contra un servidor que miente.
import fs from 'node:fs';
import { pagar } from '../src/puentes/x402-pagador.js';
import { TOKEN_USD } from '../src/puentes/x402.js';

const args = process.argv.slice(2);
const opcion = (nombre) => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] : undefined; };
const archivoLlave = opcion('--llave');
const tope = opcion('--tope');
const red = opcion('--red');
const url = args.filter((a, i) => !a.startsWith('--') && !['--llave', '--tope', '--red'].includes(args[i - 1])).at(-1);

const salir = (msg) => { console.error(msg); process.exit(1); };
if (!archivoLlave || !tope || !url) salir('uso: node demo/x402-pagar.mjs --llave <archivo> --tope <unidades-atómicas> [--red eip155:84532] <url>');
if (!/^\d+$/.test(tope)) salir('--tope va en unidades atómicas enteras (10000 = US$0,01 en USDC)');
if (red && !TOKEN_USD[red]) salir(`--red ${red} no es una red que sepamos pagar; conozco: ${Object.keys(TOKEN_USD).join(', ')}`);
if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) salir('la url tiene que ser https (o local para pruebas)');

let privKey;
try { privKey = fs.readFileSync(archivoLlave, 'utf8').trim(); } catch { salir(`no se pudo leer la llave de ${archivoLlave}`); }
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privKey)) salir('el archivo de la llave no contiene 32 bytes en hex');

const usd = (unidades) => `US$${(Number(unidades) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
console.log(`pagando ${url}`);
console.log(`tope: ${tope} unidades (${usd(tope)})${red ? ` · red: ${red}` : ''}`);

let r;
try {
  r = await pagar({ url, privKey, tope, redes: red ? [red] : undefined });
} catch (e) {
  // El mensaje de error del pagador nunca contiene la llave: sólo direcciones, montos y redes.
  salir(`no se pagó: ${e.message}`);
}
privKey = null;

if (!r.pagado) {
  console.log(`el recurso no cobró (HTTP ${r.status}); no se firmó nada`);
  process.exit(0);
}
const explorador = { 'eip155:1': 'https://etherscan.io', 'eip155:8453': 'https://basescan.org', 'eip155:84532': 'https://sepolia.basescan.org', 'eip155:137': 'https://polygonscan.com', 'eip155:42161': 'https://arbiscan.io', 'eip155:10': 'https://optimistic.etherscan.io', 'eip155:43114': 'https://snowtrace.io' }[r.red];
console.log(`red:          ${r.red} (${TOKEN_USD[r.red].red})`);
console.log(`monto:        ${r.monto} unidades (${usd(r.monto)})`);
console.log(`destinatario: ${r.destinatario}`);
console.log(`pagador:      ${r.pagador}`);
console.log(`transacción:  ${r.liquidacion?.transaction || '(el servidor no devolvió PAYMENT-RESPONSE)'}`);
if (r.liquidacion?.transaction && explorador) console.log(`compruébalo:  ${explorador}/tx/${r.liquidacion.transaction}`);
console.log(`HTTP ${r.status}`);
