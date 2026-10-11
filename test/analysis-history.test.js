import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareSavedAnalysis,createAnalysisHistory,snapshotLabel,analysisUrl,analysisMarketUrl} from '../public/analysis-history.js';
import {WORKSPACE_KEY} from '../public/workspace-data.js';

const checkedAt='2026-10-11T12:00:00Z';
const snapshot=(changes={})=>({id:'saved-1',text:'Bitcoin might reach 150000.',reelUrl:'',addedAt:checkedAt,result:{checkedAt,verdict:'NO MATCH',message:'No Gemini market on this claim yet.'},...changes});
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.textContent='';this.value='';this.hidden=false;this.listeners={};this.attributes={};this.style={};this.classList={add:()=>{},remove:()=>{}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  setAttribute(key,value){this.attributes[key]=value;}
  removeAttribute(key){delete this.attributes[key];delete this[key];}
  addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);}
  async dispatch(type,event={}){return Promise.all((this.listeners[type]||[]).map(handler=>handler({preventDefault(){},...event})));}
  scrollIntoView(){}
  focus(){}
  setSelectionRange(){}
  set innerHTML(_value){throw new Error('History must render text, never HTML.');}
}
const textOf=element=>[element.textContent,...element.children.map(textOf)].join(' ');
const descendants=element=>[element,...element.children.flatMap(descendants)];
function mockDocument(){const elements=new Map();return {elements,createElement:tag=>new Element(tag),querySelector:selector=>{if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector);},querySelectorAll:()=>[]};}
async function environment(run,{entries=[snapshot()],fetchImpl,search='?analysis=saved-1'}={}) {
  const names=['document','sessionStorage','location','history','addEventListener','fetch'];
  const previous=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]),document=mockDocument(),stored=new Map([[WORKSPACE_KEY,JSON.stringify(entries)]]),calls=[];
  const values={document,sessionStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},location:{pathname:'/',search,hash:''},history:{replaceState:(_state,_unused,url)=>{values.location.search=new URL(url,'https://pocket.test').search;}},addEventListener:()=>{},fetch:async(url,options)=>{calls.push({url,options});if(url==='/api/capabilities')return {ok:true,json:async()=>({transcription:true,reelTranscription:true})};return fetchImpl(url,options);}};
  for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:values[name]});
  try{return await run({document,stored,calls});}finally{for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
}

test('saved snapshots canonicalize Reel sources and strip unsafe Gemini links at every depth',()=>{
  const entry=snapshot({reelUrl:'https://www.instagram.com/reel/ABC/?tracking=1',result:{checkedAt,verdict:'POSSIBLE MATCH',market:{url:'javascript:alert(1)'},matches:[{url:'https://gemini.com.evil.test/predictions/a'}],nested:{url:'https://www.gemini.com/predictions/real'}}});
  const safe=prepareSavedAnalysis(entry);
  assert.equal(safe.reelUrl,'https://www.instagram.com/reel/ABC/');assert.equal(safe.result.market.url,null);assert.equal(safe.result.matches[0].url,null);
  assert.equal(safe.result.nested.url,'https://www.gemini.com/predictions/real');assert.equal(entry.result.market.url,'javascript:alert(1)');
  assert.equal(prepareSavedAnalysis(snapshot({reelUrl:'javascript:alert(1)'})).reelUrl,'');
});

test('malformed entries, oversized snapshots, dates, and unsafe route IDs are not restored',()=>{
  for(const entry of [null,[],snapshot({id:'../bad'}),snapshot({id:'<script>'}),snapshot({addedAt:'yesterday'}),snapshot({text:'x'.repeat(6001)}),snapshot({result:[]}),snapshot({result:{verdict:'NO MATCH',checkedAt:'bad'}}),snapshot({result:{checkedAt,report:{claim:{text:'x'},assessment:{}}}})])assert.equal(prepareSavedAnalysis(entry),null);
  assert.equal(prepareSavedAnalysis(snapshot({result:{checkedAt,verdict:'NO MATCH',message:'x'.repeat(500001)}})),null);
  for(const id of ['javascript:alert(1)','../x','a?b=c','\ud800']){assert.equal(analysisUrl(id),null);assert.equal(analysisMarketUrl(id),null);}
  assert.equal(analysisMarketUrl('saved-1'),'/markets.html?check=saved-1');
});

test('history renders literal text and snapshot dates; restore clicks do not create requests',async()=>environment(async({document,calls})=>{
  const list=new Element(),count=new Element(),link=new Element(),restored=[];
  const entry=snapshot({text:'<img src=x onerror=alert(1)>'});
  const history=createAnalysisHistory({list,count,marketLink:link,read:()=>[entry],onRestore:id=>restored.push(id)});history.render();
  assert.equal(count.textContent,'1');assert.match(textOf(list),/Saved snapshot.*not live/);assert.match(textOf(list),/<img src=x/);
  assert.equal(list.children[0].href,'/?analysis=saved-1');await list.children[0].dispatch('click');assert.deepEqual(restored,['saved-1']);assert.equal(calls.length,0);
  assert.match(snapshotLabel(entry),/2026/);
}));

test('Gemini outages and storage failures do not expose a dashboard link for unsaved data',async()=>environment(async()=>{
  const link=new Element();let writes=0;
  const history=createAnalysisHistory({marketLink:link,read:()=>[],record:()=>{writes++;return {...snapshot(),persisted:false};}});
  assert.equal(history.save({report:{assessment:{status:'unavailable'}}}),null);assert.equal(writes,0);
  history.save(snapshot().result);assert.equal(link.hidden,true);assert.equal(link.href,undefined);
}));

test('query restore renders a saved result without a new analysis or transcription request',async()=>environment(async({document,calls})=>{
  await import(`../public/app.js?restore=${Date.now()}`);
  assert.deepEqual(calls.map(call=>call.url),['/api/capabilities']);
  assert.equal(document.querySelector('#claim-text').value,'Bitcoin might reach 150000.');
  assert.match(textOf(document.querySelector('#result')),/NO MATCH/);
  assert.match(document.querySelector('#review-notice').textContent,/Saved snapshot.*not live/);
  assert.equal(document.querySelector('#analysis-market-link').href,'/markets.html?check=saved-1');
}));

test('restoring history aborts active work and prevents its late result from being saved',async()=>{
  let finish,activeSignal;
  await environment(async({document,stored})=>{
    await import(`../public/app.js?cancel=${Date.now()}`);
    document.querySelector('#claim-text').value='New crypto prediction';
    const pending=document.querySelector('#crypto-check-button').dispatch('click');
    assert.ok(activeSignal);assert.equal(activeSignal.aborted,false);
    await document.querySelector('#analysis-history').children[0].dispatch('click');
    assert.equal(activeSignal.aborted,true);
    finish({ok:true,json:async()=>({checkedAt,verdict:'LATE RESULT',message:'Must not replace saved history.'})});await pending;
    assert.equal(JSON.parse(stored.get(WORKSPACE_KEY)).length,1);assert.equal(JSON.parse(stored.get(WORKSPACE_KEY))[0].text,'Bitcoin might reach 150000.');
    assert.match(textOf(document.querySelector('#result')),/NO MATCH/);assert.doesNotMatch(textOf(document.querySelector('#result')),/LATE RESULT/);
  },{search:'',fetchImpl:async(_url,{signal})=>{activeSignal=signal;return new Promise(resolve=>{finish=resolve;});}});
});

test('malformed nested snapshots fail safely while keeping text available to recheck',async()=>environment(async({document,calls})=>{
  await import(`../public/app.js?malformed=${Date.now()}`);
  assert.match(textOf(document.querySelector('#result')),/Saved analysis unavailable/);assert.equal(document.querySelector('#analysis-market-link').hidden,true);
  assert.equal(document.querySelector('#claim-text').value,'Bitcoin might reach 150000.');assert.equal(calls.length,1);
},{entries:[snapshot({result:{checkedAt,verdict:'HYPE',hypeVerdict:{},claim:{},market:{},model:{}}})]}));


test('restored claim reports disclose snapshot age and require a manual refresh',async()=>environment(async({document,calls})=>{
  await import(`../public/app.js?report=${Date.now()}`);
  const output=textOf(document.querySelector('#result'));
  assert.match(output,/Your saved Gemini report/);assert.match(output,/Saved snapshot.*not live/);assert.match(output,/Check with Gemini again to fetch fresh evidence/);
  assert.doesNotMatch(output,/checks start automatically|These drafts/);assert.equal(calls.length,1);
},{entries:[snapshot({result:{checkedAt,report:{checkedAt,claim:{id:'claim-1',text:'Bitcoin might reach 150000.',quote:'Bitcoin might reach 150000.',type:'forecast'},assessment:{status:'forecast',headline:'No exact market match.'},market:{matches:[]}}}})]}));
