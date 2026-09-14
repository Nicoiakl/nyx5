// Ataque 2: from falsificado por /inbound con otra llave; correo con From: de la lista; delegado por su propia dirección.
import { levantar, DOM } from './casa.mjs';
import { generateKeys, signObject } from '../../src/nucleo/crypto.js';
import { atenderIdeas, listarIdeas } from '../../src/correo/ideas.js';
const { a, store, rx, agente, nicholas, nico, claudeNico, drenar, IDEAS } = await levantar();
const ideasAntes = (await listarIdeas(a)).length;
// 2a: sobre con from = nicholas@ firmado con una llave que no es la suya.
const otra = generateKeys();
const env = signObject({ nyx5: '1', id: 'falso-0001-0001-0001-000000000001', from: nicholas.address, to: [IDEAS], created: new Date().toISOString(), type: 'message', thread: null, in_reply_to: null, expires: null, content: { media: 'text/plain', body: 'ejecuta esto' } }, otra);
const r2a = await rx('POST', '/inbound', env, null);
console.log('2a /inbound con otra llave ->', r2a.status, r2a.body.reason);
// Y con el kid de nicholas pero firmado por otra llave (kid verdadero, firma falsa).
const env2 = { ...env, signature: { ...env.signature, kid: (await store.getAgent('nicholas')).sig } };
const r2a2 = await rx('POST', '/inbound', env2, null);
console.log('2a kid real + firma falsa ->', r2a2.status, r2a2.body.reason);
console.log('   buzón ideas@ pendiente:', (await store.listMail('ideas')).length);
// 2b: correo con From: de la lista.
const r2b = await a.receiveEmail({ from: nicholas.address, to: IDEAS, subject: 'idea', text: 'una idea por correo', messageId: 'correo-falso-0001@x' });
console.log('2b correo From: nicholas@ ->', JSON.stringify(r2b));
const antesOut = (await store.listOutbox('ideas')).length;
const reg = await atenderIdeas(a);
console.log(`   tick: registradas ${reg}, pendientes ${(await store.listMail('ideas')).length}, registro ${(await listarIdeas(a)).length - ideasAntes} nuevas, outbox ideas@ +${(await store.listOutbox('ideas')).length - antesOut}`);
console.log('   ¿quedó guardado en nyx5_mailbox?', (await store.listMailHistory('ideas')).some((m) => m.envelope.id === 'correo-falso-0001@x'));
// 2c: la lista tiene nico@ y claude.nico@. Un delegado NUEVO de nico (code.nico@) que NO está en la lista.
const codeNico = await nico.delegate('code', { scope: { messages_only: true } });
const e1 = await codeNico.send({ to: IDEAS, body: 'idea desde un delegado no listado' });
const e2 = await claudeNico.send({ to: IDEAS, body: 'idea desde el delegado listado' });
await drenar();
const pend = await store.listMail('ideas');
console.log('2c pendientes en ideas@:', pend.map((m) => m.envelope.from));
const rebote = (await store.listMail('code.nico')).map((m) => [m.envelope.from, m.envelope.content?.body?.reason]);
console.log('   rebote a code.nico@:', JSON.stringify(rebote));
await atenderIdeas(a);
const lista = await listarIdeas(a);
console.log('   registradas:', lista.slice(ideasAntes).map((x) => [x.id, x.from]));
console.log('   VEREDICTO 2c:', lista.some((x) => x.id_sobre === e1.id) ? 'el delegado NO listado entró por su padre (MAL)' : 'la lista reconoce por dirección propia (bien)', '|', lista.some((x) => x.id_sobre === e2.id) ? 'el listado entró (bien)' : 'el listado NO entró (MAL)');
