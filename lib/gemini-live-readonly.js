import {createHash, createHmac} from 'node:crypto';

// Deliberately private and fixed: neither configuration nor a browser request can
// select another host, path, HTTP method, or a funds/order mutation.
const API = 'https://api.gemini.com';
const TIMEOUT_MS = 12000;
const RESPONSE_BYTES = 262144;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const ROUTES = new Map([
  ['/v1/roles', 'POST'],
  ['/v1/account/list', 'POST'],
  ['/v1/balances', 'POST'],
  ['/v1/prediction-markets/terms/status', 'GET']
]);
const PROVIDER_REASONS = new Set([
  'InvalidApiKey', 'InvalidSignature', 'InvalidNonce', 'MissingRole',
  'AccountNotFound', 'AccountClosed', 'RateLimit', 'Maintenance', 'System'
]);
const ERRORS = {
  CONFIG_REQUIRED: [503, 'Configure a personal Gemini master API key and secret on the server.'],
  MASTER_KEY_REQUIRED: [503, 'This read-only connection requires a Gemini master API key.'],
  TIME_NONCE_REQUIRED: [503, 'Confirm time-based nonces for this Gemini key, then set GEMINI_LIVE_NONCE_MODE=time on the server.'],
  INVALID_ACCOUNT_CONFIG: [503, 'Set GEMINI_LIVE_ACCOUNT to a verified open exchange account on the server.'],
  INVALID_INPUT: [400, 'Account selection is managed by the server.'],
  NONCE_CLOCK: [503, 'The server clock cannot safely produce a Gemini time-based nonce.'],
  AUTHENTICATION: [401, 'Gemini could not authenticate this read-only connection. Check the server configuration.'],
  PERMISSION: [403, 'Gemini did not permit this account read. Check the API key permissions.'],
  RATE_LIMIT: [429, 'Gemini is receiving too many requests. Please wait before checking again.'],
  TIMEOUT: [504, 'The Gemini account check timed out. Please try again later.'],
  UNAVAILABLE: [502, 'Gemini could not complete this read-only account check.'],
  INVALID_RESPONSE: [502, 'Gemini returned an unsupported account response.'],
  NO_OPEN_ACCOUNT: [409, 'No open Gemini exchange account is available for this connection.'],
  ACCOUNT_LIST_INCOMPLETE: [409, 'The Gemini account list cannot be safely selected automatically.'],
  ACCOUNT_NOT_AVAILABLE: [409, 'The configured Gemini account is not a verified open exchange account.'],
  INVALID_BALANCE: [502, 'Gemini did not return a valid available USD balance.']
};

/** Safe to report: message, code, status and optional reason are all allowlisted. */
export class LiveReadonlyError extends Error {
  constructor(code, reason) {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'UNAVAILABLE';
    const [status, message] = ERRORS[safeCode];
    super(message);
    this.name = 'LiveReadonlyError';
    this.status = status;
    this.code = `LIVE_ACCOUNT_${safeCode}`;
    if (PROVIDER_REASONS.has(reason)) this.reason = reason;
  }
}
const fail = (code, reason) => {throw new LiveReadonlyError(code, reason);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const accountName = value => text(value, 128) && /^[A-Za-z0-9_-]+$/.test(value);

function configuration(env) {
  const apiKey = env.GEMINI_LIVE_API_KEY, apiSecret = env.GEMINI_LIVE_API_SECRET;
  if (!text(apiKey, 256) || !text(apiSecret, 4096) || /\s/.test(apiKey) || /\s/.test(apiSecret)) fail('CONFIG_REQUIRED');
  if (!/^master-[A-Za-z0-9_-]+$/.test(apiKey)) fail('MASTER_KEY_REQUIRED');
  // Monotonic nonces need shared durable coordination across serverless instances.
  // This adapter supports only keys explicitly configured for time-based nonces.
  if (env.GEMINI_LIVE_NONCE_MODE !== 'time') fail('TIME_NONCE_REQUIRED');
  const account = env.GEMINI_LIVE_ACCOUNT;
  if (account !== undefined && account !== '' && !accountName(account)) fail('INVALID_ACCOUNT_CONFIG');
  return {apiKey, apiSecret, account: account || null};
}

async function readBody(response) {
  if (Number(response.headers?.get?.('content-length')) > RESPONSE_BYTES) fail('INVALID_RESPONSE');
  if (!response.body?.getReader) {
    const body = await response.text();
    if (typeof body !== 'string' || Buffer.byteLength(body) > RESPONSE_BYTES) fail('INVALID_RESPONSE');
    return body;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_BYTES) {void reader.cancel().catch(() => {}); fail('INVALID_RESPONSE');}
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {reader.releaseLock();}
}

function rolesFrom(data) {
  const keys = ['isAuditor', 'isTrader', 'isFundManager', 'isAccountAdmin'];
  if (!object(data) || keys.some(key => typeof data[key] !== 'boolean')) fail('INVALID_RESPONSE');
  return Object.freeze(Object.fromEntries(keys.map(key => [key, data[key]])));
}

function selectedAccount(data, selected) {
  if (!Array.isArray(data) || data.length > 500) fail('INVALID_RESPONSE');
  // Hitting the request limit cannot establish that the list is complete.
  if (data.length === 500) fail('ACCOUNT_LIST_INCOMPLETE');
  const names = new Set(), open = [];
  for (const account of data) {
    if (!object(account) || !accountName(account.account) || names.has(account.account)
      || !text(account.type, 64) || !text(account.status, 64)) fail('INVALID_RESPONSE');
    names.add(account.account);
    if (account.type === 'exchange' && account.status === 'open') open.push(account);
  }
  if (selected) {
    const account = open.find(value => value.account === selected);
    if (!account) fail('ACCOUNT_NOT_AVAILABLE');
    return account;
  }
  if (!open.length) fail('NO_OPEN_ACCOUNT');
  return open.length === 1 ? open[0] : null;
}

function identityFrom(account) {
  const raw = account.counterparty_id;
  const id = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? String(raw) : raw;
  if (!text(id, 256) || id.trim() !== id || !text(account.name, 256)) fail('INVALID_RESPONSE');
  return {
    accountIdentity: createHash('sha256').update('pocket-quant:gemini:production:counterparty:v1\0').update(id).digest('hex'),
    accountLabel: account.name.slice(0, 80)
  };
}

function availableUsdFrom(data) {
  if (!Array.isArray(data)) fail('INVALID_BALANCE');
  if (data.length === 0) return '0.00';
  if (data.some(row => !object(row) || !text(row.currency, 40))) fail('INVALID_BALANCE');
  const usd = data.filter(row => row.currency === 'USD');
  if (usd.length !== 1) fail('INVALID_BALANCE');
  const value = usd[0].available;
  if (typeof value !== 'string' || value.length > 128 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) fail('INVALID_BALANCE');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  if (cents > MAX_SAFE_CENTS) fail('INVALID_BALANCE');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/**
 * @typedef {object} LiveAccountSnapshot
 * @property {{isAuditor:boolean,isTrader:boolean,isFundManager:boolean,isAccountAdmin:boolean}} roles
 * @property {boolean} accountSelectionRequired Configure GEMINI_LIVE_ACCOUNT when true.
 * @property {string|null} accountIdentity Private server identity; do not send to the browser.
 * @property {string|null} accountLabel Private account display name; expose only after local authentication.
 * @property {string|null} availableUsd Exact decimal USD string floored to cents; excludes pending funds.
 * @property {boolean|null} termsAccepted Whether the latest prediction-market terms were accepted.
 */

/**
 * Server-only, read-only personal-key connection. No credential files are read.
 * `now` returns Unix milliseconds. `waitImpl` is injectable for deterministic tests.
 * Concurrent snapshot calls share an in-flight check; there are no HTTP retries.
 * @returns {{snapshot: () => Promise<LiveAccountSnapshot>}}
 */
export function createGeminiLiveReadonly({env = process.env, fetchImpl = globalThis.fetch,
  now = Date.now, waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  let lastNonce = -1, inFlight = null;

  async function nonce() {
    let timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1000) fail('NONCE_CLOCK');
    // Use real elapsed Unix seconds, never a synthetic future sequence. A single
    // in-flight snapshot serializes all signed requests within this instance.
    if (Math.floor(timestamp / 1000) <= lastNonce) {
      if (lastNonce - Math.floor(timestamp / 1000) >= 30) fail('NONCE_CLOCK');
      await waitImpl((lastNonce + 1) * 1000 - timestamp);
      timestamp = now();
    }
    const value = Math.floor(timestamp / 1000);
    if (!Number.isSafeInteger(timestamp) || value <= lastNonce || value < 1) fail('NONCE_CLOCK');
    lastNonce = value;
    return value;
  }

  async function request(config, path, parameters = {}) {
    const method = ROUTES.get(path);
    if (!method) fail('INVALID_INPUT');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {timer = setTimeout(() => {
      controller.abort(); reject(new LiveReadonlyError('TIMEOUT'));
    }, TIMEOUT_MS);});
    try {
      return await Promise.race([deadline, (async () => {
        const value = await nonce();
        if (controller.signal.aborted) fail('TIMEOUT');
        const payload = Buffer.from(JSON.stringify({request: path, nonce: value, ...parameters})).toString('base64');
        const headers = {
          'X-GEMINI-APIKEY': config.apiKey,
          'X-GEMINI-PAYLOAD': payload,
          'X-GEMINI-SIGNATURE': createHmac('sha384', config.apiSecret).update(payload).digest('hex'),
          'Content-Type': 'text/plain', 'Cache-Control': 'no-cache'
        };
        const options = {method, headers, redirect: 'error', signal: controller.signal};
        if (method === 'POST') {headers['Content-Length'] = '0'; options.body = '';}
        const response = await fetchImpl(API + path, options);
        if (response.redirected || (response.url && response.url !== API + path)) fail('INVALID_RESPONSE');
        let data;
        try {data = JSON.parse(await readBody(response));}
        catch (error) {if (error instanceof LiveReadonlyError) throw error; fail('INVALID_RESPONSE');}
        if (!response.ok || data?.result === 'error') {
          const reason = PROVIDER_REASONS.has(data?.reason) ? data.reason : undefined;
          if (response.status === 429 || reason === 'RateLimit') fail('RATE_LIMIT', reason);
          if (response.status === 403 || reason === 'MissingRole') fail('PERMISSION', reason);
          if (response.status === 401 || ['InvalidApiKey', 'InvalidSignature', 'InvalidNonce'].includes(reason)) fail('AUTHENTICATION', reason);
          fail('UNAVAILABLE', reason);
        }
        return data;
      })()]);
    } catch (error) {
      controller.abort();
      if (error instanceof LiveReadonlyError) throw error;
      fail('UNAVAILABLE');
    } finally {clearTimeout(timer);}
  }

  async function readSnapshot() {
    const config = configuration(env);
    const roles = rolesFrom(await request(config, '/v1/roles'));
    const account = selectedAccount(await request(config, '/v1/account/list', {limit_accounts: 500}), config.account);
    if (!account) return Object.freeze({roles, accountSelectionRequired: true, accountIdentity: null,
      accountLabel: null, availableUsd: null, termsAccepted: null});
    const identity = identityFrom(account);
    const availableUsd = availableUsdFrom(await request(config, '/v1/balances', {account: account.account, showPendingBalances: false}));
    const terms = await request(config, '/v1/prediction-markets/terms/status', {account: account.account});
    if (!object(terms) || typeof terms.hasAcceptedLatest !== 'boolean') fail('INVALID_RESPONSE');
    return Object.freeze({roles, accountSelectionRequired: false, ...identity, availableUsd, termsAccepted: terms.hasAcceptedLatest});
  }

  return Object.freeze({snapshot(...args) {
    if (args.length) return Promise.reject(new LiveReadonlyError('INVALID_INPUT'));
    if (!inFlight) inFlight = readSnapshot().finally(() => {inFlight = null;});
    return inFlight;
  }});
}
