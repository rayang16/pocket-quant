import test from 'node:test';
import assert from 'node:assert/strict';
import {readTradeIntent, tradeDraftUrl, validTradeDraft} from '../public/trade-draft.js';

const symbol = 'GEMI-BTC-20261031-90000';
const now = Date.parse('2026-10-11T12:00:00.000Z');
const intent = {symbol, outcome: 'no', spendLimit: '1.00'};
const response = () => ({
  draft: {symbol, title: 'Bitcoin above $90,000?', eventTitle: 'Bitcoin in October', description: '',
    expiresAt: '2026-10-31T20:00:00.000Z', outcome: 'no', quantity: '2', price: '0.40',
    principal: '0.80', estimatedFee: '0.06', estimatedTotal: '0.86', spendLimit: '1.00', feeNote: 'Conservative fee allowance.'},
  budget: {remainingUsd: '4.00', reservedUsd: '1.00', unresolved: false}, checkedAt: new Date(now).toISOString()
});

test('handoff keeps the selected NO outcome and normalizes its spending ceiling', () => {
  assert.equal(tradeDraftUrl({symbol, outcome: 'NO', spendLimit: '1'}), `/live.html?symbol=${symbol}&outcome=no&spendLimit=1.00`);
  assert.deepEqual(readTradeIntent(tradeDraftUrl({symbol, outcome: 'NO', spendLimit: '1.0'}).split('?')[1]), intent);
  assert.deepEqual(readTradeIntent(`?symbol=${symbol}&outcome=NO&spendLimit=0.50`), {...intent, spendLimit: '0.50'});
  assert.deepEqual(readTradeIntent(`?symbol=${symbol}`), {...intent, outcome: 'yes'});
});

test('builder only emits the three supported handoff fields', () => {
  const url = tradeDraftUrl({...intent, price: '0.01', quantity: '100', modelOdds: '99', returnTo: 'https://example.com'});
  assert.equal(url, `/live.html?symbol=${symbol}&outcome=no&spendLimit=1.00`);
  assert.deepEqual(readTradeIntent(`?symbol=${symbol}&outcome=no&price=0.01&quantity=100&modelOdds=99&price=0.99`), intent);
});

test('missing values default while explicitly invalid or duplicate values never default', () => {
  assert.equal(tradeDraftUrl({symbol}), `/live.html?symbol=${symbol}&outcome=yes&spendLimit=1.00`);
  for (const key of ['symbol', 'outcome', 'spendLimit']) {
    const base = new URLSearchParams(intent);
    base.append(key, intent[key]);
    assert.equal(readTradeIntent(`?${base}`), null, `duplicate ${key}`);
    base.delete(key);
    base.set(key, '');
    assert.equal(readTradeIntent(`?${base}`), null, `empty ${key}`);
  }
  assert.equal(readTradeIntent(`?symbol=${symbol}&%73ymbol=${symbol}`), null);
  assert.equal(readTradeIntent(''), null);
  for (const input of [null, undefined, 42, {}, [], '?'.repeat(8193)]) assert.equal(readTradeIntent(input), null);
});

test('spending inputs reject malformed amounts, numeric coercion and values above the demo cap', () => {
  assert.ok(tradeDraftUrl({...intent, spendLimit: '5.00'}));
  assert.ok(tradeDraftUrl({...intent, spendLimit: '0.01'}));
  for (const spendLimit of ['0', '0.00', '5.01', '6', '100000000000000000000', '01.00', '.50', '1.000', '1e0', 'NaN', 'Infinity', ' 1', '1 ', '+1', '-1', '', 1, NaN, Infinity, null]) {
    assert.equal(tradeDraftUrl({...intent, spendLimit}), null, String(spendLimit));
    if (typeof spendLimit === 'string') assert.equal(readTradeIntent(`?symbol=${symbol}&spendLimit=${encodeURIComponent(spendLimit)}`), null);
  }
});

test('symbols and outcomes are constrained rather than treated as navigation targets', () => {
  for (const value of ['', 'BTCUSD', 'GEMI-', `GEMI-${'x'.repeat(196)}`, 'GEMI-../live.html', 'GEMI-x&outcome=yes', 'https://example.com', null, 5]) {
    assert.equal(tradeDraftUrl({...intent, symbol: value}), null);
  }
  assert.ok(tradeDraftUrl({...intent, symbol: `GEMI-${'x'.repeat(195)}`}));
  for (const outcome of ['buy', 'YES ', '', null, 0]) assert.equal(tradeDraftUrl({...intent, outcome}), null);
  for (const input of [null, [], 5, '']) assert.equal(tradeDraftUrl(input), null);
});

test('valid draft uses exact cents and agrees with the selected contract, outcome and spend limit', () => {
  assert.equal(validTradeDraft(response(), intent, now), true);
  for (const patch of [{symbol: 'GEMI-OTHER'}, {outcome: 'yes'}, {outcome: 'NO'}, {spendLimit: '2.00'}, {principal: '0.79'}, {estimatedTotal: '0.85'}]) {
    const data = response(); Object.assign(data.draft, patch);
    assert.equal(validTradeDraft(data, intent, now), false, JSON.stringify(patch));
  }
  const data = response();
  Object.assign(data.draft, {quantity: '3', price: '0.29', principal: '0.87', estimatedFee: '0.09', estimatedTotal: '0.96'});
  assert.equal(validTradeDraft(data, intent, now), true);
});

test('all response money requires bounded canonical decimal strings', () => {
  for (const key of ['price', 'principal', 'estimatedFee', 'estimatedTotal', 'spendLimit']) {
    for (const value of [null, undefined, NaN, Infinity, 0.4, 'NaN', 'Infinity', '0.4', '00.40', '0.400', '.40', '-0.40', '5.01', '9'.repeat(10000)]) {
      const data = response(); data.draft[key] = value;
      assert.equal(validTradeDraft(data, intent, now), false, key);
    }
  }
  for (const key of ['remainingUsd', 'reservedUsd']) {
    for (const value of [null, undefined, NaN, Infinity, 4, 'NaN', '4.0', '04.00', '-1.00', '5.01', '9'.repeat(10000)]) {
      const data = response(); data.budget[key] = value;
      assert.equal(validTradeDraft(data, intent, now), false, key);
    }
  }
});

test('quantity and price cannot be zero, out of range or coerced from another type', () => {
  for (const quantity of ['0', '101', '001', '1.0', '1e1', '9'.repeat(10000), 2, NaN, null]) {
    const data = response(); data.draft.quantity = quantity;
    assert.equal(validTradeDraft(data, intent, now), false);
  }
  for (const price of ['0.00', '1.00']) {
    const data = response(); data.draft.price = price;
    data.draft.principal = price === '0.00' ? '0.00' : '2.00';
    data.draft.estimatedTotal = price === '0.00' ? '0.06' : '2.06';
    assert.equal(validTradeDraft(data, intent, now), false);
  }
});

test('fees are included in spend and remaining-budget bounds, and budget conservation is required', () => {
  const data = response();
  Object.assign(data.draft, {quantity: '2', price: '0.49', principal: '0.98', estimatedFee: '0.06', estimatedTotal: '1.04'});
  assert.equal(validTradeDraft(data, intent, now), false);
  for (const patch of [{remainingUsd: '0.85', reservedUsd: '4.15'}, {remainingUsd: '4.00', reservedUsd: '0.00'}, {unresolved: true}, {unresolved: 'false'}]) {
    const data = response(); Object.assign(data.budget, patch);
    assert.equal(validTradeDraft(data, intent, now), false);
  }
  const exact = response();
  Object.assign(exact.draft, {quantity: '10', price: '0.47', principal: '4.70', estimatedFee: '0.30', estimatedTotal: '5.00', spendLimit: '5.00'});
  exact.budget = {remainingUsd: '5.00', reservedUsd: '0.00', unresolved: false};
  assert.equal(validTradeDraft(exact, {...intent, spendLimit: '5.00'}, now), true);
});

test('stale, excessively future-dated and expired drafts cannot populate an order', () => {
  for (const elapsed of [-120001, 5001]) {
    const data = response(); data.checkedAt = new Date(now + elapsed).toISOString();
    assert.equal(validTradeDraft(data, intent, now), false);
  }
  for (const elapsed of [-120000, 5000]) {
    const data = response(); data.checkedAt = new Date(now + elapsed).toISOString();
    assert.equal(validTradeDraft(data, intent, now), true);
  }
  for (const checkedAt of [null, now, '', 'not-a-date', 'Infinity']) {
    const data = response(); data.checkedAt = checkedAt;
    assert.equal(validTradeDraft(data, intent, now), false);
  }
  for (const expiresAt of [null, '', 'invalid', new Date(now).toISOString(), new Date(now - 1).toISOString()]) {
    const data = response(); data.draft.expiresAt = expiresAt;
    assert.equal(validTradeDraft(data, intent, now), false);
  }
});

test('malformed envelopes, metadata, intents and clocks return false without throwing', () => {
  for (const data of [undefined, null, [], {}, {draft: {}, budget: {}}, {draft: response().draft}, {...response(), budget: []}]) {
    assert.equal(validTradeDraft(data, intent, now), false);
  }
  for (const key of ['title', 'eventTitle', 'description', 'feeNote']) {
    const data = response(); data.draft[key] = null;
    assert.equal(validTradeDraft(data, intent, now), false, key);
  }
  for (const input of [null, undefined, {}, [], {...intent, outcome: ''}, {...intent, spendLimit: 'NaN'}]) {
    assert.equal(validTradeDraft(response(), input, now), false);
  }
  for (const clock of [NaN, Infinity, 'today', null]) assert.equal(validTradeDraft(response(), intent, clock), false);
});
