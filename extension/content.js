(()=>{
  if(globalThis.__pocketQuantLoaded)return;globalThis.__pocketQuantLoaded=true;
  const clean=s=>s.replace(/\b[\d.,]+\s*[km]?\s*(?:likes?|views?|comments?|followers?)\b/gi,' ').replace(/\b(?:follow|following|like|reply|share|more|save|send|view all comments|original audio)\b/gi,' ').replace(/\s+/g,' ').trim();
  function read() {
    const videos=[...document.querySelectorAll('video')].map(video=>{const r=video.getBoundingClientRect();return {video,area:Math.max(0,Math.min(r.right,innerWidth)-Math.max(0,r.left))*Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(0,r.top))};}).filter(v=>v.area>0).sort((a,b)=>b.area-a.area);
    const video=videos[0]?.video;if(!video)return {text:'',handle:'',url:location.href};
    let parent=video.parentElement,chosen=null;
    for(let i=0;parent&&i<12;i++,parent=parent.parentElement){const text=clean(parent.innerText||'');if(text.length>=40&&text.length<=2000){chosen=parent;break;}}
    if(!chosen)return {text:'',handle:'',url:location.href};
    const profile=[...chosen.querySelectorAll('a[href]')].find(a=>/^\/[A-Za-z0-9_.]+\/?$/.test(a.getAttribute('href'))&&!['/reels/','/explore/','/direct/'].includes(a.getAttribute('href')));
    const reel=chosen.querySelector('a[href*="/reel/"]');
    return {text:clean(chosen.innerText).slice(0,2000),handle:profile?'@'+profile.getAttribute('href').split('/').filter(Boolean)[0]:'',url:reel?.href||location.href};
  }
  chrome.runtime.onMessage.addListener((m,_sender,reply)=>{if(m.type==='read-reel')reply(read());});
  let timer,last='';
  const notify=()=>{clearTimeout(timer);timer=setTimeout(()=>{const reel=read(),key=reel.url+'|'+reel.text;if(key===last)return;last=key;chrome.runtime.sendMessage({type:'reel-changed',reel}).catch(()=>{});},800);};
  new MutationObserver(notify).observe(document.body,{childList:true,subtree:true,characterData:true});
  addEventListener('scroll',notify,{passive:true,capture:true});addEventListener('popstate',notify);
  let href=location.href;setInterval(()=>{if(location.href!==href){href=location.href;notify();}},1000);notify();
})();
