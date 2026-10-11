const BASE='https://api.gemini.com';
export class DataError extends Error { constructor(message) { super(message); this.name='DataError'; } }
export function readQuote(contract) {
  const p=contract.prices||{};
  const number=x=>x!==undefined&&x!==null&&x!==''&&Number.isFinite(Number(x))&&Number(x)>=0&&Number(x)<=1?Number(x):null;
  const bid=number(p.bestBid), ask=number(p.bestAsk), last=number(p.lastTradePrice);
  const crossed=bid!==null&&ask!==null&&bid>ask;
  if (crossed) return {prob:last,bid,ask,halfSpread:null,source:last===null?'unavailable':'last trade (crossed book)',quality:'crossed'};
  const both=bid!==null&&ask!==null;
  return {prob:both?(bid+ask)/2:last??bid??ask,bid,ask,halfSpread:both?(ask-bid)/2:null,
    source:both?'bid/ask midpoint':last!==null?'last trade':bid!==null?'bid only':ask!==null?'ask only':'unavailable',quality:both?'two-sided':'limited'};
}
export function contractProb(contract) {
  const quote=readQuote(contract);
  return quote.prob===null ? null : quote;
}
export function eventUrl(event) {
  return typeof event?.slug==='string'&&event.slug ? `https://www.gemini.com/predictions/${encodeURIComponent(event.slug)}` : null;
}
export function createGeminiClient({fetch:fetchOverride,fetchImpl=fetchOverride??globalThis.fetch, now=()=>Date.now()}={}) {
  const cache=new Map(), inflight=new Map();
  async function get(path,ttl) {
    const cached=cache.get(path);
    if(cached&&now()-cached.fetchedAt<ttl) return cached;
    if(inflight.has(path)) return inflight.get(path);
    const pending=(async()=>{
      let response;
      try { response=await fetchImpl(BASE+path,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}}); }
      catch { throw new DataError('Gemini is unreachable. Try again shortly; no odds have been substituted.'); }
      if(!response.ok) throw new DataError(`Gemini returned ${response.status}. Try again shortly.`);
      let data;
      try { data=await response.json(); } catch { throw new DataError('Gemini returned an unreadable response.'); }
      const result={data,fetchedAt:now()}; cache.set(path,result);
      if(cache.size>250) cache.delete(cache.keys().next().value);
      return result;
    })();
    inflight.set(path,pending);
    try {return await pending;} finally {inflight.delete(path);}
  }
  const client={
    async spot(asset) {
      const r=await get(`/v1/pubticker/${asset.toLowerCase()}usd`,15000);
      const value=Number(r.data.last);
      if(!Number.isFinite(value)||value<=0) throw new DataError('Gemini did not provide a valid spot price.');
      return {value,fetchedAt:r.fetchedAt};
    },
    async candles(asset) {
      const r=await get(`/v2/candles/${asset.toLowerCase()}usd/1day`,600000);
      if(!Array.isArray(r.data)) throw new DataError('Gemini did not provide daily candles.');
      const rows=[...new Map(r.data.filter(c=>Array.isArray(c)&&Number.isFinite(+c[0])&&+c[4]>0&&+c[0]+86400000<=now()).map(c=>[+c[0],c])).values()].sort((a,b)=>a[0]-b[0]);
      // Only contiguous, completed daily candles: never annualize irregular intervals as days.
      let start=0;
      for(let i=1;i<rows.length;i++) if(Math.abs(rows[i][0]-rows[i-1][0]-86400000)>1000) start=i;
      const contiguous=rows.slice(start);
      if(!contiguous.length||now()-(+contiguous.at(-1)[0]+86400000)>2*86400000) throw new DataError('Daily price history is missing or stale.');
      return {closes:contiguous.map(c=>Number(c[4])),fetchedAt:r.fetchedAt,lastCloseAt:+contiguous.at(-1)[0]+86400000};
    },
    async events({category,search,status='active'}={}) {
      const data=[]; let fetchedAt=now();
      for(let offset=0;offset<5000;offset+=100) {
        const params=new URLSearchParams({status,limit:'100',offset:String(offset)});
        if(category) params.set('category',category); if(search) params.set('search',search);
        const r=await get(`/v1/prediction-markets/events?${params}`,30000);
        if(!Array.isArray(r.data.data)) throw new DataError('Gemini returned an unexpected event format.');
        data.push(...r.data.data); fetchedAt=Math.min(fetchedAt,r.fetchedAt);
        if(r.data.data.length<100 || data.length>=Number(r.data.pagination?.total??Infinity)) return {events:data,fetchedAt};
      }
      throw new DataError('Too many markets to match reliably. Narrow the claim.');
    }
  };
  client.listEvents=async options=>(await client.events(options)).events;
  client.spotPrice=async asset=>(await client.spot(asset)).value;
  client.dailyCloses=async asset=>(await client.candles(asset)).closes;
  client.contractProb=contractProb;
  client.eventUrl=eventUrl;
  return client;
}
export const gemini=createGeminiClient();
export const listEvents=options=>gemini.listEvents(options);
export const spotPrice=asset=>gemini.spotPrice(asset);
export const dailyCloses=asset=>gemini.dailyCloses(asset);
