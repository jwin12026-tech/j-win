// Console d'administration : statistiques, utilisateurs, missions, paiements, réglages, exports CSV, sauvegarde, audit.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { uid, balanceOf } from './db.js';

const SETTINGS = {
  'fees.recharge': 'int', 'fees.withdraw': 'int', 'fees.mission': 'int', 'plan.create': 'int', 'plan.do': 'int', 'plan.unverified': 'int',
  'limits.rechargeMin': 'int', 'limits.withdrawMin': 'int', adminOm: 'str', adminPhone: 'str', adminEmail: 'str',
  kycMode: ['auto', 'manual'], paymentMode: ['manual', 'cinetpay'], banner: 'str', maintenance: 'bool', 'company.contact': 'str',
};
const setPath = (o, p, v) => { const k = p.split('.'); let t = o; while (k.length > 1) t = t[k.shift()] ??= {}; t[k[0]] = v; };
const getPath = (o, p) => p.split('.').reduce((t, k) => t?.[k], o);
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '');

export function registerAdmin({ app, db, cfg, wrap, bad, limiter, userById, notifier, log, express, getV4, dir }) {
  const audit = (action, target = '', detail = '') => {
    try { db.prepare('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)').run(Date.now(), 'admin', action, String(target), typeof detail === 'string' ? detail : JSON.stringify(detail)); }
    catch (e) { log('[audit] écriture impossible :', e.message); }   // le journal ne doit jamais empêcher de se connecter
  };
  const dbWritable = () => { try { db.exec('CREATE TABLE IF NOT EXISTS _probe(x)'); db.exec('DROP TABLE _probe'); return true; } catch (e) { return e.message; } };

  /* ----- réglages : la base prime sur les variables d'environnement ----- */
  const applySettings = () => { for (const r of db.prepare('SELECT * FROM settings').all()) if (r.key in SETTINGS) setPath(cfg, r.key, JSON.parse(r.value)); };
  applySettings();

  /* ----- maintenance (les routes /admin, /health, /config restent ouvertes) ----- */
  app.use('/api', (req, res, next) => (cfg.maintenance && !/^\/(admin|health|config)/.test(req.path) ? res.status(503).json({ error: 'J-WIN est en maintenance. Réessayez dans un instant.' }) : next()));

  /* ----- authentification administrateur ----- */
  const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
  /* identifiants : par défaut J-WIN / 1234 (ou ADMIN_USER / ADMIN_PASSWORD), modifiables ensuite depuis la console */
  const kvGet = (k) => { const x = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return x ? JSON.parse(x.value) : null; };
  const kvSet = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
  if (process.env.ADMIN_RESET_CREDENTIALS === '1') db.prepare("DELETE FROM settings WHERE key IN ('admin.user','admin.hash')").run();   // secours : oubli du mot de passe
  const creds = () => { const u = kvGet('admin.user'), h = kvGet('admin.hash'); return u && h ? { user: u, hash: h, custom: true } : { user: process.env.ADMIN_USER || 'J-WIN', plain: cfg.adminPassword || '1234', custom: false }; };
  const isDefault = () => !creds().custom && !cfg.adminPassword;
  const checkPw = (c, pw) => (c.custom ? bcrypt.compareSync(String(pw), c.hash) : safeEq(pw, c.plain));
  app.get('/api/admin/status', (req, res) => res.json({ enabled: true, version: 'v6-admin', dbWritable: dbWritable() === true }));
  app.post('/api/admin/login', limiter(60e3, 8), wrap(async (req, res) => {
    const c = creds(), okUser = String(req.body?.user || '').trim().toLowerCase() === c.user.toLowerCase(), okPw = checkPw(c, req.body?.password || '');
    if (!(okUser && okPw)) { audit('login_echec', req.ip); throw bad('Nom d\'utilisateur ou mot de passe incorrect.', 401); }
    audit('login', req.ip);
    res.json({ token: jwt.sign({ sub: 'admin' }, cfg.jwtSecret, { expiresIn: '8h', audience: 'admin-session' }) });
  }));
  const A = (req, res, next) => { try { jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), cfg.jwtSecret, { audience: 'admin-session' }); next(); } catch { res.status(401).json({ error: 'Session administrateur expirée.' }); } };
  const r = express.Router(); r.use(A, limiter(60e3, 240));
  /* tant que le mot de passe par défaut est en place : pas d'accès aux données sensibles ni aux opérations d'argent */
  const S = (req, res, next) => (isDefault() ? res.status(403).json({ error: 'Par sécurité, changez d\'abord le mot de passe par défaut : Réglages du site > Accès administrateur.' }) : next());
  r.post(['/users/:id/adjust', '/users/:id/reset-password', '/users/:id/kyc', '/payments/:id/approve', '/payments/:id/reject', '/broadcast', '/system/test-sms'], S);
  r.get(['/kyc/:id/:which', '/export/:name', '/backup'], S);
  r.put('/settings', S);
  r.post('/credentials', wrap(async (req, res) => {
    const c = creds(), b = req.body || {}, user = String(b.user || '').trim(), pw = String(b.password || '');
    if (!checkPw(c, b.current || '')) throw bad('Mot de passe actuel incorrect.', 401);
    if (!/^[\w.\- ]{3,40}$/.test(user)) throw bad('Nom d\'utilisateur : 3 à 40 caractères (lettres, chiffres, point, tiret).');
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw bad('Nouveau mot de passe : 8 caractères minimum, avec au moins une lettre et un chiffre.');
    kvSet('admin.user', user); kvSet('admin.hash', bcrypt.hashSync(pw, 11)); audit('admin_credentials', user);
    res.json({ ok: true });
  }));
  app.use('/api/admin', r);
  const get = (p, fn) => r.get(p, wrap(async (req, res) => res.json(await fn(req))));
  const post = (p, fn) => r.post(p, wrap(async (req, res) => res.json({ ok: true, ...(await fn(req)) })));
  const one = (sql, ...a) => db.prepare(sql).get(...a), all = (sql, ...a) => db.prepare(sql).all(...a);
  const like = (q) => `%${String(q || '').trim().replace(/[%_]/g, '')}%`;

  /* ----- tableau de bord ----- */
  get('/stats', () => {
    const defaultCreds = isDefault();
    const now = Date.now(), d7 = now - 7 * 864e5, d30 = now - 30 * 864e5;
    const fees = one("SELECT COALESCE(SUM(fee),0) s FROM payments WHERE status='SUCCESS'").s + (one("SELECT COALESCE(SUM(-amount),0) s FROM ledger WHERE kind='mission_pay'").s - one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kind='mission_win'").s);
    const day = (t) => new Date(t).toISOString().slice(0, 10), days = Array.from({ length: 30 }, (_, i) => day(now - (29 - i) * 864e5));
    const bucket = (rows, f) => { const m = Object.fromEntries(days.map((x) => [x, 0])); rows.forEach((x) => { const k = day(x.t); if (k in m) m[k] += f(x); }); return days.map((k) => ({ day: k, v: m[k] })); };
    return {
      defaultCreds,
      users: { total: one('SELECT COUNT(*) c FROM users').c, verified: one("SELECT COUNT(*) c FROM users WHERE kyc_status='verified'").c, kycPending: one("SELECT COUNT(*) c FROM users WHERE kyc_status='pending'").c, suspended: one("SELECT COUNT(*) c FROM users WHERE status='suspended'").c, new7: one('SELECT COUNT(*) c FROM users WHERE created_at>=?', d7).c, new30: one('SELECT COUNT(*) c FROM users WHERE created_at>=?', d30).c },
      missions: { pending: one("SELECT COUNT(*) c FROM missions WHERE mod='pending' AND status!='annulee'").c, open: one("SELECT COUNT(*) c FROM missions WHERE mod='approved' AND status='attente'").c, inProgress: one("SELECT COUNT(*) c FROM missions WHERE status IN ('cours','terminee')").c, paid: one("SELECT COUNT(*) c FROM missions WHERE status='payee'").c, rejected: one("SELECT COUNT(*) c FROM missions WHERE mod='rejetee'").c, volume: one("SELECT COALESCE(SUM(amount),0) s FROM missions WHERE status='payee'").s },
      queue: { missions: one("SELECT COUNT(*) c FROM missions WHERE mod='pending' AND status!='annulee'").c, deposits: one("SELECT COUNT(*) c FROM payments WHERE kind='recharge' AND status='PENDING_ADMIN'").c, withdrawals: one("SELECT COUNT(*) c FROM payments WHERE kind='withdraw' AND status='PENDING_ADMIN'").c, kyc: one("SELECT COUNT(*) c FROM users WHERE kyc_status='pending'").c },
      money: { walletTotal: one('SELECT COALESCE(SUM(amount),0) s FROM ledger').s, deposited: one("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE kind='recharge' AND status='SUCCESS'").s, withdrawn: one("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE kind='withdraw' AND status='SUCCESS'").s, withdrawPending: one("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE kind='withdraw' AND status='PENDING_ADMIN'").s, fees },
      signups: bucket(all('SELECT created_at t FROM users WHERE created_at>=?', d30), () => 1),
      volume: bucket(all("SELECT created_at t, -amount a FROM ledger WHERE kind='mission_pay' AND created_at>=?", d30), (x) => x.a),
    };
  });

  /* ----- utilisateurs ----- */
  const pubUser = (u) => { const { pw_hash, ...x } = u; return { ...x, balance: balanceOf(db, u.id) }; };
  get('/users', (req) => {
    const q = req.query, w = ['1=1'], a = [];
    if (q.q) { w.push('(nom LIKE ? OR prenoms LIKE ? OR phone LIKE ? OR email LIKE ? OR id LIKE ?)'); a.push(...Array(5).fill(like(q.q))); }
    if (q.status === 'suspended') w.push("status='suspended'"); if (['none', 'pending', 'verified', 'rejected'].includes(q.kyc)) { w.push('kyc_status=?'); a.push(q.kyc); }
    const limit = Math.min(Number(q.limit) || 50, 200), off = (Math.max(Number(q.page) || 1, 1) - 1) * limit;
    const total = one(`SELECT COUNT(*) c FROM users WHERE ${w.join(' AND ')}`, ...a).c;
    const rows = all(`SELECT * FROM users WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...a, limit, off).map((u) => ({ ...pubUser(u), created: one('SELECT COUNT(*) c FROM missions WHERE creator_id=?', u.id).c, done: one("SELECT COUNT(*) c FROM missions WHERE executor_id=? AND status='payee'", u.id).c }));
    return { total, rows };
  });
  get('/users/:id', (req) => {
    const u = userById(req.params.id); if (!u) throw bad('Utilisateur introuvable.', 404);
    const kd = one('SELECT type,ocr,submitted_at,front IS NOT NULL f,back IS NOT NULL b,selfie IS NOT NULL s FROM kyc_docs WHERE user_id=?', u.id);
    return { user: pubUser(u), kyc: kd ? { ...kd, ocr: JSON.parse(kd.ocr || '{}') } : null, ledger: all('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100', u.id), missions: all('SELECT id,title,amount,status,mod,creator_id,executor_id,created_at FROM missions WHERE creator_id=? OR executor_id=? ORDER BY created_at DESC LIMIT 50', u.id, u.id), payments: all('SELECT id,kind,method,amount,fee,status,ref,created_at FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT 50', u.id) };
  });
  const target = (req) => { const u = userById(req.params.id); if (!u) throw bad('Utilisateur introuvable.', 404); return u; };
  post('/users/:id/status', (req) => { const u = target(req), s = req.body?.status === 'suspended' ? 'suspended' : 'active'; db.prepare('UPDATE users SET status=? WHERE id=?').run(s, u.id); audit('user_status', u.id, { status: s, reason: req.body?.reason || '' }); if (s === 'suspended') notifier.toUser(u, 'Compte suspendu', 'Votre compte J-WIN a été suspendu. Contactez le support pour en savoir plus.').catch(() => {}); return { status: s }; });
  post('/users/:id/kyc', (req) => { const u = target(req), s = ['verified', 'rejected', 'pending'].includes(req.body?.status) ? req.body.status : null; if (!s) throw bad('Statut invalide.'); db.prepare('UPDATE users SET kyc_status=? WHERE id=?').run(s, u.id); audit('user_kyc', u.id, { status: s }); if (s !== 'pending') notifier.toUser(u, s === 'verified' ? 'Identité vérifiée' : 'Vérification refusée', s === 'verified' ? 'Votre identité est vérifiée.' : 'Votre vérification d\'identité a été refusée. Contactez le support.').catch(() => {}); return { kyc: s }; });
  post('/users/:id/adjust', (req) => {
    const u = target(req), amt = Number(req.body?.amount), memo = String(req.body?.memo || '').trim().slice(0, 120);
    if (!Number.isInteger(amt) || !amt || Math.abs(amt) > 5e6) throw bad('Montant invalide (entier non nul).');
    if (memo.length < 3) throw bad('Indiquez le motif de l\'ajustement.');
    if (balanceOf(db, u.id) + amt < 0) throw bad('Le solde deviendrait négatif.', 409);
    db.prepare('INSERT INTO ledger(user_id,kind,amount,ref,memo,method,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, 'admin_adjust', amt, uid('adj_'), `Ajustement : ${memo}`, 'admin', Date.now());
    audit('wallet_adjust', u.id, { amount: amt, memo });
    notifier.toUser(u, 'Ajustement de votre portefeuille', `${amt > 0 ? 'Crédit' : 'Débit'} de ${Math.abs(amt)} F sur votre portefeuille J-WIN : ${memo}.`).catch(() => {});
    return { balance: balanceOf(db, u.id) };
  });
  post('/users/:id/reset-password', (req) => {
    const u = target(req), c = 'abcdefghjkmnpqrstuvwxyz', n = () => c[crypto.randomInt(c.length)], temp = n() + n() + n() + n() + n() + n() + String(crypto.randomInt(1000, 9999)) + n();
    db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 11), u.id); audit('user_reset_password', u.id);
    return { temporaryPassword: temp };
  });

  const kycDir = path.join(path.dirname(path.resolve(cfg.uploadDir)), 'kyc');
  r.get('/kyc/:id/:which', wrap(async (req, res) => {
    if (!['front', 'back', 'selfie'].includes(req.params.which)) throw bad('Fichier inconnu.', 404);
    const d = one('SELECT * FROM kyc_docs WHERE user_id=?', req.params.id), f = d?.[req.params.which]; if (!f) throw bad('Aucun fichier.', 404);
    audit('kyc_view', req.params.id, req.params.which); res.set('Cache-Control', 'no-store'); res.sendFile(path.join(kycDir, f));
  }));

  /* ----- missions ----- */
  get('/missions', (req) => {
    const q = req.query, w = ['1=1'], a = [];
    if (['pending', 'approved', 'rejetee'].includes(q.mod)) { w.push('m.mod=?'); a.push(q.mod); }
    if (['attente', 'cours', 'terminee', 'payee', 'annulee'].includes(q.status)) { w.push('m.status=?'); a.push(q.status); }
    if (q.q) { w.push('(m.title LIKE ? OR m.id LIKE ? OR m.city LIKE ?)'); a.push(...Array(3).fill(like(q.q))); }
    return { rows: all(`SELECT m.id,m.title,m.descr,m.cat,m.mode,m.city,m.place,m.amount,m.win,m.mod,m.mod_note,m.status,m.created_at,m.images,m.audio,(u.prenoms||' '||u.nom) creator,u.phone creator_phone,(e.prenoms||' '||e.nom) executor FROM missions m LEFT JOIN users u ON u.id=m.creator_id LEFT JOIN users e ON e.id=m.executor_id WHERE ${w.join(' AND ')} ORDER BY m.created_at DESC LIMIT 300`, ...a).map((m) => ({ ...m, images: JSON.parse(m.images || '[]').map((i) => '/media/' + i), audio: m.audio ? '/media/' + m.audio : null })) };
  });
  const decideOn = (type, id, ok, note) => {
    const v4 = getV4(), p = { t: type, id }, d = v4.describe(p);
    if (!d) throw bad('Élément introuvable.', 404); if (d.done) throw bad('Déjà traité.', 409);
    v4.decide(p, ok, String(note || '').slice(0, 200)); audit(`${type}_${ok ? 'approve' : 'reject'}`, id, note || '');
  };
  post('/missions/:id/approve', (req) => { decideOn('mission', req.params.id, true); return {}; });
  post('/missions/:id/reject', (req) => { decideOn('mission', req.params.id, false, req.body?.note); return {}; });
  post('/missions/:id/cancel', (req) => {
    const m = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id); if (!m) throw bad('Mission introuvable.', 404);
    if (['payee', 'annulee'].includes(m.status)) throw bad('Mission déjà clôturée.', 409);
    db.prepare("UPDATE missions SET status='annulee', mod_note=? WHERE id=?").run(String(req.body?.note || 'Annulée par l\'administrateur').slice(0, 200), m.id); audit('mission_cancel', m.id);
    for (const uid_ of [m.creator_id, m.executor_id].filter(Boolean)) notifier.toUser(userById(uid_), `Mission annulée ${m.id}`, `La mission « ${m.title} » a été annulée par l'administrateur.`).catch(() => {});
    return {};
  });

  /* ----- paiements (dépôts / retraits) et transactions ----- */
  get('/payments', (req) => {
    const q = req.query, w = ["p.status!='AWAITING'"], a = [];
    if (['recharge', 'withdraw'].includes(q.kind)) { w.push('p.kind=?'); a.push(q.kind); }
    if (q.status) { w.push('p.status=?'); a.push(q.status); }
    return { rows: all(`SELECT p.*, (u.prenoms||' '||u.nom) name, u.phone uphone FROM payments p LEFT JOIN users u ON u.id=p.user_id WHERE ${w.join(' AND ')} ORDER BY p.created_at DESC LIMIT 300`, ...a) };
  });
  post('/payments/:id/approve', (req) => { const p = one('SELECT kind FROM payments WHERE id=?', req.params.id); decideOn(p?.kind === 'withdraw' ? 'withdraw' : 'deposit', req.params.id, true); return {}; });
  post('/payments/:id/reject', (req) => { const p = one('SELECT kind FROM payments WHERE id=?', req.params.id); decideOn(p?.kind === 'withdraw' ? 'withdraw' : 'deposit', req.params.id, false, req.body?.note); return {}; });
  get('/ledger', (req) => ({ rows: all("SELECT l.*, (u.prenoms||' '||u.nom) name FROM ledger l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT ?", Math.min(Number(req.query.limit) || 200, 1000)) }));
  get('/invoices', () => ({ rows: all('SELECT no,user_id,payment_id,created_at,data FROM invoices ORDER BY created_at DESC LIMIT 300').map((i) => { const d = JSON.parse(i.data); return { no: i.no, at: i.created_at, kind: d.kind, label: d.label, total: d.total, fee: d.fee, customer: d.customer?.name }; }) }));
  get('/audit', () => ({ rows: all('SELECT * FROM audit ORDER BY id DESC LIMIT 300') }));

  /* ----- réglages du site ----- */
  get('/settings', () => ({ values: Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, getPath(cfg, k) ?? ''])), spec: SETTINGS }));
  r.put('/settings', wrap(async (req, res) => {
    const b = req.body || {}, saved = {};
    for (const [k, v0] of Object.entries(b)) {
      const t = SETTINGS[k]; if (!t) continue; let v = v0;
      if (t === 'int' && (v === '' || v === null || v === undefined)) continue;
      if (t === 'int') { v = Number(v); if (!Number.isInteger(v) || v < 0 || v > 1e9) throw bad(`Valeur invalide pour ${k}.`); }
      else if (t === 'bool') v = v === true || v === 'true';
      else if (Array.isArray(t)) { if (!t.includes(v)) throw bad(`Valeur invalide pour ${k}.`); }
      else v = String(v ?? '').slice(0, 300);
      if (k.startsWith('fees.') && v > 50) throw bad('Frais : 50 % maximum.');
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v)); saved[k] = v;
    }
    applySettings(); audit('settings', '', saved); res.json({ ok: true, saved });
  }));
  post('/broadcast', (req) => {
    const subject = String(req.body?.subject || '').trim().slice(0, 120), text = String(req.body?.text || '').trim().slice(0, 2000);
    if (subject.length < 3 || text.length < 10) throw bad('Objet et message requis.');
    const users = all("SELECT * FROM users WHERE status!='suspended' AND email IS NOT NULL AND email!=''"); audit('broadcast', users.length, subject);
    (async () => { for (const u of users) { await notifier.email(u.email, subject, text); } })().catch(() => {});
    return { recipients: users.length };
  });

  /* ----- exports CSV (ouverts directement par Excel) ----- */
  const EXPORTS = {
    users: { sql: 'SELECT id,nom,prenoms,phone,email,provider,dob,adresse,kyc_status,kyc_doc_type,kyc_doc_last4,status,created_at FROM users ORDER BY created_at', dates: ['created_at'], col: 'created_at' },
    missions: { sql: 'SELECT id,title,cat,mode,city,place,amount,win,mod,status,creator_id,executor_id,created_at,accepted_at,finished_at,done_at,rating FROM missions ORDER BY created_at', dates: ['created_at', 'accepted_at', 'finished_at', 'done_at'], col: 'created_at' },
    ledger: { sql: 'SELECT id,user_id,kind,amount,ref,memo,method,invoice_no,created_at FROM ledger ORDER BY id', dates: ['created_at'], col: 'created_at' },
    payments: { sql: 'SELECT id,user_id,kind,method,amount,fee,status,phone,ref,tx_id,invoice_no,error,created_at,updated_at FROM payments ORDER BY created_at', dates: ['created_at', 'updated_at'], col: 'created_at' },
    invoices: { sql: 'SELECT no,user_id,payment_id,data,created_at FROM invoices ORDER BY created_at', dates: ['created_at'], col: 'created_at', map: (x) => { const d = JSON.parse(x.data); return { no: x.no, date: x.created_at, client: d.customer?.name, contact: d.customer?.contact, type: d.kind, libelle: d.label, moyen: d.method, frais: d.fee, total: d.total, statut: d.status }; } },
    audit: { sql: 'SELECT id,at,actor,action,target,detail FROM audit ORDER BY id', dates: ['at'], col: 'at' },
  };
  r.get('/export/:name', wrap(async (req, res) => {
    const e = EXPORTS[req.params.name]; if (!e) throw bad('Export inconnu.', 404);
    const from = req.query.from ? Date.parse(req.query.from) : 0, to = req.query.to ? Date.parse(req.query.to) + 864e5 : Infinity;
    let rows = all(e.sql).filter((x) => x[e.col] >= from && x[e.col] < to).map((x) => (e.map ? e.map(x) : x));
    if (e.map) rows = rows.map((x) => ({ ...x, date: iso(x.date) }));
    const cols = rows[0] ? Object.keys(rows[0]) : Object.keys(all(e.sql + ' LIMIT 0').length ? {} : {});
    const head = cols.length ? cols : (e.sql.match(/SELECT (.*?) FROM/)[1].split(','));
    const line = (x) => head.map((c) => csvCell(e.dates.includes(c) ? iso(x[c]) : x[c])).join(';');
    audit('export', req.params.name, `${rows.length} lignes`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="jwin-${req.params.name}-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send('\ufeff' + [head.join(';'), ...rows.map(line)].join('\r\n'));
  }));
  r.get('/backup', wrap(async (req, res) => {
    const f = path.join(os.tmpdir(), `jwin-backup-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); audit('backup');
    res.download(f, `jwin-sauvegarde-${new Date().toISOString().slice(0, 10)}.db`, () => fs.rm(f, () => {}));
  }));

  /* ----- système ----- */
  get('/system', () => {
    let dbSize = 0, upN = 0, upSize = 0;
    try { if (cfg.dbFile !== ':memory:') dbSize = fs.statSync(cfg.dbFile).size; } catch { /* */ }
    try { for (const f of fs.readdirSync(path.resolve(cfg.uploadDir))) { upN++; upSize += fs.statSync(path.join(path.resolve(cfg.uploadDir), f)).size; } } catch { /* */ }
    return { node: process.version, uptimeH: Math.round(process.uptime() / 36) / 100, publicUrl: cfg.publicUrl, dbSize, uploads: { n: upN, size: upSize }, smtp: !!cfg.smtp.host || !!cfg.smtp.json, smtpUser: cfg.smtp.user, dbWritable: dbWritable(), sms: cfg.otp.mode === 'twilio' ? 'Twilio' : 'console (aucun envoi)', ocr: cfg.ocrEnabled, paymentMode: cfg.paymentMode, kycMode: cfg.kycMode, prod: cfg.prod, maintenance: cfg.maintenance, adminEmail: cfg.adminEmail };
  });
  post('/system/test-email', async (req) => { const to = String(req.body?.to || cfg.adminEmail); const ok = await notifier.email(to, 'J-WIN : test d\'envoi', 'Si vous lisez ce message, l\'envoi d\'e-mails fonctionne.'); audit('test_email', to, ok ? 'ok' : 'échec'); return { sent: ok, to }; });
  post('/system/test-sms', async (req) => { const ph = String(req.body?.phone || cfg.adminPhone); const ok = await notifier.sms(ph, 'J-WIN : test d\'envoi de SMS.'); audit('test_sms', ph, ok ? 'ok' : 'échec'); return { sent: ok, to: ph }; });

  /* ----- page /admin ----- */
  app.get('/admin', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(dir, 'public', 'admin.html')); });
}
