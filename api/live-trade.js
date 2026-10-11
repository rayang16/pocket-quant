import {send} from '../lib/http.js';
import {createLiveOrderStore} from '../lib/live-order-store.js';

const supplied=value=>typeof value==='string'&&!!value.trim();

// Read-only preparation status. Credentials alone never enable order placement.
// Account authentication and live end-to-end verification must be integrated
// before exposing the separately prepared policy and durable order journal.
export function liveReadiness(env={}) {
  const oauth=supplied(env.GEMINI_LIVE_CLIENT_ID)&&supplied(env.GEMINI_LIVE_CLIENT_SECRET);
  const personal=supplied(env.GEMINI_LIVE_API_KEY)&&supplied(env.GEMINI_LIVE_API_SECRET);
  const credentialMode=oauth!==personal?(oauth?'oauth':'personal'):'pending';
  let storage=false;
  try {
    storage=!!createLiveOrderStore({url:env.UPSTASH_REDIS_REST_URL||'',token:env.UPSTASH_REDIS_REST_TOKEN||''});
  } catch {}
  return {
    environment:'production',tradingEnabled:false,connected:false,credentialMode,budget:'5.00',
    message:'Live trading is being prepared. Account access and the complete order flow still need verification. No real-money orders are available from this page yet.',
    requirements:[
      {id:'credentials',label:'Live connection details added',ready:credentialMode!=='pending'},
      {id:'storage',label:'Order storage details added',ready:storage},
      {id:'account',label:'Gemini account access verified',ready:false},
      {id:'verification',label:'Live order review verified',ready:false}
    ]
  };
}

export function createHandler({env=process.env}={}) {
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    let action;
    try {action=new URL(req.url,'http://localhost').searchParams.get('action')||'status';}
    catch {return send(res,400,{error:'Use a valid request.'});}
    if(action==='status') {
      if(req.method!=='GET') {res.setHeader('Allow','GET');return send(res,405,{error:'Use GET to check setup.'});}
      return send(res,200,liveReadiness(env));
    }
    if(['preview','submit','connect','history'].includes(action)) {
      return send(res,503,{environment:'production',tradingEnabled:false,code:'LIVE_TRADING_NOT_READY',error:'The live account connection and order flow are not enabled yet.'});
    }
    return send(res,404,{error:'Unknown live setup action.'});
  };
}

export default createHandler();
