import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGeminiAccount,HttpError} from '../lib/gemini-account.js';
import {createHandler} from '../api/gemini-account.js';

const env={GEMINI_SANDBOX_CLIENT_ID:'sandbox-test-client',GEMINI_SANDBOX_CLIENT_SECRET:'not-a-real-client-secret',GEMINI_SESSION_SECRET:'this-is-an-explicitly-fake-32-byte-test-secret',GEMINI_REDIRECT_URI:'https://pocket.example/api/gemini-account?action=callback'};
const token={access_token:'not-a-real-access-token',refresh_token:'not-a-real-refresh-token',token_type:'bearer',expires_in:86400,scope:'orders:read,orders:create'};
function response() {return {headers:{},setHeader(name,value){this.headers[name]=value;},getHeader(name){return this.headers[name];},end(body){this.body=body;}};}
function request(action,{method='GET',headers={},body}={}) {return {url:`/api/gemini-account?action=${action}`,method,headers,body};}
function cookies(res) {return (res.headers['Set-Cookie']||[]).map(value=>value.split(';')[0]).join('; ');}
async function start(account) {
  const res=response();await account.handler(request('connect'),res);
  assert.equal(res.statusCode,303);
  return {cookie:cookies(res),auth:new URL(res.headers.Location),res};
}
async function login(account) {
  const flow=await start(account);
  const req=request(`callback&state=${flow.auth.searchParams.get('state')}&code=test-code`,{headers:{cookie:flow.cookie}});
  const res=response();await account.handler(req,res);
  assert.equal(res.headers.Location,'/trade.html?connection=success');
  const cookie=cookies(res);
  return {cookie,session:account.getSession({headers:{cookie}}),res};
}

test('unconfigured sandbox status is useful and never starts OAuth',async()=>{
  const account=createGeminiAccount({env:{},fetchImpl:()=>{throw new Error('unexpected request');}});
  const res=response();await createHandler({account})(request('status'),res);
  assert.equal(res.statusCode,200);
  assert.deepEqual(JSON.parse(res.body),{sandbox:true,configured:false,connected:false,message:'Gemini sandbox connection needs app credentials. Ask your team to finish the sandbox setup.'});
  assert.equal(res.headers['Cache-Control'],'no-store');
  assert.equal(res.headers['Access-Control-Allow-Origin'],undefined);
  const connect=response();await account.handler(request('connect'),connect);
  assert.equal(connect.statusCode,503);
  assert.equal(connect.headers.Location,undefined);
});

test('invalid origin, production Gemini callback, callback query and weak secret disable setup',async()=>{
  for(const patch of [
    {GEMINI_REDIRECT_URI:'http://pocket.example/api/gemini-account?action=callback'},
    {GEMINI_REDIRECT_URI:'https://exchange.gemini.com/api/gemini-account?action=callback'},
    {GEMINI_REDIRECT_URI:'https://api.gemini.com/api/gemini-account?action=callback'},
    {GEMINI_REDIRECT_URI:'https://pocket.example/api/gemini-account?action=callback&next=https://evil.example'},
    {GEMINI_REDIRECT_URI:'https://user:pass@pocket.example/api/gemini-account?action=callback'},
    {GEMINI_REDIRECT_URI:'https://pocket.example/callback'},
    {GEMINI_SESSION_SECRET:'too-short'},
  ]) {
    const account=createGeminiAccount({env:{...env,...patch}});const res=response();await account.handler(request('status'),res);
    assert.equal(JSON.parse(res.body).configured,false);
  }
});

test('authorization requests are sandbox-only with state, PKCE and protected flow cookie',async()=>{
  const account=createGeminiAccount({env});const flow=await start(account);
  assert.equal(flow.auth.origin,'https://exchange.sandbox.gemini.com');
  assert.equal(flow.auth.pathname,'/auth');
  assert.equal(flow.auth.searchParams.get('redirect_uri'),env.GEMINI_REDIRECT_URI);
  assert.equal(flow.auth.searchParams.get('scope'),'orders:read,orders:create');
  assert.equal(flow.auth.searchParams.get('code_challenge_method'),'S256');
  assert.equal(flow.auth.searchParams.get('code_challenge').length,43);
  assert.ok(flow.auth.searchParams.get('state').length>=43);
  assert.equal(flow.auth.searchParams.has('client_secret'),false);
  const cookie=flow.res.headers['Set-Cookie'][0];
  assert.match(cookie,/^__Host-pq_gemini_flow=/);
  assert.match(cookie,/HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.equal(cookie.includes(flow.auth.searchParams.get('state')),false);
  const denied=response();await account.handler(request('connect',{headers:{origin:'https://evil.example'}}),denied);
  assert.equal(denied.statusCode,403);
});

test('callback exchanges the bound PKCE code and stores only an encrypted one-hour session',async()=>{
  const calls=[];const fixedNow=1230000;
  const account=createGeminiAccount({env,now:()=>fixedNow,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>token};}});
  const flow=await start(account);const res=response();
  await account.handler(request(`callback&state=${flow.auth.searchParams.get('state')}&code=test-code`,{headers:{cookie:flow.cookie}}),res);
  assert.equal(res.headers.Location,'/trade.html?connection=success');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://exchange.sandbox.gemini.com/auth/token');
  assert.equal(calls[0].options.redirect,'error');
  const exchange=JSON.parse(calls[0].options.body);
  assert.equal(exchange.client_secret,env.GEMINI_SANDBOX_CLIENT_SECRET);
  assert.equal(exchange.redirect_uri,env.GEMINI_REDIRECT_URI);
  assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'),flow.auth.searchParams.get('code_challenge'));
  const serialized=JSON.stringify(res.headers);
  assert.equal(serialized.includes(token.access_token),false);assert.equal(serialized.includes(token.refresh_token),false);
  assert.match(serialized,/Max-Age=3600/);
  const req={headers:{cookie:cookies(res)}};const session=account.getSession(req);
  assert.equal(session.accessToken,token.access_token);assert.equal(session.expiresAt,fixedNow+3600000);
  assert.equal(session.refreshToken,undefined);
  assert.ok(session.id);assert.ok(session.csrfToken);
  const status=response();await account.handler(request('status',{headers:req.headers}),status);
  assert.deepEqual(JSON.parse(status.body),{sandbox:true,configured:true,connected:true,csrfToken:session.csrfToken});
  assert.equal(status.body.includes(token.access_token),false);
});

test('tampered, expired, duplicate and differently keyed cookies never authenticate',async()=>{
  let clock=500000;const options={env,now:()=>clock,fetchImpl:async()=>({ok:true,json:async()=>token})};
  const account=createGeminiAccount(options);const signed=await login(account);
  const sessionCookie=signed.cookie.split('; ').find(value=>value.startsWith('__Host-pq_gemini_sandbox='));
  const separator=sessionCookie.indexOf('=');
  const position=separator+12;
  const tampered=sessionCookie.slice(0,position)+(sessionCookie[position]==='A'?'B':'A')+sessionCookie.slice(position+1);
  assert.equal(account.getSession({headers:{cookie:tampered}}),null);
  assert.equal(account.getSession({headers:{cookie:`${sessionCookie}; ${sessionCookie}`}}),null);
  const changed=createGeminiAccount({...options,env:{...env,GEMINI_SESSION_SECRET:'a-different-secret-that-is-at-least-32-bytes-long'}});
  assert.equal(changed.getSession({headers:{cookie:signed.cookie}}),null);
  clock+=3600000;
  assert.equal(account.getSession({headers:{cookie:signed.cookie}}),null);
});

test('OAuth state failures, provider errors and expired flows fail closed without exposing details',async()=>{
  let clock=1230000,requests=0;
  const account=createGeminiAccount({env,now:()=>clock,fetchImpl:async()=>{requests++;throw new Error('SECRET_PROVIDER_DETAIL');}});
  const flow=await start(account);
  for(const query of ['callback&state=wrong&code=x',`callback&state=${flow.auth.searchParams.get('state')}&error=SECRET_PROVIDER_DETAIL`,`callback&state=${flow.auth.searchParams.get('state')}&code=x&code=y`]) {
    const res=response();await account.handler(request(query,{headers:{cookie:flow.cookie}}),res);
    assert.equal(res.headers.Location,'/trade.html?connection=error');
    assert.match(res.headers['Set-Cookie'][0],/Max-Age=0/);
    assert.equal(JSON.stringify(res).includes('SECRET_PROVIDER_DETAIL'),false);
  }
  assert.equal(requests,0);
  const failed=response();await account.handler(request(`callback&state=${flow.auth.searchParams.get('state')}&code=x`,{headers:{cookie:flow.cookie}}),failed);
  assert.equal(requests,1);assert.equal(failed.headers.Location,'/trade.html?connection=error');
  clock+=600000;
  const expired=response();await account.handler(request(`callback&state=${flow.auth.searchParams.get('state')}&code=x`,{headers:{cookie:flow.cookie}}),expired);
  assert.equal(requests,1);assert.equal(expired.headers.Location,'/trade.html?connection=error');
});

test('missing trade permission and invalid provider token lifetime do not establish a session',async()=>{
  for(const patch of [{scope:'orders:read'},{expires_in:0},{expires_in:'3600'},{access_token:''},{token_type:'other'}]) {
    const account=createGeminiAccount({env,fetchImpl:async()=>({ok:true,json:async()=>({...token,...patch})})});
    const flow=await start(account);const res=response();
    await account.handler(request(`callback&state=${flow.auth.searchParams.get('state')}&code=x`,{headers:{cookie:flow.cookie}}),res);
    assert.equal(res.headers.Location,'/trade.html?connection=error');
    assert.equal(account.getSession({headers:{cookie:cookies(res)}}),null);
  }
});

test('mutations require exact origin, POST, valid session and timing-safe CSRF token match',async()=>{
  const account=createGeminiAccount({env,fetchImpl:async()=>({ok:true,json:async()=>token})});const signed=await login(account);
  const req=request('disconnect',{method:'POST',headers:{origin:'https://pocket.example',cookie:signed.cookie}});
  assert.equal(account.requireMutation(req,{csrfToken:signed.session.csrfToken}).id,signed.session.id);
  for(const origin of [undefined,'null','https://pocket.example.evil.example','http://pocket.example']) {
    assert.throws(()=>account.requireMutation({...req,headers:{...req.headers,origin}},{csrfToken:signed.session.csrfToken}),error=>error instanceof HttpError&&error.status===403);
  }
  for(const csrfToken of [undefined,'',123,'x'.repeat(signed.session.csrfToken.length)]) assert.throws(()=>account.requireMutation(req,{csrfToken}),error=>error.status===403);
  assert.throws(()=>account.requireMutation({...req,method:'GET'},{csrfToken:signed.session.csrfToken}),error=>error.status===405);
  assert.throws(()=>account.requireMutation({...req,headers:{origin:'https://pocket.example'}},{csrfToken:signed.session.csrfToken}),error=>error.status===401);
});

test('disconnect revokes at sandbox and clears both cookies even when revocation cannot connect',async()=>{
  const calls=[];const account=createGeminiAccount({env,fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/revoke'))throw new Error('offline');return {ok:true,json:async()=>token};}});
  const signed=await login(account);const res=response();
  await account.handler(request('disconnect',{method:'POST',headers:{origin:'https://pocket.example',cookie:signed.cookie,'content-type':'application/json'},body:{csrfToken:signed.session.csrfToken}}),res);
  assert.equal(res.statusCode,200);assert.equal(JSON.parse(res.body).connected,false);
  assert.equal(res.headers['Set-Cookie'].length,2);assert.ok(res.headers['Set-Cookie'].every(value=>value.includes('Max-Age=0')));
  assert.equal(calls.at(-1).url,'https://exchange.sandbox.gemini.com/auth/token/revoke');
  assert.equal(JSON.parse(calls.at(-1).options.body).token,token.access_token);
});

test('HTTP loopback works for development without weakening deployed cookie security',async()=>{
  for(const origin of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000']) {
    const account=createGeminiAccount({env:{...env,GEMINI_REDIRECT_URI:`${origin}/api/gemini-account?action=callback`}});
    const flow=await start(account);const cookie=flow.res.headers['Set-Cookie'][0];
    assert.match(cookie,/^pq_gemini_flow=/);assert.equal(cookie.includes('; Secure'),false);assert.match(cookie,/HttpOnly; SameSite=Lax/);
  }
});

test('sandbox helper authenticates only fixed prediction API paths and never forwards redirects',async()=>{
  const calls=[];const account=createGeminiAccount({env,now:()=>1000,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({hasAcceptedLatest:true})};}});
  const session={accessToken:'fake-token',expiresAt:100000};
  const status=await account.sandboxRequest(session,'/v1/prediction-markets/terms/status');
  assert.equal(status.hasAcceptedLatest,true);assert.equal(calls[0].url,'https://api.sandbox.gemini.com/v1/prediction-markets/terms/status');
  assert.equal(calls[0].options.headers.Authorization,'Bearer fake-token');assert.equal(calls[0].options.redirect,'error');
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].options.headers['X-GEMINI-PAYLOAD'],'base64')),{request:'/v1/prediction-markets/terms/status'});
  const body={symbol:'TEST-CONTRACT',quantity:'1',price:'0.50',outcome:'yes',side:'buy',orderType:'limit'};
  await account.sandboxRequest(session,'/v1/prediction-markets/order',{method:'POST',body});
  assert.equal(calls[1].options.body,'');
  assert.deepEqual(JSON.parse(Buffer.from(calls[1].options.headers['X-GEMINI-PAYLOAD'],'base64')),{...body,request:'/v1/prediction-markets/order'});
  for(const path of ['https://api.gemini.com/v1/prediction-markets/order','//api.gemini.com/v1/prediction-markets/order','/v1/withdraw','/v1/prediction-markets/../../withdraw','/v1/prediction-markets/%2e%2e/withdraw','/v1/prediction-markets/\\evil']) await assert.rejects(account.sandboxRequest(session,path),error=>error.status===400);
  assert.equal(calls.length,2);
  await assert.rejects(account.sandboxRequest({...session,expiresAt:999},'/v1/prediction-markets/order'),error=>error.status===401);
});

test('provider errors are safely mapped and raw response contents never reach clients',async()=>{
  for(const [providerStatus,expected] of [[401,401],[403,403],[429,429],[400,422],[503,502]]) {
    const account=createGeminiAccount({env,now:()=>0,fetchImpl:async()=>({ok:false,status:providerStatus,json:async()=>({message:'PRIVATE_DETAILS'})})});
    await assert.rejects(account.sandboxRequest({accessToken:'fake',expiresAt:99999},'/v1/prediction-markets/order'),error=>error.status===expected&&!error.message.includes('PRIVATE_DETAILS'));
  }
});

test('route rejects unsafe method and malformed disconnect bodies before external calls',async()=>{
  const account=createGeminiAccount({env,fetchImpl:()=>{throw new Error('unexpected external call');}});
  for(const [req,status] of [
    [request('status',{method:'POST'}),405],
    [request('disconnect'),405],
    [request('missing'),404],
    [request('disconnect',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}),415],
    [request('disconnect',{method:'POST',headers:{'content-type':'application/json'},body:'{'}),400],
    [request('disconnect',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(5000)}),413],
  ]) {const res=response();await account.handler(req,res);assert.equal(res.statusCode,status);}
});
