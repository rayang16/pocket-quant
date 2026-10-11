import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createGeminiLiveExchange, LiveExchangeError} from '../lib/gemini-live-exchange.js';

// Every order request below is intercepted. Never use real credentials or fetch.
const env = Object.freeze({GEMINI_LIVE_API_KEY: 'master-fake-test-key', GEMINI_LIVE_API_SECRET: 'fake-test-secret', GEMINI_LIVE_NONCE_MODE: 'time'});
const order = Object.freeze({symbol: 'GEMI-TEST26-YES', outcome: 'yes', quantity: '2', price: '0.45'});
const input = () => ({accountShortname: 'primary', order: {...order}});
const result = () => ({orderId: '9223372036854775807', status: 'filled', ...order, side: 'buy', orderType: 'limit',
  filledQuantity: '2', remainingQuantity: '0', avgExecutionPrice: '0.44', createdAt: '2026-10-11T12:00:00Z'});
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json', ...headers}});
const isError = (code, ambiguous = false) => error => error instanceof LiveExchangeError && error.code === `LIVE_EXCHANGE_${code}` && error.ambiguous === ambiguous;
function setup({config = env, fetchImpl, clockStart = 1780000000250} = {}) {
  let clock = clockStart;
  const calls = [], waits = [];
  const client = createGeminiLiveExchange({env: config, now: () => clock, waitImpl: async ms => {waits.push(ms); clock += ms;},
    fetchImpl: async (url, options) => {
      const payload = options.headers['X-GEMINI-PAYLOAD'] ? JSON.parse(Buffer.from(options.headers['X-GEMINI-PAYLOAD'], 'base64').toString()) : null;
      calls.push({url, options, payload});
      return fetchImpl ? fetchImpl(url, options, payload) : json(result(), 201);
    }});
  return {client, calls, waits, setClock(value) {clock = value;}};
}
const contract = (overrides = {}) => ({id: 'contract_1', label: 'Bitcoin reaches the threshold', description: {content: [{value: 'Official settlement rule.'}]},
  instrumentSymbol: order.symbol, status: 'active', marketState: 'open', expiryDate: '2028-12-31T18:59:59-05:00',
  quantityMinimum: '1.00', quantityIncrement: '1', priceMinimum: '0.01', priceIncrement: '0.01',
  prices: {buy: {yes: '0.45', no: '0.57'}, bestAsk: '0.46'}, ...overrides});
const event = (overrides = {}) => ({id: 'event_1', title: 'Bitcoin at year end', status: 'active', ticker: 'BTC28', slug: 'bitcoin-at-year-end',
  description: 'Event settlement rule.', contracts: [contract()], ...overrides});
const events = data => ({data, pagination: {offset: 0, limit: 100, total: data.length}});

test('only fixed production market and order capabilities are exposed; order HMAC signs exact empty-body request', async () => {
  const {client, calls} = setup({config: {...env, GEMINI_LIVE_API_URL: 'https://attacker.example', GEMINI_API_BASE_URL: 'https://attacker.example'}});
  assert.deepEqual(Object.keys(client), ['markets', 'placeOrder']);
  const actual = await client.placeOrder(input());
  assert.equal(actual.orderId, '9223372036854775807');
  assert.ok(Object.isFrozen(actual));
  assert.equal(calls.length, 1);
  const {url, options, payload} = calls[0];
  assert.equal(url, 'https://api.gemini.com/v1/prediction-markets/order');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body, '');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers['Content-Type'], 'text/plain');
  assert.equal(options.headers['Content-Length'], '0');
  assert.equal(options.headers['Cache-Control'], 'no-cache');
  assert.equal(options.headers['X-GEMINI-APIKEY'], env.GEMINI_LIVE_API_KEY);
  assert.equal(options.headers['X-GEMINI-SIGNATURE'], createHmac('sha384', env.GEMINI_LIVE_API_SECRET).update(options.headers['X-GEMINI-PAYLOAD']).digest('hex'));
  assert.equal(options.headers.Authorization, undefined);
  assert.deepEqual(payload, {request: '/v1/prediction-markets/order', nonce: 1780000000, account: 'primary', ...order,
    side: 'buy', orderType: 'limit', timeInForce: 'immediate-or-cancel'});
});

test('configuration is lazy, requires a master key and explicit time nonce mode, and public markets need no credentials', async () => {
  for (const [config, code] of [[{}, 'CONFIG_REQUIRED'], [{...env, GEMINI_LIVE_API_KEY: 'account-test'}, 'MASTER_KEY_REQUIRED'],
    [{...env, GEMINI_LIVE_API_SECRET: 'secret\r\ninjection'}, 'CONFIG_REQUIRED'],
    [{...env, GEMINI_LIVE_NONCE_MODE: undefined}, 'TIME_NONCE_REQUIRED'], [{...env, GEMINI_LIVE_NONCE_MODE: 'incremental'}, 'TIME_NONCE_REQUIRED']]) {
    const {client, calls} = setup({config});
    await assert.rejects(client.placeOrder(input()), isError(code));
    assert.equal(calls.length, 0);
  }
  const publicOnly = setup({config: {}, fetchImpl: async () => json(events([]))});
  assert.deepEqual(await publicOnly.client.markets(), []);
  assert.equal(publicOnly.calls[0].payload, null);
});

test('all authority and order fields are allowlisted before a network attempt', async () => {
  const invalid = [null, {}, [], {...input(), path: '/v1/order/new'}, {...input(), accountShortname: ['primary']},
    {...input(), accountShortname: 'primary/../../other'}, {...input(), accountShortname: 'primary\n'},
    ...[undefined, '', 'btc-usd', 'GEMI-../../', 'GEMI-CMB-FAKE', 'https://attacker.example'].map(symbol => ({...input(), order: {...order, symbol}})),
    ...[0, 1, '0', '-1', '01', '1.5', '1000000000', '1e2'].map(quantity => ({...input(), order: {...order, quantity}})),
    ...[0.45, '.45', '0.4', '0.00', '1.00', '0.451', ' 0.45'].map(price => ({...input(), order: {...order, price}})),
    ...[{side: 'sell'}, {orderType: 'market'}, {timeInForce: 'good-til-cancel'}, {outcome: 'YES'}, {makerOrCancel: false},
      {account: 'other'}, {nonce: 10}, {request: '/v1/order/cancel'}].map(extra => ({...input(), order: {...order, ...extra}}))];
  const {client, calls} = setup();
  for (const value of invalid) await assert.rejects(client.placeOrder(value), isError('INVALID_INPUT'));
  for (const argument of [undefined, {}, '/v1/order/new']) await assert.rejects(client.markets(argument), isError('INVALID_INPUT'));
  assert.equal(calls.length, 0);
});

test('all int64 order ID digits survive JSON parsing including escaped property names and misleading string values', async () => {
  for (const id of ['12345678', '9007199254740993', '9223372036854775807']) {
    const body = JSON.stringify({...result(), metadata: 'fake \\"orderId\\": 9999999999999999999'}).replace('"orderId":"9223372036854775807"', `"orderId":${id}`);
    const plain = setup({fetchImpl: async () => new Response(body, {status: 201})});
    assert.equal((await plain.client.placeOrder(input())).orderId, id);
    const escaped = setup({fetchImpl: async () => new Response(body.replace('"orderId":', '"ord\\u0065rId":'), {status: 201})});
    assert.equal((await escaped.client.placeOrder(input())).orderId, id);
  }
  for (const id of ['0', '-1', '1.5', '1e3', '9007199254740993e0', '9223372036854775808', '01']) {
    const body = JSON.stringify(result()).replace('"orderId":"9223372036854775807"', `"orderId":${id}`);
    await assert.rejects(setup({fetchImpl: async () => new Response(body)}).client.placeOrder(input()), isError('INVALID_RESPONSE', true));
  }
});

test('order results contain only matching identities, recognized states and exact bounded decimal strings', async () => {
  const extras = {apiKey: env.GEMINI_LIVE_API_KEY, secret: env.GEMINI_LIVE_API_SECRET, account: 'PRIVATE_ACCOUNT',
    users: ['PRIVATE_USER'], contractMetadata: {description: 'PRIVATE_META'}, message: 'PRIVATE_MESSAGE'};
  const {client} = setup({fetchImpl: async () => json({...result(), ...extras})});
  const actual = await client.placeOrder(input());
  assert.deepEqual(actual, {...result(), createdAt: '2026-10-11T12:00:00.000Z', updatedAt: null, cancelledAt: null});
  assert.equal(JSON.stringify(actual).includes('PRIVATE_'), false);
  for (const patch of [{orderId: null}, {orderId: 'unsafe-id'}, {status: 'canceled'}, {status: 'partially_filled'},
    {symbol: 'GEMI-OTHER'}, {side: 'sell'}, {outcome: 'no'}, {orderType: 'stop-limit'}, {timeInForce: 'fill-or-kill'},
    {quantity: '3'}, {quantity: 2}, {price: '0.46'}, {price: 0.45}, {filledQuantity: '1'}, {filledQuantity: '-1'},
    {remainingQuantity: '0.5'}, {avgExecutionPrice: '0.46'}, {avgExecutionPrice: '0'}, {createdAt: 'tomorrow'},
    {createdAt: '2026-10-11T12:00:00'}, {filledQuantity: '9999999999999999999999999999'}]) {
    await assert.rejects(setup({fetchImpl: async () => json({...result(), ...patch})}).client.placeOrder(input()), isError('INVALID_RESPONSE', true));
  }
  const partial = await setup({fetchImpl: async () => json({...result(), status: 'cancelled', filledQuantity: '1', remainingQuantity: '1'})}).client.placeOrder(input());
  assert.equal(partial.status, 'cancelled');
  assert.equal(partial.filledQuantity, '1');
});

test('transport, HTTP and provider failures are ambiguous, sanitized and never retried', async () => {
  for (const [status, code] of [[400, 'UNAVAILABLE'], [401, 'UNAVAILABLE'], [403, 'UNAVAILABLE'], [429, 'RATE_LIMIT'], [500, 'UNAVAILABLE'], [503, 'UNAVAILABLE'], [200, 'UNAVAILABLE']]) {
    const {client, calls} = setup({fetchImpl: async () => json({result: 'error', reason: 'PRIVATE_REASON', message: env.GEMINI_LIVE_API_SECRET}, status)});
    await assert.rejects(client.placeOrder(input()), error => {
      assert.ok(isError(code, true)(error));
      assert.equal(error.cause, undefined);
      assert.equal(error.reason, undefined);
      assert.equal(`${error} ${JSON.stringify(error)}`.includes('PRIVATE_'), false);
      assert.equal(`${error} ${JSON.stringify(error)}`.includes(env.GEMINI_LIVE_API_SECRET), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const {client, calls} = setup({fetchImpl: async () => {throw new Error('PRIVATE_NETWORK_SECRET');}});
  await assert.rejects(client.placeOrder(input()), isError('UNAVAILABLE', true));
  assert.equal(calls.length, 1);
});

test('redirected, malformed, and oversized order responses fail closed without leaking or following a redirect', async () => {
  for (const response of [() => new Response('PRIVATE_BODY'), () => new Response('x'.repeat(2097153)),
    () => json(result(), 201, {'content-length': '2097153'}),
    () => {const response = json(result()); Object.defineProperty(response, 'url', {value: 'https://attacker.example'}); return response;},
    () => {const response = json(result()); Object.defineProperty(response, 'redirected', {value: true}); return response;}]) {
    const {client, calls} = setup({fetchImpl: async () => response()});
    await assert.rejects(client.placeOrder(input()), isError('INVALID_RESPONSE', true));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.signal.aborted, true);
  }
});

test('seconds-based nonces advance with elapsed time and concurrent orders are not queued', async () => {
  const {client, calls, waits, setClock} = setup();
  const pending = client.placeOrder(input());
  await assert.rejects(client.placeOrder(input()), isError('BUSY'));
  await pending;
  await client.placeOrder(input());
  assert.deepEqual(calls.map(call => call.payload.nonce), [1780000000, 1780000001]);
  assert.deepEqual(waits, [770]);
  setClock(1779999960000);
  await assert.rejects(client.placeOrder(input()), isError('NONCE_CLOCK'));
  assert.equal(calls.length, 2);
  for (const clockStart of [NaN, -1, '1780000000250']) await assert.rejects(setup({clockStart}).client.placeOrder(input()), isError('NONCE_CLOCK'));
});

test('early timer wakeups recheck actual order nonce time without retrying placement', async () => {
  let clock = 1780000000250;
  const waits = [], calls = [];
  const client = createGeminiLiveExchange({env, now: () => clock,
    waitImpl: async ms => {waits.push(ms); clock += waits.length === 1 ? ms - 25 : ms;},
    fetchImpl: async (_, options) => {
      const payload = JSON.parse(Buffer.from(options.headers['X-GEMINI-PAYLOAD'], 'base64').toString());
      assert.equal(payload.nonce, Math.floor(clock / 1000));
      calls.push(payload);
      return json(result(), 201);
    }});
  await client.placeOrder(input());
  await client.placeOrder(input());
  assert.deepEqual(calls.map(call => call.nonce), [1780000000, 1780000001]);
  assert.deepEqual(waits, [770, 25]);
  assert.equal(calls.length, 2);
});

test('a frozen order clock stops after four waits before another exchange attempt', async () => {
  const waits = [], calls = [];
  const client = createGeminiLiveExchange({env, now: () => 1780000000250,
    waitImpl: async ms => {waits.push(ms);}, fetchImpl: async (_, options) => {
      calls.push(options);
      return json(result(), 201);
    }});
  await client.placeOrder(input());
  await assert.rejects(client.placeOrder(input()), isError('NONCE_CLOCK'));
  assert.deepEqual(waits, [770, 770, 770, 770]);
  assert.equal(calls.length, 1);
});

test('public market normalization retains authoritative contract data and exact precision metadata', async () => {
  const {client, calls} = setup({fetchImpl: async () => json(events([event()]))});
  const markets = await client.markets();
  assert.deepEqual(markets, [{symbol: order.symbol, contractId: 'contract_1', eventId: 'event_1', title: 'Bitcoin reaches the threshold',
    eventTitle: 'Bitcoin at year end', description: 'Official settlement rule.', expiresAt: '2028-12-31T23:59:59.000Z',
    yesAsk: 0.45, noAsk: 0.57, quantityMinimum: '1.00', quantityIncrement: '1', priceMinimum: '0.01', priceIncrement: '0.01',
    marketUrl: 'https://www.gemini.com/predictions/BTC28/bitcoin-at-year-end'}]);
  assert.ok(Object.isFrozen(markets));
  assert.ok(Object.isFrozen(markets[0]));
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.gemini.com/v1/prediction-markets/events');
  assert.deepEqual(url.searchParams.getAll('category'), ['Crypto', 'Economics', 'Business', 'Commodities', 'Tech']);
  assert.equal(url.searchParams.get('status'), 'active');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(calls[0].options.headers, {Accept: 'application/json'});
  assert.equal(calls[0].options.body, undefined);
});

test('market discovery excludes expired, closed, future, unidentified, malformed and combo contracts', async () => {
  for (const patch of [{id: ''}, {label: null}, {status: 'settled'}, {marketState: 'closed'}, {marketState: undefined},
    {isCombo: true}, {instrumentSymbol: 'GEMI-CMB-ABC'}, {instrumentSymbol: 'GEMI-X?redirect=bad'},
    {expiryDate: '2020-01-01T00:00:00Z'}, {expiryDate: '2028-02-30T23:59:59Z'}, {expiryDate: '2028-12-31T23:59:59'}, {expiryDate: 9999999999999},
    {id: 'x'.repeat(129)}, {label: 'x'.repeat(301)}, {description: 'x'.repeat(3001)},
    {description: {content: Array(101).fill({value: 'Rule'})}},
    {effectiveDate: '2028-01-01T00:00:00Z'}, {effectiveDate: 'invalid'}]) {
    const {client} = setup({fetchImpl: async () => json(events([event({contracts: [contract(patch)]})]))});
    assert.deepEqual(await client.markets(), []);
  }
  const missing = await setup({fetchImpl: async () => json(events([event({ticker: '//attacker.example', slug: 'bad', contracts: [contract({
    quantityIncrement: 1, quantityMinimum: null, priceMinimum: 'garbage', priceIncrement: undefined, description: null,
    prices: {buy: {yes: 'NaN', no: 0.5}}, marketUrl: 'https://attacker.example'
  })]})]))}).client.markets();
  assert.equal(missing[0].quantityIncrement, null);
  assert.equal(missing[0].quantityMinimum, null);
  assert.equal(missing[0].priceIncrement, null);
  assert.equal(missing[0].priceMinimum, null);
  assert.equal(missing[0].yesAsk, null);
  assert.equal(missing[0].noAsk, null);
  assert.equal(missing[0].description, 'Event settlement rule.');
  assert.equal(missing[0].marketUrl, null);
});

test('child markets are included, identical symbols deduplicated, conflicting contract identities removed', async () => {
  const child = event({id: 'child_event', contracts: [contract({id: 'child_contract', instrumentSymbol: 'GEMI-CHILD'})]});
  const data = [event({events: [child]}), event(), event({contracts: [contract({id: 'conflicting_id'})]})];
  const markets = await setup({fetchImpl: async () => json(events(data))}).client.markets();
  assert.deepEqual(markets.map(m => m.symbol), ['GEMI-CHILD']);
  for (const patch of [{id: 'other_event'}, {title: 'Changed settlement event'}]) {
    const conflicting = await setup({fetchImpl: async () => json(events([event(), event(patch)]))}).client.markets();
    assert.deepEqual(conflicting, []);
  }
});

test('market calls share in-flight discovery, read at most ten finance pages and return at most 5000 contracts', async () => {
  const {client, calls} = setup({fetchImpl: async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return json({data: Array.from({length: 100}, (_, i) => event({id: `event_${i + offset}`, contracts: Array.from({length: 6}, (_, j) =>
      contract({id: `contract_${i + offset}_${j}`, instrumentSymbol: `GEMI-MARKET${i + offset}-${j}`}))})),
      pagination: {offset, limit: 100, total: 50000}});
  }});
  const first = client.markets(), concurrent = client.markets();
  assert.equal(first, concurrent);
  assert.equal((await first).length, 5000);
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('offset')), ['0', '100', '200', '300', '400', '500', '600', '700', '800', '900']);
  assert.ok(calls.every(call => !call.payload && new URL(call.url).origin === 'https://api.gemini.com'));
  assert.ok(calls.every(call => new URL(call.url).searchParams.getAll('category').join(',') === 'Crypto,Economics,Business,Commodities,Tech'));
  await client.markets();
  assert.equal(calls.length, 20, 'a subsequent preview or submission must fetch fresh markets');
});

test('public market responses allow large nested event payloads but retain a separate 16 MiB bound', async () => {
  const body = JSON.stringify({...events([event()]), publicMetadata: 'x'.repeat(8 * 1024 * 1024)});
  const large = setup({config: {}, fetchImpl: async () => new Response(body)});
  assert.equal((await large.client.markets()).length, 1);
  assert.equal(large.calls.length, 1);
  for (const response of [() => new Response('x'.repeat(16 * 1024 * 1024 + 1)),
    () => json(events([]), 200, {'content-length': String(16 * 1024 * 1024 + 1)})]) {
    const oversized = setup({config: {}, fetchImpl: async () => response()});
    await assert.rejects(oversized.client.markets(), isError('MARKET_RESPONSE'));
    assert.equal(oversized.calls.length, 1);
    assert.equal(oversized.calls[0].options.signal.aborted, true);
  }
  // Public capacity must not relax the smaller private order-response bound.
  const orderResponse = setup({fetchImpl: async () => json({...result(), extra: 'x'.repeat(2 * 1024 * 1024)})});
  await assert.rejects(orderResponse.client.placeOrder(input()), isError('INVALID_RESPONSE', true));
  assert.equal(orderResponse.calls.length, 1);
});

test('public pagination stops at the verified last page and keeps later eligible contracts', async () => {
  const {client, calls} = setup({config: {}, fetchImpl: async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    const length = offset === 300 ? 7 : 100;
    return json({data: Array.from({length}, (_, i) => event({id: `event_${offset + i}`, contracts: [
      contract({id: `contract_${offset + i}`, instrumentSymbol: `GEMI-FINANCE${offset + i}`})]})),
    pagination: {offset, limit: 100, total: 307}});
  }});
  const markets = await client.markets();
  assert.equal(markets.length, 307);
  assert.equal(markets.at(-1).symbol, 'GEMI-FINANCE306');
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('offset')), ['0', '100', '200', '300']);
});

test('market pagination cannot redirect requests or introduce malformed lists', async () => {
  for (const data of [{}, {data: {}}, {data: [], pagination: {offset: 10, limit: 100, total: 2}},
    {data: [], pagination: {offset: 0, limit: 100, total: 1e20}}, {data: Array(101).fill(event())}]) {
    const {client, calls} = setup({fetchImpl: async () => json(data)});
    await assert.rejects(client.markets(), isError('MARKET_RESPONSE'));
    assert.equal(calls.length, 1);
  }
  const redirect = setup({fetchImpl: async () => {const response = json(events([])); Object.defineProperty(response, 'url', {value: 'https://attacker.example'}); return response;}});
  await assert.rejects(redirect.client.markets(), isError('MARKET_RESPONSE'));
  assert.equal(redirect.calls.length, 1);
});

test('deadlines include connection and body reads, abort once, and never retry an uncertain order', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const responseHangs of [false, true]) {
    const {client, calls} = setup({fetchImpl: async () => responseHangs
      ? {ok: true, status: 201, headers: new Headers(), body: {getReader: () => ({read: () => new Promise(() => {}), releaseLock() {}})}}
      : new Promise(() => {})});
    const failure = assert.rejects(client.placeOrder(input()), isError('TIMEOUT', true));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(12000);
    await failure;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.signal.aborted, true);
  }
  const publicHangs = setup({fetchImpl: async () => new Promise(() => {})});
  const failure = assert.rejects(publicHangs.client.markets(), isError('MARKET_UNAVAILABLE'));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(12000);
  assert.equal(publicHangs.calls[0].options.signal.aborted, false);
  t.mock.timers.tick(18000);
  await failure;
  assert.equal(publicHangs.calls.length, 1);
  assert.equal(publicHangs.calls[0].options.signal.aborted, true);
});
