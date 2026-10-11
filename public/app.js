import {request,renderResult,node} from './ui.js';
import {downloadCard,shareCard} from './card.js';
import {parseSharedReel,sharedInput} from './shared-reel.js';
import {getReelTranscript} from './reel-transcript.js';
import {extractClaims,checkClaims,createReportView} from './evidence-report.js';

const form=document.querySelector('#check-form'),input=document.querySelector('#claim-text'),button=document.querySelector('#check-button'),status=document.querySelector('#status'),result=document.querySelector('#result');
const reelPanel=document.querySelector('#shared-reel'),reelMessage=document.querySelector('#reel-message'),retryReel=document.querySelector('#retry-reel');
const transcriptWork=document.querySelector('#transcript-work'),transcriptProgress=document.querySelector('#transcript-progress'),reviewNotice=document.querySelector('#review-notice');
let controller,serial=0,workKind=null,reelUrl=null,reportView=null;
const cryptoButton=document.querySelector('#crypto-check-button');

function count(){document.querySelector('#char-count').textContent=`${input.value.length.toLocaleString()} / 6,000`;}
function busy(on,message='') {
  button.disabled=on;button.textContent=on?(workKind==='extract'?'Finding claims…':'Checking evidence…'):'Find claims ↗';
  cryptoButton.disabled=on;
  status.textContent=message;result.setAttribute('aria-busy',String(on));
}
function cancelWork() {
  controller?.abort();controller=null;++serial;workKind=null;reportView?.stop();
  transcriptWork.hidden=true;retryReel.disabled=false;busy(false);result.classList.remove('loading');
}
function startWork(kind) {
  cancelWork();controller=new AbortController();workKind=kind;
  retryReel.disabled=kind==='recording';
  return {id:serial,signal:controller.signal};
}
function showClaimState(title='What does the Reel claim?',message='Paste or type the spoken claims, then choose Find claims to review them.') {
  reportView=null;result.classList.remove('evidence-report');result.replaceChildren(node('span','eyebrow','REVIEW THE CLAIM'),node('h2','state-title',title),node('p','result-explanation',message));
}
function clearReel() {
  reelUrl=null;reelPanel.hidden=true;
  document.querySelector('#reel-source').removeAttribute('href');document.querySelector('#reel-url').value='';
}
function manualReel(message) {
  reelMessage.textContent=message;retryReel.hidden=false;
  showClaimState();status.textContent='Paste or type the spoken prediction. You can also upload a recording when enabled.';
}
function reviewTranscript(data,provider) {
  const trimmed=data.text.slice(0,6000),truncated=data.truncated===true||data.text.length>6000;
  input.value=trimmed;count();
  reviewNotice.textContent=`${truncated?'Only the first 6,000 characters are shown. ':''}Transcript from ${provider}. Check names, numbers and dates against the Reel. We’ll find up to three claims for you to review; source research only starts when you choose Check claims & sources.`;
  reviewNotice.hidden=false;
  input.setSelectionRange(0,0);input.scrollTop=0;
  findClaims({automatic:true});
}

async function transcribeReel(url,{automatic=false}={}) {
  const {id,signal}=startWork('reel');reviewNotice.hidden=true;retryReel.hidden=true;
  transcriptWork.hidden=false;transcriptProgress.textContent=automatic?'Checking Reel transcription availability…':'Getting the Reel’s spoken words…';
  reelMessage.textContent='Public Reel links are sent to Supadata for transcription. You can stop waiting and type the prediction yourself.';
  showClaimState('Getting the words.','We’ll load an editable transcript here. You’ll review it before running a check.');
  try {
    if(automatic) {
      const available=await capabilities;
      if(id!==serial)return;
      if(available.reelTranscription!==true) {
        manualReel(available.reelTranscription===false
          ?'Automatic Reel transcription is not enabled on this server yet. Paste the spoken prediction below, or upload a recording when enabled.'
          :'We couldn’t check automatic transcription availability. Try Get transcript, or paste the spoken prediction below.');
        retryReel.hidden=available.reelTranscription===false;return;
      }
    }
    transcriptProgress.textContent='Getting the Reel’s spoken words… This may take a few minutes.';
    const data=await getReelTranscript(url,{signal,onProgress:state=>{
      if(id===serial)transcriptProgress.textContent=state==='queued'?'Transcript queued. You can keep waiting or type the prediction below.':'Transcribing the Reel… You can keep waiting or type the prediction below.';
    }});
    if(id!==serial)return;
    reelMessage.textContent='Transcript received from Supadata. Review the transcript and extracted claims below.';
    retryReel.hidden=false;retryReel.textContent='Get transcript again';reviewTranscript(data,'Supadata');
  } catch(error) {
    if(id!==serial)return;
    manualReel(error.name==='AbortError'?'Stopped waiting for transcription. Paste the spoken prediction below.':error.message);
    status.textContent=error.name==='AbortError'?'Stopped waiting for transcription. You can paste or type the prediction.':error.message;
  } finally {
    if(id===serial){controller=null;workKind=null;transcriptWork.hidden=true;}
  }
}
function receiveReel(value) {
  const reel=parseSharedReel(value);
  if(reel.error){cancelWork();status.textContent=reel.error;return false;}
  cancelWork();input.value='';count();reviewNotice.hidden=true;
  reelUrl=reel.url;reelPanel.hidden=false;document.querySelector('#reel-source').href=reel.url;
  document.querySelector('#reel-url').value=reel.url;retryReel.textContent='Get transcript';
  transcribeReel(reel.url,{automatic:true});return true;
}
document.querySelector('#reel-form').addEventListener('submit',e=>{e.preventDefault();receiveReel(document.querySelector('#reel-url').value);});
document.querySelector('#clear-reel').addEventListener('click',()=>{cancelWork();clearReel();reviewNotice.hidden=true;showClaimState('Ready for your next claim.','Paste a prediction or send another Reel.');status.textContent='Reel removed.';});
retryReel.addEventListener('click',()=>{if(reelUrl&&workKind!=='recording')transcribeReel(reelUrl);});
document.querySelector('#cancel-transcript').addEventListener('click',()=>{
  cancelWork();if(reelUrl)manualReel('Stopped waiting for transcription. Paste or type the spoken prediction below.');
  else showClaimState('Add the words yourself.','Paste or type the prediction from your recording.');
  status.textContent='Stopped waiting for transcription. You can paste or type the prediction.';input.focus();
});

async function checkCrypto() {
  if(/^\s*https?:\/\/\S+\s*$/.test(input.value)){receiveReel(input.value);return;}
  cancelWork();
  if(input.value.trim().length<3){status.textContent='Paste a prediction to check.';input.focus();return;}
  const {id,signal}=startWork('check');reviewNotice.hidden=true;reportView=null;result.classList.remove('evidence-report');
  busy(true,'Reading your claim and fetching Gemini prices…');result.classList.add('loading');
  result.replaceChildren(node('span','eyebrow','CHECKING LIVE EVIDENCE'),node('h2','state-title','Putting it to the test.'),node('p','result-explanation','Reading the claim, finding a market, and checking the volatility range.'));
  const currentController=controller,timeout=setTimeout(()=>currentController.abort(),60000);
  try {
    const data=await request('','/api/check',{text:input.value},{signal});if(id!==serial)return;
    renderResult(result,data,{download:r=>downloadCard(r).catch(e=>status.textContent=e.message),share:typeof navigator.share==='function'?r=>shareCard(r).catch(e=>{if(e.name!=='AbortError')status.textContent=e.message;}):undefined});status.textContent='Check complete. Read the matching conditions below.';
  } catch(error) {
    if(id!==serial)return;const message=error.name==='AbortError'?'This check timed out. Please try again.':error.message;
    status.textContent=message;result.replaceChildren(node('span','eyebrow','CHECK UNAVAILABLE'),node('h2','state-title','No data. No verdict.'),node('p','result-explanation',message));
  } finally {
    clearTimeout(timeout);if(id===serial){controller=null;workKind=null;busy(false,status.textContent);result.classList.remove('loading');}
  }
}
async function findClaims({automatic=false}={}) {
  if(/^\s*https?:\/\/\S+\s*$/.test(input.value)){receiveReel(input.value);return;}
  if(input.value.trim().length<3){cancelWork();status.textContent='Paste the words or claims from a Reel first.';input.focus();return;}
  const {id,signal}=startWork('extract');reportView=null;
  busy(true,automatic?'Transcript ready. Finding up to three claims to review…':'Finding up to three claims to review…');
  showClaimState('Pulling out the claims.','We’ll separate factual statements, forecasts and recommendations. You can edit each before checking sources.');
  const currentController=controller,timeout=setTimeout(()=>currentController.abort(),60000);
  try {
    const data=await extractClaims(input.value,{sourceUrl:reelUrl,signal});if(id!==serial)return;
    const available=await capabilities;if(id!==serial)return;
    reportView=createReportView(result,data,{
      canResearch:available.evidenceResearch,
      onCheck:researchClaims,
      onEdit:()=>{if(workKind==='evidence'){cancelWork();status.textContent='Checking stopped because a claim changed. Your edits are kept.';}},
      onCancel:()=>{cancelWork();status.textContent='Checking stopped. You can edit your claims and try again.';}
    });
    status.textContent=`${data.claims.length} claim${data.claims.length===1?'':'s'} ready. Review the wording and types, then choose Check claims & sources.`;
    if(!automatic)result.scrollIntoView({behavior:'smooth',block:'start'});
  } catch(error) {
    if(id!==serial)return;
    const message=error.name==='AbortError'?'Finding claims took too long. Your transcript is kept; try again.':error.message;
    showClaimState('Your words are still here.',message);status.textContent=message;
  } finally {
    clearTimeout(timeout);if(id===serial){controller=null;workKind=null;busy(false,status.textContent);}
  }
}
async function researchClaims(claims) {
  if(!reportView)return;
  const view=reportView,{id,signal}=startWork('evidence');view.start();busy(true,'Checking sources for each claim. Results will appear as they finish…');
  // Individual requests have a 110-second deadline; edits and Stop checking abort the batch.
  try {
    await checkClaims(claims,{sourceUrl:reelUrl,signal,onResult:(claimId,response)=>{if(id===serial&&view===reportView)view.result(claimId,response);}});
    if(id===serial)status.textContent='Evidence report complete. Review the sources, dates and limits on each claim.';
  } catch(error) {
    if(id===serial){view.stop();status.textContent=error.name==='AbortError'?'Some checks timed out. Completed results are kept; you can try again.':error.message;}
  } finally {
    if(id===serial){view.finish();controller=null;workKind=null;busy(false,status.textContent);}
  }
}
form.addEventListener('submit',e=>{e.preventDefault();findClaims();});
cryptoButton.addEventListener('click',checkCrypto);
input.addEventListener('input',()=>{
  count();
  if(workKind||reportView) {
    const transcribing=workKind==='reel'||workKind==='recording';cancelWork();
    if(transcribing&&reelUrl){reelMessage.textContent='Stopped waiting for transcription because you’re editing. Your words will be kept.';retryReel.hidden=false;}
    showClaimState('Your words have changed.','Choose Find claims again to update the draft claims from this text.');
    status.textContent='Your edits are kept. Choose Find claims when ready.';
  }
});
input.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();findClaims();}});
for(const chip of document.querySelectorAll('[data-sample]'))chip.addEventListener('click',()=>{cancelWork();clearReel();reviewNotice.hidden=true;input.value=chip.dataset.sample;count();findClaims();});
document.querySelector('#recording').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  cancelWork();
  if(file.size>4000000){status.textContent='Choose a recording smaller than 4 MB.';e.target.value='';return;}
  const {id,signal}=startWork('recording');reviewNotice.hidden=true;
  transcriptWork.hidden=false;transcriptProgress.textContent='Transcribing your recording with ElevenLabs…';
  showClaimState('Getting the words.','You’ll review the recording’s transcript before checking a prediction.');
  const currentController=controller,timeout=setTimeout(()=>currentController.abort(),60000);
  try {
    const data=await request('','/api/transcribe',file,{signal});if(id!==serial)return;
    if(typeof data.text!=='string'||!data.text.trim())throw new Error('No spoken words were found. Paste or type the prediction.');
    reviewTranscript(data,'ElevenLabs');
  } catch(error) {
    if(id===serial){status.textContent=error.name==='AbortError'?'Transcription timed out. Try again or paste the prediction.':error.message;showClaimState('Add the words yourself.',status.textContent);}
  } finally {
    clearTimeout(timeout);if(id===serial){controller=null;workKind=null;transcriptWork.hidden=true;retryReel.disabled=false;}e.target.value='';
  }
});
function receiveIncomingShare(){const incoming=sharedInput(location);if(incoming===null)return;history.replaceState(null,'',location.pathname);receiveReel(incoming);}
async function loadCapabilities() {
  try {
    const response=await fetch('/api/capabilities',{signal:AbortSignal.timeout(8000)});if(!response.ok)return {};
    const available=await response.json();
    if(available.transcription===false){document.querySelector('#recording').disabled=true;document.querySelector('.upload-disclosure').textContent='Recording transcription with ElevenLabs is not enabled on this server yet. Paste or type the spoken prediction above.';}
    if(available.claimExtraction===true)document.querySelector('#evidence-disclosure').textContent='Transcript text is sent to Anthropic’s Claude to extract claims. Reviewed claims are sent to Claude for source research when you choose Check claims & sources.';
    if(available.evidenceResearch===false)document.querySelector('#evidence-disclosure').textContent='You can find and review claim drafts. Live source research isn’t available here yet; factual claims will stay unverified.';
    if(available.reelTranscription===false)document.querySelector('#reel-disclosure').textContent='Automatic Reel transcription with Supadata is not enabled on this server yet. You can still add a link and paste the spoken prediction.';
    return available;
  } catch{return {};}
}
const capabilities=loadCapabilities();
addEventListener('hashchange',receiveIncomingShare);receiveIncomingShare();
