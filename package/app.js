import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, uid, tx, balanceOf } from './lib/db.js';
import { CinetPay, CinetPayError, METHOD_CODES, mapStatus } from './lib/cinetpay.js';
import { sendOtp, verifyOtp, normPhone, validPhone } from './lib/otp.js';
import { issueInvoice } from './lib/invoices.js';
import { createNotifier } from './lib/notify.js';
import { registerV4 } from './lib/v4.js';
import { registerAdmin } from './lib/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const METHOD_LABEL = { orange: 'Orange Money', mtn: 'MTN MoMo', moov: 'Moov Money', wave: 'Wave', card: 'Carte bancaire' };
const pct = (amount, p) => Math.round((amount * p) / 100);
const merchantId = (p) => p + crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 10); // ≤ 30 caractères (limite CinetPay)

export function createApp({ cfg, db = openDb(cfg.dbFile), cinetpay, readIdentity, notifier, log = console.log } = {}) {
  cinetpay ??= new CinetPay(cfg.cinetpay);
  notifier ??= createNotifier(cfg, { log });
  let v4;
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  if (cfg.corsOrigin) app.use(cors({ origin: cfg.corsOrigin.split(','), credentials: false }));
  app.use(express.json({ limit: '200kb' }));

  const sign = (payload, exp) => jwt.sign(payload, cfg.jwtSecret, { expiresIn: exp });
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || (e instanceof CinetPayError ? 502 : 500);
    if (status >= 500) log('[erreur]', e.message);
    res.status(status).json({ error: status >= 500 && !(e instanceof CinetPayError) ? 'Erreur serveur.' : e.message });
  });
  const bad = (m, status = 400) => Object.assign(new Error(m), { status });
  const auth = (req, res, next) => {
    let sub;
    try { sub = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), cfg.jwtSecret).sub; }
    catch { return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' }); }
    if (db.prepare('SELECT status FROM users WHERE id=?').get(sub)?.status === 'suspended') return res.status(403).json({ error: 'Compte suspendu. Contactez le support J-WIN.' });
    req.uid = sub; next();
  };
  const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const publicUser = (u) => ({ id: u.id, nom: u.nom, prenoms: u.prenoms, naissance: u.dob, contact: u.phone || '', email: u.email || '', adresse: u.adresse || '', provider: u.provider, kycStatus: u.kyc_status });
  const session = (u) => ({ token: sign({ sub: u.id }, '7d'), user: publicUser(u) });
  const limiter = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de requêtes. Réessayez dans un instant.' } });

  registerAdmin({ app, db, cfg, wrap, bad, limiter, userById, notifier, log, express, getV4: () => v4, dir: here });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({
    live: true, paymentMode: cfg.paymentMode, adminOm: cfg.adminOm, plan: cfg.plan, fees: { ...cfg.fees, mission: cfg.fees.mission ?? 1 }, banner: cfg.banner, contact: { email: cfg.adminEmail, phone: cfg.company.contact }, limits: cfg.limits, ocr: cfg.ocrEnabled && !!readIdentity,
    methods: Object.keys(METHOD_LABEL), sso: { google: !!cfg.googleClientId }, otpChannels: ['sms', 'whatsapp', 'both'],
  }));

  /* ---------- OTP ---------- */
  app.post('/api/otp/send', limiter(60e3, 10), wrap(async (req, res) => {
    const { phone, channel = 'both', purpose } = req.body || {};
    if (!['signup', 'login', 'reset'].includes(purpose)) throw bad('Objet du code invalide.');
    if (!['sms', 'whatsapp', 'both'].includes(channel)) throw bad('Canal invalide.');
    const r = await sendOtp({ db, cfg, log }, { phone, channel, purpose });
    res.json({ ok: true, ...r });
  }));
  app.post('/api/otp/verify', limiter(60e3, 20), wrap(async (req, res) => {
    const { phone, code, purpose } = req.body || {};
    verifyOtp({ db, cfg }, { phone, purpose, code });
    res.json({ proof: sign({ phone: normPhone(phone), purpose }, '15m') });
  }));
  const readProof = (proof, purpose) => {
    try { const p = jwt.verify(proof, cfg.jwtSecret); if (p.purpose !== purpose) throw 0; return p.phone; }
    catch { throw bad('Vérification par code requise ou expirée.', 401); }
  };

  /* ---------- comptes ---------- */
  const okPw = (p) => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
  const okDob = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); if (d.getUTCMonth() !== +m[2] - 1) return false; const now = new Date(); const age = now.getUTCFullYear() - d.getUTCFullYear() - (now < new Date(Date.UTC(now.getUTCFullYear(), +m[2] - 1, +m[3])) ? 1 : 0); return +m[1] >= 1920 && age >= 18; };
  app.post('/api/register', limiter(60e3, 10), wrap(async (req, res) => {
    const b = req.body || {};
    const phone = b.proof ? readProof(b.proof, 'signup') : normPhone(b.phone);
    if (!validPhone(phone)) throw bad('Numéro mobile ivoirien à 10 chiffres requis.');
    if (!(b.nom || '').trim() || !(b.prenoms || '').trim()) throw bad('Nom et prénoms requis.');
    if (!okDob(b.naissance)) throw bad('Date de naissance invalide (18 ans minimum).');
    if (!okPw(b.password)) throw bad('Mot de passe : 8 caractères minimum, avec une lettre et un chiffre.');
    if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) throw bad('Ce numéro est déjà associé à un compte.', 409);
    const email = String(b.email || '').trim().toLowerCase();
    if ((cfg.requireEmail || email) && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('Adresse e-mail valide requise pour recevoir vos notifications.');
    if (email && db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw bad('Cette adresse e-mail est déjà associée à un compte.', 409);
    const id = uid('u_');
    const docNum = String(b.pieceNumero || '');
    db.prepare('INSERT INTO users(id,phone,email,provider,nom,prenoms,dob,adresse,pw_hash,kyc_status,kyc_doc_type,kyc_doc_last4,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, phone, email || null, 'phone', b.nom.trim(), b.prenoms.trim(), b.naissance, (b.adresse || '').trim(), bcrypt.hashSync(b.password, 11), 'none', '', '', Date.now());
    const nu = userById(id);
    const notified = await notifier.toUser(nu, 'Bienvenue sur J-WIN', `Bienvenue ${nu.prenoms.split(' ')[0]} ! Votre compte J-WIN est créé. Connectez-vous avec votre numéro ${phone}. Sans vérification d'identité, vous pouvez créer et réaliser ${cfg.plan.unverified} missions. Vérifiez votre pièce d'identité et faites un selfie dans Paramètres pour lever cette limite et retirer vos gains.`).catch(() => ({ email: false, sms: false }));
    res.status(201).json({ ...session(nu), notified });
  }));
  app.post('/api/login', limiter(60e3, 10), wrap(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE phone=?').get(normPhone(req.body?.phone));
    if (!u || !u.pw_hash || !bcrypt.compareSync(String(req.body?.password || ''), u.pw_hash)) throw bad('Numéro ou mot de passe incorrect.', 401);
    if (u.status === 'suspended') throw bad('Compte suspendu. Contactez le support J-WIN.', 403);
    res.json(session(u));
  }));
  app.post('/api/login/otp', limiter(60e3, 10), wrap(async (req, res) => {
    const phone = readProof(req.body?.proof, 'login');
    const u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
    if (!u) throw bad('Aucun compte pour ce numéro.', 404);
    res.json(session(u));
  }));
  app.post('/api/password/forgot', limiter(60e3, 5), wrap(async (req, res) => {
    const em = String(req.body?.email || '').trim().toLowerCase();
    const u = em && db.prepare('SELECT * FROM users WHERE email=? AND pw_hash IS NOT NULL').get(em);
    if (u && u.status !== 'suspended') {
      const token = jwt.sign({ sub: u.id }, cfg.jwtSecret + u.pw_hash.slice(-12), { expiresIn: '1h', audience: 'pwreset' });
      notifier.email(u.email, 'Réinitialisation de votre mot de passe J-WIN', `Bonjour ${u.prenoms.split(' ')[0]},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n${cfg.publicUrl}/?reset=${token}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`).catch(() => {});
    }
    res.json({ ok: true });   // même réponse que le compte existe ou non
  }));
  app.post('/api/password/reset', limiter(60e3, 10), wrap(async (req, res) => {
    if (req.body?.token) {
      const dec = jwt.decode(String(req.body.token)), u = dec?.sub && userById(dec.sub);
      if (!okPw(req.body?.password)) throw bad('Mot de passe : 8 caractères minimum, avec une lettre et un chiffre.');
      try { if (!u?.pw_hash) throw 0; jwt.verify(req.body.token, cfg.jwtSecret + u.pw_hash.slice(-12), { audience: 'pwreset' }); } catch { throw bad('Lien invalide ou expiré. Refaites une demande.', 401); }
      db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password, 11), u.id);
      return res.json({ ok: true });
    }
    const phone = readProof(req.body?.proof, 'reset');
    if (!okPw(req.body?.password)) throw bad('Mot de passe : 8 caractères minimum, avec une lettre et un chiffre.');
    db.prepare('UPDATE users SET pw_hash=? WHERE phone=?').run(bcrypt.hashSync(req.body.password, 11), phone);
    res.json({ ok: true });
  }));
  app.post('/api/sso', limiter(60e3, 20), wrap(async (req, res) => {
    // Google : vérification du jeton d'identité via l'endpoint tokeninfo. Apple / Microsoft / Yahoo : à ajouter (JWKS).
    if (req.body?.provider !== 'google' || !cfg.googleClientId) throw bad('Fournisseur SSO non configuré.', 501);
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.idToken || ''));
    const t = await r.json().catch(() => ({}));
    if (!r.ok || t.aud !== cfg.googleClientId || String(t.email_verified) !== 'true') throw bad('Jeton Google invalide.', 401);
    let u = db.prepare('SELECT * FROM users WHERE email=?').get(t.email.toLowerCase());
    if (!u) {
      const p = req.body.profile || {};
      if (!p.nom || !p.prenoms || !okDob(p.naissance)) throw bad('Profil incomplet pour créer le compte.');
      const id = uid('u_');
      db.prepare('INSERT INTO users(id,email,provider,nom,prenoms,dob,adresse,kyc_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, t.email.toLowerCase(), 'google', p.nom, p.prenoms, p.naissance, p.adresse || '', 'none', Date.now());
      u = userById(id);
    }
    res.json(session(u));
  }));
  app.get('/api/me', auth, wrap(async (req, res) => res.json({ user: publicUser(userById(req.uid)) })));

  /* ---------- OCR de la pièce d'identité (à l'inscription) ---------- */
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 2 }, fileFilter: (r, f, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(f.mimetype)) });
  app.post('/api/kyc/ocr', limiter(60e3, 6), upload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]), wrap(async (req, res) => {
    if (!cfg.ocrEnabled || !readIdentity) throw bad('Lecture automatique indisponible.', 501);
    const front = req.files?.front?.[0]?.buffer, back = req.files?.back?.[0]?.buffer;
    if (!front && !back) throw bad('Ajoutez une photo JPEG, PNG ou WebP de la pièce.');
    res.json(await readIdentity({ front, back }));
  }));

  /* ---------- portefeuille ---------- */
  const entry = (r) => ({ id: r.id, kind: r.kind, amount: r.amount, memo: r.memo, method: r.method, invoiceNo: r.invoice_no, at: r.created_at });
  app.get('/api/wallet', auth, wrap(async (req, res) => {
    const rows = db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.uid);
    res.json({ balance: balanceOf(db, req.uid), entries: rows.map(entry), pending: v4.pending(req.uid) });
  }));

  const checkMethod = (m, allowCard) => {
    if (!METHOD_LABEL[m] || (m === 'card' && !allowCard)) throw bad('Moyen de paiement non pris en charge.');
  };
  const cpPhone = (p) => '+225' + normPhone(p);

  /* ----- recharge : CinetPay (page de paiement hébergée) ----- */
  app.post('/api/payments/recharge', auth, limiter(60e3, 15), wrap(async (req, res) => {
    const { amount, method, phone } = req.body || {};
    const A = Number(amount);
    if (!Number.isInteger(A) || A < cfg.limits.rechargeMin || A > cfg.limits.rechargeMax) throw bad(`Montant entre ${cfg.limits.rechargeMin} et ${cfg.limits.rechargeMax} F.`);
    checkMethod(method, true);
    const u = userById(req.uid);
    const fee = pct(A, cfg.fees.recharge), total = A + fee;
    const id = merchantId('JWR');
    const now = Date.now();
    db.prepare('INSERT INTO payments(id,user_id,kind,method,amount,fee,status,phone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, u.id, 'recharge', method, A, fee, 'INITIATED', phone ? normPhone(phone) : u.phone, now, now);
    const body = {
      currency: 'XOF', merchant_transaction_id: id, amount: total, lang: 'fr', designation: 'Recharge portefeuille J-WIN',
      client_email: u.email || cfg.cinetpay.fallbackEmail, client_first_name: (u.prenoms || 'Client').padEnd(2, ' '), client_last_name: (u.nom || 'J-WIN').padEnd(2, ' '),
      success_url: `${cfg.publicUrl}/?paiement=ok&id=${id}`, failed_url: `${cfg.publicUrl}/?paiement=echec&id=${id}`, notify_url: `${cfg.publicUrl}/api/payments/webhook`, channel: 'PUSH',
    };
    if (METHOD_CODES[method]) body.payment_method = METHOD_CODES[method];
    try {
      const r = await cinetpay.initPayment(body);
      db.prepare('UPDATE payments SET provider_tx=?, payment_token=?, notify_token=?, payment_url=?, status=?, updated_at=? WHERE id=?').run(r.transaction_id || '', r.payment_token || '', r.notify_token || '', r.payment_url || '', 'PENDING', Date.now(), id);
      res.status(201).json({ id, status: 'PENDING', paymentUrl: r.payment_url, amount: A, fee, total });
    } catch (e) {
      db.prepare('UPDATE payments SET status=?, error=?, updated_at=? WHERE id=?').run('FAILED', e.message.slice(0, 300), Date.now(), id);
      throw e;
    }
  }));

  /** Règle un paiement/retrait à partir du statut réel chez CinetPay (idempotent). */
  async function settle(p) {
    if (['SUCCESS', 'FAILED'].includes(p.status)) return p;
    const isRecharge = p.kind === 'recharge';
    let st;
    try {
      const r = isRecharge ? await cinetpay.paymentStatus(p.id) : await cinetpay.transferStatus(p.provider_tx || p.id);
      st = mapStatus(r.status);
      if (!isRecharge && r.transaction_id) p.provider_tx = r.transaction_id;
    } catch (e) { if (e.apiStatus === 'NOT_FOUND') st = 'PENDING'; else throw e; }
    if (st === 'PENDING') return p;
    tx(db, () => {
      const fresh = db.prepare('SELECT * FROM payments WHERE id=?').get(p.id);
      if (['SUCCESS', 'FAILED'].includes(fresh.status)) return;
      const u = userById(fresh.user_id);
      if (st === 'SUCCESS') {
        if (isRecharge) {
          const inv = issueInvoice(db, cfg, { user: u, paymentId: p.id, kind: 'recharge', label: 'Recharge du portefeuille J-WIN', lines: [{ label: 'Recharge du portefeuille', amount: fresh.amount }, { label: `Frais de service J-WIN (${cfg.fees.recharge} %)`, amount: fresh.fee }], fee: fresh.fee, total: fresh.amount + fresh.fee, method: METHOD_LABEL[fresh.method], providerRef: fresh.provider_tx });
          db.prepare('INSERT INTO ledger(user_id,kind,amount,ref,memo,method,invoice_no,created_at) VALUES(?,?,?,?,?,?,?,?)').run(u.id, 'recharge', fresh.amount, fresh.id, 'Recharge ' + METHOD_LABEL[fresh.method], fresh.method, inv.no, Date.now());
          db.prepare('UPDATE payments SET status=?, invoice_no=?, provider_tx=?, updated_at=? WHERE id=?').run('SUCCESS', inv.no, p.provider_tx || fresh.provider_tx, Date.now(), fresh.id);
        } else {
          const net = fresh.amount - fresh.fee;
          const inv = issueInvoice(db, cfg, { user: u, paymentId: p.id, kind: 'retrait', label: 'Retrait du portefeuille J-WIN', lines: [{ label: 'Montant retiré du portefeuille', amount: fresh.amount }, { label: `Frais de service J-WIN (${cfg.fees.withdraw} %)`, amount: -fresh.fee }, { label: 'Montant versé sur votre compte', amount: net }], fee: fresh.fee, total: net, method: METHOD_LABEL[fresh.method], providerRef: p.provider_tx || fresh.provider_tx });
          db.prepare('UPDATE ledger SET invoice_no=? WHERE kind=? AND ref=?').run(inv.no, 'withdraw', fresh.id);
          db.prepare('UPDATE payments SET status=?, invoice_no=?, provider_tx=?, updated_at=? WHERE id=?').run('SUCCESS', inv.no, p.provider_tx || fresh.provider_tx, Date.now(), fresh.id);
        }
      } else {
        if (!isRecharge) db.prepare('INSERT OR IGNORE INTO ledger(user_id,kind,amount,ref,memo,method,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, 'withdraw_refund', fresh.amount, fresh.id, 'Retrait échoué : remboursement', fresh.method, Date.now());
        db.prepare('UPDATE payments SET status=?, updated_at=? WHERE id=?').run('FAILED', Date.now(), fresh.id);
      }
    });
    return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id);
  }

  const timingEq = (a, b) => { const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || '')); return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B); };
  const webhook = (kind) => wrap(async (req, res) => {
    const b = req.body || {};
    const mid = b.merchant_transaction_id || b.merchantTransactionId;
    const p = mid && db.prepare('SELECT * FROM payments WHERE id=? AND kind=?').get(mid, kind);
    // Jeton de notification comparé en temps constant ; puis statut relu directement chez CinetPay (jamais cru sur parole).
    if (p && timingEq(p.notify_token, b.notify_token || b.notifyToken)) await settle(p);
    res.status(200).send('OK');
  });
  app.post('/api/payments/webhook', webhook('recharge'));
  app.post('/api/payouts/webhook', webhook('withdraw'));

  const pubPayment = (p) => ({ id: p.id, kind: p.kind, method: p.method, amount: p.amount, fee: p.fee, status: p.status, invoiceNo: p.invoice_no || null, paymentUrl: p.status === 'PENDING' ? p.payment_url : undefined, error: p.error || undefined });
  app.get('/api/payments/:id', auth, wrap(async (req, res) => {
    let p = db.prepare('SELECT * FROM payments WHERE id=? AND user_id=?').get(req.params.id, req.uid);
    if (!p) throw bad('Transaction introuvable.', 404);
    if (p.status === 'PENDING') p = await settle(p);
    res.json(pubPayment(p));
  }));

  /* ----- retrait : virement CinetPay vers le mobile money ----- */
  app.post('/api/payouts', auth, limiter(60e3, 10), (req, res, next) => (cfg.paymentMode === 'manual' ? v4.payout(req, res) : next()), wrap(async (req, res) => {
    const { amount, method, phone } = req.body || {};
    const A = Number(amount);
    if (!Number.isInteger(A) || A < cfg.limits.withdrawMin || A > cfg.limits.withdrawMax) throw bad(`Montant entre ${cfg.limits.withdrawMin} et ${cfg.limits.withdrawMax} F.`);
    checkMethod(method, false);
    if (!validPhone(phone)) throw bad('Numéro mobile ivoirien invalide.');
    const u = userById(req.uid);
    if (u.kyc_status !== 'verified' && cfg.prod) throw bad('Vérifiez votre identité avant de retirer des fonds.', 403);
    const fee = pct(A, cfg.fees.withdraw), net = A - fee;
    const id = merchantId('JWW');
    // Réservation atomique du solde AVANT l'appel au fournisseur (empêche le double retrait).
    tx(db, () => {
      if (balanceOf(db, u.id) < A) throw bad('Solde insuffisant.', 402);
      const now = Date.now();
      db.prepare('INSERT INTO payments(id,user_id,kind,method,amount,fee,status,phone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, u.id, 'withdraw', method, A, fee, 'INITIATED', normPhone(phone), now, now);
      db.prepare('INSERT INTO ledger(user_id,kind,amount,ref,memo,method,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, 'withdraw', -A, id, 'Retrait vers ' + METHOD_LABEL[method], method, now);
    });
    try {
      const r = await cinetpay.createTransfer({ currency: 'XOF', merchant_transaction_id: id, phone_number: cpPhone(phone), amount: net, payment_method: METHOD_CODES[method], reason: 'Retrait portefeuille J-WIN', notify_url: `${cfg.publicUrl}/api/payouts/webhook` });
      db.prepare('UPDATE payments SET provider_tx=?, notify_token=?, status=?, updated_at=? WHERE id=?').run(r.transaction_id || '', r.notify_token || '', 'PENDING', Date.now(), id);
    } catch (e) {
      tx(db, () => {
        db.prepare('INSERT OR IGNORE INTO ledger(user_id,kind,amount,ref,memo,method,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, 'withdraw_refund', A, id, 'Retrait refusé : remboursement', method, Date.now());
        db.prepare('UPDATE payments SET status=?, error=?, updated_at=? WHERE id=?').run('FAILED', e.message.slice(0, 300), Date.now(), id);
      });
      throw e;
    }
    let p = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
    p = await settle(p).catch(() => p);
    res.status(201).json({ ...pubPayment(p), fee, net });
  }));

  /* ---------- factures ---------- */
  app.get('/api/invoices', auth, wrap(async (req, res) => {
    const rows = db.prepare('SELECT data FROM invoices WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.uid);
    res.json({ invoices: rows.map((r) => JSON.parse(r.data)) });
  }));
  app.get('/api/invoices/:no', auth, wrap(async (req, res) => {
    const r = db.prepare('SELECT data FROM invoices WHERE no=? AND user_id=?').get(req.params.no, req.uid);
    if (!r) throw bad('Facture introuvable.', 404);
    res.json(JSON.parse(r.data));
  }));

  v4 = registerV4({ app, db, cfg, auth, wrap, bad, limiter, userById, notifier, log, METHOD_LABEL, pct, normPhone, validPhone, merchantId });

  /* ---------- site statique (optionnel) : dossier ./public ---------- */
  const pub = path.join(here, 'public');
  if (fs.existsSync(path.join(pub, 'index.html'))) app.use(express.static(pub));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  return app;
}
