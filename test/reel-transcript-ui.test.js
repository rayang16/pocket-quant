import test from 'node:test';
import assert from 'node:assert/strict';
import {getReelTranscript} from '../public/reel-transcript.js';

const url='https://www.instagram.com/reel/example/';
const completed={status:'completed',text:'Bitcoin could reach 150,000 by December.',sourceUrl:url,provider:'supadata',truncated:false};

test('loads an immediate transcript without submitting it for analysis',async()=>{
  const calls=[];
  const result=await getReelTranscript(url,{send:async(...args)=>{calls.push(args);return completed;}});
  assert.deepEqual(result,completed);
  assert.equal(calls.length,1);
  assert.equal(calls[0][1],'/api/reel-transcript');
  assert.deepEqual(calls[0][2],{url});
});

test('queued and active responses poll the latest server-issued job token',async()=>{
  const bodies=[],progress=[],delays=[];
  const responses=[{status:'queued',jobToken:'signed-first',retryAfterMs:2000},{status:'active',jobToken:'signed-next',retryAfterMs:3000},completed];
  const result=await getReelTranscript(url,{
    send:async(_base,path,body)=>{assert.equal(path,'/api/reel-transcript');bodies.push(body);return responses.shift();},
    onProgress:state=>progress.push(state),pause:async ms=>delays.push(ms)
  });
  assert.deepEqual(bodies,[{url},{jobToken:'signed-first'},{jobToken:'signed-next'}]);
  assert.deepEqual(progress,['queued','active']);assert.deepEqual(delays,[2000,3000]);assert.equal(result.text,completed.text);
});

test('cancelling an in-flight request suppresses a late transcript even if the transport ignores cancellation',async()=>{
  const controller=new AbortController();let finish;
  const pending=getReelTranscript(url,{signal:controller.signal,send:()=>new Promise(resolve=>{finish=resolve;})});
  controller.abort();finish(completed);
  await assert.rejects(pending,{name:'AbortError'});
});

test('cancelling while queued stops subsequent polling',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=getReelTranscript(url,{
    signal:controller.signal,
    send:async()=>{++calls;return {status:'queued',jobToken:'signed'};},
    onProgress:()=>controller.abort()
  });
  await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);
});

test('an already cancelled job never sends a Reel link',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(getReelTranscript(url,{signal:controller.signal,send:async()=>{++calls;return completed;}}),{name:'AbortError'});
  assert.equal(calls,0);
});

test('long-running requests end with a manual fallback instead of an endless spinner',async()=>{
  await assert.rejects(getReelTranscript(url,{
    timeoutMs:10,
    send:async(_base,_path,_body,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  }),/taking too long.*paste the prediction/);
});

test('oversized transcripts are explicitly marked as shortened for review',async()=>{
  const result=await getReelTranscript(url,{send:async()=>({...completed,text:'x'.repeat(6500)})});
  assert.equal(result.text.length,6000);assert.equal(result.truncated,true);
  const serverTruncated=await getReelTranscript(url,{send:async()=>({...completed,truncated:true})});
  assert.equal(serverTruncated.truncated,true);
});

test('empty, malformed, or failed transcript responses never fabricate a claim',async()=>{
  for(const response of [{status:'completed',text:' '},{status:'queued'},{status:'failed'},{status:'active',jobToken:''}]){
    await assert.rejects(getReelTranscript(url,{send:async()=>response}),/spoken words|could not be retrieved/);
  }
  await assert.rejects(getReelTranscript(url,{send:async()=>{throw new Error('This Reel is private or unavailable.');}}),/private or unavailable/);
});
