import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, phone TEXT UNIQUE, email TEXT UNIQUE, provider TEXT DEFAULT 'phone',
      nom TEXT, prenoms TEXT, dob TEXT, adresse TEXT, pw_hash TEXT,
      kyc_status TEXT DEFAULT 'pending', kyc_doc_type TEXT, kyc_doc_last4 TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS otps(
      phone TEXT, purpose TEXT, code_hash TEXT, expires_at INTEGER, attempts INTEGER DEFAULT 0, sent_at INTEGER,
      PRIMARY KEY(phone, purpose));
    CREATE TABLE IF NOT EXISTS otp_log(phone TEXT, sent_at INTEGER);
    CREATE TABLE IF NOT EXISTS ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, amount INTEGER, ref TEXT, memo TEXT,
      method TEXT, invoice_no TEXT, created_at INTEGER, UNIQUE(kind, ref));
    CREATE TABLE IF NOT EXISTS payments(
      id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, method TEXT, amount INTEGER, fee INTEGER, status TEXT,
      phone TEXT, provider_tx TEXT, payment_token TEXT, notify_token TEXT, payment_url TEXT, error TEXT,
      invoice_no TEXT, created_at INTEGER, updated_at INTEGER, ref TEXT, tx_id TEXT);
    CREATE TABLE IF NOT EXISTS invoices(
      no TEXT PRIMARY KEY, user_id TEXT, payment_id TEXT, data TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER);
    CREATE TABLE IF NOT EXISTS missions(
      id TEXT PRIMARY KEY, creator_id TEXT, title TEXT, descr TEXT, cat TEXT, mode TEXT, city TEXT, place TEXT, lat REAL, lng REAL,
      amount INTEGER, win INTEGER, open INTEGER, ask_loc INTEGER, dl INTEGER, images TEXT, audio TEXT,
      mod TEXT DEFAULT 'pending', mod_note TEXT, status TEXT DEFAULT 'attente', executor_id TEXT,
      accepted_at INTEGER, finished_at INTEGER, done_at INTEGER, rating INTEGER, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, mime TEXT, file TEXT, owner_id TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS kyc_docs(user_id TEXT PRIMARY KEY, type TEXT, front TEXT, back TEXT, selfie TEXT, ocr TEXT, submitted_at INTEGER);
    CREATE TABLE IF NOT EXISTS magic_links(jti TEXT PRIMARY KEY, email TEXT, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actor TEXT, action TEXT, target TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS ix_mis_creator ON missions(creator_id);
    CREATE INDEX IF NOT EXISTS ix_ledger_user ON ledger(user_id);
    CREATE INDEX IF NOT EXISTS ix_pay_user ON payments(user_id);
  `);
  try { db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'"); } catch { /* colonne déjà présente */ }
  // Bases créées par une version plus ancienne : on ajoute les colonnes manquantes.
  for (const sql of ['ALTER TABLE payments ADD COLUMN ref TEXT', 'ALTER TABLE payments ADD COLUMN tx_id TEXT']) { try { db.exec(sql); } catch { /* déjà présente */ } }
  return db;
}

export const uid = (p = '') => p + crypto.randomBytes(8).toString('hex');

/** Exécute fn dans une transaction SQLite (BEGIN IMMEDIATE), annule en cas d'erreur. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

export function nextInvoiceNo(db, year = new Date().getFullYear()) {
  const name = 'invoice-' + year;
  db.prepare('INSERT OR IGNORE INTO counters(name,value) VALUES(?,0)').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  const { value } = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  return `FAC-${year}-${String(value).padStart(6, '0')}`;
}

export const balanceOf = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(amount),0) AS b FROM ledger WHERE user_id = ?').get(userId).b;
