import {request,renderResult,node} from './ui.js';
import {downloadCard,shareCard} from './card.js';
import {parseSharedReel,sharedInput} from './shared-reel.js';
import {getReelTranscript} from './reel-transcript.js';
import {extractClaims,checkClaims,createReportView} from './evidence-report.js';
import {createAnalysisHistory,snapshotLabel,analysisUrl} from './analysis-history.js';
import {reportWorkspaceResult} from './report-workspace.js';

const form=document.querySelector('#check-form'),input=document.querySelector('#claim-text'),button=document.querySelector('#check-button'),status=document.querySelector('#status'),result=document.querySelector('#result');
const reelPanel=document.querySelector('#shared-reel'),reelMessage=document.querySelector('#reel-message'),retryReel=document.querySelector('#retry-reel');
const transcriptWork=document.querySelector('#transcript-work'),transcriptProgress=document.querySelector('#transcript-progress'),reviewNotice=document.querySelector('#review-notice');
let controller,serial=0,workKind=null,reelUrl=null,reportView=null;
const cryptoButton=document.querySelector('#crypto-check-button');
const analysisHistory=createAnalysisHistory({list:document.querySelector('#analysis-history'),count:document.querySelector('#analysis-count'),marketLink:document.querySelector('#analysis-market-link'),onRestore:restoreAnalysis});

function count(){document.querySelector('#char-count').textContent=`${input.value.length.toLocaleString()} / 6,000`;}
function busy(on,message='') {
  button.disabled=on;button.textContent=on?(workKind==='extract'?'Finding claims…':'Checking Gemini…'):'Check with Gemini ↗';
  cryptoButton.disabled=on;
  status.textContent=message;result.setAttribute('aria-busy',String(on));
}
function cancelWork() {
  controller?.abort();controller=null;++serial;workKind=null;reportView?.stop();
  transcriptWork.hidden=true;retryReel.disabled=false;busy(false);result.classList.remove('loading');
}
function startWork(kind) {
  cancelWork();analysisHistory.hideMarket();controller=new AbortController();workKind=kind;
  retryReel.disabled=kind==='recording';
  return {id:serial,signal:controller.signal};
}
function showClaimState(title='What does the Reel claim?',message='Paste or type the spoken claims, then choose Check with Gemini. We’ll find the claims and run the checks for you.') {
  analysisHistory.hideMarket();reportView=null;result.classList.remove('evidence-report');result.replaceChildren(node('span','eyebrow','REVIEW THE CLAIM'),node('h2','state-title',title),node('p','result-explanation',message));
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
  reviewNotice.textContent=`${truncated?'Only the first 6,000 characters are shown. ':''}Transcript from ${provider}. We’ll automatically find up to three claims, check Gemini markets, and run crypto math where supported. You can correct names, numbers and dates at any time; editing stops the current check.`;
  reviewNotice.hidden=false;
  input.setSelectionRange(0,0);input.scrollTop=0;
  findClaims({automatic:true});
}

async function transcribeReel(url,{automatic=false}={}) {
  const {id,signal}=startWork('reel');reviewNotice.hidden=true;retryReel.hidden=true;
  transcriptWork.hidden=false;transcriptProgress.textContent=automatic?'Checking Reel transcription availability…':'Getting the Reel’s spoken words…';
  reelMessage.textContent='Public Reel links are sent to Supadata for transcription. You can stop waiting and type the prediction yourself.';
  showClaimState('Getting the words.','We’ll load the transcript, find up to three claims, and check Gemini automatically.');
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
    reelMessage.textContent='Transcript received from Supadata. Finding claims and checking Gemini automatically.';
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
    saveAnalysis(data,input.value);
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
  busy(true,automatic?'Transcript ready. Finding up to three claims to check…':'Finding up to three claims to check…');
  showClaimState('Pulling out the claims.','Next, we’ll check Gemini markets and run any supported crypto math automatically. You can edit the claims at any time.');
  const currentController=controller,timeout=setTimeout(()=>currentController.abort(),60000);
  try {
    const data=await extractClaims(input.value,{sourceUrl:reelUrl,signal});if(id!==serial)return;
    reportView=createReportView(result,data,{
      onCheck:checkGeminiClaims,
      onEdit:()=>{analysisHistory.hideMarket();if(workKind==='evidence'){cancelWork();status.textContent='Checking stopped because a claim changed. Your edits are kept.';}},
      onCancel:()=>{cancelWork();status.textContent='Checking stopped. You can edit your claims and try again.';}
    });
    if(!automatic)result.scrollIntoView({behavior:'smooth',block:'start'});
    // Hand off immediately. The new work ID keeps extraction cleanup from clearing a running report.
    clearTimeout(timeout);
    await checkGeminiClaims(data.claims);
  } catch(error) {
    if(id!==serial)return;
    const message=error.name==='AbortError'?'Finding claims took too long. Your transcript is kept; try again.':error.message;
    showClaimState('Your words are still here.',message);status.textContent=message;
  } finally {
    clearTimeout(timeout);if(id===serial){controller=null;workKind=null;busy(false,status.textContent);}
  }
}
async function checkGeminiClaims(claims) {
  if(!reportView)return;
  const view=reportView,{id,signal}=startWork('evidence');view.start();busy(true,'Checking Gemini Exchange markets for each claim. Results will appear as they finish…');
  // Individual requests have a 110-second deadline; edits and Stop checking abort the batch.
  try {
    await checkClaims(claims,{sourceUrl:reelUrl,signal,onResult:(claimId,response)=>{if(id===serial&&view===reportView){view.result(claimId,response);if(response.data)saveAnalysis(reportWorkspaceResult(response.data),response.data.claim.text);}}});
    if(id===serial)status.textContent='Gemini market report complete. Compare the exact targets, deadlines and limits on each claim.';
  } catch(error) {
    if(id===serial){view.stop();status.textContent=error.name==='AbortError'?'Some checks timed out. Completed results are kept; you can try again.':error.message;}
  } finally {
    if(id===serial){view.finish();controller=null;workKind=null;busy(false,status.textContent);}
  }
}
form.addEventListener('submit',e=>{e.preventDefault();findClaims();});
cryptoButton.addEventListener('click',checkCrypto);
input.addEventListener('input',()=>{
  count();analysisHistory.hideMarket();
  if(workKind||reportView) {
    const transcribing=workKind==='reel'||workKind==='recording';cancelWork();
    if(transcribing&&reelUrl){reelMessage.textContent='Stopped waiting for transcription because you’re editing. Your words will be kept.';retryReel.hidden=false;}
    showClaimState('Your words have changed.','Choose Check with Gemini to find and check the claims in your edited text.');
    status.textContent='Your edits are kept. Choose Check with Gemini when ready.';
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
  showClaimState('Getting the words.','We’ll transcribe the recording, find its claims, and check Gemini automatically.');
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
function receiveIncomingShare(){const incoming=sharedInput(location);if(incoming===null)return false;history.replaceState(null,'',location.pathname);receiveReel(incoming);return true;}
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
addEventListener('hashchange',receiveIncomingShare);
analysisHistory.render();
if(!receiveIncomingShare())restoreAnalysis();
addEventListener('pagehide',cancelWork);


function saveAnalysis(data,text) {
  return analysisHistory.save(data,{text,reelUrl:reelUrl||''});
}
function restoreAnalysis(requestedId) {
  const id=typeof requestedId==='string'?requestedId:new URLSearchParams(location.search).get('analysis');
  if(!id)return false;
  cancelWork();clearReel();analysisHistory.hideMarket();reviewNotice.hidden=true;
  const entry=analysisHistory.find(id);
  if(!entry){showClaimState('Saved analysis unavailable.','This snapshot is missing or no longer readable. Paste a claim to check again.');status.textContent='This analysis is no longer saved in this browser session.';return false;}
  input.value=entry.text;count();
  if(entry.reelUrl) {
    reelUrl=entry.reelUrl;reelPanel.hidden=false;document.querySelector('#reel-source').href=reelUrl;
    document.querySelector('#reel-url').value=reelUrl;reelMessage.textContent='Saved Reel source. No transcription has been requested.';
    retryReel.hidden=false;retryReel.textContent='Get transcript again';
  }
  try {
    const report=entry.result.report;
    if(report) {
      reportView=createReportView(result,{claims:[report.claim],extraction:'saved',checkedAt:report.checkedAt||entry.result.checkedAt}, {
        onCheck:checkGeminiClaims,
        onEdit:()=>{cancelWork();analysisHistory.hideMarket();reviewNotice.hidden=true;status.textContent='Claim edited. Check with Gemini again to update its evidence.';},
        onCancel:()=>{cancelWork();status.textContent='Checking stopped. Your saved snapshot is kept.';}
      });
      reportView.result(report.claim.id,{data:report});reportView.finish();
    } else {
      reportView=null;result.classList.remove('evidence-report');
      renderResult(result,entry.result,{download:r=>downloadCard(r).catch(e=>status.textContent=e.message),share:typeof navigator.share==='function'?r=>shareCard(r).catch(e=>{if(e.name!=='AbortError')status.textContent=e.message;}):undefined});
    }
  } catch {
    showClaimState('Saved analysis unavailable.','This snapshot uses an unsupported format. Your words are kept; check again for fresh results.');
    status.textContent='The saved result could not be restored. No new check was sent.';return false;
  }
  reviewNotice.textContent=`${snapshotLabel(entry)}. Choose Check with Gemini to fetch fresh evidence.`;reviewNotice.hidden=false;
  status.textContent=snapshotLabel(entry);analysisHistory.showMarket(entry);analysisHistory.render(entry.id);
  history.replaceState(null,'',analysisUrl(entry.id));return true;
}
