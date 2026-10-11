import test from 'node:test';
import assert from 'node:assert/strict';
import {assessmentFor,geminiMarketUrl,normalizeDrafts,extractClaims,checkClaims,createReportView} from '../public/evidence-report.js';

const claim={id:'claim-1',text:'Tesla expects production to increase in 2027.',quote:'Tesla expects production to increase in 2027.',type:'forecast'};
const extracted={claims:[claim],extraction:'rules',warnings:[]};
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.textContent='';this.classList={add:()=>{}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  setAttribute(){}
  addEventListener(){}
  set innerHTML(_value){throw new Error('Report content must be rendered as plain text.');}
}
const textOf=element=>[element.textContent,...element.children.map(textOf)].join(' ');
const elementsOf=element=>[element,...element.children.flatMap(elementsOf)];
function withDocument(run) {
  const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
  try {return run();} finally {if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
}
function renderReport(data,extraction=extracted) {
  const container=new Element('section'),view=createReportView(container,extraction);
  view.result('claim-1',{data});return container;
}

test('related market actions explicitly carry the chosen outcome without treating odds as an order price',()=>withDocument(()=>{
  const container=renderReport({claim,assessment:{status:'forecast'},market:{matches:[{title:'Optimus released?',url:'https://www.gemini.com/predictions/optimus-release',contracts:[{symbol:'GEMI-OPTIMUS',label:'YES',prob:.99}]}]}});
  const links=elementsOf(container).filter(element=>element.href?.startsWith('/live.html'));
  assert.equal(links.length,2);
  for(const [index,outcome] of ['yes','no'].entries()) {
    assert.equal(links[index].textContent,`Prepare ${outcome.toUpperCase()} trade ↗`);
    assert.equal(links[index].href,`/live.html?symbol=GEMI-OPTIMUS&outcome=${outcome}&spendLimit=2.00`);
  }
}));

test('forecast and recommendation cards never become factual verdicts',()=>{
  for(const status of ['supported','contradicted','mixed','unverified']) {
    assert.equal(assessmentFor(claim,{status}).status,'forecast');
    assert.equal(assessmentFor({...claim,type:'recommendation'},{status}).status,'opinion');
  }
  assert.equal(assessmentFor({...claim,type:'fact'},{status:'supported'}).label,'Not market-verifiable');
  assert.equal(assessmentFor({...claim,type:'fact'},{status:'invented'}).status,'not_market_verifiable');
});

test('market links only open official Gemini prediction pages',()=>{
  assert.equal(geminiMarketUrl('https://www.gemini.com/predictions/btc-price'),'https://www.gemini.com/predictions/btc-price');
  for(const value of ['https://example.com/','https://www.sec.gov/Archives/test','https://gemini.com.evil.com/predictions/btc','https://www.gemini.com/settings/','javascript:alert(1)','data:text/html,test','http://example.com/','https://localhost/','https://x.local/','https://x.internal/','https://127.0.0.1/','https://0177.0.0.1/','https://10.0.0.1/','https://[::1]/','https://a:b@example.com/','https://example.com:3000/','/relative'])assert.equal(geminiMarketUrl(value),null,value);
});

test('claim extraction is separate from Gemini lookup and is limited to transcript length',async()=>{
  const calls=[];
  const data=await extractClaims('x'.repeat(6100),{sourceUrl:'https://www.instagram.com/reel/test/',send:async(...args)=>{calls.push(args);return extracted;}});
  assert.equal(calls.length,1);assert.equal(calls[0][1],'/api/evidence-report?action=extract');
  assert.equal(calls[0][2].text.length,6000);assert.equal(calls[0][2].sourceUrl,'https://www.instagram.com/reel/test/');
  assert.equal(data.claims[0].text,claim.text);
});

test('drafts preserve original quotes, cap at three, and reject unusable extraction',()=>{
  assert.equal(normalizeDrafts({...extracted,claims:Array.from({length:5},(_,i)=>({...claim,id:`claim-${i}`}))}).claims.length,3);
  assert.equal(normalizeDrafts(extracted).claims[0].quote,claim.quote);
  assert.throws(()=>normalizeDrafts({claims:[]}),/No clear claims/);
  assert.throws(()=>normalizeDrafts({}),/No claims were returned/);
});

test('editing or replacing the transcript suppresses a late extraction even if the server ignores cancellation',async()=>{
  const controller=new AbortController();let finish;
  const pending=extractClaims(claim.text,{signal:controller.signal,send:()=>new Promise(resolve=>{finish=resolve;})});
  controller.abort();finish(extracted);
  await assert.rejects(pending,{name:'AbortError'});
});

test('individual Gemini lookup failures do not discard successful claim cards',async()=>{
  const updates=[];
  const results=await checkClaims([claim,{...claim,id:'claim-2'},{...claim,id:'claim-3'}],{
    onResult:(id,value)=>updates.push({id,...value}),
    send:async(_base,path,{claim:input})=>{assert.equal(path,'/api/evidence-report?action=check');if(input.id==='claim-2')throw new Error('Gemini lookup unavailable.');return {claim:input,assessment:{status:'forecast'}};}
  });
  assert.equal(results.length,3);assert.equal(updates.length,3);
  assert.equal(updates.find(v=>v.id==='claim-2').error,'Gemini lookup unavailable.');
  assert.equal(updates.filter(v=>v.data).length,2);
});

test('edited claims cancel every late card update even when transport ignores abort',async()=>{
  const controller=new AbortController(),finishes=[],updates=[];
  const pending=checkClaims([claim,{...claim,id:'claim-2'}],{signal:controller.signal,onResult:(...args)=>updates.push(args),send:()=>new Promise(resolve=>finishes.push(resolve))});
  controller.abort();finishes.forEach(finish=>finish({assessment:{status:'supported'}}));
  await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(updates,[]);
});

test('checks snapshot claim edits and never send more than three claims',async()=>{
  const original={...claim},bodies=[];
  await checkClaims([original,...Array.from({length:4},(_,i)=>({...claim,id:`other-${i}`}))],{send:async(_base,_path,body)=>{bodies.push(body);original.text='changed';return {};}});
  assert.equal(bodies.length,3);assert.equal(bodies[0].claim.text,claim.text);
});

test('already cancelled work never sends a transcript or claims',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const options={signal:controller.signal,send:async()=>{calls++;return extracted;}};
  await assert.rejects(extractClaims(claim.text,options),{name:'AbortError'});
  await assert.rejects(checkClaims([claim],options),{name:'AbortError'});
  assert.equal(calls,0);
});

test('server-corrected claim types and assessment labels override mislabeled factual drafts',()=>{
  const draft={...claim,type:'fact'};
  assert.equal(assessmentFor(draft,{status:'supported'},{type:'forecast'}).status,'forecast');
  assert.equal(assessmentFor(draft,{status:'supported'},{type:'recommendation'}).status,'opinion');
  assert.equal(assessmentFor(draft,{status:'forecast'},{type:'fact'}).claimType,'forecast');
  assert.equal(assessmentFor(draft,{status:'opinion'},{type:'fact'}).claimType,'recommendation');
  // Conservative draft types cannot accidentally become a fact solely because evidence supports an assumption.
  assert.equal(assessmentFor(claim,{status:'supported'},{type:'fact'}).status,'forecast');
});

test('each claim has a deadline even when a batch cancellation signal is supplied',async()=>{
  const controller=new AbortController(),updates=[];
  const result=await checkClaims([claim],{signal:controller.signal,timeoutMs:5,onResult:(id,value)=>updates.push({id,...value}),send:async(_base,_path,_body,{signal})=>{
    assert.notEqual(signal,controller.signal);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(signal.aborted,true);
    return {assessment:{status:'supported'}};
  }});
  assert.equal(controller.signal.aborted,false);
  assert.match(result[0].error,/timed out/);
  assert.equal(updates.length,1);assert.equal(updates[0].data,undefined);
});

test('one timed-out Gemini check preserves a different claim that finished',async()=>{
  const updates=[];
  const result=await checkClaims([claim,{...claim,id:'claim-2'}],{timeoutMs:5,onResult:(id,value)=>updates.push({id,...value}),send:async(_base,_path,body)=>{
    if(body.claim.id==='claim-2')await new Promise(resolve=>setTimeout(resolve,20));
    return {claim:body.claim,assessment:{status:'forecast'}};
  }});
  assert.equal(result[0].data.claim.id,'claim-1');assert.match(result[1].error,/timed out/);
  assert.equal(updates.filter(update=>update.data).length,1);
});

test('Gemini outages remain visible for facts, forecasts and recommendations',()=>{
  for(const type of ['fact','forecast','recommendation'])assert.equal(assessmentFor({...claim,type},{status:'unavailable'}).label,'Gemini unavailable');
});

test('market cards render Gemini data and do not render external source reports',()=>{
  withDocument(()=>{
    const container=new Element('section');
    const view=createReportView(container,{claims:[{...claim,type:'fact'}],extraction:'rules',warnings:[]});
    view.result('claim-1',{data:{claim:{...claim,type:'fact'},checkedAt:'2026-10-11T12:00:00Z',assessment:{status:'not_market_verifiable',summary:'A future market cannot verify past production.',limitations:[]},sources:[{title:'External source that must not be rendered',url:'https://example.com/'}],market:{status:'related',reason:'Related topic; different target.',matches:[{title:'Tesla releases Optimus',url:'https://www.gemini.com/predictions/optimus-release',expiryDate:'2027-01-01T00:00:00Z',contracts:[{label:'YES',prob:.42,source:'midpoint'}]}]}}});
    const rendered=textOf(container);
    assert.match(rendered,/GEMINI MARKET REPORT/);assert.match(rendered,/Check with Gemini/);
    assert.match(rendered,/Not market-verifiable/);assert.match(rendered,/42\.0%/);
    assert.match(rendered,/Gemini Exchange · midpoint · YES price/);
    assert.doesNotMatch(rendered,/External source that must not be rendered|Claude|SOURCES CHECKED|research isn’t available/);
  });
});

test('the direct answer leads the assessment while related-market mismatch notices remain',()=>withDocument(()=>{
  const container=renderReport({claim,assessment:{status:'forecast',headline:'Gemini does not price this exact prediction.',summary:'The related market is about a release, not production volume.',limitations:['A release is different from making one million robots.']},market:{status:'related',reason:'Different target and deadline.',matches:[{title:'Optimus released?',url:'https://www.gemini.com/predictions/optimus-release',contracts:[{prob:.105,label:'YES',source:'midpoint'}]}]}});
  const rendered=textOf(container),answer=elementsOf(container).find(element=>element.className==='evidence-answer');
  assert.match(textOf(answer),/^ ANSWER TO THE REEL Gemini does not price this exact prediction\./);
  assert.ok(rendered.indexOf('ANSWER TO THE REEL')<rendered.indexOf('GEMINI EXCHANGE · PREDICTION MARKETS'));
  assert.match(rendered,/10\.5%/);assert.match(rendered,/Different target and deadline/);
  assert.match(rendered,/A release is different from making one million robots/);
  assert.match(rendered,/Related topics are not verification/);
}));

test('older reports receive conservative headline fallbacks without changing status labels',()=>withDocument(()=>{
  for(const [type,status,headline] of [
    ['fact','not_market_verifiable','Gemini cannot verify this factual claim.'],
    ['forecast','forecast','This prediction is not confirmed.'],
    ['recommendation','opinion','This recommendation is not established by market prices.'],
    ['forecast','unavailable','Gemini could not check this claim right now.']
  ]) {
    const draft={...claim,type},data={claim:draft,assessment:{status},market:{matches:[]}};
    const rendered=textOf(renderReport(data,{claims:[draft]}));
    assert.ok(rendered.includes(headline));assert.ok(rendered.includes(assessmentFor(draft,{status}).label));
  }
}));

test('Claude is disclosed separately and references only evidence returned with the report',()=>withDocument(()=>{
  const container=renderReport({claim,assessment:{status:'forecast',headline:'No matching Gemini prediction.'},explanation:{status:'complete',provider:'claude',answer:'Gemini cannot settle the Reel’s prediction.',reason:'The only related contract uses a different deadline.',evidenceIds:['market-1','invented-id']},evidence:[{id:'market-1',text:'The Gemini market settles on December 31, 2026.'},{id:'unused',text:'Unreferenced evidence must not appear here.'}],market:{matches:[]}}, {...extracted,extraction:'ai'});
  const rendered=textOf(container);
  assert.match(rendered,/Claude selected these claims; original excerpt preserved/);
  assert.match(rendered,/CLAUDE · EXPLANATION/);assert.match(rendered,/Gemini cannot settle the Reel’s prediction/);
  assert.match(rendered,/The only related contract uses a different deadline/);
  assert.match(rendered,/Evidence used in this explanation/);assert.match(rendered,/The Gemini market settles on December 31, 2026/);
  assert.match(rendered,/does not add independent fact-checking/);
  assert.doesNotMatch(rendered,/invented-id|Unreferenced evidence/);
  assert.match(rendered,/Forecast/);
}));

test('AI and transcript text cannot introduce HTML, links, or factual status overrides',()=>withDocument(()=>{
  const unsafe='<img src=x onerror=alert(1)> <script>alert(1)</script> [click](javascript:alert(1))';
  const container=renderReport({claim,assessment:{status:'forecast',headline:unsafe,summary:unsafe},explanation:{status:'complete',provider:'claude',statusLabel:'Verified true',answer:unsafe,reason:unsafe+' reason',evidenceIds:['e-1']},evidence:[{id:'e-1',text:unsafe}],market:{matches:[]}},{...extracted,claims:[{...claim,text:unsafe,quote:unsafe}]});
  const rendered=textOf(container);
  assert.ok(rendered.includes(unsafe));
  assert.equal(elementsOf(container).some(element=>['img','script','a'].includes(element.tagName)),false);
  assert.match(rendered,/Forecast/);assert.doesNotMatch(rendered,/Verified true/);
}));

test('disabled or failed AI preserves Gemini results and exposes no setup requirements',()=>withDocument(()=>{
  for(const status of ['disabled','unavailable']) {
    const container=renderReport({claim,assessment:{status:'forecast',headline:'No exact Gemini match.'},explanation:{status,provider:'claude',reason:'ANTHROPIC_API_KEY is missing'},market:{matches:[]}});
    const rendered=textOf(container);
    assert.match(rendered,/No exact Gemini match/);assert.match(rendered,/GEMINI EXCHANGE · PREDICTION MARKETS/);
    assert.doesNotMatch(rendered,/ANTHROPIC|API_KEY|missing|CLAUDE · EXPLANATION/);
    if(status==='unavailable')assert.match(rendered,/AI explanation unavailable; Gemini results are shown/);
    else assert.doesNotMatch(rendered,/AI explanation unavailable/);
  }
}));
