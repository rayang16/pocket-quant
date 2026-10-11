import {request,renderResult,node} from './ui.js';
import {downloadCard} from './card.js';
const form=document.querySelector('#check-form'),input=document.querySelector('#claim-text'),button=document.querySelector('#check-button'),status=document.querySelector('#status'),result=document.querySelector('#result');
let controller,serial=0;
function count(){document.querySelector('#char-count').textContent=`${input.value.length.toLocaleString()} / 6,000`;}
function busy(on,message='') {button.disabled=on;button.textContent=on?'Checking live evidence…':'Check the hype ↗';status.textContent=message;result.setAttribute('aria-busy',String(on));}
async function check() {
  if(input.value.trim().length<3){status.textContent='Paste a prediction to check.';input.focus();return;}
  controller?.abort();controller=new AbortController();const id=++serial;
  busy(true,'Reading your claim and fetching Gemini prices…');result.classList.add('loading');
  result.replaceChildren(node('span','eyebrow','CHECKING LIVE EVIDENCE'),node('h2','state-title','Putting it to the test.'),node('p','result-explanation','Reading the claim, finding a market, and checking the volatility range.'));
  const timeout=setTimeout(()=>controller.abort(),60000);
  try {const data=await request('','/api/check',{text:input.value},{signal:controller.signal});if(id!==serial)return;
    renderResult(result,data,{download:r=>downloadCard(r).catch(e=>status.textContent=e.message)});status.textContent='Check complete. Read the matching conditions below.';
  }catch(e){if(id!==serial)return;const message=e.name==='AbortError'?'This check timed out. Please try again.':e.message;status.textContent=message;result.replaceChildren(node('span','eyebrow','CHECK UNAVAILABLE'),node('h2','state-title','No data. No verdict.'),node('p','result-explanation',message));}
  finally {clearTimeout(timeout);if(id===serial){busy(false,status.textContent);result.classList.remove('loading');}}
}
form.addEventListener('submit',e=>{e.preventDefault();check();});input.addEventListener('input',count);
input.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();check();}});
for(const chip of document.querySelectorAll('[data-sample]'))chip.addEventListener('click',()=>{input.value=chip.dataset.sample;count();check();});
document.querySelector('#recording').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(file.size>4000000){status.textContent='Choose a recording smaller than 4 MB.';e.target.value='';return;}
  controller?.abort();++serial;busy(true,'Transcribing your recording with ElevenLabs…');try{const data=await request('','/api/transcribe',file);input.value=data.text;count();await check();}catch(err){busy(false,err.message);}finally{e.target.value='';}});
