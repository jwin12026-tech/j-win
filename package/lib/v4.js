// Missions (avec photos et vocal), approbation par l'administrateur, dépôts Orange Money et retraits validés à la main.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { uid, tx, balanceOf } from './db.js';
import { issueInvoice } from './invoices.js';
import { actionUrl, readAction, adminMailHtml } from './notify.js';

const CATS = ['livraison', 'visite', 'reparation', 'nettoyage', 'vente', 'cuisine', 'construction', 'demenagement', 'photo', 'enligne'];
const tier = (a) => (a <= 10000 ? 1 : a <= 50000 ? 2 : 3);
const F = (n) => new Intl.NumberFormat('fr-FR').format(n).replace(/[\u202f\u00a0]/g, ' ') + ' F';
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const code5 = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += c[crypto.randomInt(c.length)]; return s; };
const num = (v) => (v === undefined || v === '' || v === null ? null : Number(v));
const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on';

export function registerV4({ app, db, cfg, auth, wrap, bad, limiter, userById, notifier, log, METHOD_LABEL, pct, normPhone, validPhone, merchantId }) {
  const v4 = {};
  const feeMission = cfg.fees.mission ?? 1;
  const first = (u) => (u.prenoms || '').split(' ')[0];
  const who = (u) => (u ? `${first(u)} ${(u.nom || '').slice(0, 1)}.`.trim() : '');
  const fire = (p) => Promise.resolve(p).catch((e) => log('[notif]', e.message));
  const link = (payload) => actionUrl(cfg, payload);

  /* ---------- fichiers (photos, vocal) ---------- */
  const dir = path.resolve(cfg.uploadDir);
  fs.mkdirSync(dir, { recursive: true });
  const IMG = /^image\/(jpeg|png|webp)$/, AUD = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|x-m4a|aac)(;.*)?$/;
  const upload = multer({
    storage: multer.diskStorage({ destination: dir, filename: (r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex')) }),
    limits: { fileSize: 8 * 1024 * 1024, files: 5 },
    fileFilter: (r, f, cb) => cb(null, f.fieldname === 'audio' ? AUD.test(f.mimetype) : f.fieldname === 'images' && IMG.test(f.mimetype)),
  });
  const saveMedia = (f, owner) => { const id = uid('m_'); db.prepare('INSERT INTO media(id,mime,file,owner_id,created_at) VALUES(?,?,?,?,?)').run(id, f.mimetype.split(';')[0], f.filename, owner, Date.now()); return id; };
  app.get('/media/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
    if (!m) return res.status(404).end();
    res.set({ 'Content-Type': m.mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.join(dir, m.file));
  });

  /* ---------- notifications internes + e-mail/SMS ---------- */
  const q1 = (sql, ...a) => db.prepare(sql).get(...a), qa = (sql, ...a) => db.prepare(sql).all(...a);
  const push = (userId, title, text, missionId = null, type = 'bell') => db.prepare('INSERT INTO notifs(user_id,type,title,text,mission_id,read,created_at) VALUES(?,?,?,?,?,0,?)').run(userId, type, title, text, missionId, Date.now());
  const tellUser = (u, subject, text, missionId, type) => { if (!u) return; try { push(u.id, subject, text, missionId, type); } catch (e) { log('[notif]', e.message); } fire(notifier.toUser(u, subject, text)); };
  v4.tell = tellUser;

  /* ---------- notes et profils ---------- */
  const fullName = (u) => `${u.prenoms} ${u.nom}`.trim();
  const ratingAs = (id, role) => { const col = role === 'exec' ? 'exec_rating' : 'rating', who_ = role === 'exec' ? 'executor_id' : 'creator_id'; const r = q1(`SELECT AVG(${col}) a, COUNT(${col}) n FROM missions WHERE ${who_}=? AND ${col} IS NOT NULL`, id); return { avg: r.a ? Math.round(r.a * 10) / 10 : null, n: r.n }; };
  const profileCard = (u, role) => { const r = ratingAs(u.id, role); return { id: u.id, name: fullName(u), prenoms: u.prenoms, nom: u.nom, rating: r.avg, reviews: r.n, done: q1("SELECT COUNT(*) c FROM missions WHERE executor_id=? AND status='payee'", u.id).c, verified: u.kyc_status === 'verified' }; };
  v4.profileCard = profileCard;

  /* ---------- sérialisation ---------- */
  const avg = (id) => ratingAs(id, 'creator').avg;
  const media = (id) => '/media/' + id;
  const cands = (mid) => qa("SELECT user_id,note,created_at FROM applications WHERE mission_id=? AND status='pending' ORDER BY created_at", mid).map((a) => ({ ...profileCard(userById(a.user_id), 'exec'), userId: a.user_id, message: a.note || '', at: a.created_at }));
  const front = (m, viewer) => {
    const creator = userById(m.creator_id), exec = m.executor_id ? userById(m.executor_id) : null;
    const myApp = viewer && m.creator_id !== viewer && m.executor_id !== viewer ? q1('SELECT * FROM applications WHERE mission_id=? AND user_id=?', m.id, viewer) : null;
    const role = m.creator_id === viewer ? 'donneur' : m.executor_id === viewer ? 'real' : (myApp && ['pending', 'declined'].includes(myApp.status) ? 'real' : undefined);
    const status = role === 'real' && m.executor_id !== viewer ? (myApp.status === 'pending' ? 'candidature' : 'refusee') : m.status;
    const o = {
      id: m.id, title: m.title, desc: m.descr, cat: m.cat, mode: m.mode, city: m.city, place: m.place || '', lat: m.lat, lng: m.lng,
      amount: m.amount, win: m.win, open: !!m.open, askLoc: !!m.ask_loc, dl: m.dl || 0, req: [],
      images: JSON.parse(m.images || '[]').map(media), audio: m.audio ? media(m.audio) : null,
      mod: m.mod, modNote: m.mod_note || '', status, role, by: who(creator), rating: avg(m.creator_id), creatorId: m.creator_id,
      realisateur: exec && role === 'donneur' ? fullName(exec) : undefined, createdAt: m.created_at, acceptedAt: m.accepted_at, finishedAt: m.finished_at, doneAt: m.done_at,
      myApp: myApp?.status, applicants: role === 'donneur' && m.status === 'attente' ? q1("SELECT COUNT(*) c FROM applications WHERE mission_id=? AND status='pending'", m.id).c : undefined,
    };
    if (role === 'donneur' && m.status === 'attente' && m.mod === 'approved') o.candidates = cands(m.id);
    if (role === 'donneur' && exec) o.counterpart = { ...profileCard(exec, 'exec'), phone: exec.phone || '' };
    else if (role === 'real' && creator) o.counterpart = m.executor_id === viewer ? { ...profileCard(creator, 'creator'), phone: creator.phone || '' } : profileCard(creator, 'creator');
    if (role) {
      const p = m.proof ? JSON.parse(m.proof) : null;
      o.proof = p ? { text: p.text || '', link: p.link || '', images: (p.images || []).map(media), audio: p.audio ? media(p.audio) : null, at: m.proof_at } : null;
      o.proofNote = m.proof_note || ''; o.execRating = m.exec_rating || 0; o.execReview = m.exec_review || ''; o.review = m.review || '';
      o.myRating = role === 'real' ? m.rating || 0 : undefined;
    }
    return o;
  };
  const mission = (id) => q1('SELECT * FROM missions WHERE id=?', id);
  const getM = (id) => { const m = mission(id); if (!m) throw bad('Mission introuvable.', 404); return m; };

  /* ---------- alertes administrateur ---------- */
  const alertAdmin = (subject, lines, actions) => fire(notifier.toAdmin(`J-WIN : ${subject}`, [...lines, '', ...actions.map((a) => `${a.label} : ${a.url}`)].join('\n'), adminMailHtml(cfg, subject, lines, actions), actions[0]?.url));

  /* ---------- vérification d'identité manuelle (KYC_MODE=manual) ---------- */
  v4.kycAlert = (u, type, last3) => alertAdmin(`identité à vérifier ${who(u)}`, [`Nom : ${u.prenoms} ${u.nom}`, `Né(e) le : ${u.dob}`, `Pièce : ${type || '?'} (fin ${last3 || '???'})`, `Téléphone : ${u.phone || ''} · E-mail : ${u.email || ''}`, `Adresse : ${u.adresse || ''}`],
    [{ label: 'Valider l\'identité', url: link({ t: 'kyc', id: u.id, a: 'approve' }), color: '#16a34a' }, { label: 'Refuser', url: link({ t: 'kyc', id: u.id, a: 'reject' }), color: '#dc2626' }]);

  /* ---------- vérification d'identité (depuis les paramètres de l'utilisateur) ---------- */
  const kycDir = path.join(path.dirname(dir), 'kyc'); fs.mkdirSync(kycDir, { recursive: true });
  const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  const kycUpload = multer({ storage: multer.diskStorage({ destination: kycDir, filename: (r, f, cb) => cb(null, crypto.randomBytes(14).toString('hex') + (EXT[f.mimetype] || '.jpg')) }), limits: { fileSize: 12 * 1024 * 1024, files: 3 }, fileFilter: (r, f, cb) => cb(null, IMG.test(f.mimetype)) });
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/gi, '').toLowerCase();
  app.post('/api/kyc/submit', auth, limiter(60e3, 5), kycUpload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]), wrap(async (req, res) => {
    const u = userById(req.uid), b = req.body || {}, f = req.files || {}, type = b.type === 'passeport' ? 'passeport' : 'cni', num = String(b.number || '').replace(/\s/g, '').toUpperCase();
    const drop = () => Object.values(f).flat().forEach((x) => fs.rm(x.path, () => {}));
    try {
      if (u.kyc_status === 'verified') throw bad('Votre identité est déjà vérifiée.', 409);
      if (u.kyc_status === 'pending') throw bad('Votre vérification est déjà en cours d\'examen.', 409);
      if (!(type === 'cni' ? /^([0-9]{11}|[A-Z]\d{10})$/.test(num) : /^[A-Z0-9]{6,9}$/.test(num))) throw bad('Numéro de pièce invalide.');
      if (!f.front?.[0] || !f.selfie?.[0] || (type === 'cni' && !f.back?.[0])) throw bad('Photos manquantes : recto, verso (carte) et selfie sont requis.');
    } catch (e) { drop(); throw e; }
    const old = db.prepare('SELECT * FROM kyc_docs WHERE user_id=?').get(u.id);
    if (old) for (const k of ['front', 'back', 'selfie']) if (old[k]) fs.rm(path.join(kycDir, old[k]), () => {});
    const ocr = { nom: b.ocrNom || '', prenoms: b.ocrPrenoms || '', dob: b.ocrDob || '', confidence: b.ocrConfidence || '' };
    db.prepare('INSERT INTO kyc_docs(user_id,type,front,back,selfie,ocr,submitted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET type=excluded.type,front=excluded.front,back=excluded.back,selfie=excluded.selfie,ocr=excluded.ocr,submitted_at=excluded.submitted_at').run(u.id, type, f.front[0].filename, f.back?.[0]?.filename || null, f.selfie[0].filename, JSON.stringify(ocr), Date.now());
    const auto = cfg.kycMode === 'auto', status = auto ? 'verified' : 'pending';
    db.prepare('UPDATE users SET kyc_status=?, kyc_doc_type=?, kyc_doc_last4=? WHERE id=?').run(status, type, num.slice(-3), u.id);
    if (!auto) {
      const match = ocr.nom ? (norm(ocr.nom) === norm(u.nom) ? 'le nom lu sur la pièce correspond au compte' : `ATTENTION : nom lu « ${ocr.nom} » ≠ compte « ${u.nom} »`) : 'pièce non lue automatiquement';
      alertAdmin(`identité à vérifier ${who(u)}`, [`Compte : ${u.prenoms} ${u.nom} · né(e) le ${u.dob}`, `Pièce : ${type} (fin ${num.slice(-3)}) · ${match}`, `Contact : ${u.phone || ''} ${u.email || ''}`, `Regardez les photos (pièce + selfie) dans la console : ${cfg.publicUrl}/admin > Utilisateurs > ${u.nom}`],
        [{ label: 'Valider l\'identité', url: link({ t: 'kyc', id: u.id, a: 'approve' }), color: '#16a34a' }, { label: 'Refuser', url: link({ t: 'kyc', id: u.id, a: 'reject' }), color: '#dc2626' }]);
    }
    tellUser(u, auto ? 'Identité vérifiée' : 'Vérification reçue', auto ? 'Votre identité est vérifiée : les limites sont levées.' : 'Nous avons bien reçu votre pièce d\'identité et votre selfie. Vous serez prévenu dès la fin du contrôle.');
    res.json({ ok: true, status });
  }));

  /* ---------- missions ---------- */
  app.post('/api/missions', auth, limiter(60e3, 12), upload.fields([{ name: 'images', maxCount: 4 }, { name: 'audio', maxCount: 1 }]), wrap(async (req, res) => {
    const b = req.body || {}, u = userById(req.uid);
    const title = String(b.title || '').trim(), desc = String(b.desc || '').trim(), amount = Number(b.amount);
    if (title.length < 3) throw bad('Donnez un titre à votre mission.');
    if (desc.length < 10) throw bad('Décrivez la mission (10 caractères minimum).');
    if (!Number.isInteger(amount) || amount < 100 || amount > 5000000) throw bad('Montant invalide (minimum 100 F).');
    const mode = b.mode === 'remote' ? 'remote' : 'onsite', cat = CATS.includes(b.cat) ? b.cat : 'visite';
    const lat = num(b.lat), lng = num(b.lng);
    if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) throw bad('Position invalide.');
    const ver = u.kyc_status === 'verified', lim = ver ? Date.now() - cfg.plan.days * 864e5 : 0, cap = ver ? cfg.plan.create : cfg.plan.unverified;
    const used = db.prepare("SELECT COUNT(*) c FROM missions WHERE creator_id=? AND status!='annulee' AND mod!='rejetee' AND created_at>=?").get(u.id, lim).c;
    if (used >= cap) throw bad(ver ? `Limite atteinte : ${cap} missions créées sur la période avec votre offre.` : `Limite atteinte : ${cap} missions créées sans vérification d'identité. Vérifiez votre identité dans Paramètres pour en créer davantage.`, 403);
    const id = `J-${code5()}/${new Date().getFullYear()}`;
    const imgs = (req.files?.images || []).map((f) => saveMedia(f, u.id)), aud = req.files?.audio?.[0] ? saveMedia(req.files.audio[0], u.id) : null;
    db.prepare(`INSERT INTO missions(id,creator_id,title,descr,cat,mode,city,place,lat,lng,amount,win,open,ask_loc,dl,images,audio,mod,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, u.id, title, desc, cat, mode, mode === 'remote' ? 'En ligne' : String(b.city || '').slice(0, 60), mode === 'remote' ? '' : String(b.place || '').slice(0, 120),
      mode === 'remote' ? null : lat, mode === 'remote' ? null : lng, amount, tier(amount), bool(b.open) ? 1 : 0, mode === 'remote' ? 0 : bool(b.askLoc) ? 1 : 0, Number(b.dl) || 0, JSON.stringify(imgs), aud, 'pending', 'attente', Date.now());
    const lines = [`Mission : ${title}`, `Référence : ${id}`, `Montant : ${F(amount)} (WIN ${tier(amount)})`, `Lieu : ${mode === 'remote' ? 'à distance' : `${b.city || ''} ${b.place || ''}`.trim()}`, `Par : ${who(u)} (${u.phone || u.email})`, `Description : ${desc.slice(0, 300)}`, `Photos : ${imgs.length}${aud ? ' · message vocal joint' : ''}`];
    alertAdmin(`mission à approuver ${id}`, lines, [{ label: 'Approuver', url: link({ t: 'mission', id, a: 'approve' }), color: '#16a34a' }, { label: 'Refuser', url: link({ t: 'mission', id, a: 'reject' }), color: '#dc2626' }]);
    res.status(201).json({ mission: front(mission(id), u.id) });
  }));

  app.get('/api/missions', auth, wrap(async (req, res) => {
    const market = qa("SELECT * FROM missions WHERE mod='approved' AND status='attente' AND creator_id!=? AND id NOT IN (SELECT mission_id FROM applications WHERE user_id=?) ORDER BY created_at DESC LIMIT 300", req.uid, req.uid);
    const mine = qa("SELECT * FROM missions WHERE creator_id=? OR executor_id=? OR id IN (SELECT mission_id FROM applications WHERE user_id=? AND status IN ('pending','declined')) ORDER BY created_at DESC LIMIT 500", req.uid, req.uid, req.uid);
    res.json({ market: market.map((m) => front(m, req.uid)), mine: mine.map((m) => front(m, req.uid)) });
  }));

  const act = (name, fn) => app.post(`/api/missions/:id/${name}`, auth, limiter(60e3, 40), wrap(async (req, res) => {
    const u = userById(req.uid); const out = await fn(getM(req.params.id), u, req.body || {});
    res.json({ ok: true, ...(out || {}), mission: front(mission(req.params.id), u.id) });
  }));
  const checkDo = (u, forOther) => {
    const ver = u.kyc_status === 'verified', cap = ver ? cfg.plan.do : cfg.plan.unverified, lim = ver ? Date.now() - cfg.plan.days * 864e5 : 0;
    if (q1("SELECT COUNT(*) c FROM missions WHERE executor_id=? AND status!='annulee' AND accepted_at>=?", u.id, lim).c >= cap)
      throw bad(forOther ? 'Ce réalisateur a atteint sa limite de missions réalisées.' : ver ? `Limite atteinte : ${cap} missions réalisées sur la période avec votre offre.` : `Limite atteinte : ${cap} missions réalisées sans vérification d'identité. Vérifiez votre identité dans Paramètres pour en réaliser davantage.`, forOther ? 409 : 403);
  };
  const short = (s, n) => String(s || '').trim().slice(0, n);

  /* candidature d'un réalisateur : le créateur voit son nom, ses prénoms et sa note avant de décider */
  act('apply', async (m, u, body) => {
    if (m.creator_id === u.id) throw bad('Vous ne pouvez pas réaliser votre propre mission.');
    if (m.mod !== 'approved' || m.status !== 'attente') throw bad('Cette mission n\'est plus disponible.', 409);
    const ex = q1('SELECT * FROM applications WHERE mission_id=? AND user_id=?', m.id, u.id);
    if (ex?.status === 'pending') throw bad('Vous avez déjà postulé à cette mission.', 409);
    if (ex?.status === 'declined') throw bad('Votre candidature n\'a pas été retenue pour cette mission.', 409);
    checkDo(u);
    if (ex) db.prepare("UPDATE applications SET status='pending', note=?, created_at=?, decided_at=NULL WHERE id=?").run(short(body.message, 300), Date.now(), ex.id);
    else db.prepare('INSERT INTO applications(id,mission_id,user_id,status,note,created_at) VALUES(?,?,?,?,?,?)').run(uid('a_'), m.id, u.id, 'pending', short(body.message, 300), Date.now());
    const c = profileCard(u, 'exec');
    tellUser(userById(m.creator_id), `Nouvelle candidature · ${m.id}`, `${c.name} postule à « ${m.title} » : ${c.rating ? `note J-WIN ${String(c.rating).replace('.', ',')}/5 (${c.reviews} avis)` : 'nouveau réalisateur, pas encore noté'}, ${c.done} mission(s) réalisée(s). Ouvrez la mission pour accepter ou refuser ce réalisateur.`, m.id, 'user');
  });
  act('withdraw-application', async (m, u) => {
    const r = db.prepare("UPDATE applications SET status='withdrawn', decided_at=? WHERE mission_id=? AND user_id=? AND status='pending'").run(Date.now(), m.id, u.id);
    if (!r.changes) throw bad('Aucune candidature en attente.', 409);
  });
  act('choose', async (m, u, body) => {
    if (m.creator_id !== u.id) throw bad('Action impossible.', 403);
    if (m.mod !== 'approved' || m.status !== 'attente') throw bad('Un réalisateur a déjà été choisi ou la mission n\'est plus ouverte.', 409);
    const a = q1("SELECT * FROM applications WHERE mission_id=? AND user_id=? AND status='pending'", m.id, String(body.userId || ''));
    if (!a) throw bad('Candidature introuvable.', 404);
    const cand = userById(a.user_id); if (cand.status === 'suspended') throw bad('Ce compte est suspendu.', 409);
    checkDo(cand, true);
    const now = Date.now(), others = qa("SELECT user_id FROM applications WHERE mission_id=? AND status='pending' AND id!=?", m.id, a.id);
    tx(db, () => {
      const r = db.prepare("UPDATE missions SET status='cours', executor_id=?, accepted_at=? WHERE id=? AND status='attente'").run(cand.id, now, m.id);
      if (!r.changes) throw bad('La mission n\'est plus disponible.', 409);
      db.prepare("UPDATE applications SET status='accepted', decided_at=? WHERE id=?").run(now, a.id);
      db.prepare("UPDATE applications SET status='declined', decided_at=? WHERE mission_id=? AND status='pending'").run(now, m.id);
    });
    tellUser(cand, `Candidature retenue · ${m.id}`, `${fullName(u)} vous a choisi pour « ${m.title} ». Discutez avec lui dans la mission, puis réalisez-la et envoyez vos preuves.`, m.id, 'check');
    for (const o of others) tellUser(userById(o.user_id), `Candidature non retenue · ${m.id}`, `Le créateur a choisi un autre réalisateur pour « ${m.title} ».`, m.id, 'bell');
  });
  act('decline', async (m, u, body) => {
    if (m.creator_id !== u.id) throw bad('Action impossible.', 403);
    const r = db.prepare("UPDATE applications SET status='declined', decided_at=? WHERE mission_id=? AND user_id=? AND status='pending'").run(Date.now(), m.id, String(body.userId || ''));
    if (!r.changes) throw bad('Candidature introuvable.', 404);
    tellUser(userById(String(body.userId)), `Candidature non retenue · ${m.id}`, `Le créateur n'a pas retenu votre candidature pour « ${m.title} ».`, m.id, 'bell');
  });

  /* le réalisateur envoie ses preuves (texte, lien, photos, vocal) : le créateur les approuve, puis le paiement est prélevé */
  app.post('/api/missions/:id/submit-proof', auth, limiter(60e3, 20), upload.fields([{ name: 'images', maxCount: 4 }, { name: 'audio', maxCount: 1 }]), wrap(async (req, res) => {
    const u = userById(req.uid), m = getM(req.params.id), b = req.body || {};
    if (m.executor_id !== u.id || m.status !== 'cours') throw bad('Action impossible.', 409);
    const text = short(b.text, 2000), link = short(b.link, 300);
    if (link && !/^https?:\/\//i.test(link)) throw bad('Le lien doit commencer par http:// ou https://');
    const imgs = (req.files?.images || []).map((f) => saveMedia(f, u.id)), aud = req.files?.audio?.[0] ? saveMedia(req.files.audio[0], u.id) : null;
    if (!text && !link && !imgs.length && !aud) throw bad('Ajoutez au moins une preuve : texte, lien, photo ou message vocal.');
    db.prepare("UPDATE missions SET proof=?, proof_at=?, proof_note=NULL, status='terminee', finished_at=? WHERE id=?").run(JSON.stringify({ text, link, images: imgs, audio: aud }), Date.now(), Date.now(), m.id);
    tellUser(userById(m.creator_id), `Preuves à valider · ${m.id}`, `${fullName(u)} a terminé « ${m.title} » et envoie ses preuves. Approuvez pour payer ${F(m.amount)}, ou demandez une correction.`, m.id, 'send');
    res.json({ ok: true, mission: front(mission(m.id), u.id) });
  }));
  act('revise', async (m, u, body) => {
    if (m.creator_id !== u.id || m.status !== 'terminee') throw bad('Action impossible.', 409);
    const note = short(body.note, 300); if (note.length < 3) throw bad('Indiquez ce qui doit être corrigé.');
    db.prepare("UPDATE missions SET status='cours', proof_note=? WHERE id=?").run(note, m.id);
    tellUser(userById(m.executor_id), `Correction demandée · ${m.id}`, `Le créateur demande une correction sur « ${m.title} » : ${note}`, m.id, 'bell');
  });
  act('validate', async (m, u, body) => {
    if (m.creator_id !== u.id || m.status !== 'terminee') throw bad('Action impossible.', 409);
    const fee = pct(m.amount, feeMission), net = m.amount - fee, ex = userById(m.executor_id), now = Date.now(), n = Number(body.rating);
    tx(db, () => {
      if (balanceOf(db, u.id) < m.amount) throw bad('Solde insuffisant : rechargez votre portefeuille pour payer cette mission.', 402);
      const invP = issueInvoice(db, cfg, { user: u, paymentId: m.id, kind: 'mission', label: `Paiement de la mission ${m.id}`, lines: [{ label: m.title, amount: m.amount }], fee: 0, total: m.amount, method: 'Portefeuille J-WIN' });
      const invE = issueInvoice(db, cfg, { user: ex, paymentId: m.id, kind: 'mission', label: `Rémunération de la mission ${m.id}`, lines: [{ label: m.title, amount: m.amount }, { label: `Commission J-WIN (${feeMission} %)`, amount: -fee }, { label: 'Montant reçu', amount: net }], fee, total: net, method: 'Portefeuille J-WIN' });
      db.prepare('INSERT INTO ledger(user_id,kind,amount,ref,memo,method,invoice_no,created_at) VALUES(?,?,?,?,?,?,?,?)').run(u.id, 'mission_pay', -m.amount, m.id, `Paiement : ${m.title}`, 'wallet', invP.no, now);
      db.prepare('INSERT INTO ledger(user_id,kind,amount,ref,memo,method,invoice_no,created_at) VALUES(?,?,?,?,?,?,?,?)').run(ex.id, 'mission_win', net, m.id, `WIN : ${m.title}`, 'wallet', invE.no, now);
      db.prepare("UPDATE missions SET status='payee', done_at=?, exec_rating=?, exec_review=? WHERE id=?").run(now, n >= 1 && n <= 5 ? Math.round(n) : null, n >= 1 && n <= 5 ? short(body.review, 300) : null, m.id);
    });
    tellUser(ex, `Preuves approuvées · ${m.id}`, `Le créateur a approuvé votre travail : ${F(net)} ont été crédités sur votre portefeuille J-WIN pour « ${m.title} ».`, m.id, 'check');
  });
  act('rate-exec', async (m, u, body) => {
    const n = Number(body.n);
    if (m.creator_id !== u.id || m.status !== 'payee' || m.exec_rating || !(n >= 1 && n <= 5)) throw bad('Action impossible.', 409);
    db.prepare('UPDATE missions SET exec_rating=?, exec_review=? WHERE id=?').run(Math.round(n), short(body.review, 300), m.id);
  });
  act('rate', async (m, u, body) => {
    const n = Number(body.n);
    if (m.executor_id !== u.id || m.status !== 'payee' || !(n >= 1 && n <= 5)) throw bad('Action impossible.', 409);
    db.prepare('UPDATE missions SET rating=?, review=? WHERE id=?').run(Math.round(n), short(body.review, 300), m.id);
  });
  act('cancel', async (m, u) => {
    if (m.creator_id === u.id) {
      if (m.status !== 'attente') throw bad('Une mission acceptée ne peut plus être annulée par son créateur : seule l\'administrateur J-WIN peut l\'annuler. Contactez-le.', 403);
      const pend = qa("SELECT user_id FROM applications WHERE mission_id=? AND status='pending'", m.id);
      db.prepare("UPDATE missions SET status='annulee' WHERE id=?").run(m.id);
      db.prepare("UPDATE applications SET status='declined', decided_at=? WHERE mission_id=? AND status='pending'").run(Date.now(), m.id);
      for (const p of pend) tellUser(userById(p.user_id), `Mission annulée · ${m.id}`, `Le créateur a annulé « ${m.title} ».`, m.id, 'bell');
    } else if (m.executor_id === u.id && m.status === 'cours') {
      db.prepare("UPDATE missions SET status='attente', executor_id=NULL, accepted_at=NULL, proof_note=NULL WHERE id=?").run(m.id);
      db.prepare("UPDATE applications SET status='withdrawn', decided_at=? WHERE mission_id=? AND user_id=?").run(Date.now(), m.id, u.id);
      tellUser(userById(m.creator_id), `Réalisateur retiré · ${m.id}`, `Le réalisateur s'est retiré de « ${m.title} ». La mission est de nouveau ouverte aux candidatures.`, m.id, 'bell');
    } else throw bad('Action impossible.', 409);
  });

  /* ---------- discussion créateur / réalisateur (par mission et par candidat) ---------- */
  const thread = (m, viewer, cid) => {
    const cand = m.creator_id === viewer ? String(cid || '') : viewer;
    if (!cand || cand === m.creator_id) throw bad('Discussion introuvable.', 404);
    if (!q1("SELECT 1 x FROM applications WHERE mission_id=? AND user_id=? AND status IN ('pending','accepted')", m.id, cand)) throw bad('La discussion s\'ouvre dès qu\'un réalisateur postule.', 403);
    return cand;
  };
  app.get('/api/chats', auth, wrap(async (req, res) => {
    const rows = qa("SELECT a.mission_id, a.user_id cid, m.title, m.creator_id, m.status ms FROM applications a JOIN missions m ON m.id=a.mission_id WHERE a.status IN ('pending','accepted') AND m.status!='annulee' AND (a.user_id=? OR m.creator_id=?)", req.uid, req.uid);
    const out = rows.map((r) => {
      const other = userById(r.creator_id === req.uid ? r.cid : r.creator_id), last = q1('SELECT text,created_at,sender_id FROM messages WHERE mission_id=? AND candidate_id=? ORDER BY id DESC LIMIT 1', r.mission_id, r.cid);
      const unread = q1('SELECT COUNT(*) c FROM messages WHERE mission_id=? AND candidate_id=? AND sender_id!=? AND read_at IS NULL', r.mission_id, r.cid, req.uid).c;
      return { missionId: r.mission_id, title: r.title, candidateId: r.cid, with: fullName(other), last: last ? { text: last.text, at: last.created_at, mine: last.sender_id === req.uid } : null, unread, at: last?.created_at || 0 };
    }).sort((a, b) => b.at - a.at);
    res.json({ threads: out, unread: out.reduce((s, t) => s + t.unread, 0) });
  }));
  app.get('/api/chats/:mid/:cid', auth, wrap(async (req, res) => {
    const m = getM(req.params.mid), cand = thread(m, req.uid, req.params.cid), after = Number(req.query.after) || 0;
    const rows = qa('SELECT id,sender_id,text,created_at FROM messages WHERE mission_id=? AND candidate_id=? AND id>? ORDER BY id LIMIT 200', m.id, cand, after);
    db.prepare('UPDATE messages SET read_at=? WHERE mission_id=? AND candidate_id=? AND sender_id!=? AND read_at IS NULL').run(Date.now(), m.id, cand, req.uid);
    const other = userById(m.creator_id === req.uid ? cand : m.creator_id);
    res.json({ with: fullName(other), accepted: !!q1("SELECT 1 x FROM applications WHERE mission_id=? AND user_id=? AND status='accepted'", m.id, cand), phone: q1("SELECT 1 x FROM applications WHERE mission_id=? AND user_id=? AND status='accepted'", m.id, cand) ? other.phone || '' : '', messages: rows.map((x) => ({ id: x.id, mine: x.sender_id === req.uid, text: x.text, at: x.created_at })) });
  }));
  app.post('/api/chats/:mid/:cid', auth, limiter(60e3, 60), wrap(async (req, res) => {
    const m = getM(req.params.mid), cand = thread(m, req.uid, req.params.cid), text = short(req.body?.text, 1000);
    if (m.status === 'annulee') throw bad('Cette mission est annulée.', 409);
    if (!text) throw bad('Écrivez un message.');
    const id = db.prepare('INSERT INTO messages(mission_id,candidate_id,sender_id,text,created_at) VALUES(?,?,?,?,?)').run(m.id, cand, req.uid, text, Date.now()).lastInsertRowid;
    res.status(201).json({ ok: true, id: Number(id) });
  }));

  /* ---------- notifications de l'application ---------- */
  app.get('/api/notifications', auth, wrap(async (req, res) => {
    const items = qa('SELECT * FROM notifs WHERE user_id=? ORDER BY id DESC LIMIT 60', req.uid).map((n) => ({ id: n.id, type: n.type, title: n.title, text: n.text, missionId: n.mission_id, read: !!n.read, at: n.created_at }));
    const chats = q1("SELECT COUNT(*) c FROM messages x JOIN missions m ON m.id=x.mission_id WHERE x.sender_id!=? AND x.read_at IS NULL AND (x.candidate_id=? OR m.creator_id=?)", req.uid, req.uid, req.uid).c;
    res.json({ items, unread: items.filter((n) => !n.read).length, chats });
  }));
  app.post('/api/notifications/read', auth, wrap(async (req, res) => {
    if (req.body?.all) db.prepare('UPDATE notifs SET read=1 WHERE user_id=?').run(req.uid);
    else for (const id of [].concat(req.body?.ids || []).slice(0, 100)) db.prepare('UPDATE notifs SET read=1 WHERE user_id=? AND id=?').run(req.uid, Number(id));
    res.json({ ok: true });
  }));

  /* ---------- dépôts Orange Money (validés par l'administrateur) ---------- */
  const payment = (id) => db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  app.post('/api/deposits', auth, limiter(60e3, 15), wrap(async (req, res) => {
    const A = Number(req.body?.amount), u = userById(req.uid);
    if (!Number.isInteger(A) || A < cfg.limits.rechargeMin || A > cfg.limits.rechargeMax) throw bad(`Montant entre ${cfg.limits.rechargeMin} et ${cfg.limits.rechargeMax} F.`);
    if (!validPhone(req.body?.phone)) throw bad('Numéro mobile ivoirien invalide.');
    const id = merchantId('JWD'), ref = 'DEP-' + code5(), fee = pct(A, cfg.fees.recharge), now = Date.now();
    db.prepare('INSERT INTO payments(id,user_id,kind,method,amount,fee,status,phone,created_at,updated_at,ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, u.id, 'recharge', 'orange', A, fee, 'AWAITING', normPhone(req.body.phone), now, now, ref);
    res.status(201).json({ id, ref, amount: A, fee, total: A + fee, payTo: cfg.adminOm });
  }));
  app.post('/api/deposits/:id/confirm', auth, limiter(60e3, 15), wrap(async (req, res) => {
    const p = payment(req.params.id);
    if (!p || p.user_id !== req.uid || p.kind !== 'recharge') throw bad('Dépôt introuvable.', 404);
    if (p.status === 'AWAITING') {
      const txId = String(req.body?.txId || '').slice(0, 60), u = userById(req.uid);
      db.prepare("UPDATE payments SET status='PENDING_ADMIN', tx_id=?, updated_at=? WHERE id=?").run(txId, Date.now(), p.id);
      alertAdmin(`dépôt à valider ${p.ref}`, [`Client : ${who(u)} (${u.phone || u.email})`, `Référence : ${p.ref}`, `Montant à créditer : ${F(p.amount)}`, `À recevoir sur Orange Money : ${F(p.amount + p.fee)} (frais ${F(p.fee)})`, `Numéro expéditeur : ${p.phone}`, `ID de transaction indiqué : ${txId || 'non renseigné'}`, 'Vérifiez la réception du transfert AVANT de valider.'],
        [{ label: 'Valider le dépôt', url: link({ t: 'deposit', id: p.id, a: 'approve' }), color: '#16a34a' }, { label: 'Refuser', url: link({ t: 'deposit', id: p.id, a: 'reject' }), color: '#dc2626' }]);
    }
    res.json({ ok: true, status: 'PENDING_ADMIN' });
  }));

  /* ---------- retraits : le solde est réservé, l'administrateur paie à la main ---------- */
  v4.payout = wrap(async (req, res) => {
    const { amount, method, phone } = req.body || {}, A = Number(amount), u = userById(req.uid);
    if (u.kyc_status !== 'verified' && cfg.prod) throw bad('Vérifiez votre identité (Paramètres) avant de retirer des fonds.', 403);
    if (!Number.isInteger(A) || A < cfg.limits.withdrawMin || A > cfg.limits.withdrawMax) throw bad(`Montant entre ${cfg.limits.withdrawMin} et ${cfg.limits.withdrawMax} F.`);
    if (!METHOD_LABEL[method] || method === 'card') throw bad('Moyen de paiement non pris en charge.');
    if (!validPhone(phone)) throw bad('Numéro mobile ivoirien invalide.');
    const fee = pct(A, cfg.fees.withdraw), net = A - fee, id = merchantId('JWW'), ref = 'RET-' + code5();
    tx(db, () => {
      if (balanceOf(db, u.id) < A) throw bad('Solde insuffisant.', 402);
      const now = Date.now();
      db.prepare('INSERT INTO payments(id,user_id,kind,method,amount,fee,status,phone,created_at,updated_at,ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, u.id, 'withdraw', method, A, fee, 'PENDING_ADMIN', normPhone(phone), now, now, ref);
      db.prepare('INSERT INTO ledger(user_id,kind,amount,ref,memo,method,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, 'withdraw', -A, id, 'Retrait vers ' + METHOD_LABEL[method], method, now);
    });
    alertAdmin(`retrait à payer ${ref}`, [`Client : ${who(u)} (${u.phone || u.email})`, `Référence : ${ref}`, `Montant retiré du portefeuille : ${F(A)}`, `À ENVOYER au client : ${F(net)} (frais J-WIN ${F(fee)})`, `Vers : ${METHOD_LABEL[method]} ${normPhone(phone)}`, 'Envoyez l\'argent par mobile money, puis cliquez sur « J\'ai payé ».'],
      [{ label: 'J\'ai payé', url: link({ t: 'withdraw', id, a: 'approve' }), color: '#16a34a' }, { label: 'Refuser et rembourser', url: link({ t: 'withdraw', id, a: 'reject' }), color: '#dc2626' }]);
    res.status(201).json({ id, ref, status: 'PENDING_ADMIN', fee, net });
  });

  /* ---------- page d'action de l'administrateur (liens signés reçus par e-mail / SMS) ---------- */
  const page = (title, body, status = 200) => (res) => res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:40px auto;padding:0 16px"><h2>${esc(title)}</h2>${body}</body>`);
  const describe = (p) => {
    if (p.t === 'kyc') { const u = userById(p.id); return u && { done: u.kyc_status !== 'pending', text: `Identité de ${u.prenoms} ${u.nom} · statut : ${u.kyc_status}` }; }
    if (p.t === 'mission') { const m = mission(p.id); return m && { done: m.mod !== 'pending', text: `Mission « ${m.title} » (${m.id}) · ${F(m.amount)} · statut : ${m.mod}` }; }
    const x = payment(p.id); return x && { done: !['AWAITING', 'PENDING_ADMIN'].includes(x.status), text: `${p.t === 'deposit' ? 'Dépôt' : 'Retrait'} ${x.ref} · ${F(x.amount)} · statut : ${x.status}` };
  };
  const decode = (t) => { try { return readAction(cfg, t); } catch { return null; } };
  /* décision commune aux liens e-mail et à la console admin */
  v4.decide = (p, ok, note) => {
      if (p.t === 'kyc') {
        const u = userById(p.id);
        db.prepare('UPDATE users SET kyc_status=? WHERE id=?').run(ok ? 'verified' : 'rejected', u.id);
        tellUser(u, ok ? 'Identité vérifiée' : 'Vérification refusée', ok ? 'Votre identité est vérifiée : vous pouvez publier, accepter des missions et retirer vos gains.' : 'Votre vérification d\'identité a été refusée. Contactez-nous pour la corriger.');
      } else if (p.t === 'mission') {
        const m = mission(p.id), c = userById(m.creator_id);
        db.prepare('UPDATE missions SET mod=?, mod_note=? WHERE id=?').run(ok ? 'approved' : 'rejetee', note, m.id);
        tellUser(c, ok ? `Mission approuvée ${m.id}` : `Mission refusée ${m.id}`, ok ? `Votre mission « ${m.title} » a été approuvée : elle est maintenant visible par tous les utilisateurs.` : `Votre mission « ${m.title} » a été refusée${note ? ' : ' + note : '.'}`);
      } else if (p.t === 'deposit') {
        const x = payment(p.id), u = userById(x.user_id);
        tx(db, () => {
          if (!ok) return db.prepare("UPDATE payments SET status='FAILED', error=?, updated_at=? WHERE id=?").run(note || 'Refusé par l\'administrateur', Date.now(), x.id);
          const inv = issueInvoice(db, cfg, { user: u, paymentId: x.id, kind: 'recharge', label: 'Recharge du portefeuille J-WIN', lines: [{ label: 'Recharge du portefeuille (Orange Money)', amount: x.amount }, { label: `Frais de service J-WIN (${cfg.fees.recharge} %)`, amount: x.fee }], fee: x.fee, total: x.amount + x.fee, method: 'Orange Money', providerRef: x.tx_id || x.ref });
          db.prepare('INSERT INTO ledger(user_id,kind,amount,ref,memo,method,invoice_no,created_at) VALUES(?,?,?,?,?,?,?,?)').run(u.id, 'recharge', x.amount, x.id, 'Recharge Orange Money', 'orange', inv.no, Date.now());
          db.prepare("UPDATE payments SET status='SUCCESS', invoice_no=?, updated_at=? WHERE id=?").run(inv.no, Date.now(), x.id);
        });
        tellUser(u, ok ? `Dépôt validé ${x.ref}` : `Dépôt refusé ${x.ref}`, ok ? `Votre portefeuille J-WIN a été crédité de ${F(x.amount)}.` : `Votre dépôt ${x.ref} n'a pas pu être validé${note ? ' : ' + note : '. Contactez-nous.'}`);
      } else {
        const x = payment(p.id), u = userById(x.user_id);
        tx(db, () => {
          if (!ok) {
            db.prepare('INSERT OR IGNORE INTO ledger(user_id,kind,amount,ref,memo,method,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, 'withdraw_refund', x.amount, x.id, 'Retrait refusé : remboursement', x.method, Date.now());
            return db.prepare("UPDATE payments SET status='FAILED', error=?, updated_at=? WHERE id=?").run(note || 'Refusé par l\'administrateur', Date.now(), x.id);
          }
          const net = x.amount - x.fee;
          const inv = issueInvoice(db, cfg, { user: u, paymentId: x.id, kind: 'retrait', label: 'Retrait du portefeuille J-WIN', lines: [{ label: 'Montant retiré du portefeuille', amount: x.amount }, { label: `Frais de service J-WIN (${cfg.fees.withdraw} %)`, amount: -x.fee }, { label: 'Montant versé sur votre compte', amount: net }], fee: x.fee, total: net, method: METHOD_LABEL[x.method], providerRef: x.ref });
          db.prepare('UPDATE ledger SET invoice_no=? WHERE kind=? AND ref=?').run(inv.no, 'withdraw', x.id);
          db.prepare("UPDATE payments SET status='SUCCESS', invoice_no=?, updated_at=? WHERE id=?").run(inv.no, Date.now(), x.id);
        });
        tellUser(u, ok ? `Retrait payé ${x.ref}` : `Retrait refusé ${x.ref}`, ok ? `${F(x.amount - x.fee)} ont été envoyés vers votre compte ${METHOD_LABEL[x.method]}.` : `Votre retrait ${x.ref} a été refusé et le montant remboursé sur votre portefeuille${note ? ' : ' + note : '.'}`);
      }
  };
  v4.describe = describe;

  app.get('/admin/act', (req, res) => {
    const p = decode(req.query.t); if (!p) return page('Lien invalide ou expiré', '<p>Ce lien n\'est plus valable.</p>', 400)(res);
    const d = describe(p); if (!d) return page('Introuvable', '<p>Élément introuvable.</p>', 404)(res);
    const verb = { approve: p.t === 'withdraw' ? 'Confirmer : j\'ai payé' : 'Approuver', reject: 'Refuser' }[p.a];
    page('Confirmation', `<p>${esc(d.text)}</p>${d.done ? '<p><b>Déjà traité.</b></p>' : `<form method="post" action="/admin/act"><input type="hidden" name="t" value="${esc(req.query.t)}">${p.a === 'reject' ? '<p><input name="note" placeholder="Motif (facultatif)" style="width:100%;padding:10px"></p>' : ''}<button style="padding:12px 20px;border:0;border-radius:999px;background:${p.a === 'reject' ? '#dc2626' : '#16a34a'};color:#fff;font-weight:700;font-size:16px">${esc(verb)}</button></form>`}`)(res);
  });
  app.post('/admin/act', express.urlencoded({ extended: false, limit: '5kb' }), (req, res) => {
    const p = decode(req.body.t); if (!p) return page('Lien invalide ou expiré', '<p>Ce lien n\'est plus valable.</p>', 400)(res);
    const d = describe(p); if (!d) return page('Introuvable', '<p>Élément introuvable.</p>', 404)(res);
    if (d.done) return page('Déjà traité', `<p>${esc(d.text)}</p>`)(res);
    const note = String(req.body.note || '').slice(0, 200), ok = p.a === 'approve';
    try {
      v4.decide(p, ok, note);
      page('C\'est fait', `<p>${esc(d.text)}</p><p>Action enregistrée : <b>${ok ? 'validée' : 'refusée'}</b>. L'utilisateur est prévenu.</p>`)(res);
    } catch (e) { log('[admin]', e.message); page('Erreur', `<p>${esc(e.message)}</p>`, 500)(res); }
  });

  /* ---------- portefeuille : opérations en attente ---------- */
  v4.pending = (uidv) => db.prepare("SELECT * FROM payments WHERE user_id=? AND status IN ('PENDING_ADMIN','PENDING') ORDER BY created_at DESC").all(uidv).map((p) => ({ id: p.id, kind: p.kind, amount: p.amount, method: p.method, ref: p.ref, at: p.created_at }));
  return v4;
}
