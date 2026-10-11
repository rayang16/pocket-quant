import {createGeminiTrade} from '../lib/gemini-trade.js';
import {send,rawBody} from '../lib/http.js';
export const config={api:{bodyParser:false}};
export function createHandler({trade=createGeminiTrade()}={}){
  return async function handler(req,res){
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      const action=new URL(req.url,'http://localhost').searchParams.get('action');
      if(action==='markets'){
        if(req.method!=='GET')return send(res,405,{error:'Use GET for market discovery.'});
        if(!trade.getSession(req))return send(res,401,{error:'Connect your Gemini sandbox account first.'});
        return send(res,200,{sandbox:true,markets:await trade.markets(),limit:300});
      }
      if(!['preview','submit'].includes(action))return send(res,404,{error:'Unknown sandbox action.'});
      if(req.method!=='POST')return send(res,405,{error:'Use POST for this sandbox action.'});
      if(!String(req.headers?.['content-type']??'').startsWith('application/json'))return send(res,415,{error:'Send JSON for this action.'});
      let body;try{body=JSON.parse((await rawBody(req,8000)).toString());}catch(e){if(e.status)throw e;return send(res,400,{error:'Send a valid order review.'});}
      if(!body||typeof body!=='object'||Array.isArray(body))return send(res,400,{error:'Send a valid order review.'});
      return send(res,200,await trade[action](req,body));
    }catch(error){return send(res,error.status??500,{error:error.status?error.message:'The sandbox request could not finish.',...(error.code?{code:error.code}:{})});}
  };
}
export default createHandler();
