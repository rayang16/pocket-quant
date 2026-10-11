import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {createGeminiLiveReadonly, LiveReadonlyError} from '../lib/gemini-live-readonly.js';

const env = Object.freeze({GEMINI_LIVE_API_KEY: 'master-fake-test-key', GEMINI_LIVE_API_SECRET: 'fake-test-secret', GEMINI_LIVE_NONCE_MODE: 'time'});
const roles = {isAuditor: true, isTrader: true, isFundManager: false, isAccountAdmin: false};
const account = {name: 'Personal exchange', account: 'primary', type: 'exchange', status: 'open', counterparty_id: 'fake-counterparty-id'};
const defaults = {
  '/v1/roles': roles,
  '/v1/account/list': [account],
  '/v1/balances': [{currency: 'USD', available: '12.99999999', amount: '200.00', availableForWithdrawal: '8.00'}],
  '/v1/prediction-markets/terms/status': {hasAcceptedLatest: true}
};
function json(data, status = 200) {return new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});}
function setup({values = {}, config = env, fetchImpl, clockStart = 1780000000250} = {}) {
  let clock = clockStart;
  const calls = [], waits = [];
  const client = createGeminiLiveReadonly({env: config, now: () => clock, waitImpl: async ms => {waits.push(ms); clock += ms;},
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(Buffer.from(options.headers['X-GEMINI-PAYLOAD'], 'base64').toString());
      calls.push({url, options, payload});
      return fetchImpl ? fetchImpl(url, options, payload) : json(Object.hasOwn(values, payload.request) ? values[payload.request] : defaults[payload.request]);
    }});
  return {client, calls, waits, setClock(value) {clock = value;}};
}
const isError = (code, status) => error => error instanceof LiveReadonlyError && error.code === `LIVE_ACCOUNT_${code}` && (!status || error.status === status);

test('personal master requests use fixed production read routes, exact signatures and empty POST bodies', async () => {
  const {client, calls} = setup({config: {...env, GEMINI_LIVE_API_URL: 'https://attacker.example', GEMINI_API_BASE_URL: 'https://attacker.example'}});
  const snapshot = await client.snapshot();
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
    ['https://api.gemini.com/v1/roles', 'POST'],
    ['https://api.gemini.com/v1/account/list', 'POST'],
    ['https://api.gemini.com/v1/balances', 'POST'],
    ['https://api.gemini.com/v1/prediction-markets/terms/status', 'GET']
  ]);
  for (const {url, options, payload} of calls) {
    assert.equal(new URL(url).origin, 'https://api.gemini.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['X-GEMINI-APIKEY'], env.GEMINI_LIVE_API_KEY);
    assert.equal(options.headers['X-GEMINI-SIGNATURE'], createHmac('sha384', env.GEMINI_LIVE_API_SECRET).update(options.headers['X-GEMINI-PAYLOAD']).digest('hex'));
    assert.equal(options.headers['Content-Type'], 'text/plain');
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(new URL(url).search, '');
    assert.equal(payload.nonce, 1780000000 + calls.findIndex(call => call.options === options));
    if (options.method === 'POST') {
      assert.equal(options.body, '');
      assert.equal(options.headers['Content-Length'], '0');
    } else {
      assert.equal(options.body, undefined);
      assert.equal(options.headers['Content-Length'], undefined);
    }
  }
  assert.deepEqual(calls[0].payload, {request: '/v1/roles', nonce: 1780000000});
  assert.deepEqual(calls[1].payload, {request: '/v1/account/list', nonce: 1780000001, limit_accounts: 500});
  assert.deepEqual(calls[2].payload, {request: '/v1/balances', nonce: 1780000002, account: 'primary', showPendingBalances: false});
  assert.deepEqual(calls[3].payload, {request: '/v1/prediction-markets/terms/status', nonce: 1780000003, account: 'primary'});
  assert.deepEqual(snapshot, {roles, accountSelectionRequired: false,
    accountIdentity: createHash('sha256').update('pocket-quant:gemini:production:counterparty:v1\0fake-counterparty-id').digest('hex'),
    accountShortname: 'primary', accountLabel: 'Personal exchange', availableUsd: '12.99', termsAccepted: true});
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.roles));
});

test('only snapshot is exposed and browser arguments cannot choose accounts, hosts or mutations', async () => {
  const {client, calls} = setup();
  assert.deepEqual(Object.keys(client), ['snapshot']);
  for (const input of [{account: 'other'}, {path: '/v1/order/new'}, 'https://attacker.example', undefined]) {
    await assert.rejects(client.snapshot(input), isError('INVALID_INPUT', 400));
  }
  assert.equal(calls.length, 0);
});

test('configuration is lazy and requires explicit time nonce mode and a master key', async () => {
  for (const [config, code] of [
    [{}, 'CONFIG_REQUIRED'],
    [{...env, GEMINI_LIVE_API_SECRET: ''}, 'CONFIG_REQUIRED'],
    [{...env, GEMINI_LIVE_API_KEY: 'account-fake-key'}, 'MASTER_KEY_REQUIRED'],
    [{...env, GEMINI_LIVE_API_KEY: 'master-abc\r\nx-header:secret'}, 'CONFIG_REQUIRED'],
    [{...env, GEMINI_LIVE_NONCE_MODE: undefined}, 'TIME_NONCE_REQUIRED'],
    [{...env, GEMINI_LIVE_NONCE_MODE: 'monotonic'}, 'TIME_NONCE_REQUIRED'],
    [{...env, GEMINI_LIVE_ACCOUNT: 'primary/../../order/new'}, 'INVALID_ACCOUNT_CONFIG'],
    [{...env, GEMINI_LIVE_ACCOUNT: 123}, 'INVALID_ACCOUNT_CONFIG']
  ]) {
    const {client, calls} = setup({config});
    await assert.rejects(client.snapshot(), isError(code, 503));
    assert.equal(calls.length, 0);
  }
});

test('concurrent checks share a request sequence and every nonce uses an actual unique Unix second', async () => {
  const {client, calls, waits} = setup();
  const first = client.snapshot(), concurrent = client.snapshot();
  assert.equal(first, concurrent);
  await Promise.all([first, concurrent]);
  await client.snapshot();
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(call => call.payload.nonce), Array.from({length: 8}, (_, index) => 1780000000 + index));
  assert.deepEqual(waits, [750, 1000, 1000, 1000, 1000, 1000, 1000]);
});

test('a backward clock fails closed rather than jumping beyond Gemini nonce tolerance', async () => {
  const {client, calls, setClock} = setup();
  await client.snapshot();
  setClock(1779999960000);
  await assert.rejects(client.snapshot(), isError('NONCE_CLOCK', 503));
  assert.equal(calls.length, 4);
  for (const now of [() => NaN, () => '1780000000000', () => -1]) {
    const invalid = createGeminiLiveReadonly({env, now, fetchImpl: () => {throw new Error('must not fetch');}});
    await assert.rejects(invalid.snapshot(), isError('NONCE_CLOCK', 503));
  }
});

test('available USD is exact, floored to cents and never inferred from amount or withdrawal funds', async () => {
  for (const [value, expected] of [
    ['0', '0.00'], ['0.00999999', '0.00'], ['0.01999999', '0.01'], ['3.1', '3.10'],
    ['5.9999999999999999999999999', '5.99'], ['90071992547409.919999', '90071992547409.91']
  ]) {
    const {client} = setup({values: {'/v1/balances': [{currency: 'USD', available: value, amount: '999999.00', availableForWithdrawal: '888888.00'}]}});
    assert.equal((await client.snapshot()).availableUsd, expected);
  }
  const empty = setup({values: {'/v1/balances': []}});
  assert.equal((await empty.client.snapshot()).availableUsd, '0.00');
});

test('malformed, absent or duplicate USD balances fail closed', async () => {
  const badValues = [undefined, null, 1.25, -1, '', ' 1.25', '1.25 ', '-0.01', '+1.00', '1e2', '.50', '1.', '00.50', 'NaN', 'Infinity', '1,000.00', '90071992547409.92', '1'.repeat(129)];
  const badBalances = [null, {}, [{currency: 'BTC', available: '1.00'}], [null], [{available: '1.00'}],
    [{currency: 'USD', available: '1.00'}, {currency: 'USD', available: '2.00'}],
    ...badValues.map(available => [{currency: 'USD', available, amount: '100.00'}])];
  for (const balances of badBalances) {
    const {client, calls} = setup({values: {'/v1/balances': balances}});
    await assert.rejects(client.snapshot(), isError('INVALID_BALANCE', 502));
    assert.equal(calls.length, 3);
  }
});

test('multiple open exchange accounts require server selection without exposing the account list', async () => {
  const second = {...account, account: 'second', name: 'Second private account', counterparty_id: 'second-provider-id'};
  const {client, calls} = setup({values: {'/v1/account/list': [account, second]}});
  assert.deepEqual(await client.snapshot(), {roles, accountSelectionRequired: true, accountIdentity: null,
    accountShortname: null, accountLabel: null, availableUsd: null, termsAccepted: null});
  assert.equal(calls.length, 2);
  const configured = setup({config: {...env, GEMINI_LIVE_ACCOUNT: 'second'}, values: {'/v1/account/list': [account, second]}});
  const snapshot = await configured.client.snapshot();
  assert.equal(snapshot.accountLabel, second.name);
  assert.equal(snapshot.accountSelectionRequired, false);
  assert.equal(configured.calls[2].payload.account, 'second');
  assert.equal(configured.calls[3].payload.account, 'second');
});

test('only verified open exchange accounts qualify, even for a configured selection', async () => {
  for (const accounts of [[], [{...account, status: 'closed'}], [{...account, type: 'custody'}]]) {
    const {client, calls} = setup({values: {'/v1/account/list': accounts}});
    await assert.rejects(client.snapshot(), isError('NO_OPEN_ACCOUNT', 409));
    assert.equal(calls.length, 2);
  }
  for (const accounts of [[account], [{...account, account: 'selected', status: 'closed'}], [{...account, account: 'selected', type: 'custody'}]]) {
    const {client, calls} = setup({config: {...env, GEMINI_LIVE_ACCOUNT: 'selected'}, values: {'/v1/account/list': accounts}});
    await assert.rejects(client.snapshot(), isError('ACCOUNT_NOT_AVAILABLE', 409));
    assert.equal(calls.length, 2);
  }
  const ignored = setup({values: {'/v1/account/list': [{...account, account: 'closed', status: 'closed'}, account]}});
  assert.equal((await ignored.client.snapshot()).accountSelectionRequired, false);
});

test('malformed or potentially truncated account responses cannot establish a selection', async () => {
  for (const accounts of [{data: [account]}, [account, account], [{...account, account: '//attacker.example'}],
    [{...account, counterparty_id: undefined}], [{...account, counterparty_id: ''}], [{...account, name: 'name\nprivate'}]]) {
    const {client, calls} = setup({values: {'/v1/account/list': accounts}});
    await assert.rejects(client.snapshot(), isError('INVALID_RESPONSE', 502));
    assert.equal(calls.length, 2);
  }
  const {client, calls} = setup({values: {'/v1/account/list': Array.from({length: 500}, (_, index) => ({...account, account: `account-${index}`}))}});
  await assert.rejects(client.snapshot(), isError('ACCOUNT_LIST_INCOMPLETE', 409));
  assert.equal(calls.length, 2);
});

test('server identity is provider-based and survives key rotation; private extras never escape', async () => {
  const extra = {users: [{email: 'PRIVATE_USER_EMAIL'}], bank: 'PRIVATE_BANK', key: env.GEMINI_LIVE_API_KEY, secret: env.GEMINI_LIVE_API_SECRET};
  const values = {'/v1/roles': {...roles, ...extra}, '/v1/account/list': [{...account, ...extra}],
    '/v1/balances': [{currency: 'USD', available: '4.25', ...extra}], '/v1/prediction-markets/terms/status': {hasAcceptedLatest: true, ...extra}};
  const before = JSON.stringify(values), config = {...env};
  const first = await setup({values, config}).client.snapshot();
  const rotated = await setup({values, config: {...env, GEMINI_LIVE_API_KEY: 'master-rotated-fake-key', GEMINI_LIVE_API_SECRET: 'rotated-fake-secret'}}).client.snapshot();
  const differentAccount = await setup({values: {...values, '/v1/account/list': [{...account, counterparty_id: 'different-id'}]}}).client.snapshot();
  assert.equal(first.accountIdentity, rotated.accountIdentity);
  assert.notEqual(first.accountIdentity, differentAccount.accountIdentity);
  assert.equal(JSON.stringify(values), before);
  assert.deepEqual(config, env);
  assert.equal(first.accountShortname,account.account);
  for (const value of [account.counterparty_id, 'PRIVATE_USER_EMAIL', 'PRIVATE_BANK', env.GEMINI_LIVE_API_KEY, env.GEMINI_LIVE_API_SECRET]) {
    assert.equal(JSON.stringify(first).includes(value), false);
  }
});

test('roles and terms must contain booleans, and false terms acceptance stays false', async () => {
  for (const invalidRoles of [null, [], {...roles, isAuditor: 'true'}, {...roles, isTrader: undefined}]) {
    const {client, calls} = setup({values: {'/v1/roles': invalidRoles}});
    await assert.rejects(client.snapshot(), isError('INVALID_RESPONSE', 502));
    assert.equal(calls.length, 1);
  }
  for (const terms of [null, {}, {hasAcceptedLatest: 'true'}, {hasAcceptedLatest: 1}]) {
    await assert.rejects(setup({values: {'/v1/prediction-markets/terms/status': terms}}).client.snapshot(), isError('INVALID_RESPONSE', 502));
  }
  const {client} = setup({values: {'/v1/prediction-markets/terms/status': {hasAcceptedLatest: false}}});
  assert.equal((await client.snapshot()).termsAccepted, false);
});

test('provider errors expose only allowlisted reason codes and never retry a request', async () => {
  for (const [status, reason, code, expectedStatus] of [
    [401, 'InvalidApiKey', 'AUTHENTICATION', 401], [400, 'InvalidNonce', 'AUTHENTICATION', 401],
    [403, 'MissingRole', 'PERMISSION', 403], [429, 'RateLimit', 'RATE_LIMIT', 429],
    [503, 'Maintenance', 'UNAVAILABLE', 502], [400, 'PRIVATE_CUSTOM_REASON', 'UNAVAILABLE', 502]
  ]) {
    const {client, calls} = setup({fetchImpl: async () => json({result: 'error', reason, message: `PRIVATE_DETAIL ${env.GEMINI_LIVE_API_SECRET}`, users: ['PRIVATE_USER']}, status)});
    await assert.rejects(client.snapshot(), error => {
      assert.ok(isError(code, expectedStatus)(error));
      assert.equal(error.reason, reason === 'PRIVATE_CUSTOM_REASON' ? undefined : reason);
      assert.equal(error.cause, undefined);
      assert.ok(!`${error} ${JSON.stringify(error)}`.includes('PRIVATE_'));
      assert.ok(!`${error} ${JSON.stringify(error)}`.includes(env.GEMINI_LIVE_API_SECRET));
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const transport = setup({fetchImpl: async () => {throw new Error('PRIVATE_TRANSPORT_DETAILS');}});
  await assert.rejects(transport.client.snapshot(), error => isError('UNAVAILABLE', 502)(error) && !String(error).includes('PRIVATE_'));
  assert.equal(transport.calls.length, 1);
});

test('redirected, oversized and unreadable responses are rejected and aborted', async () => {
  const responses = [
    () => new Response('PRIVATE_UNREADABLE_BODY'),
    () => new Response('x'.repeat(262145)),
    () => new Response('{}', {headers: {'content-length': '262145'}}),
    () => {const response = json(roles); Object.defineProperty(response, 'url', {value: 'https://attacker.example/v1/roles'}); return response;},
    () => {const response = json(roles); Object.defineProperty(response, 'redirected', {value: true}); return response;}
  ];
  for (const response of responses) {
    const {client, calls} = setup({fetchImpl: async () => response()});
    await assert.rejects(client.snapshot(), isError('INVALID_RESPONSE', 502));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.signal.aborted, true);
  }
});

test('the request deadline includes both network connection and response-body reading', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const responseHangs of [false, true]) {
    let signal;
    const {client} = setup({fetchImpl: async (_, options) => {
      signal = options.signal;
      if (!responseHangs) return new Promise(() => {});
      return {ok: true, status: 200, headers: new Headers(), body: {getReader: () => ({read: () => new Promise(() => {}), releaseLock() {}})}};
    }});
    const failure = assert.rejects(client.snapshot(), isError('TIMEOUT', 504));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(12000);
    await failure;
    assert.equal(signal.aborted, true);
  }
});
