import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,liveReadiness} from '../api/live-trade.js';

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
