import {node} from './ui.js';
import {geminiMarketUrl} from './evidence-report.js';
import {parseSharedReel} from './shared-reel.js';
import {readChecks,recordCheck} from './workspace-data.js';

const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
export const analysisUrl=id=>validId(id)?`/?analysis=${encodeURIComponent(id)}`:null;
export const analysisMarketUrl=id=>validId(id)?`/markets.html?check=${encodeURIComponent(id)}`:null;
export function snapshotLabel(entry) {
  const value=entry?.result?.checkedAt||entry?.addedAt;
  const date=new Date(value);
  return Number.isFinite(date.getTime())?`Saved snapshot · ${date.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})} · not live`:'Saved snapshot · not live';
}

// Session storage can be edited or contain an older schema. Never restore raw hrefs.
export function prepareSavedAnalysis(entry) {
  try {
    if(!object(entry)||!validId(entry.id)||typeof entry.text!=='string'||entry.text.length>6000||!object(entry.result))return null;
    const encoded=JSON.stringify(entry);if(encoded.length>500000)return null;
    const safe=JSON.parse(encoded);
    if(!Number.isFinite(Date.parse(safe.addedAt))||!Number.isFinite(Date.parse(safe.result.checkedAt)))return null;
    const scrub=(value,depth=0)=>{
      if(depth>30)throw new Error('Invalid snapshot');
      if(Array.isArray(value)){for(const item of value)scrub(item,depth+1);return;}
      if(!object(value))return;
      for(const key of Object.keys(value)) {
        if(key==='url')value[key]=geminiMarketUrl(value[key]);
        else scrub(value[key],depth+1);
      }
    };
    scrub(safe.result);
    const report=safe.result.report;
    if(report!==undefined) {
      if(!object(report)||!object(report.claim)||typeof report.claim.id!=='string'||typeof report.claim.text!=='string'||!report.claim.text.trim()||!object(report.assessment))return null;
      if(!['fact','forecast','recommendation'].includes(report.claim.type))return null;
    } else if(typeof safe.result.verdict!=='string')return null;
    safe.reelUrl=typeof safe.reelUrl==='string'?(parseSharedReel(safe.reelUrl).url||''):'';
    return safe;
  } catch{return null;}
}

export function createAnalysisHistory({list,count,marketLink,onRestore=()=>{},read=readChecks,record=recordCheck}={}) {
  let storageAvailable=true;
  const hideMarket=()=>{if(marketLink){marketLink.hidden=true;marketLink.removeAttribute('href');}};
  function showMarket(entry) {
    hideMarket();
    const href=analysisMarketUrl(entry?.id);
    if(marketLink&&href&&storageAvailable&&entry?.persisted!==false){marketLink.href=href;marketLink.hidden=false;}
  }
  function entries(){try{return read().map(prepareSavedAnalysis).filter(Boolean).slice(0,30);}catch{return [];}}
  function render(selectedId) {
    const checks=entries();
    if(count)count.textContent=String(checks.length);
    if(!list)return;
    list.replaceChildren();
    if(!storageAvailable)list.append(node('p','history-empty','Browser storage is unavailable. Results stay on this page and cannot carry into Markets.'));
    if(!checks.length){list.append(node('p','history-empty','Completed checks appear here for this browser session.'));return;}
    for(const entry of checks) {
      const item=node('a','analysis-history-item',entry.text||'Saved analysis');item.href=analysisUrl(entry.id);
      if(selectedId===entry.id)item.classList.add('is-selected');
      item.append(node('span','',snapshotLabel(entry)));
      item.addEventListener('click',event=>{
        if(event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
        event.preventDefault();onRestore(entry.id);
      });
      list.append(item);
    }
  }
  return {
    render,hideMarket,showMarket,
    find(id){return validId(id)?entries().find(entry=>entry.id===id)||null:null;},
    save(data,options) {
      // A fulfilled HTTP request can still report a Gemini outage. Keep history useful.
      if(!object(data)||data.report?.assessment?.status==='unavailable')return null;
      let entry;try{entry=record(data,options);}catch{return null;}
      if(!entry)return null;
      storageAvailable=entry.persisted!==false;showMarket(entry);render(entry.id);return entry;
    }
  };
}
