// Envoi d'e-mails (SMTP, ex. Gmail) et de SMS / WhatsApp (Twilio). Sans configuration : tout est écrit dans les logs.
import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';

export function createNotifier(cfg, { log = console.log } = {}) {
  const s = cfg.smtp;
  const transport = s.host
    ? nodemailer.createTransport({ host: s.host, port: s.port, secure: s.port === 465, auth: s.user ? { user: s.user, pass: s.pass } : undefined })
    : s.json ? nodemailer.createTransport({ jsonTransport: true }) : null;
  const outbox = [];
  const t = cfg.otp.twilio;
  const e164 = (p) => '+225' + String(p).replace(/\D/g, '').replace(/^225(?=\d{10}$)/, '');

  async function email(to, subject, text, html) {
    if (!to) return false;
    const msg = { from: s.from || `J-WIN <${s.user || cfg.adminEmail}>`, to, subject, text, html };
    outbox.push(msg);
    if (!transport) { log(`[EMAIL non envoyé, SMTP non configuré] à ${to} : ${subject}`); return false; }
    try { await transport.sendMail(msg); return true; } catch (e) { log('[EMAIL erreur]', e.message); return false; }
  }
  async function twilioMsg(to, body, whatsapp) {
    const form = new URLSearchParams({ To: (whatsapp ? 'whatsapp:' : '') + to, Body: body });
    if (whatsapp) form.set('From', 'whatsapp:' + t.whatsappFrom);
    else if (t.messagingServiceSid) form.set('MessagingServiceSid', t.messagingServiceSid); else form.set('From', t.smsFrom);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    return res.ok;
  }
  async function sms(phone, text) {
    if (!phone) return false;
    if (cfg.otp.mode !== 'twilio') { log(`[SMS] ${e164(phone)} : ${text}`); outbox.push({ sms: e164(phone), text }); return true; }
    try { return await twilioMsg(e164(phone), text, false); } catch (e) { log('[SMS erreur]', e.message); return false; }
  }
  async function whatsapp(phone, text) {
    if (cfg.otp.mode !== 'twilio') return false;
    try { return await twilioMsg(e164(phone), text, true); } catch { return false; }
  }
  /** Prévient un utilisateur : e-mail + SMS. */
  async function toUser(u, subject, text) {
    const [e, m] = await Promise.all([email(u.email, subject, text), sms(u.phone, `J-WIN : ${text}`.slice(0, 300))]);
    return { email: e, sms: m };
  }
  /** Prévient l'administrateur : e-mail (avec boutons) + SMS/WhatsApp court avec le lien principal. */
  async function toAdmin(subject, text, html, shortLink) {
    const r = { email: await email(cfg.adminEmail, subject, text, html) };
    const brief = `J-WIN admin : ${subject}${shortLink ? ' ' + shortLink : ''}`.slice(0, 300);
    r.sms = await sms(cfg.adminPhone, brief);
    r.whatsapp = await whatsapp(cfg.adminPhone, brief);
    return r;
  }
  return { email, sms, whatsapp, toUser, toAdmin, outbox };
}

/** Lien d'action signé pour l'administrateur (valable 30 jours, à usage fonctionnel unique). */
export const actionUrl = (cfg, payload) => `${cfg.publicUrl}/admin/act?t=${encodeURIComponent(jwt.sign({ ...payload, aud: 'admin' }, cfg.jwtSecret, { expiresIn: '30d' }))}`;
export const readAction = (cfg, t) => jwt.verify(String(t || ''), cfg.jwtSecret, { audience: 'admin' });

export function adminMailHtml(cfg, title, lines, actions) {
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px"><h2 style="margin:0 0 8px">${esc(title)}</h2>${lines.map((l) => `<p style="margin:4px 0">${esc(l)}</p>`).join('')}<p style="margin-top:18px">${actions.map((a) => `<a href="${a.url}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:999px;background:${a.color || '#2563eb'};color:#fff;text-decoration:none;font-weight:700">${esc(a.label)}</a>`).join('')}</p><p style="color:#666;font-size:12px">Ces liens sont personnels : ne les transférez pas. Chaque action demande une confirmation.</p></div>`;
}
