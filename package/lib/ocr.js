// OCR côté serveur : Tesseract.js (langues embarquées, aucun téléchargement) + prétraitement sharp.
// Les images ne sont jamais écrites sur disque ni conservées : lecture en mémoire uniquement.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import { parseMrz, parseLabels, mergeIdentity } from './mrz.js';

const require = createRequire(import.meta.url);
let workerP = null;
let queue = Promise.resolve();

function prepareLangDir() {
  const dir = path.resolve('data/tessdata');
  fs.mkdirSync(dir, { recursive: true });
  for (const [pkg, f] of [['@tesseract.js-data/fra', 'fra'], ['@tesseract.js-data/eng', 'eng']]) {
    const src = path.join(path.dirname(require.resolve(pkg + '/package.json')), '4.0.0', f + '.traineddata.gz');
    const dst = path.join(dir, f + '.traineddata.gz');
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
  return dir;
}
function getWorker() {
  workerP ??= createWorker(['fra', 'eng'], 1, { langPath: prepareLangDir(), cachePath: prepareLangDir(), gzip: true });
  return workerP;
}
function run(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

async function prep(buf, { crop, angle = 0 } = {}) {
  let src = buf;
  if (angle) src = await sharp(buf, { failOn: 'none' }).rotate().rotate(angle).toBuffer();
  let img = sharp(src, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  if (crop) img = img.extract({ left: 0, top: Math.floor(meta.height * crop), width: meta.width, height: meta.height - Math.floor(meta.height * crop) });
  return img.grayscale().normalize().resize({ width: 1800 }).sharpen().png().toBuffer();
}
async function ocr(buf, params) {
  return run(async () => {
    const w = await getWorker();
    await w.setParameters(params);
    const { data } = await w.recognize(buf);
    return data.text || '';
  });
}
const MRZ_PARAMS = { tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' };
const TEXT_PARAMS = { tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: '' };

export async function readIdentity({ front, back }) {
  let mrz = null;
  for (const [buf, crop] of [[back, 0.55], [front, 0.6], [back, 0.4], [front, 0.75]]) {
    if (!buf || mrz?.checksOk) continue;
    const text = await ocr(await prep(buf, { crop }), MRZ_PARAMS);
    const r = parseMrz(text.split(/\r?\n/));
    if (r && (!mrz || r.checksOk)) mrz = r;
  }
  // Photo prise de travers (téléphone tenu à l'horizontale) : on retente avec 90°, 270° puis 180°.
  for (const angle of back ? [90, 270, 180] : [90, 270]) {
    if (mrz?.checksOk) break;
    for (const [buf, crop] of [[back, 0.55], [front, 0.6]]) {
      if (!buf || mrz?.checksOk) continue;
      const r = parseMrz((await ocr(await prep(buf, { crop, angle }), MRZ_PARAMS)).split(/\r?\n/));
      if (r && (!mrz || r.checksOk)) mrz = r;
    }
  }
  let labels = null;
  if (front) labels = parseLabels(await ocr(await prep(front), TEXT_PARAMS));
  return mergeIdentity(mrz, labels);
}
export async function closeOcr() { if (workerP) { const w = await workerP; await w.terminate(); workerP = null; } }
