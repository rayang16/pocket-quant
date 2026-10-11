import test from 'node:test';
import assert from 'node:assert/strict';
import transcribe from '../api/transcribe.js';
import capabilities from '../api/capabilities.js';
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=JSON.parse(body);}});
test('transcription forwards actual bytes in multipart and reports provider failures honestly',async()=>{
  const original=process.env.ELEVENLABS_API_KEY,originalFetch=globalThis.fetch;
  process.env.ELEVENLABS_API_KEY='test-only-key';
  try{
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://api.elevenlabs.io/v1/speech-to-text');
      assert.equal(options.headers['xi-api-key'],'test-only-key');
      assert.equal(options.body.get('model_id'),'scribe_v1');
      assert.deepEqual([...new Uint8Array(await options.body.get('file').arrayBuffer())],[1,2,3]);
      return {ok:true,json:async()=>({text:'BTC could reach 150k this month'})};
    };
    const req={method:'POST',headers:{'content-type':'video/mp4'},body:Buffer.from([1,2,3])};
    const success=response();await transcribe(req,success);assert.equal(success.statusCode,200);assert.equal(success.body.text,'BTC could reach 150k this month');
    globalThis.fetch=async()=>({ok:false,status:429});const limited=response();await transcribe(req,limited);assert.equal(limited.statusCode,502);assert.match(limited.body.error,/429/);
    globalThis.fetch=async()=>({ok:true,json:async()=>({text:' '})});const silent=response();await transcribe(req,silent);assert.equal(silent.statusCode,422);
    const invalid=response();await transcribe({...req,headers:{'content-type':'text/html'}},invalid);assert.equal(invalid.statusCode,415);
    const tooBig=response();await transcribe({...req,headers:{'content-type':'video/mp4','content-length':'4000001'}},tooBig);assert.equal(tooBig.statusCode,413);
    const caps=response();capabilities({method:'GET'},caps);assert.deepEqual(caps.body,{transcription:true});
  }finally{globalThis.fetch=originalFetch;if(original===undefined)delete process.env.ELEVENLABS_API_KEY;else process.env.ELEVENLABS_API_KEY=original;}
});
