import {createHash} from 'node:crypto';
import {extractReportClaims,classifyReportClaim} from './report-claims.js';
import {createEvidenceProvider} from './evidence-provider.js';
import {relatedMarkets} from './report-markets.js';
import {checkClaim} from './engine.js';
import {regexClaim} from './claim.js';
import {parseSharedReel} from '../public/shared-reel.js';

const fail=(status,message)=>Object.assign(new Error(message),{status});
export function validateReportInput(action,input,now=new Date()) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Send a claim or transcript as JSON.');
  const allowed=action==='extract'?['text','sourceUrl']:['claim','sourceUrl'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))throw fail(400,'Unsupported report fields.');
  if(input.sourceUrl!==undefined&&(!input.sourceUrl||typeof input.sourceUrl!=='string'||parseSharedReel(input.sourceUrl).error))throw fail(400,'Use a supported Instagram Reel source link.');
  if(action==='extract') {
    if(typeof input.text!=='string'||input.text.trim().length<3||input.text.length>6000)throw fail(400,'Use a transcript between 3 and 6,000 characters.');
    return {text:input.text.trim()};
  }
  if(action!=='check')throw fail(400,'Choose extract or check.');
  const c=input.claim;
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['id','text','quote','type'].includes(k))||
    typeof c.id!=='string'||!/^claim-[1-3]$/.test(c.id)||typeof c.text!=='string'||c.text.trim().length<3||c.text.length>500||
    typeof c.quote!=='string'||c.quote.length>2000||!['fact','forecast','recommendation'].includes(c.type))throw fail(400,'Send a reviewed claim of 3–500 characters with its type.');
  const claim={...c,text:c.text.trim()};
  // A manually mislabeled forecast must never receive a true/false verdict.
  if(claim.type==='fact')claim.type=classifyReportClaim(claim.text,now);
  return {claim};
}

function noResearch(claim,message) {
  return {assessment:{status:claim.type==='forecast'?'forecast':claim.type==='recommendation'?'opinion':'unavailable',summary:message,limitations:['No live source research was completed. Related Gemini markets do not verify this claim.']},sources:[]};
}

async function independentModel(claim,now,checker) {
  if(claim.type!=='forecast')return null;
  const parsed=regexClaim(claim.text,now);
  // For an undated Reel, relative deadlines and assumed deadlines are unsafe.
  // Keep the existing single-prediction tool available for user-entered dates.
  const dated=/\b(?:by|on|before)\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b/.test(claim.text);
  if(!parsed.asset||!dated||parsed.deadlineAssumed||parsed.clarification)return null;
  try{return await checker(claim.text,{now,extract:async()=>parsed,apiKey:null});}catch{return null;}
}

export function createEvidenceReporter({providerFactory=createEvidenceProvider,marketLookup=relatedMarkets,checker=checkClaim,clock=()=>new Date()}={}) {
  const cached=new Map(),clients=new Map();let active=0;
  return async function report(action,input,{client='unknown'}={}) {
    const now=clock(),time=+now,valid=validateReportInput(action,input,now);
    for(const [key,value] of cached)if(value.expires<=time)cached.delete(key);
    for(const [key,value] of clients)if(value.expires<=time)clients.delete(key);
    const provider=providerFactory(),mode=provider?'research':'rules';
    // Bind reuse to the input and provider availability, and keep it process-local.
    const key=createHash('sha256').update(JSON.stringify({action,valid,mode})).digest('hex');
    const existing=cached.get(key);if(existing)return existing.promise;
    const usage=clients.get(client)||{count:0,expires:time+60000};
    if(usage.count>=12||active>=8)throw fail(429,'Too many checks are running. Wait a moment and try again.');
    usage.count++;clients.set(client,usage);if(clients.size>1000)clients.delete(clients.keys().next().value);
    active++;
    const promise=(async()=>{
      if(action==='extract')return {...await extractReportClaims(valid.text,{extractor:provider?.extract,now}),checkedAt:now.toISOString()};
      const {claim}=valid;
      const research=provider?provider.research(claim,{now}).catch(()=>noResearch(claim,'Live source research could not finish. Try checking this claim again.')):Promise.resolve(noResearch(claim,'Live source research is not configured yet. The app owner needs to connect an AI research API key.'));
      const [evidence,market,model]=await Promise.all([research,marketLookup(claim,{now}).catch(()=>({status:'unavailable',reason:'Gemini markets could not be loaded. Try again.',matches:[]})),independentModel(claim,now,checker)]);
      const limitations=[...evidence.assessment.limitations];
      if(/\b(?:today|tomorrow|yesterday|this (?:year|month|week)|next (?:year|month|week)|last (?:year|month|week))\b/i.test(claim.text))limitations.push('The Reel publication date is unknown. Relative dates need review before comparing outcomes or deadlines.');
      if(claim.type==='forecast'&&!model)limitations.push('No independent probability model was applied: this report requires a supported crypto price target and an explicit calendar date with a year.');
      return {claim,checkedAt:now.toISOString(),...evidence,assessment:{...evidence.assessment,limitations},market,model};
    })();
    cached.set(key,{expires:time+5*60000,promise});if(cached.size>100)cached.delete(cached.keys().next().value);
    try {
      const result=await promise;
      if(result.assessment?.status==='unavailable'||result.assessment?.limitations?.some(x=>x.startsWith('No live source research')))cached.delete(key);
      return result;
    }catch(error){cached.delete(key);throw error;}finally{active--;}
  };
}
