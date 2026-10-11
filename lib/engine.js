import {gemini,createGeminiClient,readQuote,eventUrl} from './gemini.js';
import {extractClaim,selectMarket} from './claim.js';
import {probCloseAbove,probCloseBelow,probTouch,realizedVol,impliedVolSolutions,hypeVerdict,marketVsModel,range} from './math.js';
const YEAR=365*86400000;
// Deadlines, prediction language, and quantities do not identify a market's subject.
const genericMarketWords=new Set([
  'price','crypto','bitcoin','ethereum','hit','end','month','think','might','could','probably','degree','degrees','temperature','highest',
  'year','years','months','week','weeks','days','hour','hours','today','tonight','tomorrow','yesterday','next','last',
  'before','after','during','until','within','annual','annually','daily','weekly','monthly','quarterly','yearly','quarter','quarters',
  'expected','expect','expects','likely','unlikely','possible','possibly','predict','predicts','prediction','predictions','forecast','forecasts',
  'guaranteed','certainly','definitely','thinks','believe','believes','should','would','will','going','about','happen','happens',
  'above','below','over','under','more','less','most','than','then','this','that','these','those','with','from','into','have','been','being','there','their','they','them',
  'thousand','thousands','million','millions','billion','billions','trillion','trillions'
]);
const assumptions=[
  'A lognormal model can understate crypto’s fat tails and sudden jumps.',
  'Realized volatility describes the past. It is not implied volatility or a guarantee of future volatility.',
  'Zero drift expresses no directional view; the model does not forecast returns.',
  'The 14/30/90-day range is a sensitivity range, not a statistical confidence interval.',
  'Speaker confidence is a language heuristic, not a measured belief or calibrated probability.',
  'Touching a price before a deadline differs from closing beyond it at expiry.',
  'Gemini contracts may settle on an external index; Gemini spot is a proxy for that index.',
  'Quotes are indicative. Fees, liquidity, and unknown last-trade age can affect interpretation. Not financial advice.'
];
const usd=x=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(x);
const pct=x=>`${(x*100).toFixed(1)}%`;
const expiry=(event,c)=>Date.parse(c?.expiryDate||event.expiryDate);
const future=(e,now)=>e.status==='active'&&Date.parse(e.expiryDate)>now;
function marketObject(e,c,q) {
  return {eventTitle:e.title,contractLabel:c.label,instrumentSymbol:c.instrumentSymbol,strike:Number(c.strike?.value)||null,expiryDate:c.expiryDate||e.expiryDate,...q,url:eventUrl(e),match:'nearest',settlement:'at expiry'};
}
export async function checkClaim(text,{fetch:fetchOverride,client,now=new Date(),extract=extractClaim,apiKey=null}={}) {
  now=new Date(now);
  if(!Number.isFinite(+now)) throw new TypeError('now must be a valid date.');
  if(typeof text!=='string'||text.trim().length<3||text.length>6000) throw new TypeError('text must contain 3–6,000 characters.');
  client??=fetchOverride?createGeminiClient({fetch:fetchOverride,now:()=>+now}):gemini;
  const claim=await extract(text,{now,fetchImpl:fetchOverride??globalThis.fetch,apiKey});
  const base={claim,checkedAt:now.toISOString(),assumptions};
  const stop=(verdict,message,extra={})=>({...base,verdict,message,...extra});
  if(claim.clarification||claim.deadlineError) return stop('NEEDS CLARIFICATION',claim.clarification||claim.deadlineError);
  if(!claim.isPrediction) return stop('NOT A PREDICTION','Markets can only check predictions about the future.');
  const deadline=Date.parse(claim.deadlineISO),t=(deadline-now)/YEAR;
  if(!Number.isFinite(t)||t<=0) return stop('NOT A FUTURE DEADLINE','That deadline has passed. Include a future date. Deadlines are interpreted at 21:00 UTC.');
  if(!claim.asset) return checkOther(claim,base,client,now,{fetchImpl:fetchOverride??globalThis.fetch,apiKey});
  const [spot,candles,listing]=await Promise.all([client.spot(claim.asset),client.candles(claim.asset),client.events({category:'Crypto'})]);
  const S=spot.value;
  const candidates=(claim.targets??claim.targetCandidates??[claim.target]).filter(x=>x>=S*.2&&x<=S*10);
  const target=claim.targetPct!==null&&claim.targetPct!==undefined?S*(1+claim.targetPct):candidates[0];
  if(!(target>0)) return stop('NEEDS A PRICE TARGET',`Include one USD target between ${usd(S*.2)} and ${usd(S*10)}, or an up/down percentage.`);
  if(new Set(candidates).size>1&&claim.targetPct==null) return stop('NEEDS CLARIFICATION','Several plausible price targets were found. Paste one prediction with one target.');
  claim.target=target;
  const vols=[14,30,90].map(window=>({window,sigma:realizedVol(candles.closes,window)})).filter(v=>v.sigma!==null);
  if(vols.length<3) return stop('INSUFFICIENT HISTORY','Gemini did not return enough completed daily candles for all three volatility windows.');
  const closing=(K,T,v)=>claim.direction==='above'?probCloseAbove(S,K,T,v):probCloseBelow(S,K,T,v);
  const model={atExpiry:range(vols.map(v=>closing(target,t,v.sigma))),touch:range(vols.map(v=>probTouch(S,target,t,v.sigma,claim.direction)))};
  const inputs={spot:S,vols,days:t*365,historyEndsAt:new Date(candles.lastCloseAt).toISOString(),asOf:{spot:new Date(spot.fetchedAt).toISOString(),candles:new Date(candles.fetchedAt).toISOString(),markets:new Date(listing.fetchedAt).toISOString()}};
  const eligible=listing.events.filter(e=>future(e,+now)&&new RegExp(`^${claim.asset}(?:\\d|05M|15M|1H|$)`).test(e.ticker??e.series??'')&&(!/(?:05M|15M)/.test(e.series??e.ticker)||t*YEAR<3600000))
    .filter(e=>e.contracts?.some(c=>['above','reference'].includes(c.strike?.type)&&Number(c.strike.value)>0))
    .sort((a,b)=>Math.abs(expiry(a)-deadline)-Math.abs(expiry(b)-deadline));
  if(!eligible.length) return stop('NO MATCH','No Gemini market on this claim yet.',{inputs,model});
  const event=eligible[0];
  const contracts=event.contracts.filter(c=>['above','reference'].includes(c.strike?.type)&&Number(c.strike.value)>0&&expiry(event,c)>+now&&(!c.status||c.status==='active')).sort((a,b)=>Math.abs(Number(a.strike.value)-target)-Math.abs(Number(b.strike.value)-target));
  const contract=contracts.find(c=>readQuote(c).prob!==null);
  if(!contract) return stop('NO QUOTES','A matching Gemini event exists, but none of its price contracts has a quote.',{inputs,model,market:{eventTitle:event.title,url:event.slug?`https://www.gemini.com/predictions/${encodeURIComponent(event.slug)}`:null,prob:null}});
  const q=readQuote(contract),K=Number(contract.strike.value),mt=(expiry(event,contract)-now)/YEAR;
  const market=marketObject(event,contract,q);
  market.yesProb=q.prob; market.side=claim.direction==='above'?'YES':'NO';
  if(claim.direction==='below') {
    market.prob=1-q.prob;market.bid=q.ask===null?null:1-q.ask;market.ask=q.bid===null?null:1-q.bid;
    market.source=`complement of YES ${q.source}`;
  }
  market.deadlineDifferenceHours=(expiry(event,contract)-deadline)/3600000;
  market.sameDeadline=Math.abs(market.deadlineDifferenceHours)<=1/60;
  market.sameStrike=Math.abs(K-target)<.000001;
  market.match=market.sameDeadline&&market.sameStrike?'exact':'nearest';
  const matchedModel=range(vols.map(v=>closing(K,mt,v.sigma)));
  const comparison=marketVsModel(market.prob,matchedModel.lo,matchedModel.hi,market.halfSpread);
  model.matchedContract=matchedModel;
  // A price bound applies to expiry probabilities only, and only at the SAME expiry.
  const beyond=claim.direction==='above'?target>Math.max(...contracts.map(c=>Number(c.strike.value))):target<Math.min(...contracts.map(c=>Number(c.strike.value)));
  market.targetBound=market.sameDeadline&&beyond?{kind:'upper',prob:market.prob,scope:'at expiry only',quotedStrike:K}:null;
  if(market.targetBound) market.targetBound.explanation=`Gemini’s ${claim.direction==='above'?'highest':'lowest'} quoted strike is ${usd(K)} at ${pct(market.prob)} for ${market.side}, suggesting an indicative ≤${pct(market.prob)} at your target at the same expiry; this is not a bound on touching it.`;
  const roots=impliedVolSolutions(S,K,mt,q.prob);
  market.impliedVols=roots;
  market.impliedAtTarget=roots.length?range(roots.map(v=>closing(target,t,v))):null;
  market.impliedTouchAtTarget=roots.length?range(roots.map(v=>probTouch(S,target,t,v,claim.direction))):null;
  market.estimateNote=roots.length>1?'Two implied volatility solutions; both are included.':roots.length?'Model-based extrapolation from the matched quote; not a listed Gemini price.':'This quote has no identifiable implied volatility in the 5%–400% search range.';
  if(!market.sameDeadline) market.estimateNote+=' The market has a different expiry.';
  const touchMidpoint=(model.touch.lo+model.touch.hi)/2;
  const marketTargetEstimate=market.sameDeadline&&market.sameStrike?market.prob:market.impliedAtTarget?.hi??null;
  const evidence=Math.max(touchMidpoint,marketTargetEstimate??0);
  const verdict=hypeVerdict(claim.speakerConfidence,evidence);
  const explanation=verdict.label==='HYPE'?'The speaker sounds much more certain than the midpoint of the modeled touch range and the market-based target estimate support.':verdict.label==='STRETCH'?'The speaker sounds more certain than the evidence supports.':verdict.label==='UNDERSOLD'?'The evidence is more optimistic than the speaker’s cautious language.':'The speaker’s language is broadly consistent with the available evidence; this does not make the prediction certain.';
  return {...base,verdict:verdict.label,hypeVerdict:verdict,inputs,market,model,marketVsModel:comparison,evidence,
    evidenceBasis:{touchMidpoint,marketTargetEstimate,rule:'max(touch range midpoint, market-implied target probability)'},explanation,matchNote:market.match==='exact'?'Exact strike and expiry match.':`Closest quoted contract: ${usd(K)} at ${market.expiryDate}. Its quoted ${pct(market.prob)} is not the odds of the original claim.`,
    warnings:[...(market.quality!=='two-sided'?['There is no usable two-sided order book. No market mispricing verdict is issued.']:[]),...(!market.sameDeadline?['The nearest market has a different deadline. Target estimates assume constant implied volatility across time.']:[]),...(beyond?['The target is outside the listed strikes; extrapolation is especially uncertain.']:[])]};
}
async function checkOther(claim,base,client,now,options) {
  const listing=await client.events({category:claim.category==='Other'?undefined:claim.category});
  const words=new Set(claim.keywords.map(w=>w.toLowerCase().replace(/[^a-z]/g,'')).filter(w=>w.length>=4&&!genericMarketWords.has(w)));
  const scored=listing.events.filter(e=>future(e,+now)).map(e=>({e,score:[...words].filter(w=>new RegExp(`\\b${w}\\b`,'i').test(e.title)).length})).filter(x=>x.score>=1).sort((a,b)=>b.score-a.score).slice(0,24);
  if(!scored.length) return {...base,verdict:'NO MATCH',message:'No Gemini market on this claim yet.'};
  const selection=await selectMarket(claim,scored.map(x=>x.e),options);
  if(selection) {
    const event=scored[selection.eventIndex].e,contract=event.contracts[selection.contractIndex],quote=readQuote(contract);
    if(quote.prob!==null) {
      const market=marketObject(event,contract,quote);market.side=selection.side;market.match='AI-selected';market.matchReason=selection.reason;
      if(selection.side==='NO') {market.prob=1-quote.prob;market.bid=quote.ask===null?null:1-quote.ask;market.ask=quote.bid===null?null:1-quote.bid;market.source=`complement of YES ${quote.source}`;}
      return {...base,verdict:'MARKET ONLY',market,model:null,hypeVerdict:null,marketVsModel:null,explanation:'This market prices a related outcome; there is no probability model for this category, so no hype verdict is issued.',message:`Claude selected “${contract.label}” (${market.side}) at ${pct(market.prob)}. Confirm the resolution rules on Gemini.`,warnings:['AI matching can be wrong; verify the deadline and conditions.']};
    }
  }
  const matches=scored.slice(0,3).map(({e})=>({title:e.title,expiryDate:e.expiryDate,url:eventUrl(e),contracts:(e.contracts??[]).map(c=>({label:c.label,...readQuote(c)})).filter(c=>c.prob!==null)}));
  return {...base,verdict:'POSSIBLE MATCH',message:'Related markets found. Confirm their conditions on Gemini; keyword overlap alone cannot establish that they price this claim.',matches,model:null,explanation:'No model for this category. No hype verdict is assigned to an unconfirmed match.'};
}
