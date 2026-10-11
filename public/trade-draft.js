const SYMBOL = /^GEMI-[A-Za-z0-9_-]{1,195}$/;
const BUDGET_CENTS = 500n;
const MAX_QUOTE_AGE_MS = 120_000;
const MAX_CLOCK_SKEW_MS = 5_000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit, allowEmpty = false) => typeof value === 'string'
  && value.length <= limit && (allowEmpty || value.trim().length > 0);
const symbolValue = value => typeof value === 'string' && SYMBOL.test(value);
const usd = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

function spendValue(value) {
  // Bound the text before conversion; never coerce numbers, exponents or huge integers.
  if (typeof value !== 'string' || !/^[0-5](?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n && cents <= BUDGET_CENTS ? usd(cents) : null;
}

function outcomeValue(value) {
  if (typeof value !== 'string') return null;
  const outcome = value.toLowerCase();
  return outcome === 'yes' || outcome === 'no' ? outcome : null;
}

function normalizeIntent({symbol, outcome = 'yes', spendLimit = '1.00'} = {}) {
  if (!symbolValue(symbol)) return null;
  const normalizedOutcome = outcomeValue(outcome);
  const normalizedSpend = spendValue(spendLimit);
  return normalizedOutcome && normalizedSpend
    ? {symbol, outcome: normalizedOutcome, spendLimit: normalizedSpend}
    : null;
}

/** A handoff carries only a contract, outcome and spending ceiling, never an executable order. */
export function tradeDraftUrl(input = {}) {
  if (!object(input)) return null;
  const intent = normalizeIntent(input);
  return intent ? `/live.html?${new URLSearchParams(intent)}` : null;
}

export function readTradeIntent(search) {
  if (typeof search !== 'string' || search.length > 8192) return null;
  const params = new URLSearchParams(search);
  for (const name of ['symbol', 'outcome', 'spendLimit']) {
    if (params.getAll(name).length > 1) return null;
  }
  // Unknown parameters, including prices, quantities and model odds, have no authority.
  return normalizeIntent({
    symbol: params.get('symbol'),
    outcome: params.has('outcome') ? params.get('outcome') : undefined,
    spendLimit: params.has('spendLimit') ? params.get('spendLimit') : undefined
  });
}

function canonicalCents(value) {
  if (typeof value !== 'string' || !/^[0-5]\.\d{2}$/.test(value)) return null;
  const cents = BigInt(value[0]) * 100n + BigInt(value.slice(2));
  return cents <= BUDGET_CENTS ? cents : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Verify a fresh server draft before copying it into editable fields. This does not authorize submission. */
export function validTradeDraft(data, intent, now = Date.now()) {
  if (!object(data) || !object(data.draft) || !object(data.budget) || !object(intent)
    || !Number.isSafeInteger(now)) return false;
  const normalized = normalizeIntent(intent);
  if (!normalized) return false;
  const {draft, budget} = data;
  if (draft.symbol !== normalized.symbol || draft.outcome !== normalized.outcome
    || draft.spendLimit !== normalized.spendLimit
    || !text(draft.title, 300) || !text(draft.eventTitle, 300)
    || !text(draft.description, 3000, true) || !text(draft.feeNote, 3000)
    || typeof draft.quantity !== 'string' || !/^[1-9]\d{0,2}$/.test(draft.quantity)
    || BigInt(draft.quantity) > 100n || budget.unresolved !== false) return false;

  const checkedAt = timestamp(data.checkedAt);
  const expiresAt = timestamp(draft.expiresAt);
  if (checkedAt === null || expiresAt === null || expiresAt <= now
    || checkedAt > now + MAX_CLOCK_SKEW_MS || checkedAt < now - MAX_QUOTE_AGE_MS) return false;

  const price = canonicalCents(draft.price);
  const principal = canonicalCents(draft.principal);
  const fee = canonicalCents(draft.estimatedFee);
  const total = canonicalCents(draft.estimatedTotal);
  const spend = canonicalCents(draft.spendLimit);
  const remaining = canonicalCents(budget.remainingUsd);
  const reserved = canonicalCents(budget.reservedUsd);
  if ([price, principal, fee, total, spend, remaining, reserved].includes(null)) return false;
  return price >= 1n && price <= 99n && spend > 0n
    && principal === BigInt(draft.quantity) * price && total === principal + fee
    && total <= spend && total <= remaining && total <= BUDGET_CENTS
    && remaining + reserved === BUDGET_CENTS;
}
