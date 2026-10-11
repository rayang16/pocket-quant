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

test('live allowance covers separate whole-contract fills under both published fee schedules',()=>{
  for(let priceCents=1;priceCents<100;priceCents++) {
    const price=(priceCents/100).toFixed(2);
    const result=review({price,feeSchedule:'conservative'});
    assert.equal(result.estimatedFeeCents,3);
    // One-contract fills are the worst case for per-fill cent rounding.
    assert.ok(Math.ceil(7*(priceCents/100)*(1-priceCents/100))<=3);
    assert.ok(Math.ceil(5*Math.min(priceCents/100,1-priceCents/100))<=3);
  }
  const split=review({quantity:'4',price:'0.99',feeSchedule:'conservative'});
  assert.equal(split.estimatedFee,'0.12');assert.equal(split.estimatedTotal,'4.08');
  assert.match(split.feeNote,/3 cents per whole contract/);
  // Also reserves enough when a high-limit buy fills nearer the peak-fee price.
  assert.ok(split.estimatedFeeCents>=4*3);
});

test('conservative live allowance is included in both remaining budget and available balance',()=>{
  assert.equal(review({quantity:'10',price:'0.47',feeSchedule:'conservative'}).estimatedTotal,'5.00');
  rejects({quantity:'10',price:'0.48',feeSchedule:'conservative'},'BUDGET_EXCEEDED');
  rejects({price:'0.50',availableUsd:'0.52',feeSchedule:'conservative'},'INSUFFICIENT_FUNDS');
  rejects({price:'0.50',remainingBudgetUsd:'0.52',feeSchedule:'conservative'},'REMAINING_BUDGET_EXCEEDED');
});

test('conservative fees cover cent rounding for each permitted fractional fill',()=>{
  for (const [quantityIncrement,fee,total] of [
    ['0.01','1.00','1.50'],
    ['0.1','0.10','0.60'],
    ['0.5','0.04','0.54'],
    ['1','0.03','0.53'],
  ]) {
    const result=review({quantityIncrement,feeSchedule:'conservative'});
    assert.equal(result.estimatedFee,fee,quantityIncrement);
    assert.equal(result.estimatedTotal,total,quantityIncrement);
  }
  const multiple=review({quantity:'2',quantityIncrement:'0.01',feeSchedule:'conservative'});
  assert.equal(multiple.estimatedFee,'2.00');
  assert.equal(multiple.estimatedTotal,'3.00');
  const wholeStep=review({quantity:'2',quantityIncrement:'2',feeSchedule:'conservative'});
  assert.equal(wholeStep.estimatedFee,'0.06');
  assert.equal(wholeStep.estimatedTotal,'1.06');
  assert.deepEqual(review({quantityIncrement:'1',feeSchedule:'conservative'}),review({feeSchedule:'conservative'}));
});

test('fractional allowance rounds both the possible fill count and each fill fee upward exactly',()=>{
  // Three whole contracts on a 0.3 grid need the conservative four fills per
  // whole-contract allowance, even though 1 / 0.3 is not an integer.
  assert.equal(review({quantity:'3',price:'0.01',quantityIncrement:'0.3',feeSchedule:'conservative'}).estimatedFee,'0.12');
  // At 0.4 contracts the peak legacy fee is exactly one cent; the smallest
  // accepted decimal increase must make that per-fill reservation two cents.
  assert.equal(review({quantityIncrement:'0.400000000000000000',feeSchedule:'conservative'}).estimatedFee,'0.03');
  assert.equal(review({quantityIncrement:'0.400000000000000001',feeSchedule:'conservative'}).estimatedFee,'0.06');
  assert.equal(review({quantityIncrement:'0.500000000000000000',feeSchedule:'conservative'}).estimatedFee,'0.04');
  assert.equal(review({quantity:'2',quantityIncrement:'2.000000000000000000',feeSchedule:'conservative'}).estimatedFee,'0.06');
});

test('fractional fees enforce the exact $5 total and one-cent remaining budget and balance boundaries',()=>{
  const fractional={quantityIncrement:'0.01',feeSchedule:'conservative'};
  const exact=review({...fractional,availableUsd:'1.50',remainingBudgetUsd:'1.50'});
  assert.equal(exact.principal,'0.50');
  assert.equal(exact.estimatedFee,'1.00');
  assert.equal(exact.estimatedTotal,'1.50');
  rejects({...fractional,availableUsd:'1.49'},'INSUFFICIENT_FUNDS');
  rejects({...fractional,remainingBudgetUsd:'1.49'},'REMAINING_BUDGET_EXCEEDED');
  assert.equal(review({...fractional,quantity:'4',price:'0.25'}).estimatedTotal,'5.00');
  // Five contracts on a 0.02 grid reserve $2.50 in fees; the same principal
  // would fit easily if the old three-cent whole-contract allowance were used.
  assert.equal(review({quantity:'5',price:'0.50',quantityIncrement:'0.02',feeSchedule:'conservative'}).estimatedTotal,'5.00');
  rejects({...fractional,quantity:'4',price:'0.26'},'BUDGET_EXCEEDED');
  rejects({quantity:'5',price:'0.51',quantityIncrement:'0.02',feeSchedule:'conservative'},'BUDGET_EXCEEDED');
});

test('tiny but valid increments fail the budget check without numeric overflow',()=>{
  for (const quantityIncrement of ['0.0005','0.000000000000000001']) {
    rejects({quantityIncrement,feeSchedule:'conservative'},'BUDGET_EXCEEDED');
  }
});

test('conservative fee increments reject malformed, nonpositive, and unsupported fractional steps',()=>{
  for (const quantityIncrement of [
    '0','0.0','0.000000000000000000','-0.01','+0.01','1e-2',
    ' 0.01','0.01 ','00.01','01','.01','1.','0.0000000000000000001',
    '1.1','1.000000000000000001','2.5','NaN','Infinity','',
    0.01,1,NaN,Infinity,null,true,{},[],
  ]) rejects({quantityIncrement,feeSchedule:'conservative'},'INVALID_QUANTITY_INCREMENT');
});

test('fractional allowance bounds every split-fill partition under both published schedules',()=>{
  for (const stepHundredths of [1,10,20,25,50,100]) {
    const quantityIncrement=(stepHundredths/100).toFixed(2);
    const allowance=review({price:'0.99',quantityIncrement,feeSchedule:'conservative'}).estimatedFeeCents;
    const units=100/stepHundredths;
    for (const feeSchedule of ['current','legacy']) {
      for (let priceCents=1;priceCents<100;priceCents++) {
        // Integer numerators keep exact-cent rounding independent of binary
        // floating-point price arithmetic. Enumerate all partitions by finding
        // the maximum cumulative fee for each count of quantity-grid units.
        const maximumFees=Array(units+1).fill(0);
        for (let totalUnits=1;totalUnits<=units;totalUnits++) {
          for (let fillUnits=1;fillUnits<=totalUnits;fillUnits++) {
            const fillHundredths=fillUnits*stepHundredths;
            const fee=feeSchedule==='current'
              ? Math.ceil(7*fillHundredths*priceCents*(100-priceCents)/1000000)
              : Math.ceil(5*fillHundredths*Math.min(priceCents,100-priceCents)/10000);
            maximumFees[totalUnits]=Math.max(maximumFees[totalUnits],maximumFees[totalUnits-fillUnits]+fee);
          }
        }
        assert.ok(maximumFees[units]<=allowance,`${feeSchedule}: increment ${quantityIncrement}, price ${priceCents} cents`);
      }
    }
  }
});
