/** Data preparation for charts. Missing quotes are gaps, never zero. */
export function prepareContractQuotes(contracts = []) {
  const points = contracts.map((contract, index) => ({
    index,
    label: typeof contract.label === 'string' ? contract.label : contract.symbol || `Contract ${index + 1}`,
    strike: typeof contract.strike === 'number' && Number.isFinite(contract.strike) ? contract.strike : null,
    probability: typeof contract.prob === 'number' && Number.isFinite(contract.prob) && contract.prob >= 0 && contract.prob <= 1 ? contract.prob * 100 : null,
    source: contract.source || 'unavailable',
  }));
  // A shared number does not imply shared settlement conditions. Only explicit
  // above-strike contracts at the same expiry form a comparable price ladder.
  const expiries = contracts.map(contract => Date.parse(contract.expiryDate));
  const priceLadder = points.length > 1 && points.every(point => point.strike !== null) &&
    contracts.every(contract => contract.strikeType === 'above') && expiries.every(Number.isFinite) &&
    new Set(expiries).size === 1 && new Set(points.map(point => point.strike)).size === points.length;
  if (priceLadder) points.sort((a, b) => a.strike - b.strike);
  return { points, priceLadder, quoted: points.filter(point => point.probability !== null).length };
}
