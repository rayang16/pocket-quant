import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {createJobToken, createReelTranscriber, fetchReelTranscript, readJobToken, reelUrl} from '../lib/reel-transcript.js';
import capabilities from '../api/capabilities.js';

const KEY='offline-test-key-not-a-real-credential';
const NOW=1800000000000;
const REEL='https://www.instagram.com/reel/MarketClaim/';
const jsonResponse=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const expectStatus=status=>error=>{
  assert.equal(error.status,status);
  assert.equal(typeof error.message,'string');
  return true;
};
const deferred=()=>{
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
};
const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value;},end(body){this.body=JSON.parse(body);}});
const request=(body,changes={})=>({method:'POST',headers:{host:'pocket-quant.example','content-type':'application/json',origin:'https://pocket-quant.example'},body,...changes});
let handlerId=0;
async function withHandler(fetchImpl,run,key=KEY) {
  const originalFetch=globalThis.fetch,originalKey=process.env.SUPADATA_API_KEY;
  globalThis.fetch=fetchImpl;
  if(key===undefined) delete process.env.SUPADATA_API_KEY;
  else process.env.SUPADATA_API_KEY=key;
  try {
    const {default:handler}=await import(`../api/reel-transcript.js?offline-test=${++handlerId}`);
    await run(handler);
  } finally {
    globalThis.fetch=originalFetch;
    if(originalKey===undefined) delete process.env.SUPADATA_API_KEY;
    else process.env.SUPADATA_API_KEY=originalKey;
  }
}
const noFetch=async()=>assert.fail('Provider must not be contacted for this request');

test('immediate transcript uses only the fixed provider host and a canonical Instagram URL',async()=>{
  let calls=0;
  const result=await fetchReelTranscript({url:'Watch this: https://m.instagram.com/reels/MarketClaim/?igsh=private-tracker'},{key:KEY,fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(url.origin,'https://api.supadata.ai');
    assert.equal(url.pathname,'/v1/transcript');
    assert.deepEqual(Object.fromEntries(url.searchParams),{url:REEL,text:'true',mode:'auto'});
    assert.equal(options.headers['x-api-key'],KEY);
    assert.equal(options.headers.Accept,'application/json');
    assert.equal(options.redirect,'error');
    assert.ok(options.signal instanceof AbortSignal);
    return jsonResponse({content:'  BTC could hit $100,000 next month.  ',lang:'en'});
  }});
  assert.equal(calls,1);
  assert.deepEqual(result,{status:'completed',text:'BTC could hit $100,000 next month.',truncated:false,sourceUrl:REEL,provider:'supadata',language:'en'});
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('invalid and spoofed source URLs are rejected before any provider call',async()=>{
  for(const url of [
    'http://instagram.com/reel/a/', 'https://instagram.com.evil.test/reel/a/',
    'https://instagram.com@127.0.0.1/reel/a/', 'https://user:password@instagram.com/reel/a/',
    'https://instagram.com:444/reel/a/', 'http://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/reel/a/', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://instagram.com/direct/inbox/', 'https://instagram.com/reel/a/extra',
    'https://instagram.com/reel/a/ https://instagram.com/reel/b/', 'x'.repeat(12001), '', null
  ]) {
    await assert.rejects(fetchReelTranscript({url},{key:KEY,fetchImpl:noFetch}),expectStatus(400));
  }
  assert.equal(reelUrl('https://instagram.com/p/Post_1/?tracking=discard'), 'https://www.instagram.com/p/Post_1/');
});

test('async transcription returns a signed job and polls queued, active, and flat completed results',async()=>{
  let calls=0;
  const fetchImpl=async(url)=>{
    calls++;
    if(calls===1) return jsonResponse({jobId:'job_123-abc'},202);
    assert.equal(url.href,'https://api.supadata.ai/v1/transcript/job_123-abc');
    return jsonResponse(calls===2?{status:'queued'}:calls===3?{status:'active'}:{status:'completed',content:'ETH to 5000',lang:'en'});
  };
  const started=await fetchReelTranscript({url:REEL},{key:KEY,fetchImpl,now:NOW});
  assert.equal(started.status,'queued');
  assert.equal(started.sourceUrl,REEL);
  assert.equal(started.retryAfterMs,2000);
  assert.deepEqual(readJobToken(started.jobToken,KEY,NOW),{jobId:'job_123-abc',sourceUrl:REEL,expires:NOW+900000});
  for(const status of ['queued','active','completed']) {
    const polled=await fetchReelTranscript({jobToken:started.jobToken},{key:KEY,fetchImpl,now:NOW+1});
    assert.equal(polled.status,status);
    assert.equal(polled.sourceUrl,REEL);
    if(status==='completed') assert.equal(polled.text,'ETH to 5000');
    else assert.equal(polled.jobToken,started.jobToken);
  }
  assert.equal(calls,4);
});

test('async result wrapper is supported while failed and unknown states fail safely',async()=>{
  const jobToken=createJobToken('job_123',REEL,KEY,NOW);
  const result=await fetchReelTranscript({jobToken},{key:KEY,now:NOW,fetchImpl:async()=>jsonResponse({status:'completed',result:{content:'A prediction',lang:'fr'}})});
  assert.equal(result.text,'A prediction');
  assert.equal(result.language,'fr');
  for(const [status,httpStatus] of [['failed',422],['unexpected',502]]) {
    await assert.rejects(fetchReelTranscript({jobToken},{key:KEY,now:NOW,fetchImpl:async()=>jsonResponse({status,error:{message:'<script>secret provider error</script>'}})}),error=>{
      assert.equal(error.status,httpStatus);
      assert.doesNotMatch(error.message,/<script|secret provider/);
      return true;
    });
  }
});

test('signed jobs reject altered payload, signature, key, expiry, malformed and oversized tokens',async()=>{
  const token=createJobToken('job_123',REEL,KEY,NOW);
  const [payload,signature]=token.split('.');
  const alteredPayload=Buffer.from(JSON.stringify({jobId:'attacker',sourceUrl:REEL,expires:NOW+900000})).toString('base64url');
  const alteredSignature=(signature[0]==='a'?'b':'a')+signature.slice(1);
  for(const invalid of [alteredPayload+'.'+signature,payload+'.'+alteredSignature,'',null,'not-a-token','a.b.c','a.!!!','x'.repeat(2049)]) {
    assert.throws(()=>readJobToken(invalid,KEY,NOW),expectStatus(400));
    await assert.rejects(fetchReelTranscript({jobToken:invalid,url:'invalid'},{key:KEY,now:NOW,fetchImpl:noFetch}),expectStatus(400));
  }
  assert.throws(()=>readJobToken(token,'another-test-key',NOW),expectStatus(400));
  assert.throws(()=>readJobToken(token,KEY,NOW+900000),expectStatus(400));
  assert.throws(()=>readJobToken(token,KEY,NOW-1),expectStatus(400));
  assert.equal(readJobToken(token,KEY,NOW+899999).jobId,'job_123');
});

test('even correctly signed job payloads must contain a safe job ID, canonical source, and bounded expiry',()=>{
  const signed=data=>{
    const payload=Buffer.from(JSON.stringify(data)).toString('base64url');
    return payload+'.'+createHmac('sha256',KEY).update('pocket-quant/reel-job/v1\0'+payload).digest('base64url');
  };
  for(const patch of [{jobId:'../../private'},{sourceUrl:'https://127.0.0.1/reel/a/'},{sourceUrl:'https://instagram.com/reel/MarketClaim/'},{expires:NOW+900001},{expires:'1800000000010'}, {jobId:''}]) {
    assert.throws(()=>readJobToken(signed({jobId:'job',sourceUrl:REEL,expires:NOW+1000,...patch}),KEY,NOW),expectStatus(400));
  }
});

test('malformed async start results never become provider paths',async()=>{
  for(const jobId of [undefined,'../secret','https://evil.test/', 'x'.repeat(129),0]) {
    await assert.rejects(fetchReelTranscript({url:REEL},{key:KEY,fetchImpl:async()=>jsonResponse({jobId},202)}),expectStatus(502));
  }
});

test('provider status failures are actionable and never disclose provider messages or credentials',async()=>{
  for(const [providerStatus,expectedStatus] of [[206,422],[403,422],[404,422],[401,503],[402,503],[429,429],[500,502],[302,502]]) {
    await assert.rejects(fetchReelTranscript({url:REEL},{key:KEY,fetchImpl:async()=>jsonResponse({error:`<script>unsafe</script> ${KEY}`},providerStatus)}),error=>{
      assert.equal(error.status,expectedStatus,`provider HTTP ${providerStatus}`);
      assert.doesNotMatch(error.message,/<script|unsafe|offline-test-key/);
      return true;
    });
  }
});

test('empty speech, unexpected content formats, and malformed JSON produce safe errors',async()=>{
  for(const content of ['', ' \n ', null, [], {text:'not the requested text format'}]) {
    await assert.rejects(fetchReelTranscript({url:REEL},{key:KEY,fetchImpl:async()=>jsonResponse({content})}),expectStatus(422));
  }
  await assert.rejects(fetchReelTranscript({url:REEL},{key:KEY,fetchImpl:async()=>new Response('<html>private error details</html>')}),error=>{
    assert.equal(error.status,502);
    assert.match(error.message,/unreadable/);
    assert.doesNotMatch(error.message,/private error|html/);
    return true;
  });
});

test('transcripts are trimmed and bounded without pretending truncation did not happen',async()=>{
  const data=await fetchReelTranscript({url:REEL},{key:KEY,fetchImpl:async()=>jsonResponse({content:'  '+'x'.repeat(6001)+'  ',lang:'x'.repeat(30)})});
  assert.equal(data.text.length,6000);
  assert.equal(data.truncated,true);
  assert.equal(data.language,undefined);
  for(const fetchImpl of [
    async()=>jsonResponse({content:'hello'},200,{'content-length':'1000001'}),
    async()=>jsonResponse({content:'x'.repeat(1000001)})
  ]) await assert.rejects(fetchReelTranscript({url:REEL},{key:KEY,fetchImpl}),expectStatus(502));
});

test('network and timeout failures are safe, make one attempt, and do not claim cancellation',async()=>{
  for(const error of [new TypeError('private network details '+KEY),new DOMException('private timeout details','TimeoutError')]) {
    let calls=0;
    await assert.rejects(fetchReelTranscript({url:REEL},{key:KEY,fetchImpl:async()=>{calls++;throw error;}}),failure=>{
      assert.equal(failure.status,504);
      assert.match(failure.message,/not retried/);
      assert.doesNotMatch(failure.message,/private|offline-test-key/);
      return true;
    });
    assert.equal(calls,1);
  }
  await assert.rejects(fetchReelTranscript({url:REEL},{fetchImpl:noFetch}),expectStatus(501));
});

test('duplicate requests share in-flight paid work, strip tracking, and reuse the cached result',async()=>{
  const pending=deferred();let calls=0;
  const transcribe=createReelTranscriber({clock:()=>NOW,fetchImpl:async()=>{calls++;await pending.promise;return jsonResponse({content:'BTC prediction'});}});
  const first=transcribe({url:REEL},{key:KEY,client:'one'});
  const second=transcribe({url:REEL+'?igsh=tracking'},{key:KEY,client:'two'});
  assert.equal(calls,1);
  pending.resolve();
  assert.deepEqual(await first,await second);
  assert.deepEqual(await transcribe({url:REEL},{key:KEY,client:'one'}),await first);
  assert.equal(calls,1);
  await transcribe({url:REEL},{key:'different-key',client:'one'});
  assert.equal(calls,2,'cache must be isolated when provider credentials change');
});

test('failed starts are deduplicated briefly and can be retried after their cache expires',async()=>{
  let now=NOW,calls=0;
  const transcribe=createReelTranscriber({clock:()=>now,fetchImpl:async()=>{calls++;throw new Error('provider is offline');}});
  await assert.rejects(transcribe({url:REEL},{key:KEY}),expectStatus(504));
  await assert.rejects(transcribe({url:REEL},{key:KEY}),expectStatus(504));
  assert.equal(calls,1);
  now+=10000;
  await assert.rejects(transcribe({url:REEL},{key:KEY}),expectStatus(504));
  assert.equal(calls,2);
});

test('per-client paid-start guard resets after a minute and permits reuse of existing work',async()=>{
  let now=NOW,calls=0;
  const transcribe=createReelTranscriber({clock:()=>now,fetchImpl:async()=>{calls++;return jsonResponse({content:'prediction'});}});
  for(let n=0;n<6;n++) await transcribe({url:`https://instagram.com/reel/start_${n}/`},{key:KEY,client:'one'});
  await assert.rejects(transcribe({url:'https://instagram.com/reel/blocked/'},{key:KEY,client:'one'}),expectStatus(429));
  await transcribe({url:'https://instagram.com/reel/start_0/'},{key:KEY,client:'one'});
  assert.equal(calls,6);
  await transcribe({url:'https://instagram.com/reel/another_client/'},{key:KEY,client:'two'});
  now+=60000;
  await transcribe({url:'https://instagram.com/reel/after_reset/'},{key:KEY,client:'one'});
  assert.equal(calls,8);
});

test('concurrent paid starts are capped and capacity is released after completion',async()=>{
  const pending=deferred();let calls=0;
  const transcribe=createReelTranscriber({clock:()=>NOW,fetchImpl:async()=>{calls++;await pending.promise;return jsonResponse({content:'prediction'});}});
  const jobs=Array.from({length:8},(_,n)=>transcribe({url:`https://instagram.com/reel/concurrent_${n}/`},{key:KEY,client:`client_${n}`}));
  await assert.rejects(transcribe({url:'https://instagram.com/reel/blocked/'},{key:KEY,client:'ninth'}),expectStatus(429));
  assert.equal(calls,8);
  pending.resolve();await Promise.all(jobs);
  await transcribe({url:'https://instagram.com/reel/after_completion/'},{key:KEY,client:'ninth'});
  assert.equal(calls,9);
});

test('job polls use the signed job endpoint rather than starting another paid transcription',async()=>{
  let calls=0;
  const transcribe=createReelTranscriber({clock:()=>NOW,fetchImpl:async(url)=>{
    calls++;
    if(url.pathname==='/v1/transcript') return jsonResponse({jobId:'job_existing'},202);
    assert.equal(url.pathname,'/v1/transcript/job_existing');
    return jsonResponse({status:'active'});
  }});
  const started=await transcribe({url:REEL},{key:KEY});
  const cached=await transcribe({url:REEL},{key:KEY});
  assert.equal(started.jobToken,cached.jobToken);
  assert.equal(calls,1);
  await transcribe({jobToken:started.jobToken},{key:KEY});
  assert.equal(calls,2);
});

test('HTTP endpoint validates method, origin, type, body size and request shape before using the provider',async()=>{
  await withHandler(noFetch,async handler=>{
    const cases=[
      [request({url:REEL},{method:'GET'}),405],
      [request({url:REEL},{headers:{host:'pocket-quant.example',origin:'https://attacker.example','content-type':'application/json'}}),403],
      [request({url:REEL},{headers:{host:'pocket-quant.example',origin:'garbage','content-type':'application/json'}}),403],
      [request({url:REEL},{headers:{host:'pocket-quant.example','content-type':'text/plain'}}),415],
      [request('{not json}'),400],
      [request(null),400], [request([]),400], [request({}),400],
      [request({url:REEL,jobToken:'job'}),400], [request({url:42}),400],
      [request({url:REEL,extra:'ignored?'}),400], [request({jobToken:null}),400],
      [request({url:'https://localhost/reel/private/'}),400],
      [request({jobToken:'tampered.job'}),400],
      [request('x'.repeat(16001)),413],
      [request({url:REEL},{headers:{host:'pocket-quant.example','content-type':'application/json','content-length':'16001'}}),413]
    ];
    for(const [req,status] of cases) {
      const res=response();await handler(req,res);
      assert.equal(res.statusCode,status,JSON.stringify(req.body)?.slice(0,100));
      assert.equal(typeof res.body.error,'string');
      assert.equal(res.headers['Cache-Control'],'no-store');
      assert.equal(res.headers['X-Content-Type-Options'],'nosniff');
    }
    const stream=Readable.from([Buffer.alloc(8000),Buffer.alloc(8001)]);
    stream.method='POST';stream.headers={'content-type':'application/json'};
    const res=response();await handler(stream,res);assert.equal(res.statusCode,413);
  });
});

test('HTTP endpoint maps immediate and async responses to 200 and 202 and permits originless clients',async()=>{
  let calls=0;
  await withHandler(async()=>++calls===1?jsonResponse({content:'Immediate claim'}):jsonResponse({jobId:'queued_job'},202),async handler=>{
    const first=response();
    await handler(request({url:REEL},{headers:{'content-type':'application/json; charset=utf-8'}}),first);
    assert.equal(first.statusCode,200);assert.equal(first.body.text,'Immediate claim');
    const second=response();await handler(request({url:'https://instagram.com/reel/second/'}),second);
    assert.equal(second.statusCode,202);assert.equal(second.body.status,'queued');
    assert.equal(typeof second.body.jobToken,'string');
    assert.doesNotMatch(JSON.stringify(second.body),/offline-test-key/);
  });
  assert.equal(calls,2);
});

test('HTTP endpoint keeps unexpected response-stream failures private',async()=>{
  await withHandler(async()=>({ok:true,status:200,headers:new Headers(),body:{async *[Symbol.asyncIterator](){throw new Error('private stream details '+KEY);}}}),async handler=>{
    const res=response();await handler(request({url:REEL}),res);
    assert.equal(res.statusCode,502);
    assert.equal(res.body.error,'Transcription could not finish. Paste the claim or upload a recording.');
    assert.doesNotMatch(JSON.stringify(res.body),/private|offline-test-key/);
  });
});

test('missing configuration is reported honestly and capabilities never expose a provider key',async()=>{
  const originalKey=process.env.SUPADATA_API_KEY;
  try {
    delete process.env.SUPADATA_API_KEY;
    await withHandler(noFetch,async handler=>{
      // withHandler's default key is deliberately removed before exercising this handler.
      delete process.env.SUPADATA_API_KEY;
      const res=response();await handler(request({url:REEL}),res);
      assert.equal(res.statusCode,501);assert.match(res.body.error,/not enabled/);
      const caps=response();capabilities({method:'GET'},caps);
      assert.equal(caps.body.reelTranscription,false);
    });
    process.env.SUPADATA_API_KEY=KEY;
    const caps=response();capabilities({method:'GET'},caps);
    assert.equal(caps.body.reelTranscription,true);
    assert.doesNotMatch(JSON.stringify(caps.body),/offline-test-key/);
  } finally {
    if(originalKey===undefined) delete process.env.SUPADATA_API_KEY;
    else process.env.SUPADATA_API_KEY=originalKey;
  }
});
