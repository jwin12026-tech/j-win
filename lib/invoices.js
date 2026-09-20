import { nextInvoiceNo } from './db.js';

/** Émet une facture (numérotation continue par année) et l'enregistre. À appeler dans une transaction. */
export function issueInvoice(db, cfg, { user, paymentId, kind, label, lines, fee = 0, total, method, providerRef }) {
  const no = nextInvoiceNo(db);
  const issuedAt = Date.now();
  const data = {
    no, issuedAt, kind, label, lines, fee, total, currency: 'XOF', method, providerRef: providerRef || '', status: 'PAYÉ',
    customer: { name: `${user.prenoms || ''} ${user.nom || ''}`.trim(), contact: user.phone ? '+225' + user.phone : '', email: user.email || '', address: user.adresse || '' },
    seller: { ...cfg.company },
    note: 'Les frais de service J-WIN sont indiqués sur la facture. Document généré automatiquement.',
  };
  db.prepare('INSERT INTO invoices(no,user_id,payment_id,data,created_at) VALUES(?,?,?,?,?)').run(no, user.id, paymentId, JSON.stringify(data), issuedAt);
  return data;
}
