import {checkClaim} from '../lib/engine.js';
import {headers,send,rawBody} from '../lib/http.js';
export const config={api:{bodyParser:false}};
export default async function handler(req,res) {
  if(!headers(req,res)) return;
  try {
    let body; try {body=JSON.parse((await rawBody(req,30000)).toString());} catch(e) {if(e.status) throw e;return send(res,400,{error:'Send JSON with a text field.'});}
    if(typeof body?.text!=='string'||body.text.trim().length<3||body.text.length>6000) return send(res,400,{error:'Paste a prediction between 3 and 6,000 characters.'});
    send(res,200,await checkClaim(body.text.trim()));
  } catch(e) {send(res,e.status??(e.name==='DataError'?502:500),{error:e.name==='DataError'||e.status?e.message:'The check could not finish. Please try again.'});}
}
