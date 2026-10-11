import {request} from './ui.js';

function wait(ms,signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(signal.reason??new DOMException('Aborted','AbortError'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
}

// Poll only a server-issued job token; browser code never receives provider credentials.
export async function getReelTranscript(url,{signal,timeoutMs=240000,onProgress=()=>{},send=request,pause=wait}={}) {
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  let body={url};
  try {
    while(true) {
      controller.signal.throwIfAborted();
      const data=await send('','/api/reel-transcript',body,{signal:controller.signal});
      controller.signal.throwIfAborted();
      if(data.status==='completed') {
        if(typeof data.text!=='string'||!data.text.trim())throw new Error('No spoken words were found. Paste the prediction or upload a recording.');
        return {...data,text:data.text.slice(0,6000),truncated:data.truncated===true||data.text.length>6000};
      }
      if(!['queued','active'].includes(data.status)||typeof data.jobToken!=='string'||!data.jobToken)throw new Error('The transcript could not be retrieved. Try again or paste the prediction.');
      onProgress(data.status);
      body={jobToken:data.jobToken};
      const delay=Number.isFinite(data.retryAfterMs)?Math.max(1000,Math.min(10000,data.retryAfterMs)):2000;
      await pause(delay,controller.signal);
    }
  } catch(error) {
    if(timedOut)throw new Error('This Reel is taking too long to transcribe. Try again, paste the prediction, or upload a recording.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}
