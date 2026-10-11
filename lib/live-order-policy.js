const BUDGET_CENTS = 500n;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const FEE_NOTE = 'Estimated taker fee, rounded up to a cent. Actual charges may differ if fills are rounded separately or Gemini changes its fees.';
const QUANTITY_SCALE = 10n ** 18n;

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), {status, code: `LIVE_ORDER_${code}`});
}

function cents(value, label) {
  // Decimal strings only: no floating-point rounding, coercion, signs, exponents,
  // separators, or fractional cents. The API adapter must floor raw balances to
  // cents before invoking this policy; pending funds must not be included.
  if (typeof value !== 'string' || value.length > 19 || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    fail('INVALID_MONEY', `${label} must be a nonnegative USD amount with at most two decimal places.`);
  }
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > MAX_SAFE_CENTS) fail('INVALID_MONEY', `${label} is too large.`);
  return result;
}

const usd = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const ceilDivide = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

function fillAllowance(quantityIncrement) {
  if (typeof quantityIncrement !== 'string' || quantityIncrement.length > 48
    || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(quantityIncrement)) {
    fail('INVALID_QUANTITY_INCREMENT', 'A verified positive contract quantity increment is required to reserve fees.');
  }
  const [whole, fraction = ''] = quantityIncrement.split('.');
  const step = BigInt(whole + fraction.padEnd(18, '0'));
  if (step <= 0n || (step > QUANTITY_SCALE && step % QUANTITY_SCALE !== 0n)) {
    fail('INVALID_QUANTITY_INCREMENT', 'The contract quantity increment is not supported by this fee allowance.');
  }
  // Legacy taker fees peak at 2.5 cents per contract; current fees peak lower.
  // Splitting a fill into minimum increments can only increase a sum of fees
  // individually rounded up to a cent. Round the number of increments per
  // whole requested contract up too, so non-divisor grids remain conservative.
  const perContractCents = step <= QUANTITY_SCALE
    ? ceilDivide(QUANTITY_SCALE, step) * ceilDivide(5n * step, 2n * QUANTITY_SCALE)
    : 3n;
  return {perContractCents, note: `Reserves ${perContractCents} cents per whole contract for fees, allowing for fills in increments of ${quantityIncrement} contracts and each fill rounded up under Gemini’s published current and legacy schedules. Actual fees may be much lower. Unfilled or unused reservations remain counted toward this demo’s $5 limit.`};
}

/**
 * Pure review policy for the $5 live-money demonstration. No orders are placed.
 *
 * Published schedules, checked October 11, 2026:
 * https://www.gemini.com/fees/predictions
 * https://www.gemini.com/fees/predictions-2026-03-18
 * Current: 0.07 * quantity * P * (1-P), for listings from March 18, 2026.
 * Legacy: 0.05 * quantity * min(P, 1-P), for earlier listings.
 * Both are converted to cents with exact integer arithmetic and rounded upward.
 * These are estimates, not guaranteed fee ceilings: the published schedule does
 * not establish how rounding is aggregated across multiple execution fills.
 * The live demo uses conservative mode with a verified quantity increment.
 * Current taker fees peak at 1.75 cents per contract; legacy fees at 2.5 cents.
 * Fractional fills each rounded to a cent can cost more than one whole fill.
 * The allowance covers that split-fill case, including better execution prices.
 * The default increment keeps standalone policy callers compatible; live order
 * callers must always supply the authoritative market increment explicitly.
 */
export function reviewLiveOrder({quantity, price, availableUsd, remainingBudgetUsd = '5.00', feeSchedule, quantityIncrement = '1'} = {}) {
  if (typeof quantity !== 'string' || !/^[1-9]\d{0,2}$/.test(quantity) || BigInt(quantity) > 100n) {
    fail('INVALID_QUANTITY', 'Choose 1 to 100 whole contracts.');
  }
  if (typeof price !== 'string' || !/^0?\.\d{1,2}$/.test(price)) {
    fail('INVALID_PRICE', 'Enter a limit price from $0.01 to $0.99 in whole cents.');
  }
  const priceCents = cents(price.startsWith('.') ? `0${price}` : price, 'Limit price');
  if (priceCents < 1n || priceCents > 99n) {
    fail('INVALID_PRICE', 'Enter a limit price from $0.01 to $0.99 in whole cents.');
  }
  if (!['current', 'legacy', 'conservative'].includes(feeSchedule)) {
    fail('UNKNOWN_FEE_SCHEDULE', 'The fee schedule for this contract must be confirmed before reviewing a live order.');
  }
  const availableCents = cents(availableUsd, 'Available balance');
  const remainingBudgetCents = cents(remainingBudgetUsd, 'Remaining demo budget');
  if (remainingBudgetCents > BUDGET_CENTS) {
    fail('INVALID_BUDGET', 'The remaining demo budget cannot exceed $5.00.');
  }
  const quantityContracts = BigInt(quantity), principalCents = quantityContracts * priceCents;
  const allowance = feeSchedule === 'conservative' ? fillAllowance(quantityIncrement) : null;
  const estimatedFeeCents = allowance ? allowance.perContractCents * quantityContracts : feeSchedule === 'current'
    ? ceilDivide(7n * quantityContracts * priceCents * (100n - priceCents), 10000n)
    : ceilDivide(5n * quantityContracts * (priceCents < 50n ? priceCents : 100n - priceCents), 100n);
  const estimatedTotalCents = principalCents + estimatedFeeCents;
  if (estimatedTotalCents > BUDGET_CENTS) {
    fail('BUDGET_EXCEEDED', 'The order plus its estimated fee exceeds the $5.00 demo budget.');
  }
  if (estimatedTotalCents > remainingBudgetCents) {
    fail('REMAINING_BUDGET_EXCEEDED', 'The order plus its estimated fee exceeds the remaining demo budget.', 409);
  }
  if (estimatedTotalCents > availableCents) {
    fail('INSUFFICIENT_FUNDS', 'The available USD balance does not cover the order and its estimated fee.', 402);
  }
  return {
    quantity: String(quantityContracts), price: usd(priceCents),
    principal: usd(principalCents), estimatedFee: usd(estimatedFeeCents), estimatedTotal: usd(estimatedTotalCents),
    budget: usd(BUDGET_CENTS), availableUsd: usd(availableCents), remainingBudgetUsd: usd(remainingBudgetCents),
    feeSchedule, feeNote: allowance ? allowance.note : FEE_NOTE,
    quantityContracts: Number(quantityContracts), priceCents: Number(priceCents), principalCents: Number(principalCents),
    estimatedFeeCents: Number(estimatedFeeCents), estimatedTotalCents: Number(estimatedTotalCents),
    budgetCents: Number(BUDGET_CENTS), availableCents: Number(availableCents), remainingBudgetCents: Number(remainingBudgetCents)
  };
}
