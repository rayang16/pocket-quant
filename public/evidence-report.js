import {request,node,percent,renderResult} from './ui.js';

const types=new Set(['fact','forecast','recommendation']);
const statuses={supported:'Evidence supports',contradicted:'Evidence conflicts',mixed:'Mixed evidence',unverified:'Not verified',forecast:'Forecast',opinion:'Opinion / recommendation',unavailable:'Check unavailable'};
export const claimTypeLabel=type=>({fact:'Factual statement',forecast:'Forecast',recommendation:'Recommendation'}[type]??'Factual statement');

export function publicSourceUrl(value) {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return null;
    if(!host.includes('.')||host.endsWith('.local')||host.endsWith('.localhost')||host.endsWith('.internal')||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host))return null;
    return url.href;
  } catch{return null;}
}
export function assessmentFor(claim,assessment={},reportedClaim) {
  // A server-corrected forecast or opinion must remain distinct from a factual verdict.
  const claimType=assessment.status==='forecast'?'forecast':assessment.status==='opinion'?'recommendation'
    :['forecast','recommendation'].includes(reportedClaim?.type)?reportedClaim.type
    :['forecast','recommendation'].includes(claim.type)?claim.type:'fact';
  const status=claimType==='forecast'?'forecast':claimType==='recommendation'?'opinion':Object.hasOwn(statuses,assessment.status)?assessment.status:'unverified';
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
function externalLink(title,url,cls='evidence-source-link') {
  const safe=publicSourceUrl(url);if(!safe)return node('span',cls,title);
  const link=node('a',cls,title);link.href=safe;link.target='_blank';link.rel='noopener noreferrer';return link;
}
function renderAssessment(container,claim,data) {
  container.replaceChildren();
  const assessment=assessmentFor(claim,data.assessment,data.claim),stamp=node('div',`evidence-verdict evidence-${assessment.status}`);
  stamp.append(node('strong','',assessment.label));
  const checked=timeLabel(data.checkedAt);if(checked)stamp.append(node('span','timestamp',`Checked ${checked}`));
  container.append(stamp,node('p','evidence-summary',assessment.summary||'There is not enough evidence to assess this claim.'));
  if(assessment.claimType==='forecast')container.append(node('p','notice','A forecast or target is not evidence that the outcome happened or will happen. Check the deadline and supporting assumptions.'));
  if(assessment.claimType==='recommendation')container.append(node('p','notice','This is an opinion or recommendation. Supporting facts do not establish that a trade is suitable or profitable.'));
  for(const limitation of assessment.limitations??[])if(typeof limitation==='string')container.append(node('p','evidence-limitation',limitation));
  const sources=Array.isArray(data.sources)?data.sources.slice(0,8):[];
  const sourceArea=node('section','evidence-sources');sourceArea.append(node('h4','eyebrow','SOURCES CHECKED'));
  if(!sources.length)sourceArea.append(node('p','evidence-limitation','No cited sources returned. This claim remains unverified.'));
  const list=node('ol','evidence-source-list');
  sources.forEach(source=>{
    const item=node('li','');item.append(externalLink(source.title||'View source',source.url));
    const sourceDate=source.publishedAt&&Number.isFinite(Date.parse(source.publishedAt))?new Date(source.publishedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):null;
    const kind={primary:'Primary source',secondary:'Secondary source',unknown:'Source type not verified'}[source.sourceType]??'Source type not verified';
    item.append(node('small','evidence-source-meta',`${kind} · ${sourceDate?`Published ${sourceDate}`:'Publication date not provided'}`));
    if(source.excerpt)item.append(node('p','evidence-source-excerpt',source.excerpt));
    list.append(item);
  });
  sourceArea.append(list);container.append(sourceArea);
  const markets=node('section','evidence-markets');markets.append(node('h4','eyebrow','RELATED GEMINI MARKETS'));
  markets.append(node('p','evidence-limitation',data.market?.reason||'No matching market was returned.'));
  const matches=Array.isArray(data.market?.matches)?data.market.matches.slice(0,3):[];
  if(matches.length)markets.append(node('p','notice','Related topics are not verification. Check that the market uses the same metric, target and deadline as this claim. Market prices are crowd estimates.'));
  for(const match of matches) {
    const market=node('div','evidence-market');market.append(externalLink(match.title||'Gemini market',match.url));
    const expiry=timeLabel(match.expiryDate);if(expiry)market.append(node('small','evidence-source-meta',`Market deadline: ${expiry}`));
    for(const contract of (match.contracts??[]).slice(0,4)) {
      const line=node('div','evidence-contract');line.append(node('span','',contract.label||'YES contract'),node('span','',percent(contract.prob)));market.append(line);
      if(contract.source)market.append(node('small','evidence-source-meta',`${contract.source} · YES price`));
    }
    markets.append(market);
  }
  container.append(markets);
  if(data.model?.claim?.asset&&data.model?.model) {
    const details=node('details','method independent-model');details.append(node('summary','','Independent crypto probability check'));
    const content=node('div','');content.append(node('p','notice','This volatility model estimates a price outcome under assumptions. It does not verify the Reel’s factual statements or predict investment returns.'));
    const modelContainer=node('div','');renderResult(modelContainer,data.model);content.append(modelContainer);details.append(content);container.append(details);
  }
}
export function createReportView(container,extraction,{onCheck=()=>{},onEdit=()=>{},onCancel=()=>{},canResearch}={}) {
  const data=normalizeDrafts(extraction),drafts=data.claims.map(c=>({...c})),cards=new Map();
  container.replaceChildren();container.classList.add('evidence-report');
  const header=node('div','result-meta');header.append(node('span','eyebrow','YOUR EVIDENCE REPORT'),node('span','small-tag',`${drafts.length} CLAIM${drafts.length===1?'':'S'} TO REVIEW`));container.append(header);
  container.append(node('h2','report-title','First, check the claims.'),node('p','result-explanation','Correct the wording and claim type below. Then check the sources. Facts, forecasts and recommendations need different kinds of evidence.'));
  container.append(node('p','evidence-extraction',data.extraction==='ai'?'Claude extracted these drafts. Check them against the original words.':'These drafts use a basic text extraction. Check the wording and claim types carefully.'));
  for(const warning of data.warnings??[])if(typeof warning==='string')container.append(node('p','notice',warning));
  if(canResearch===false)container.append(node('p','notice','Live source research isn’t available here yet. You can review claims and explore related Gemini markets. Factual claims will stay unverified.'));
  const list=node('div','evidence-cards');container.append(list);
  const checkButton=node('button','primary','Check claims & sources ↗');checkButton.type='button';
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
    const output=node('div','evidence-card-output');output.setAttribute('aria-live','polite');output.append(node('p','evidence-limitation','Ready for your review. No sources checked yet.'));card.append(output);list.append(card);cards.set(claim.id,{card,output,type,pending:false});
    const edit=()=>{claim.text=text.value;claim.type=type.value;onEdit();output.replaceChildren(node('p','evidence-limitation','Claim edited. Check again to update its evidence.'));updateCheckButton();};
    text.addEventListener('input',edit);type.addEventListener('change',edit);
  }
  const actions=node('div','report-actions');actions.append(checkButton,stopButton);container.append(actions);
  const disclosure=node('p','evidence-disclosure',canResearch===false?'Related Gemini markets can provide context. They do not verify the claim’s facts.':'Claims are sent to Anthropic’s Claude to look up evidence. Source pages may be incomplete or wrong; review the cited material.');container.append(disclosure);
  checkButton.addEventListener('click',()=>onCheck(drafts.map(c=>({...c,text:c.text.trim()}))));stopButton.addEventListener('click',onCancel);updateCheckButton();
  return {
    start(){checkButton.disabled=true;checkButton.textContent='Checking each claim…';stopButton.hidden=false;for(const value of cards.values()){value.pending=true;value.card.setAttribute('aria-busy','true');value.output.replaceChildren(node('p','evidence-progress','Looking up sources and related markets…'));}},
    finish(){checkButton.textContent='Check claims again ↗';stopButton.hidden=true;updateCheckButton();},
    stop(){this.finish();for(const value of cards.values())if(value.pending){value.pending=false;value.card.setAttribute('aria-busy','false');value.output.replaceChildren(node('p','evidence-limitation','Check stopped. Review the claim, then check again.'));}},
    result(id,response){const value=cards.get(id),claim=drafts.find(c=>c.id===id);if(!value||!claim)return;value.pending=false;value.card.setAttribute('aria-busy','false');if(response.error)value.output.replaceChildren(node('strong','evidence-error','Check unavailable'),node('p','evidence-limitation',response.error));else {const reviewed=assessmentFor(claim,response.data.assessment,response.data.claim);claim.type=reviewed.claimType;value.type.value=claim.type;renderAssessment(value.output,claim,response.data);}}
  };
}
