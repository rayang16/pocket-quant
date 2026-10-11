const validRange = value => value && Number.isFinite(value.lo) && Number.isFinite(value.hi)
  && value.lo >= 0 && value.hi <= 1 && value.lo <= value.hi;
const percent = value => value>0&&value<.001?'<0.1%':value<1&&value>.999?'>99.9%':`${(value * 100).toFixed(1)}%`;
const rangeText = value => `${percent(value.lo)}–${percent(value.hi)}`;
const excerpt = value => value.length > 210 ? `${value.slice(0,207)}…` : value;
const deadlineText = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-US',{
  timeZone:'America/Los_Angeles',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'
}).format(new Date(value)) : 'unavailable';

// Conclusions are derived from known evidence states, never from an AI verdict.
export function concludeClaim(claim, market, model) {
  const matches = Array.isArray(market?.matches) ? market.matches : [];
  const assessment = (status, headline, summary) => ({status, headline, summary, limitations: []});
  if (claim.type === 'fact') {
    const returns = /\b(?:up|rose|risen|gained|fell|down|returned|returns?)\b/i.test(claim.text) && /%|percent/i.test(claim.text);
    return assessment('not_market_verifiable', 'This claim is not verified by Gemini.', returns
      ? 'The Reel reports a past return. Checking that number requires historical prices and the exact start and end dates. A future prediction market does not verify it.'
      : 'The Reel presents this as a fact. Gemini prediction markets do not establish whether the reported event happened. This needs evidence about the event itself; this report has not checked that evidence.');
  }
  if (claim.type === 'recommendation') return assessment('opinion', 'This is advice, not a proven opportunity.',
    'The Reel recommends a trade. Gemini market prices cannot establish that following this advice will be profitable or suitable. Any related contracts below provide context only.');

  if (validRange(model?.model?.touch) && validRange(model?.model?.atExpiry)) {
    const missingMarket = market?.status === 'unavailable' ? ' Gemini market discovery is currently unavailable.'
      : !matches.length ? ' No related Gemini market was found by the topic search.' : '';
    return assessment('forecast', 'The model estimates a range, not a guarantee.',
      `For ${model.claim?.asset} ${model.claim?.direction==='below'?'below':'above'} $${model.claim?.target} by ${deadlineText(model.claim?.deadlineISO)}, the volatility model estimates ${rangeText(model.model.touch)} for touching the target by the deadline and ${rangeText(model.model.atExpiry)} for finishing beyond it at expiry. These are assumption-based estimates, not observed odds for the whole Reel.${missingMarket}`);
  }
  if (market?.status === 'unavailable') return assessment('unavailable', 'We could not check this prediction yet.',
    'Gemini market data could not be loaded. There is no market-based answer to this claim right now; try again.');
  if (!matches.length) return assessment('forecast', 'Gemini cannot answer this specific prediction.',
    'No relevant active Gemini contract was found for this claim. The prediction remains unverified; the absence of a market does not make it false.');

  const release = matches.find(match => /\b(?:release|released|launch|launched)\b/i.test(match.title));
  const annualProduction = /\b(?:robots?|production|produc\w*|ship\w*|manufactur\w*)\b/i.test(claim.text)
    && /\b(?:a year|per year|annual|annually)\b/i.test(claim.text);
  if (annualProduction && release) return assessment('forecast', 'A release market does not verify the production claim.',
    `The Reel predicts annual production. Gemini’s “${excerpt(release.title)}” concerns a release. Its price does not tell us the probability of reaching the Reel’s stated production volume by its deadline.`);
  return assessment('forecast', 'A related market does not confirm this prediction.',
    `Gemini has a related contract: “${excerpt(matches[0].title)}”. We have not established that its target, deadline and settlement rules match the Reel. Its price cannot be treated as the probability of this exact claim.`);
}

// Only these explicitly supplied facts may ground a Claude explanation.
export function reportEvidence({claim, assessment, market, model}) {
  const evidence = [{id: 'scope', text: 'This report checks Gemini Exchange public market data and supported volatility calculations only. It does not search news, filings or historical evidence to fact-check the Reel. The Reel transcript is an unverified claim, not a source of established facts.'},
    {id: 'conclusion', text: `${assessment.headline} ${assessment.summary}`}];
  if (market?.reason) evidence.push({id: 'market-search', text: market.reason});
  for (const [index, match] of (market?.matches ?? []).slice(0,3).entries()) {
    const id = `market-${index + 1}`;
    evidence.push({id, text: `Related Gemini contract question: ${match.title}. Settlement deadline: ${deadlineText(match.expiryDate)} (America/Los_Angeles). Preserve this timezone and calendar date in explanations. Topic similarity alone does not establish the same outcome as the Reel.`});
    for (const [quoteIndex, contract] of (match.contracts ?? []).slice(0,4).entries()) {
      if (!Number.isFinite(contract.prob) || contract.prob < 0 || contract.prob > 1) continue;
      evidence.push({id: `${id}-quote-${quoteIndex + 1}`, text: `For the Gemini contract “${match.title}”, outcome “${contract.label}”, the indicative YES price is ${percent(contract.prob)} (${contract.source || 'quote'}). This is not the probability of the Reel’s exact claim. Quote/trade age is unavailable.`});
    }
  }
  if (validRange(model?.model?.touch) && validRange(model?.model?.atExpiry)) evidence.push({id: 'model',
    text: `Independent volatility calculation for ${model.claim?.asset} ${model.claim?.direction} USD ${model.claim?.target} by ${deadlineText(model.claim?.deadlineISO)} (America/Los_Angeles): touching the target ${rangeText(model.model.touch)}, closing beyond the target at expiry ${rangeText(model.model.atExpiry)}. Sensitivity across 14/30/90-day realized volatility windows; not a confidence interval or a guarantee. Both market and historical price data come from Gemini.`});
  if (assessment.limitations.length) evidence.push({id: 'limits', text: assessment.limitations.join(' ')});
  return evidence;
}
