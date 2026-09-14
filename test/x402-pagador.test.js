// node --test test/
// El pagador x402: keccak256 y secp256k1 en JS puro contra vectores PÚBLICOS, la autorización
// EIP-3009 verificada recuperando la dirección, y la prueba redonda casa-cobra / agente-paga con
// un facilitador FALSO que verifica la firma de verdad (ecrecover), sin red, sin llave real y sin
// mover nada.
//
// Lo que estas pruebas cuidan, y por qué:
//   - Keccak-256 NO es sha3-256: distinto relleno. Los vectores son los del equipo Keccak.
//   - La firma es determinista (RFC 6979): la misma llave y el mismo hash dan la misma firma.
//   - Una autorización firmada para una red NO sirve en otra: el dominio EIP-712 lleva chainId y
//     contrato, y la dirección recuperada cambia.
//   - `tope` manda: si el precio lo supera, no se firma. La firma es dinero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { keccak256, keccak256Hex, deHex, aHex } from '../src/nucleo/keccak.js';
import * as secp from '../src/nucleo/secp256k1.js';
import * as pagador from '../src/puentes/x402-pagador.js';
import * as x402 from '../src/puentes/x402.js';

// Puertos propios de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4781;              // servidor de recurso (la casa que cobra)
const PF = P + 1;            // facilitador falso

// Llaves de PRUEBA, públicas y conocidas por todo el mundo. Nunca contienen fondos.
const LLAVE_1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
const DIR_1 = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const LLAVE_2 = '0x0000000000000000000000000000000000000000000000000000000000000002';
const DIR_2 = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const COBRA = '0x000000000000000000000000000000000000dEaD';
const RED = 'eip155:84532';
const abrir = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// ---------- keccak-256 ----------

test('keccak256 da los vectores oficiales del equipo Keccak, incluido uno de dos bloques', () => {
  // Fuente: KeccakKAT-3.zip (https://keccak.team/obsolete/KeccakKAT-3.zip, sha256
  // af92d22d23527a0d168a6bbe70b28c840a43bba5bcea828a6d9a5e7ad79378ce), archivo
  // KeccakKAT/ShortMsgKAT_256.txt, entradas Len = 0, 24, 1088 y 2000. Es el Keccak ORIGINAL
  // (relleno pad10*1), el que usa Ethereum, no el SHA3-256 de FIPS 202.
  assert.equal(keccak256Hex(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256Hex('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256Hex(deHex('1F877C')), '627d7bc1491b2ab127282827b8de2d276b13d7d70fb4c5957fdf20655bc7ac30');
  // Len = 1088 bits = 136 bytes: llena un bloque EXACTO, así que el relleno ocupa un bloque entero.
  const exacto = 'B32D95B0B9AAD2A8816DE6D06D1F86008505BD8C14124F6E9A163B5A2ADE55F835D0EC3880EF50700D3B25E42CC0AF050CCD1BE5E555B23087E04D7BF9813622780C7313A1954F8740B6EE2D3F71F768DD417F520482BD3A08D4F222B4EE9DBD015447B33507DD50F3AB4247C5DE9A8ABD62A8DECEA01E3B87C8B927F5B08BEB37674C6F8E380C04';
  assert.equal(deHex(exacto).length, 136);
  assert.equal(keccak256Hex(deHex(exacto)), 'e717a7769448abbe5fef8187954a88ac56ded1d22e63940ab80d029585a21921');
  // Len = 2000 bits = 250 bytes: más de un bloque de 136, dos absorciones.
  const largo = 'B3C5E74B69933C2533106C563B4CA20238F2B6E675E8681E34A389894785BDADE59652D4A73D80A5C85BD454FD1E9FFDAD1C3815F5038E9EF432AAC5C3C4FE840CC370CF86580A6011778BBEDAF511A51B56D1A2EB68394AA299E26DA9ADA6A2F39B9FAFF7FBA457689B9C1A577B2A1E505FDF75C7A0A64B1DF81B3A356001BF0DF4E02A1FC59F651C9D585EC6224BB279C6BEBA2966E8882D68376081B987468E7AED1EF90EBD090AE825795CDCA1B4F09A979C8DFC21A48D8A53CDBB26C4DB547FC06EFE2F9850EDD2685A4661CB4911F165D4B63EF25B87D0A96D3DFF6AB0758999AAD214D07BD4F133A6734FDE445FE474711B69A98F7E2B';
  assert.equal(deHex(largo).length, 250);
  assert.equal(keccak256Hex(deHex(largo)), 'c6d86cc4ccef3bb70bf7bfddec6a9a04a0dd0a68fe1bf51c14648cf506a03e98');
});

test('keccak256 no es sha3-256: el relleno cambia y el resultado también', () => {
  const sha3 = createHash('sha3-256').update('abc').digest('hex');
  assert.notEqual(keccak256Hex('abc'), sha3, 'si esto coincide, alguien cambió el relleno a FIPS 202');
  assert.equal(sha3, '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  // Los typehash que publica el contrato de USDC (EIP-3009) y el de EIP-712 salen de aquí.
  assert.equal(keccak256Hex(pagador.TIPO_TRANSFER), '7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267');
  assert.equal(keccak256Hex(pagador.TIPO_DOMINIO), '8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f');
  assert.throws(() => deHex('abc'), /hex inválido/);
  assert.throws(() => keccak256(42), /Uint8Array o string/);
});

// ---------- secp256k1 ----------

test('la llave privada 1 da la dirección conocida, y la 2 también', () => {
  // Las direcciones de las llaves 1 y 2 son de dominio público (aparecen en cualquier libro de
  // Ethereum). Van con la mayúscula de EIP-55, así que el checksum también queda probado.
  assert.equal(secp.direccionDe(LLAVE_1), DIR_1);
  assert.equal(secp.direccionDe(LLAVE_2), DIR_2);
  assert.equal(secp.checksum(DIR_1.toLowerCase()), DIR_1);
  assert.throws(() => secp.direccionDe('0x' + '0'.repeat(64)), /fuera de rango/);
  assert.throws(() => secp.direccionDe('0x' + 'ff'.repeat(32)), /fuera de rango/);
  assert.throws(() => secp.direccionDe('0x01'), /32 bytes/);
});

test('la firma es RFC 6979: sha256("Satoshi Nakamoto") con la llave 1 da el k y la firma publicados', () => {
  // Vector público: hilo de bitcointalk 285142 (2013) reproducido en la suite de python-ecdsa
  // (test_pyecdsa.py, "from https://bitcointalk.org/index.php?topic=285142.40"): llave 1, sha256
  // del mensaje "Satoshi Nakamoto", r y s en forma baja.
  const z = new Uint8Array(createHash('sha256').update('Satoshi Nakamoto').digest());
  const f = secp.firmar(z, LLAVE_1);
  assert.equal(f.r.toString(16), '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8');
  assert.equal(f.s.toString(16), '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5');
  assert.ok(f.s <= secp.N / 2n, 's va en forma baja');
  assert.equal(f.firma.length, 65);
  assert.ok(f.v === 27 || f.v === 28);
  // Determinista: firmar dos veces da exactamente lo mismo.
  assert.equal(secp.firmar(z, LLAVE_1).firmaHex, f.firmaHex);
  // Y de la firma se recupera la dirección de la llave que firmó.
  assert.equal(secp.recuperarDireccion(z, f.firma), DIR_1);
  assert.equal(secp.recuperarDireccion('0x' + aHex(z), f.firmaHex), DIR_1);
});

test('recuperar falla cerrado: firma alterada, s alta, v inválido o largo incorrecto no dan una dirección', () => {
  const z = keccak256('un mensaje cualquiera');
  const f = secp.firmar(z, LLAVE_2);
  assert.equal(secp.recuperarDireccion(z, f.firma), DIR_2);
  // Un bit cambiado en r: o el punto no está en la curva, o la dirección es otra. Nunca DIR_2.
  const alterada = new Uint8Array(f.firma); alterada[5] ^= 0x01;
  let rec = null; try { rec = secp.recuperarDireccion(z, alterada); } catch { /* fuera de la curva */ }
  assert.notEqual(rec, DIR_2);
  // Otro hash con la misma firma: otra dirección.
  assert.notEqual(secp.recuperarDireccion(keccak256('otro'), f.firma), DIR_2);
  // s en forma alta se rechaza (EIP-2): un mensaje tiene UNA firma válida, no dos.
  const alta = new Uint8Array(f.firma);
  alta.set(deHex((secp.N - f.s).toString(16).padStart(64, '0')), 32);
  assert.throws(() => secp.recuperarDireccion(z, alta), /forma alta/);
  const malV = new Uint8Array(f.firma); malV[64] = 29;
  assert.throws(() => secp.recuperarDireccion(z, malV), /v inválido/);
  assert.throws(() => secp.recuperarDireccion(z, f.firma.subarray(0, 64)), /65 bytes/);
  assert.throws(() => secp.firmar('0x1234', LLAVE_2), /32 bytes/);
});

// ---------- EIP-712 / EIP-3009 ----------

test('el separador de dominio EIP-712 coincide con el ejemplo del EIP y con el que publica USDC', () => {
  // Ejemplo "Ether Mail" del propio EIP-712 (su código de prueba publica este separador).
  const mail = pagador.separadorDeDominio({ name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' });
  assert.equal(aHex(mail), 'f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f');
  // El DOMAIN_SEPARATOR() que publica el contrato de USDC en Ethereum (0xA0b8…eB48): name
  // "USD Coin", version "2", chainId 1. Sale de TOKEN_USD, no de una constante escrita aquí.
  const usdc = pagador.separadorDeDominio(pagador.dominioDe('eip155:1'));
  assert.equal(aHex(usdc), '06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335');
  // El dominio se lee de la tabla de x402.js: cambiarla ahí cambia esto.
  assert.equal(pagador.dominioDe('eip155:84532').name, x402.TOKEN_USD['eip155:84532'].name);
  assert.equal(pagador.dominioDe('eip155:8453').chainId, 8453n);
  assert.throws(() => pagador.dominioDe('eip155:56'), /no sé pagar/);
});

test('la autorización EIP-3009 firmada se recupera como `from`, y en otra red NO', () => {
  const auth = { network: RED, from: DIR_1, to: COBRA, value: '10000', validAfter: '0', validBefore: '1800000000', nonce: '0x' + '11'.repeat(32) };
  const a = pagador.firmarAutorizacion({ ...auth, privKey: LLAVE_1 });
  assert.deepEqual(Object.keys(a.authorization), ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']);
  for (const v of Object.values(a.authorization)) assert.equal(typeof v, 'string', 'todo viaja como cadena');
  assert.match(a.signature, /^0x[0-9a-f]{130}$/);
  assert.equal(pagador.recuperarPagador({ network: RED, authorization: a.authorization, signature: a.signature }), DIR_1);
  // GRITO: la misma firma leída con el dominio de Base mainnet recupera OTRA dirección. Si esto
  // pasara a coincidir, el dominio dejó de incluir la red y una firma valdría en todas.
  for (const otra of ['eip155:8453', 'eip155:1', 'eip155:137']) {
    assert.notEqual(pagador.recuperarPagador({ network: otra, authorization: a.authorization, signature: a.signature }), DIR_1, `la firma de ${RED} no puede valer en ${otra}`);
  }
  // Cualquier campo alterado después de firmar rompe la recuperación.
  assert.notEqual(pagador.recuperarPagador({ network: RED, authorization: { ...a.authorization, value: '10001' }, signature: a.signature }), DIR_1);
  assert.notEqual(pagador.recuperarPagador({ network: RED, authorization: { ...a.authorization, to: DIR_2 }, signature: a.signature }), DIR_1);
});

test('firmar exige que `from` sea la dirección de la llave, un nonce de 32 bytes y una ventana coherente', () => {
  const base = { network: RED, from: DIR_1, to: COBRA, value: '1', validAfter: '0', validBefore: '10', nonce: '0x' + '22'.repeat(32), privKey: LLAVE_1 };
  pagador.firmarAutorizacion(base);
  assert.throws(() => pagador.firmarAutorizacion({ ...base, from: DIR_2 }), /no es la dirección de la llave/);
  assert.throws(() => pagador.firmarAutorizacion({ ...base, nonce: '0x1234' }), /32 bytes/);
  assert.throws(() => pagador.firmarAutorizacion({ ...base, value: '1.5' }), /entero sin signo/);
  assert.throws(() => pagador.firmarAutorizacion({ ...base, value: -1 }), /entero sin signo/);
  assert.throws(() => pagador.firmarAutorizacion({ ...base, validBefore: '0' }), /mayor que validAfter/);
  assert.throws(() => pagador.firmarAutorizacion({ ...base, to: 'dead' }), /dirección inválida/);
  assert.throws(() => pagador.firmarAutorizacion({ ...base, network: 'eip155:56' }), /no sé pagar/);
});

// ---------- elegir y armar el pago ----------

const requisitoDe = (extra = {}) => ({
  ...x402.requisitosEvm({ url: 'https://casa/x', amount: 10000, payTo: COBRA, network: RED, asset: x402.TOKEN_USD[RED].asset, tokenName: x402.TOKEN_USD[RED].name, tokenVersion: '2' }).accepts[0],
  ...extra,
});

test('tope superado → no se firma (y la llave ni se toca)', () => {
  const req = requisitoDe({ amount: '10001' });
  // privKey nulo a propósito: si el tope se comprobara DESPUÉS de tocar la llave, el error sería
  // otro. Que el mensaje hable del tope demuestra el orden.
  assert.throws(() => pagador.armarPago({ requisito: req, privKey: null, tope: '10000' }), /supera el tope.*no se firma/);
  assert.throws(() => pagador.armarPago({ requisito: req, privKey: LLAVE_1 }), /tope .* obligatorio/);
  assert.throws(() => pagador.armarPago({ requisito: req, privKey: LLAVE_1, tope: 1.5 }), /entero sin signo/);
  // Justo en el tope sí se firma.
  const p = pagador.armarPago({ requisito: req, privKey: LLAVE_1, tope: '10001' });
  assert.equal(p.payload.authorization.value, '10001');
});

test('el pago armado lleva nonce aleatorio, validBefore ≤ ahora + 5 min, y `accepted` tal cual', () => {
  const req = requisitoDe({ maxTimeoutSeconds: 3600 }); // el servidor pide una hora; no se le da
  const ahora = 1_800_000_000;
  const p1 = pagador.armarPago({ requisito: req, privKey: LLAVE_1, tope: '10000', ahora });
  const p2 = pagador.armarPago({ requisito: req, privKey: LLAVE_1, tope: '10000', ahora });
  assert.equal(p1.x402Version, 2);
  assert.equal(p1.accepted, req);
  assert.match(p1.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(p1.payload.authorization.nonce, p2.payload.authorization.nonce, 'dos pagos, dos nonces');
  assert.notEqual(p1.payload.signature, p2.payload.signature);
  assert.equal(Number(p1.payload.authorization.validBefore), ahora + pagador.VIGENCIA_MAX_S);
  assert.equal(Number(p1.payload.authorization.validAfter), ahora - pagador.TOLERANCIA_RELOJ_S);
  assert.equal(p1.payload.authorization.from, DIR_1);
  assert.equal(p1.payload.authorization.to, COBRA);
  assert.equal(p1.payload.authorization.value, '10000');
  // Un servidor que pide 60 s recibe 60 s, no 300.
  const corto = pagador.armarPago({ requisito: requisitoDe({ maxTimeoutSeconds: 60 }), privKey: LLAVE_1, tope: '10000', ahora });
  assert.equal(Number(corto.payload.authorization.validBefore), ahora + 60);
  // La clave antirreplay que la casa ya usa sale de este nonce.
  assert.equal(x402.claveDePago(p1), `x402:${RED}:${p1.payload.authorization.nonce}`);
});

test('un 402 que anuncia otro contrato, otro dominio o una red desconocida no consigue firma', () => {
  const pr = (a) => ({ x402Version: 2, resource: { url: 'u' }, accepts: [a] });
  assert.equal(pagador.elegirRequisito(pr(requisitoDe())).network, RED);
  // Un contrato que no es el USDC de esa red: firmar sería autorizar un token que no conocemos.
  assert.throws(() => pagador.elegirRequisito(pr(requisitoDe({ asset: '0x0000000000000000000000000000000000000001' }))), /no es el USDC/);
  // El dominio del token que dicta el cobrador no se acepta: sale de nuestra tabla.
  assert.throws(() => pagador.elegirRequisito(pr(requisitoDe({ extra: { name: 'USD Coin', version: '2' } }))), /dominio del token/);
  assert.throws(() => pagador.elegirRequisito(pr(requisitoDe({ network: 'eip155:56' }))), /red que no sé pagar/);
  assert.throws(() => pagador.elegirRequisito(pr(requisitoDe({ scheme: 'upto' }))), /scheme upto/);
  assert.throws(() => pagador.elegirRequisito(pr(requisitoDe({ payTo: 'caro@casa' }))), /payTo/);
  assert.throws(() => pagador.elegirRequisito(pr(requisitoDe({ amount: 10000 }))), /cadena de unidades/);
  assert.throws(() => pagador.elegirRequisito({ x402Version: 1, accepts: [requisitoDe()] }), /x402Version/);
  // El token de la casa (nyx5:1) se salta sin fallar, y se toma la red EVM que sigue.
  const mixto = { x402Version: 2, accepts: [x402.requisitos({ url: 'u', amount: 25, payTo: 'a@b' }).accepts[0], requisitoDe()] };
  assert.equal(pagador.elegirRequisito(mixto).network, RED);
  // Y si sólo ofrece el token de la casa, se dice: no hay nada que un pagador EVM pueda pagar.
  assert.throws(() => pagador.elegirRequisito({ x402Version: 2, accepts: mixto.accepts.slice(0, 1) }), /nyx5:1: red que no sé pagar/);
  // Acotar redes: la ofrecida no está en la lista.
  assert.throws(() => pagador.elegirRequisito(pr(requisitoDe()), { redes: ['eip155:8453'] }), /fuera de las redes permitidas/);
});

// ---------- la prueba redonda: la casa cobra, el agente paga, el facilitador falso verifica ----------
//
// El facilitador falso hace lo que hace uno real en /verify y /settle, salvo tocar la cadena:
// recompone el digest EIP-712 con el dominio de la red, recupera la dirección de la firma y la
// compara con `from`; comprueba monto, destinatario, vigencia y nonce. Es NUESTRO ecrecover del
// otro lado del cable: si firmar y recuperar se equivocaran igual, esta prueba no lo vería, y por
// eso los vectores públicos de arriba existen.

let casa, facilitador;
const vistoFacilitador = [];
const noncesLiquidados = new Set();
const noncesVistosCasa = new Set();

const leerJson = (req) => new Promise((res, rej) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { rej(e); } }); });

function juzgar(paymentPayload, paymentRequirements) {
  const a = paymentPayload?.payload?.authorization, s = paymentPayload?.payload?.signature;
  const r = paymentRequirements;
  if (!a || !s) return { isValid: false, invalidReason: 'sin autorización' };
  let payer;
  try { payer = pagador.recuperarPagador({ network: r.network, authorization: a, signature: s }); } catch (e) { return { isValid: false, invalidReason: `firma: ${e.message}` }; }
  const ahora = Math.floor(Date.now() / 1000);
  if (payer.toLowerCase() !== String(a.from).toLowerCase()) return { isValid: false, invalidReason: 'la firma no es de from', payer };
  if (a.value !== r.amount) return { isValid: false, invalidReason: 'monto distinto', payer };
  if (String(a.to).toLowerCase() !== String(r.payTo).toLowerCase()) return { isValid: false, invalidReason: 'destinatario distinto', payer };
  if (Number(a.validBefore) <= ahora) return { isValid: false, invalidReason: 'vencida', payer };
  if (Number(a.validAfter) > ahora) return { isValid: false, invalidReason: 'aún no válida', payer };
  if (noncesLiquidados.has(a.nonce)) return { isValid: false, invalidReason: 'nonce ya usado', payer };
  return { isValid: true, payer };
}

before(async () => {
  facilitador = http.createServer(async (req, res) => {
    const responder = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/supported') return responder(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: RED }] });
    const cuerpo = await leerJson(req);
    vistoFacilitador.push({ ruta: req.url, cuerpo });
    const v = juzgar(cuerpo.paymentPayload, cuerpo.paymentRequirements);
    if (req.url === '/verify') return responder(200, v);
    if (req.url === '/settle') {
      if (!v.isValid) return responder(200, { success: false, errorReason: v.invalidReason, transaction: '', network: RED, payer: v.payer });
      const nonce = cuerpo.paymentPayload.payload.authorization.nonce;
      noncesLiquidados.add(nonce);
      return responder(200, { success: true, transaction: '0x' + keccak256Hex(nonce), network: RED, payer: v.payer });
    }
    responder(404, {});
  });
  await new Promise((r) => facilitador.listen(PF, '127.0.0.1', r));

  // La casa que cobra: usa SÓLO src/puentes/x402.js, como haría en producción.
  const f = x402.facilitador(`http://127.0.0.1:${PF}`);
  const requisitos = () => x402.requisitosEvm({ url: `http://127.0.0.1:${P}/recurso`, amount: 10000, payTo: COBRA, network: RED, asset: x402.TOKEN_USD[RED].asset, tokenName: x402.TOKEN_USD[RED].name, tokenVersion: x402.TOKEN_USD[RED].version, description: 'un recurso de prueba' });
  casa = http.createServer(async (req, res) => {
    const pr = requisitos();
    const rechazar = (error) => { res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': x402.cabeceraRequerido({ ...pr, error }) }); res.end(JSON.stringify({ error })); };
    if (req.url !== '/recurso') { res.writeHead(404); return res.end(); }
    const cab = req.headers['payment-signature'];
    if (!cab) return rechazar('PAYMENT-SIGNATURE header is required');
    let pago; try { pago = abrir(cab); } catch { res.writeHead(400); return res.end(); }
    const nuestro = pr.accepts[0];
    if (!['scheme', 'network', 'amount', 'asset', 'payTo'].every((k) => String(nuestro[k]).toLowerCase() === String(pago.accepted?.[k]).toLowerCase())) return rechazar('accepted does not match what was published');
    const clave = x402.claveDePago(pago);
    if (!clave || noncesVistosCasa.has(clave)) return rechazar('replayed payment');
    noncesVistosCasa.add(clave);
    const v = await f.verificar(pago, nuestro);
    if (!v.body.isValid) return rechazar(`invalid payment: ${v.body.invalidReason}`);
    const s = await f.liquidar(pago, nuestro);
    if (!s.body.success) return rechazar(`settlement failed: ${s.body.errorReason}`);
    res.writeHead(200, { 'content-type': 'application/json', 'PAYMENT-RESPONSE': x402.cabeceraLiquidacion(s.body) });
    res.end(JSON.stringify({ recurso: 'lo que se vendía', para: s.body.payer }));
  });
  await new Promise((r) => casa.listen(P, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => casa.close(r));
  await new Promise((r) => facilitador.close(r));
});

test('redonda: la casa responde 402, el agente paga, el facilitador recupera al pagador y liquida', async () => {
  const url = `http://127.0.0.1:${P}/recurso`;
  const r = await pagador.pagar({ url, privKey: LLAVE_1, tope: '10000' });
  assert.equal(r.pagado, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { recurso: 'lo que se vendía', para: DIR_1 });
  assert.equal(r.red, RED);
  assert.equal(r.monto, '10000');
  assert.equal(r.destinatario, COBRA);
  assert.equal(r.pagador, DIR_1);
  // El PAYMENT-RESPONSE que devuelve la casa es el del facilitador, y el pagador es el recuperado
  // de la firma, no el que dijo el cliente.
  assert.equal(r.liquidacion.success, true);
  assert.equal(r.liquidacion.payer, DIR_1);
  assert.equal(r.liquidacion.network, RED);
  assert.equal(r.liquidacion.transaction, '0x' + keccak256Hex(r.nonce));
  // El facilitador vio verify y luego settle con el sobre que el estándar pide.
  const rutas = vistoFacilitador.map((v) => v.ruta);
  assert.deepEqual(rutas.slice(-2), ['/verify', '/settle']);
  assert.deepEqual(Object.keys(vistoFacilitador.at(-1).cuerpo).sort(), ['paymentPayload', 'paymentRequirements', 'x402Version']);
  assert.equal(vistoFacilitador.at(-1).cuerpo.paymentPayload.payload.authorization.nonce, r.nonce);
});

test('redonda: un pago reenviado (mismo nonce) no entrega dos veces', async () => {
  // Se arma un pago a mano y se manda DOS veces con la misma cabecera: la casa lo deduplica por
  // nonce (invariante 4) y el facilitador, si le llegara, lo rechaza por nonce usado.
  const url = `http://127.0.0.1:${P}/recurso`;
  const pr = abrir((await fetch(url)).headers.get('payment-required'));
  const pago = pagador.armarPago({ requisito: pagador.elegirRequisito(pr), privKey: LLAVE_2, tope: '10000' });
  const cab = b64(pago);
  const r1 = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': cab } });
  assert.equal(r1.status, 200);
  assert.equal(abrir(r1.headers.get('payment-response')).payer, DIR_2);
  const r2 = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': cab } });
  assert.equal(r2.status, 402);
  assert.match(abrir(r2.headers.get('payment-required')).error, /replayed/);
  // Y aunque la casa no dedujera, el facilitador tampoco lo liquida: el nonce ya está usado.
  const j = juzgar(pago, pr.accepts[0]);
  assert.equal(j.isValid, false);
  assert.equal(j.invalidReason, 'nonce ya usado');
});

test('redonda: una firma de otra red o de otra llave la rechaza el facilitador, y la casa no entrega', async () => {
  const url = `http://127.0.0.1:${P}/recurso`;
  const pr = abrir((await fetch(url)).headers.get('payment-required'));
  const req = pagador.elegirRequisito(pr);
  // Firmada con el dominio de Base mainnet pero presentada como Base Sepolia: `accepted` calza,
  // la firma no. El facilitador recupera OTRA dirección y dice que no es de `from`.
  const ajena = pagador.firmarAutorizacion({ network: 'eip155:8453', from: DIR_1, to: COBRA, value: '10000', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: '0x' + '33'.repeat(32), privKey: LLAVE_1 });
  const pago = { x402Version: 2, accepted: req, payload: ajena };
  const r = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': b64(pago) } });
  assert.equal(r.status, 402);
  assert.match(abrir(r.headers.get('payment-required')).error, /la firma no es de from/);
  assert.equal(r.headers.get('payment-response'), null, 'sin pago no hay recibo');
});

test('pagar: si el precio supera el tope, se hace UNA petición y ninguna con firma', async () => {
  const url = `http://127.0.0.1:${P}/recurso`;
  const vistas = [];
  const espia = async (u, o) => { vistas.push(o?.headers || {}); return fetch(u, o); };
  await assert.rejects(pagador.pagar({ url, privKey: LLAVE_1, tope: '9999', fetch: espia }), /supera el tope/);
  assert.equal(vistas.length, 1);
  assert.ok(!('PAYMENT-SIGNATURE' in vistas[0]));
  await assert.rejects(pagador.pagar({ url, privKey: LLAVE_1 }), /tope .* obligatorio/);
  // Redes acotadas y la ofrecida no está: tampoco se firma.
  await assert.rejects(pagador.pagar({ url, privKey: LLAVE_1, tope: '10000', redes: ['eip155:8453'] }), /fuera de las redes permitidas/);
});

test('pagar: un recurso que no cobra se devuelve sin firmar nada', async () => {
  const gratis = async () => new Response(JSON.stringify({ libre: true }), { status: 200 });
  const r = await pagador.pagar({ url: 'http://x/y', privKey: LLAVE_1, tope: '1', fetch: gratis });
  assert.deepEqual(r, { pagado: false, status: 200, body: { libre: true } });
  // Un 402 sin cabecera no se adivina.
  const mudo = async () => new Response('', { status: 402 });
  await assert.rejects(pagador.pagar({ url: 'http://x/y', privKey: LLAVE_1, tope: '1', fetch: mudo }), /sin cabecera PAYMENT-REQUIRED/);
});

test('pagar: si la casa rechaza el pago firmado, se dice el motivo y no se devuelve cuerpo como si fuera bueno', async () => {
  let n = 0;
  const pr = { x402Version: 2, resource: { url: 'u' }, accepts: [requisitoDe()] };
  const terco = async () => {
    n++;
    return new Response(JSON.stringify({ error: 'no' }), { status: 402, headers: { 'PAYMENT-REQUIRED': b64({ ...pr, error: n === 1 ? 'PAYMENT-SIGNATURE header is required' : 'settlement failed: sin fondos' }) } });
  };
  await assert.rejects(pagador.pagar({ url: 'http://x/y', privKey: LLAVE_1, tope: '10000', fetch: terco }), /rechazó el pago: settlement failed: sin fondos/);
  assert.equal(n, 2);
});

// ---------- revisión adversarial (14-sep-2026): lo que la primera pasada no cubría ----------

test('ATAQUE · el dominio de otra red con el MISMO asset (sólo chainId difiere) recupera otra dirección', () => {
  // La prueba de "otra red" de arriba cambia chainId Y contrato a la vez. Aquí sólo el chainId: si
  // el separador dejara de incluirlo, una firma de Base Sepolia valdría en cualquier cadena con el
  // mismo contrato (bridges y forks los tienen).
  const auth = { from: DIR_1, to: COBRA, value: '1', validAfter: '0', validBefore: '10', nonce: '0x' + '44'.repeat(32) };
  const a = pagador.firmarAutorizacion({ network: RED, ...auth, privKey: LLAVE_1 });
  const dom = pagador.dominioDe(RED);
  assert.equal(secp.recuperarDireccion(pagador.digestAutorizacion({ dominio: dom, ...a.authorization }), a.signature), DIR_1, 'SILENCIO: con el dominio correcto recupera');
  assert.notEqual(secp.recuperarDireccion(pagador.digestAutorizacion({ dominio: { ...dom, chainId: dom.chainId + 1n }, ...a.authorization }), a.signature), DIR_1);
  assert.notEqual(secp.recuperarDireccion(pagador.digestAutorizacion({ dominio: { ...dom, chainId: 1n }, ...a.authorization }), a.signature), DIR_1);
});

test('ATAQUE · maxTimeoutSeconds negativo, no numérico, fraccionario o enorme: la vigencia queda en (0, 300]', () => {
  // Un servidor con maxTimeoutSeconds: -100 conseguía una autorización con validBefore en el
  // pasado: un cheque ya vencido, firmado igual. Ahora el servidor sólo puede ACORTAR los 5 min.
  const ahora = 1_800_000_000;
  for (const mts of [-100, '-100', -1e9, 'abc', null, {}, 0, 0.5, Infinity, NaN, 1e9, '1e9', 3600]) {
    const p = pagador.armarPago({ requisito: requisitoDe({ maxTimeoutSeconds: mts }), privKey: LLAVE_1, tope: '10000', ahora });
    const vida = Number(p.payload.authorization.validBefore) - ahora;
    assert.ok(vida >= 1 && vida <= pagador.VIGENCIA_MAX_S, `maxTimeoutSeconds=${JSON.stringify(mts)} dio una vigencia de ${vida} s`);
  }
  assert.equal(Number(pagador.armarPago({ requisito: requisitoDe({ maxTimeoutSeconds: 61.9 }), privKey: LLAVE_1, tope: '10000', ahora }).payload.authorization.validBefore), ahora + 61, 'SILENCIO: 61,9 se redondea hacia abajo, no falla');
  assert.equal(Number(pagador.armarPago({ requisito: requisitoDe({ maxTimeoutSeconds: 1 }), privKey: LLAVE_1, tope: '10000', ahora }).payload.authorization.validBefore), ahora + 1);
});

test('ATAQUE · una llave malformada no se repite en el error, y la llave = n se rechaza como fuera de rango', () => {
  // `deHex` cita los primeros 20 caracteres de lo que recibió: con una llave de 64 hex más un
  // carácter de basura, eso eran 72 bits del secreto en un log.
  const casi = '0xzz' + 'a1b2c3d4e5f6a7b8c9d0'.repeat(3) + 'ab';
  for (const fn of [() => secp.direccionDe(casi), () => secp.firmar(keccak256('x'), casi), () => pagador.armarPago({ requisito: requisitoDe(), privKey: casi, tope: '10000' })]) {
    let msg = null; try { fn(); } catch (e) { msg = e.message; }
    assert.ok(msg, 'tiene que fallar');
    assert.ok(!msg.includes('a1b2'), `el error repite la llave: ${msg}`);
    assert.match(msg, /no es hex de 32 bytes/);
  }
  assert.throws(() => secp.direccionDe('0x' + secp.N.toString(16)), /fuera de rango/);
  assert.equal(secp.direccionDe('0x' + (secp.N - 1n).toString(16)).length, 42, 'SILENCIO: n−1 es válida');
});

test('ATAQUE · una red llamada como una propiedad del prototipo se rechaza con motivo, no con un TypeError', () => {
  // `TOKEN_USD['constructor']` es truthy (Object): el pagador seguía hasta reventar en `.toLowerCase`.
  for (const net of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => pagador.elegirRequisito({ x402Version: 2, accepts: [requisitoDe({ network: net })] }), /red que no sé pagar/, net);
    assert.throws(() => pagador.dominioDe(net), /no sé pagar/, net);
    assert.throws(() => pagador.armarPago({ requisito: requisitoDe({ network: net }), privKey: LLAVE_1, tope: '10000' }), /no sé pagar/, net);
  }
});

test('ATAQUE · el payTo cambia en la segunda respuesta: se firmó UNA vez para el primero, no se vuelve a firmar, y el error dice qué cheque quedó afuera', async () => {
  let n = 0; const firmas = [];
  const pr1 = { x402Version: 2, resource: { url: 'u' }, accepts: [requisitoDe()] };
  const pr2 = { x402Version: 2, resource: { url: 'u' }, accepts: [requisitoDe({ payTo: DIR_2 })], error: 'wrong payee' };
  const f = async (u, o) => {
    n++;
    const s = o?.headers?.['PAYMENT-SIGNATURE'];
    if (s) firmas.push(abrir(s));
    return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': b64(n === 1 ? pr1 : pr2) } });
  };
  const antes = [];
  const e = await pagador.pagar({ url: 'http://x/y', privKey: LLAVE_1, tope: '10000', fetch: f, alFirmar: (x) => antes.push(x) }).then(() => null, (err) => err);
  assert.match(e.message, /rechazó el pago: wrong payee/);
  assert.equal(n, 2, 'dos peticiones y ninguna más');
  assert.equal(firmas.length, 1, 'una sola firma');
  assert.equal(firmas[0].payload.authorization.to, COBRA, 'firmada para el payTo del PRIMER 402');
  // La firma ya salió: es un cheque hasta que venza. El error lo dice, para conciliar.
  assert.equal(e.firmado, true);
  assert.equal(e.nonce, firmas[0].payload.authorization.nonce);
  assert.equal(e.red, RED); assert.equal(e.monto, '10000'); assert.equal(e.destinatario, COBRA); assert.equal(e.pagador, DIR_1);
  assert.equal(e.validBefore, firmas[0].payload.authorization.validBefore);
  // `alFirmar` corrió ANTES de mandar la firma, con los mismos datos: el registro antes del paso.
  assert.equal(antes.length, 1); assert.equal(antes[0].nonce, e.nonce);
  // Un fallo de red DESPUÉS de entregar la firma también lo dice.
  let m = 0;
  const caido = async (u, o) => { m++; if (!o?.headers?.['PAYMENT-SIGNATURE']) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': b64(pr1) } }); throw new TypeError('fetch failed'); };
  const e2 = await pagador.pagar({ url: 'http://x/y', privKey: LLAVE_1, tope: '10000', fetch: caido }).then(() => null, (err) => err);
  assert.match(e2.message, /fetch failed/); assert.equal(e2.firmado, true); assert.match(e2.nonce, /^0x[0-9a-f]{64}$/);
  // SILENCIO: un error ANTES de firmar no lleva `firmado` (no hay cheque afuera).
  const e3 = await pagador.pagar({ url: 'http://x/y', privKey: LLAVE_1, tope: '1', fetch: f }).then(() => null, (err) => err);
  assert.match(e3.message, /supera el tope/); assert.equal(e3.firmado, undefined);
  // Y la respuesta buena lleva los mismos campos (misma definición, no dos).
  const bueno = async (u, o) => o?.headers?.['PAYMENT-SIGNATURE'] ? new Response('{"ok":1}', { status: 200 }) : new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': b64(pr1) } });
  const r = await pagador.pagar({ url: 'http://x/y', privKey: LLAVE_1, tope: '10000', fetch: bueno });
  assert.equal(r.pagado, true); assert.equal(r.firmado, true); assert.equal(r.destinatario, COBRA); assert.match(r.nonce, /^0x[0-9a-f]{64}$/);
});

test('COMPAT · la segunda petición lleva X-PAYMENT con la forma v1 además de PAYMENT-SIGNATURE, y el motivo del rechazo sale del cuerpo si la cabecera no lo trae', async () => {
  const url = `http://127.0.0.1:${P}/recurso`;
  const vistas = [];
  const espia = async (u, o) => { vistas.push(o?.headers || {}); return fetch(u, o); };
  const r = await pagador.pagar({ url, privKey: LLAVE_1, tope: '10000', fetch: espia });
  assert.equal(r.pagado, true);
  const cab = vistas.at(-1);
  assert.ok(cab['PAYMENT-SIGNATURE'] && cab['X-PAYMENT'], 'van las dos cabeceras');
  const v2 = abrir(cab['PAYMENT-SIGNATURE']), v1 = abrir(cab['X-PAYMENT']);
  assert.equal(v1.x402Version, 1); assert.equal(v1.scheme, 'exact'); assert.equal(v1.network, v2.accepted.network);
  assert.deepEqual(v1.payload, v2.payload, 'el mismo cheque: una sola firma');
  // Un servidor que rechaza con el motivo en el cuerpo JSON y una cabecera PAYMENT-REQUIRED sin error.
  const pr1 = abrir((await fetch(url)).headers.get('payment-required'));
  const cuerpoDice = async (u, o) => o?.headers?.['X-PAYMENT'] ? new Response(JSON.stringify({ error: 'Payment failed', details: 'Unsupported payment scheme: None' }), { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': b64(pr1) } }) : new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': b64(pr1) } });
  await assert.rejects(pagador.pagar({ url, privKey: LLAVE_1, tope: '10000', fetch: cuerpoDice }), /Payment failed: Unsupported payment scheme/);
});
