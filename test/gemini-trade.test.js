import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeminiTrade,normalizeMarkets} from '../lib/gemini-trade.js';
import {createHandler} from '../api/gemini-trade.js';
import {HttpError} from '../lib/gemini-account.js';

const NOW=Date.parse('2026-10-11T19:00:00Z');
const event=()=>({status:'active',title:'BTC price on October 31',contracts:[{instrumentSymbol:'GEMI-BTC-DEMO',label:'$100,000 or above',status:'active',marketState:'open',expiryDate:'2026-10-31T21:00:00Z',prices:{buy:{yes:'0.25',no:'0.80'}},description:{content:[{value:'Resolves from the specified index at expiry.'}]},priceMinimum:'0.01',priceIncrement:'0.01',quantityMinimum:'0.01',quantityIncrement:'0.01'}]});
const input={csrfToken:'csrf',symbol:'GEMI-BTC-DEMO',outcome:'yes',quantity:'2',price:'0.25'};
function setup(){
  let time=NOW,terms=true,events=[event()],orderError=false;
  const session={id:'session-1',expiresAt:NOW+3600000};const calls=[],urls=[];
  const account={getSession:()=>session,requireMutation(req,body){if(body.csrfToken!=='csrf')throw new HttpError(403,'Invalid CSRF');return session;},async sandboxRequest(s,path,options){calls.push({path,options});if(path.endsWith('/status'))return {hasAcceptedLatest:terms};if(orderError)throw new Error('network failed');return {orderId:123,status:'filled',filledQuantity:'2',remainingQuantity:'0'};}};
  const trade=createGeminiTrade({account,now:()=>time,fetchImpl:async(url)=>{urls.push(url);return {ok:true,json:async()=>({data:events})};}});
  return {trade,calls,urls,session,setTime:v=>time=v,setTerms:v=>terms=v,setEvents:v=>events=v,setOrderError:v=>orderError=v};
}
test('discovery uses exact open sandbox symbols and never invents missing quotes',()=>{
  const active=event();active.contracts.push({...active.contracts[0],instrumentSymbol:'GEMI-CLOSED',marketState:'closed'},{...active.contracts[0],instrumentSymbol:'GEMI-EXPIRED',expiryDate:'2020-01-01'}, {...active.contracts[0],instrumentSymbol:undefined});
  const found=normalizeMarkets([active],NOW);assert.equal(found.length,1);assert.equal(found[0].symbol,'GEMI-BTC-DEMO');assert.equal(found[0].noAsk,.8);
  delete active.contracts[0].prices;assert.equal(normalizeMarkets([active],NOW)[0].yesAsk,null);
});
test('review binds exact terms, totals, session and sandbox origin; confirmation places only a limit buy',async()=>{
  const s=setup(),p=await s.trade.preview({},input);assert.equal(p.order.notional,'0.50');assert.equal(p.order.description,'Resolves from the specified index at expiry.');
  const result=await s.trade.submit({},{csrfToken:'csrf',previewToken:p.previewToken,confirmed:true});assert.equal(result.order.orderId,123);
  const placement=s.calls.filter(c=>c.path.endsWith('/order'));assert.equal(placement.length,1);assert.deepEqual(placement[0].options.body,{symbol:'GEMI-BTC-DEMO',outcome:'yes',quantity:'2',price:'0.25',side:'buy',orderType:'limit',timeInForce:'immediate-or-cancel'});
  assert.ok(s.urls.every(url=>new URL(url).origin==='https://api.sandbox.gemini.com'));
});
test('explicit confirmation and current terms are mandatory',async()=>{
  const s=setup();s.setTerms(false);await assert.rejects(s.trade.preview({},input),e=>e.code==='TERMS_REQUIRED');s.setTerms(true);
  const p=await s.trade.preview({},input);await assert.rejects(s.trade.submit({},{csrfToken:'csrf',previewToken:p.previewToken}),e=>e.status===400);
  s.setTerms(false);await assert.rejects(s.trade.submit({},{csrfToken:'csrf',previewToken:p.previewToken,confirmed:true}),e=>e.code==='TERMS_REQUIRED');assert.equal(s.calls.filter(c=>c.path.endsWith('/order')).length,0);
});
test('tampered, expired, superseded and cross-session previews fail closed',async()=>{
  const s=setup(),p=await s.trade.preview({},input);const body={csrfToken:'csrf',previewToken:p.previewToken,confirmed:true};
  await assert.rejects(s.trade.submit({},{...body,previewToken:'forged'}),e=>e.code==='PREVIEW_EXPIRED');
  s.session.id='someone-else';await assert.rejects(s.trade.submit({},body),e=>e.code==='PREVIEW_EXPIRED');s.session.id='session-1';
  await s.trade.preview({},input);await assert.rejects(s.trade.submit({},body),e=>e.code==='PREVIEW_EXPIRED');
  const fresh=await s.trade.preview({},input);s.setTime(NOW+120001);await assert.rejects(s.trade.submit({},{...body,previewToken:fresh.previewToken}),e=>e.code==='PREVIEW_EXPIRED');
});
test('concurrent confirmations submit once, and uncertainty cannot be retried',async()=>{
  const s=setup(),p=await s.trade.preview({},input),body={csrfToken:'csrf',previewToken:p.previewToken,confirmed:true};
  const results=await Promise.allSettled([s.trade.submit({},body),s.trade.submit({},body)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(s.calls.filter(c=>c.path.endsWith('/order')).length,1);
  const next=await s.trade.preview({},input);s.setOrderError(true);body.previewToken=next.previewToken;
  await assert.rejects(s.trade.submit({},body),e=>e.code==='UNKNOWN_RESULT');await assert.rejects(s.trade.submit({},body),e=>e.code==='ALREADY_SUBMITTED');
});
test('invalid inputs, wrong increments, CSRF and changed markets never place orders',async()=>{
  const s=setup();for(const change of [{outcome:'maybe'},{price:'1.00'},{price:'0.001'},{price:'NaN'},{quantity:'101'},{quantity:'1.1'},{quantity:2},{symbol:'GEMI-FABRICATED'},{csrfToken:'wrong'}])await assert.rejects(s.trade.preview({},{...input,...change}));
  const special=event();special.contracts[0].priceIncrement='.1';s.setEvents([special]);await assert.rejects(s.trade.preview({},input));
  s.setEvents([event()]);const p=await s.trade.preview({},input);const closed=event();closed.contracts[0].marketState='closed';s.setEvents([closed]);await assert.rejects(s.trade.submit({},{csrfToken:'csrf',previewToken:p.previewToken,confirmed:true}));assert.equal(s.calls.filter(c=>c.path.endsWith('/order')).length,0);
});
test('server restart or another process cannot replay a review',async()=>{
  const one=setup(),two=setup(),p=await one.trade.preview({},input);
  await assert.rejects(two.trade.submit({},{csrfToken:'csrf',previewToken:p.previewToken,confirmed:true}),e=>e.code==='PREVIEW_EXPIRED');
});
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=JSON.parse(body);}};}
test('trade API restricts methods and payloads without permissive CORS',async()=>{
  const s=setup(),handler=createHandler({trade:s.trade});
  for(const [method,action,status,body]of [['GET','preview',405,{}],['POST','markets',405,{}],['POST','oops',404,{}],['POST','preview',400,'{'],['POST','preview',400,null]]){
    const res=response();await handler({method,url:'/api/gemini-trade?action='+action,headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)},res);assert.equal(res.statusCode,status);assert.equal(res.headers['Access-Control-Allow-Origin'],undefined);
  }
});
