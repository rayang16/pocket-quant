import {rawBody,send} from '../lib/http.js';
import {createEvidenceReporter} from '../lib/evidence-report.js';

export const config={api:{bodyParser:false}};
export function createReportHandler(report=createEvidenceReporter()) {
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method!=='POST')return send(res,405,{error:'Use POST for this endpoint.'});
    const origin=req.headers.origin;
    if(origin) {
      try {const url=new URL(origin);if(url.host!==req.headers.host||!['http:','https:'].includes(url.protocol))return send(res,403,{error:'Run source checks from Gem Finder.'});}
      catch{return send(res,403,{error:'Run source checks from Gem Finder.'});}
    }
    if((req.headers['content-type']||'').split(';')[0].trim()!=='application/json')return send(res,415,{error:'Send claims as JSON.'});
    try {
      const action=new URL(req.url,'http://localhost').searchParams.get('action');
      if(!['extract','check'].includes(action))return send(res,400,{error:'Choose extract or check.'});
      const raw=await rawBody(req,26000);let input;
      try {input=JSON.parse(raw.toString());}catch{return send(res,400,{error:'Send a valid claim request.'});}
      const client=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim().slice(0,128);
      send(res,200,await report(action,input,{client}));
    }catch(error){send(res,error.status??502,{error:error.status?error.message:'The report could not finish. Try checking again.'});}
  };
}
export default createReportHandler();
