import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {send,rawBody} from './http.js';

// Sandbox hosts are deliberately constants. Configuration cannot enable real-money trading.
export const SANDBOX_API='https://api.sandbox.gemini.com';
const SANDBOX_EXCHANGE='https://exchange.sandbox.gemini.com';
const SCOPES='orders:read,orders:create';
const SESSION_SECONDS=3600;
const FLOW_SECONDS=600;
const SETUP_MESSAGE='Gemini sandbox connection needs app credentials. Ask your team to finish the sandbox setup.';

export class HttpError extends Error {
  constructor(status,message) {super(message);this.name='HttpError';this.status=status;}
}

function configuration(env) {
  const clientId=env.GEMINI_SANDBOX_CLIENT_ID;
  const clientSecret=env.GEMINI_SANDBOX_CLIENT_SECRET;
  const secret=env.GEMINI_SESSION_SECRET;
  if(typeof clientId!=='string'||!clientId.trim()||typeof clientSecret!=='string'||!clientSecret.trim()||typeof secret!=='string'||Buffer.byteLength(secret)<32) return null;
  try {
    const redirect=new URL(env.GEMINI_REDIRECT_URI);
    const loopback=['localhost','127.0.0.1','[::1]'].includes(redirect.hostname);
    if(redirect.username||redirect.password||redirect.hash||redirect.pathname!=='/api/gemini-account'||redirect.search!=='?action=callback') return null;
    if(redirect.protocol!=='https:'&&!(redirect.protocol==='http:'&&loopback)) return null;
    // A callback belongs to Pocket Quant, never either Gemini production host.
    if(redirect.hostname==='gemini.com'||redirect.hostname.endsWith('.gemini.com')) return null;
    const secure=redirect.protocol==='https:';
    return {clientId,clientSecret,redirectUri:redirect.href,origin:redirect.origin,secure,
      key:createHash('sha256').update(secret).digest(),
      sessionCookie:secure?'__Host-pq_gemini_sandbox':'pq_gemini_sandbox',
      flowCookie:secure?'__Host-pq_gemini_flow':'pq_gemini_flow'};
  } catch {return null;}
}

function equal(a,b) {
  if(typeof a!=='string'||typeof b!=='string') return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
}

function readCookie(req,name) {
  const source=req.headers?.cookie;
  if(typeof source!=='string'||source.length>16000) return null;
  const values=source.split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
  return values.length===1?values[0].slice(name.length+1):null;
}

function cookie(name,value,seconds,secure) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure?'; Secure':''}`;
}

function appendCookie(res,value) {
  const existing=res.getHeader?.('Set-Cookie')||res.headers?.['Set-Cookie'];
  res.setHeader('Set-Cookie',[...(Array.isArray(existing)?existing:existing?[existing]:[]),value]);
}

function seal(config,purpose,data,seconds,now) {
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',config.key,iv);
  cipher.setAAD(Buffer.from(`${purpose}:${config.clientId}:${config.origin}`));
  const payload=JSON.stringify({issuedAt:now,expiresAt:now+seconds*1000,data});
  const encrypted=Buffer.concat([cipher.update(payload,'utf8'),cipher.final()]);
  const value=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
  if(value.length>3700) throw new HttpError(502,'Gemini returned an unsupported session. Please reconnect.');
  return value;
}

function unseal(config,purpose,value,maxSeconds,now) {
  try {
    if(typeof value!=='string'||value.length>3700||!/^[-_A-Za-z0-9]+$/.test(value)) return null;
    const bytes=Buffer.from(value,'base64url');
    if(bytes.length<29||bytes.toString('base64url')!==value) return null;
    const decipher=createDecipheriv('aes-256-gcm',config.key,bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(`${purpose}:${config.clientId}:${config.origin}`));
    decipher.setAuthTag(bytes.subarray(12,28));
    const payload=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
    if(!Number.isFinite(payload.issuedAt)||!Number.isFinite(payload.expiresAt)||payload.issuedAt>now||payload.expiresAt<=now||payload.expiresAt-payload.issuedAt>maxSeconds*1000||payload.expiresAt<=payload.issuedAt) return null;
    return payload.data;
  } catch {return null;}
}

export function createGeminiAccount({env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}) {
  const config=()=>configuration(env);
  function needConfig() {const value=config();if(!value) throw new HttpError(503,SETUP_MESSAGE);return value;}

  function getSession(req) {
    const c=config();
    if(!c) return null;
    const session=unseal(c,'session',readCookie(req,c.sessionCookie),SESSION_SECONDS,now());
    if(!session||typeof session.accessToken!=='string'||!session.accessToken||typeof session.csrfToken!=='string'||typeof session.id!=='string'||!Number.isFinite(session.expiresAt)||session.expiresAt<=now()) return null;
    return session;
  }

  function requireMutation(req,body) {
    const c=needConfig();
    if(req.method!=='POST') throw new HttpError(405,'Use POST for this endpoint.');
    if(req.headers?.origin!==c.origin) throw new HttpError(403,'Open Pocket Quant directly before making this request.');
    const session=getSession(req);
    if(!session) throw new HttpError(401,'Connect your Gemini sandbox account again.');
    if(!equal(body?.csrfToken,session.csrfToken)) throw new HttpError(403,'Refresh the page before trying again.');
    return session;
  }

  async function sandboxRequest(session,path,{method='GET',body}={}) {
    if(!session?.accessToken||!Number.isFinite(session.expiresAt)||session.expiresAt<=now()) throw new HttpError(401,'Connect your Gemini sandbox account again.');
    if(typeof path!=='string'||!/^\/v1\/prediction-markets\/[a-z0-9/-]+(?:\?[a-zA-Z0-9_=&%.-]*)?$/.test(path)||path.includes('//')||!['GET','POST'].includes(method)) throw new HttpError(400,'Unsupported sandbox request.');
    const url=new URL(path,SANDBOX_API);
    if(url.origin!==SANDBOX_API||!url.pathname.startsWith('/v1/prediction-markets/')) throw new HttpError(400,'Unsupported sandbox request.');
    const payload={...(body||{}),request:url.pathname};
    const headers={Authorization:`Bearer ${session.accessToken}`,'X-GEMINI-PAYLOAD':Buffer.from(JSON.stringify(payload)).toString('base64'),'Cache-Control':'no-cache'};
    const options={method,headers,redirect:'error',signal:AbortSignal.timeout(15000)};
    // Gemini private REST parameters live in X-GEMINI-PAYLOAD; the HTTP body stays empty.
    if(method==='POST') {headers['Content-Type']='text/plain';options.body='';}
    try {
      const response=await fetchImpl(url.href,options);
      if(!response.ok) {
        if(response.status===401) throw new HttpError(401,'Your Gemini sandbox session expired. Connect again.');
        if(response.status===403) throw new HttpError(403,'Gemini sandbox did not allow this request. Check prediction-market access and app permissions.');
        if(response.status===429) throw new HttpError(429,'Gemini sandbox is receiving too many requests. Please wait and try again.');
        throw new HttpError(response.status>=400&&response.status<500?422:502,'Gemini sandbox could not complete this request. Check your order and account, then try again.');
      }
      return await response.json();
    } catch(error) {
      if(error instanceof HttpError) throw error;
      throw new HttpError(502,'Gemini sandbox is unavailable. Please try again.');
    }
  }

  function redirect(res,path) {res.statusCode=303;res.setHeader('Location',path);res.end();}
  function clearCookie(res,c,name) {appendCookie(res,cookie(name,'',0,c.secure));}

  async function connect(req,res) {
    const c=needConfig();
    if(req.headers?.origin&&req.headers.origin!==c.origin) throw new HttpError(403,'Open Pocket Quant directly to connect.');
    const state=randomBytes(32).toString('base64url');
    const verifier=randomBytes(48).toString('base64url');
    const target=new URL('/auth',SANDBOX_EXCHANGE);
    target.search=new URLSearchParams({client_id:c.clientId,response_type:'code',redirect_uri:c.redirectUri,state,scope:SCOPES,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
    appendCookie(res,cookie(c.flowCookie,seal(c,'flow',{state,verifier},FLOW_SECONDS,now()),FLOW_SECONDS,c.secure));
    redirect(res,target.href);
  }

  async function callback(req,res,url) {
    const c=config();
    if(!c) return redirect(res,'/trade.html?connection=error');
    const flow=unseal(c,'flow',readCookie(req,c.flowCookie),FLOW_SECONDS,now());
    clearCookie(res,c,c.flowCookie);
    try {
      if(url.searchParams.has('error')||!flow||!equal(url.searchParams.get('state'),flow.state)) throw new Error('OAuth state rejected');
      const code=url.searchParams.get('code');
      if(!code||code.length>2048||url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length!==1) throw new Error('OAuth code rejected');
      const response=await fetchImpl(`${SANDBOX_EXCHANGE}/auth/token`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:c.clientId,client_secret:c.clientSecret,code,redirect_uri:c.redirectUri,grant_type:'authorization_code',code_verifier:flow.verifier})});
      if(!response.ok) throw new Error('OAuth exchange rejected');
      const token=await response.json();
      const scopes=typeof token.scope==='string'?token.scope.split(/[ ,]+/):[];
      if(typeof token.access_token!=='string'||!token.access_token||token.access_token.length>2400||token.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(token.expires_in)||token.expires_in<1||!SCOPES.split(',').every(scope=>scopes.includes(scope))) throw new Error('OAuth token rejected');
      const lifetime=Math.min(SESSION_SECONDS,Math.floor(token.expires_in));
      const timestamp=now();
      const session={accessToken:token.access_token,csrfToken:randomBytes(32).toString('base64url'),id:randomBytes(24).toString('base64url'),expiresAt:timestamp+lifetime*1000};
      appendCookie(res,cookie(c.sessionCookie,seal(c,'session',session,lifetime,timestamp),lifetime,c.secure));
      // Refresh tokens are intentionally discarded. Reconnection is required after one hour.
      redirect(res,'/trade.html?connection=success');
    } catch {redirect(res,'/trade.html?connection=error');}
  }

  async function disconnect(req,res,body) {
    const session=requireMutation(req,body);
    const c=needConfig();
    clearCookie(res,c,c.sessionCookie);
    clearCookie(res,c,c.flowCookie);
    // Clear locally even when the provider's revocation endpoint is temporarily unavailable.
    try {await fetchImpl(`${SANDBOX_EXCHANGE}/auth/token/revoke`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json'},body:JSON.stringify({token:session.accessToken,client_id:c.clientId,client_secret:c.clientSecret})});} catch {}
    send(res,200,{sandbox:true,configured:true,connected:false});
  }

  async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    try {
      const url=new URL(req.url||'/api/gemini-account','http://localhost');
      const action=url.searchParams.get('action')||'status';
      if(!['status','connect','callback','disconnect'].includes(action)) throw new HttpError(404,'Unknown account action.');
      const method=action==='disconnect'?'POST':'GET';
      if(req.method!==method) {res.setHeader('Allow',method);throw new HttpError(405,`Use ${method} for this endpoint.`);}
      if(action==='status') {
        const c=config();const session=getSession(req);
        return send(res,200,{sandbox:true,configured:!!c,connected:!!session,...(session?{csrfToken:session.csrfToken}:{}),...(!c?{message:SETUP_MESSAGE}:{})});
      }
      if(action==='connect') return await connect(req,res);
      if(action==='callback') return await callback(req,res,url);
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||'')) throw new HttpError(415,'Send a JSON request.');
      let body;
      try {body=JSON.parse((await rawBody(req,4000)).toString());} catch(error) {throw new HttpError(error.status===413?413:400,'Send a valid JSON request.');}
      return await disconnect(req,res,body);
    } catch(error) {
      send(res,error instanceof HttpError?error.status:500,{sandbox:true,error:error instanceof HttpError?error.message:'The sandbox connection could not finish. Please try again.'});
    }
  }

  return {handler,getSession,requireMutation,sandboxRequest};
}

const account=createGeminiAccount();
export const getSession=account.getSession;
export const requireMutation=account.requireMutation;
export const sandboxRequest=account.sandboxRequest;
