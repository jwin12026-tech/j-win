import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { createApp } from '../app.js';
import { openDb } from '../lib/db.js';
import { createNotifier } from '../lib/notify.js';

let base, srv, notifier, cfg; const logs = [];
test.before(async () => {
  cfg = loadConfig({ dbFile: ':memory:', publicUrl: 'https://jwin.test', ocrEnabled: false, paymentMode: 'manual', smtp: { json: true }, otp: { resendMs: 0 }, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jwin-up-')) });
  const log = (...a) => logs.push(a.join(' '));
  notifier = createNotifier(cfg, { log });
  srv = http.createServer(createApp({ cfg, db: openDb(':memory:'), notifier, log }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => srv.close());

const call = async (method, p, body, token, form) => {
  const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get('content-type') || '';
  return { s: r.status, j: ct.includes('json') ? await r.json() : await r.text() };
};
const lastOtp = () => /-> (\d{6})/.exec([...logs].reverse().find((l) => l.includes('[OTP')))[1];
async function register(phone, email, prenoms) {
  await call('POST', '/api/otp/send', { phone, channel: 'sms', purpose: 'signup' });
  const v = await call('POST', '/api/otp/verify', { phone, purpose: 'signup', code: lastOtp() });
  return call('POST', '/api/register', { proof: v.j.proof, nom: 'Test', prenoms, email, naissance: '1990-01-01', password: 'Motdepasse1' });
}
const mailTo = (to, subj) => [...notifier.outbox].reverse().find((m) => m.to === to && m.subject.includes(subj));
const actionLink = (m, label) => { const t = new RegExp(label + ' : https://jwin.test/admin/act\\?t=([^\\s]+)').exec(m.text)[1]; return decodeURIComponent(t); };
const adminDo = async (t, note) => { const g = await call('GET', '/admin/act?t=' + encodeURIComponent(t)); const p = await fetch(base + '/admin/act', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t, note: note || '' }) }); return { g, s: p.status, html: await p.text() }; };

let A, B;
test('inscription : e-mail obligatoire, e-mail + SMS de bienvenue envoyés', async () => {
  await call('POST', '/api/otp/send', { phone: '0701000001', channel: 'sms', purpose: 'signup' });
  const v = await call('POST', '/api/otp/verify', { phone: '0701000001', purpose: 'signup', code: lastOtp() });
  const noMail = await call('POST', '/api/register', { proof: v.j.proof, nom: 'Test', prenoms: 'Aya', naissance: '1990-01-01', password: 'Motdepasse1' });
  assert.equal(noMail.s, 400);
  A = await register('0701000002', 'aya@example.com', 'Aya');
  assert.equal(A.s, 201); assert.deepEqual(A.j.notified, { email: true, sms: true });
  assert.ok(mailTo('aya@example.com', 'Bienvenue'));
  assert.ok(logs.some((l) => l.startsWith('[SMS] +2250701000002')));
  B = await register('0701000003', 'moussa@example.com', 'Moussa');
  assert.equal((await register('0701000004', 'aya@example.com', 'Doublon')).s, 409);
});

test('dépôt Orange Money : demande, confirmation, validation par l\'administrateur, facture, e-mail utilisateur', async () => {
  const d = await call('POST', '/api/deposits', { amount: 50000, phone: '0701000002' }, A.j.token);
  assert.equal(d.s, 201); assert.equal(d.j.total, 50500); assert.equal(d.j.payTo, '+225 07 88 33 02 48'); assert.match(d.j.ref, /^DEP-/);
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.pending.length, 0);
  assert.equal((await call('POST', `/api/deposits/${d.j.id}/confirm`, { txId: 'MP123' }, A.j.token)).s, 200);
  const mail = mailTo('jwin1.2026@gmail.com', 'dépôt à valider');
  assert.ok(mail && mail.text.includes('MP123') && mail.html.includes('/admin/act?t='));
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.balance, 0);       // rien n'est crédité avant l'administrateur
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.pending.length, 1);
  assert.equal((await call('GET', '/admin/act?t=faux')).s, 400);
  const r = await adminDo(actionLink(mail, 'Valider le dépôt'));
  assert.equal(r.s, 200); assert.match(r.html, /validée/);
  const w = (await call('GET', '/api/wallet', null, A.j.token)).j;
  assert.equal(w.balance, 50000); assert.match(w.entries[0].invoiceNo, /^FAC-|^J-|\d/); assert.equal(w.pending.length, 0);
  assert.ok(mailTo('aya@example.com', 'Dépôt validé'));
  assert.match((await adminDo(actionLink(mail, 'Valider le dépôt'))).html, /Déjà traité/);   // aucun double crédit
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.balance, 50000);
});

test('retrait : solde réservé, e-mail à l\'administrateur, paiement puis refus avec remboursement', async () => {
  assert.equal((await call('POST', '/api/payouts', { amount: 900000, method: 'orange', phone: '0701000002' }, A.j.token)).s, 402);
  const p = await call('POST', '/api/payouts', { amount: 10000, method: 'mtn', phone: '0501000002' }, A.j.token);
  assert.equal(p.s, 201); assert.equal(p.j.net, 9900); assert.equal(p.j.status, 'PENDING_ADMIN');
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.balance, 40000);
  const mail = mailTo('jwin1.2026@gmail.com', 'retrait à payer');
  assert.ok(mail.text.includes('9 900 F') && mail.text.includes('MTN MoMo'));
  assert.equal((await adminDo(actionLink(mail, 'J\'ai payé'))).s, 200);
  assert.ok(mailTo('aya@example.com', 'Retrait payé'));
  const p2 = await call('POST', '/api/payouts', { amount: 5000, method: 'wave', phone: '0701000002' }, A.j.token);
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.balance, 35000);
  const mail2 = [...notifier.outbox].reverse().find((m) => m.subject.includes('retrait à payer') && m.text.includes(p2.j.ref));
  assert.equal((await adminDo(actionLink(mail2, 'Refuser et rembourser'), 'Numéro invalide')).s, 200);
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.balance, 40000);
});

let mid;
test('mission : invisible tant que non approuvée, photos + vocal, approbation par lien, acceptation, paiement', async () => {
  const fd = new FormData();
  Object.entries({ title: 'Livrer un dossier', desc: 'Récupérer un dossier au Plateau et le livrer à Cocody.', cat: 'livraison', mode: 'onsite', city: 'Cocody', place: 'Riviera 2', amount: '7500', lat: '5.36', lng: '-3.98', askLoc: 'false' }).forEach(([k, v]) => fd.append(k, v));
  fd.append('images', new Blob([Buffer.from('fakejpg1')], { type: 'image/jpeg' }), 'a.jpg'); fd.append('images', new Blob([Buffer.from('fakejpg2')], { type: 'image/png' }), 'b.png');
  fd.append('audio', new Blob([Buffer.from('fakeaudio')], { type: 'audio/webm' }), 'v.webm');
  const c = await call('POST', '/api/missions', null, A.j.token, fd);
  assert.equal(c.s, 201); mid = c.j.mission.id; assert.equal(c.j.mission.mod, 'pending'); assert.equal(c.j.mission.images.length, 2); assert.ok(c.j.mission.audio);
  const mail = mailTo('jwin1.2026@gmail.com', 'mission à approuver');
  assert.ok(mail.text.includes('Livrer un dossier') && mail.text.includes('Photos : 2'));
  assert.equal((await call('GET', '/api/missions', null, B.j.token)).j.market.length, 0);           // pas visible par tous avant approbation
  const mine = (await call('GET', '/api/missions', null, A.j.token)).j.mine; assert.equal(mine[0].role, 'donneur');
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/accept`, {}, B.j.token)).s, 409);            // non approuvée : inacceptable
  assert.equal((await adminDo(actionLink(mail, 'Approuver'))).s, 200);
  assert.ok(mailTo('aya@example.com', 'Mission approuvée'));
  const market = (await call('GET', '/api/missions', null, B.j.token)).j.market; assert.equal(market.length, 1); assert.equal(market[0].by, 'Aya T.');
  const img = await fetch(base + market[0].images[0]); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/accept`, {}, A.j.token)).s, 400);           // pas sa propre mission
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/accept`, {}, B.j.token)).s, 200);
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/accept`, {}, B.j.token)).s, 409);
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/validate`, {}, A.j.token)).s, 409);          // pas encore terminée
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/done`, {}, B.j.token)).s, 200);
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/validate`, {}, B.j.token)).s, 409);          // seul le donneur valide
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/validate`, {}, A.j.token)).s, 200);
  assert.equal((await call('GET', '/api/wallet', null, A.j.token)).j.balance, 40000 - 7500);
  assert.equal((await call('GET', '/api/wallet', null, B.j.token)).j.balance, 7500 - 75);            // commission 1 %
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(mid)}/rate`, { n: 5 }, B.j.token)).s, 200);
  assert.equal((await call('GET', '/api/missions', null, B.j.token)).j.market.length, 0);
});

test('mission refusée par l\'administrateur, quota de création, solde insuffisant', async () => {
  const mk = (title) => { const fd = new FormData(); Object.entries({ title, desc: 'Une description suffisante.', cat: 'enligne', mode: 'remote', amount: '2000' }).forEach(([k, v]) => fd.append(k, v)); return call('POST', '/api/missions', null, A.j.token, fd); };
  const m = await mk('Sondage en ligne'); assert.equal(m.j.mission.mode, 'remote'); assert.equal(m.j.mission.city, 'En ligne');
  const mail = [...notifier.outbox].reverse().find((x) => x.subject.includes(m.j.mission.id));
  assert.equal((await adminDo(actionLink(mail, 'Refuser'), 'Contenu non conforme')).s, 200);
  const mine = (await call('GET', '/api/missions', null, A.j.token)).j.mine.find((x) => x.id === m.j.mission.id);
  assert.equal(mine.mod, 'rejetee'); assert.equal(mine.modNote, 'Contenu non conforme');
  cfg.plan.unverified = 1; assert.equal((await mk('Trois')).s, 403); cfg.plan.unverified = 3;
  const poor = await register('0701000005', 'poor@example.com', 'Pauvre');
  const fd = new FormData(); Object.entries({ title: 'Mission chère', desc: 'Une description suffisante.', cat: 'visite', mode: 'remote', amount: '9000' }).forEach(([k, v]) => fd.append(k, v));
  const c = await call('POST', '/api/missions', null, poor.j.token, fd);
  const okMail = [...notifier.outbox].reverse().find((x) => x.subject.includes(c.j.mission.id)); await adminDo(actionLink(okMail, 'Approuver'));
  await call('POST', `/api/missions/${encodeURIComponent(c.j.mission.id)}/accept`, {}, B.j.token); await call('POST', `/api/missions/${encodeURIComponent(c.j.mission.id)}/done`, {}, B.j.token);
  assert.equal((await call('POST', `/api/missions/${encodeURIComponent(c.j.mission.id)}/validate`, {}, poor.j.token)).s, 402);
});

