import {headers,send,rawBody} from '../lib/http.js';
export const config={api:{bodyParser:false}};
export default async function handler(req,res) {
  if(!headers(req,res)) return;
  if(!process.env.ELEVENLABS_API_KEY) return send(res,501,{error:'Audio transcription is not configured. Add ELEVENLABS_API_KEY on the server, or paste the spoken claim.'});
  const type=(req.headers['content-type']||'').split(';')[0];
  if(!/^(audio|video)\/[\w.+-]+$/.test(type)) return send(res,415,{error:'Send an audio or video file as the raw request body.'});
  try {
    const body=await rawBody(req,4000000);
    if(!body.length) return send(res,400,{error:'Choose a nonempty recording.'});
    const form=new FormData();
    form.append('model_id','scribe_v1');
    form.append('file',new Blob([body],{type}),'recording.'+(type.includes('mp4')?'mp4':type.includes('mpeg')?'mp3':'webm'));
    const r=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY},body:form,signal:AbortSignal.timeout(45000)});
    if(!r.ok) return send(res,502,{error:`Transcription service returned ${r.status}. Paste the claim or try again.`});
    const data=await r.json();
    if(typeof data.text!=='string'||!data.text.trim()) return send(res,422,{error:'No speech was detected. Try a clearer recording or paste the claim.'});
    send(res,200,{text:data.text.slice(0,6000)});
  } catch(e) {send(res,e.status??502,{error:e.status?e.message:'Transcription could not finish. Paste the claim or try again.'});}
}
