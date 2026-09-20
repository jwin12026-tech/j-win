// Configuration lue depuis les variables d'environnement (voir .env.example).
const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(overrides = {}) {
  const prod = env.NODE_ENV === 'production';
  if (prod && !env.JWT_SECRET) throw new Error('JWT_SECRET est obligatoire en production.');
  const apiKey = env.CINETPAY_API_KEY || '';
  const cfg = {
    prod,
    port: int(env.PORT, 3000),
    publicUrl: (env.PUBLIC_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
    jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
    corsOrigin: env.CORS_ORIGIN || '',            // ex. https://jwin.exemple.ci (vide = même origine)
    dbFile: env.DB_FILE || './data/jwin.db',
    // Frais J-WIN, en % du montant. À valider avec votre comptable / votre juriste.
    fees: { recharge: int(env.FEE_RECHARGE_PCT, 1), withdraw: int(env.FEE_WITHDRAW_PCT, 1), mission: int(env.FEE_MISSION_PCT, 1) },
    limits: { rechargeMin: 100, rechargeMax: 2500000, withdrawMin: 500, withdrawMax: 1500000 },
    cinetpay: {
      apiKey,
      apiPassword: env.CINETPAY_API_PASSWORD || '',
      // sk_test_… => bac à sable ; sk_live_… => production
      baseUrl: env.CINETPAY_BASE_URL || (apiKey.startsWith('sk_live_') ? 'https://api.cinetpay.co' : 'https://api.cinetpay.net'),
      fallbackEmail: env.PAYER_FALLBACK_EMAIL || 'paiements@jwin.example',
    },
    otp: {
      mode: env.OTP_MODE || 'console',            // console | twilio
      ttlMs: int(env.OTP_TTL_SECONDS, 300) * 1000,
      resendMs: int(env.OTP_RESEND_SECONDS, 45) * 1000,
      maxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID || '',
        authToken: env.TWILIO_AUTH_TOKEN || '',
        messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || '',
        smsFrom: env.TWILIO_SMS_FROM || '',
        whatsappFrom: env.TWILIO_WHATSAPP_FROM || '',              // ex. +14155238886
        whatsappContentSid: env.TWILIO_WHATSAPP_CONTENT_SID || '', // modèle « authentification » approuvé
      },
    },
    adminEmail: env.ADMIN_EMAIL || 'jwin1.2026@gmail.com',      // reçoit les demandes d'approbation, de dépôt et de retrait
    adminPhone: env.ADMIN_PHONE || '0788330248',                 // alerte SMS de l'administrateur (si Twilio est configuré)
    adminOm: env.ADMIN_OM_NUMBER || '+225 07 88 33 02 48',       // numéro Orange Money qui reçoit les dépôts
    paymentMode: env.PAYMENT_MODE || 'manual',                   // manual = dépôts/retraits validés par l'administrateur ; cinetpay = automatique
    uploadDir: env.UPLOAD_DIR || './data/uploads',
    smtp: {
      host: env.SMTP_HOST || '', port: int(env.SMTP_PORT, 465), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '',
      from: env.SMTP_FROM || '', json: false,                    // json = mode test (aucun envoi)
    },
    plan: { create: int(env.PLAN_CREATE_LIMIT, 100), do: int(env.PLAN_DO_LIMIT, 50), unverified: int(env.PLAN_UNVERIFIED_LIMIT, 3), days: 90 },
    adminPassword: env.ADMIN_PASSWORD || '',                     // mot de passe de la console /admin (vide = console désactivée)
    banner: '', maintenance: false,
    requireEmail: true,
    kycMode: env.KYC_MODE || 'manual',   // auto : compte vérifié dès l'inscription ; manual : l'administrateur valide chaque identité (lien reçu par e-mail)
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    ocrEnabled: env.OCR_ENABLED !== 'false',
    company: {
      name: env.COMPANY_NAME || 'J-WIN',
      address: env.COMPANY_ADDRESS || 'Abidjan, Cocody, Côte d\'Ivoire',
      rccm: env.COMPANY_RCCM || '',
      ncc: env.COMPANY_NCC || '',
      contact: env.COMPANY_CONTACT || '',
    },
  };
  return deepMerge(cfg, overrides);
}

function deepMerge(a, b) {
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]);
    else a[k] = b[k];
  }
  return a;
}
