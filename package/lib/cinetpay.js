// Client CinetPay API v1 (paiements + transferts). Endpoints vérifiés dans le SDK officiel cinetpay-python :
//   POST /v1/oauth/login  {api_key, api_password} -> {access_token}
//   POST /v1/payment       GET /v1/payment/{merchant_transaction_id | transaction_id | payment_token}
//   POST /v1/transfer      GET /v1/transfer/{transaction_id}
//   GET  /v1/balances
// Jeton JWT en « Authorization: Bearer ». Sandbox : api.cinetpay.net (clés sk_test_), production : api.cinetpay.co (sk_live_).

export const METHOD_CODES = { orange: 'OM_CI', mtn: 'MTN_CI', moov: 'MOOV_CI', wave: 'WAVE_CI' };

export class CinetPayError extends Error {
  constructor(message, { status, code, apiStatus, description } = {}) {
    super(message); this.name = 'CinetPayError';
    Object.assign(this, { httpStatus: status, code, apiStatus, description });
  }
}

/** SUCCESS | PENDING | FAILED */
export function mapStatus(s) {
  if (s === 'SUCCESS') return 'SUCCESS';
  if (['INITIATED', 'PENDING', 'OK'].includes(s)) return 'PENDING';
  return 'FAILED';
}

export class CinetPay {
  constructor({ apiKey, apiPassword, baseUrl, fetchImpl = fetch, tokenTtlMs = 23 * 3600e3 }) {
    Object.assign(this, { apiKey, apiPassword, baseUrl: baseUrl.replace(/\/$/, ''), fetchImpl, tokenTtlMs });
    this._token = null; this._exp = 0;
  }
  get configured() { return !!(this.apiKey && this.apiPassword); }

  async _raw(method, path, body, token) {
    let res;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) { throw new CinetPayError('Réseau CinetPay indisponible : ' + e.message); }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }
  async token(force = false) {
    if (!this.configured) throw new CinetPayError('CinetPay n\'est pas configuré (CINETPAY_API_KEY / CINETPAY_API_PASSWORD).');
    if (!force && this._token && Date.now() < this._exp) return this._token;
    const { res, data } = await this._raw('POST', '/v1/oauth/login', { api_key: this.apiKey, api_password: this.apiPassword });
    if (!res.ok || !data.access_token) throw new CinetPayError('Authentification CinetPay refusée.', { status: res.status });
    this._token = data.access_token; this._exp = Date.now() + this.tokenTtlMs;
    return this._token;
  }
  async call(method, path, body) {
    let { res, data } = await this._raw(method, path, body, await this.token());
    if (data && (data.status === 'EXPIRED_TOKEN' || data.code === 1003)) ({ res, data } = await this._raw(method, path, body, await this.token(true)));
    if (!res.ok || (data.status && ['INVALID_PARAMS', 'INVALID_CREDENTIALS', 'INVALID_TOKEN', 'TRANSACTION_EXIST', 'NOT_ALLOWED'].includes(data.status))) {
      throw new CinetPayError(data.description || data.message || `Erreur CinetPay ${res.status}`, { status: res.status, code: data.code, apiStatus: data.status, description: data.description });
    }
    return data;
  }
  initPayment(body) { return this.call('POST', '/v1/payment', body); }
  paymentStatus(id) { return this.call('GET', '/v1/payment/' + encodeURIComponent(id)); }
  createTransfer(body) { return this.call('POST', '/v1/transfer', body); }
  transferStatus(id) { return this.call('GET', '/v1/transfer/' + encodeURIComponent(id)); }
  balance() { return this.call('GET', '/v1/balances'); }
}
