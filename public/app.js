import {request,renderResult,node} from './ui.js';
import {downloadCard,shareCard} from './card.js';
import {parseSharedReel,sharedInput} from './shared-reel.js';
import {getReelTranscript} from './reel-transcript.js';

const form=document.querySelector('#check-form'),input=document.querySelector('#claim-text'),button=document.querySelector('#check-button'),status=document.querySelector('#status'),result=document.querySelector('#result');
const reelPanel=document.querySelector('#shared-reel'),reelMessage=document.querySelector('#reel-message'),retryReel=document.querySelector('#retry-reel');
const transcriptWork=document.querySelector('#transcript-work'),transcriptProgress=document.querySelector('#transcript-progress'),reviewNotice=document.querySelector('#review-notice');
let controller,serial=0,workKind=null,reelUrl=null;

function count(){document.querySelector('#char-count').textContent=`${input.value.length.toLocaleString()} / 6,000`;}
function busy(on,message='') {
  button.disabled=on;button.textContent=on?'Checking live evidence…':'Check the hype ↗';
  status.textContent=message;result.setAttribute('aria-busy',String(on));
}
function cancelWork() {
  controller?.abort();controller=null;++serial;workKind=null;
  transcriptWork.hidden=true;retryReel.disabled=false;busy(false);result.classList.remove('loading');
}
function startWork(kind) {
  cancelWork();controller=new AbortController();workKind=kind;
  retryReel.disabled=kind==='recording';
  return {id:serial,signal:controller.signal};
}
function showClaimState(title='What’s the prediction?',message='Paste or type one prediction from the Reel to check it against live evidence.') {
  result.replaceChildren(node('span','eyebrow','REVIEW THE CLAIM'),node('h2','state-title',title),node('p','result-explanation',message));
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
  reviewNotice.textContent=truncated
    ?`Only the first 6,000 characters of this ${provider} transcript are shown. Select one prediction, check names, prices and dates against the Reel, then choose Check the hype.`
    :`Transcript from ${provider}. Select one prediction and correct any mistakes in names, prices or dates before choosing Check the hype. Nothing has been analyzed yet.`;
  reviewNotice.hidden=false;button.textContent='Check the hype ↗';
  showClaimState('Check the words first.','The transcript is ready to edit. Keep one prediction, confirm the details, then choose Check the hype.');
  status.textContent=truncated?'Transcript ready, shortened to 6,000 characters. Review and select one prediction.':'Transcript ready. Review the words and select one prediction before checking.';
  input.focus();
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
    reelMessage.textContent='Transcript received from Supadata. Review it below and keep one prediction to check.';
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

async function check() {
  if(/^\s*https?:\/\/\S+\s*$/.test(input.value)){receiveReel(input.value);return;}
  cancelWork();
  if(input.value.trim().length<3){status.textContent='Paste a prediction to check.';input.focus();return;}
  const {id,signal}=startWork('check');reviewNotice.hidden=true;
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
form.addEventListener('submit',e=>{e.preventDefault();check();});
input.addEventListener('input',()=>{
  count();
  if(workKind==='reel'||workKind==='recording') {
    cancelWork();if(reelUrl)manualReel('Stopped waiting for transcription because you’re editing the claim. Your words will be kept.');
    else showClaimState();
    status.textContent='Your words will be kept. Finish editing, then choose Check the hype.';
  }
});
input.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();check();}});
for(const chip of document.querySelectorAll('[data-sample]'))chip.addEventListener('click',()=>{cancelWork();clearReel();reviewNotice.hidden=true;input.value=chip.dataset.sample;count();check();});
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
    if(available.reelTranscription===false)document.querySelector('#reel-disclosure').textContent='Automatic Reel transcription with Supadata is not enabled on this server yet. You can still add a link and paste the spoken prediction.';
    return available;
  } catch{return {};}
}
const capabilities=loadCapabilities();
addEventListener('hashchange',receiveIncomingShare);receiveIncomingShare();
