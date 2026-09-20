// Lecture de la zone MRZ (ICAO 9303, TD1 = cartes 3×30, TD3 = passeports 2×44) et des libellés imprimés.
const W = [7, 3, 1];
export function checkDigit(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const v = c === '<' ? 0 : c >= '0' && c <= '9' ? Number(c) : c.charCodeAt(0) - 55;
    sum += v * W[i % 3];
  }
  return sum % 10;
}
const DIGIT_FIX = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const fixDigits = (s) => s.replace(/[A-Z]/g, (c) => DIGIT_FIX[c] ?? c);
const okCheck = (field, digit) => /^\d$/.test(digit) && checkDigit(field) === Number(digit);

export function cleanMrzLine(l) {
  return String(l).toUpperCase().replace(/[«‹〈»]/g, '<').replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, '<');
}
function fit(l, n) { return l.length >= n - 1 && l.length <= n + 2 ? l.slice(0, n).padEnd(n, '<') : null; }

export function isoFromYYMMDD(s) {
  s = fixDigits(s);
  if (!/^\d{6}$/.test(s)) return null;
  const yy = Number(s.slice(0, 2)), mm = s.slice(2, 4), dd = s.slice(4, 6);
  const cur = new Date().getFullYear() % 100;
  const year = yy > cur ? 1900 + yy : 2000 + yy;
  const d = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
  if (d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) return null;
  return `${year}-${mm}-${dd}`;
}
function names(field) {
  const parts = field.split('<<');
  const clean = (s) => (s || '').replace(/</g, ' ').replace(/\s+/g, ' ').trim();
  return { nom: clean(parts[0]), prenoms: clean(parts.slice(1).join(' ')) };
}

/** @param {string[]} rawLines lignes brutes issues de l'OCR */
export function parseMrz(rawLines) {
  const lines = rawLines.map(cleanMrzLine).filter((l) => l.length >= 28);
  // TD3 (passeport)
  for (let i = 0; i < lines.length - 1; i++) {
    const a = fit(lines[i], 44), b = fit(lines[i + 1], 44);
    if (a && b && a[0] === 'P') {
      const num = b.slice(0, 9), dob = fixDigits(b.slice(13, 19));
      const valid = { docNumber: okCheck(num, fixDigits(b[9])), dob: okCheck(dob, fixDigits(b[19])) };
      return { source: 'mrz', docType: 'passeport', docNumber: num.replace(/</g, ''), ...names(a.slice(5)), dob: isoFromYYMMDD(dob), sex: b[20] === 'M' || b[20] === 'F' ? b[20] : '', valid, checksOk: valid.docNumber && valid.dob };
    }
  }
  // TD1 (carte d'identité)
  for (let i = 0; i < lines.length - 2; i++) {
    const a = fit(lines[i], 30), b = fit(lines[i + 1], 30), c = fit(lines[i + 2], 30);
    if (a && b && c && (a[0] === 'I' || a[0] === 'A' || a[0] === 'C')) {
      const num = a.slice(5, 14), dob = fixDigits(b.slice(0, 6));
      const valid = { docNumber: okCheck(num, fixDigits(a[14])), dob: okCheck(dob, fixDigits(b[6])) };
      return { source: 'mrz', docType: 'cni', docNumber: num.replace(/</g, ''), ...names(c), dob: isoFromYYMMDD(dob), sex: b[7] === 'M' || b[7] === 'F' ? b[7] : '', valid, checksOk: valid.docNumber && valid.dob };
    }
  }
  return null;
}

const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const nameClean = (v) => strip(v || '').replace(/[^A-Za-z\s'\-]/g, ' ').replace(/\s+/g, ' ').trim();
const DATE_RE = /([0-3]?\d)\s*[\/.\-\s]\s*([01]?\d)\s*[\/.\-\s]\s*((?:19|20)\d{2})/;

/** Repli : lecture des libellés imprimés (NOM, PRÉNOMS, NÉ(E) LE…). */
export function parseLabels(text) {
  const raw = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const up = raw.map((l) => strip(l).toUpperCase());
  const out = { source: 'labels' };
  const valueAt = (i, re) => {
    const m = up[i].match(re);
    let v = m ? m[m.length - 1].replace(/^[\s:\/.\-]+/, '').trim() : '';
    if (!v || v.length < 2) v = (raw[i + 1] && !/^(PRENOM|NOM|NE|DATE|SEXE|TAILLE|LIEU|N°)/i.test(strip(raw[i + 1])) ? raw[i + 1] : '');
    return nameClean(v).toUpperCase();
  };
  up.forEach((l, i) => {
    if (!out.nom && /^(NOM|SURNAME)\b/.test(l) && !/JEUNE|MAIDEN|USAGE/.test(l)) out.nom = valueAt(i, /^(?:NOM(?:\s*\/\s*SURNAME)?|SURNAME)\b(.*)$/);
    if (!out.prenoms && /^(PRENOMS?|GIVEN\s*NAMES?)\b/.test(l)) out.prenoms = valueAt(i, /^(?:PRENOMS?(?:\s*\/\s*GIVEN\s*NAMES?)?|GIVEN\s*NAMES?)\b(.*)$/);
    if (!out.dob && /(NE\(?E?\)?\s*LE|DATE\s*DE\s*NAISS|DATE\s*OF\s*BIRTH|\bDOB\b)/.test(l)) {
      const m = (l + ' ' + (up[i + 1] || '')).match(DATE_RE);
      if (m) out.dob = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  });
  const all = up.join(' ');
  const cni = all.match(/\b([A-Z]\s?\d{10}|\d{11})\b/);
  if (cni) { out.docNumber = cni[1].replace(/\s/g, ''); out.docType = 'cni'; }
  else { const p = all.match(/\b([A-Z]{1,2}\d{6,8})\b/); if (p) { out.docNumber = p[1]; out.docType = 'passeport'; } }
  return out;
}

/** Fusionne MRZ (prioritaire quand les chiffres de contrôle sont bons) et libellés. */
export function mergeIdentity(mrz, labels) {
  const pick = (k) => (mrz && mrz.checksOk && mrz[k]) || (labels && labels[k]) || (mrz && mrz[k]) || '';
  const res = { nom: pick('nom'), prenoms: pick('prenoms'), dob: pick('dob'), docNumber: pick('docNumber'), docType: pick('docType'), sex: (mrz && mrz.sex) || '' };
  const found = ['nom', 'prenoms', 'dob', 'docNumber'].filter((k) => res[k]).length;
  res.confidence = mrz && mrz.checksOk ? 'high' : found >= 3 ? 'medium' : found ? 'low' : 'none';
  res.source = mrz ? (labels ? 'mrz+labels' : 'mrz') : labels ? 'labels' : 'none';
  return res;
}
