const TYPES = new Set(['fact', 'forecast', 'recommendation']);
const MAX_CLAIMS = 3;
const MAX_CLAIM_LENGTH = 500;
const FINANCE = /\b(?:stocks?|shares?|invest(?:ing|ment|ments|ors?)?|trading|trades?|markets?|prices?|valuation|valued|revenue|revenues|earnings|profits?|sales|growth|returns?|contracts?|government|defen[cs]e|business|compan(?:y|ies)|production|produc(?:e|es|ed|ing)|manufactur\w*|robots?|robotics|chips?|semiconductors?|rare earths?|magnets?|tariffs?|inflation|rates?|economy|economic|bitcoin|btc|ethereum|eth|crypto\w*|solana|xrp|zcash|dollars?|million|billion|trillion)\b|[$€£%]/i;
const NUMBER = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|trillion|double|triple)\b/i;
const ASSERTION = /\b(?:is|are|was|were|has|have|had|did|does|didn['’]t|doesn['’]t|rose|grew|fell|gained|lost|jumped|surged|dropped|increased|decreased|signed|won|awarded|received|secured|reported|announced|made|makes|make|produces?|produced|manufactures?|supplies|supplied|holds?|held|owns?|owned|sells?|sold|reached|hit|accounts? for|imports?|exports?|earns?|earned|generates?|generated|worth|valued|costs?|paid)\b/i;
const FORECAST = /\b(?:will|won['’]t|would|could|might|may|gonna|going to|about to|expected to|expects? to|anticipates?|plans? to|planned to|planning to|aims? to|aimed to|target(?:s|ing)?|projects? to|projected to|forecast(?:s|ed|ing)?|predict(?:s|ed|ing)?|potential to|set to|on track to|likely to|can (?:reach|hit|grow|rise|fall|double|triple)|should (?:reach|hit|grow|rise|fall))\b/i;
const RECOMMENDATION = /(?:^|[.!?;:]\s*)(?:(?:so|and|now|please)\s+)?(?:buy|sell|hold|short|accumulate|invest in|avoid)\b|\b(?:you (?:should|must|need to|have to)|we should|i (?:recommend|would buy|would sell)|consider (?:buying|selling|investing)|time to (?:buy|sell)|stocks? to (?:buy|sell|own)|shares? to buy|best (?:stocks?|investments?)|must[ -]buy|load up on|stay away from)\b/i;
const PROMO_ONLY = /^(?:(?:please|and|so|now|also|remember to|don't forget to|do not forget to)\s+)*(?:follow|subscribe|like|share|comment|click|check (?:out|the link)|join|save this|link in (?:my |the )?bio)\b/i;
const INSTRUCTION = /\b(?:ignore (?:all |the |any |previous |prior )*(?:instructions|rules|prompts)|system prompt|developer message|return (?:only )?json|output (?:only )?json|act as (?:an? )?(?:assistant|system)|reveal (?:the )?(?:secret|key|password))\b/i;
const NO_CLAIMS = 'No clear financial claims were found. Add a specific statement, forecast, or stock recommendation from the Reel.';

// Quotes are matched against this same whitespace-only normalization. Numbers,
// punctuation, dates, negation, and speaker qualifications are never rewritten.
const normalize = value => value.replace(/\s+/g, ' ').trim();
const words = value => value.match(/[\p{L}\p{N}]+/gu) ?? [];

function isProtectedPeriod(text, index) {
  const before = text.slice(0, index), after = text.slice(index + 1);
  if (/\d\s*$/.test(before) && /^\s*\d/.test(after)) return true;
  const start = Math.max(0, index - 12), around = text.slice(start, index + 12);
  for (const match of around.matchAll(/\b(?:[A-Za-z]\s*\.\s*){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|Inc|Corp|Ltd|vs|No)\./g)) {
    if (index >= start + match.index && index < start + match.index + match[0].length) return true;
  }
  return false;
}

function sentenceSpans(text) {
  const spans = [];
  let start = 0;
  const add = end => {
    while (start < end && /\s/.test(text[start])) start++;
    if (end > start) spans.push({start, end, quote: text.slice(start, end).trim()});
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    if (/[.!?]/.test(text[i]) && (i + 1 === text.length || /\s/.test(text[i + 1])) && !(text[i] === '.' && isProtectedPeriod(text, i))) add(i + 1);
  }
  add(text.length);
  return spans.flatMap(span => splitIndependentClauses(span, text));
}

function splitIndependentClauses(span, text) {
  // Attribution and conditional language may govern the whole sentence. Keep
  // those sentences intact instead of silently dropping that context.
  if (/\b(?:if|unless|according to|said|says|believes?|thinks?|claims?|claimed|reportedly|allegedly|supposedly|rumou?rs?)\b/i.test(span.quote)) return [span];
  const boundaries = [];
  const subject = /^(?:[A-Z][\p{L}\p{N}&'’-]*\s+){1,4}(?:(?:shares?|stock|revenue|sales|production|profits?|earnings)\s+)?(?:is|are|was|were|has|have|had|will|could|might|may|expects?|plans?|rose|fell|grew|reported|signed|won|secured|produces?|announced)\b/u;
  for (const match of span.quote.matchAll(/;\s*|,\s*(?:and\s+)?|\s+(?:and|while)\s+/g)) {
    const after = span.quote.slice(match.index + match[0].length);
    if (subject.test(after)) boundaries.push({end: span.start + match.index, next: span.start + match.index + match[0].length});
  }
  if (!boundaries.length) return [span];
  const parts = [];
  let start = span.start;
  for (const boundary of [...boundaries, {end: span.end, next: span.end}]) {
    const quote = text.slice(start, boundary.end).trim();
    if (!FINANCE.test(quote) || words(quote).length < 4) return [span];
    parts.push({start, end: boundary.end, quote});
    start = boundary.next;
  }
  return parts;
}

function typeOf(quote, now, fallback = 'fact') {
  if (RECOMMENDATION.test(quote) && FINANCE.test(quote)) return 'recommendation';
  if (FORECAST.test(quote)) return 'forecast';
  const futureYear = [...quote.matchAll(/\b(?:by|in|during|before|end of)\s+(?:the (?:end of |year )?)?(20\d{2})\b/gi)]
    .some(match => Number(match[1]) > now.getUTCFullYear());
  const futurePeriod = /\b(?:next (?:week|month|quarter|year)|tomorrow|by (?:the )?end of (?:this |the )?(?:week|month|year))\b/i.test(quote);
  if ((futureYear || futurePeriod) && !/\b(?:announced|said|reported) (?:in|during)\b/i.test(quote)) return 'forecast';
  return fallback;
}

export function classifyReportClaim(value, now=new Date()) {
  return typeOf(normalize(value),now,'fact');
}

function usable(quote) {
  return quote.length <= MAX_CLAIM_LENGTH && words(quote).length >= 4 && !INSTRUCTION.test(quote)
    && !PROMO_ONLY.test(quote) && !/^https?:\/\//i.test(quote) && !/\?\s*$/.test(quote);
}

function score(quote, type) {
  if (!usable(quote) || !FINANCE.test(quote)) return 0;
  if (type === 'fact' && (!ASSERTION.test(quote) || !NUMBER.test(quote))) return 0;
  if (type === 'forecast' && !NUMBER.test(quote) && !/\b(?:price|revenue|earnings|profit|sales|stock|shares?|bitcoin|btc|ethereum|eth|crypto|recession|inflation|rates?)\b/i.test(quote)) return 0;
  let result = 3 + (NUMBER.test(quote) ? 3 : 0) + (ASSERTION.test(quote) ? 1 : 0);
  if (/\b20\d{2}\b|\b(?:yesterday|last year|next year|this year|tomorrow)\b/i.test(quote)) result++;
  if (/[$€£%]|\b(?:million|billion|trillion|contract|revenue|earnings|production)\b/i.test(quote)) result += 2;
  if (type === 'recommendation') result++;
  if (/\b(?:he|she|it|they|this|that|these|those)\b/i.test(quote.split(/\s+/)[0])) result--;
  return result;
}

function fingerprint(quote) {
  return words(quote.toLowerCase()).filter(word => !['and', 'the', 'a', 'an', 'so', 'well'].includes(word));
}

function duplicate(left, right) {
  const a = fingerprint(left), b = fingerprint(right), aString = a.join(' '), bString = b.join(' ');
  if (aString === bString) return true;
  // Repeated ASR fragments may have punctuation or a small number of repeated
  // words. Do not merge claims with different numeric values or time periods.
  const distinctions = value => (value.toLowerCase().match(/\d+(?:[.,]\d+)*|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|trillion|not|never|no|without|cannot|can['’]t|won['’]t|didn['’]t|doesn['’]t|isn['’]t|aren['’]t|couldn['’]t|wouldn['’]t|will|would|could|might|may|tomorrow|today|yesterday|next|last)\b/g) ?? []).join('|');
  if (distinctions(left) !== distinctions(right)) return false;
  if (aString.includes(bString) || bString.includes(aString)) return true;
  const aSet = new Set(a), bSet = new Set(b), union = new Set([...aSet, ...bSet]);
  const overlap = [...aSet].filter(word => bSet.has(word)).length;
  return union.size > 0 && overlap / union.size >= .85;
}

function select(candidates) {
  const chosen = [];
  // Reward a different kind of claim while retaining the strongest concrete
  // statements. Restore transcript order after selection for readable context.
  while (chosen.length < MAX_CLAIMS) {
    const remaining = candidates.filter(candidate => !chosen.some(item => duplicate(item.quote, candidate.quote)));
    if (!remaining.length) break;
    remaining.sort((a, b) => (b.score + (chosen.some(item => item.type === b.type) ? 0 : 2))
      - (a.score + (chosen.some(item => item.type === a.type) ? 0 : 2)) || a.start - b.start);
    chosen.push(remaining[0]);
  }
  return chosen.sort((a, b) => a.start - b.start).map(({quote, type}, index) => ({id: `claim-${index + 1}`, text: quote, quote, type}));
}

function contextualQuote(span, index, spans, text) {
  if (/^(?:(?:and|but|so)\s+)?(?:it|they|he|she|this company|this stock|the company)\b/i.test(span.quote) && index > 0) {
    const previous = spans[index - 1];
    const expanded = text.slice(previous.start, span.end);
    if (expanded.length <= MAX_CLAIM_LENGTH && FINANCE.test(previous.quote) && !PROMO_ONLY.test(previous.quote) && !INSTRUCTION.test(previous.quote)) return {quote: expanded, start: previous.start};
  }
  return {quote: span.quote, start: span.start};
}

function fallbackClaims(text, now) {
  const spans = sentenceSpans(text), candidates = [];
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    // An overlong sentence is not arbitrarily cropped: that could remove a
    // negation, a deadline, or the entity. Let the user select it manually.
    if (span.quote.length > MAX_CLAIM_LENGTH) continue;
    const {quote, start} = contextualQuote(span, index, spans, text);
    const type = typeOf(quote, now), value = score(quote, type);
    if (value) candidates.push({quote, start, type, score: value});
  }
  return select(candidates);
}

function validateExtracted(data, text, now) {
  if (!data || !Array.isArray(data.claims) || data.claims.length > MAX_CLAIMS) return null;
  const spans = sentenceSpans(text), candidates = [];
  for (const claim of data.claims) {
    if (!claim || typeof claim.text !== 'string' || !claim.text.trim() || claim.text.length > MAX_CLAIM_LENGTH
      || typeof claim.quote !== 'string' || !claim.quote.trim() || claim.quote.length > MAX_CLAIM_LENGTH || !TYPES.has(claim.type)) return null;
    let quote = normalize(claim.quote), start = text.indexOf(quote);
    if (start < 0) return null;
    const firstIndex = spans.findIndex(span => span.start <= start && span.end > start);
    const lastSpan = spans.find(span => span.start < start + quote.length && span.end >= start + quote.length);
    const firstSpan = spans[firstIndex];
    if (!firstSpan || !lastSpan) return null;
    // Keep the complete surrounding statement, even when the model returns a
    // cropped quote such as "produce one million robots" after "might not".
    quote = text.slice(firstSpan.start, lastSpan.end);
    start = firstSpan.start;
    if (firstSpan === lastSpan) ({quote, start} = contextualQuote(firstSpan, firstIndex, spans, text));
    if (!usable(quote)) return null;
    const type = typeOf(quote, now, claim.type);
    candidates.push({quote, start, type, score: score(quote, type) || 1});
  }
  return select(candidates);
}

/** Extract up to three source-anchored claims; the transcript is untrusted data. */
export async function extractReportClaims(text, {extractor, now = new Date()} = {}) {
  if (typeof text !== 'string' || !text.trim()) return {claims: [], extraction: 'rules', warnings: [NO_CLAIMS]};
  const transcript = normalize(text);
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const warnings = [];
  if (typeof extractor === 'function') {
    try {
      const claims = validateExtracted(await extractor(transcript), transcript, date);
      if (claims && claims.length) return {claims, extraction: 'ai', warnings};
      if (claims && !fallbackClaims(transcript, date).length) return {claims: [], extraction: 'ai', warnings: [NO_CLAIMS]};
      warnings.push('Automatic claim extraction could not be verified. Showing statements selected directly from the transcript instead.');
    } catch {
      warnings.push('Automatic claim extraction was unavailable. Showing statements selected directly from the transcript instead.');
    }
  } else warnings.push('Claims were selected with text rules. Review the wording and classification before relying on the report.');
  const claims = fallbackClaims(transcript, date);
  if (!claims.length) warnings.push(NO_CLAIMS);
  return {claims, extraction: 'rules', warnings};
}
