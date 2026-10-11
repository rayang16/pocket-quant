import {createHmac, timingSafeEqual} from 'node:crypto';
import {parseSharedReel} from '../public/shared-reel.js';

const API='https://api.supadata.ai/v1/transcript';
const TOKEN_LIFETIME=15*60*1000;
const failure=(status,message)=>Object.assign(new Error(message),{status});

export function reelUrl(value) {
  const reel=parseSharedReel(value);
  if(reel.error) throw failure(400,reel.error);
  return reel.url;
}

function sign(payload,key) {
  return createHmac('sha256',key).update('pocket-quant/reel-job/v1\0'+payload).digest();
}

export function createJobToken(jobId,sourceUrl,key,now=Date.now()) {
  if(typeof jobId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw failure(502,'The transcription service returned an invalid job. Paste the claim or upload a recording.');
  const payload=Buffer.from(JSON.stringify({jobId,sourceUrl,expires:now+TOKEN_LIFETIME})).toString('base64url');
  return payload+'.'+sign(payload,key).toString('base64url');
}

export function readJobToken(token,key,now=Date.now()) {
  const invalid=()=>failure(400,'This transcription session is invalid or expired. Send the Reel again.');
  if(typeof token!=='string'||token.length>2048) throw invalid();
  const parts=token.split('.');
  if(parts.length!==2||!parts.every(part=>/^[a-zA-Z0-9_-]+$/.test(part))) throw invalid();
  const actual=Buffer.from(parts[1],'base64url'),expected=sign(parts[0],key);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) throw invalid();
  let data;
  try {data=JSON.parse(Buffer.from(parts[0],'base64url').toString());} catch {throw invalid();}
  if(!data||typeof data.jobId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(data.jobId)||!Number.isSafeInteger(data.expires)||data.expires<=now||data.expires>now+TOKEN_LIFETIME) throw invalid();
  try {if(reelUrl(data.sourceUrl)!==data.sourceUrl) throw invalid();} catch {throw invalid();}
  return data;
}

async function providerJson(response) {
  // Bound provider data as well as the incoming request. Never forward raw errors.
  if(Number(response.headers.get('content-length'))>1000000) throw failure(502,'The transcript is too large. Paste one prediction from the Reel instead.');
  let size=0;const chunks=[];
  for await(const chunk of response.body) {
    size+=chunk.length;
    if(size>1000000) throw failure(502,'The transcript is too large. Paste one prediction from the Reel instead.');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString());} catch {throw failure(502,'The transcription service returned an unreadable response. Paste the claim or upload a recording.');}
}

function completed(data,sourceUrl) {
  const text=typeof data?.content==='string'?data.content.trim():'';
  if(!text) throw failure(422,'No spoken words were found in this Reel. Paste the visible prediction or upload a recording with speech.');
  return {status:'completed',text:text.slice(0,6000),truncated:text.length>6000,sourceUrl,provider:'supadata',...(typeof data.lang==='string'&&data.lang.length<30?{language:data.lang}:{})};
}

export async function fetchReelTranscript({url,jobToken},{key,fetchImpl=fetch,now=Date.now()}={}) {
  if(!key) throw failure(501,'Automatic Reel transcription is not enabled yet. Paste the spoken prediction or upload a recording.');
  const job=jobToken?readJobToken(jobToken,key,now):null;
  const sourceUrl=job?job.sourceUrl:reelUrl(url);
  const endpoint=job?new URL(`${API}/${encodeURIComponent(job.jobId)}`):new URL(API);
  if(!job) {endpoint.searchParams.set('url',sourceUrl);endpoint.searchParams.set('text','true');endpoint.searchParams.set('mode','auto');}
  let response;
  try {response=await fetchImpl(endpoint,{headers:{'x-api-key':key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(job?20000:110000)});}
  catch {throw failure(504,'Transcription could not finish. It may still be processing; we have not retried it. Paste the claim or upload a recording.');}
  if(response.status===206||response.status===404||response.status===403) throw failure(422,'This Reel is unavailable for automatic transcription. It may be private, restricted, or removed. Paste the claim or upload a recording.');
  if(response.status===401||response.status===402) throw failure(503,'The transcription service needs attention from the app owner. Paste the claim or upload a recording for now.');
  if(response.status===429) throw failure(429,'The transcription service is busy or its allowance is used up. Wait a little, or paste the claim.');
  if(!response.ok) throw failure(502,'The transcription service could not read this Reel. Paste the claim or upload a recording.');
  const data=await providerJson(response);
  if(response.status===202&&!job) {
    return {status:'queued',jobToken:createJobToken(data?.jobId,sourceUrl,key,now),sourceUrl,retryAfterMs:2000};
  }
  if(job) {
    if(['queued','active'].includes(data?.status)) return {status:data.status,jobToken,sourceUrl,retryAfterMs:2000};
    if(data?.status==='failed') throw failure(422,'This Reel could not be transcribed. Paste the claim or upload a recording.');
    if(data?.status!=='completed') throw failure(502,'The transcription service returned an unknown job status. Paste the claim or upload a recording.');
    // REST returns flat fields; some provider versions wrap them under result.
    return completed(data.result??data,sourceUrl);
  }
  return completed(data,sourceUrl);
}

// Best-effort instance-local deduplication and cost guard. No durable quota is claimed.
export function createReelTranscriber({fetchImpl=fetch,clock=Date.now}={}) {
  const starts=new Map(),limits=new Map();
  let inFlight=0;
  return async function transcribe(input,{key,client='unknown'}={}) {
    if(!key) return fetchReelTranscript(input,{key,fetchImpl,now:clock()});
    if(input.jobToken) return fetchReelTranscript(input,{key,fetchImpl,now:clock()});
    const url=reelUrl(input.url),now=clock();
    for(const [id,entry] of starts) if(entry.expires<=now) starts.delete(id);
    for(const [id,entry] of limits) if(entry.expires<=now) limits.delete(id);
    const cacheKey=sign(url,key).toString('hex');
    if(starts.has(cacheKey)) return starts.get(cacheKey).promise;
    const bucket=limits.get(client)??{count:0,expires:now+60000};
    if(bucket.count>=6||inFlight>=8||limits.size>=1000) throw failure(429,'Too many Reels at once. Please wait a minute or paste the prediction.');
    bucket.count++;limits.set(client,bucket);inFlight++;
    // Bound memory without dropping the in-flight counter.
    if(starts.size>=100) starts.delete(starts.keys().next().value);
    const entry={expires:now+10*60*1000};
    entry.promise=fetchReelTranscript({url},{key,fetchImpl,now}).catch(error=>{
      // Briefly retain failures: a double submit must not duplicate paid work.
      entry.expires=clock()+10000;throw error;
    }).finally(()=>{inFlight--;});
    starts.set(cacheKey,entry);
    return entry.promise;
  };
}
