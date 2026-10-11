import { geminiMarketUrl } from './evidence-report.js';

/** Preserve the complete upstream report alongside the existing crypto snapshot. */
export function reportWorkspaceResult(report) {
  const model = report?.model?.claim ? report.model : null;
  return {
    ...(model || {claim:{summary:report?.claim?.text || '',category:'Other'},verdict:report?.assessment?.label || report?.assessment?.status || 'Checked'}),
    checkedAt:report.checkedAt,
    report,
  };
}
const prob = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const symbol = value => typeof value === 'string' && /^GEMI-[A-Za-z0-9_-]{1,195}$/.test(value) ? value : null;
/** Only use matches selected by the report service; never widen its subject match. */
export function reportWorkspaceEvents(report) {
  const events = (Array.isArray(report?.market?.matches) ? report.market.matches : []).filter(match => match && typeof match.title==='string' && geminiMarketUrl(match.url)).map((match,index)=>({
    id:`report-${index}`,title:match.title,url:geminiMarketUrl(match.url),category:match.category || 'Related',expiryDate:match.expiryDate,
    _fetchedAt:report.checkedAt,_rank:index,contracts:(Array.isArray(match.contracts) ? match.contracts : []).filter(c=>c && typeof c.label==='string').map((contract,i)=>({
      id:`report-${index}-${i}`,label:contract.label,prob:prob(contract.prob),bid:null,ask:null,symbol:symbol(contract.symbol),
      source:contract.source || 'report snapshot',expiryDate:match.expiryDate,quality:'limited',
    })),
  }));
  const model=report?.model, market=model?.market;
  if (model?.model && symbol(market?.instrumentSymbol) && geminiMarketUrl(market.url)) {
    let event=events.find(event=>event.url===geminiMarketUrl(market.url));
    if (!event) {event={id:'report-model',title:market.eventTitle || market.contractLabel,url:geminiMarketUrl(market.url),category:'Crypto',expiryDate:market.expiryDate,_fetchedAt:model.checkedAt,_rank:events.length,contracts:[]};events.push(event);}
    event.category='Crypto';
    const bid=prob(market.bid),ask=prob(market.ask),price=prob(market.prob),no=market.side==='NO';
    const contract={label:market.contractLabel,symbol:market.instrumentSymbol,strike:market.strike,expiryDate:market.expiryDate,
      prob:no&&price!==null?1-price:price,bid:no?(ask===null?null:1-ask):bid,ask:no?(bid===null?null:1-bid):ask,
      source:market.source,quality:bid!==null&&ask!==null&&bid<=ask?'two-sided':'limited'};
    const index=event.contracts.findIndex(c=>c.label===contract.label);
    if(index>=0)event.contracts[index]=contract;else event.contracts.push(contract);
  }
  return events;
}
