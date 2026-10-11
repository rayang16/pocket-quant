import {tradeDraftUrl} from './trade-draft.js';

export const percent=p=>!Number.isFinite(p)?'—':p>0&&p<.001?'<0.1%':`${(p*100).toFixed(p===0||p===1?0:1)}%`;
export const percentRange=r=>!r?'—':r.hi<.001?'<0.1%':percent(r.lo)===percent(r.hi)?percent(r.hi):`${percent(r.lo)}–${percent(r.hi)}`;
export const money=n=>Number.isFinite(n)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:n<10?2:0}).format(n):'—';
export const date=s=>new Date(s).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
export function node(tag,cls,text) {const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function link(text,url) {const a=node('a','market-link',text);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function row(label,value,note,prob) {
  const r=node('div','stat-row'); const meta=node('div','stat-meta');meta.append(node('span','stat-label',label),node('small','',note));r.append(meta,node('strong','stat-value',value));
  if(Number.isFinite(prob)) {const track=node('div','stat-track');const bar=node('span');bar.style.width=`${Math.max(0,Math.min(1,prob))*100}%`;track.append(bar);r.append(track);}return r;
}
export function renderResult(container,r,{download,share}={}) {
  container.replaceChildren();
  const header=node('div','result-meta');header.append(node('span','eyebrow','THE EVIDENCE'),node('span','timestamp',`Checked ${new Date(r.checkedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`));container.append(header);
  if(!r.hypeVerdict) {
    container.append(node('h2','state-title',r.verdict),node('p','result-explanation',r.message||r.explanation));
    if(r.market?.url)container.append(link('Inspect this event on Gemini ↗',r.market.url));
    for(const match of r.matches??[]) {
      const card=node('div','match');card.append(node('h3','',match.title));
      for(const c of match.contracts)card.append(row(c.label,percent(c.prob),`${c.source} · YES contract`,c.prob));
      if(match.url)card.append(link('Confirm the conditions on Gemini ↗',match.url));container.append(card);
    }
    return;
  }
  const title=node('h2','verdict-stamp',r.verdict);container.append(title,node('p','result-explanation',r.explanation));
  const claim=node('div','normalized-claim');
  claim.append(node('span','eyebrow','CLAIM INTERPRETED AS'),node('p','',`${r.claim.asset} ${r.claim.direction==='above'?'≥':'<'} ${money(r.claim.target)} by ${date(r.claim.deadlineISO)}`));
  if(r.claim.deadlineAssumed)claim.append(node('small','notice','Deadline assumed: 30 days. Add a date to change it.'));
  container.append(claim);
  const stats=node('div','stats');
  stats.append(row('Speaker sounds',percent(r.claim.speakerConfidence),'Language estimate · not a measured belief',r.claim.speakerConfidence));
  stats.append(row(r.market.match==='exact'?'Gemini market':'Nearest Gemini market',percent(r.market.prob),`${r.market.side} · ${money(r.market.strike)} · ${date(r.market.expiryDate)} · ${r.market.source}`,r.market.prob));
  stats.append(row('Math at your deadline',percentRange(r.model.atExpiry),'Closes beyond target · 14 / 30 / 90-day volatility',r.model.atExpiry.hi));container.append(stats);
  const touch=node('div','touch-note');touch.append(node('span','','Even if it only touches the price'),node('strong','',percentRange(r.model.touch)));container.append(touch);
  if(r.market.match!=='exact')container.append(node('p','notice',r.matchNote));
  const details=node('details','method');details.append(node('summary','','How we got this'));
  const content=node('div','method-content');
  const lines=[`Spot: ${money(r.inputs.spot)} · ${r.inputs.days.toFixed(2)} days to the claim deadline.`,
    ...r.inputs.vols.map(v=>`${v.window}-day realized volatility: ${percent(v.sigma)} annualized.`),
    `Matched-contract model: ${percentRange(r.model.matchedContract)}. Market comparison: ${r.marketVsModel.label}.`,
    `Bid / ask for ${r.market.side}: ${percent(r.market.bid)} / ${percent(r.market.ask)}. Spread threshold: ${percent(r.marketVsModel.threshold)}.`,
    `Market-implied estimate at exact target: ${percentRange(r.market.impliedAtTarget)} at expiry; ${percentRange(r.market.impliedTouchAtTarget)} to touch. ${r.market.estimateNote}`,
    ...(r.market.targetBound?[`At this same expiry, the quoted strike suggests an indicative upper bound of ${percent(r.market.targetBound.prob)} for your target. This is not a touch bound.`]:[]),
    `Hype comparison uses the larger of the touch-range midpoint and market-based target estimate: ${percent(r.evidence)}.`,
    `Extraction: ${r.claim.extraction}. Daily history through ${date(r.inputs.historyEndsAt)}.`,
    `Data retrieved: spot ${date(r.inputs.asOf.spot)}, markets ${date(r.inputs.asOf.markets)}, candles ${date(r.inputs.asOf.candles)}. Quote/trade age is not supplied by Gemini.`];
  for(const line of lines)content.append(node('p','',line));
  for(const warning of r.warnings??[])content.append(node('p','notice',warning));
  const list=node('ul','assumptions');r.assumptions.forEach(a=>list.append(node('li','',a)));content.append(list);details.append(content);container.append(details);
  const actions=node('div','result-actions');if(r.market.url)actions.append(link('View this market on Gemini ↗',r.market.url));
  const draftUrl=tradeDraftUrl({symbol:r.market.instrumentSymbol,outcome:r.market.side});
  if(draftUrl&&Date.parse(r.market.expiryDate)>Date.now()) {
    const trade=node('a','secondary',`Prepare ${r.market.side} trade ↗`);trade.href=draftUrl;actions.append(trade);
  }
  if(share) {const button=node('button','secondary','↑ Share verdict card');button.type='button';button.addEventListener('click',()=>share(r));actions.append(button);}
  if(download) {const button=node('button','secondary','↓ Download card');button.type='button';button.addEventListener('click',()=>download(r));actions.append(button);}container.append(actions);
}
export async function request(base,path,body,{signal}={}) {
  const file=body instanceof Blob;
  const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':file?(body.type||'audio/webm'):'application/json'},body:file?body:JSON.stringify(body),signal:signal??AbortSignal.timeout(60000)});
  let data;try {data=await r.json();}catch {throw new Error('The server returned an unreadable response. Check the API address.');}
  if(!r.ok)throw new Error(data.error||`Request failed (${r.status}).`);return data;
}
