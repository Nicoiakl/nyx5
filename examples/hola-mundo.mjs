// El "hola mundo" de Nyx5: una casa, dos agentes, un mensaje cifrado que viaja firmado
// y aparece en el buzón del otro. Sin servidor aparte, sin dependencias.
//
//   node examples/hola-mundo.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';

const url = 'http://127.0.0.1:4321', hosts = { 'casa.local': { url } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-hola-'));
const casa = await new Estafeta({ domain: 'casa.local', port: 4321, dataDir: dir, adminToken: 's', hosts, log: () => {} }).start();

const alicia = Agent.create('alicia@casa.local', url, { hosts });
const bruno = Agent.create('bruno@casa.local', url, { hosts });
await alicia.register({ adminToken: 's' });
await bruno.register({ adminToken: 's' });

await alicia.send({ to: bruno.address, body: '¡Hola, Bruno! Este sobre viaja firmado y cifrado.' });
const m = await bruno.waitFor((e) => e.from === alicia.address);   // Bruno espera su carta
const abierto = await bruno.open(m.envelope);                    // solo Bruno puede descifrarla

console.log('De:', abierto.from);
console.log('Dice:', abierto.content.body);
await casa.stop();
