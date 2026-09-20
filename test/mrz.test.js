import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDigit, parseMrz, parseLabels, mergeIdentity } from '../lib/mrz.js';

// Spécimens officiels ICAO 9303
const TD3 = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
const TD1 = ['I<UTOD231458907<<<<<<<<<<<<<<<', '7408122F1204159UTO<<<<<<<<<<<6', 'ERIKSSON<<ANNA<MARIA<<<<<<<<<<'];

test('chiffres de contrôle ICAO', () => {
  assert.equal(checkDigit('L898902C3'), 6);
  assert.equal(checkDigit('740812'), 2);
  assert.equal(checkDigit('D23145890'), 7);
});
test('MRZ passeport (TD3)', () => {
  const r = parseMrz(TD3);
  assert.equal(r.docType, 'passeport'); assert.equal(r.nom, 'ERIKSSON'); assert.equal(r.prenoms, 'ANNA MARIA');
  assert.equal(r.docNumber, 'L898902C3'); assert.equal(r.dob, '1974-08-12'); assert.ok(r.checksOk);
});
test('MRZ carte (TD1)', () => {
  const r = parseMrz(TD1);
  assert.equal(r.docType, 'cni'); assert.equal(r.nom, 'ERIKSSON'); assert.equal(r.docNumber, 'D23145890'); assert.equal(r.dob, '1974-08-12'); assert.ok(r.checksOk);
});
test('MRZ tolérante aux erreurs OCR (O/0, espaces, longueur ±1)', () => {
  const noisy = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO74O8122F12O4159ZE184226B<<<<<10 '];
  const r = parseMrz(noisy);
  assert.equal(r.dob, '1974-08-12'); assert.ok(r.checksOk);
});
test('MRZ absente => null', () => assert.equal(parseMrz(['Bonjour', 'CARTE NATIONALE']), null));
test('libellés imprimés', () => {
  const t = "RÉPUBLIQUE DE CÔTE D'IVOIRE\nCARTE NATIONALE D'IDENTITÉ\nNOM / SURNAME\nKOFFI\nPRÉNOMS / GIVEN NAMES\nAya Marie\nNÉ(E) LE 12/08/1994 À ABIDJAN\nN° C0123456789";
  const r = parseLabels(t);
  assert.equal(r.nom, 'KOFFI'); assert.equal(r.prenoms, 'AYA MARIE'); assert.equal(r.dob, '1994-08-12'); assert.equal(r.docNumber, 'C0123456789');
});
test('fusion : la MRZ vérifiée est prioritaire', () => {
  const m = mergeIdentity(parseMrz(TD3), { nom: 'AUTRE', prenoms: 'X', dob: '2000-01-01', docNumber: 'Z' });
  assert.equal(m.nom, 'ERIKSSON'); assert.equal(m.confidence, 'high');
});
