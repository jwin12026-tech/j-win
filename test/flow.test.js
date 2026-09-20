import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../lib/config.js';
import { createApp } from '../app.js';
import { openDb } from '../lib/db.js';

/* ---- faux serveur CinetPay v1 (mêmes chemins que l'API réelle) ---- */
function mockCinetPay() {
  const pay = new Map(), tr = new Map(); let n = 0; const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {}; const send = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      calls.push({ m: req.method, u: req.url, auth: req.headers.authorization, j });
      if (req.url === '/v1/oauth/login') return j.api_key === 'sk_test_ok' && j.api_password === 'pw' ? send({ access_token: 'JWT123' }) : send({ status: 'INVALID_CREDENTIALS', code: 1005 }, 401);
      if (req.headers.authorization !== 'Bearer JWT123') return send({ status: 'INVALID_TOKEN', code: 1002 }, 401);
      if (req.method === 'POST' && req.url === '/v1/payment') { const id = ++n; pay.set(j.merchant_transaction_id, { status: 'INITIATED', j }); return send({ code: 201, status: 'INITIATED', payment_token: 'PT' + id, notify_token: 'NT' + id, transaction_id: 'CP' + id, merchant_transaction_id: j.merchant_transaction_id, payment_url: 'https://pay.example/' + id }, 201); }
      if (req.method === 'POST' && req.url === '/v1/transfer') { const id = ++n; if (j.amount > 100000) return send({ status: 'INSUFFICIENT_BALANCE', code: 2005, description: 'Solde marchand insuffisant' }, 400); tr.set('CT' + id, { status: 'PENDING', j }); return send({ code: 201, status: 'PENDING', transaction_id: 'CT' + id, notify_token: 'TN' + id, merchant_transaction_id: j.merchant_transaction_id, amount: String(j.amount), fee_amount: '0' }, 201); }
      let m;
      if ((m = /^\/v1\/payment\/(.+)$/.exec(req.url))) { const p = pay.get(decodeURIComponent(m[1])); return p ? send({ code: 100, status: p.status, merchant_transaction_id: decodeURIComponent(m[1]), transaction_id: 'CPX' }) : send({ status: 'NOT_FOUND', code: 404 }, 404); }
      if ((m = /^\/v1\/transfer\/(.+)$/.exec(req.url))) { const t = tr.get(m[1]); return t ? send({ code: 100, status: t.status, transaction_id: m[1], merchant_transaction_id: t.j.merchant_transaction_id }) : send({ status: 'NOT_FOUND', code: 404 }, 404); }
      send({ status: 'NOT_FOUND' }, 404);
    });
  });
  return { srv, pay, tr, calls };
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

let cp, api, base, otpLog = [], app;
test.before(async () => {
  cp = mockCinetPay(); const cpPort = await listen(cp.srv);
  const cfg = loadConfig({ dbFile: ':memory:', publicUrl: 'https://jwin.test', ocrEnabled: false, paymentMode: 'cinetpay', kycMode: 'manual', smtp: { json: true }, cinetpay: { apiKey: 'sk_test_ok', apiPassword: 'pw', baseUrl: `http://127.0.0.1:${cpPort}` }, otp: { resendMs: 0 } });
  app = createApp({ cfg, db: openDb(':memory:'), log: (...a) => otpLog.push(a.join(' ')) });
  api = http.createServer(app); base = `http://127.0.0.1:${await listen(api)}`;
});
test.after(() => { cp.srv.close(); api.close(); });

const post = (p, body, token) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const get = (p, token) => fetch(base + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then(async (r) => ({ s: r.status, j: await r.json() }));
const lastCode = () => /-> (\d{6})/.exec(otpLog.at(-1))[1];

let token, user;
test('OTP SMS + WhatsApp puis inscription', async () => {
  const s = await post('/api/otp/send', { phone: '07 01 02 03 04', channel: 'both', purpose: 'signup' });
  assert.equal(s.s, 200); assert.deepEqual(s.j.channels, ['sms', 'whatsapp']);
  assert.equal(otpLog.length, 2); assert.ok(otpLog[0].includes('[OTP sms]') && otpLog[1].includes('[OTP whatsapp]'));
  assert.equal((await post('/api/otp/verify', { phone: '0701020304', purpose: 'signup', code: '000000' })).s, 400);
  const v = await post('/api/otp/verify', { phone: '0701020304', purpose: 'signup', code: lastCode() });
  assert.equal(v.s, 200);
  const bad = await post('/api/register', { proof: v.j.proof, nom: 'Koffi', prenoms: 'Aya', naissance: '2015-01-01', password: 'Motdepasse1' });
  assert.equal(bad.s, 400);                                    // mineur refusé
  const r = await post('/api/register', { proof: v.j.proof, nom: 'Koffi', prenoms: 'Aya', email: 'aya@example.com', naissance: '1994-08-12', password: 'Motdepasse1', pieceType: 'cni', pieceNumero: 'C0123456789' });
  assert.equal(r.s, 201); token = r.j.token; user = r.j.user;
  assert.equal(user.contact, '0701020304'); assert.equal(user.kycStatus, 'pending');
  assert.equal((await post('/api/login', { phone: '0701020304', password: 'faux' })).s, 401);
  assert.equal((await post('/api/login', { phone: '0701020304', password: 'Motdepasse1' })).s, 200);
});

let rid;
test('recharge Wave : initialisation CinetPay + frais J-WIN', async () => {
  const r = await post('/api/payments/recharge', { amount: 10000, method: 'wave' }, token);
  assert.equal(r.s, 201); rid = r.j.id;
  assert.equal(r.j.fee, 100); assert.equal(r.j.total, 10100); assert.match(r.j.paymentUrl, /^https:\/\/pay\.example\//);
  const call = cp.calls.find((c) => c.u === '/v1/payment' && c.m === 'POST');
  assert.equal(call.auth, 'Bearer JWT123'); assert.equal(call.j.amount, 10100); assert.equal(call.j.payment_method, 'WAVE_CI'); assert.equal(call.j.currency, 'XOF');
  assert.equal(call.j.notify_url, 'https://jwin.test/api/payments/webhook'); assert.ok(call.j.merchant_transaction_id.length <= 30);
  assert.equal((await get('/api/wallet', token)).j.balance, 0);        // rien n'est crédité avant confirmation
});
test('webhook : mauvais jeton ignoré, bon jeton crédite une seule fois + facture', async () => {
  cp.pay.get(rid).status = 'SUCCESS';
  await post('/api/payments/webhook', { merchant_transaction_id: rid, notify_token: 'FAUX' });
  assert.equal((await get('/api/wallet', token)).j.balance, 0);
  for (let i = 0; i < 3; i++) await post('/api/payments/webhook', { merchant_transaction_id: rid, notify_token: 'NT1' });
  const w = (await get('/api/wallet', token)).j;
  assert.equal(w.balance, 10000); assert.equal(w.entries.filter((e) => e.kind === 'recharge').length, 1);
  const inv = (await get('/api/invoices/' + w.entries[0].invoiceNo, token)).j;
  assert.match(inv.no, /^FAC-\d{4}-000001$/); assert.equal(inv.total, 10100); assert.equal(inv.fee, 100); assert.equal(inv.lines.length, 2);
  assert.equal((await get('/api/payments/' + rid, token)).j.status, 'SUCCESS');
});
test('recharge en attente : le polling règle le statut', async () => {
  const r = await post('/api/payments/recharge', { amount: 5000, method: 'orange' }, token);
  assert.equal((await get('/api/payments/' + r.j.id, token)).j.status, 'PENDING');
  cp.pay.get(r.j.id).status = 'SUCCESS';
  assert.equal((await get('/api/payments/' + r.j.id, token)).j.status, 'SUCCESS');
  assert.equal((await get('/api/wallet', token)).j.balance, 15000);
});
test('recharge refusée par le fournisseur => échec propre', async () => {
  const r = await post('/api/payments/recharge', { amount: 50, method: 'mtn' }, token); assert.equal(r.s, 400);
  const c = await post('/api/payments/recharge', { amount: 1000, method: 'bitcoin' }, token); assert.equal(c.s, 400);
});
let wid;
test('retrait Orange Money : solde réservé, frais, virement, facture', async () => {
  assert.equal((await post('/api/payouts', { amount: 50000, method: 'orange', phone: '0707070707' }, token)).s, 402);   // solde insuffisant
  const r = await post('/api/payouts', { amount: 8000, method: 'orange', phone: '07 07 07 07 07' }, token);
  assert.equal(r.s, 201); wid = r.j.id; assert.equal(r.j.fee, 80); assert.equal(r.j.net, 7920);
  const t = cp.calls.find((c) => c.u === '/v1/transfer' && c.m === 'POST');
  assert.equal(t.j.amount, 7920); assert.equal(t.j.phone_number, '+2250707070707'); assert.equal(t.j.payment_method, 'OM_CI');
  assert.equal((await get('/api/wallet', token)).j.balance, 7000);                        // 15000 - 8000 réservés
  const p = cp.tr.get('CT' + (cp.tr.size ? [...cp.tr.keys()][0].slice(2) : ''));
  cp.tr.forEach((v) => (v.status = 'SUCCESS'));
  await post('/api/payouts/webhook', { merchant_transaction_id: wid, notify_token: 'TN' + [...cp.tr.keys()][0].slice(2) });
  const pay = (await get('/api/payments/' + wid, token)).j;
  assert.equal(pay.status, 'SUCCESS'); assert.match(pay.invoiceNo, /^FAC-\d{4}-000003$/);
  const inv = (await get('/api/invoices/' + pay.invoiceNo, token)).j;
  assert.equal(inv.total, 7920); assert.equal(inv.kind, 'retrait');
  assert.equal((await get('/api/wallet', token)).j.balance, 7000);
});
test('retrait rejeté par le fournisseur => remboursement automatique', async () => {
  await post('/api/payments/recharge', { amount: 200000, method: 'wave' }, token).then((r) => { cp.pay.get(r.j.id).status = 'SUCCESS'; return get('/api/payments/' + r.j.id, token); });
  const before = (await get('/api/wallet', token)).j.balance;
  const r = await post('/api/payouts', { amount: 150000, method: 'mtn', phone: '0501020304' }, token);
  assert.ok(r.s >= 400);
  const w = (await get('/api/wallet', token)).j;
  assert.equal(w.balance, before);                                                        // remboursé
  assert.ok(w.entries.some((e) => e.kind === 'withdraw_refund'));
});
test('sécurité : routes protégées et factures privées', async () => {
  assert.equal((await get('/api/wallet')).s, 401);
  const o = await post('/api/otp/send', { phone: '0505050505', channel: 'sms', purpose: 'signup' });
  const v = await post('/api/otp/verify', { phone: '0505050505', purpose: 'signup', code: lastCode() });
  const b = await post('/api/register', { proof: v.j.proof, nom: 'Autre', prenoms: 'Test', email: 'autre@example.com', naissance: '1990-05-05', password: 'Autrepass1' });
  const inv = (await get('/api/wallet', token)).j.entries.find((e) => e.invoiceNo).invoiceNo;
  assert.equal((await get('/api/invoices/' + inv, b.j.token)).s, 404);                   // pas la facture d'un autre
  assert.equal((await post('/api/register', { proof: v.j.proof, nom: 'X', prenoms: 'Y', naissance: '1990-05-05', password: 'Autrepass1' })).s, 409 );
});
