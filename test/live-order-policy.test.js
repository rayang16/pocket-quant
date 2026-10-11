import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewLiveOrder} from '../lib/live-order-policy.js';

const review = changes => reviewLiveOrder({quantity:'1', price:'0.50', availableUsd:'5.00', feeSchedule:'current', ...changes});
const rejects = (changes, code) => assert.throws(() => review(changes), error => error.code === `LIVE_ORDER_${code}`);

test('current and legacy fees use their published formulas and round fractional cents upward', () => {
  const current = review(), legacy = review({feeSchedule:'legacy'});
  assert.deepEqual([current.principal,current.estimatedFee,current.estimatedTotal], ['0.50','0.02','0.52']);
  assert.deepEqual([legacy.principal,legacy.estimatedFee,legacy.estimatedTotal], ['0.50','0.03','0.53']);
  assert.deepEqual([current.priceCents,current.principalCents,current.estimatedFeeCents,current.estimatedTotalCents], [50,50,2,52]);
  assert.match(current.feeNote, /Estimated/);
  assert.match(current.feeNote, /rounded separately/);
});

test('exact cent fees are not rounded up a second time and complementary prices have equal fees', () => {
  assert.equal(review({quantity:'4',price:'0.50'}).estimatedFee,'0.07');
  assert.equal(review({quantity:'2',price:'0.20',feeSchedule:'legacy'}).estimatedFee,'0.02');
  for (const feeSchedule of ['current','legacy']) {
    const low = review({quantity:'2',price:'0.20',feeSchedule});
    const high = review({quantity:'2',price:'0.80',feeSchedule});
    assert.equal(low.estimatedFee, high.estimatedFee);
    assert.equal(high.principal,'1.60');
  }
});

test('fee-inclusive total, rather than principal alone, enforces the $5 budget', () => {
  const below = review({quantity:'10',price:'0.48'});
  assert.equal(below.estimatedTotal,'4.98');
  assert.equal(review({quantity:'19',price:'0.25'}).estimatedTotal,'5.00');
  rejects({quantity:'10',price:'0.49'}, 'BUDGET_EXCEEDED');
  rejects({quantity:'10',price:'0.50'}, 'BUDGET_EXCEEDED');
  rejects({quantity:'100',price:'0.99',availableUsd:'100.00'}, 'BUDGET_EXCEEDED');
});

test('balance and remaining budget accept an exact estimated total but reject one cent less', () => {
  assert.equal(review({availableUsd:'0.52',remainingBudgetUsd:'0.52'}).estimatedTotal,'0.52');
  rejects({availableUsd:'0.51'}, 'INSUFFICIENT_FUNDS');
  rejects({availableUsd:'0.00'}, 'INSUFFICIENT_FUNDS');
  rejects({remainingBudgetUsd:'0.51'}, 'REMAINING_BUDGET_EXCEEDED');
  rejects({remainingBudgetUsd:'0.00'}, 'REMAINING_BUDGET_EXCEEDED');
  rejects({remainingBudgetUsd:'5.01'}, 'INVALID_BUDGET');
});

test('normalizes plain decimals and exposes only JSON-safe integer cents', () => {
  const result = review({quantity:'2',price:'.1',availableUsd:'5',remainingBudgetUsd:'5.0'});
  assert.equal(result.quantity,'2');assert.equal(result.price,'0.10');
  assert.equal(result.availableUsd,'5.00');assert.equal(result.remainingBudgetUsd,'5.00');assert.equal(result.budget,'5.00');
  for (const key of ['quantityContracts','priceCents','principalCents','estimatedFeeCents','estimatedTotalCents','budgetCents','availableCents','remainingBudgetCents'])assert.equal(Number.isSafeInteger(result[key]),true,key);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('quantity boundaries are accepted without permissive numeric coercion', () => {
  assert.equal(review({quantity:'1',price:'0.01'}).quantityContracts,1);
  assert.equal(review({quantity:'100',price:'0.01'}).quantityContracts,100);
  for (const quantity of ['0','101','001','1.0','1.5','1e1','+1','-1',' 1','1 ','',1,null,undefined])rejects({quantity}, 'INVALID_QUANTITY');
});

test('prices reject zero, one dollar, fractional cents, scientific notation, and coercible values', () => {
  assert.equal(review({price:'0.01'}).priceCents,1);
  assert.equal(review({price:'0.99'}).priceCents,99);
  for (const price of ['0.00','.00','1.00','1','0.001','0.500','1e-2','+0.50','-0.50',' 0.50','0.50 ','00.50','50','',.5,null,undefined])rejects({price}, 'INVALID_PRICE');
});

test('available balances and remaining budgets reject malformed or unsafe monetary strings', () => {
  for (const value of ['-1.00','+1.00',' 5.00','5.00 ','5.000','1e3','1,000.00','01.00','.50','NaN','Infinity','',5,NaN,Infinity,null]) {
    rejects({availableUsd:value}, 'INVALID_MONEY');
    rejects({remainingBudgetUsd:value}, 'INVALID_MONEY');
  }
  rejects({availableUsd:undefined}, 'INVALID_MONEY');
  rejects({availableUsd:'90071992547409.92'}, 'INVALID_MONEY');
  assert.equal(review({availableUsd:'90071992547409.91'}).availableCents,Number.MAX_SAFE_INTEGER);
});

test('a fee schedule is mandatory and never inferred or coerced', () => {
  for (const feeSchedule of [undefined,null,'','CURRENT','current ','new','unknown',0,{}])rejects({feeSchedule}, 'UNKNOWN_FEE_SCHEDULE');
});

test('review is deterministic and does not mutate its inputs', () => {
  const input = Object.freeze({quantity:'3',price:'0.32',availableUsd:'5.00',remainingBudgetUsd:'4.00',feeSchedule:'current'});
  assert.deepEqual(reviewLiveOrder(input),reviewLiveOrder(input));
  assert.equal(input.price,'0.32');
});
