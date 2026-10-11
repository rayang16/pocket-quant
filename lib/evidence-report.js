import {createHash} from 'node:crypto';
import {extractReportClaims,classifyReportClaim} from './report-claims.js';
import {relatedMarkets} from './report-markets.js';
import {checkClaim} from './engine.js';
import {regexClaim,parseDeadline} from './claim.js';
import {parseSharedReel} from '../public/shared-reel.js';
import {createReportAI} from './report-ai.js';
import {concludeClaim,reportEvidence} from './report-conclusion.js';

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

async function independentModel(claim,now,checker) {
  if(claim.type!=='forecast')return null;
  const parsed=regexClaim(claim.text,now);
  // For an undated Reel, relative deadlines and assumed deadlines are unsafe.
  // Keep the existing single-prediction tool available for user-entered dates.
  const dates=[...claim.text.matchAll(/\b(?:by|on|before)\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b/gi)];
  if(!parsed.asset||dates.length!==1||parsed.deadlineAssumed||parsed.clarification)return null;
  const explicit=parseDeadline(dates[0][0],now);
  // A nearby "today" or second date must not silently override the quoted target's deadline.
  if(explicit.deadlineError||explicit.deadlineAssumed||explicit.deadlineISO!==parsed.deadlineISO)return null;
  try{return await checker(claim.text,{now,extract:async()=>parsed,apiKey:null});}catch{return null;}
}

function configuredAI() {
  try{return createReportAI();}catch{return null;}
}

export function createEvidenceReporter({marketLookup=relatedMarkets,checker=checkClaim,clock=()=>new Date(),ai=configuredAI()}={}) {
  const cached=new Map(),clients=new Map();let active=0;
  return async function report(action,input,{client='unknown'}={}) {
    const now=clock(),time=+now,valid=validateReportInput(action,input,now);
    for(const [key,value] of cached)if(value.expires<=time)cached.delete(key);
    for(const [key,value] of clients)if(value.expires<=time)clients.delete(key);
    // Results are process-local and tied to the exact reviewed claim.
    const key=createHash('sha256').update(JSON.stringify({action,valid})).digest('hex');
    const existing=cached.get(key);if(existing)return existing.promise;
    const usage=clients.get(client)||{count:0,expires:time+60000};
    if(usage.count>=12||active>=8)throw fail(429,'Too many checks are running. Wait a moment and try again.');
    usage.count++;clients.set(client,usage);if(clients.size>1000)clients.delete(clients.keys().next().value);
    active++;
    const promise=(async()=>{
      if(action==='extract')return {...await extractReportClaims(valid.text,{now,extractor:ai?text=>ai.extractClaims(text):undefined}),checkedAt:now.toISOString()};
      const {claim}=valid;
      const [market,model]=await Promise.all([marketLookup(claim,{now}).catch(()=>({status:'unavailable',reason:'Gemini markets could not be loaded. Try again.',matches:[]})),independentModel(claim,now,checker)]);
      const assessment=concludeClaim(claim,market,model),limitations=[...assessment.limitations];
      if(/\b(?:today|tomorrow|yesterday|this (?:year|month|week)|next (?:year|month|week)|last (?:year|month|week))\b/i.test(claim.text))limitations.push('The Reel publication date is unknown. Relative dates need review before comparing outcomes or deadlines.');
      if(claim.type==='forecast'&&!model)limitations.push('No independent probability model was applied. It requires a supported crypto price target, one unambiguous calendar deadline with a year, and available price history.');
      const result={claim,checkedAt:now.toISOString(),assessment:{...assessment,limitations},market,model};
      result.evidence=reportEvidence(result);
      result.explanation={status:'disabled',provider:'claude'};
      if(ai) {
        try {
          // The original quote remains visible in the UI; edited text is the only current claim.
          const currentClaim={text:claim.text,type:claim.type};
          const explanation=await ai.explain({claim:currentClaim,assessment:result.assessment,evidence:result.evidence,checkedAt:result.checkedAt});
          result.explanation={...explanation,status:'complete',provider:'claude'};
        } catch {result.explanation={status:'unavailable',provider:'claude'};}
      }
      return result;
    })();
    cached.set(key,{expires:time+5*60000,promise});if(cached.size>100)cached.delete(cached.keys().next().value);
    try {
      const result=await promise;
      if(result.market?.status==='unavailable'||result.explanation?.status==='unavailable')cached.delete(key);
      return result;
    }catch(error){cached.delete(key);throw error;}finally{active--;}
  };
}
