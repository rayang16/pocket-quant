import {createCipheriv,createDecipheriv,createHash,randomBytes as cryptoRandomBytes,timingSafeEqual} from 'node:crypto';

const SESSION_SECONDS=15*60;
const SETUP_MESSAGE='The private account dashboard is not configured.';
const PURPOSE='pocket-quant:live-owner:v1';

export class LiveOwnerAuthError extends Error {
  constructor(status,message) {super(message);this.name='LiveOwnerAuthError';this.status=status;}
}

function configuration(env) {
  const hash=env.GEMINI_LIVE_OWNER_CODE_HASH;
  const secret=env.GEMINI_LIVE_SESSION_SECRET;
  const origin=env.GEMINI_LIVE_APP_ORIGIN;
  if(typeof hash!=='string'||! /^[a-fA-F0-9]{64}$/.test(hash)||typeof secret!=='string'||secret.length<32||typeof origin!=='string') return null;
  try {
    const url=new URL(origin);
    const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.origin!==origin||url.username||url.password||url.search||url.hash||url.pathname!=='/') return null;
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback&&env.NODE_ENV==='development')) return null;
    const secure=url.protocol==='https:';
    return {origin,secure,hash:Buffer.from(hash,'hex'),
      key:createHash('sha256').update(`${PURPOSE}\0`).update(secret).digest(),
      aad:Buffer.from(`${PURPOSE}\0${origin}\0${hash.toLowerCase()}`),
      cookieName:secure?'__Host-pq_gemini_live_owner':'pq_gemini_live_owner'};
  } catch {return null;}
}

function validToken(value) {
  return typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)&&Buffer.from(value,'base64url').toString('base64url')===value;
}

function equalToken(left,right) {
  const valid=validToken(left)&&validToken(right);
  const a=valid?Buffer.from(left,'base64url'):Buffer.alloc(32);
  const b=valid?Buffer.from(right,'base64url'):Buffer.alloc(32);
  return timingSafeEqual(a,b)&&valid;
}

function readCookie(req,name) {
  const source=req?.headers?.cookie;
  if(typeof source!=='string'||source.length>16000) return null;
  const values=source.split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
  return values.length===1?values[0].slice(name.length+1):null;
}

function writeCookie(res,config,value,seconds) {
  const existing=res.getHeader?.('Set-Cookie')||res.headers?.['Set-Cookie'];
  const cookie=`${config.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${config.secure?'; Secure':''}`;
  res.setHeader('Set-Cookie',[...(Array.isArray(existing)?existing:existing?[existing]:[]),cookie]);
}

function requireOrigin(req,config) {
  if(req?.method!=='POST') throw new LiveOwnerAuthError(405,'Use POST for this endpoint.');
  const site=req.headers?.['sec-fetch-site'];
  if(req.headers?.origin!==config.origin||(site!==undefined&&!['same-origin','none'].includes(site))) throw new LiveOwnerAuthError(403,'Open the private account dashboard directly before trying again.');
}

export function createLiveOwnerAuth({env=process.env,now=Date.now,randomBytes=cryptoRandomBytes}={}) {
  const config=()=>configuration(env);
  function needConfig() {const c=config();if(!c) throw new LiveOwnerAuthError(503,SETUP_MESSAGE);return c;}
  function random(size) {
    const bytes=randomBytes(size);
    if(!Buffer.isBuffer(bytes)||bytes.length!==size) throw new Error('Invalid random source.');
    return bytes;
  }

  function getSession(req) {
    const c=config();
    if(!c) return null;
    try {
      const value=readCookie(req,c.cookieName);
      if(typeof value!=='string'||value.length>2000||! /^[A-Za-z0-9_-]+$/.test(value)) return null;
      const bytes=Buffer.from(value,'base64url');
      if(bytes.length<29||bytes.toString('base64url')!==value) return null;
      const decipher=createDecipheriv('aes-256-gcm',c.key,bytes.subarray(0,12));
      decipher.setAAD(c.aad);
      decipher.setAuthTag(bytes.subarray(12,28));
      const session=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
      const timestamp=now();
      if(!session||!validToken(session.id)||!validToken(session.csrfToken)||!Number.isSafeInteger(timestamp)||!Number.isSafeInteger(session.issuedAt)||!Number.isSafeInteger(session.expiresAt)||session.issuedAt>timestamp||session.issuedAt<0||session.expiresAt<=timestamp||session.expiresAt-session.issuedAt!==SESSION_SECONDS*1000) return null;
      return {id:session.id,csrfToken:session.csrfToken,issuedAt:session.issuedAt,expiresAt:session.expiresAt};
    } catch {return null;}
  }

  // The caller owns JSON responses and cache headers. This helper only manages authentication.
  function login(req,res,code) {
    const c=needConfig();
    requireOrigin(req,c);
    const valid=validToken(code);
    const candidate=createHash('sha256').update(valid?code:'').digest();
    const matches=timingSafeEqual(candidate,c.hash);
    if(!matches||!valid) throw new LiveOwnerAuthError(401,'The owner access code is incorrect.');
    try {
      const timestamp=now();
      if(!Number.isSafeInteger(timestamp)||timestamp<0) throw new Error('Invalid clock.');
      const session={id:random(32).toString('base64url'),csrfToken:random(32).toString('base64url'),issuedAt:timestamp,expiresAt:timestamp+SESSION_SECONDS*1000};
      const iv=random(12);
      const cipher=createCipheriv('aes-256-gcm',c.key,iv);
      cipher.setAAD(c.aad);
      const encrypted=Buffer.concat([cipher.update(JSON.stringify(session),'utf8'),cipher.final()]);
      writeCookie(res,c,Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url'),SESSION_SECONDS);
      return session;
    } catch {throw new LiveOwnerAuthError(503,'The private account session could not be created. Please try again.');}
  }

  function requireMutation(req,session=getSession(req)) {
    const c=needConfig();
    requireOrigin(req,c);
    const authenticated=getSession(req);
    if(!authenticated||!session||!equalToken(session.id,authenticated.id)||!equalToken(session.csrfToken,authenticated.csrfToken)||session.expiresAt!==authenticated.expiresAt) throw new LiveOwnerAuthError(401,'Unlock the private account dashboard again.');
    if(!equalToken(req.headers?.['x-csrf-token'],authenticated.csrfToken)) throw new LiveOwnerAuthError(403,'Refresh the private account dashboard before trying again.');
    return authenticated;
  }

  function logout(req,res) {
    requireMutation(req);
    writeCookie(res,needConfig(),'',0);
  }

  return {get configured(){return !!config();},login,logout,getSession,requireMutation};
}
