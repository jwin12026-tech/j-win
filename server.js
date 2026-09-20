import { loadConfig } from './lib/config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
let readIdentity = null;
if (cfg.ocrEnabled) ({ readIdentity } = await import('./lib/ocr.js'));
const app = createApp({ cfg, readIdentity });
app.listen(cfg.port, () => {
  console.log(`J-WIN API sur ${cfg.publicUrl} (port ${cfg.port}) · OTP: ${cfg.otp.mode} · CinetPay: ${cfg.cinetpay.apiKey ? cfg.cinetpay.baseUrl : 'NON CONFIGURÉ'} · OCR: ${readIdentity ? 'oui' : 'non'}`);
});
