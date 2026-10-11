import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceReporter, validateReportInput} from '../lib/evidence-report.js';
import {createReportHandler} from '../api/evidence-report.js';

const now = new Date('2026-10-11T00:00:00Z');
const claim = {id: 'claim-1', text: 'Acme signed a $400 million contract in 2025.', quote: 'Acme signed a $400 million contract in 2025.', type: 'fact'};
const market = {status: 'none', reason: 'No matching market.', matches: []};
const evidence = {assessment: {status: 'supported', summary: 'The issuer announced an agreement.', limitations: []}, sources: [{id: 'source-1', title: 'Issuer announcement', url: 'https://example.com/release', sourceType: 'unknown', publishedAt: null, excerpt: null}]};
const createReporter = options => createEvidenceReporter({providerFactory: () => null, marketLookup: async () => market, checker: () => assert.fail('unexpected probability check'), clock: () => now, ...options});
const response = () => ({headers: {}, setHeader(name, value) {this.headers[name] = value;}, end(body) {this.body = body;}});
async function request(handler, overrides = {}) {
  const req = {method: 'POST', url: '/api/evidence-report?action=check', headers: {host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json'}, body: JSON.stringify({claim}), ...overrides};
  const res = response();
  await handler(req, res);
  return {...res, data: JSON.parse(res.body)};
}

test('report inputs reject unknown fields, invalid types, unsupported links and oversized text', () => {
  const invalid = [
    ['extract', null], ['extract', []], ['extract', {text: 'hi'}], ['extract', {text: 'x'.repeat(6001)}],
    ['extract', {text: claim.text, providerKey: 'test-secret'}],
    ['extract', {text: claim.text, sourceUrl: 'https://example.com/reel/test'}],
    ['check', {claim: {...claim, id: 'claim-4'}}], ['check', {claim: {...claim, type: 'verified'}}],
    ['check', {claim: {...claim, text: 'x'.repeat(501)}}], ['check', {claim: {...claim, quote: 'x'.repeat(2001)}}],
    ['check', {claim: {...claim, secret: true}}], ['check', {claim: []}], ['delete', {claim}]
  ];
  for (const [action, input] of invalid) assert.throws(() => validateReportInput(action, input), error => error.status === 400);
  assert.deepEqual(validateReportInput('extract', {text: ` ${claim.text} `, sourceUrl: 'https://www.instagram.com/reel/Db8kR0kud6W/'}), {text: claim.text});
});

test('manually mislabeled predictions and direct recommendations keep nonfactual types', () => {
  for (const [text, type] of [
    ['Tesla will produce one million robots by 2027.', 'forecast'],
    ['Tesla is expected to produce one million robots.', 'forecast'],
    ['Acme production reaches 1 million robots by 2027.', 'forecast'],
    ['Tesla is going to produce one million robots.', 'forecast'],
    ['You should buy Acme shares.', 'recommendation'],
    ['I would buy Acme shares.', 'recommendation']
  ]) {
    assert.equal(validateReportInput('check', {claim: {...claim, text}}, now).claim.type, type, text);
  }
});

test('unconfigured research still returns honest per-claim states and related markets', async () => {
  const report = createReporter();
  for (const [type, status] of [['fact', 'unavailable'], ['forecast', 'forecast'], ['recommendation', 'opinion']]) {
    const result = await report('check', {claim: {...claim, type}});
    assert.equal(result.assessment.status, status);
    assert.match(result.assessment.summary, /not configured/);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.market, market);
    assert.equal(result.model, null);
    assert.equal(result.checkedAt, now.toISOString());
  }
});

test('unconfigured extraction preserves source statements with an honest rules warning', async () => {
  const result = await createReporter()('extract', {text: claim.text});
  assert.equal(result.extraction, 'rules');
  assert.equal(result.claims[0].text, claim.text);
  assert.ok(result.warnings.length);
});

test('one failed claim does not erase another claim and provider error details do not leak', async () => {
  const report = createReporter({providerFactory: () => ({research: async value => {
    if (value.id === 'claim-2') throw new Error('secret provider credential');
    return evidence;
  }})});
  const [good, failed] = await Promise.all([
    report('check', {claim}),
    report('check', {claim: {...claim, id: 'claim-2', text: 'OtherCo reported $10 million in 2025.'}})
  ]);
  assert.equal(good.assessment.status, 'supported');
  assert.equal(failed.assessment.status, 'unavailable');
  assert.equal(failed.market.status, 'none');
  assert.doesNotMatch(JSON.stringify(failed), /secret provider credential/);
});

test('market failure preserves source evidence, and undated relative claims explain the limitation', async () => {
  const report = createReporter({providerFactory: () => ({research: async () => evidence}), marketLookup: async () => {throw new Error('private market diagnostics');}});
  const result = await report('check', {claim: {...claim, text: 'Acme reported $10 million last year.'}});
  assert.equal(result.assessment.status, 'supported');
  assert.equal(result.market.status, 'unavailable');
  assert.match(result.assessment.limitations.join(' '), /publication date is unknown/);
  assert.doesNotMatch(JSON.stringify(result), /private market diagnostics/);
});

test('concurrent duplicate inputs share one research job and expire after five minutes', async () => {
  let calls = 0, tick = +now, resolve;
  const pending = new Promise(done => {resolve = done;});
  const report = createReporter({clock: () => new Date(tick), providerFactory: () => ({research: async () => {calls++; await pending; return evidence;}})});
  const first = report('check', {claim});
  const duplicate = report('check', {claim});
  assert.equal(calls, 1);
  resolve();
  assert.deepEqual(await first, await duplicate);
  await report('check', {claim});
  assert.equal(calls, 1);
  tick += 5 * 60000 + 1;
  await report('check', {claim});
  assert.equal(calls, 2);
});

test('failed research can be retried immediately and provider availability changes invalidate rules cache', async () => {
  let enabled = true, calls = 0;
  const provider = {research: async () => {if (++calls === 1) throw new Error('temporary error'); return evidence;}};
  const report = createReporter({providerFactory: () => enabled ? provider : null});
  assert.equal((await report('check', {claim})).assessment.status, 'unavailable');
  assert.equal((await report('check', {claim})).assessment.status, 'supported');
  assert.equal(calls, 2);
  enabled = false;
  assert.equal((await report('check', {claim})).assessment.status, 'unavailable');
});

test('per-client rate limit bounds unique paid checks and resets after one minute', async () => {
  let tick = +now;
  const report = createReporter({clock: () => new Date(tick), providerFactory: () => ({research: async () => evidence})});
  for (let index = 0; index < 12; index++) await report('check', {claim: {...claim, text: `Acme reported $${index + 1} million in revenue.`}}, {client: 'client-a'});
  await assert.rejects(report('check', {claim}, {client: 'client-a'}), error => error.status === 429);
  assert.equal((await report('check', {claim}, {client: 'client-b'})).assessment.status, 'supported');
  tick += 60001;
  assert.equal((await report('check', {claim: {...claim, text: 'Acme reported $99 million.'}}, {client: 'client-a'})).assessment.status, 'supported');
});

test('global concurrency is bounded and capacity is released after work finishes', async () => {
  let resolve, calls = 0;
  const pending = new Promise(done => {resolve = done;});
  const report = createReporter({providerFactory: () => ({research: async () => {calls++; await pending; return evidence;}})});
  const jobs = Array.from({length: 8}, (_, index) => report('check', {claim: {...claim, text: `Acme reported $${index + 1} million.`}}, {client: `client-${index}`}));
  assert.equal(calls, 8);
  await assert.rejects(report('check', {claim}, {client: 'another-client'}), error => error.status === 429);
  resolve();
  await Promise.all(jobs);
  assert.equal((await report('check', {claim}, {client: 'another-client'})).assessment.status, 'supported');
  assert.equal(calls, 9);
});

test('the independent probability model requires a crypto forecast and explicit year/date', async () => {
  let modelCalls = 0;
  const report = createReporter({checker: async () => {modelCalls++; return {status: 'complete'};}});
  for (const text of ['Tesla will produce one million robots by 2027.', 'BTC will reach $200000 next year.']) {
    const result = await report('check', {claim: {...claim, type: 'forecast', text}});
    assert.equal(result.model, null);
    assert.match(result.assessment.limitations.join(' '), /No independent probability model/);
  }
  const result = await report('check', {claim: {...claim, type: 'forecast', text: 'BTC will reach $200000 by December 31, 2027.'}});
  assert.equal(modelCalls, 1);
  assert.deepEqual(result.model, {status: 'complete'});
});

test('report endpoint rejects methods, foreign origins and non-JSON requests before work begins', async () => {
  const handler = createReportHandler(() => assert.fail('must not run report'));
  const cases = [
    [{method: 'GET'}, 405], [{method: 'OPTIONS'}, 405],
    [{headers: {host: 'localhost:3000', origin: 'https://attacker.example', 'content-type': 'application/json'}}, 403],
    [{headers: {host: 'localhost:3000', origin: 'invalid origin', 'content-type': 'application/json'}}, 403],
    [{headers: {host: 'localhost:3000', 'content-type': 'text/plain'}}, 415]
  ];
  for (const [input, status] of cases) {
    const result = await request(handler, input);
    assert.equal(result.statusCode, status);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
});

test('report endpoint bounds request bodies and rejects invalid action and malformed JSON', async () => {
  const handler = createReportHandler(() => assert.fail('must not run report'));
  for (const [input, status] of [[{url: '/api/evidence-report?action=delete'}, 400], [{body: '{'}, 400], [{body: 'x'.repeat(26001)}, 413]]) {
    assert.equal((await request(handler, input)).statusCode, status);
  }
});

test('report endpoint forwards valid input and hides unexpected internal errors', async () => {
  let received;
  const good = await request(createReportHandler(async (...args) => {received = args; return {ok: true};}));
  assert.equal(good.statusCode, 200);
  assert.deepEqual(received.slice(0, 2), ['check', {claim}]);
  assert.deepEqual(good.data, {ok: true});
  const failed = await request(createReportHandler(async () => {throw new Error('internal-secret-token');}));
  assert.equal(failed.statusCode, 502);
  assert.doesNotMatch(failed.body, /internal-secret-token/);
});
