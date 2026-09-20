import crypto from 'node:crypto';

export const normPhone = (s) => { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('225') && d.length > 10) d = d.slice(3); return d; };
export const validPhone = (s) => /^0[157]\d{8}$/.test(normPhone(s));
const e164 = (s) => '+225' + normPhone(s);
const hash = (secret, phone, purpose, code) => crypto.createHmac('sha256', secret).update(`${phone}|${purpose}|${code}`).digest('hex');

/** Envoi du code : SMS et/ou WhatsApp (Twilio). Mode « console » pour le développement. */
async function deliver(cfg, channel, phone, code, log) {
  const t = cfg.otp.twilio;
  if (cfg.otp.mode !== 'twilio') { log(`[OTP ${channel}] ${e164(phone)} -> ${code}`); return; }
  const auth = 'Basic ' + Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64');
  const form = new URLSearchParams();
  if (channel === 'whatsapp') {
    form.set('To', 'whatsapp:' + e164(phone)); form.set('From', 'whatsapp:' + t.whatsappFrom);
    if (t.whatsappContentSid) { form.set('ContentSid', t.whatsappContentSid); form.set('ContentVariables', JSON.stringify({ 1: code })); }
    else form.set('Body', `Votre code J-WIN : ${code}. Valable 5 minutes.`);
  } else {
    form.set('To', e164(phone));
    if (t.messagingServiceSid) form.set('MessagingServiceSid', t.messagingServiceSid); else form.set('From', t.smsFrom);
    form.set('Body', `Votre code J-WIN : ${code}. Valable 5 minutes. Ne le partagez jamais.`);
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  if (!res.ok) throw new Error(`Envoi ${channel} refusé (${res.status})`);
}

export async function sendOtp({ db, cfg, log = console.log }, { phone, channel = 'both', purpose }) {
  phone = normPhone(phone);
  if (!validPhone(phone)) throw Object.assign(new Error('Numéro ivoirien invalide.'), { status: 400 });
  const now = Date.now();
  const prev = db.prepare('SELECT sent_at FROM otps WHERE phone=? AND purpose=?').get(phone, purpose);
  if (prev && now - prev.sent_at < cfg.otp.resendMs) throw Object.assign(new Error('Patientez avant de demander un nouveau code.'), { status: 429 });
  const perHour = db.prepare('SELECT COUNT(*) c FROM otp_log WHERE phone=? AND sent_at>?').get(phone, now - 3600e3).c;
  if (perHour >= 6) throw Object.assign(new Error('Trop de codes demandés. Réessayez plus tard.'), { status: 429 });
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  db.prepare('INSERT OR REPLACE INTO otps(phone,purpose,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,?,0,?)').run(phone, purpose, hash(cfg.jwtSecret, phone, purpose, code), now + cfg.otp.ttlMs, now);
  db.prepare('INSERT INTO otp_log(phone,sent_at) VALUES(?,?)').run(phone, now);
  const channels = channel === 'both' ? ['sms', 'whatsapp'] : [channel];
  const results = await Promise.allSettled(channels.map((c) => deliver(cfg, c, phone, code, log)));
  if (results.every((r) => r.status === 'rejected')) throw Object.assign(new Error('Impossible d\'envoyer le code pour le moment.'), { status: 502 });
  return { channels, delivered: channels.filter((_, i) => results[i].status === 'fulfilled'), expiresAt: now + cfg.otp.ttlMs, resendAfter: now + cfg.otp.resendMs };
}

export function verifyOtp({ db, cfg }, { phone, purpose, code }) {
  phone = normPhone(phone);
  const row = db.prepare('SELECT * FROM otps WHERE phone=? AND purpose=?').get(phone, purpose);
  const fail = (m, s = 400) => { throw Object.assign(new Error(m), { status: s }); };
  if (!row) fail('Aucun code en attente pour ce numéro.');
  if (Date.now() > row.expires_at) fail('Ce code a expiré. Demandez-en un nouveau.');
  if (row.attempts >= cfg.otp.maxAttempts) fail('Trop d\'essais. Demandez un nouveau code.', 429);
  const ok = crypto.timingSafeEqual(Buffer.from(hash(cfg.jwtSecret, phone, purpose, String(code))), Buffer.from(row.code_hash));
  if (!ok) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=? AND purpose=?').run(phone, purpose); fail(`Code incorrect. Il reste ${cfg.otp.maxAttempts - row.attempts - 1} essai(s).`); }
  db.prepare('DELETE FROM otps WHERE phone=? AND purpose=?').run(phone, purpose);
  return true;
}
