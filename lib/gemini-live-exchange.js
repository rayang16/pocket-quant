import {createHmac} from 'node:crypto';

// Server-only. Never accept a caller-supplied host, path, method or credentials.
// Verified 2026-10-11 against Gemini's API-key, Subaccounts, List Events and
// Place Order documentation. Private REST parameters belong in signed headers.
const API = 'https://api.gemini.com';
const ORDER_PATH = '/v1/prediction-markets/order';
const EVENTS_PATH = '/v1/prediction-markets/events';
const ORDER_TIMEOUT_MS = 12000;
const MARKET_TIMEOUT_MS = 30000;
const ORDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MARKET_RESPONSE_BYTES = 16 * 1024 * 1024;
const MARKET_CATEGORIES = ['Crypto', 'Economics', 'Business', 'Commodities', 'Tech'];
const MAX_MARKET_PAGES = 10;
const MAX_MARKETS = 5000;
const SCALE = 10n ** 18n;
const MAX_INT64 = 9223372036854775807n;
const ERRORS = {
  CONFIG_REQUIRED: [503, 'Configure a Gemini master API key and secret on the server.'],
  MASTER_KEY_REQUIRED: [503, 'Live trading requires a Gemini master API key.'],
  TIME_NONCE_REQUIRED: [503, 'Confirm time-based nonces and configure GEMINI_LIVE_NONCE_MODE=time.'],
  INVALID_INPUT: [400, 'This live order contains unsupported values.'],
  NONCE_CLOCK: [503, 'The server clock cannot safely produce a Gemini time-based nonce.'],
  BUSY: [409, 'A Gemini order is already being submitted.'],
  TIMEOUT: [504, 'The Gemini request timed out. Check Gemini order history before submitting another order.'],
  UNAVAILABLE: [502, 'Gemini could not confirm the request. Check Gemini order history before submitting another order.'],
  INVALID_RESPONSE: [502, 'Gemini returned an unsupported response. Check Gemini order history before submitting another order.'],
  RATE_LIMIT: [429, 'Gemini could not confirm the request because of a request limit. Check Gemini order history.'],
  MARKET_RESPONSE: [502, 'Gemini returned an unsupported market response.'],
  MARKET_UNAVAILABLE: [502, 'Gemini markets are temporarily unavailable.']
};

/** Only static errors are exposed. ambiguous means an order may have reached Gemini. */
export class LiveExchangeError extends Error {
  constructor(code, ambiguous = false) {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'UNAVAILABLE';
    const [status, message] = ERRORS[safeCode];
    super(message);
    this.name = 'LiveExchangeError';
    this.code = `LIVE_EXCHANGE_${safeCode}`;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}
const fail = code => {throw new LiveExchangeError(code);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const symbol = value => text(value, 128) && /^GEMI-[A-Z0-9][A-Z0-9_-]*$/.test(value) && !value.startsWith('GEMI-CMB-');
const shortname = value => text(value, 128) && /^[A-Za-z0-9_-]+$/.test(value);
const identifier = value => text(value, 128) && /^[A-Za-z0-9_-]+$/.test(value);

function decimal(value) {
  return typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d{0,15})(?:\.\d{1,18})?$/.test(value) ? value : null;
}
function units(value) {
  if (decimal(value) === null) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function quote(value) {
  const parsed = units(value);
  return parsed !== null && parsed > 0n && parsed < SCALE ? Number(value) : null;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function richText(value, depth = 0, budget = {nodes: 0}) {
  if (value === undefined || value === null) return '';
  // Settlement conditions are never silently truncated to fit a review screen.
  if (depth > 8 || ++budget.nodes > 1000) return null;
  if (typeof value === 'string') return value.length > 3000 ? null : value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!object(value) || (value.content !== undefined && !Array.isArray(value.content))
    || (value.value !== undefined && typeof value.value !== 'string')) return null;
  if (value.content?.length > 100) return null;
  const parts = [value.value === undefined ? '' : richText(value.value, depth + 1, budget),
    ...(value.content ?? []).map(row => richText(row, depth + 1, budget))];
  if (parts.includes(null)) return null;
  const joined = parts.filter(Boolean).join(' ');
  return joined.length > 3000 ? null : joined;
}
function marketUrl(event) {
  // Public Gemini event routes use the provider's ticker and slug. Never copy an
  // arbitrary response URL, an image/terms URL, or manufacture a contract URL.
  if (!text(event.ticker, 200) || !/^[A-Z0-9][A-Z0-9_-]*$/.test(event.ticker)
    || !text(event.slug, 300) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.slug)) return null;
  return `https://www.gemini.com/predictions/${event.ticker}/${event.slug}`;
}

function normalizeMarkets(events, currentTime) {
  const markets = new Map(), conflicting = new Set();
  let visited = 0;
  function visit(event, depth = 0) {
    if (++visited > 20000 || depth > 3 || !object(event) || event.status !== 'active') return;
    if (!identifier(event.id) || !text(event.title, 300)) return;
    for (const contract of Array.isArray(event.contracts) ? event.contracts.slice(0, 500) : []) {
      if (!object(contract) || contract.status !== 'active' || contract.marketState !== 'open'
        || contract.isCombo === true || !symbol(contract.instrumentSymbol) || !identifier(contract.id)
        || !text(contract.label, 300)) continue;
      const expiresAt = timestamp(contract.expiryDate ?? event.expiryDate);
      if (!expiresAt || Date.parse(expiresAt) <= currentTime) continue;
      const effective = contract.effectiveDate ?? event.effectiveDate;
      if (effective !== undefined && effective !== null && (!timestamp(effective) || Date.parse(effective) > currentTime)) continue;
      let description = richText(contract.description);
      if (description === '') description = richText(event.description);
      if (description === null) continue;
      const market = {
        symbol: contract.instrumentSymbol, contractId: contract.id, eventId: event.id,
        title: contract.label, eventTitle: event.title,
        description, expiresAt,
        yesAsk: quote(contract.prices?.buy?.yes ?? contract.prices?.bestAsk), noAsk: quote(contract.prices?.buy?.no),
        quantityMinimum: decimal(contract.quantityMinimum), quantityIncrement: decimal(contract.quantityIncrement),
        priceMinimum: decimal(contract.priceMinimum), priceIncrement: decimal(contract.priceIncrement),
        marketUrl: marketUrl(event)
      };
      const prior = markets.get(market.symbol);
      if (prior && (prior.contractId !== market.contractId || prior.expiresAt !== market.expiresAt
        || prior.eventId !== market.eventId || prior.eventTitle !== market.eventTitle
        || prior.title !== market.title || prior.description !== market.description
        || ['quantityMinimum', 'quantityIncrement', 'priceMinimum', 'priceIncrement'].some(key => prior[key] !== market[key]))) {
        conflicting.add(market.symbol);
      }
      if (!prior && markets.size < MAX_MARKETS) markets.set(market.symbol, Object.freeze(market));
    }
    for (const child of Array.isArray(event.events) ? event.events.slice(0, 100) : []) visit(child, depth + 1);
  }
  for (const event of events) visit(event);
  return Object.freeze([...markets.values()].filter(market => !conflicting.has(market.symbol)));
}

function configuration(env) {
  const apiKey = env.GEMINI_LIVE_API_KEY, apiSecret = env.GEMINI_LIVE_API_SECRET;
  if (!text(apiKey, 256) || !text(apiSecret, 4096) || /\s/.test(apiKey) || /\s/.test(apiSecret)) fail('CONFIG_REQUIRED');
  if (!/^master-[A-Za-z0-9_-]+$/.test(apiKey)) fail('MASTER_KEY_REQUIRED');
  if (env.GEMINI_LIVE_NONCE_MODE !== 'time') fail('TIME_NONCE_REQUIRED');
  return {apiKey, apiSecret};
}

async function readBody(response, invalidCode, maximumBytes) {
  if (Number(response.headers?.get?.('content-length')) > maximumBytes) fail(invalidCode);
  if (!response.body?.getReader) {
    const body = await response.text();
    if (typeof body !== 'string' || Buffer.byteLength(body) > maximumBytes) fail(invalidCode);
    return body;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {void reader.cancel().catch(() => {}); fail(invalidCode);}
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {reader.releaseLock();}
}

// Tokenize JSON strings, preserving escapes. Quote numeric orderId tokens BEFORE
// JSON.parse can round int64 IDs. This never searches/replaces inside string values.
function losslessOrderJson(source) {
  let output = '', index = 0;
  while (index < source.length) {
    if (source[index] !== '"') {output += source[index++]; continue;}
    const start = index++;
    while (index < source.length) {
      if (source[index] === '\\') {index += 2; continue;}
      if (source[index++] === '"') break;
    }
    const token = source.slice(start, index);
    output += token;
    if (JSON.parse(token) !== 'orderId') continue;
    let cursor = index;
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    if (source[cursor] !== ':') continue;
    cursor++;
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    if (!/[-0-9]/.test(source[cursor] ?? '')) continue;
    const numberStart = cursor;
    while (cursor < source.length && /[-+0-9.eE]/.test(source[cursor])) cursor++;
    const number = source.slice(numberStart, cursor);
    if (!/^(?:0|[1-9]\d*)$/.test(number)) fail('INVALID_RESPONSE');
    output += source.slice(index, numberStart) + JSON.stringify(number);
    index = cursor;
  }
  return JSON.parse(output);
}

function validateOrder(input) {
  if (!object(input) || Object.keys(input).some(key => !['accountShortname', 'order'].includes(key)) || !shortname(input.accountShortname)) fail('INVALID_INPUT');
  const order = input.order;
  if (!object(order) || Object.keys(order).some(key => !['symbol', 'outcome', 'quantity', 'price', 'side', 'orderType', 'timeInForce'].includes(key))
    || !symbol(order.symbol) || !['yes', 'no'].includes(order.outcome)
    || typeof order.quantity !== 'string' || !/^[1-9]\d{0,8}$/.test(order.quantity)
    || typeof order.price !== 'string' || !/^0\.\d{2}$/.test(order.price) || units(order.price) <= 0n || units(order.price) >= SCALE
    || (order.side !== undefined && order.side !== 'buy') || (order.orderType !== undefined && order.orderType !== 'limit')
    || (order.timeInForce !== undefined && order.timeInForce !== 'immediate-or-cancel')) fail('INVALID_INPUT');
  return {account: input.accountShortname, symbol: order.symbol, outcome: order.outcome, quantity: order.quantity,
    price: order.price, side: 'buy', orderType: 'limit', timeInForce: 'immediate-or-cancel'};
}

function orderResult(data, expected) {
  if (!object(data) || typeof data.orderId !== 'string' || !/^[1-9]\d{0,18}$/.test(data.orderId) || BigInt(data.orderId) > MAX_INT64
    || !['open', 'filled', 'cancelled'].includes(data.status)
    || data.symbol !== expected.symbol || data.side !== 'buy' || data.outcome !== expected.outcome || data.orderType !== 'limit'
    || (data.timeInForce !== undefined && data.timeInForce !== 'immediate-or-cancel')) fail('INVALID_RESPONSE');
  const quantity = units(data.quantity), filled = units(data.filledQuantity), remaining = units(data.remainingQuantity), price = units(data.price);
  if (quantity === null || filled === null || remaining === null || price === null || quantity !== units(expected.quantity)
    || price !== units(expected.price) || filled > quantity || remaining > quantity || filled + remaining !== quantity
    || (data.status === 'filled' && (filled !== quantity || remaining !== 0n))) fail('INVALID_RESPONSE');
  let avgExecutionPrice = null;
  if (data.avgExecutionPrice !== undefined && data.avgExecutionPrice !== null) {
    const average = units(data.avgExecutionPrice);
    if (average === null || average > price || (filled > 0n && average === 0n)) fail('INVALID_RESPONSE');
    avgExecutionPrice = data.avgExecutionPrice;
  }
  const dates = {};
  for (const key of ['createdAt', 'updatedAt', 'cancelledAt']) {
    dates[key] = data[key] === undefined || data[key] === null ? null : timestamp(data[key]);
    if (data[key] !== undefined && data[key] !== null && dates[key] === null) fail('INVALID_RESPONSE');
  }
  return Object.freeze({orderId: data.orderId, status: data.status, symbol: expected.symbol, side: 'buy', outcome: expected.outcome,
    orderType: 'limit', quantity: expected.quantity, price: expected.price, filledQuantity: data.filledQuantity,
    remainingQuantity: data.remainingQuantity, avgExecutionPrice, ...dates});
}

/**
 * Production-only transport; configuration is read lazily. markets() is public.
 * placeOrder() must only receive a server-verified account and confirmed order.
 * Authorization, durable deduplication, terms, balance and grid checks belong to
 * the caller. No retries occur, including after a rate limit or ambiguous result.
 */
export function createGeminiLiveExchange({env = process.env, fetchImpl = globalThis.fetch,
  now = Date.now, waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  let lastNonce = -1, orderInFlight = false, marketsInFlight = null;

  async function nonce() {
    let time = now();
    if (!Number.isSafeInteger(time) || time < 1000) fail('NONCE_CLOCK');
    if (Math.floor(time / 1000) <= lastNonce) {
      if (lastNonce - Math.floor(time / 1000) >= 30) fail('NONCE_CLOCK');
      await waitImpl((lastNonce + 1) * 1000 - time);
      time = now();
    }
    const value = Math.floor(time / 1000);
    if (!Number.isSafeInteger(time) || value <= lastNonce || value < 1) fail('NONCE_CLOCK');
    lastNonce = value;
    return value;
  }

  async function bounded(operation, marketRead = false) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {timer = setTimeout(() => {
      controller.abort(); reject(new LiveExchangeError(marketRead ? 'MARKET_UNAVAILABLE' : 'TIMEOUT'));
    }, marketRead ? MARKET_TIMEOUT_MS : ORDER_TIMEOUT_MS);});
    try {return await Promise.race([deadline, operation(controller.signal)]);}
    catch (error) {
      controller.abort();
      if (error instanceof LiveExchangeError) throw error;
      fail(marketRead ? 'MARKET_UNAVAILABLE' : 'UNAVAILABLE');
    } finally {clearTimeout(timer);}
  }

  async function loadMarkets() {
    return bounded(async signal => {
      const events = [];
      for (let page = 0; page < MAX_MARKET_PAGES; page++) {
        const offset = page * 100;
        const query = new URLSearchParams({status: 'active', limit: '100', offset: String(offset)});
        for (const category of MARKET_CATEGORIES) query.append('category', category);
        const url = `${API}${EVENTS_PATH}?${query}`;
        const response = await fetchImpl(url, {method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error', signal});
        if (signal.aborted) fail('MARKET_UNAVAILABLE');
        if (response.redirected || (response.url && response.url !== url)) fail('MARKET_RESPONSE');
        if (!response.ok) fail('MARKET_UNAVAILABLE');
        let data;
        try {data = JSON.parse(await readBody(response, 'MARKET_RESPONSE', MARKET_RESPONSE_BYTES));}
        catch {fail('MARKET_RESPONSE');}
        if (!object(data) || !Array.isArray(data.data) || data.data.length > 100) fail('MARKET_RESPONSE');
        const pagination = data.pagination;
        if (pagination !== undefined && (!object(pagination) || pagination.offset !== offset || pagination.limit !== 100
          || !Number.isSafeInteger(pagination.total) || pagination.total < 0)) fail('MARKET_RESPONSE');
        events.push(...data.data);
        if (!data.data.length || data.data.length < 100 || (pagination && offset + data.data.length >= pagination.total)) break;
        if (signal.aborted) fail('MARKET_UNAVAILABLE');
      }
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || currentTime < 1000) fail('NONCE_CLOCK');
      return normalizeMarkets(events, currentTime);
    }, true);
  }

  async function placeOrder(input) {
    const order = validateOrder(input), config = configuration(env);
    if (orderInFlight) fail('BUSY');
    orderInFlight = true;
    let attempted = false;
    try {
      return await bounded(async signal => {
        const value = await nonce();
        if (signal.aborted) fail('TIMEOUT');
        const payload = Buffer.from(JSON.stringify({request: ORDER_PATH, nonce: value, ...order})).toString('base64');
        const headers = {'X-GEMINI-APIKEY': config.apiKey, 'X-GEMINI-PAYLOAD': payload,
          'X-GEMINI-SIGNATURE': createHmac('sha384', config.apiSecret).update(payload).digest('hex'),
          'Content-Type': 'text/plain', 'Content-Length': '0', 'Cache-Control': 'no-cache'};
        attempted = true;
        const response = await fetchImpl(API + ORDER_PATH, {method: 'POST', headers, body: '', redirect: 'error', signal});
        if (response.redirected || (response.url && response.url !== API + ORDER_PATH)) fail('INVALID_RESPONSE');
        let data;
        try {data = losslessOrderJson(await readBody(response, 'INVALID_RESPONSE', ORDER_RESPONSE_BYTES));}
        catch {fail('INVALID_RESPONSE');}
        if (!response.ok || data?.result === 'error' || data?.error) fail(response.status === 429 ? 'RATE_LIMIT' : 'UNAVAILABLE');
        return orderResult(data, order);
      });
    } catch (error) {
      // Provider errors can be proxies, stale responses, or uncertain delivery;
      // keep the caller's durable attempt consumed even for an apparent reject.
      if (error instanceof LiveExchangeError) {error.ambiguous = attempted; throw error;}
      throw new LiveExchangeError('UNAVAILABLE', attempted);
    } finally {orderInFlight = false;}
  }

  return Object.freeze({markets(...args) {
    if (args.length) return Promise.reject(new LiveExchangeError('INVALID_INPUT'));
    if (!marketsInFlight) marketsInFlight = loadMarkets().finally(() => {marketsInFlight = null;});
    return marketsInFlight;
  }, placeOrder});
}
