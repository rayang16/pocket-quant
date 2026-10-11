import {rawBody,send} from '../lib/http.js';
import {createReelTranscriber} from '../lib/reel-transcript.js';

export const config={api:{bodyParser:false}};
const transcribe=createReelTranscriber();
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST') return send(res,405,{error:'Use POST for this endpoint.'});
  // This paid endpoint is for our own UI. A CLI without Origin remains usable.
  const origin=req.headers.origin;
  if(origin) {
    try {if(new URL(origin).host!==req.headers.host||!['http:','https:'].includes(new URL(origin).protocol)) return send(res,403,{error:'Send the Reel from Pocket Quant.'});}
    catch {return send(res,403,{error:'Send the Reel from Pocket Quant.'});}
  }
  if((req.headers['content-type']||'').split(';')[0].trim()!=='application/json') return send(res,415,{error:'Send a Reel link as JSON.'});
  try {
    const raw=await rawBody(req,16000);let input;
    try {input=JSON.parse(raw.toString());} catch {return send(res,400,{error:'Send a valid Reel link request.'});}
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['url','jobToken'].includes(k))||
      (typeof input.url==='string')===(typeof input.jobToken==='string')||
      ('url' in input&&typeof input.url!=='string')||('jobToken' in input&&typeof input.jobToken!=='string')) return send(res,400,{error:'Send either a Reel link or a transcription job token.'});
    const client=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim().slice(0,128);
    const data=await transcribe(input,{key:process.env.SUPADATA_API_KEY,client});
    send(res,data.status==='completed'?200:202,data);
  } catch(error) {
    send(res,error.status??502,{error:error.status?error.message:'Transcription could not finish. Paste the claim or upload a recording.'});
  }
}
