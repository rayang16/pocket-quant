import test from 'node:test';import assert from 'node:assert/strict';import {checkClaim} from '../lib/engine.js';import {createGeminiClient,readQuote} from '../lib/gemini.js';import {regexClaim} from '../lib/claim.js';import {NOW,fixtureEvents,fixtureCandles,mockFetch} from '../fixtures/gemini.js';
const run=(text,events=fixtureEvents())=>checkClaim(text,{now:NOW,apiKey:'',extract:async t=>regexClaim(t,NOW),client:createGeminiClient({now:()=>+NOW,fetchImpl:mockFetch(events)})});
test('BTC full path with real-shaped candles and missing nearest quote',async()=>{const r=await run('BTC to 150K by end of month, guaranteed');assert.equal(r.verdict,'HYPE');assert.equal(r.inputs.spot,83600);assert.equal(r.inputs.vols.length,3);assert.equal(r.market.strike,100000);assert.equal(r.market.prob,.1);assert.equal(r.market.targetBound.kind,'upper');assert.ok(r.model.touch.hi>=r.model.atExpiry.hi);assert.ok(r.market.impliedAtTarget);assert.match(r.matchNote,/not the odds/);});
test('different deadline cannot become a bound',async()=>{const r=await run('BTC to 150k tomorrow guaranteed');assert.equal(r.market.targetBound,null);assert.equal(r.market.sameDeadline,false);assert.ok(r.warnings.some(x=>x.includes('different deadline')));});
test('below claims invert YES quote and order book',async()=>{const r=await run('BTC will drop below 100k by end of month');assert.equal(r.market.side,'NO');assert.equal(r.market.prob,.9);assert.equal(r.market.bid,.88);assert.equal(r.market.ask,.92);assert.equal(r.model.touch.hi,1);});
test('no market means no hype verdict',async()=>{const r=await run('BTC to 150k this month',{data:[],pagination:{total:0}});assert.equal(r.verdict,'NO MATCH');assert.equal(r.hypeVerdict,undefined);assert.ok(r.model);});
test('missing prices never become zero odds',async()=>{const e=fixtureEvents();e.data[0].contracts.forEach(c=>delete c.prices);const r=await run('BTC to 150k this month',e);assert.equal(r.verdict,'NO QUOTES');assert.equal(r.market.prob,null);assert.equal(r.hypeVerdict,undefined);});
test('one-sided quotes suppress pricing signal',async()=>{const e=fixtureEvents();delete e.data[0].contracts[0].prices.bestAsk;const r=await run('BTC to 150k this month',e);assert.equal(r.market.source,'last trade');assert.equal(r.marketVsModel.label,'INSUFFICIENT QUOTES');});
test('quotes preserve zero and reject crossed books',()=>{assert.equal(readQuote({prices:{lastTradePrice:'0'}}).prob,0);assert.equal(readQuote({prices:{bestBid:'0.8',bestAsk:'0.2'}}).prob,null);assert.equal(readQuote({prices:{bestAsk:'0.3'}}).prob,.3);assert.equal(readQuote({}).prob,null);});
test('past and multi-target claims stopped',async()=>{assert.equal((await run('BTC was 90k yesterday')).verdict,'NOT A PREDICTION');assert.equal((await run('BTC to 100k or 150k tomorrow')).verdict,'NEEDS CLARIFICATION');assert.equal((await run('BTC to 150k by October 1')).verdict,'NOT A FUTURE DEADLINE');});
test('relative targets derive from fetched spot',async()=>{assert.equal((await run('BTC up 20% this month')).claim.target,100320);});
test('weather matches remain possible, with no hype verdict',async()=>{const e={data:[{title:'Highest temperature in Austin on October 11, 2026?',slug:'austin',category:'Weather',status:'active',expiryDate:'2026-10-12T21:00:00Z',contracts:[{label:'94°F to 95°F',prices:{lastTradePrice:'0.6'}}]}],pagination:{total:1}};const r=await run('Highest temperature in Austin will be over 95 today',e);assert.equal(r.verdict,'POSSIBLE MATCH');assert.equal(r.hypeVerdict,undefined);});
test('Tesla production claim keeps its subject match without matching unrelated markets on year',async()=>{
  const titles=['Will Tesla Optimus be released this year?','The Game Awards 2026 Game of the Year','Will a recession happen this year?'];
  const events={data:titles.map((title,i)=>({title,slug:`subject-${i}`,category:'Other',status:'active',expiryDate:'2026-12-31T21:00:00Z',contracts:[{label:'Yes',prices:{lastTradePrice:'0.5'}}]})),pagination:{total:titles.length}};
  const result=await run('Tesla is expected to ship 1 million Optimus robots a year by the end of 2027.',events);
  assert.equal(result.verdict,'POSSIBLE MATCH');
  assert.deepEqual(result.matches.map(match=>match.title),[titles[0]]);
  assert.equal(result.model,null);
  assert.equal(result.hypeVerdict,undefined);
  assert.match(result.message,/keyword overlap alone cannot establish/);
});
test('generic temporal and prediction language alone cannot establish a possible match',async()=>{
  const events={data:[{title:'Will the expected recession happen this year or next month?',slug:'recession',category:'Other',status:'active',expiryDate:'2026-12-31T21:00:00Z',contracts:[{label:'Yes',prices:{lastTradePrice:'0.5'}}]}],pagination:{total:1}};
  for(const claim of ['It is expected this year, probably before next month.','This will probably happen next year.']) {
    const result=await run(claim,events);
    assert.equal(result.verdict,'NO MATCH',claim);
    assert.equal(result.matches,undefined);
    assert.equal(result.hypeVerdict,undefined);
  }
});
test('cache coalesces requests and expires',async()=>{let calls=0,now=+NOW;const client=createGeminiClient({now:()=>now,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({last:'80000'})};}});await Promise.all([client.spot('BTC'),client.spot('BTC')]);assert.equal(calls,1);await client.spot('BTC');assert.equal(calls,1);now+=16000;await client.spot('BTC');assert.equal(calls,2);});
test('paginates active events',async()=>{let calls=0;const client=createGeminiClient({now:()=>+NOW,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({data:Array.from({length:calls===1?100:5},(_,i)=>({id:i})),pagination:{total:105}})};}});assert.equal((await client.events()).events.length,105);assert.equal(calls,2);});
test('network failure returns no synthetic odds',async()=>{const client=createGeminiClient({fetchImpl:async()=>{throw Error('offline');}});await assert.rejects(()=>client.spot('BTC'),/unreachable/);});
test('ignores incomplete candle',async()=>{const rows=fixtureCandles();rows.unshift([+NOW,1,1,1,9999999,1]);const client=createGeminiClient({now:()=>+NOW,fetchImpl:async()=>({ok:true,json:async()=>rows})});assert.ok(!(await client.candles('BTC')).closes.includes(9999999));});
test('documented checkClaim(text, {fetch, now}) interface uses injectable fetch',async()=>{const r=await checkClaim('BTC to 150k this month guaranteed',{fetch:mockFetch(),now:NOW,apiKey:''});assert.equal(r.inputs.spot,83600);assert.deepEqual(r.claim.targets,[150000]);assert.equal(r.evidence,Math.max((r.model.touch.lo+r.model.touch.hi)/2,r.market.impliedAtTarget.hi));assert.equal(r.hypeVerdict.gap,r.claim.speakerConfidence-r.evidence);});
test('percentage targets and malformed input cannot reach probability math',async()=>{assert.equal((await run('BTC down 110% this month')).verdict,'NEEDS CLARIFICATION');await assert.rejects(()=>checkClaim(null),/text/);await assert.rejects(()=>checkClaim('BTC 100k',{now:'not-a-date'}),/valid date/);});
