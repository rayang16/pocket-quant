import {DEFAULT_API_BASE} from './config.js';
import {request,renderResult,node} from './ui.js';
import {downloadCard} from './card.js';
const $=s=>document.querySelector(s),status=$('#status'),input=$('#paste'),result=$('#result');
let base=DEFAULT_API_BASE,handle='',currentUrl='',generation=0,controller,recording=false,lastAuto='',pendingAuto=null;
const saved=await chrome.storage.local.get(['apiBase','auto']);base=saved.apiBase||base;$('#api-base').value=base;$('#auto').checked=!!saved.auto;
function report(message){status.textContent=message;}
function busy(on){$('#check').disabled=on;$('#read').disabled=on;result.setAttribute('aria-busy',String(on));}
async function activeTab(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return tab;}
async function check(text){if(text.trim().length<3){report('Paste a prediction first.');return;}
  controller?.abort();controller=new AbortController();const id=++generation;busy(true);report('Checking live Gemini evidence…');
  result.replaceChildren(node('span','eyebrow','CHECKING LIVE EVIDENCE'));
  const timer=setTimeout(()=>controller.abort(),60000);
  try{const data=await request(base,'/api/check',{text},{signal:controller.signal});if(id!==generation)return;
    const checkedHandle=handle;renderResult(result,data,{download:r=>downloadCard(r,checkedHandle).catch(e=>report(e.message))});report('Check complete.');
  }catch(e){if(id!==generation)return;report(e.name==='AbortError'?'Check timed out. Try again.':e.message);result.replaceChildren(node('h2','state-title','No data. No verdict.'),node('p','result-explanation','Check the server connection or paste another claim.'));}
  finally{clearTimeout(timer);if(id===generation)busy(false);}
}
async function useReel(reel,auto=false){if(!reel?.text){report('Couldn’t read this Reel — paste the claim instead.');return;}
  if(auto&&recording){pendingAuto=reel;return;}
  const key=reel.url+'|'+reel.text;if(auto&&key===lastAuto)return;lastAuto=key;input.value=reel.text;handle=reel.handle||'';currentUrl=reel.url;$('#source').textContent=handle?`From ${handle}`:'Visible Reel caption';await check(reel.text);
}
async function readReel(){try{const tab=await activeTab();if(!tab?.url?.startsWith('https://www.instagram.com/')){report('Open an Instagram Reel, or paste the claim instead.');return;}
  let reel;try{reel=await chrome.tabs.sendMessage(tab.id,{type:'read-reel'});}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});reel=await chrome.tabs.sendMessage(tab.id,{type:'read-reel'});}await useReel(reel);
}catch{report('Couldn’t read this Reel — paste the claim instead.');}}
$('#read').addEventListener('click',readReel);$('#paste-form').addEventListener('submit',e=>{e.preventDefault();handle='';$('#source').textContent='Pasted claim';check(input.value);});
$('#auto').addEventListener('change',async e=>{await chrome.storage.local.set({auto:e.target.checked});if(e.target.checked)readReel();else{pendingAuto=null;report('Auto is off.');}});
chrome.runtime.onMessage.addListener((m,sender)=>{if(m.type==='reel-changed'&&$('#auto').checked)activeTab().then(tab=>{if(tab?.id===sender.tab?.id)useReel(m.reel,true);}).catch(()=>{});});
chrome.tabs.onActivated.addListener(()=>{if($('#auto').checked)readReel();});
$('#save').addEventListener('click',async()=>{try{const url=new URL($('#api-base').value.trim());if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Use HTTPS, or HTTP on localhost.');if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Enter only the server origin, without credentials or a path.');
  const granted=await chrome.permissions.request({origins:[url.origin+'/*']});if(!granted)throw new Error('Connection permission was not granted.');base=url.origin;await chrome.storage.local.set({apiBase:base});report('Connection saved.');}catch(e){report(e.message);}});
$('#listen').addEventListener('click',async()=>{
  if(recording)return;recording=true;$('#listen').disabled=true;controller?.abort();++generation;
  let stream,audio,recorder,timer;
  try{const tab=await activeTab();if(!tab?.url?.startsWith('https://www.instagram.com/'))throw new Error('Open an Instagram Reel before listening.');
    const id=await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
    stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:id}},video:false});
    audio=new AudioContext();audio.createMediaStreamSource(stream).connect(audio.destination);await audio.resume();
    const chunks=[];recorder=new MediaRecorder(stream,{mimeType:'audio/webm',audioBitsPerSecond:64000});
    const blob=await new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=()=>reject(new Error('Recording failed. Paste the claim instead.'));recorder.onstop=()=>resolve(new Blob(chunks,{type:'audio/webm'}));recorder.start();report('Listening to this Reel for 12 seconds…');timer=setTimeout(()=>{if(recorder.state!=='inactive')recorder.stop();},12000);});
    stream.getTracks().forEach(t=>t.stop());await audio.close();audio=null;
    report('Transcribing with ElevenLabs…');const transcript=await request(base,'/api/transcribe',blob);input.value=transcript.text;handle='';$('#source').textContent='Transcribed tab audio';await check(transcript.text);
  }catch(e){report(`${e.message} Click the extension icon on this tab to grant access, or paste the claim.`);busy(false);}
  finally{clearTimeout(timer);if(recorder?.state==='recording')recorder.stop();stream?.getTracks().forEach(t=>t.stop());if(audio)await audio.close();recording=false;$('#listen').disabled=false;if(pendingAuto&&$('#auto').checked){const reel=pendingAuto;pendingAuto=null;useReel(reel,true);}}
});
if($('#auto').checked)readReel();
