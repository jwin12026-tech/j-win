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

let base, srv, notifier, cfg;
test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwin-n-'));
  cfg = loadConfig({ dbFile: ':memory:', publicUrl: 'https://jwin.test', ocrEnabled: false, paymentMode: 'manual', kycMode: 'manual', adminPassword: 'Sup3r-secret', smtp: { json: true }, uploadDir: path.join(tmp, 'uploads') });
  const log = () => {}; notifier = createNotifier(cfg, { log });
  srv = http.createServer(createApp({ cfg, db: openDb(':memory:'), notifier, log }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => srv.close());
const call = async (method, p, body, token, form) => { const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) }); const ct = r.headers.get('content-type') || ''; return { s: r.status, h: r.headers, j: ct.includes('json') ? await r.json() : await r.text() }; };
const reg = (phone, email, prenoms = 'Aya', extra = {}) => call('POST', '/api/register', { phone, nom: 'Kone', prenoms, email, naissance: '1992-03-03', password: 'Motdepasse1', ...extra });
const mission = (t, title) => { const fd = new FormData(); Object.entries({ title, desc: 'Une description suffisante ici.', cat: 'enligne', mode: 'remote', amount: '2000' }).forEach(([k, v]) => fd.append(k, v)); return call('POST', '/api/missions', null, t, fd); };
const approveAll = async (T) => { for (const m of (await call('GET', '/api/admin/missions?mod=pending', null, T)).j.rows) await call('POST', `/api/admin/missions/${encodeURIComponent(m.id)}/approve`, {}, T); };

let A, T;
test('inscription sans code SMS : profil non vérifié, e-mail de bienvenue', async () => {
  A = await reg('0703000001', 'a@example.com'); assert.equal(A.s, 201); assert.equal(A.j.user.kycStatus, 'none');
  assert.ok(notifier.outbox.some((m) => m.to === 'a@example.com' && m.subject.includes('Bienvenue') && m.text.includes('3 missions')));
  assert.equal((await reg('0703000001', 'b@example.com')).s, 409);       // numéro déjà pris
  assert.equal((await reg('0703000002', 'a@example.com')).s, 409);       // e-mail déjà pris
  assert.equal((await reg('123', 'c@example.com')).s, 400);               // numéro invalide
  assert.equal((await reg('0703000003', 'c@example.com', 'Mineur', { naissance: '2015-01-01' })).s, 400);
  assert.equal((await call('POST', '/api/login', { phone: '0703000001', password: 'Motdepasse1' })).s, 200);
  T = (await call('POST', '/api/admin/login', { user: 'J-WIN', password: 'Sup3r-secret' })).j.token;
});
test('limite de 3 missions créées sans vérification, levée après validation de l\'identité', async () => {
  for (const n of [1, 2, 3]) assert.equal((await mission(A.j.token, 'Mission ' + n)).s, 201);
  const r = await mission(A.j.token, 'Mission 4'); assert.equal(r.s, 403); assert.match(r.j.error, /vérification d'identité/);
  assert.equal((await call('POST', '/api/deposits', { amount: 1000, phone: '0703000001' }, A.j.token)).s, 201);     // le dépôt reste possible
});
test('limite de 3 missions réalisées sans vérification', async () => {
  const B = await reg('0703000010', 'b10@example.com', 'Bea'), C = await reg('0703000011', 'c11@example.com', 'Cyr');
  await approveAll(T);
  const ids = []; for (const n of [1, 2, 3, 4]) ids.push((await mission(C.j.token, 'Autre ' + n)).j?.mission?.id);   // C : 3 créées puis refus
  assert.equal(ids.filter(Boolean).length, 3); await approveAll(T);
  const market = (await call('GET', '/api/missions', null, B.j.token)).j.market; assert.ok(market.length >= 3);
  for (const m of market.slice(0, 3)) assert.equal((await call('POST', `/api/missions/${encodeURIComponent(m.id)}/accept`, {}, B.j.token)).s, 200);
  const r = await call('POST', `/api/missions/${encodeURIComponent(market[3].id)}/accept`, {}, B.j.token); assert.equal(r.s, 403); assert.match(r.j.error, /réalisées sans vérification/);
});
test('vérification d\'identité : envoi des pièces, contrôle par l\'administrateur, limites levées', async () => {
  const send = (t, over = {}, files = ['front', 'back', 'selfie']) => { const fd = new FormData(); Object.entries({ type: 'cni', number: 'C0123456789', ocrNom: 'KONE', ocrPrenoms: 'Aya', ocrDob: '1992-03-03', ...over }).forEach(([k, v]) => fd.append(k, v)); files.forEach((f) => fd.append(f, new Blob([Buffer.from('img-' + f)], { type: 'image/jpeg' }), f + '.jpg')); return call('POST', '/api/kyc/submit', null, t, fd); };
  assert.equal((await send(A.j.token, { number: 'XX' })).s, 400);
  assert.equal((await send(A.j.token, {}, ['front', 'selfie'])).s, 400);        // verso manquant
  const ok = await send(A.j.token); assert.equal(ok.s, 200); assert.equal(ok.j.status, 'pending');
  assert.equal((await call('GET', '/api/me', null, A.j.token)).j.user.kycStatus, 'pending');
  assert.equal((await send(A.j.token)).s, 409);                                  // déjà en cours
  const mail = [...notifier.outbox].reverse().find((m) => m.to === 'jwin1.2026@gmail.com' && m.subject.includes('identité à vérifier'));
  assert.ok(mail.text.includes('le nom lu sur la pièce correspond'));
  const id = A.j.user.id, d = (await call('GET', `/api/admin/users/${id}`, null, T)).j; assert.equal(d.kyc.f, 1); assert.equal(d.kyc.s, 1); assert.equal(d.kyc.ocr.nom, 'KONE');
  const img = await fetch(`${base}/api/admin/kyc/${id}/selfie`, { headers: { Authorization: 'Bearer ' + T } }); assert.equal(img.status, 200); assert.equal(Buffer.from(await img.arrayBuffer()).toString(), 'img-selfie');
  assert.equal((await fetch(`${base}/api/admin/kyc/${id}/selfie`)).status, 401);                        // jamais sans session administrateur
  assert.equal((await call('POST', `/api/admin/users/${id}/kyc`, { status: 'verified' }, T)).s, 200);
  assert.equal((await mission(A.j.token, 'Mission 4')).s, 201);                  // limite levée
});
test('mot de passe oublié par e-mail : lien à usage unique', async () => {
  assert.equal((await call('POST', '/api/password/forgot', { email: 'inconnu@example.com' })).s, 200);
  assert.equal(notifier.outbox.filter((m) => (m.subject || '').includes('Réinitialisation')).length, 0);
  await call('POST', '/api/password/forgot', { email: 'a@example.com' });
  const m = [...notifier.outbox].reverse().find((x) => (x.subject || '').includes('Réinitialisation')), tok = /\?reset=(\S+)/.exec(m.text)[1];
  assert.equal((await call('POST', '/api/password/reset', { token: tok, password: 'court' })).s, 400);
  assert.equal((await call('POST', '/api/password/reset', { token: tok, password: 'NouveauPass9' })).s, 200);
  assert.equal((await call('POST', '/api/login', { phone: '0703000001', password: 'NouveauPass9' })).s, 200);
  assert.equal((await call('POST', '/api/password/reset', { token: tok, password: 'EncoreUn99' })).s, 401);      // lien déjà utilisé
  assert.equal((await call('POST', '/api/password/reset', { token: 'zzz', password: 'EncoreUn99' })).s, 401);
});
test('mode auto : la vérification est immédiate ; retrait refusé si non vérifié en production', async () => {
  const U = await reg('0703000020', 'u20@example.com', 'Uma'); cfg.kycMode = 'auto';
  const fd = new FormData(); fd.append('type', 'passeport'); fd.append('number', 'AB123456'); fd.append('front', new Blob(['x'], { type: 'image/png' }), 'f.png'); fd.append('selfie', new Blob(['y'], { type: 'image/png' }), 's.png');
  assert.equal((await call('POST', '/api/kyc/submit', null, U.j.token, fd)).j.status, 'verified'); cfg.kycMode = 'manual';
  const W = await reg('0703000021', 'w21@example.com', 'Wil'); cfg.prod = true;
  assert.equal((await call('POST', '/api/payouts', { amount: 1000, method: 'orange', phone: '0703000021' }, W.j.token)).s, 403); cfg.prod = false;
});
