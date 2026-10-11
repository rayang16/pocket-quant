import {createHash} from 'node:crypto';
import {DataError,readQuote,eventUrl} from './gemini.js';

export const MARKET_LIMITS=Object.freeze({events:100,contracts:500});
const ASSETS=new Set(['BTC','ETH','SOL','XRP','ZEC']);
export const MARKET_CATEGORIES=Object.freeze(['Live','Sports','Pro Football','Pro Baseball','Midterms','Crypto','Commodities','Economics','Politics','Tech','Business','Weather','Culture']);
const SECTORS=new Map(MARKET_CATEGORIES.map(category=>[category.toLowerCase().replaceAll(' ','-'),category]));
const STOP_WORDS=new Set(`a an and are as at be been before being below between big but by can claim claims close closes closing could date day days deadline definitely degree degrees dollar dollars end event feed for forecast from guaranteed happens has have highest hit hits i if in into is it its just likely low market markets may might month months more most must my next not now of on one only or over past prediction predictions price prices probably reach reaches really reel say says should so some than that the their them then there these they think this those time to today tomorrow tonight under up very was week weeks were what when where which will with would year years yes your january february march april may june july august september october november december`.split(/\s+/));
const PARAMS=new Set(['asset','category','sector','q','search','deadline','offset','snapshot','cursor']);
export class MarketQueryError extends Error {
  constructor(message){super(message);this.name='MarketQueryError';this.status=400;}
}

function deadlineValue(value){
  if(!value)return null;
  const parts=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  const timestamp=Date.parse(value);
  if(!parts||!Number.isFinite(timestamp)||+parts[2]<1||+parts[2]>12||+parts[3]<1||+parts[3]>new Date(Date.UTC(+parts[1],+parts[2],0)).getUTCDate()||+parts[4]>23||+parts[5]>59||+parts[6]>59)throw new MarketQueryError('Use a valid ISO date and time for the deadline.');
  return new Date(timestamp).toISOString();
}

export function parseMarketQuery(params){
  if(!(params instanceof URLSearchParams))throw new MarketQueryError('Use URL query parameters for market discovery.');
  for(const key of params.keys())if(!PARAMS.has(key)||params.getAll(key).length!==1)throw new MarketQueryError('Use each market filter parameter at most once.');
  const asset=(params.get('asset')||'').trim().toUpperCase()||null;
  if(asset&&!ASSETS.has(asset))throw new MarketQueryError('Choose BTC, ETH, SOL, XRP, or ZEC for the asset.');
  let category=(params.get('category')||'').trim()||null;
  if(category&&(category.length>64||!/^\p{L}[\p{L}\p{N} &-]*$/u.test(category)))throw new MarketQueryError('Use a category name of up to 64 characters.');
  if(['other','all'].includes(category?.toLowerCase()))category=null;
  if(category)category=MARKET_CATEGORIES.find(name=>name.toLowerCase()===category.toLowerCase())||category;
  let sector=(params.get('sector')||'').trim().toLowerCase()||null;
  if(sector==='all')sector=null;
  if(sector&&!SECTORS.has(sector))throw new MarketQueryError('Choose one of the available Gemini market sectors.');
  if(sector){
    const sectorCategory=SECTORS.get(sector);
    if(category&&category!==sectorCategory)throw new MarketQueryError('Choose either one category or its matching sector.');
    category=sectorCategory;
  }
  if(asset&&category&&category!=='Crypto')throw new MarketQueryError('An asset filter must use the Crypto category.');
  if(asset)category='Crypto';
  const q=params.get('q')||'';
  if(q.length>6000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(q))throw new MarketQueryError('Use search text of up to 6,000 characters without control characters.');
  const search=params.get('search')||'';
  if(search.length>120||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(search))throw new MarketQueryError('Use a market search of up to 120 characters without control characters.');
  const rawOffset=params.get('offset')??'0';
  if(!/^\d+$/.test(rawOffset)||Number(rawOffset)>10000)throw new MarketQueryError('Use an offset from 0 to 10,000 in whole numbers.');
  const snapshot=params.get('snapshot')||null;
  if(snapshot&&!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(snapshot))throw new MarketQueryError('Use the snapshot returned by the first market page.');
  const cursor=params.get('cursor')||null;
  if(cursor&&(cursor.length>16384||!/^[A-Za-z0-9_-]+$/.test(cursor)))throw new MarketQueryError('Use the cursor returned by the previous market page.');
  return {asset,category,sector,q:q.trim(),search:search.trim(),deadline:deadlineValue((params.get('deadline')||'').trim()),offset:Number(rawOffset),snapshot,cursor};
}

const boundedText=(value,limit=1000)=>typeof value==='string'&&value.trim()&&value.length<=limit?value.trim():null;
const identifier=value=>typeof value==='number'&&Number.isFinite(value)?String(value):boundedText(value,256);
const validTime=value=>typeof value==='string'&&value.trim()&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const words=value=>String(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
// Directory search keeps dates, amounts, and every other typed term. Normalize
// thousands separators so 92500 also finds a source label such as $92,500.
const searchWords=value=>words(String(value).replace(/(\d),(?=\d{3}(?:\D|$))/g,'$1'));

export function marketKeywords(q){return [...new Set(words(q).filter(word=>word.length>=3&&!/^\d+$/.test(word)&&!STOP_WORDS.has(word)))];}

// Symbols, not loose title substrings, establish a crypto asset relationship.
export function matchesAsset(event,asset){
  if(!ASSETS.has(asset))return false;
  const pattern=new RegExp(`^${asset}(?:$|\\d|[-_])`);
  return [event?.ticker,event?.series].some(value=>typeof value==='string'&&pattern.test(value.toUpperCase()));
}

function matchesCategory(event,category,upstreamCategory){
  if(!category)return true;
  // Live membership comes only from Gemini's dedicated category response, not
  // status=active, a future deadline, or an inferred kickoff time.
  if(category==='Live'&&upstreamCategory==='Live')return true;
  const labels=[event.category,...(Array.isArray(event.tags)?event.tags:[]),event.subcategory?.name,...(Array.isArray(event.subcategory?.path)?event.subcategory.path:[])];
  return labels.some(value=>typeof value==='string'&&value.toLowerCase()===category.toLowerCase());
}

function quoteNumber(value){
  if(typeof value!=='number'&&typeof value!=='string')return null;
  if(typeof value==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))return null;
  const number=Number(value);
  return Number.isFinite(number)&&number>=0&&number<=1?number:null;
}

function normalizeContract(contract,event,now){
  if(!contract||typeof contract!=='object'||Array.isArray(contract))return null;
  if(contract.status!=null&&contract.status!=='active'||contract.marketState!=null&&contract.marketState!=='open'||contract.resolvedAt)return null;
  const expiry=validTime(contract.expiryDate??event.expiryDate);
  const label=boundedText(contract.label);
  if(expiry===null||expiry<=now||!label)return null;
  const prices=contract.prices&&typeof contract.prices==='object'?contract.prices:{};
  const {prob,bid,ask,source,quality}=readQuote({prices:Object.fromEntries(['bestBid','bestAsk','lastTradePrice'].map(key=>[key,quoteNumber(prices[key])]))});
  const rawStrike=contract.strike?.value;
  const strike=(typeof rawStrike==='number'||typeof rawStrike==='string'&&rawStrike.trim())&&Number.isFinite(Number(rawStrike))?Number(rawStrike):null;
  const rawSymbol=boundedText(contract.instrumentSymbol,256);
  const symbol=rawSymbol&&/^GEMI-[A-Za-z0-9_-]{1,195}$/.test(rawSymbol)?rawSymbol:null;
  return {id:identifier(contract.id)??symbol??identifier(contract.ticker),label,symbol,strike,strikeType:boundedText(contract.strike?.type,32),expiryDate:new Date(expiry).toISOString(),prob,bid,ask,source,quality};
}

function flattenEvents(events){
  const result=[],seen=new Set(),objects=new WeakSet(),queue=[...events];
  for(let index=0;index<queue.length;index++){
    const event=queue[index];
    if(!event||typeof event!=='object'||Array.isArray(event)||objects.has(event))continue;
    objects.add(event);
    if(Array.isArray(event.events))queue.push(...event.events);
    const key=identifier(event.id)??identifier(event.ticker);
    if(key&&seen.has(key))continue;
    if(key)seen.add(key);
    result.push(event);
  }
  return result;
}

// Lexical comparison is independent of the machine's locale. A source ID is the
// final tiebreaker so reordered equal-title events cannot cross a page boundary.
export function compareMarketKeys(a,b){
  for(let index=0;index<a.length;index++)if(a[index]!==b[index])return a[index]<b[index]?-1:1;
  return 0;
}

// Related-market discovery never declares a contract to price the original claim.
export function normalizeWorkspaceMarkets(rawEvents,query,{now=Date.now(),fetchedAt,upstreamCategory=null,maxEvents=MARKET_LIMITS.events,maxContracts=MARKET_LIMITS.contracts,after=null}={}){
  if(!Array.isArray(rawEvents)||!Number.isFinite(now)||!Number.isFinite(fetchedAt))throw new DataError('Gemini returned an unreadable market list.');
  if(!Number.isInteger(maxEvents)||maxEvents<1||!Number.isInteger(maxContracts)||maxContracts<1)throw new TypeError('Market limits must be positive integers.');
  const {asset,category,q,search='',deadline,offset=0}=query;
  if(!Number.isInteger(offset)||offset<0||offset>10000)throw new MarketQueryError('Use an offset from 0 to 10,000 in whole numbers.');
  const keywords=marketKeywords(q),searchTerms=searchWords(search),reference=deadline?Date.parse(deadline):null;
  const scope=asset?`Related ${asset} markets`:category==='Live'?(q?'Keyword-related markets in Gemini’s Live feed':'Gemini Live feed (upstream category)'):q?`Keyword-related${category?` ${category}`:''} markets`:category?`Active ${category} markets (category browse)`:'Active Gemini markets (browse)';
  const related=[];
  for(const event of flattenEvents(rawEvents)){
    const title=boundedText(event.title),eventCategory=boundedText(event.category,64),expiry=validTime(event.expiryDate);
    if(event.status!=='active'||event.resolvedAt||!title||expiry===null||expiry<=now)continue;
    if(!matchesCategory(event,category,upstreamCategory))continue;
    if(asset&&!matchesAsset(event,asset))continue;
    const titleWords=new Set(words(title));
    const score=keywords.reduce((total,word)=>total+Number(titleWords.has(word)),0);
    if(!asset&&q&&!score)continue;
    const contracts=(Array.isArray(event.contracts)?event.contracts:[]).map(contract=>normalizeContract(contract,event,now)).filter(Boolean);
    if(!contracts.length)continue;
    if(search&&(!searchTerms.length||!contracts.some(contract=>{
      const text=searchWords(`${title} ${contract.label}`).join(' ');
      return searchTerms.every(term=>text.includes(term));
    })))continue;
    const start=validTime(event.startTime);
    const normalized={id:identifier(event.id)??identifier(event.ticker),title,category:eventCategory,expiryDate:new Date(expiry).toISOString(),startTime:start!==null&&start<expiry?new Date(start).toISOString():null,series:boundedText(event.series,64),url:eventUrl({slug:boundedText(event.slug,500)}),contracts};
    const identity=normalized.id??createHash('sha256').update(JSON.stringify([title,expiry,contracts.map(contract=>[contract.id,contract.symbol,contract.label])])).digest('hex');
    related.push({event:normalized,key:[reference===null?0:Math.abs(expiry-reference),-score,expiry,title,identity]});
  }
  related.sort((a,b)=>compareMarketKeys(a.key,b.key));
  const total=related.length,totalContracts=related.reduce((sum,item)=>sum+item.event.contracts.length,0),events=[];
  const eligible=after?related.filter(item=>compareMarketKeys(item.key,after)>0):related,start=after?0:offset;
  let remaining=maxContracts,continuationKey=null;
  for(const {event,key} of eligible.slice(start,start+maxEvents)){
    if(!remaining)break;
    // Keep an ordinary event together. An oversized first event still gets a
    // bounded response with explicit disclosure of the omitted contracts.
    if(events.length&&event.contracts.length>remaining)break;
    const contractTotal=event.contracts.length;
    const contracts=event.contracts.slice(0,remaining);remaining-=contracts.length;
    events.push({...event,contracts,contractTotal,contractsTruncated:contracts.length<contractTotal});
    continuationKey=key;
  }
  const hasMore=start+events.length<eligible.length,nextOffset=hasMore?offset+events.length:null;
  return {events,fetchedAt:new Date(fetchedAt).toISOString(),scope,total,totalContracts,offset,nextOffset,hasMore,continuationKey:hasMore?continuationKey:null,truncated:offset>0||events.length<total||events.some(event=>event.contractsTruncated)};
}
