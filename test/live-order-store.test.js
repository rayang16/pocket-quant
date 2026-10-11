import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveOrderStore} from '../lib/live-order-store.js';

const url = 'https://demo-redis-123.upstash.io';
const token = 'test-redis-token';
const previewToken = 'abcdefghijklmnop1234567890';
const now = Date.now();
const preview = {sessionId: 'session-a', accountId: 'account-a', order: {symbol: 'GEMI-DEMO', amount: '1', price: '0.50'}, estimatedTotalCents: 55, expiresAt: now + 120000};
const journal = {...preview, status: 'submitting', startedAt: now, updatedAt: now};
const budget = {reservedCents: 55, unresolved: true};
const response = result => new Response(JSON.stringify({result}), {headers: {'content-type': 'application/json'}});
const encoded = result => JSON.stringify(result);
function mockStore(results, overrides = {}) {
  const calls = [];
  const store = createLiveOrderStore({url, token, fetchImpl: async (endpoint, options) => {
    const command = JSON.parse(options.body);
    calls.push({endpoint, options, command});
    assert.ok(results.length, 'unexpected Redis command');
    const result = results.shift();
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : response(result);
  }, ...overrides});
  return {store, calls};
}
const storeError = error => typeof error.code === 'string' && error.code.startsWith('STORE_');

test('no configured credentials means no production store, never an in-memory substitute', () => {
  for (const config of [{url: null, token: null}, {url, token: ''}, {url: '', token}]) {
    assert.equal(createLiveOrderStore({...config, fetchImpl: () => assert.fail('unexpected request')}), null);
  }
});

test('only an HTTPS Upstash REST root without credentials or redirects is accepted', () => {
  for (const endpoint of ['http://demo.upstash.io', 'https://upstash.io', 'https://upstash.io.evil.com', 'https://evil.com',
    'https://demo.upstash.io/other', 'https://demo.upstash.io?x=y', 'https://user:secret@demo.upstash.io', 'https://demo.upstash.io:444', 'not-url']) {
    assert.throws(() => createLiveOrderStore({url: endpoint, token}), error => error.code === 'STORE_INVALID_CONFIG');
  }
  assert.throws(() => createLiveOrderStore({url, token, namespace: 'namespace:unsafe'}), storeError);
  assert.throws(() => createLiveOrderStore({url, token: 'line\nbreak'}), storeError);
});

test('preview writes use NX and a bounded expiry and never put credentials in command data', async () => {
  const {store, calls} = mockStore(['OK']);
  assert.equal(store.durable, true);
  assert.deepEqual(await store.putPreview(previewToken, preview), preview);
  const {command, options, endpoint} = calls[0];
  assert.equal(endpoint, `${url}/`);
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, `Bearer ${token}`);
  assert.equal(options.method, 'POST');
  assert.equal(command[0], 'SET');
  assert.match(command[1], /^pocket-quant-live-v1:preview:[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(command[2]), preview);
  assert.deepEqual(command.slice(3, 5), ['NX', 'PX']);
  assert.ok(command[5] > 0 && command[5] <= 120000);
  assert.equal(options.body.includes(token), false);
  assert.equal(command[1].includes(previewToken), false);
});

test('duplicate preview cannot extend or replace the original authorization', async () => {
  const {store, calls} = mockStore([null]);
  await assert.rejects(store.putPreview(previewToken, preview), error => error.code === 'STORE_PREVIEW_EXISTS');
  assert.equal(calls.length, 1);
});

test('getPreview handles absence and expiry and returns only validated records', async () => {
  const {store} = mockStore([null, encoded({...preview, expiresAt: now - 1}), encoded(preview), encoded({...preview, estimatedTotalCents: -1})]);
  assert.equal(await store.getPreview(previewToken), null);
  assert.equal(await store.getPreview(previewToken), null);
  assert.deepEqual(await store.getPreview(previewToken), preview);
  await assert.rejects(store.getPreview(previewToken), error => error.code === 'STORE_CORRUPT_STATE');
});

test('begin uses one atomic Lua call for binding, duplicate prevention, budget and durable reservation', async () => {
  const {store, calls} = mockStore([encoded({ok: true, submission: journal, budget})]);
  assert.deepEqual(await store.beginSubmission(previewToken, {sessionId: preview.sessionId, accountId: preview.accountId, now}), {ok: true, submission: journal, budget});
  assert.equal(calls.length, 1);
  const [operation, script, numberOfKeys, previewKey, submissionKey, accountKey, sessionId, accountId, timestamp, maximum] = calls[0].command;
  assert.equal(operation, 'EVAL');
  assert.equal(numberOfKeys, 3);
  assert.match(previewKey, /:preview:/);
  assert.match(submissionKey, /:submission:/);
  assert.match(accountKey, /:budget:[a-f0-9]{64}$/);
  assert.equal(accountKey.includes(preview.accountId), false);
  assert.equal(sessionId, preview.sessionId);
  assert.equal(accountId, preview.accountId);
  assert.equal(timestamp, now);
  assert.equal(maximum, 500);
  assert.match(script, /journal\.sessionId ~= ARGV\[1\]/);
  assert.match(script, /preview\.accountId ~= ARGV\[2\]/);
  assert.match(script, /preview\.expiresAt\) <= now/);
  assert.match(script, /reserved \+ amount > maximum/);
  assert.match(script, /unresolved_submission/);
  assert.ok(script.indexOf("'HSET'") < script.indexOf("'SET'"));
  assert.ok(script.indexOf("'SET'") < script.indexOf("'DEL'"));
  assert.doesNotMatch(script, /\b(?:EXPIRE|PEXPIRE|EX|PX|HINCRBY)\b/);
});

test('duplicate, mismatched, expired, unresolved and exhausted outcomes do not authorize an order', async () => {
  const cases = [
    {ok: false, reason: 'duplicate', submission: journal},
    {ok: false, reason: 'preview_missing'}, {ok: false, reason: 'preview_expired'},
    {ok: false, reason: 'session_mismatch'}, {ok: false, reason: 'account_mismatch'},
    {ok: false, reason: 'unresolved_submission', budget},
    {ok: false, reason: 'budget_exceeded', budget: {reservedCents: 500, unresolved: false}}
  ];
  const {store, calls} = mockStore(cases.map(encoded));
  for (const expected of cases) {
    const actual = await store.beginSubmission(previewToken, {sessionId: preview.sessionId, accountId: preview.accountId, now});
    assert.deepEqual(actual, expected);
    assert.equal(actual.ok, false);
  }
  assert.equal(calls.length, cases.length);
});

test('a duplicate reported through another store instance stays rejected, with no instance-local fallback', async () => {
  const first = mockStore([encoded({ok: true, submission: journal, budget})]);
  const second = mockStore([encoded({ok: false, reason: 'duplicate', submission: journal})]);
  const input = {sessionId: preview.sessionId, accountId: preview.accountId, now};
  assert.equal((await first.store.beginSubmission(previewToken, input)).ok, true);
  assert.equal((await second.store.beginSubmission(previewToken, input)).ok, false);
  assert.equal(first.calls[0].command[4], second.calls[0].command[4]);
});

test('bad or contradictory Redis success responses fail closed', async () => {
  const invalid = [
    {ok: true, submission: {...journal, accountId: 'other'}, budget},
    {ok: true, submission: {...journal, expiresAt: now - 1}, budget},
    {ok: true, submission: journal, budget: {reservedCents: 0, unresolved: true}},
    {ok: true, submission: journal, budget: {reservedCents: 55, unresolved: false}},
    {ok: false, reason: 'corrupt_state'}, {ok: false, reason: 'unexpected'},
    {ok: false, reason: 'duplicate', submission: {...journal, sessionId: 'other'}}
  ];
  const {store} = mockStore(invalid.map(encoded));
  for (const _ of invalid) await assert.rejects(store.beginSubmission(previewToken, {sessionId: preview.sessionId, accountId: preview.accountId, now}), error => error.code === 'STORE_CORRUPT_STATE');
});

test('finish retains the lifetime reservation and unknown results retain the account gate', async () => {
  const result = {status: 'unknown', code: 'EXCHANGE_TIMEOUT'};
  const finished = {...journal, status: 'unknown', updatedAt: now + 1, result};
  const {store, calls} = mockStore([encoded(journal), encoded({ok: true, submission: finished})]);
  assert.deepEqual(await store.finishSubmission(previewToken, result), finished);
  assert.equal(calls[0].command[0], 'GET');
  const [operation, script, count, submissionKey, budgetKey, json] = calls[1].command;
  assert.equal(operation, 'EVAL');
  assert.equal(count, 2);
  assert.match(submissionKey, /:submission:/);
  assert.match(budgetKey, /:budget:/);
  assert.deepEqual(JSON.parse(json), result);
  assert.match(script, /if result\.status ~= 'unknown' then redis\.call\('HDEL', KEYS\[2\], 'unresolved'\) end/);
  assert.match(script, /gate ~= KEYS\[1\]/);
  assert.doesNotMatch(script, /\b(?:EXPIRE|PEXPIRE|EX|PX|HINCRBY|HSET)\b/);
});

test('complete and rejected results retain reservations, and prior terminal journals cannot be overwritten', async () => {
  for (const status of ['complete', 'rejected']) {
    const result = {status, orderId: 'demo-order'}, finished = {...journal, status, updatedAt: now + 1, result};
    const {store, calls} = mockStore([encoded(journal), encoded({ok: true, submission: finished})]);
    assert.deepEqual(await store.finishSubmission(previewToken, result), finished);
    assert.match(calls[1].command[1], /if journal\.status == 'complete' or journal\.status == 'rejected' then return/);
    assert.equal(Object.hasOwn(store, 'markPreflightRejected'), false);
  }
});

test('missing, corrupt or lost reservation prevents finishing instead of resetting budget', async () => {
  const missing = mockStore([null]);
  await assert.rejects(missing.store.finishSubmission(previewToken, {status: 'complete'}), error => error.code === 'STORE_SUBMISSION_MISSING');
  assert.equal(missing.calls.length, 1);
  const corrupt = mockStore([encoded(journal), encoded({ok: false, reason: 'corrupt_state'})]);
  await assert.rejects(corrupt.store.finishSubmission(previewToken, {status: 'complete'}), error => error.code === 'STORE_CORRUPT_STATE');
});

test('durable budget reads persist spend while separately reporting unresolved submissions', async () => {
  const {store, calls} = mockStore([[null, null], ['55', 'submission-key'], ['55', null], ['500', null], [null, 'unresolved'], ['garbage', null], ['501', null]]);
  assert.deepEqual(await store.getBudget('account-a'), {reservedCents: 0, unresolved: false});
  assert.deepEqual(await store.getBudget('account-a'), {reservedCents: 55, unresolved: true});
  assert.deepEqual(await store.getBudget('account-a'), {reservedCents: 55, unresolved: false});
  assert.deepEqual(await store.getBudget('account-a'), {reservedCents: 500, unresolved: false});
  for (let i = 0; i < 3; i++) await assert.rejects(store.getBudget('account-a'), error => error.code === 'STORE_CORRUPT_STATE');
  assert.deepEqual(calls[0].command.slice(2), ['reservedCents', 'unresolved']);
});

test('invalid inputs and budget increases fail before transport', async () => {
  const {store, calls} = mockStore([]);
  for (const changes of [{estimatedTotalCents: 0}, {estimatedTotalCents: 501}, {estimatedTotalCents: 1.5}, {accountId: ''}, {expiresAt: now - 1}, {expiresAt: Date.now() + 130000}, {order: {oversized: 'x'.repeat(6001)}}]) {
    await assert.rejects(store.putPreview(previewToken, {...preview, ...changes}), storeError);
  }
  for (const changes of [{maxBudgetCents: 501}, {maxBudgetCents: 0}, {sessionId: ''}, {now: -1}]) {
    await assert.rejects(store.beginSubmission(previewToken, {sessionId: preview.sessionId, accountId: preview.accountId, now, ...changes}), storeError);
  }
  await assert.rejects(store.getSubmission('tiny'), storeError);
  await assert.rejects(store.finishSubmission(previewToken, {status: 'retry'}), storeError);
  assert.equal(calls.length, 0);
});

test('Redis errors, malformed data and network failures reveal no provider secrets and are never retried', async () => {
  for (const data of [new Error('test-redis-token private details'), new Response('test-redis-token', {status: 500}),
    new Response(JSON.stringify({error: 'test-redis-token private details'})), new Response('not-json'), new Response('x'.repeat(65537))]) {
    const {store, calls} = mockStore([data]);
    await assert.rejects(store.beginSubmission(previewToken, {sessionId: preview.sessionId, accountId: preview.accountId, now}), error => {
      assert.doesNotMatch(error.message + JSON.stringify(error), /test-redis-token|private details/);
      return error.code === 'STORE_UNAVAILABLE';
    });
    assert.equal(calls.length, 1);
  }
});

test('mutation timeout covers body reading, aborts once, and does not retry an uncertain reservation', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let requests = 0, signal;
  const store = createLiveOrderStore({url, token, fetchImpl: async (_url, options) => {
    requests++; signal = options.signal;
    return {ok: true, text: () => new Promise(() => {})};
  }});
  const pending = store.beginSubmission(previewToken, {sessionId: preview.sessionId, accountId: preview.accountId, now});
  const rejected = assert.rejects(pending, error => error.code === 'STORE_TIMEOUT');
  await Promise.resolve();
  t.mock.timers.tick(8000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(requests, 1);
});
