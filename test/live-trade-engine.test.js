import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveTradeEngine, LiveTradeError} from '../lib/live-trade-engine.js';

const clone = value => structuredClone(value);
const START = 1900000000000;
const session = {id: Buffer.alloc(32, 11).toString('base64url'), expiresAt: START + 900000};
const input = {symbol: 'GEMI-DEMO', outcome: 'yes', quantity: '1', price: '0.50'};
const account = {accountIdentity: 'a'.repeat(64), accountShortname: 'primary', accountLabel: 'Demo account',
  accountSelectionRequired: false, availableUsd: '5.00', roles: {isTrader: true}, termsAccepted: true};
const market = {symbol: input.symbol, contractId: '123', eventId: '456', title: 'Test contract',
  eventTitle: 'Test event', description: 'Settles according to the published event terms.',
  expiresAt: new Date(START + 3600000).toISOString(), quantityMinimum: '1', quantityIncrement: '1',
  priceMinimum: '0.01', priceIncrement: '0.01', yesAsk: 0.51, noAsk: 0.50,
  marketUrl: 'https://www.gemini.com/predictions/test'};
const hasCode = code => error => error.code === code;

function fixture() {
  const state = {now: START, account: clone(account), markets: [clone(market)], snapshots: 0,
    exchangeCalls: [], previews: new Map(), submissions: new Map(), budgets: new Map(), events: [], randomCounter: 0};
  const hooks = {};
  const budget = id => {
    if (!state.budgets.has(id)) state.budgets.set(id, {reservedCents: 0, unresolved: false});
    return state.budgets.get(id);
  };
  const store = {
    durable: true,
    async putPreview(token, record) {
      assert.equal(state.previews.has(token), false);
      state.events.push('preview'); state.previews.set(token, clone(record));
      if (hooks.putPreview) await hooks.putPreview();
    },
    async getPreview(token) {if (hooks.getPreview) await hooks.getPreview(); return clone(state.previews.get(token) ?? null);},
    async getSubmission(token) {if (hooks.getSubmission) await hooks.getSubmission(); return clone(state.submissions.get(token) ?? null);},
    async getBudget(id) {if (hooks.getBudget) await hooks.getBudget(); return clone(budget(id));},
    async beginSubmission(token, args) {
      if (hooks.beforeBegin) await hooks.beforeBegin();
      const existing = state.submissions.get(token);
      if (existing) return {ok: false, reason: 'duplicate', submission: clone(existing)};
      const record = state.previews.get(token);
      if (!record) return {ok: false, reason: 'preview_missing'};
      if (record.sessionId !== args.sessionId) return {ok: false, reason: 'session_mismatch'};
      if (record.accountId !== args.accountId) return {ok: false, reason: 'account_mismatch'};
      if (record.expiresAt <= args.now) return {ok: false, reason: 'preview_expired'};
      const previous = budget(args.accountId);
      if (previous.unresolved) return {ok: false, reason: 'unresolved_submission'};
      if (previous.reservedCents + record.estimatedTotalCents > args.maxBudgetCents) return {ok: false, reason: 'budget_exceeded'};
      previous.reservedCents += record.estimatedTotalCents; previous.unresolved = true;
      const journal = {...clone(record), status: 'submitting', startedAt: state.now, updatedAt: state.now};
      state.submissions.set(token, journal); state.previews.delete(token); state.events.push('reserve');
      if (hooks.afterBegin) await hooks.afterBegin();
      return {ok: true, submission: clone(journal), budget: clone(previous)};
    },
    async finishSubmission(token, result) {
      if (hooks.finish) await hooks.finish(result);
      const journal = state.submissions.get(token);
      if (!journal) throw new Error('missing');
      if (['complete', 'rejected'].includes(journal.status)) return clone(journal);
      journal.status = result.status; journal.result = clone(result); journal.updatedAt = state.now;
      if (result.status !== 'unknown') budget(journal.accountId).unresolved = false;
      state.events.push(`finish:${result.status}`);
      return clone(journal);
    }
  };
  const exchange = {
    async markets() {if (hooks.markets) await hooks.markets(); return clone(state.markets);},
    async placeOrder(value) {
      state.events.push('exchange'); state.exchangeCalls.push(clone(value));
      if (hooks.placeOrder) return await hooks.placeOrder(value);
      return {orderId: '789', status: 'filled', ...value.order, side: 'buy', orderType: 'limit',
        filledQuantity: value.order.quantity, remainingQuantity: '0'};
    }
  };
  const accountClient = {async snapshot() {
    state.snapshots++;
    if (hooks.snapshot) await hooks.snapshot();
    return clone(state.account);
  }};
  const engine = createLiveTradeEngine({accountClient, exchange, store, now: () => state.now,
    randomBytes: size => Buffer.alloc(size, ++state.randomCounter)});
  const preview = (changes = {}, ownerSession = session) => engine.preview(ownerSession, {...input, ...changes});
  const submit = (ticket, ownerSession = session) => engine.submit(ownerSession, {previewToken: ticket.previewToken, confirmed: true});
  return {state, hooks, store, exchange, accountClient, engine, preview, submit, budget};
}

test('lists verified whole and fractional-fill markets and omits account routing data', async () => {
  const f = fixture();
  f.state.markets.push({...market, symbol: 'FRACTIONAL', quantityIncrement: '0.5'},
    {...market, symbol: 'EXPIRED', expiresAt: new Date(START).toISOString()},
    {...market, symbol: 'NO-GRID', priceIncrement: null});
  const result = await f.engine.markets(session);
  assert.equal(result.markets.length, 2);
  assert.equal(result.markets[1].symbol, 'FRACTIONAL');
  assert.equal(result.markets[0].contractId, '123');
  assert.deepEqual(result.budget, {remainingUsd: '5.00', reservedUsd: '0.00', unresolved: false});
  assert.doesNotMatch(JSON.stringify(result), /accountIdentity|accountShortname|primary/);
  f.budget(account.accountIdentity).unresolved = true;
  assert.equal((await f.engine.markets(session)).budget.unresolved, true);
});

test('preview saves an immutable account/session-bound ticket with conservative fees', async () => {
  const f = fixture(), ticket = await f.preview({quantity: '2', price: '.50'});
  assert.equal(Buffer.from(ticket.previewToken, 'base64url').length, 32);
  assert.equal(ticket.previewExpiresAt, new Date(START + 120000).toISOString());
  assert.equal(ticket.order.estimatedTotal, '1.06');
  assert.equal(ticket.order.estimatedFee, '0.06');
  assert.equal(ticket.order.remainingBudgetUsd, '5.00');
  assert.equal(ticket.order.accountLabel, account.accountLabel);
  assert.equal(ticket.order.eventTitle, market.eventTitle);
  assert.equal(ticket.order.description, market.description);
  const record = f.state.previews.get(ticket.previewToken);
  assert.equal(record.sessionId, session.id); assert.equal(record.accountId, account.accountIdentity);
  assert.equal(record.estimatedTotalCents, 106);
  assert.equal(record.order.feeSchedule, 'conservative');
  assert.doesNotMatch(JSON.stringify(ticket), /accountIdentity|accountShortname|sessionId/);
  ticket.order.price = '0.99';
  assert.equal(record.order.price, '0.50');
  assert.equal(f.state.exchangeCalls.length, 0);
});

test('preview lifetime is capped by session and market expiration', async () => {
  const f = fixture();
  const shorter = {...session, expiresAt: START + 10000};
  assert.equal((await f.preview({}, shorter)).previewExpiresAt, new Date(shorter.expiresAt).toISOString());
  f.state.markets[0].expiresAt = new Date(START + 5000).toISOString();
  assert.equal((await f.preview()).previewExpiresAt, f.state.markets[0].expiresAt);
  f.hooks.putPreview = () => {f.state.now += 10000;};
  await assert.rejects(f.preview(), hasCode('LIVE_TRADE_PREVIEW_EXPIRED'));
});

test('accepts exactly the preview and confirmation fields and strict scalar inputs', async () => {
  const f = fixture();
  for (const body of [null, [], {}, {...input, side: 'sell'}, {...input, account: 'other'},
    {...input, symbol: '../other'}, {...input, outcome: 'YES'}, {...input, price: 0.5},
    {...input, quantity: '1.5'}, {...input, quantity: '1e0'}, {...input, price: '0.500'}]) {
    await assert.rejects(f.engine.preview(session, body));
  }
  const ticket = await f.preview();
  for (const body of [{previewToken: ticket.previewToken}, {previewToken: ticket.previewToken, confirmed: 'true'},
    {previewToken: ticket.previewToken, confirmed: true, quantity: '100'}, {previewToken: 'tiny', confirmed: true}]) {
    await assert.rejects(f.engine.submit(session, body), hasCode('LIVE_TRADE_INVALID_INPUT'));
  }
  assert.equal(f.state.exchangeCalls.length, 0);
});

test('fails closed without durable storage, permissions, terms or account selection', async () => {
  const f = fixture();
  assert.doesNotThrow(() => createLiveTradeEngine());
  await assert.rejects(createLiveTradeEngine().preview(session, input), error => error instanceof LiveTradeError);
  f.store.durable = false;
  await assert.rejects(f.preview(), hasCode('LIVE_TRADE_STORE_UNAVAILABLE'));
  f.store.durable = true;
  for (const [changes, code] of [[{roles: {isTrader: false}}, 'TRADER_REQUIRED'], [{termsAccepted: false}, 'TERMS_REQUIRED'],
    [{accountSelectionRequired: true}, 'ACCOUNT_SELECTION_REQUIRED'], [{accountIdentity: 'bad'}, 'ACCOUNT_UNAVAILABLE']]) {
    f.state.account = {...clone(account), ...changes};
    await assert.rejects(f.preview(), hasCode(`LIVE_TRADE_${code}`));
  }
  assert.equal(f.state.exchangeCalls.length, 0);
});

test('requires exact decimal price and supported authoritative quantity grids', async () => {
  const f = fixture();
  Object.assign(f.state.markets[0], {quantityMinimum: '2.000', quantityIncrement: '2', priceMinimum: '0.01', priceIncrement: '0.03'});
  await assert.rejects(f.preview({quantity: '3', price: '0.10'}), hasCode('LIVE_TRADE_INVALID_GRID'));
  await assert.rejects(f.preview({quantity: '2', price: '0.11'}), hasCode('LIVE_TRADE_INVALID_GRID'));
  assert.equal((await f.preview({quantity: '2', price: '0.10'})).order.price, '0.10');
  Object.assign(f.state.markets[0], {quantityMinimum: '1', quantityIncrement: '1', priceMinimum: '0.000000000000000001', priceIncrement: '0.000000000000000003'});
  assert.equal((await f.preview({price: '0.01'})).order.price, '0.01');
  await assert.rejects(f.preview({price: '0.02'}), hasCode('LIVE_TRADE_INVALID_GRID'));
  for (const changes of [{quantityMinimum: '0'}, {quantityMinimum: null}, {quantityIncrement: '1.5'},
    {quantityIncrement: null}, {priceIncrement: '0'}, {priceMinimum: '1'}, {priceIncrement: '1e-2'}]) {
    f.state.markets[0] = {...clone(market), ...changes};
    await assert.rejects(f.preview(), hasCode('LIVE_TRADE_MARKET_UNAVAILABLE'));
  }
});

test('whole requested contracts on fractional-fill markets reserve every possible minimum fill fee', async () => {
  const f = fixture();
  Object.assign(f.state.markets[0], {quantityMinimum: '0.01', quantityIncrement: '0.01'});
  const ticket = await f.preview();
  assert.equal(ticket.order.quantity, '1');
  assert.equal(ticket.order.estimatedFee, '1.00');
  assert.equal(ticket.order.estimatedTotal, '1.50');
  assert.match(ticket.order.feeNote, /100 cents per whole contract/);
  assert.match(ticket.order.feeNote, /increments of 0.01 contracts/);
  f.hooks.placeOrder = value => ({orderId: '789', status: 'cancelled', ...value.order,
    filledQuantity: '0.990', remainingQuantity: '0.010'});
  const result = await f.submit(ticket);
  assert.equal(result.status, 'complete');
  assert.equal(result.order.filledQuantity, '0.990');
  assert.equal(result.order.remainingQuantity, '0.010');
  assert.deepEqual(await f.submit(ticket), result);
  assert.deepEqual(await f.engine.result(session, ticket.previewToken), result);
  assert.deepEqual(f.budget(account.accountIdentity), {reservedCents: 150, unresolved: false});
  assert.equal(f.state.exchangeCalls.length, 1);
});

test('fractional-fill allowance is rechecked against balance, lifetime budget and exact market grid', async () => {
  const f = fixture();
  Object.assign(f.state.markets[0], {quantityMinimum: '0.01', quantityIncrement: '0.01'});
  f.state.account.availableUsd = '1.49';
  await assert.rejects(f.preview(), hasCode('LIVE_TRADE_INSUFFICIENT_FUNDS'));
  f.state.account.availableUsd = '5.00';
  await assert.rejects(f.preview({quantity: '4'}), hasCode('LIVE_TRADE_BUDGET_EXCEEDED'));
  const ticket = await f.preview({quantity: '3'});
  assert.equal(ticket.order.estimatedFee, '3.00');
  assert.equal(ticket.order.estimatedTotal, '4.50');
  assert.equal((await f.submit(ticket)).status, 'complete');
  await assert.rejects(f.preview(), hasCode('LIVE_TRADE_REMAINING_BUDGET_EXCEEDED'));
  assert.equal(f.budget(account.accountIdentity).reservedCents, 450);
  const changed = fixture();
  Object.assign(changed.state.markets[0], {quantityMinimum: '0.01', quantityIncrement: '0.01'});
  const review = await changed.preview();
  changed.state.markets[0].quantityIncrement = '0.1';
  await assert.rejects(changed.submit(review), hasCode('LIVE_TRADE_MARKET_CHANGED'));
  assert.equal(changed.state.exchangeCalls.length, 0);
});

test('fractional receipts must stay on the verified fill increment without rounding or truncation', async () => {
  for (const [filledQuantity, remainingQuantity] of [['0.995', '0.005'], ['0.001', '0.999'], ['1e-2', '0.99']]) {
    const f = fixture();
    Object.assign(f.state.markets[0], {quantityMinimum: '0.01', quantityIncrement: '0.01'});
    const ticket = await f.preview();
    f.hooks.placeOrder = value => ({orderId: '789', status: 'cancelled', ...value.order, filledQuantity, remainingQuantity});
    const result = await f.submit(ticket);
    assert.equal(result.status, 'unknown'); assert.equal(result.order, undefined);
    assert.deepEqual(f.budget(account.accountIdentity), {reservedCents: 150, unresolved: true});
    assert.equal(f.state.exchangeCalls.length, 1);
  }
});

test('fractional quantity metadata is mandatory and cannot silently fall back to whole-fill fees', async () => {
  for (const quantityIncrement of [null, undefined, '', '0', 0.01, '1e-2']) {
    const f = fixture();
    Object.assign(f.state.markets[0], {quantityMinimum: '0.01', quantityIncrement});
    await assert.rejects(f.preview(), hasCode('LIVE_TRADE_MARKET_UNAVAILABLE'));
    assert.equal(f.state.previews.size, 0); assert.equal(f.state.exchangeCalls.length, 0);
  }
  const f = fixture();
  Object.assign(f.state.markets[0], {quantityMinimum: '0.1', quantityIncrement: '0.3'});
  await assert.rejects(f.preview(), hasCode('LIVE_TRADE_INVALID_GRID'));
});

test('reserves durable budget before the only order call and returns a sanitized result', async () => {
  const f = fixture(), ticket = await f.preview();
  const result = await f.submit(ticket);
  assert.equal(result.status, 'complete'); assert.equal(result.order.status, 'filled');
  assert.equal(result.order.orderId, '789');
  assert.deepEqual(f.state.exchangeCalls, [{accountShortname: 'primary', order: input}]);
  assert.deepEqual(f.state.events, ['preview', 'reserve', 'exchange', 'finish:complete']);
  assert.deepEqual(f.budget(account.accountIdentity), {reservedCents: 53, unresolved: false});
  assert.equal(f.state.previews.has(ticket.previewToken), false);
  assert.equal(f.state.submissions.get(ticket.previewToken).status, 'complete');
  assert.deepEqual(await f.submit(ticket), result);
  assert.deepEqual(await f.engine.result(session, ticket.previewToken), result);
  assert.equal(f.state.exchangeCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /accountIdentity|sessionId|accountShortname|startedAt/);
});

test('concurrent confirmation through separate engine instances makes one exchange call', async () => {
  const f = fixture(), ticket = await f.preview();
  let release;
  const blocked = new Promise(resolve => {release = resolve;});
  f.hooks.placeOrder = async value => {
    await blocked;
    return {orderId: '789', status: 'filled', ...value.order, filledQuantity: value.order.quantity, remainingQuantity: '0'};
  };
  const second = createLiveTradeEngine({accountClient: f.accountClient, exchange: f.exchange, store: f.store, now: () => f.state.now});
  const first = f.submit(ticket);
  const duplicate = second.submit(session, {previewToken: ticket.previewToken, confirmed: true});
  // Both async preflights reach the atomic store before the first order finishes.
  const other = await duplicate;
  assert.equal(other.status, 'submitting'); assert.equal(other.code, 'ORDER_IN_PROGRESS');
  release(); assert.equal((await first).status, 'complete');
  assert.equal(f.state.exchangeCalls.length, 1);
  assert.equal(f.budget(account.accountIdentity).reservedCents, 53);
});

test('fresh preflight rejects changes to terms, balance, market terms and contract identity', async () => {
  for (const changes of [{title: 'Changed'}, {eventTitle: 'Changed'}, {description: 'Changed rules'},
    {expiresAt: new Date(START + 4000000).toISOString()}, {contractId: '999'}, {eventId: '999'}, {priceIncrement: '0.02'}]) {
    const f = fixture(), ticket = await f.preview();
    Object.assign(f.state.markets[0], changes);
    await assert.rejects(f.submit(ticket), hasCode('LIVE_TRADE_MARKET_CHANGED'));
    assert.equal(f.state.exchangeCalls.length, 0); assert.equal(f.state.submissions.size, 0);
  }
  for (const [changes, code] of [[{availableUsd: '0.52'}, 'LIVE_TRADE_INSUFFICIENT_FUNDS'],
    [{termsAccepted: false}, 'LIVE_TRADE_TERMS_REQUIRED'], [{roles: {isTrader: false}}, 'LIVE_TRADE_TRADER_REQUIRED']]) {
    const f = fixture(), ticket = await f.preview(); Object.assign(f.state.account, changes);
    await assert.rejects(f.submit(ticket), hasCode(code)); assert.equal(f.state.exchangeCalls.length, 0);
  }
});

test('every preflight await is followed by session, ticket and market expiry checks', async () => {
  for (const hook of ['getSubmission', 'getPreview', 'markets', 'getBudget']) {
    const f = fixture(), ticket = await f.preview();
    f.hooks[hook] = () => {f.state.now = session.expiresAt;};
    await assert.rejects(f.submit(ticket));
    assert.equal(f.state.exchangeCalls.length, 0, hook);
    assert.equal(f.state.submissions.size, 0, hook);
  }
  const f = fixture(), ticket = await f.preview();
  f.hooks.getBudget = () => {f.state.now = START + 120000;};
  await assert.rejects(f.submit(ticket), hasCode('LIVE_TRADE_PREVIEW_EXPIRED'));
  assert.equal(f.state.submissions.size, 0);
});

test('expiry while reservation is pending sends nothing and retains the reserved budget', async () => {
  for (const deadline of [START + 120000, session.expiresAt]) {
    const f = fixture(), ticket = await f.preview();
    f.hooks.afterBegin = () => {f.state.now = deadline;};
    const result = await f.submit(ticket);
    assert.deepEqual(result, {status: 'rejected', code: 'PREVIEW_EXPIRED', message: 'The review expired before sending. No order was sent.'});
    assert.equal(f.state.exchangeCalls.length, 0);
    assert.deepEqual(f.budget(account.accountIdentity), {reservedCents: 53, unresolved: false});
  }
});

test('account identity binds reviews and results, while a new login may inspect an old result', async () => {
  const f = fixture(), ticket = await f.preview();
  const relogin = {...session, id: Buffer.alloc(32, 12).toString('base64url')};
  await assert.rejects(f.submit(ticket, relogin), hasCode('LIVE_TRADE_SESSION_MISMATCH'));
  f.state.account.accountIdentity = 'b'.repeat(64);
  await assert.rejects(f.submit(ticket), hasCode('LIVE_TRADE_ACCOUNT_MISMATCH'));
  f.state.account.accountIdentity = account.accountIdentity;
  const result = await f.submit(ticket);
  assert.deepEqual(await f.engine.result(relogin, ticket.previewToken), result);
  await assert.rejects(f.submit(ticket, relogin), hasCode('LIVE_TRADE_SESSION_MISMATCH'));
  f.state.account.accountIdentity = 'b'.repeat(64);
  await assert.rejects(f.engine.result(relogin, ticket.previewToken), hasCode('LIVE_TRADE_ACCOUNT_MISMATCH'));
  assert.equal(f.state.exchangeCalls.length, 1);
});

test('unknown exchange outcomes retain the account gate and never retry the token', async () => {
  for (const response of [new Error('secret api key'), {}, {orderId: '123', status: 'future-status'},
    {orderId: '123', status: 'filled', ...input, filledQuantity: '0', remainingQuantity: '1'},
    {orderId: '123', status: 'open', ...input, filledQuantity: '0.5', remainingQuantity: '0.5'},
    {orderId: '123', status: 'open', ...input, price: '0.51', filledQuantity: '0', remainingQuantity: '1'}]) {
    const f = fixture(), ticket = await f.preview();
    f.hooks.placeOrder = () => {if (response instanceof Error) throw response; return response;};
    const result = await f.submit(ticket);
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'UNKNOWN_RESULT');
    assert.doesNotMatch(JSON.stringify(result), /secret api key|future-status/);
    assert.deepEqual(await f.submit(ticket), result);
    assert.deepEqual(f.budget(account.accountIdentity), {reservedCents: 53, unresolved: true});
    await assert.rejects(f.preview(), hasCode('LIVE_TRADE_UNRESOLVED_SUBMISSION'));
    assert.equal(f.state.exchangeCalls.length, 1);
  }
});

test('lost completion journal leaves an unresolved durable submission and returns unknown', async () => {
  const f = fixture(), ticket = await f.preview();
  f.hooks.finish = () => {throw new Error('secret redis token');};
  const result = await f.submit(ticket);
  assert.equal(result.code, 'UNKNOWN_RESULT');
  assert.equal(f.state.submissions.get(ticket.previewToken).status, 'submitting');
  assert.equal((await f.submit(ticket)).status, 'submitting');
  assert.equal(f.budget(account.accountIdentity).unresolved, true);
  assert.equal(f.state.exchangeCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret redis token/);
});

test('an IOC response that is still open retains its order ID and unresolved account gate', async () => {
  const f = fixture(), ticket = await f.preview();
  f.hooks.placeOrder = value => ({orderId: '789', status: 'open', ...value.order,
    filledQuantity: '0', remainingQuantity: value.order.quantity, accountShortname: 'private', secret: 'hidden'});
  const result = await f.submit(ticket);
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'UNKNOWN_RESULT');
  assert.equal(result.order.orderId, '789'); assert.equal(result.order.status, 'open');
  assert.doesNotMatch(JSON.stringify(result), /private|hidden|accountShortname/);
  assert.deepEqual(await f.submit(ticket), result);
  assert.deepEqual(await f.engine.result(session, ticket.previewToken), result);
  assert.deepEqual(f.budget(account.accountIdentity), {reservedCents: 53, unresolved: true});
  assert.equal(f.state.exchangeCalls.length, 1);
});

test('a concurrent submission discovered during budget preflight returns the original result', async () => {
  const f = fixture(), ticket = await f.preview();
  let raced = false;
  f.hooks.getBudget = async () => {
    if (raced) return;
    raced = true;
    assert.equal((await f.submit(ticket)).status, 'complete');
  };
  const result = await f.submit(ticket);
  assert.equal(result.status, 'complete'); assert.equal(result.order.orderId, '789');
  assert.equal(f.state.exchangeCalls.length, 1);
  assert.equal(f.budget(account.accountIdentity).reservedCents, 53);
});

test('a concurrent submission that consumes the preview during lookup is still returned', async () => {
  const f = fixture(), ticket = await f.preview();
  let raced = false;
  f.hooks.getPreview = async () => {
    if (raced) return;
    raced = true;
    assert.equal((await f.submit(ticket)).status, 'complete');
  };
  const result = await f.submit(ticket);
  assert.equal(result.status, 'complete'); assert.equal(result.order.orderId, '789');
  assert.equal(f.state.exchangeCalls.length, 1);
});

test('policy failures remain safe, specific client errors understood by the route', async () => {
  const f = fixture();
  for (const [changes, code, status] of [[{quantity: '1.5'}, 'INVALID_QUANTITY', 400],
    [{price: '0'}, 'INVALID_PRICE', 400], [{quantity: '10'}, 'BUDGET_EXCEEDED', 409]]) {
    await assert.rejects(f.preview(changes), error => error instanceof LiveTradeError
      && error.code === `LIVE_TRADE_${code}` && error.status === status);
  }
  f.state.account.availableUsd = '0.52';
  await assert.rejects(f.preview(), error => error instanceof LiveTradeError && error.status === 402
    && error.code === 'LIVE_TRADE_INSUFFICIENT_FUNDS' && /available USD balance/.test(error.message));
});

test('a lost reservation response does not send an order or reset the durable account gate', async () => {
  const f = fixture(), ticket = await f.preview();
  f.hooks.afterBegin = () => {throw new Error('reservation response lost');};
  const result = await f.submit(ticket);
  assert.equal(result.code, 'UNKNOWN_RESULT'); assert.equal(f.state.exchangeCalls.length, 0);
  assert.equal(f.state.submissions.get(ticket.previewToken).status, 'unknown');
  assert.equal(f.budget(account.accountIdentity).unresolved, true);
  assert.deepEqual(await f.submit(ticket), result);
});

test('lifetime budget is account-based, fee-inclusive and never refunded on cancelled orders', async () => {
  const f = fixture();
  f.hooks.placeOrder = value => ({orderId: '789', status: 'cancelled', ...value.order,
    filledQuantity: '0', remainingQuantity: value.order.quantity});
  const ticket = await f.preview({quantity: '10', price: '0.47'});
  assert.equal((await f.submit(ticket)).order.status, 'cancelled');
  assert.deepEqual(f.budget(account.accountIdentity), {reservedCents: 500, unresolved: false});
  const relogin = {...session, id: Buffer.alloc(32, 13).toString('base64url')};
  await assert.rejects(f.preview({}, relogin), hasCode('LIVE_TRADE_REMAINING_BUDGET_EXCEEDED'));
  assert.equal((await f.engine.markets(relogin)).budget.remainingUsd, '0.00');
});

test('atomic reservation prevents two different previews from overspending a shared budget', async () => {
  const f = fixture();
  const one = await f.preview({quantity: '6', price: '0.50'}), two = await f.preview({quantity: '6', price: '0.50'});
  const results = await Promise.allSettled([f.submit(one), f.submit(two)]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.status === 'complete').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.state.exchangeCalls.length, 1); assert.equal(f.budget(account.accountIdentity).reservedCents, 318);
});

test('journal object key ordering does not change a valid reviewed order', async () => {
  const f = fixture(), ticket = await f.preview();
  f.hooks.afterBegin = () => {
    const journal = f.state.submissions.get(ticket.previewToken);
    journal.order = Object.fromEntries(Object.entries(journal.order).reverse());
  };
  assert.equal((await f.submit(ticket)).status, 'complete');
  assert.equal(f.state.exchangeCalls.length, 1);
});

test('provider and storage preflight failures use static safe errors and never call the exchange', async () => {
  for (const hook of ['snapshot', 'markets', 'getBudget', 'getPreview', 'getSubmission']) {
    const f = fixture(), ticket = await f.preview();
    f.hooks[hook] = () => {throw new Error('private secret contents');};
    await assert.rejects(f.submit(ticket), error => {
      assert.doesNotMatch(error.message + JSON.stringify(error), /private secret contents/);
      return error instanceof LiveTradeError;
    });
    assert.equal(f.state.exchangeCalls.length, 0);
  }
});
