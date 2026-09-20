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
  cfg = loadConfig({ dbFile: ':memory:', publicUrl: 'https://jwin.test', ocrEnabled: false, paymentMode: 'manual', kycMode: 'auto', adminPassword: 'Sup3r-secret', smtp: { json: true }, otp: { resendMs: 0 }, uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jwin-adm-')) });
  const log = (...a) => logs.push(a.join(' ')); notifier = createNotifier(cfg, { log });
  srv = http.createServer(createApp({ cfg, db: openDb(':memory:'), notifier, log }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => srv.close());
const call = async (method, p, body, token, form) => { const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) }); const ct = r.headers.get('content-type') || ''; return { s: r.status, h: r.headers, j: ct.includes('json') ? await r.json() : await r.text() }; };
const lastOtp = () => /-> (\d{6})/.exec([...logs].reverse().find((l) => l.includes('[OTP')))[1];
async function register(phone, email, prenoms) { await call('POST', '/api/otp/send', { phone, channel: 'sms', purpose: 'signup' }); const v = await call('POST', '/api/otp/verify', { phone, purpose: 'signup', code: lastOtp() }); return call('POST', '/api/register', { proof: v.j.proof, nom: 'Test', prenoms, email, naissance: '1990-01-01', password: 'Motdepasse1' }); }

let T, U, V;
test('accès : mot de passe requis, jeton utilisateur refusé', async () => {
  assert.equal((await call('POST', '/api/admin/login', { user: 'J-WIN', password: 'faux' })).s, 401);
  assert.equal((await call('GET', '/api/admin/stats')).s, 401);
  T = (await call('POST', '/api/admin/login', { user: 'J-WIN', password: 'Sup3r-secret' })).j.token; assert.ok(T);
  U = await register('0701100001', 'u1@example.com', 'Aya'); V = await register('0701100002', 'u2@example.com', 'Moussa');
  assert.equal((await call('GET', '/api/admin/stats', null, U.j.token)).s, 401);
  assert.equal((await call('GET', '/admin')).s, 200);
});
test('statistiques et liste des utilisateurs avec recherche', async () => {
  const s = (await call('GET', '/api/admin/stats', null, T)).j; assert.equal(s.users.total, 2); assert.equal(s.signups.length, 30);
  const l = (await call('GET', '/api/admin/users?q=Moussa', null, T)).j; assert.equal(l.total, 1); assert.equal(l.rows[0].email, 'u2@example.com'); assert.equal(l.rows[0].pw_hash, undefined);
});
test('suspension, réactivation, identité, ajustement de solde, mot de passe temporaire', async () => {
  const id = U.j.user.id;
  assert.equal((await call('POST', `/api/admin/users/${id}/status`, { status: 'suspended', reason: 'test' }, T)).s, 200);
  assert.equal((await call('GET', '/api/wallet', null, U.j.token)).s, 403);
  assert.equal((await call('POST', '/api/login', { phone: '0701100001', password: 'Motdepasse1' })).s, 403);
  await call('POST', `/api/admin/users/${id}/status`, { status: 'active' }, T);
  assert.equal((await call('GET', '/api/wallet', null, U.j.token)).s, 200);
  assert.equal((await call('POST', `/api/admin/users/${id}/kyc`, { status: 'rejected' }, T)).j.kyc, 'rejected');
  assert.equal((await call('POST', `/api/admin/users/${id}/adjust`, { amount: 1000, memo: '' }, T)).s, 400);
  assert.equal((await call('POST', `/api/admin/users/${id}/adjust`, { amount: 5000, memo: 'Geste commercial' }, T)).j.balance, 5000);
  assert.equal((await call('POST', `/api/admin/users/${id}/adjust`, { amount: -9000, memo: 'Correction' }, T)).s, 409);
  const p = (await call('POST', `/api/admin/users/${id}/reset-password`, {}, T)).j.temporaryPassword;
  assert.equal((await call('POST', '/api/login', { phone: '0701100001', password: p })).s, 200);
  const d = (await call('GET', `/api/admin/users/${id}`, null, T)).j; assert.equal(d.user.balance, 5000); assert.equal(d.ledger[0].kind, 'admin_adjust');
});
test('missions et paiements traités depuis la console', async () => {
  const fd = new FormData(); Object.entries({ title: 'Mission console', desc: 'Une description suffisante ici.', cat: 'enligne', mode: 'remote', amount: '2000' }).forEach(([k, v]) => fd.append(k, v));
  const m = (await call('POST', '/api/missions', null, U.j.token, fd)).j.mission;
  assert.equal((await call('GET', '/api/admin/missions?mod=pending', null, T)).j.rows.length, 1);
  assert.equal((await call('POST', `/api/admin/missions/${encodeURIComponent(m.id)}/approve`, {}, T)).s, 200);
  assert.equal((await call('POST', `/api/admin/missions/${encodeURIComponent(m.id)}/approve`, {}, T)).s, 409);
  assert.equal((await call('GET', '/api/missions', null, V.j.token)).j.market.length, 1);
  const d = (await call('POST', '/api/deposits', { amount: 20000, phone: '0701100002' }, V.j.token)).j;
  await call('POST', `/api/deposits/${d.id}/confirm`, { txId: 'X1' }, V.j.token);
  const q = (await call('GET', '/api/admin/payments?status=PENDING_ADMIN', null, T)).j.rows; assert.equal(q.length, 1); assert.equal(q[0].tx_id, 'X1');
  assert.equal((await call('POST', `/api/admin/payments/${d.id}/approve`, {}, T)).s, 200);
  assert.equal((await call('GET', '/api/wallet', null, V.j.token)).j.balance, 20000);
  const w = (await call('POST', '/api/payouts', { amount: 5000, method: 'orange', phone: '0701100002' }, V.j.token)).j;
  assert.equal((await call('POST', `/api/admin/payments/${w.id}/reject`, { note: 'test' }, T)).s, 200);
  assert.equal((await call('GET', '/api/wallet', null, V.j.token)).j.balance, 20000);   // remboursé
  assert.equal((await call('POST', `/api/admin/missions/${encodeURIComponent(m.id)}/cancel`, {}, T)).s, 200);
  assert.equal((await call('GET', '/api/admin/stats', null, T)).j.money.deposited, 20000);
});
test('réglages : frais, bandeau, maintenance ; applicables sans redémarrage', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { 'fees.recharge': 99 }, T)).s, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { 'fees.recharge': 3, banner: 'Nouveau : offres Entreprise', adminOm: '+225 01 02 03 04 05' }, T)).s, 200);
  const c = (await call('GET', '/api/config')).j; assert.equal(c.banner, 'Nouveau : offres Entreprise'); assert.equal(c.adminOm, '+225 01 02 03 04 05'); assert.equal(c.fees.recharge, 3);
  const d = (await call('POST', '/api/deposits', { amount: 10000, phone: '0701100002' }, V.j.token)).j; assert.equal(d.fee, 300); assert.equal(d.payTo, '+225 01 02 03 04 05');
  await call('PUT', '/api/admin/settings', { maintenance: true }, T);
  assert.equal((await call('GET', '/api/wallet', null, V.j.token)).s, 503);
  assert.equal((await call('GET', '/api/admin/stats', null, T)).s, 200);
  await call('PUT', '/api/admin/settings', { maintenance: false }, T);
  assert.equal((await call('GET', '/api/wallet', null, V.j.token)).s, 200);
});
test('exports CSV, sauvegarde, système, e-mail de test, message groupé, audit', async () => {
  const u = await call('GET', '/api/admin/export/users', null, T); assert.match(u.h.get('content-type'), /text\/csv/); assert.ok(u.j.startsWith('id;nom;prenoms')); assert.ok(u.j.includes('u2@example.com')); assert.ok(!u.j.includes('pw_hash'));
  const l = await call('GET', '/api/admin/export/ledger?from=2020-01-01&to=2099-01-01', null, T); assert.ok(l.j.includes('admin_adjust'));
  assert.equal((await call('GET', '/api/admin/export/inconnu', null, T)).s, 404);
  assert.ok((await call('GET', '/api/admin/export/invoices', null, T)).j.includes('Recharge'));
  const b = await fetch(base + '/api/admin/backup', { headers: { Authorization: 'Bearer ' + T } }); assert.equal(b.status, 200); assert.equal(Buffer.from(await b.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await call('GET', '/api/admin/system', null, T)).j.paymentMode, 'manual');
  assert.equal((await call('POST', '/api/admin/system/test-email', { to: 'jwin1.2026@gmail.com' }, T)).j.sent, true);
  assert.equal((await call('POST', '/api/admin/broadcast', { subject: 'Info J-WIN', text: 'Bonjour à toutes et tous, une nouveauté arrive.' }, T)).j.recipients, 2);
  const a = (await call('GET', '/api/admin/audit', null, T)).j.rows.map((x) => x.action); for (const k of ['login', 'user_status', 'wallet_adjust', 'settings', 'export', 'backup', 'broadcast']) assert.ok(a.includes(k), k);
});
