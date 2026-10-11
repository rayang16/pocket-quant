import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createLiveOwnerAuth,LiveOwnerAuthError} from '../lib/live-owner-auth.js';

// These generated values are test fixtures only and never read from local credentials.
const code=Buffer.alloc(32,21).toString('base64url');
const env={GEMINI_LIVE_OWNER_CODE_HASH:createHash('sha256').update(code).digest('hex'),GEMINI_LIVE_SESSION_SECRET:'fake-owner-session-secret-for-tests-only',GEMINI_LIVE_APP_ORIGIN:'https://pocket.example'};
function response() {return {headers:{},setHeader(name,value){this.headers[name]=value;},getHeader(name){return this.headers[name];},end(){throw new Error('Auth helper must not end the response.');}};}
function request(headers={},method='POST') {return {method,headers:{origin:env.GEMINI_LIVE_APP_ORIGIN,...headers}};}
function login(auth,origin=env.GEMINI_LIVE_APP_ORIGIN) {
  const res=response(),session=auth.login(request({origin}),res,code);
  const cookie=res.headers['Set-Cookie'].at(-1).split(';')[0];
  return {res,session,cookie,req:request({origin,cookie,'x-csrf-token':session.csrfToken})};
}
function fails(fn,status) {assert.throws(fn,error=>error instanceof LiveOwnerAuthError&&error.status===status);}

test('owner login creates an encrypted fifteen-minute Strict cookie distinct from sandbox',()=>{
  const auth=createLiveOwnerAuth({env,now:()=>1000});
  assert.equal(auth.configured,true);
  const signed=login(auth);
  assert.deepEqual(auth.getSession(signed.req),signed.session);
  assert.equal(signed.session.issuedAt,1000);
  assert.equal(signed.session.expiresAt,901000);
  assert.match(signed.res.headers['Set-Cookie'][0],/^__Host-pq_gemini_live_owner=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=900; Secure$/);
  for(const secret of [code,env.GEMINI_LIVE_OWNER_CODE_HASH,env.GEMINI_LIVE_SESSION_SECRET,signed.session.csrfToken,signed.session.id]) assert.equal(signed.cookie.includes(secret),false);
  assert.equal(signed.cookie.includes('pq_gemini_sandbox='),false);
  assert.equal(auth.getSession({headers:{cookie:signed.cookie.replace('__Host-pq_gemini_live_owner=','__Host-pq_gemini_sandbox=')}}),null);
  assert.equal(signed.res.statusCode,undefined);
});

test('wrong, noncanonical and malformed owner codes fail safely without setting cookies',()=>{
  const auth=createLiveOwnerAuth({env});
  for(const bad of [randomBytes(32).toString('base64url'),undefined,null,123,{},[],Buffer.from(code),'',code+'=',code.slice(1),'x'.repeat(100000),code.slice(0,-1)+'V']) {
    const res=response();
    fails(()=>auth.login(request(),res,bad),401);
    assert.equal(res.headers['Set-Cookie'],undefined);
  }
  // The comparison is still against the full hash even if a hash of malformed input is configured.
  const malformed=createLiveOwnerAuth({env:{...env,GEMINI_LIVE_OWNER_CODE_HASH:createHash('sha256').update('').digest('hex')}});
  fails(()=>malformed.login(request(),response(),''),401);
});

test('login requires POST and exact Origin and rejects cross-site fetch metadata',()=>{
  const auth=createLiveOwnerAuth({env});
  for(const origin of [undefined,null,[],['https://pocket.example'],'null','https://pocket.example/','https://pocket.example.evil.example','http://pocket.example','https://pocket.example:444']) fails(()=>auth.login(request({origin}),response(),code),403);
  for(const method of ['GET','OPTIONS','PUT','post',undefined]) fails(()=>auth.login({...request(),method},response(),code),405);
  for(const site of ['cross-site','same-site',[], 'invalid']) fails(()=>auth.login(request({'sec-fetch-site':site}),response(),code),403);
  for(const site of [undefined,'same-origin','none']) assert.ok(auth.login(request({'sec-fetch-site':site}),response(),code).id);
});

test('missing or invalid configuration never enables authentication and does not leak configuration',()=>{
  const invalid=[{},...Object.keys(env).map(key=>({...env,[key]:undefined})),
    {...env,GEMINI_LIVE_OWNER_CODE_HASH:'x'.repeat(64)},
    {...env,GEMINI_LIVE_OWNER_CODE_HASH:'ab'},
    {...env,GEMINI_LIVE_SESSION_SECRET:'x'.repeat(31)},
    ...['http://pocket.example','http://localhost:3000','https://pocket.example/','https://pocket.example/path','https://pocket.example?x=y','https://pocket.example#hash','https://user:pass@pocket.example','not a URL'].map(origin=>({...env,GEMINI_LIVE_APP_ORIGIN:origin}))];
  for(const fixture of invalid) {
    const auth=createLiveOwnerAuth({env:fixture});
    assert.equal(auth.configured,false);
    assert.equal(auth.getSession(request()),null);
    for(const fn of [()=>auth.login(request(),response(),code),()=>auth.logout(request(),response()),()=>auth.requireMutation(request())]) {
      assert.throws(fn,error=>error.status===503&&error.message==='The private account dashboard is not configured.');
    }
  }
});

test('only explicit localhost development uses a non-Secure cookie',()=>{
  for(const origin of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000']) {
    const auth=createLiveOwnerAuth({env:{...env,NODE_ENV:'development',GEMINI_LIVE_APP_ORIGIN:origin}});
    assert.equal(auth.configured,true);
    const signed=login(auth,origin);
    assert.match(signed.res.headers['Set-Cookie'][0],/^pq_gemini_live_owner=.*; SameSite=Strict; Max-Age=900$/);
    assert.equal(signed.res.headers['Set-Cookie'][0].includes('; Secure'),false);
    assert.ok(auth.getSession(signed.req));
    for(const NODE_ENV of [undefined,'test','production']) assert.equal(createLiveOwnerAuth({env:{...env,NODE_ENV,GEMINI_LIVE_APP_ORIGIN:origin}}).configured,false);
  }
  assert.equal(createLiveOwnerAuth({env:{...env,NODE_ENV:'development',GEMINI_LIVE_APP_ORIGIN:'http://localhost.evil.example'}}).configured,false);
  const secure=createLiveOwnerAuth({env:{...env,NODE_ENV:'development',GEMINI_LIVE_APP_ORIGIN:'https://localhost'}});
  assert.match(login(secure,'https://localhost').res.headers['Set-Cookie'][0],/; Secure$/);
});

test('tampered, duplicate, malformed, future and expired cookies fail closed',()=>{
  let clock=1000000;
  const auth=createLiveOwnerAuth({env,now:()=>clock});
  const {cookie,session}=login(auth);
  const separator=cookie.indexOf('='),value=cookie.slice(separator+1);
  const bytes=Buffer.from(value,'base64url');bytes[bytes.length-1]^=1;
  for(const source of [undefined,[],{},'',`${cookie}; ${cookie}`,cookie.slice(0,separator+1)+bytes.toString('base64url'),cookie+'=',cookie.slice(0,separator+1)+'abc',cookie.slice(0,separator+1)+'!invalid','x'.repeat(16001)]) assert.equal(auth.getSession({headers:{cookie:source}}),null);
  assert.equal(auth.getSession(),null);
  clock=session.issuedAt-1;assert.equal(auth.getSession({headers:{cookie}}),null);
  clock=session.expiresAt-1;assert.ok(auth.getSession({headers:{cookie}}));
  clock=session.expiresAt;assert.equal(auth.getSession({headers:{cookie}}),null);
});

test('secret, owner-code hash and app-origin rotation invalidate previous sessions',()=>{
  const signed=login(createLiveOwnerAuth({env}));
  for(const patch of [
    {GEMINI_LIVE_SESSION_SECRET:'another-fake-secret-with-at-least-32-characters'},
    {GEMINI_LIVE_OWNER_CODE_HASH:createHash('sha256').update('different-owner-code').digest('hex')},
    {GEMINI_LIVE_APP_ORIGIN:'https://different.example'},
  ]) assert.equal(createLiveOwnerAuth({env:{...env,...patch}}).getSession(signed.req),null);
});

test('mutations require authenticated cookie, matching session, exact origin and header CSRF',()=>{
  const auth=createLiveOwnerAuth({env}),signed=login(auth);
  assert.deepEqual(auth.requireMutation(signed.req,signed.session),signed.session);
  assert.deepEqual(auth.requireMutation(signed.req),signed.session);
  for(const csrf of [undefined,null,[],{},'',123,'x'.repeat(43),signed.session.csrfToken+'=']) fails(()=>auth.requireMutation({...signed.req,headers:{...signed.req.headers,'x-csrf-token':csrf}},signed.session),403);
  fails(()=>auth.requireMutation({...signed.req,method:'GET'},signed.session),405);
  fails(()=>auth.requireMutation({...signed.req,headers:{...signed.req.headers,origin:'https://evil.example'}},signed.session),403);
  fails(()=>auth.requireMutation({...signed.req,headers:{...signed.req.headers,'sec-fetch-site':'cross-site'}},signed.session),403);
  fails(()=>auth.requireMutation({...signed.req,headers:{...signed.req.headers,cookie:undefined}},signed.session),401);
  for(const session of [null,{}, {...signed.session,id:randomBytes(32).toString('base64url')},{...signed.session,expiresAt:signed.session.expiresAt+1}]) fails(()=>auth.requireMutation(signed.req,session),401);
  const other=login(auth);
  fails(()=>auth.requireMutation(signed.req,other.session),401);
});

test('logout validates POST, origin and CSRF before clearing only the owner cookie',()=>{
  const auth=createLiveOwnerAuth({env}),signed=login(auth);
  for(const patch of [{method:'GET'},{headers:{...signed.req.headers,origin:'https://evil.example'}},{headers:{...signed.req.headers,'x-csrf-token':undefined}}]) {
    const res=response();assert.throws(()=>auth.logout({...signed.req,...patch},res),LiveOwnerAuthError);assert.equal(res.headers['Set-Cookie'],undefined);
  }
  const res=response();res.setHeader('Set-Cookie','unrelated=value; Path=/');
  assert.equal(auth.logout(signed.req,res),undefined);
  assert.deepEqual(res.headers['Set-Cookie'],['unrelated=value; Path=/','__Host-pq_gemini_live_owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure']);
  assert.equal(res.statusCode,undefined);
});

test('cryptographic failures produce generic errors without leaking injected error details',()=>{
  const auth=createLiveOwnerAuth({env,randomBytes:()=>{throw new Error('SECRET_RANDOM_PROVIDER_DETAIL');}});
  const res=response();
  assert.throws(()=>auth.login(request(),res,code),error=>error instanceof LiveOwnerAuthError&&error.status===503&&!error.message.includes('SECRET_RANDOM_PROVIDER_DETAIL'));
  assert.equal(res.headers['Set-Cookie'],undefined);
});
