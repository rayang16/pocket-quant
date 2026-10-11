import {randomBytes as cryptoRandomBytes} from 'node:crypto';
import {reviewLiveOrder} from './live-order-policy.js';

const MAX_BUDGET_CENTS = 500;
const PREVIEW_MS = 120000;
const EXCHANGE_STATUSES = new Set(['open', 'filled', 'cancelled']);
const ERRORS = {
  INVALID_INPUT: [400, 'Use only the fields shown on this order ticket.'],
  SESSION_EXPIRED: [401, 'Unlock the private account dashboard again.'],
  STORE_UNAVAILABLE: [503, 'Durable order storage is unavailable. No new order can be authorized.'],
  ACCOUNT_UNAVAILABLE: [503, 'The selected Gemini account could not be verified.'],
  ACCOUNT_SELECTION_REQUIRED: [409, 'Select a verified Gemini account in the server configuration.'],
  TRADER_REQUIRED: [403, 'The Gemini connection must have the Trader role.'],
  TERMS_REQUIRED: [409, 'Accept the latest prediction-market terms directly in Gemini.'],
  MARKET_UNAVAILABLE: [409, 'This contract is unavailable or does not support this live demo.'],
  MARKET_CHANGED: [409, 'The contract changed after review. Review a new order before confirming.'],
  INVALID_GRID: [400, 'The quantity or limit price does not match this contract’s trading increments.'],
  INVALID_QUANTITY: [400, 'Choose 1 to 100 whole contracts.'],
  INVALID_QUANTITY_INCREMENT: [409, 'The contract quantity increment could not be verified for this fee allowance.'],
  INVALID_PRICE: [400, 'Enter a limit price from $0.01 to $0.99 in whole cents.'],
  INVALID_MONEY: [400, 'A valid USD balance is required to review this order.'],
  UNKNOWN_FEE_SCHEDULE: [503, 'A verified fee allowance is required before placing this order.'],
  INVALID_BUDGET: [503, 'The remaining demo budget could not be verified.'],
  REMAINING_BUDGET_EXCEEDED: [409, 'The order and its fee allowance exceed the remaining demo budget.'],
  INSUFFICIENT_FUNDS: [402, 'The available USD balance does not cover the order and its fee allowance.'],
  PREVIEW_EXPIRED: [409, 'This order review has expired. Review a new order before confirming.'],
  PREVIEW_MISSING: [404, 'This order review is unavailable. Review a new order before confirming.'],
  SESSION_MISMATCH: [403, 'Confirm an order from the same private session that reviewed it.'],
  ACCOUNT_MISMATCH: [409, 'The selected account changed. Review a new order for the current account.'],
  UNRESOLVED_SUBMISSION: [409, 'An earlier order has an uncertain result. Check it in Gemini before placing another order.'],
  BUDGET_EXCEEDED: [409, 'This order exceeds the remaining $5.00 demo budget.'],
  RESULT_MISSING: [404, 'No submission has been recorded for this order review.']
};

export class LiveTradeError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(ERRORS, code) ? code : 'STORE_UNAVAILABLE';
    const [status, message] = ERRORS[safe];
    super(message);
    this.name = 'LiveTradeError';
    this.status = status;
    this.code = `LIVE_TRADE_${safe}`;
  }
}
const fail = code => {throw new LiveTradeError(code);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum, empty = false) => typeof value === 'string' && (empty || value.length > 0)
  && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const id = value => text(value, 128) && /^[A-Za-z0-9_-]+$/.test(value);
const money = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const tokenValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;

function reviewedOrder(input) {
  try {return reviewLiveOrder(input);}
  catch (error) {
    const code = typeof error?.code === 'string' ? error.code.replace(/^LIVE_ORDER_/, '') : '';
    fail(Object.hasOwn(ERRORS, code) ? code : 'STORE_UNAVAILABLE');
  }
}

function fields(value, expected) {
  if (!object(value) || Object.keys(value).length !== expected.length
    || expected.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}

// A shared integer scale makes grid comparisons exact even for sub-cent grids.
function decimal(value) {
  if (typeof value !== 'string' || value.length > 48 || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
}
const ONE = 10n ** 18n;

function verifiedMarket(raw, timestamp) {
  if (!object(raw) || !id(raw.symbol) || !text(raw.title, 300) || !text(raw.eventTitle, 300)
    || !text(raw.description, 3000, true) || typeof raw.expiresAt !== 'string') fail('MARKET_UNAVAILABLE');
  const expiration = Date.parse(raw.expiresAt);
  if (!Number.isSafeInteger(expiration) || expiration <= timestamp) fail('MARKET_UNAVAILABLE');
  for (const field of ['contractId', 'eventId']) {
    if (raw[field] !== undefined && raw[field] !== null && !id(raw[field])) fail('MARKET_UNAVAILABLE');
  }
  const minimum = decimal(raw.quantityMinimum), increment = decimal(raw.quantityIncrement);
  const priceMinimum = decimal(raw.priceMinimum), priceIncrement = decimal(raw.priceIncrement);
  if (minimum === null || increment === null || minimum <= 0n || increment <= 0n
    || (increment > ONE && increment % ONE !== 0n) || priceMinimum === null || priceIncrement === null
    || priceMinimum <= 0n || priceMinimum >= ONE || priceIncrement <= 0n) fail('MARKET_UNAVAILABLE');
  const market = {
    symbol: raw.symbol, title: raw.title, eventTitle: raw.eventTitle, description: raw.description,
    expiresAt: new Date(expiration).toISOString(), quantityMinimum: raw.quantityMinimum,
    quantityIncrement: raw.quantityIncrement, priceMinimum: raw.priceMinimum, priceIncrement: raw.priceIncrement,
    contractId: raw.contractId ?? null, eventId: raw.eventId ?? null
  };
  for (const side of ['yesAsk', 'noAsk']) market[side] = typeof raw[side] === 'number'
    && Number.isFinite(raw[side]) && raw[side] > 0 && raw[side] < 1 ? raw[side] : null;
  market.marketUrl = null;
  if (typeof raw.marketUrl === 'string') {
    try {
      const url = new URL(raw.marketUrl);
      if (url.protocol === 'https:' && ['gemini.com', 'www.gemini.com', 'exchange.gemini.com'].includes(url.hostname)
        && !url.username && !url.password && !url.port) market.marketUrl = url.href;
    } catch { /* A missing external link never changes the order. */ }
  }
  return market;
}

const BINDING_FIELDS = ['symbol', 'contractId', 'eventId', 'title', 'eventTitle', 'description', 'expiresAt',
  'quantityMinimum', 'quantityIncrement', 'priceMinimum', 'priceIncrement'];

function onGrid(market, order) {
  const quantity = decimal(order.quantity), price = decimal(order.price);
  const quantityMinimum = decimal(market.quantityMinimum), quantityIncrement = decimal(market.quantityIncrement);
  const priceMinimum = decimal(market.priceMinimum), priceIncrement = decimal(market.priceIncrement);
  if (quantity === null || price === null || quantity < quantityMinimum || price < priceMinimum
    || quantity % quantityIncrement !== 0n || (quantity - quantityMinimum) % quantityIncrement !== 0n
    || (price - priceMinimum) % priceIncrement !== 0n) fail('INVALID_GRID');
}

function safeExchangeOrder(raw, expected) {
  if (!object(raw) || typeof raw.orderId !== 'string' || !/^[1-9]\d{0,18}$/.test(raw.orderId)
    || BigInt(raw.orderId) > 9223372036854775807n || !EXCHANGE_STATUSES.has(raw.status)
    || raw.symbol !== expected.symbol || raw.outcome !== expected.outcome
    || (raw.side !== undefined && raw.side !== 'buy') || (raw.orderType !== undefined && raw.orderType !== 'limit')) return null;
  const quantity = decimal(raw.quantity), price = decimal(raw.price);
  const filled = decimal(raw.filledQuantity), remaining = decimal(raw.remainingQuantity);
  const increment = decimal(expected.quantityIncrement);
  if (quantity === null || quantity !== decimal(expected.quantity) || price === null || price !== decimal(expected.price)
    || filled === null || remaining === null || filled + remaining !== quantity
    || increment === null || increment <= 0n || filled % increment !== 0n || remaining % increment !== 0n
    || (raw.status === 'filled' && remaining !== 0n)
    || (raw.status === 'open' && remaining === 0n)) return null;
  return {orderId: raw.orderId, status: raw.status, symbol: expected.symbol, outcome: expected.outcome,
    quantity: expected.quantity, price: expected.price,
    filledQuantity: raw.filledQuantity, remainingQuantity: raw.remainingQuantity};
}

const unknown = order => ({status: 'unknown', code: 'UNKNOWN_RESULT',
  message: 'The order result is uncertain. Do not retry. Check your orders directly in Gemini.', ...(order ? {order} : {})});

/** The route supplies authenticated sessions and enforces POST, Origin and CSRF. */
export function createLiveTradeEngine({accountClient, exchange, store, now = Date.now, randomBytes = cryptoRandomBytes} = {}) {
  function clock() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1) fail('SESSION_EXPIRED');
    return timestamp;
  }
  function sessionValid(session) {
    const timestamp = clock();
    if (!object(session) || !tokenValid(session.id) || !Number.isSafeInteger(session.expiresAt)
      || session.expiresAt <= timestamp) fail('SESSION_EXPIRED');
    return timestamp;
  }
  function storage() {
    if (store?.durable !== true || ['getBudget', 'putPreview', 'getPreview', 'getSubmission', 'beginSubmission', 'finishSubmission']
      .some(method => typeof store[method] !== 'function')) fail('STORE_UNAVAILABLE');
  }
  async function stored(method, ...args) {
    try {return await store[method](...args);} catch {fail('STORE_UNAVAILABLE');}
  }
  async function snapshot() {
    let account;
    try {account = await accountClient.snapshot();} catch {fail('ACCOUNT_UNAVAILABLE');}
    if (!object(account)) fail('ACCOUNT_UNAVAILABLE');
    if (account.accountSelectionRequired !== false) fail('ACCOUNT_SELECTION_REQUIRED');
    if (typeof account.accountIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(account.accountIdentity)
      || !id(account.accountShortname) || !text(account.accountLabel, 80)) fail('ACCOUNT_UNAVAILABLE');
    return account;
  }
  function tradable(account) {
    if (account.roles?.isTrader !== true) fail('TRADER_REQUIRED');
    if (account.termsAccepted !== true) fail('TERMS_REQUIRED');
  }
  async function budgetFor(accountId) {
    const budget = await stored('getBudget', accountId);
    if (!object(budget) || !Number.isSafeInteger(budget.reservedCents) || budget.reservedCents < 0
      || budget.reservedCents > MAX_BUDGET_CENTS || typeof budget.unresolved !== 'boolean') fail('STORE_UNAVAILABLE');
    return budget;
  }
  const publicBudget = budget => ({remainingUsd: money(MAX_BUDGET_CENTS - budget.reservedCents),
    reservedUsd: money(budget.reservedCents), unresolved: budget.unresolved});
  async function marketList() {
    let list;
    try {list = await exchange.markets();} catch {fail('MARKET_UNAVAILABLE');}
    if (!Array.isArray(list) || list.length > 10000) fail('MARKET_UNAVAILABLE');
    const seen = new Set();
    for (const market of list) {
      if (!object(market) || !id(market.symbol) || seen.has(market.symbol)) fail('MARKET_UNAVAILABLE');
      seen.add(market.symbol);
    }
    return list;
  }
  function findMarket(list, symbol) {
    return verifiedMarket(list.find(market => market.symbol === symbol), clock());
  }
  function binding(record, session, account, exactSession = true) {
    if (!object(record) || !object(record.order)) fail('STORE_UNAVAILABLE');
    if (record.accountId !== account.accountIdentity) fail('ACCOUNT_MISMATCH');
    if (exactSession && record.sessionId !== session.id) fail('SESSION_MISMATCH');
  }
  function current(record, session) {
    const timestamp = sessionValid(session);
    if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= timestamp
      || !Number.isSafeInteger(Date.parse(record.order.expiresAt)) || Date.parse(record.order.expiresAt) <= timestamp) fail('PREVIEW_EXPIRED');
    return timestamp;
  }
  function publicSubmission(record) {
    if (record.status === 'submitting') return {status: 'submitting', code: 'ORDER_IN_PROGRESS',
      message: 'The order is being recorded. Do not confirm it again.'};
    if (record.status === 'unknown') return unknown(safeExchangeOrder(record.result?.order, record.order));
    if (record.status === 'rejected' && record.result?.code === 'PREVIEW_EXPIRED') return {
      status: 'rejected', code: 'PREVIEW_EXPIRED', message: 'The review expired before sending. No order was sent.'};
    if (record.status === 'complete') {
      const order = safeExchangeOrder(record.result?.order, record.order);
      if (order && order.status !== 'open') return {status: 'complete', order};
    }
    return unknown();
  }
  async function uncertain(token, order) {
    try {await store.finishSubmission(token, unknown(order));} catch { /* Keep the durable submitting gate on failure. */ }
    return unknown(order);
  }
  async function finish(token, result) {
    try {
      const record = await store.finishSubmission(token, result);
      if (!object(record) || record.status !== result.status) return await uncertain(token, result.order);
      return publicSubmission(record);
    } catch {return await uncertain(token, result.order);}
  }
  function checkedToken(value) {
    if (!tokenValid(value)) fail('INVALID_INPUT');
    return value;
  }

  return Object.freeze({
    async markets(session) {
      sessionValid(session); storage();
      const account = await snapshot();
      tradable(account);
      const list = await marketList();
      const budget = await budgetFor(account.accountIdentity);
      const timestamp = sessionValid(session);
      const markets = list.flatMap(raw => {
        try {return [verifiedMarket(raw, timestamp)];} catch {return [];}
      });
      return {markets, budget: publicBudget(budget), accountLabel: account.accountLabel, availableUsd: account.availableUsd};
    },

    async preview(session, body) {
      sessionValid(session); storage();
      fields(body, ['symbol', 'outcome', 'quantity', 'price']);
      if (!id(body.symbol) || !['yes', 'no'].includes(body.outcome)) fail('INVALID_INPUT');
      const account = await snapshot();
      tradable(account);
      const budget = await budgetFor(account.accountIdentity);
      if (budget.unresolved) fail('UNRESOLVED_SUBMISSION');
      const market = findMarket(await marketList(), body.symbol);
      const review = reviewedOrder({quantity: body.quantity, price: body.price, availableUsd: account.availableUsd,
        remainingBudgetUsd: publicBudget(budget).remainingUsd, feeSchedule: 'conservative', quantityIncrement: market.quantityIncrement});
      onGrid(market, review);
      const timestamp = sessionValid(session);
      const expiresAt = Math.min(timestamp + PREVIEW_MS, session.expiresAt, Date.parse(market.expiresAt));
      if (expiresAt <= timestamp) fail('PREVIEW_EXPIRED');
      const bytes = randomBytes(32);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32) fail('STORE_UNAVAILABLE');
      const previewToken = bytes.toString('base64url');
      const order = {...Object.fromEntries(BINDING_FIELDS.map(field => [field, market[field]])),
        outcome: body.outcome, quantity: review.quantity, price: review.price, principal: review.principal,
        estimatedFee: review.estimatedFee, estimatedTotal: review.estimatedTotal, feeNote: review.feeNote,
        feeSchedule: review.feeSchedule, remainingBudgetUsd: review.remainingBudgetUsd, accountLabel: account.accountLabel};
      const record = {sessionId: session.id, accountId: account.accountIdentity, order,
        estimatedTotalCents: review.estimatedTotalCents, expiresAt};
      await stored('putPreview', previewToken, record);
      current(record, session);
      return {previewToken, previewExpiresAt: new Date(expiresAt).toISOString(), order, budget: publicBudget(budget)};
    },

    async submit(session, body) {
      sessionValid(session); storage();
      fields(body, ['previewToken', 'confirmed']);
      const token = checkedToken(body.previewToken);
      if (body.confirmed !== true) fail('INVALID_INPUT');
      const account = await snapshot();
      const existing = await stored('getSubmission', token);
      if (existing) {
        binding(existing, session, account); sessionValid(session);
        return publicSubmission(existing);
      }
      let record, review, timestamp;
      try {
        record = await stored('getPreview', token);
        if (!record) fail('PREVIEW_MISSING');
        binding(record, session, account);
        current(record, session); tradable(account);
        const market = findMarket(await marketList(), record.order.symbol);
        if (BINDING_FIELDS.some(field => record.order[field] !== market[field])) fail('MARKET_CHANGED');
        const budget = await budgetFor(account.accountIdentity);
        if (budget.unresolved) fail('UNRESOLVED_SUBMISSION');
        review = reviewedOrder({quantity: record.order.quantity, price: record.order.price, availableUsd: account.availableUsd,
          remainingBudgetUsd: publicBudget(budget).remainingUsd, feeSchedule: 'conservative', quantityIncrement: market.quantityIncrement});
        onGrid(market, review);
        if (record.estimatedTotalCents !== review.estimatedTotalCents || record.order.estimatedTotal !== review.estimatedTotal
          || record.order.estimatedFee !== review.estimatedFee || record.order.principal !== review.principal
          || record.order.feeSchedule !== 'conservative' || !['yes', 'no'].includes(record.order.outcome)) fail('STORE_UNAVAILABLE');
        timestamp = current(record, session);
      } catch (error) {
        // Another instance may have consumed this token while preflight was
        // reading its preview or budget. Return that submission instead of
        // inviting a new confirmation or treating its reservation as new spend.
        const duplicate = await stored('getSubmission', token);
        if (duplicate) {
          binding(duplicate, session, account); sessionValid(session);
          return publicSubmission(duplicate);
        }
        throw error;
      }
      // All async preflight reads are complete. The atomic store consumes the token
      // and reserves its fee-inclusive amount before the sole exchange call.
      let begun;
      try {
        begun = await store.beginSubmission(token, {sessionId: session.id, accountId: account.accountIdentity,
          now: timestamp, maxBudgetCents: MAX_BUDGET_CENTS});
      } catch {return await uncertain(token);}
      if (begun?.ok !== true) {
        if (begun?.reason === 'duplicate' && begun.submission) {
          binding(begun.submission, session, account); sessionValid(session);
          return publicSubmission(begun.submission);
        }
        const reasons = {preview_missing: 'PREVIEW_MISSING', preview_expired: 'PREVIEW_EXPIRED',
          session_mismatch: 'SESSION_MISMATCH', account_mismatch: 'ACCOUNT_MISMATCH',
          unresolved_submission: 'UNRESOLVED_SUBMISSION', budget_exceeded: 'BUDGET_EXCEEDED'};
        if (!Object.hasOwn(reasons, begun?.reason)) return await uncertain(token);
        fail(reasons[begun.reason]);
      }
      try {
        binding(begun.submission, session, account);
        if (begun.submission.status !== 'submitting' || begun.submission.estimatedTotalCents !== record.estimatedTotalCents
          || begun.budget?.unresolved !== true || !Number.isSafeInteger(begun.budget.reservedCents)
          || begun.budget.reservedCents < record.estimatedTotalCents || begun.budget.reservedCents > MAX_BUDGET_CENTS
          || Object.keys(begun.submission.order).length !== Object.keys(record.order).length
          || Object.keys(record.order).some(key => begun.submission.order[key] !== record.order[key])) return await uncertain(token);
        // The reservation itself may take long enough to exhaust the session or
        // ticket. Nothing is sent when that happens, and reservation is retained.
        try {current(record, session);} catch {return await finish(token, {status: 'rejected', code: 'PREVIEW_EXPIRED'});}
        const response = await exchange.placeOrder({accountShortname: account.accountShortname,
          order: {symbol: record.order.symbol, outcome: record.order.outcome, quantity: review.quantity, price: review.price}});
        const order = safeExchangeOrder(response, record.order);
        if (!order) return await uncertain(token);
        // IOC should be terminal. A still-open response is not evidence that
        // matching has finished, so preserve both its order ID and account gate.
        if (order.status === 'open') return await uncertain(token, order);
        return await finish(token, {status: 'complete', order});
      } catch {return await uncertain(token);}
    },

    async result(session, previewToken) {
      sessionValid(session); storage();
      const token = checkedToken(previewToken);
      const account = await snapshot();
      const record = await stored('getSubmission', token);
      if (!record) fail('RESULT_MISSING');
      // The owner can inspect a prior result after logging back in, but only for
      // the same stable Gemini account. A new session cannot submit old previews.
      binding(record, session, account, false); sessionValid(session);
      return publicSubmission(record);
    }
  });
}
