import test from 'node:test';
import assert from 'node:assert/strict';
import {assessmentFor,publicSourceUrl,normalizeDrafts,extractClaims,checkClaims} from '../public/evidence-report.js';

const claim={id:'claim-1',text:'Tesla expects production to increase in 2027.',quote:'Tesla expects production to increase in 2027.',type:'forecast'};
const extracted={claims:[claim],extraction:'ai',warnings:[]};

test('forecast and recommendation cards never become factual verdicts',()=>{
  for(const status of ['supported','contradicted','mixed','unverified']) {
    assert.equal(assessmentFor(claim,{status}).status,'forecast');
    assert.equal(assessmentFor({...claim,type:'recommendation'},{status}).status,'opinion');
  }
  assert.equal(assessmentFor({...claim,type:'fact'},{status:'supported'}).label,'Evidence supports');
  assert.equal(assessmentFor({...claim,type:'fact'},{status:'invented'}).status,'unverified');
});

test('source links allow public HTTPS URLs and reject executable, local and credential URLs',()=>{
  assert.equal(publicSourceUrl('https://www.sec.gov/Archives/test?x=1'),'https://www.sec.gov/Archives/test?x=1');
  for(const value of ['javascript:alert(1)','data:text/html,test','http://example.com/','https://localhost/','https://x.local/','https://x.internal/','https://127.0.0.1/','https://0177.0.0.1/','https://10.0.0.1/','https://[::1]/','https://a:b@example.com/','https://example.com:3000/','/relative'])assert.equal(publicSourceUrl(value),null,value);
});

test('claim extraction is separate from research and is limited to transcript length',async()=>{
  const calls=[];
  const data=await extractClaims('x'.repeat(6100),{sourceUrl:'https://www.instagram.com/reel/test/',send:async(...args)=>{calls.push(args);return extracted;}});
  assert.equal(calls.length,1);assert.equal(calls[0][1],'/api/evidence-report?action=extract');
  assert.equal(calls[0][2].text.length,6000);assert.equal(calls[0][2].sourceUrl,'https://www.instagram.com/reel/test/');
  assert.equal(data.claims[0].text,claim.text);
});

test('drafts preserve original quotes, cap at three, and reject unusable extraction',()=>{
  assert.equal(normalizeDrafts({...extracted,claims:Array.from({length:5},(_,i)=>({...claim,id:`claim-${i}`}))}).claims.length,3);
  assert.equal(normalizeDrafts(extracted).claims[0].quote,claim.quote);
  assert.throws(()=>normalizeDrafts({claims:[]}),/No clear claims/);
  assert.throws(()=>normalizeDrafts({}),/No claims were returned/);
});

test('editing or replacing the transcript suppresses a late extraction even if the server ignores cancellation',async()=>{
  const controller=new AbortController();let finish;
  const pending=extractClaims(claim.text,{signal:controller.signal,send:()=>new Promise(resolve=>{finish=resolve;})});
  controller.abort();finish(extracted);
  await assert.rejects(pending,{name:'AbortError'});
});

test('individual evidence failures do not discard successful claim cards',async()=>{
  const updates=[];
  const results=await checkClaims([claim,{...claim,id:'claim-2'},{...claim,id:'claim-3'}],{
    onResult:(id,value)=>updates.push({id,...value}),
    send:async(_base,path,{claim:input})=>{assert.equal(path,'/api/evidence-report?action=check');if(input.id==='claim-2')throw new Error('Source lookup unavailable.');return {claim:input,assessment:{status:'forecast'}};}
  });
  assert.equal(results.length,3);assert.equal(updates.length,3);
  assert.equal(updates.find(v=>v.id==='claim-2').error,'Source lookup unavailable.');
  assert.equal(updates.filter(v=>v.data).length,2);
});

test('edited claims cancel every late card update even when transport ignores abort',async()=>{
  const controller=new AbortController(),finishes=[],updates=[];
  const pending=checkClaims([claim,{...claim,id:'claim-2'}],{signal:controller.signal,onResult:(...args)=>updates.push(args),send:()=>new Promise(resolve=>finishes.push(resolve))});
  controller.abort();finishes.forEach(finish=>finish({assessment:{status:'supported'}}));
  await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(updates,[]);
});

test('checks snapshot claim edits and never send more than three claims',async()=>{
  const original={...claim},bodies=[];
  await checkClaims([original,...Array.from({length:4},(_,i)=>({...claim,id:`other-${i}`}))],{send:async(_base,_path,body)=>{bodies.push(body);original.text='changed';return {};}});
  assert.equal(bodies.length,3);assert.equal(bodies[0].claim.text,claim.text);
});

test('already cancelled work never sends a transcript or claims',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const options={signal:controller.signal,send:async()=>{calls++;return extracted;}};
  await assert.rejects(extractClaims(claim.text,options),{name:'AbortError'});
  await assert.rejects(checkClaims([claim],options),{name:'AbortError'});
  assert.equal(calls,0);
});

test('server-corrected claim types and assessment labels override mislabeled factual drafts',()=>{
  const draft={...claim,type:'fact'};
  assert.equal(assessmentFor(draft,{status:'supported'},{type:'forecast'}).status,'forecast');
  assert.equal(assessmentFor(draft,{status:'supported'},{type:'recommendation'}).status,'opinion');
  assert.equal(assessmentFor(draft,{status:'forecast'},{type:'fact'}).claimType,'forecast');
  assert.equal(assessmentFor(draft,{status:'opinion'},{type:'fact'}).claimType,'recommendation');
  // Conservative draft types cannot accidentally become a fact solely because evidence supports an assumption.
  assert.equal(assessmentFor(claim,{status:'supported'},{type:'fact'}).status,'forecast');
});

test('each claim has a deadline even when a batch cancellation signal is supplied',async()=>{
  const controller=new AbortController(),updates=[];
  const result=await checkClaims([claim],{signal:controller.signal,timeoutMs:5,onResult:(id,value)=>updates.push({id,...value}),send:async(_base,_path,_body,{signal})=>{
    assert.notEqual(signal,controller.signal);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(signal.aborted,true);
    return {assessment:{status:'supported'}};
  }});
  assert.equal(controller.signal.aborted,false);
  assert.match(result[0].error,/timed out/);
  assert.equal(updates.length,1);assert.equal(updates[0].data,undefined);
});

test('one timed-out source check preserves a different claim that finished',async()=>{
  const updates=[];
  const result=await checkClaims([claim,{...claim,id:'claim-2'}],{timeoutMs:5,onResult:(id,value)=>updates.push({id,...value}),send:async(_base,_path,body)=>{
    if(body.claim.id==='claim-2')await new Promise(resolve=>setTimeout(resolve,20));
    return {claim:body.claim,assessment:{status:'forecast'}};
  }});
  assert.equal(result[0].data.claim.id,'claim-1');assert.match(result[1].error,/timed out/);
  assert.equal(updates.filter(update=>update.data).length,1);
});
