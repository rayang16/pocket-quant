import {send,rawBody} from '../lib/http.js';
import {createLiveOrderStore} from '../lib/live-order-store.js';
import {createLiveOwnerAuth,LiveOwnerAuthError} from '../lib/live-owner-auth.js';
import {createGeminiLiveReadonly,LiveReadonlyError} from '../lib/gemini-live-readonly.js';
import {createGeminiLiveExchange} from '../lib/gemini-live-exchange.js';
import {createLiveTradeEngine,LiveTradeError} from '../lib/live-trade-engine.js';

const supplied=value=>typeof value==='string'&&!!value.trim();

function configuredStore(env) {
  try {return createLiveOrderStore({url:env.UPSTASH_REDIS_REST_URL||'',token:env.UPSTASH_REDIS_REST_TOKEN||''});}
  catch {return null;}
}

// Configuration is not an account check or permission to submit an order.
// Every private action independently authenticates the owner and revalidates
// account state, and every submission consumes a durable reviewed reservation.
export function liveReadiness(env={}) {
  const oauth=supplied(env.GEMINI_LIVE_CLIENT_ID)&&supplied(env.GEMINI_LIVE_CLIENT_SECRET);
  const personal=supplied(env.GEMINI_LIVE_API_KEY)&&supplied(env.GEMINI_LIVE_API_SECRET);
  const credentialMode=oauth!==personal?(oauth?'oauth':'personal'):'pending';
  const storage=!!configuredStore(env);
  const tradingEnabled=env.GEMINI_LIVE_TRADING_ENABLED==='true'&&credentialMode==='personal'&&
    env.GEMINI_LIVE_NONCE_MODE==='time'&&createLiveOwnerAuth({env}).configured&&storage;
  return {
    environment:'production',tradingEnabled,connected:false,credentialMode,budget:'5.00',
    message:tradingEnabled?'Unlock your private account to review a real-money order. Every order needs your confirmation; the demo reserves at most $5 including a fee allowance.':'Live order review is not enabled. You can check your private account while setup is completed.',
    requirements:[
      {id:'credentials',label:'Live connection details added',ready:credentialMode!=='pending'},
      {id:'storage',label:'Order storage details added',ready:storage},
      {id:'account',label:'Gemini account access verified',ready:false},
      {id:'verification',label:'Live order review available',ready:tradingEnabled}
    ]
  };
}

export function createHandler({env=process.env,auth=createLiveOwnerAuth({env}),client=createGeminiLiveReadonly({env}),
  exchange=createGeminiLiveExchange({env}),store=configuredStore(env),now=()=>Date.now(),
  engine=createLiveTradeEngine({accountClient:client,exchange,store,now})}={}) {
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
    if(['login','logout','account','markets','preview','submit','result'].includes(action)) {
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
        if(['markets','preview','submit','result'].includes(action)) {
          const session=auth.getSession(req);
          if(!session) return send(res,401,{code:'OWNER_LOGIN_REQUIRED',error:'Unlock private owner access before reviewing an order.'});
          if(!liveReadiness(env).tradingEnabled) return send(res,503,{code:'LIVE_TRADING_NOT_READY',error:'Live order review is not enabled yet.'});
          if(['preview','submit'].includes(action)) {
            auth.requireMutation(req,session);
            if(!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||'')) return send(res,415,{error:'Send the order review as JSON.'});
            let body;
            try {body=JSON.parse((await rawBody(req,4096)).toString('utf8'));}
            catch {return send(res,400,{error:'Send a valid order review.'});}
            return send(res,200,await engine[action](session,body));
          }
          if(req.method!=='GET') {res.setHeader('Allow','GET');return send(res,405,{error:'Use GET to check markets or an order result.'});}
          const value=action==='markets'?await engine.markets(session):await engine.result(session,new URL(req.url,'http://localhost').searchParams.get('previewToken'));
          if(now()>=session.expiresAt) return send(res,401,{code:'OWNER_LOGIN_REQUIRED',error:'Your private session expired. Unlock it again.'});
          return send(res,200,value);
        }
        if(req.method!=='GET') {res.setHeader('Allow','GET');return send(res,405,{error:'Use GET to check your account.'});}
        const session=auth.getSession(req);
        if(!session) return send(res,401,{code:'OWNER_LOGIN_REQUIRED',error:'Unlock private owner access to check this account.'});
        if(liveReadiness(env).credentialMode!=='personal') return send(res,503,{code:'LIVE_ACCOUNT_NOT_CONFIGURED',error:'The private account connection is not configured yet.'});
        const snapshot=await client.snapshot();
        if(now()>=session.expiresAt) return send(res,401,{code:'OWNER_LOGIN_REQUIRED',error:'Your private session expired. Unlock it again.'});
        if(snapshot.accountSelectionRequired) return send(res,409,{code:'LIVE_ACCOUNT_SELECTION_REQUIRED',error:'Choose the intended Gemini account in the private server configuration first.'});
        return send(res,200,{environment:'production',connected:true,tradingEnabled:liveReadiness(env).tradingEnabled,budget:'5.00',
          account:{label:snapshot.accountLabel,availableUsd:snapshot.availableUsd,termsAccepted:snapshot.termsAccepted,roles:{trader:snapshot.roles.isTrader}},checkedAt:new Date(now()).toISOString()});
      } catch(error) {
        if(error instanceof LiveOwnerAuthError||error instanceof LiveReadonlyError||error instanceof LiveTradeError) {
          return send(res,error.status||503,{code:error.code||'LIVE_ACCOUNT_UNAVAILABLE',error:error.message});
        }
        return send(res,503,{code:'LIVE_ACCOUNT_UNAVAILABLE',error:'The private account check is unavailable. Try again shortly.'});
      }
    }
    if(['connect','history'].includes(action)) {
      return send(res,503,{environment:'production',tradingEnabled:false,code:'LIVE_TRADING_NOT_READY',error:'The live account connection and order flow are not enabled yet.'});
    }
    return send(res,404,{error:'Unknown live setup action.'});
  };
}

export default createHandler();
