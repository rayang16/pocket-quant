import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSearchSources, createEvidenceProvider, normalizeAssessment, safeEvidenceUrl} from '../lib/evidence-provider.js';

const sourceUrl = 'https://investors.mpmaterials.com/news/agreement';
const claim = {id: 'claim-1', text: 'Acme signed a $400 million contract in 2025.', quote: 'Acme signed a $400 million contract in 2025.', type: 'fact'};
const hit = (url = sourceUrl, extra = {}) => ({type: 'web_search_result', url, title: 'Official agreement announcement', page_age: '2025-07-10', ...extra});
const search = (...hits) => ({type: 'web_search_tool_result', content: hits});
const assessment = (extra = {}) => ({kind: 'fact', status: 'supported', summary: 'The company announced this agreement.', limitations: [], sourceUrls: [sourceUrl], ...extra});
const submitted = (input = assessment()) => ({content: [{type: 'tool_use', name: 'submit_assessment', input}]});
const json = body => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
function mockProvider(responses) {
  const calls = [];
  const provider = createEvidenceProvider({apiKey: 'test-only-secret', fetchImpl: async (url, options) => {
    calls.push({url, ...options, body: JSON.parse(options.body)});
    assert.ok(responses.length, 'unexpected provider request');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : json(next);
  }});
  return {provider, calls};
}

test('evidence URLs allow only public HTTPS links without credentials or nonstandard ports', () => {
  assert.equal(safeEvidenceUrl('https://www.sec.gov/Archives/report.htm#section'), 'https://www.sec.gov/Archives/report.htm');
  for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,test', 'https://user:secret@example.com', 'https://example.com:8443', 'https://localhost', 'https://foo.localhost', 'https://foo.local', 'https://foo.internal', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'not a URL']) {
    assert.equal(safeEvidenceUrl(url), null, url);
  }
});

test('only web-search tool results can establish sources, with bounded citation excerpts', () => {
  const fabricated = 'https://example.com/model-invented';
  const words = Array.from({length: 40}, (_, index) => `word${index}`).join(' ');
  const sources = collectSearchSources([{content: [
    {type: 'text', text: `Citation: ${fabricated}`, citations: [
      {type: 'web_search_result_location', url: sourceUrl, cited_text: words},
      {type: 'web_search_result_location', url: fabricated, cited_text: 'This did not come from a search result.'}
    ]},
    {type: 'tool_use', name: 'submit_assessment', input: assessment({sourceUrls: [fabricated]})},
    search(hit(), hit(`${sourceUrl}#duplicate`), hit('https://127.0.0.1/private'), {...hit(fabricated), type: 'text'})
  ]}]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, sourceUrl);
  assert.equal(sources[0].title, 'Official agreement announcement');
  assert.equal(sources[0].publishedAt, '2025-07-10T00:00:00.000Z');
  assert.equal(sources[0].sourceType, 'primary');
  assert.equal(sources[0].excerpt.split(' ').length, 20);
});

test('missing publication dates and unrelated domains are not upgraded to primary evidence', () => {
  const [source] = collectSearchSources([{content: [search(hit('https://tesla.com.example.org/story', {page_age: 'yesterday'}))]}]);
  assert.equal(source.publishedAt, null);
  assert.equal(source.sourceType, 'unknown');
  assert.equal(source.excerpt, null);
});

test('invented assessment URLs are discarded even when the model asserts support', () => {
  const sources = collectSearchSources([{content: [search(hit())]}]);
  for (const urls of [['https://example.com/fabricated'], [sourceUrl, 'https://example.com/fabricated']]) {
    const result = normalizeAssessment(assessment({sourceUrls: urls}), claim, sources);
    assert.ok(result.sources.every(source => source.url === sourceUrl));
    assert.equal(result.assessment.status, 'unverified');
    assert.doesNotMatch(result.assessment.summary, /announced this agreement/);
  }
});

test('source-free claims cannot be supported or contradicted', () => {
  for (const status of ['supported', 'contradicted', 'mixed']) {
    const result = normalizeAssessment(assessment({status}), claim, []);
    assert.equal(result.assessment.status, 'unverified');
    assert.match(result.assessment.limitations.join(' '), /missing sources/);
  }
});

test('forecasts and recommendations never receive factual verdicts', () => {
  const sources = collectSearchSources([{content: [search(hit())]}]);
  for (const [type, status] of [['forecast', 'forecast'], ['recommendation', 'opinion']]) {
    for (const available of [sources, []]) {
      const result = normalizeAssessment(assessment({status: 'contradicted'}), {...claim, type}, available);
      assert.equal(result.assessment.status, status);
    }
  }
  assert.equal(normalizeAssessment(assessment({kind: 'forecast'}), claim, sources).assessment.status, 'forecast');
  assert.equal(normalizeAssessment(assessment({kind: 'recommendation'}), claim, sources).assessment.status, 'opinion');
});

test('research searches first and submits only assessments grounded in returned search sources', async () => {
  const {provider, calls} = mockProvider([
    {content: [search(hit()), {type: 'text', text: 'The issuer reported an agreement.', citations: [{type: 'web_search_result_location', url: sourceUrl, cited_text: 'The agreement runs for ten years.'}]}]},
    submitted(assessment())
  ]);
  const result = await provider.research(claim, {now: new Date('2026-10-11T00:00:00Z')});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].body.tools[0].name, 'web_search');
  assert.equal(calls[0].body.tools[0].max_uses, 3);
  assert.equal(calls[1].body.tool_choice.name, 'submit_assessment');
  assert.equal(result.assessment.status, 'supported');
  assert.deepEqual(result.sources.map(source => source.url), [sourceUrl]);
  assert.equal(result.sources[0].excerpt, 'The agreement runs for ten years.');
  assert.match(result.assessment.limitations.join(' '), /not independent confirmation/);
});

test('a search tool failure is actionable and cannot be promoted into cited evidence', async () => {
  const error = {type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded'};
  for (const content of [error, [error]]) {
    const {provider, calls} = mockProvider([{content: [
      {type: 'web_search_tool_result', content},
      {type: 'text', text: `This is definitely true: ${sourceUrl}.`}
    ]}]);
    await assert.rejects(provider.research(claim), /research is unavailable/);
    assert.equal(calls.length, 1);
  }
});

test('a text-only answer cannot be promoted into cited evidence', async () => {
  const {provider, calls} = mockProvider([{content: [{type: 'text', text: `This is definitely true: ${sourceUrl}.`}]}]);
  const result = await provider.research(claim);
  assert.equal(calls.length, 1);
  assert.equal(result.assessment.status, 'unverified');
  assert.deepEqual(result.sources, []);
});

test('paused web searches resume at most once and collect both result sets', async () => {
  const other = 'https://www.sec.gov/Archives/filing.htm';
  const {provider, calls} = mockProvider([
    {stop_reason: 'pause_turn', content: [search(hit())]},
    {stop_reason: 'pause_turn', content: [search(hit(other))]},
    submitted(assessment({sourceUrls: [sourceUrl, other]}))
  ]);
  const result = await provider.research(claim);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.sources.map(source => source.url), [sourceUrl, other]);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.equal(calls[1].signal, calls[2].signal);
});

test('no key disables the provider without making a request', () => {
  assert.equal(createEvidenceProvider({apiKey: '', fetchImpl: () => assert.fail('must not fetch')}), null);
});

test('provider transport and HTTP failures return safe errors without response bodies or secrets', async () => {
  for (const response of [new Error('credential test-only-secret'), ...[401, 403, 429, 500].map(status => new Response('credential test-only-secret', {status}))]) {
    const {provider} = mockProvider([response]);
    await assert.rejects(provider.extract(claim.text), error => {
      assert.doesNotMatch(error.message, /test-only-secret|credential/);
      return true;
    });
  }
});

test('malformed, oversized and missing assessment responses fail safely', async () => {
  const responses = [
    new Response('not JSON'),
    new Response('{}', {headers: {'content-length': '2000001'}}),
    new Response('x'.repeat(2000001))
  ];
  for (const response of responses) {
    const {provider} = mockProvider([response]);
    await assert.rejects(provider.extract(claim.text), /unreadable|too large/);
  }
  const {provider} = mockProvider([{content: [search(hit())]}, {content: [{type: 'text', text: 'No structured assessment.'}]}]);
  await assert.rejects(provider.research(claim), /usable assessment/);
});

test('extraction passes transcript as untrusted user data and requests structured claims', async () => {
  const input = {claims: [{text: claim.text, quote: claim.quote, type: 'fact'}]};
  const {provider, calls} = mockProvider([{content: [{type: 'tool_use', name: 'submit_claims', input}]}]);
  assert.deepEqual(await provider.extract(claim.text), input);
  assert.equal(calls[0].body.messages[0].role, 'user');
  assert.equal(calls[0].body.messages[0].content, claim.text);
  assert.equal(calls[0].body.tool_choice.name, 'submit_claims');
  assert.match(calls[0].body.system, /untrusted transcript/);
});
