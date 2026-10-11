import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createHandler,liveReadiness} from '../api/live-trade.js';
import {createLiveOwnerAuth} from '../lib/live-owner-auth.js';

const credentials={GEMINI_LIVE_CLIENT_ID:'example-id',GEMINI_LIVE_CLIENT_SECRET:'private-oauth-secret',
  UPSTASH_REDIS_REST_URL:'https://example.upstash.io',UPSTASH_REDIS_REST_TOKEN:'private-storage-secret'};
function response(){return {headers:{},setHeader(name,value){this.headers[name]=value;},end(body){this.body=JSON.parse(body);}};}

test('adding credentials never enables live orders or claims an account is connected',()=>{
  for(const env of [{},credentials,{GEMINI_LIVE_API_KEY:'personal-key',GEMINI_LIVE_API_SECRET:'personal-secret'},
    {...credentials,GEMINI_LIVE_API_KEY:'personal-key',GEMINI_LIVE_API_SECRET:'personal-secret'},
    {...credentials,GEMINI_LIVE_TRADING_ENABLED:'true',GEMINI_LIVE_APPROVED:'true'}]) {
    const state=liveReadiness(env);
    assert.equal(state.tradingEnabled,false);assert.equal(state.connected,false);assert.equal(state.budget,'5.00');
    assert.equal(state.requirements.find(item=>item.id==='account').ready,false);
    for(const secret of ['private-oauth-secret','private-storage-secret','personal-secret','personal-key'])assert.ok(!JSON.stringify(state).includes(secret));
  }
  assert.equal(liveReadiness(credentials).credentialMode,'oauth');
  assert.equal(liveReadiness({GEMINI_LIVE_API_KEY:'x',GEMINI_LIVE_API_SECRET:'y'}).credentialMode,'personal');
  assert.equal(liveReadiness({...credentials,GEMINI_LIVE_API_KEY:'x',GEMINI_LIVE_API_SECRET:'y'}).credentialMode,'pending');
});

test('malformed storage configuration cannot appear configured',()=>{
  for(const url of ['http://example.upstash.io','https://evil.example','https://example.upstash.io.evil.example','https://user:pass@example.upstash.io','https://example.upstash.io?token=secret','https://example.upstash.io/path','https://example.upstash.io:444']) {
    assert.equal(liveReadiness({...credentials,UPSTASH_REDIS_REST_URL:url}).requirements.find(item=>item.id==='storage').ready,false);
  }
});

test('public readiness exposes no secrets and trade attempts always fail closed',async()=>{
  const handler=createHandler({env:credentials});
  const status=response();await handler({method:'GET',url:'/api/live-trade?action=status'},status);
  assert.equal(status.statusCode,200);assert.equal(status.headers['Cache-Control'],'no-store');
  assert.equal(status.headers['Access-Control-Allow-Origin'],undefined);
  for(const action of ['preview','submit','connect','history']) {
    const res=response();await handler({method:'POST',url:`/api/live-trade?action=${action}`,body:{confirmed:true,price:'0.01',quantity:'1'}},res);
    assert.equal(res.statusCode,503);assert.equal(res.body.code,'LIVE_TRADING_NOT_READY');
  }
  const wrongMethod=response();await handler({method:'POST',url:'/api/live-trade?action=status'},wrongMethod);
  assert.equal(wrongMethod.statusCode,405);
});

function privateSetup(now=Date.now) {
  const code=randomBytes(32).toString('base64url');
  const env={GEMINI_LIVE_API_KEY:'master-example',GEMINI_LIVE_API_SECRET:'private-gemini-secret',
    GEMINI_LIVE_OWNER_CODE_HASH:createHash('sha256').update(code).digest('hex'),
    GEMINI_LIVE_SESSION_SECRET:randomBytes(32).toString('base64url'),GEMINI_LIVE_APP_ORIGIN:'https://pocket.example'};
  const auth=createLiveOwnerAuth({env,now});
  const headers={origin:env.GEMINI_LIVE_APP_ORIGIN,'content-type':'application/json'};
  return {code,env,auth,headers};
}

test('unauthenticated requests cannot call Gemini or see account data',async()=>{
  const setup=privateSetup();let calls=0;
  const handler=createHandler({...setup,client:{snapshot(){calls++;throw new Error('must not call');}}});
  const res=response();await handler({method:'GET',url:'/api/live-trade?action=account'},res);
  assert.equal(res.statusCode,401);assert.equal(calls,0);
  const status=response();await handler({method:'GET',url:'/api/live-trade?action=status'},status);
  assert.equal(status.body.ownerAccessConfigured,true);assert.equal(status.body.authenticated,false);
  assert.equal(status.body.csrfToken,undefined);assert.equal(status.body.account,undefined);
});

test('private account check requires owner login and exposes only approved summary fields',async()=>{
  const setup=privateSetup();let calls=0;
  const handler=createHandler({...setup,client:{async snapshot(){calls++;return {
    accountSelectionRequired:false,accountIdentity:'hidden-stable-identity',accountLabel:'Primary',
    availableUsd:'10.00',termsAccepted:true,roles:{isTrader:true,isAccountAdmin:true},rawSecret:'must never escape'
  };}}});
  const login=response();await handler({method:'POST',url:'/api/live-trade?action=login',headers:setup.headers,body:{code:setup.code}},login);
  assert.equal(login.statusCode,200);assert.equal(login.body.authenticated,true);
  const cookie=login.headers['Set-Cookie'][0].split(';')[0];
  const status=response();await handler({method:'GET',url:'/api/live-trade?action=status',headers:{cookie}},status);
  assert.equal(status.body.authenticated,true);assert.equal(status.body.csrfToken,login.body.csrfToken);
  const account=response();await handler({method:'GET',url:'/api/live-trade?action=account',headers:{cookie}},account);
  assert.equal(account.statusCode,200);assert.equal(calls,1);assert.equal(account.body.tradingEnabled,false);
  assert.deepEqual(account.body.account,{label:'Primary',availableUsd:'10.00',termsAccepted:true,roles:{trader:true}});
  const data=JSON.stringify(account.body);
  for(const secret of [setup.code,setup.env.GEMINI_LIVE_API_SECRET,'hidden-stable-identity','must never escape'])assert.ok(!data.includes(secret));
  const crossSite=response();await handler({method:'POST',url:'/api/live-trade?action=login',headers:{...setup.headers,origin:'https://evil.example'},body:{code:setup.code}},crossSite);
  assert.equal(crossSite.statusCode,403);
  const logout=response();await handler({method:'POST',url:'/api/live-trade?action=logout',headers:{...setup.headers,cookie,'x-csrf-token':login.body.csrfToken}},logout);
  assert.equal(logout.statusCode,200);assert.equal(logout.body.authenticated,false);assert.match(logout.headers['Set-Cookie'][0],/Max-Age=0/);
});

test('an expired in-flight session or provider error cannot leak private account details',async()=>{
  let clock=1_800_000_000_000;const setup=privateSetup(()=>clock);
  const handler=createHandler({...setup,now:()=>clock,client:{async snapshot(){clock+=900_000;return {accountLabel:'Private account'};}}});
  const login=response();await handler({method:'POST',url:'/api/live-trade?action=login',headers:setup.headers,body:{code:setup.code}},login);
  const cookie=login.headers['Set-Cookie'][0].split(';')[0];
  const res=response();await handler({method:'GET',url:'/api/live-trade?action=account',headers:{cookie}},res);
  assert.equal(res.statusCode,401);assert.equal(res.body.account,undefined);
  const failing=createHandler({...setup,client:{async snapshot(){throw new Error('private-gemini-secret');}}});
  const fresh=response();await failing({method:'POST',url:'/api/live-trade?action=login',headers:setup.headers,body:{code:setup.code}},fresh);
  const fail=response();await failing({method:'GET',url:'/api/live-trade?action=account',headers:{cookie:fresh.headers['Set-Cookie'][0].split(';')[0]}},fail);
  assert.equal(fail.statusCode,503);assert.ok(!JSON.stringify(fail.body).includes('private-gemini-secret'));
});
