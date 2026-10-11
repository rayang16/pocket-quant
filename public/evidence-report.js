import {request,node,percent,renderResult} from './ui.js';

const types=new Set(['fact','forecast','recommendation']);
const statuses={not_market_verifiable:'Not market-verifiable',forecast:'Forecast',opinion:'Opinion / recommendation',unavailable:'Gemini unavailable'};
const fallbackHeadlines={not_market_verifiable:'Gemini cannot verify this factual claim.',forecast:'This prediction is not confirmed.',opinion:'This recommendation is not established by market prices.',unavailable:'Gemini could not check this claim right now.'};
export const claimTypeLabel=type=>({fact:'Factual statement',forecast:'Forecast',recommendation:'Recommendation'}[type]??'Factual statement');

export function geminiMarketUrl(value) {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return null;
    if(!['www.gemini.com','gemini.com'].includes(host)||!url.pathname.startsWith('/predictions/'))return null;
    return url.href;
  } catch{return null;}
}
export function assessmentFor(claim,assessment={},reportedClaim) {
  // A server-corrected forecast or opinion must remain distinct from a factual verdict.
  const claimType=assessment.status==='forecast'?'forecast':assessment.status==='opinion'?'recommendation'
    :['forecast','recommendation'].includes(reportedClaim?.type)?reportedClaim.type
    :['forecast','recommendation'].includes(claim.type)?claim.type:'fact';
  const status=assessment.status==='unavailable'?'unavailable':claimType==='forecast'?'forecast':claimType==='recommendation'?'opinion':'not_market_verifiable';
  return {...assessment,status,claimType,label:statuses[status]};
}
export function normalizeDrafts(data) {
  if(!Array.isArray(data?.claims))throw new Error('No claims were returned. Edit the transcript and try again.');
  const claims=data.claims.slice(0,3).filter(c=>typeof c?.text==='string'&&c.text.trim()).map((c,index)=>({id:typeof c.id==='string'?c.id:`claim-${index+1}`,text:c.text.trim().slice(0,500),quote:typeof c.quote==='string'?c.quote.slice(0,2000):'',type:types.has(c.type)?c.type:'fact'}));
  if(!claims.length)throw new Error('No clear claims were found. Paste a specific factual statement or prediction, then try again.');
  return {...data,claims};
}
export async function extractClaims(text,{sourceUrl,signal,send=request}={}) {
  signal?.throwIfAborted();
  const data=await send('','/api/evidence-report?action=extract',{text:text.slice(0,6000),...(sourceUrl?{sourceUrl}:{})},{signal});
  signal?.throwIfAborted();
  return normalizeDrafts(data);
}
// Each claim can fail independently; aborted or superseded batches never emit late results.
export async function checkClaims(claims,{sourceUrl,signal,onResult=()=>{},send=request,timeoutMs=110000}={}) {
  signal?.throwIfAborted();
  return Promise.all(claims.slice(0,3).map(async original=>{
    const claim={...original};
    const deadline=AbortSignal.timeout(Math.max(1,Math.min(110000,timeoutMs)));
    const claimSignal=AbortSignal.any([deadline,...(signal?[signal]:[])]);
    try {
      claimSignal.throwIfAborted();
      const data=await send('','/api/evidence-report?action=check',{claim,...(sourceUrl?{sourceUrl}:{})},{signal:claimSignal});
      claimSignal.throwIfAborted();onResult(claim.id,{data});return {id:claim.id,data};
    } catch(error) {
      signal?.throwIfAborted();
      const message=deadline.aborted||['AbortError','TimeoutError'].includes(error.name)?'This claim check timed out. Try checking again.':error.message;
      onResult(claim.id,{error:message});return {id:claim.id,error:message};
    }
  }));
}
function timeLabel(value) {
  if(!value||!Number.isFinite(new Date(value).getTime()))return null;
  return new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
}
function externalLink(title,url,cls='evidence-market-link') {
  const safe=geminiMarketUrl(url);if(!safe)return node('span',cls,title);
  const link=node('a',cls,title);link.href=safe;link.target='_blank';link.rel='noopener noreferrer';return link;
}
function renderExplanation(container,data) {
  const explanation=data.explanation;
  if(explanation?.provider!=='claude'||explanation.status==='disabled')return;
  if(explanation.status==='unavailable') {
    container.append(node('p','evidence-limitation','AI explanation unavailable; Gemini results are shown.'));return;
  }
  if(explanation.status!=='complete'||typeof explanation.answer!=='string'||!explanation.answer.trim())return;
  const section=node('section','evidence-ai-explanation');
  section.append(node('h4','eyebrow','CLAUDE · EXPLANATION'),node('p','evidence-ai-answer',explanation.answer));
  if(typeof explanation.reason==='string'&&explanation.reason.trim()&&explanation.reason!==explanation.answer)section.append(node('p','evidence-ai-reason',explanation.reason));
  const ids=new Set(Array.isArray(explanation.evidenceIds)?explanation.evidenceIds.filter(id=>typeof id==='string'):[]);
  const grounded=Array.isArray(data.evidence)?data.evidence.filter(item=>typeof item?.id==='string'&&ids.has(item.id)&&typeof item.text==='string'):[];
  if(grounded.length) {
    const details=node('details','evidence-ai-evidence');details.append(node('summary','','Evidence used in this explanation'));
    const list=node('ul','');
    for(const evidence of grounded)list.append(node('li','',evidence.text));
    details.append(list);section.append(details);
  }
  section.append(node('p','evidence-ai-disclosure','Claude explains the Gemini results and available math. It does not add independent fact-checking.'));
  container.append(section);
}
function renderAssessment(container,claim,data) {
  container.replaceChildren();
  const assessment=assessmentFor(claim,data.assessment,data.claim),stamp=node('div',`evidence-verdict evidence-${assessment.status}`);
  const answer=node('section','evidence-answer');
  const headline=typeof assessment.headline==='string'&&assessment.headline.trim()?assessment.headline:fallbackHeadlines[assessment.status];
  answer.append(node('p','eyebrow','ANSWER TO THE REEL'),node('h4','evidence-answer-headline',headline),node('p','evidence-summary',assessment.summary||'Gemini market prices cannot establish whether this claim is true.'));
  container.append(answer);
  stamp.append(node('strong','',assessment.label));
  const checked=timeLabel(data.checkedAt);if(checked)stamp.append(node('span','timestamp',`Checked ${checked}`));
  container.append(stamp);
  renderExplanation(container,data);
  for(const limitation of assessment.limitations??[])if(typeof limitation==='string')container.append(node('p','evidence-limitation',limitation));
  const markets=node('section','evidence-markets');markets.append(node('h4','eyebrow','GEMINI EXCHANGE · PREDICTION MARKETS'));
  markets.append(node('p','evidence-limitation',data.market?.reason||'No matching market was returned.'));
  const matches=Array.isArray(data.market?.matches)?data.market.matches.slice(0,3):[];
  if(matches.length)markets.append(node('p','notice','Related topics are not verification. Check that the market uses the same metric, target and deadline as this claim. Market prices are crowd estimates.'));
  for(const match of matches) {
    const market=node('div','evidence-market');market.append(externalLink(match.title||'Gemini market',match.url));
    const expiry=timeLabel(match.expiryDate);if(expiry)market.append(node('small','evidence-market-meta',`Market deadline: ${expiry}`));
    for(const contract of (match.contracts??[]).slice(0,4)) {
      const line=node('div','evidence-contract');line.append(node('span','',contract.label||'YES contract'),node('span','',percent(contract.prob)));market.append(line);
      if(contract.source)market.append(node('small','evidence-market-meta',`Gemini Exchange · ${contract.source} · YES price`));
      if(typeof contract.symbol==='string'&&/^GEMI-[A-Za-z0-9_-]{1,195}$/.test(contract.symbol)) {
        const review=node('a','evidence-market-link','Review this market in Pocket Quant ↗');
        review.href='/live.html?symbol='+encodeURIComponent(contract.symbol);
        market.append(review);
      }
    }
    markets.append(market);
  }
  if(matches.length)markets.append(node('p','evidence-limitation','Prices were retrieved from Gemini Exchange for this check. Individual quote/trade timestamps are not supplied by Gemini.'));
  container.append(markets);
  if(data.model?.claim?.asset&&data.model?.model) {
    const details=node('details','method independent-model');details.append(node('summary','','Independent crypto probability check'));
    const content=node('div','');content.append(node('p','notice','This volatility model estimates a price outcome under assumptions. It does not verify the Reel’s factual statements or predict investment returns.'));
    const modelContainer=node('div','');renderResult(modelContainer,data.model);content.append(modelContainer);details.append(content);container.append(details);
  }
}
export function createReportView(container,extraction,{onCheck=()=>{},onEdit=()=>{},onCancel=()=>{}}={}) {
  const data=normalizeDrafts(extraction),drafts=data.claims.map(c=>({...c})),cards=new Map();
  container.replaceChildren();container.classList.add('evidence-report');
  const header=node('div','result-meta');header.append(node('span','eyebrow','GEMINI MARKET REPORT'),node('span','small-tag',`${drafts.length} CLAIM${drafts.length===1?'':'S'}`));container.append(header);
  container.append(node('h2','report-title','Your Gemini report.'),node('p','result-explanation','Gemini market checks start automatically for each claim, with crypto math where supported. A related market may use a different target or deadline.'));
  container.append(node('p','evidence-extraction',data.extraction==='ai'?'Claude selected these claims; original excerpt preserved. Check the wording and claim types against the original words.':'These drafts were selected from the transcript. Check the wording and claim types against the original words.'));
  for(const warning of data.warnings??[])if(typeof warning==='string')container.append(node('p','notice',warning));
  const list=node('div','evidence-cards');container.append(list);
  const checkButton=node('button','primary','Check with Gemini ↗');checkButton.type='button';
  const stopButton=node('button','secondary','Stop checking');stopButton.type='button';stopButton.hidden=true;
  const updateCheckButton=()=>{checkButton.disabled=drafts.some(c=>c.text.trim().length<3);};
  for(const [index,claim] of drafts.entries()) {
    const card=node('article','evidence-card');card.setAttribute('aria-label',`Claim ${index+1}`);
    const heading=node('div','evidence-card-heading');heading.append(node('h3','',`Claim ${index+1}`));card.append(heading);
    const textLabel=node('label','evidence-field-label','Claim to check');textLabel.htmlFor=`evidence-claim-${index}`;
    const text=node('textarea','evidence-claim-input');text.id=textLabel.htmlFor;text.value=claim.text;text.maxLength=500;text.rows=3;card.append(textLabel,text);
    const typeLabel=node('label','evidence-field-label','What kind of claim is this?');typeLabel.htmlFor=`evidence-type-${index}`;
    const type=node('select','evidence-type');type.id=typeLabel.htmlFor;
    for(const value of types){const option=node('option','',claimTypeLabel(value));option.value=value;type.append(option);}type.value=claim.type;card.append(typeLabel,type);
    if(claim.quote) {
      const original=node('details','evidence-quote');original.append(node('summary','','Original transcript excerpt'),node('blockquote','',claim.quote));card.append(original);
    }
    const output=node('div','evidence-card-output');output.setAttribute('aria-live','polite');output.append(node('p','evidence-limitation','Preparing the automatic Gemini check…'));card.append(output);list.append(card);cards.set(claim.id,{card,output,type,pending:false});
    const edit=()=>{claim.text=text.value;claim.type=type.value;onEdit();output.replaceChildren(node('p','evidence-limitation','Claim edited. Check again to update its evidence.'));updateCheckButton();};
    text.addEventListener('input',edit);type.addEventListener('change',edit);
  }
  const actions=node('div','report-actions');actions.append(checkButton,stopButton);container.append(actions);
  const disclosure=node('p','evidence-disclosure','Market data comes from Gemini Exchange. A market price is a crowd estimate, not proof of a Reel’s factual claims or a recommendation to trade.');container.append(disclosure);
  checkButton.addEventListener('click',()=>onCheck(drafts.map(c=>({...c,text:c.text.trim()}))));stopButton.addEventListener('click',onCancel);updateCheckButton();
  return {
    start(){checkButton.disabled=true;checkButton.textContent='Checking each claim…';stopButton.hidden=false;for(const value of cards.values()){value.pending=true;value.card.setAttribute('aria-busy','true');value.output.replaceChildren(node('p','evidence-progress','Looking for live Gemini prediction markets…'));}},
    finish(){checkButton.textContent='Check with Gemini again ↗';stopButton.hidden=true;updateCheckButton();},
    stop(){this.finish();for(const value of cards.values())if(value.pending){value.pending=false;value.card.setAttribute('aria-busy','false');value.output.replaceChildren(node('p','evidence-limitation','Check stopped. Review the claim, then check again.'));}},
    result(id,response){const value=cards.get(id),claim=drafts.find(c=>c.id===id);if(!value||!claim)return;value.pending=false;value.card.setAttribute('aria-busy','false');if(response.error)value.output.replaceChildren(node('strong','evidence-error','Gemini check unavailable'),node('p','evidence-limitation',response.error));else {const reviewed=assessmentFor(claim,response.data.assessment,response.data.claim);claim.type=reviewed.claimType;value.type.value=claim.type;renderAssessment(value.output,claim,response.data);}}
  };
}
