import test from 'node:test';
import assert from 'node:assert/strict';
import {relatedMarkets} from '../lib/report-markets.js';

const now = new Date('2026-10-11T19:30:00Z');
const contract = (label = 'Yes', prices = {bestBid: '0.4', bestAsk: '0.6'}, extra = {}) => ({label, prices, ...extra});
const event = (title = 'Will Tesla Optimus be released in 2026?', extra = {}) => ({title, slug: title.toLowerCase().replace(/\W+/g, '-'), status: 'active', expiryDate: '2026-12-31T21:00:00Z', contracts: [contract()], ...extra});
const run = (text, events, type = 'forecast') => relatedMarkets({text, type}, {now, client: {events: async () => ({events})}});

test('Tesla annual production finds release market but explicitly distinguishes conditions', async () => {
  const result = await run('Tesla is expected to ship 1 million Optimus robots a year by the end of 2027.', [event(), event('The Game Awards Game of the Year'), event('Will a recession happen this year?')]);
  assert.equal(result.status, 'related');
  assert.equal(result.matches.length, 1);
  assert.match(result.reason, /release market does not measure annual production volume/);
  assert.match(result.reason, /not the odds of the Reel claim/);
  assert.deepEqual(result.matches[0].contracts, [{label: 'Yes', prob: .5, source: 'bid/ask midpoint'}]);
  assert.equal(result.matches[0].url, 'https://www.gemini.com/predictions/will-tesla-optimus-be-released-in-2026-');
});

test('unknown stock tickers cannot match generic stocks or monetary amounts', async () => {
  const result = await run('You should buy VSOF stock before it reaches one billion dollars next year.', [event('Will stock markets rise next year?'), event('Will a company reach one billion dollars?')], 'recommendation');
  assert.equal(result.status, 'none');
  assert.deepEqual(result.matches, []);
});

test('an explicit MP ticker excludes background North America from market subjects', async () => {
  const text = "That's why I'm watching these two stocks. First is Ticker MP. They're the only rare earth mine of scale in North America.";
  const unrelated = [
    event('Which party will win the North Carolina Senate election?', {category:'Politics'}),
    event('Which party will win the North Carolina House election?', {category:'Politics'}),
    event('Will America enter a recession?', {category:'Economics'}),
  ];
  const missing = await run(text, unrelated, 'fact');
  assert.equal(missing.status, 'none');
  assert.deepEqual(missing.matches, []);

  const company = event('Will MP Materials open a new rare earth mine?', {category:'Companies'});
  const matched = await run(text, [...unrelated, company], 'fact');
  assert.equal(matched.status, 'related');
  assert.deepEqual(matched.matches.map(match => match.title), [company.title]);
});

test('cardinal directions alone do not match an unrelated geographic market', async () => {
  for (const [direction, place] of [['North','North Carolina'],['South','South Korea'],['East','East Timor'],['West','West Virginia']]) {
    const result = await run(`This mine in ${direction} America could increase production.`, [event(`Will ${place} hold an election?`, {category:'Politics'})]);
    assert.equal(result.status, 'not_applicable', direction);
    assert.deepEqual(result.matches, []);
  }
});

test('explicit tickers retain crypto aliases and only their related outcomes', async () => {
  const result = await run('The stock symbol BTC could rise after Trump speaks in North America.', [event('Bitcoin above $100000?'),event('Will Trump visit North Carolina?')]);
  assert.equal(result.status, 'related');
  assert.deepEqual(result.matches.map(match => match.title), ['Bitcoin above $100000?']);
});

test('stock performance since an incidental political mention does not match politician markets', async () => {
  const result = await run('Dell is up over 250 % since Trump mentioned it earlier this year.', [
    event('Will Trump replace a cabinet member this year?'),
    event('Will Trump appoint a new Treasury Secretary?'),
    event('Will a Trump cabinet member resign?'),
  ], 'fact');
  assert.equal(result.status, 'none');
  assert.deepEqual(result.matches, []);
});

test('a company surname does not become a same-name sports or weather outcome', async () => {
  const sports=event('Comeback Player of the Year Winner',{category:'Sports',contracts:[contract('Tank Dell')]});
  const weather=event('Dell temperature record',{category:'Weather'});
  const result=await run('Dell is up over 250 % since Trump mentioned it earlier this year.',[sports,weather],'fact');
  assert.equal(result.status,'none');
  assert.deepEqual(result.matches,[]);
  const player=await run('NFL player Tank Dell could win comeback player of the year.',[sports]);
  assert.equal(player.status,'related');
});

test('retains the main named company before causal and attribution context', async () => {
  const related = event('Will Intel announce a new factory?');
  const incidental = [event('Will Trump replace a cabinet member?'), event('Will the government appoint Smith?')];
  for (const text of [
    'Intel shares rose after Trump announced a government investment.',
    'Intel shares rose because Smith announced government support.',
    'Intel shares rose due to a government agreement with Smith.',
    'Intel shares rose following a speech by Trump.',
    'Intel shares rose 20%, according to Smith.',
  ]) {
    const result = await run(text, [...incidental, related], 'fact');
    assert.equal(result.status, 'related', text);
    assert.deepEqual(result.matches.map(match => match.title), [related.title], text);
  }
});

test('main company and product stay matched when later context mentions another entity', async () => {
  const result = await run('Tesla could produce one million Optimus robots a year by 2027 because Trump supports domestic manufacturing.', [event(), event('Will Trump replace a cabinet member?')]);
  assert.equal(result.status, 'related');
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].title, /Tesla Optimus/);
  assert.match(result.reason, /release market does not measure annual production volume/);
});

test('generic dates, government, and production language do not trigger requests', async () => {
  let calls = 0;
  for (const text of ['It will happen in 2027, maybe next year.', 'Buy stocks with government contracts worth one billion dollars.', 'Magnets and rare earth materials will rise in price next year.', 'The Government awarded a Million Dollar Contract.']) {
    const result = await relatedMarkets({text, type: 'forecast'}, {now, client: {events: async () => {calls++; return {events: [event()]};}}});
    assert.equal(result.status, 'not_applicable', text);
    assert.deepEqual(result.matches, []);
  }
  assert.equal(calls, 0);
});

test('specific crypto aliases survive lowercase text and match whole tokens', async () => {
  const result = await run('btc could reach $150000 by next year.', [event('Bitcoin above $100000 at year end?'), event('Will MicroBitcoin launch next year?')]);
  assert.equal(result.status, 'related');
  assert.deepEqual(result.matches.map(match => match.title), ['Bitcoin above $100000 at year end?']);
});

test('facts and recommendations get related markets without becoming verified or trade advice', async () => {
  const fact = await run('Tesla reported $40 million in revenue last year.', [event()], 'fact');
  const recommendation = await run('You should buy Tesla stock now.', [event()], 'recommendation');
  assert.equal(fact.status, 'related');
  assert.match(fact.reason, /do not verify/);
  assert.equal(recommendation.status, 'related');
  assert.match(recommendation.reason, /do not establish whether buying a stock is suitable or profitable/);
  assert.equal(fact.prob, undefined);
});

test('past, invalid, closed, and inactive event or contract data are excluded', async () => {
  const result = await run('Tesla will produce one million robots.', [
    event('Tesla old event', {expiryDate: '2025-01-01'}),
    event('Tesla invalid date', {expiryDate: 'not-a-date'}),
    event('Tesla inactive event', {status: 'resolved'}),
    event('Tesla live event', {contracts: [contract('old', {lastTradePrice: '.2'}, {expiryDate: '2025-01-01'}), contract('closed', {lastTradePrice: '.3'}, {status: 'resolved'}), contract('halted', {lastTradePrice: '.4'}, {tradingStatus: 'closed'}), contract('live', {lastTradePrice: '.7'}, {status: 'active', tradingStatus: 'open'})]}),
  ]);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].contracts, [{label: 'live', prob: .7, source: 'last trade'}]);
});

test('missing and malformed probabilities never become invented zero quotes', async () => {
  const result = await run('Tesla could make one million robots.', [event('Tesla launch?', {contracts: [
    contract('boolean', {bestBid: false, bestAsk: true}),
    contract('blank', {lastTradePrice: ' '}),
    contract('invalid', {bestBid: '-.1', bestAsk: '1.1', lastTradePrice: 'NaN'}),
    contract('crossed', {bestBid: '.9', bestAsk: '.1'}),
    contract('zero', {lastTradePrice: '0'}),
    contract('one-sided', {bestAsk: '.3'}),
  ]})]);
  assert.deepEqual(result.matches[0].contracts, [{label: 'zero', prob: 0, source: 'last trade'}, {label: 'one-sided', prob: .3, source: 'ask only'}]);
});

test('events without quotes retain their real link and an empty contract list', async () => {
  const result = await run('Tesla could make one million robots.', [event('Tesla launch?', {contracts: [contract('Yes', {})]})]);
  assert.equal(result.status, 'related');
  assert.deepEqual(result.matches[0].contracts, []);
});

test('limits results to three events and four total quotes without mutating source data', async () => {
  const events = Array.from({length: 6}, (_, index) => event(`Tesla event ${index}`, {contracts: Array.from({length: 8}, (_, i) => contract(`Outcome ${i}`))}));
  const result = await run('Tesla could make one million robots.', events);
  assert.equal(result.matches.length, 3);
  assert.equal(result.matches.reduce((count, match) => count + match.contracts.length, 0), 4);
  assert.ok(result.matches.every(match => match.contracts.length >= 1));
  assert.equal(events[0].contracts.length, 8);
});

test('generic multi-outcome events include only the outcome that names the specific subject', async () => {
  const result = await run('Tesla could make one million robots.', [event('Which company will launch a robot first?', {contracts: [contract('Tesla', {lastTradePrice: '.7'}), contract('Acme', {lastTradePrice: '.3'})]})]);
  assert.equal(result.status, 'related');
  assert.deepEqual(result.matches[0].contracts.map(item => item.label), ['Tesla']);
});

test('deduplicates event links and skips malformed event fields', async () => {
  const result = await run('Tesla could make one million robots.', [event(), event(), event('Tesla missing link', {slug: null}), event('Tesla bad contracts', {contracts: null}), null]);
  assert.equal(result.matches.length, 1);
});

test('data errors return unavailable without provider error or synthetic data', async () => {
  const result = await relatedMarkets({text: 'Tesla could make one million robots.', type: 'forecast'}, {now, client: {events: async () => {throw new Error('secret provider response');}}});
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.matches, []);
  assert.ok(!JSON.stringify(result).includes('secret provider'));
  const malformed = await relatedMarkets({text: 'Tesla could make one million robots.', type: 'forecast'}, {now, client: {events: async () => ({events: null})}});
  assert.equal(malformed.status, 'unavailable');
});
