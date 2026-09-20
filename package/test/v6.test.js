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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwin-v6-'));
  cfg = loadConfig({ dbFile: ':memory:', publicUrl: 'https://jwin.test', ocrEnabled: false, adminPassword: '', smtp: { json: true }, uploadDir: path.join(tmp, 'uploads') });
  const log = () => {}; notifier = createNotifier(cfg, { log });
  srv = http.createServer(createApp({ cfg, db: openDb(':memory:'), notifier, log }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => srv.close());
const call = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); const ct = r.headers.get('content-type') || ''; return { s: r.status, j: ct.includes('json') ? await r.json() : await r.text() }; };
const lastMail = (to) => [...notifier.outbox].reverse().find((m) => m.to === to);
const tokenOf = (m) => decodeURIComponent(/\?login=(\S+)/.exec(m.text)[1]);

let T;
test('console : identifiants par défaut J-WIN / 1234, mode restreint tant qu\'ils ne sont pas changés', async () => {
  assert.equal((await call('POST', '/api/admin/login', { user: 'Autre', password: '1234' })).s, 401);
  assert.equal((await call('POST', '/api/admin/login', { user: 'J-WIN', password: '0000' })).s, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: '1234' })).s, 401);
  const r = await call('POST', '/api/admin/login', { user: 'j-win', password: '1234' }); assert.equal(r.s, 200); T = r.j.token;
  assert.equal((await call('GET', '/api/admin/stats', null, T)).j.defaultCreds, true);
  assert.equal((await call('GET', '/api/admin/users', null, T)).s, 200);                       // consultation possible
  for (const p of ['/api/admin/export/users', '/api/admin/backup', '/api/admin/kyc/x/front']) assert.equal((await call('GET', p, null, T)).s, 403);
  assert.equal((await call('PUT', '/api/admin/settings', { adminOm: '+225 01' }, T)).s, 403);
  assert.equal((await call('POST', '/api/admin/broadcast', { subject: 'abc', text: 'message assez long' }, T)).s, 403);
});
test('changement des identifiants : ancien refusé, nouveau accepté, restrictions levées', async () => {
  assert.equal((await call('POST', '/api/admin/credentials', { current: 'faux', user: 'Jesno', password: 'Nouveau2026x' }, T)).s, 401);
  assert.equal((await call('POST', '/api/admin/credentials', { current: '1234', user: 'Jesno', password: 'court' }, T)).s, 400);
  assert.equal((await call('POST', '/api/admin/credentials', { current: '1234', user: 'Jesno', password: 'Nouveau2026x' }, T)).s, 200);
  assert.equal((await call('POST', '/api/admin/login', { user: 'J-WIN', password: '1234' })).s, 401);
  T = (await call('POST', '/api/admin/login', { user: 'Jesno', password: 'Nouveau2026x' })).j.token; assert.ok(T);
  assert.equal((await call('GET', '/api/admin/stats', null, T)).j.defaultCreds, false);
  assert.equal((await call('GET', '/api/admin/export/users', null, T)).s, 200);
  assert.equal((await call('PUT', '/api/admin/settings', { adminOm: '+225 01 02' }, T)).s, 200);
});
test('lien de connexion par e-mail : inscription, connexion, usage unique, expiration, anti-spam', async () => {
  assert.equal((await call('POST', '/api/auth/link', { email: 'inconnu@example.com', mode: 'login' })).s, 200);
  assert.equal(lastMail('inconnu@example.com'), undefined);                                     // aucun e-mail pour un compte inexistant
  assert.equal((await call('POST', '/api/auth/link', { email: 'nouveau@example.com', mode: 'signup', profile: { nom: 'Kone' } })).s, 400);
  assert.equal((await call('POST', '/api/auth/link', { email: 'mineur@example.com', mode: 'signup', profile: { nom: 'K', prenoms: 'M', naissance: '2015-01-01' } })).s, 400);
  const p = { nom: 'Kone', prenoms: 'Fatou Aya', naissance: '1992-03-03', adresse: 'Cocody' };
  assert.equal((await call('POST', '/api/auth/link', { email: 'Nouveau@Example.com', mode: 'signup', profile: p })).s, 200);
  assert.equal((await call('POST', '/api/auth/link', { email: 'nouveau@example.com', mode: 'signup', profile: p })).s, 429);
  const m = lastMail('nouveau@example.com'); assert.match(m.subject, /inscription/); assert.ok(m.html.includes('/?login='));
  const v = await call('POST', '/api/auth/link/verify', { token: tokenOf(m) });
  assert.equal(v.s, 200); assert.equal(v.j.created, true); assert.equal(v.j.user.email, 'nouveau@example.com'); assert.equal(v.j.user.kycStatus, 'none'); assert.ok(v.j.token);
  assert.equal((await call('GET', '/api/me', null, v.j.token)).j.user.nom, 'Kone');
  assert.ok(lastMail('nouveau@example.com') && [...notifier.outbox].some((x) => x.to === 'nouveau@example.com' && x.subject.includes('Bienvenue')));
  assert.equal((await call('POST', '/api/auth/link/verify', { token: tokenOf(m) })).s, 401);   // usage unique
  assert.equal((await call('POST', '/api/auth/link/verify', { token: 'zzz' })).s, 401);
  // compte existant : connexion par lien
  await call('POST', '/api/register', { phone: '0704000001', nom: 'Bamba', prenoms: 'Ali', email: 'ali@example.com', naissance: '1990-01-01', password: 'Motdepasse1' });
  await call('POST', '/api/auth/link', { email: 'ali@example.com', mode: 'login' });
  const m2 = lastMail('ali@example.com'); assert.match(m2.subject, /connexion/);
  const v2 = await call('POST', '/api/auth/link/verify', { token: tokenOf(m2) }); assert.equal(v2.j.created, false); assert.equal(v2.j.user.prenoms, 'Ali');
  // compte suspendu
  await call('POST', `/api/admin/users/${v2.j.user.id}/status`, { status: 'suspended' }, T);
  assert.equal((await call('POST', '/api/auth/link', { email: 'ali@example.com', mode: 'login' })).s, 403);
});
test('lien : e-mail non configuré ou en échec => message clair', async () => {
  const saved = notifier.email; 
  const cfg2 = loadConfig({ dbFile: ':memory:', publicUrl: 'https://jwin.test', ocrEnabled: false, uploadDir: path.join(os.tmpdir(), 'jwin-v6b') });
  const n2 = createNotifier(cfg2, { log: () => {} }), s2 = http.createServer(createApp({ cfg: cfg2, db: openDb(':memory:'), notifier: n2, log: () => {} }));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/auth/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', mode: 'signup', profile: { nom: 'A', prenoms: 'B', naissance: '1990-01-01' } }) });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /envoi/i); s2.closeAllConnections(); s2.close(); void saved;
});
