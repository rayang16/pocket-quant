import {createHash} from 'node:crypto';
import {gemini} from '../lib/gemini.js';
import {send} from '../lib/http.js';
import {parseMarketQuery,normalizeWorkspaceMarkets} from '../lib/workspace-markets.js';

const CURSOR_TTL=15*60*1000;
function staleCursor(){const error=new Error('This market page has expired or does not match the current filters. Refresh the markets to start a new list.');error.status=409;return error;}
function readCursor(token,fingerprint,timestamp){
  let value;
  try{value=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));}catch{throw staleCursor();}
  const key=value?.after;
  if(value?.version!==1||value.fingerprint!==fingerprint||!Number.isFinite(value.at)||value.at>timestamp||timestamp-value.at>=CURSOR_TTL||!Number.isInteger(value.count)||value.count<1||value.count>10000||!Array.isArray(key)||key.length!==5||!key.slice(0,3).every(Number.isFinite)||key[0]<0||key[1]>0||key[1]<-6000||key[2]<0||typeof key[3]!=='string'||key[3].length>1000||typeof key[4]!=='string'||key[4].length>256)throw staleCursor();
  return value;
}

export function createHandler({client=gemini,now=()=>Date.now()}={}){
  return async function handler(req,res){
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
    if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
    if(req.method!=='GET'){res.setHeader('Allow','GET, OPTIONS');return send(res,405,{error:'Use GET for market discovery.'});}
    try{
      const query=parseMarketQuery(new URL(req.url,'http://localhost').searchParams);
      const {offset,snapshot,cursor,...filters}=query;
      const fingerprint=createHash('sha256').update(JSON.stringify(filters)).digest('base64url');
      const continuation=cursor?readCursor(cursor,fingerprint,now()):null;
      if(!continuation&&(offset>0||snapshot))throw staleCursor();
      const listing=await client.events(query.category?{category:query.category}:{});
      const evaluatedAt=continuation?.at??now(),position=continuation?.count??0;
      // A portable seek cursor never applies an offset to a changed live feed.
      // Removed or newly inserted earlier events cannot shift the next page.
      const {continuationKey,...result}=normalizeWorkspaceMarkets(listing?.events,{...query,offset:position},{now:evaluatedAt,fetchedAt:listing?.fetchedAt,upstreamCategory:query.category,after:continuation?.after??null});
      const nextCursor=result.hasMore?Buffer.from(JSON.stringify({version:1,at:evaluatedAt,fingerprint,count:position+result.events.length,after:continuationKey})).toString('base64url'):null;
      return send(res,200,{...result,nextCursor,evaluatedAt:new Date(evaluatedAt).toISOString(),cursorExpiresAt:new Date(evaluatedAt+CURSOR_TTL).toISOString()});
    }catch(error){
      const status=[400,409].includes(error.status)?error.status:502;
      return send(res,status,{error:status===400||status===409||error.name==='DataError'?error.message:'The related markets could not be loaded. Try again shortly; no odds have been substituted.'});
    }
  };
}
export default createHandler();
