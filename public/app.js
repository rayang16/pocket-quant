import {request,renderResult,node} from './ui.js';
import {downloadCard,shareCard} from './card.js';
import {parseSharedReel,sharedInput} from './shared-reel.js';
const form=document.querySelector('#check-form'),input=document.querySelector('#claim-text'),button=document.querySelector('#check-button'),status=document.querySelector('#status'),result=document.querySelector('#result');
let controller,serial=0;
const reelPanel=document.querySelector('#shared-reel');
function receiveReel(value) {
  const reel=parseSharedReel(value);
  if(reel.error){status.textContent=reel.error;return false;}
  controller?.abort();++serial;busy(false);result.classList.remove('loading');
  result.replaceChildren(node('span','eyebrow','REEL RECEIVED'),node('h2','state-title','What’s the prediction?'),node('p','result-explanation','The shared link is ready. Add the spoken claim to check it against live evidence.'));
  input.value='';count();reelPanel.hidden=false;document.querySelector('#reel-source').href=reel.url;
  document.querySelector('#reel-url').value=reel.url;
  status.textContent='Reel received. Paste or type the prediction to check it.';
  input.focus();return true;
}
document.querySelector('#reel-form').addEventListener('submit',e=>{e.preventDefault();receiveReel(document.querySelector('#reel-url').value);});
document.querySelector('#clear-reel').addEventListener('click',()=>{reelPanel.hidden=true;document.querySelector('#reel-source').removeAttribute('href');document.querySelector('#reel-url').value='';status.textContent='Reel removed.';});
function count(){document.querySelector('#char-count').textContent=`${input.value.length.toLocaleString()} / 6,000`;}
function busy(on,message='') {button.disabled=on;button.textContent=on?'Checking live evidence…':'Check the hype ↗';status.textContent=message;result.setAttribute('aria-busy',String(on));}
async function check() {
  if(/^\s*https?:\/\/\S+\s*$/.test(input.value)){receiveReel(input.value);return;}
  if(input.value.trim().length<3){status.textContent='Paste a prediction to check.';input.focus();return;}
  controller?.abort();controller=new AbortController();const id=++serial;
  busy(true,'Reading your claim and fetching Gemini prices…');result.classList.add('loading');
  result.replaceChildren(node('span','eyebrow','CHECKING LIVE EVIDENCE'),node('h2','state-title','Putting it to the test.'),node('p','result-explanation','Reading the claim, finding a market, and checking the volatility range.'));
  const timeout=setTimeout(()=>controller.abort(),60000);
  try {const data=await request('','/api/check',{text:input.value},{signal:controller.signal});if(id!==serial)return;
    renderResult(result,data,{download:r=>downloadCard(r).catch(e=>status.textContent=e.message),share:typeof navigator.share==='function'?r=>shareCard(r).catch(e=>{if(e.name!=='AbortError')status.textContent=e.message;}):undefined});status.textContent='Check complete. Read the matching conditions below.';
  }catch(e){if(id!==serial)return;const message=e.name==='AbortError'?'This check timed out. Please try again.':e.message;status.textContent=message;result.replaceChildren(node('span','eyebrow','CHECK UNAVAILABLE'),node('h2','state-title','No data. No verdict.'),node('p','result-explanation',message));}
  finally {clearTimeout(timeout);if(id===serial){busy(false,status.textContent);result.classList.remove('loading');}}
}
form.addEventListener('submit',e=>{e.preventDefault();check();});input.addEventListener('input',count);
input.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();check();}});
for(const chip of document.querySelectorAll('[data-sample]'))chip.addEventListener('click',()=>{reelPanel.hidden=true;input.value=chip.dataset.sample;count();check();});
document.querySelector('#recording').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(file.size>4000000){status.textContent='Choose a recording smaller than 4 MB.';e.target.value='';return;}
  controller?.abort();controller=new AbortController();const id=++serial;
  busy(true,'Transcribing your recording with ElevenLabs…');
  const timeout=setTimeout(()=>controller.abort(),60000);
  try{const data=await request('','/api/transcribe',file,{signal:controller.signal});if(id!==serial)return;clearTimeout(timeout);input.value=data.text;count();await check();}
  catch(err){if(id===serial)busy(false,err.name==='AbortError'?'Transcription timed out. Try again or paste the claim.':err.message);}
  finally{clearTimeout(timeout);e.target.value='';}});
function receiveIncomingShare(){const incoming=sharedInput(location);if(incoming===null)return;history.replaceState(null,'',location.pathname);receiveReel(incoming);}
addEventListener('hashchange',receiveIncomingShare);receiveIncomingShare();
async function showTranscriptionAvailability(){
  try{const response=await fetch('/api/capabilities');if(!response.ok)return;const available=await response.json();
    if(available.transcription===false){document.querySelector('#recording').disabled=true;document.querySelector('.upload-disclosure').textContent='Recording transcription is not enabled on this server yet. Paste or type the spoken prediction above.';}
  }catch{/* Keep uploads available if the capability check itself fails. */}
}
showTranscriptionAvailability();
