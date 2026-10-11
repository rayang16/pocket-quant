import {gemini, readQuote, eventUrl} from './gemini.js';

// A shared quantity, finance word, or date is not evidence of a shared subject.
// Capitalization alone is also insufficient for common transcript sentence starts.
const GENERIC = new Set(`a an and are as at be been being but by can cannot could did do does for from had has have he her here hers him his how i if in into is it its let lets may me might more most my no not of on one or our ours out she should so than that the their theirs them then there these they this those through to too two up us was we were what when where which who why will with without would you your yours
about above after again all almost also already always another any around back because before below between both claim claims company companies fact facts forecast forecasts prediction predictions recommendation recommendations believe believes think thinks expect expected expects likely probably possible possibly plans planned plan potential potentially said says reportedly report reported reports next last today tomorrow yesterday now currently right really recently soon still just first second third finally
day days week weeks month months quarter quarters year years hour hours annual annually daily weekly monthly quarterly yearly time times end beginning deadline future past january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday
million millions billion billions trillion trillions thousand thousands hundred hundreds three four five six seven eight nine ten percent percentage dollars dollar usd eur gbp cents money cash buy buying sell selling hold short invest investing investor investors investment investments stock stocks share shares trading trade trades market markets price prices priced revenue revenues earning earnings profit profits sales growth returns return gain gains rose rise rises rising fall falls falling fell dropped drop surged increase increases increased decrease decreases decreased value valuation valued worth hit hits reach reaches reached target targets high higher highest low lower lowest double triple guaranteed guarantee best top must great huge massive big small new good bad real actual
government federal state local states united american america global world contract contracts deal deals agreement agreements order orders awarded award awards win wins won received receive receives secure secured signed sign signs announced announcement launches launch launched release released releases produce produces produced producing production manufacture manufactures manufactured manufacturing shipping shipped ship supply supplies supplied demand material materials magnets magnet rare earth earths metal metals mineral minerals robot robots robotics chip chips semiconductor semiconductors technology tech ai artificial intelligence electric vehicle vehicles defense defence business industry industries sector sectors public private news follows follow subscribe comment like welcome look hey wow well according analyst analysts ceo cfo sec ipo api usa uk eu u s`.split(/\s+/));

// These subject terms are specific enough to survive lower-case transcripts.
// Company names otherwise come from the transcript's own proper nouns/tickers.
const TOPICS = new Map([
  ['bitcoin', 'bitcoin'], ['btc', 'bitcoin'], ['ethereum', 'ethereum'], ['ether', 'ethereum'], ['eth', 'ethereum'],
  ['solana', 'solana'], ['sol', 'solana'], ['xrp', 'xrp'], ['ripple', 'xrp'], ['zcash', 'zcash'], ['zec', 'zcash'],
  ['recession', 'recession'], ['inflation', 'inflation'], ['unemployment', 'unemployment'],
]);

function subjectTokens(text) {
  const subjects = new Set();
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9'’-]*\b/g)) {
    const token = match[0], lower = token.toLowerCase().replace(/[’']/g, "'").replace(/'s$/, '');
    if (GENERIC.has(lower) || lower.length < 2 || /^\d/.test(lower)) continue;
    if (TOPICS.has(lower)) subjects.add(TOPICS.get(lower));
    else if (/^[A-Z][a-z]+(?:[A-Z][A-Za-z]*)?$/.test(token.replace(/[’']s$/, '')) || /^[A-Z][A-Z0-9]{1,9}$/.test(token)) subjects.add(lower);
  }
  return subjects;
}

function claimSubjects(text) {
  // Names in causal or attribution clauses can explain a claim without being
  // its subject (e.g. a stock moved after a politician mentioned it). Prefer
  // the named subject in the main clause instead of markets about that person.
  for (const context of text.matchAll(/\b(?:since|after|because|due to|following|according to)\b/gi)) {
    const mainSubjects = subjectTokens(text.slice(0, context.index));
    if (mainSubjects.size) return mainSubjects;
  }
  return subjectTokens(text);
}

function normalizedTokens(text) {
  return new Set((text.toLowerCase().replace(/[’']/g, "'").match(/[a-z][a-z0-9]*(?:'s)?/g) ?? [])
    .map(word => word.replace(/'s$/, '')).map(word => TOPICS.get(word) ?? word));
}

const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const future = (value, now) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
const inactive = value => value !== undefined && !['active', 'open'].includes(value);

function usableQuote(contract) {
  if (!contract || !validText(contract.label, 500) || !contract.prices || typeof contract.prices !== 'object') return null;
  const clean = {};
  for (const key of ['bestBid', 'bestAsk', 'lastTradePrice']) {
    const value = contract.prices[key];
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= 1) clean[key] = number;
  }
  const quote = readQuote({prices: clean});
  return quote.prob === null ? null : {label: contract.label.trim(), prob: quote.prob, source: quote.source};
}

function relatedReason(claim, matches) {
  const mismatch = 'Related topics only: deadlines, quantities, and settlement conditions may differ. These contract prices are not the odds of the Reel claim.';
  const production = /\b(?:robots?|production|produc\w*|ship\w*|manufactur\w*)\b/i.test(claim.text)
    && /\b(?:a year|per year|annual|annually)\b/i.test(claim.text)
    && matches.some(match => /\b(?:release|released|launch|launched)\b/i.test(match.title));
  const distinction = production ? ' A release market does not measure annual production volume.' : '';
  const typeNote = claim.type === 'fact' ? ' Future markets do not verify that a reported event already happened.'
    : claim.type === 'recommendation' ? ' Market prices do not establish whether buying a stock is suitable or profitable.' : '';
  return mismatch + distinction + typeNote;
}

/** Discover related live markets without treating topical overlap as verification. */
export async function relatedMarkets(claim, {client = gemini, now = new Date()} = {}) {
  const notApplicable = reason => ({status: 'not_applicable', reason, matches: []});
  if (!claim || !validText(claim.text, 6000)) return notApplicable('Add a specific claim to look for related Gemini markets.');
  const subjects = claimSubjects(claim.text);
  if (!subjects.size) return notApplicable('No sufficiently specific company, ticker, or subject was identified for reliable market discovery.');
  try {
    const time = Number(now instanceof Date ? now : new Date(now));
    if (!Number.isFinite(time)) throw new Error('Invalid check date');
    const listing = await client.events({status: 'active'});
    if (!Array.isArray(listing?.events)) throw new Error('Invalid event response');
    const candidates = [], seen = new Set();
    for (const event of listing.events) {
      if (!event || event.status !== 'active' || !future(event.expiryDate, time) || !validText(event.title, 500)
        || !validText(event.slug, 300) || !Array.isArray(event.contracts)) continue;
      const titleWords = normalizedTokens(event.title);
      const titleOverlap = [...subjects].filter(subject => titleWords.has(subject)).length;
      const activeContracts = event.contracts.filter(contract => contract && !inactive(contract.status) && !inactive(contract.tradingStatus)
        && future(contract.expiryDate ?? event.expiryDate, time));
      const relatedContracts = activeContracts.filter(contract => validText(contract.label, 500)
        && [...subjects].some(subject => normalizedTokens(contract.label).has(subject)));
      if (!titleOverlap && !relatedContracts.length) continue;
      const url = eventUrl(event);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      // A generic multi-outcome event may have only one related outcome. Do not
      // attach unrelated contract prices merely because its sibling matched.
      const contracts = (titleOverlap ? activeContracts : relatedContracts).map(usableQuote).filter(Boolean);
      candidates.push({score: titleOverlap * 3 + relatedContracts.length, match: {title: event.title.trim(), url, expiryDate: event.expiryDate, contracts}});
    }
    candidates.sort((a, b) => b.score - a.score || a.match.title.localeCompare(b.match.title));
    let quoteBudget = 4;
    const selected = candidates.slice(0, 3);
    const matches = selected.map(({match}, index) => {
      const reserved = selected.slice(index + 1).filter(candidate => candidate.match.contracts.length).length;
      const contracts = match.contracts.slice(0, Math.max(0, quoteBudget - reserved));
      quoteBudget -= contracts.length;
      return {...match, contracts};
    });
    if (!matches.length) return {status: 'none', reason: 'No active, unexpired Gemini market with a sufficiently specific subject match was found. This does not prove or disprove the claim.', matches: []};
    return {status: 'related', reason: relatedReason(claim, matches), matches};
  } catch {
    return {status: 'unavailable', reason: 'Gemini market data is unavailable right now. No market prices have been substituted.', matches: []};
  }
}
