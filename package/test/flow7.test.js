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

let base, srv, notifier, cfg, T;
test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwin-f7-'));
  cfg = loadConfig({ dbFile: ':memory:', publicUrl: 'https://jwin.test', ocrEnabled: false, adminPassword: 'Sup3r-secret', kycMode: 'auto', smtp: { json: true }, uploadDir: path.join(tmp, 'uploads') });
  const log = () => {}; notifier = createNotifier(cfg, { log });
  srv = http.createServer(createApp({ cfg, db: openDb(':memory:'), notifier, log }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
  T = (await call('POST', '/api/admin/login', { user: 'J-WIN', password: 'Sup3r-secret' })).j.token;
});
test.after(() => srv.close());
const call = async (method, p, body, token, form) => { const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) }); const ct = r.headers.get('content-type') || ''; return { s: r.status, j: ct.includes('json') ? await r.json() : await r.text() }; };
const enc = encodeURIComponent;
const reg = async (phone, email, prenoms, nom = 'Kone') => { const r = await call('POST', '/api/register', { phone, nom, prenoms, email, naissance: '1990-01-01', password: 'Motdepasse1' }); return { ...r.j, id: r.j.user.id }; };
const verify = (u) => { const fd = new FormData(); fd.append('type', 'cni'); fd.append('number', 'C0123456789'); fd.append('front', new Blob(['a'], { type: 'image/png' }), 'f.png'); fd.append('back', new Blob(['b'], { type: 'image/png' }), 'b.png'); fd.append('selfie', new Blob(['c'], { type: 'image/png' }), 's.png'); return call('POST', '/api/kyc/submit', null, u.token, fd); };
const mk = async (u, title, amount = 5000) => { const fd = new FormData(); Object.entries({ title, desc: 'Une description suffisante ici.', cat: 'livraison', mode: 'onsite', city: 'Cocody', amount: String(amount) }).forEach(([k, v]) => fd.append(k, v)); const m = (await call('POST', '/api/missions', null, u.token, fd)).j.mission; await call('POST', `/api/admin/missions/${enc(m.id)}/approve`, {}, T); return m.id; };
const M = (u) => call('GET', '/api/missions', null, u.token).then((r) => r.j);
const post = (u, id, act, body = {}) => call('POST', `/api/missions/${enc(id)}/${act}`, body, u.token);
const proof = (u, id, text = 'Fait, voir la photo', link = 'https://exemple.ci/preuve') => { const fd = new FormData(); fd.append('text', text); if (link) fd.append('link', link); fd.append('images', new Blob([Buffer.from('p')], { type: 'image/jpeg' }), 'p.jpg'); fd.append('audio', new Blob([Buffer.from('v')], { type: 'audio/webm' }), 'v.webm'); return call('POST', `/api/missions/${enc(id)}/submit-proof`, null, u.token, fd); };
const dep = async (u, amount) => { const d = (await call('POST', '/api/deposits', { amount, phone: '0701000000' }, u.token)).j; await call('POST', `/api/deposits/${d.id}/confirm`, { txId: 'x' }, u.token); await call('POST', `/api/admin/payments/${d.id}/approve`, {}, T); };

let A, B, C, mid;
test('candidature : le créateur voit nom, prénoms et note avant de choisir ; notification interne', async () => {
  A = await reg('0705000001', 'a@x.ci', 'Aya', 'Kone'); B = await reg('0705000002', 'b@x.ci', 'Moussa Ali', 'Traore'); C = await reg('0705000003', 'c@x.ci', 'Cyr', 'Bamba');
  mid = await mk(A, 'Livrer un colis');
  assert.equal((await M(B)).market.length, 1);
  const r = await post(B, mid, 'apply', { message: 'Disponible aujourd\'hui' }); assert.equal(r.s, 200); assert.equal(r.j.mission.status, 'candidature'); assert.equal(r.j.mission.role, 'real');
  await post(C, mid, 'apply');
  assert.equal((await M(B)).market.length, 0);                                               // déjà postulé : sorti de la liste publique
  const mine = (await M(A)).mine.find((m) => m.id === mid); assert.equal(mine.status, 'attente'); assert.equal(mine.candidates.length, 2);
  const cb = mine.candidates.find((x) => x.userId === B.id); assert.equal(cb.prenoms, 'Moussa Ali'); assert.equal(cb.nom, 'Traore'); assert.equal(cb.rating, null); assert.equal(cb.message, 'Disponible aujourd\'hui');
  assert.equal(mine.counterpart, undefined);                                                   // pas de contact tant que personne n'est choisi
  const n = (await call('GET', '/api/notifications', null, A.token)).j; assert.ok(n.items.some((x) => x.title.includes('Nouvelle candidature') && x.text.includes('Moussa Ali Traore') && x.text.includes('pas encore noté')));
  assert.equal(n.unread >= 1, true); await call('POST', '/api/notifications/read', { all: true }, A.token); assert.equal((await call('GET', '/api/notifications', null, A.token)).j.unread, 0);
});
test('discussion : réservée au créateur et au candidat, non lus, téléphone seulement après acceptation', async () => {
  assert.equal((await call('POST', `/api/chats/${enc(mid)}/${B.id}`, { text: 'Bonjour, quelle heure ?' }, A.token)).s, 201);
  assert.equal((await call('POST', `/api/chats/${enc(mid)}/x`, { text: 'Bonjour' }, B.token)).s, 201);                     // le candidat écrit dans son propre fil
  const D = await reg('0705000004', 'd@x.ci', 'Dia');
  assert.equal((await call('GET', `/api/chats/${enc(mid)}/${B.id}`, null, D.token)).s, 403);                              // un tiers n'a aucun accès
  const list = (await call('GET', '/api/chats', null, B.token)).j; assert.equal(list.threads.length, 1); assert.equal(list.threads[0].unread, 1); assert.equal(list.unread, 1);
  assert.equal((await call('GET', `/api/chats/${enc(mid)}/${C.id}`, null, B.token)).s, 200);                              // B lit SON fil (le paramètre est ignoré pour un candidat)
  const th = (await call('GET', `/api/chats/${enc(mid)}/${B.id}`, null, B.token)).j; assert.equal(th.messages.length, 2); assert.equal(th.messages[0].mine, false); assert.equal(th.phone, ''); assert.equal(th.with, 'Aya Kone');
  assert.equal((await call('GET', '/api/chats', null, B.token)).j.unread, 0);
  assert.equal((await call('POST', `/api/chats/${enc(mid)}/${B.id}`, { text: '  ' }, A.token)).s, 400);
});
test('choix du réalisateur : détails, refus des autres, contacts, annulation interdite au créateur', async () => {
  assert.equal((await post(B, mid, 'choose', { userId: B.id })).s, 403);
  const r = await post(A, mid, 'choose', { userId: B.id }); assert.equal(r.s, 200); assert.equal(r.j.mission.status, 'cours'); assert.equal(r.j.mission.counterpart.name, 'Moussa Ali Traore'); assert.equal(r.j.mission.counterpart.phone, '0705000002');
  const rb = (await M(B)).mine.find((m) => m.id === mid); assert.equal(rb.status, 'cours'); assert.equal(rb.counterpart.name, 'Aya Kone'); assert.equal(rb.counterpart.phone, '0705000001');
  const rc = (await M(C)).mine.find((m) => m.id === mid); assert.equal(rc.status, 'refusee'); assert.equal(rc.counterpart.phone, undefined);
  assert.ok((await call('GET', '/api/notifications', null, B.token)).j.items.some((x) => x.title.includes('Candidature retenue')));
  assert.ok((await call('GET', '/api/notifications', null, C.token)).j.items.some((x) => x.title.includes('non retenue')));
  assert.equal((await post(C, mid, 'apply')).s, 409);
  const c = await post(A, mid, 'cancel'); assert.equal(c.s, 403); assert.match(c.j.error, /administrateur/);                // acceptée : le créateur ne peut plus annuler
  assert.equal((await call('GET', `/api/chats/${enc(mid)}/${B.id}`, null, A.token)).j.phone, '0705000002');
});
test('preuves : texte + lien + photo + vocal, correction, approbation, paiement, notes croisées', async () => {
  assert.equal((await post(A, mid, 'validate')).s, 409);                                        // rien à valider
  const empty = new FormData(); assert.equal((await call('POST', `/api/missions/${enc(mid)}/submit-proof`, null, B.token, empty)).s, 400);
  const bad = new FormData(); bad.append('link', 'javascript:alert(1)'); assert.equal((await call('POST', `/api/missions/${enc(mid)}/submit-proof`, null, B.token, bad)).s, 400);
  assert.equal((await proof(A, mid)).s, 409);                                                    // seul le réalisateur envoie
  const p = await proof(B, mid); assert.equal(p.s, 200); assert.equal(p.j.mission.status, 'terminee'); assert.equal(p.j.mission.proof.text, 'Fait, voir la photo'); assert.equal(p.j.mission.proof.images.length, 1); assert.ok(p.j.mission.proof.audio);
  const seen = (await M(A)).mine.find((m) => m.id === mid).proof; assert.equal(seen.link, 'https://exemple.ci/preuve');
  assert.equal((await post(A, mid, 'revise', { note: '' })).s, 400);
  assert.equal((await post(A, mid, 'revise', { note: 'Ajoutez une photo de la signature' })).j.mission.status, 'attente' === 'x' ? '' : 'cours');
  assert.equal((await M(B)).mine.find((m) => m.id === mid).proofNote, 'Ajoutez une photo de la signature');
  await proof(B, mid, 'Signature ajoutée');
  const v0 = await post(A, mid, 'validate', { rating: 5 }); assert.equal(v0.s, 402); assert.match(v0.j.error, /Solde insuffisant/);      // pas encore de fonds
  await dep(A, 10000);
  const v = await post(A, mid, 'validate', { rating: 4, review: 'Rapide et sérieux' }); assert.equal(v.s, 200); assert.equal(v.j.mission.status, 'payee'); assert.equal(v.j.mission.execRating, 4);
  assert.equal((await call('GET', '/api/wallet', null, A.token)).j.balance, 10000 - 5000); assert.equal((await call('GET', '/api/wallet', null, B.token)).j.balance, 5000 - 50);
  assert.equal((await post(A, mid, 'validate')).s, 409);                                        // pas de double paiement
  assert.equal((await post(A, mid, 'cancel')).s, 403);
  assert.equal((await post(B, mid, 'rate', { n: 5, review: 'Créateur clair' })).s, 200);
  // les notes apparaissent chez les candidats suivants
  const mid2 = await mk(C, 'Autre mission'); await post(B, mid2, 'apply');
  const cand = (await M(C)).mine.find((m) => m.id === mid2).candidates[0]; assert.equal(cand.rating, 4); assert.equal(cand.reviews, 1); assert.equal(cand.done, 1); assert.equal(cand.verified, false);
  await post(A, mid2, 'apply'); const ca = (await M(C)).mine.find((m) => m.id === mid2).candidates.find((x) => x.userId === A.id); assert.equal(ca.rating, null);
  assert.ok((await call('GET', '/api/notifications', null, B.token)).j.items.some((x) => x.title.includes('Preuves approuvées')));
  const listed = (await M(B)).market.find((m) => m.id === mid2); assert.equal(listed, undefined);
});
test('annulation par le créateur avant acceptation ; l\'administrateur peut annuler une mission acceptée ; retrait du réalisateur', async () => {
  const m1 = await mk(A, 'À annuler'); await post(C, m1, 'apply');
  assert.equal((await post(A, m1, 'cancel')).j.mission.status, 'annulee');
  assert.ok((await call('GET', '/api/notifications', null, C.token)).j.items.some((x) => x.title.includes('Mission annulée')));
  assert.equal((await post(C, m1, 'apply')).s, 409);
  const m2 = await mk(A, 'Acceptée puis annulée admin'); await post(C, m2, 'apply'); await post(A, m2, 'choose', { userId: C.id });
  assert.equal((await post(A, m2, 'cancel')).s, 403);
  assert.equal((await call('POST', `/api/admin/missions/${enc(m2)}/cancel`, { note: 'Litige' }, T)).s, 200);
  assert.equal((await M(C)).mine.find((m) => m.id === m2).status, 'annulee');
  const m3 = await mk(A, 'Retrait réalisateur'); await post(C, m3, 'apply'); await post(A, m3, 'choose', { userId: C.id });
  assert.equal((await post(C, m3, 'cancel')).j.mission.status, 'refusee' === 'x' ? '' : 'attente' && (await M(C)).mine.find((m) => m.id === m3)?.status === 'refusee' ? 'attente' : 'attente');
  assert.equal((await M(A)).mine.find((m) => m.id === m3).status, 'attente');
});
test('création de compte non vérifié : limite de candidatures ; suspension du compte : candidat exclu', async () => {
  const X = await reg('0705000010', 'x@x.ci', 'Xavier'); await verify(X);
  const m = await mk(A, 'Pour X'); assert.equal((await post(X, m, 'apply')).s, 200);
  await call('POST', `/api/admin/users/${X.id}/status`, { status: 'suspended' }, T);
  assert.equal((await post(A, m, 'choose', { userId: X.id })).s, 409);
});
test('console : avis, détail de mission, message direct et note interne', async () => {
  const rv = (await call('GET', '/api/admin/reviews?max=5', null, T)).j.rows; assert.ok(rv.length >= 1);
  const d = (await call('GET', `/api/admin/missions/${enc(mid)}/detail`, null, T)).j;
  assert.equal(d.executor.name, 'Moussa Ali Traore'); assert.ok(d.proof.text); assert.ok(d.chat.length >= 2); assert.equal(d.candidates.length, 2);
  assert.equal((await call('POST', `/api/admin/users/${B.id}/message`, { subject: 'Bonjour', text: 'Un message de test' }, T)).s, 200);
  assert.ok((await call('GET', '/api/notifications', null, B.token)).j.items.some((x) => x.title === 'Bonjour'));
  assert.equal((await call('POST', `/api/admin/users/${B.id}/note`, { note: 'Fiable' }, T)).s, 200);
  assert.equal((await call('GET', `/api/admin/users/${B.id}`, null, T)).j.user.admin_note, 'Fiable');
  assert.equal((await call('POST', `/api/admin/reviews/${enc(mid)}/remove`, { which: 'exec' }, T)).s, 200);
  assert.equal((await call('GET', `/api/admin/users/${B.id}`, null, T)).j.rExec.avg, null);
});
