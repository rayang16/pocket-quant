import {send,rawBody} from '../lib/http.js';
import {createLiveOrderStore} from '../lib/live-order-store.js';
import {createLiveOwnerAuth,LiveOwnerAuthError} from '../lib/live-owner-auth.js';
import {createGeminiLiveReadonly,LiveReadonlyError} from '../lib/gemini-live-readonly.js';

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

export function createHandler({env=process.env,auth=createLiveOwnerAuth({env}),client=createGeminiLiveReadonly({env}),now=()=>Date.now()}={}) {
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    let action;
    try {action=new URL(req.url,'http://localhost').searchParams.get('action')||'status';}
    catch {return send(res,400,{error:'Use a valid request.'});}
    if(action==='status') {
      if(req.method!=='GET') {res.setHeader('Allow','GET');return send(res,405,{error:'Use GET to check setup.'});}
      const session=auth.getSession(req);
      return send(res,200,{...liveReadiness(env),ownerAccessConfigured:auth.configured,authenticated:!!session,
        ...(session?{csrfToken:session.csrfToken,sessionExpiresAt:session.expiresAt}:{})});
    }
    if(['login','logout','account'].includes(action)) {
      try {
        if(action==='login') {
          if(req.method!=='POST') {res.setHeader('Allow','POST');return send(res,405,{error:'Use POST to unlock your account.'});}
          if(!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||'')) return send(res,415,{error:'Send your access code as JSON.'});
          let body;
          try {body=JSON.parse((await rawBody(req,2048)).toString('utf8'));}
          catch {return send(res,400,{error:'Enter a valid owner access code.'});}
          const session=auth.login(req,res,body?.code);
          return send(res,200,{authenticated:true,csrfToken:session.csrfToken,sessionExpiresAt:session.expiresAt});
        }
        if(action==='logout') {
          auth.logout(req,res);
          return send(res,200,{authenticated:false});
        }
        if(req.method!=='GET') {res.setHeader('Allow','GET');return send(res,405,{error:'Use GET to check your account.'});}
        const session=auth.getSession(req);
        if(!session) return send(res,401,{code:'OWNER_LOGIN_REQUIRED',error:'Unlock private owner access to check this account.'});
        if(liveReadiness(env).credentialMode!=='personal') return send(res,503,{code:'LIVE_ACCOUNT_NOT_CONFIGURED',error:'The private account connection is not configured yet.'});
        const snapshot=await client.snapshot();
        if(now()>=session.expiresAt) return send(res,401,{code:'OWNER_LOGIN_REQUIRED',error:'Your private session expired. Unlock it again.'});
        if(snapshot.accountSelectionRequired) return send(res,409,{code:'LIVE_ACCOUNT_SELECTION_REQUIRED',error:'Choose the intended Gemini account in the private server configuration first.'});
        return send(res,200,{environment:'production',connected:true,tradingEnabled:false,budget:'5.00',
          account:{label:snapshot.accountLabel,availableUsd:snapshot.availableUsd,termsAccepted:snapshot.termsAccepted,roles:{trader:snapshot.roles.isTrader}},checkedAt:new Date(now()).toISOString()});
      } catch(error) {
        if(error instanceof LiveOwnerAuthError||error instanceof LiveReadonlyError) {
          return send(res,error.status||503,{code:error.code||'LIVE_ACCOUNT_UNAVAILABLE',error:error.message});
        }
        return send(res,503,{code:'LIVE_ACCOUNT_UNAVAILABLE',error:'The private account check is unavailable. Try again shortly.'});
      }
    }
    if(['preview','submit','connect','history'].includes(action)) {
      return send(res,503,{environment:'production',tradingEnabled:false,code:'LIVE_TRADING_NOT_READY',error:'The live account connection and order flow are not enabled yet.'});
    }
    return send(res,404,{error:'Unknown live setup action.'});
  };
}

export default createHandler();
