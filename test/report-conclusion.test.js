import test from 'node:test';
import assert from 'node:assert/strict';
import {concludeClaim,reportEvidence} from '../lib/report-conclusion.js';
import {createEvidenceReporter} from '../lib/evidence-report.js';

const now=new Date('2026-10-11T00:00:00Z');
const text='Tesla is expected to ship 1 million Optimus robots a year by the end of 2027.';
const claim={id:'claim-1',text,quote:text,type:'forecast'};
const market={status:'related',reason:'Related topics only; release differs from annual production.',matches:[{title:'Tesla Optimus released this year?',expiryDate:'2026-12-31T00:00:00Z',contracts:[{label:'Yes',prob:.105,source:'bid/ask midpoint'}]}]};
const options={ai:null,clock:()=>now,marketLookup:async()=>market,checker:()=>assert.fail('No crypto claim')};

test('a release-market quote never becomes odds of annual robot production',()=>{
  const assessment=concludeClaim(claim,market,null);
  assert.match(assessment.headline,/release market does not verify/);
  assert.match(assessment.summary,/annual production/);
  assert.doesNotMatch(assessment.summary,/10\.5%/);
  const evidence=reportEvidence({claim,market,model:null,assessment});
  const quote=evidence.find(item=>item.id==='market-1-quote-1');
  assert.match(quote.text,/10\.5%/);
  assert.match(quote.text,/not the probability of the Reel/);
});

test('missing markets, outages, facts and advice never turn into true/false conclusions',()=>{
  for(const type of ['fact','recommendation','forecast'])for(const status of ['none','unavailable']) {
    const answer=concludeClaim({...claim,type},{status,matches:[]},null);
    assert.ok(answer.headline);
    assert.notEqual(answer.status,'supported');assert.notEqual(answer.status,'contradicted');
    if(type==='fact')assert.match(answer.headline,/not verified/);
    if(type==='recommendation')assert.match(answer.headline,/not a proven opportunity/);
    if(type==='forecast'&&status==='none')assert.match(answer.summary,/does not make it false/);
    if(type==='forecast'&&status==='unavailable')assert.equal(answer.status,'unavailable');
  }
});

test('model estimates distinguish touch from expiry and remain useful with no related market',()=>{
  const model={claim:{asset:'BTC',direction:'above',target:150000,deadlineISO:'2027-12-31T21:00:00Z'},model:{touch:{lo:.2,hi:.3},atExpiry:{lo:.1,hi:.15}}};
  const assessment=concludeClaim(claim,{status:'none',matches:[]},model);
  assert.match(assessment.summary,/20\.0%–30\.0% for touching/);
  assert.match(assessment.summary,/10\.0%–15\.0% for finishing/);
  assert.match(assessment.summary,/assumption-based/);
  const invalid=concludeClaim(claim,{status:'none',matches:[]},{model:{touch:{lo:-1,hi:2},atExpiry:{lo:0,hi:1}}});
  assert.doesNotMatch(invalid.summary,/-100|200%/);
});

test('Claude selects source-anchored statements and receives only bounded supplied evidence for explanations',async()=>{
  let explanationInput;
  const report=createEvidenceReporter({...options,ai:{
    extractClaims:async()=>({claims:[{text:'A rewritten claim that must not replace the source',quote:text,type:'forecast'}]}),
    explain:async input=>{explanationInput=input;return {answer:'The available market does not verify the production claim.',reason:'The contract concerns a release.',evidenceIds:['market-1']};}
  }});
  const extraction=await report('extract',{text});
  assert.equal(extraction.extraction,'ai');assert.equal(extraction.claims[0].text,text);
  const result=await report('check',{claim:extraction.claims[0]});
  assert.equal(result.explanation.status,'complete');
  assert.equal(result.assessment.status,'forecast');
  assert.match(result.assessment.headline,/does not verify/);
  assert.deepEqual(Object.keys(explanationInput).sort(),['assessment','checkedAt','claim','evidence']);
  assert.deepEqual(result.market,market);
});

test('AI failures preserve Gemini conclusions and can be retried without waiting for cache expiry',async()=>{
  let attempts=0;
  const report=createEvidenceReporter({...options,ai:{extractClaims:async()=>{throw new Error('private key diagnostics');},explain:async()=>{
    if(++attempts===1)throw new Error('private key diagnostics');
    return {answer:'The market is related only.',reason:'It concerns a release.',evidenceIds:['market-1']};
  }}});
  const extraction=await report('extract',{text});
  assert.equal(extraction.extraction,'rules');assert.equal(extraction.claims[0].text,text);
  const first=await report('check',{claim});
  assert.equal(first.explanation.status,'unavailable');assert.deepEqual(first.market,market);
  assert.match(first.assessment.headline,/does not verify/);
  assert.doesNotMatch(JSON.stringify(first),/private key diagnostics/);
  assert.equal((await report('check',{claim})).explanation.status,'complete');assert.equal(attempts,2);
});

test('conflicting or multiple deadlines never produce a calculation for the wrong time',async()=>{
  const report=createEvidenceReporter({...options,checker:()=>assert.fail('Ambiguous deadline must not be modeled')});
  for(const text of ['Today I think BTC will reach $150000 by December 31, 2027.','BTC will reach $150000 by December 31, 2027 or by January 1, 2028.']) {
    const result=await report('check',{claim:{...claim,text,quote:text}});
    assert.equal(result.model,null);
    assert.match(result.assessment.limitations.join(' '),/No independent probability model/);
  }
});

test('very small and near-certain probabilities do not round to impossible or guaranteed outcomes',()=>{
  const model={claim:{asset:'BTC',direction:'above',target:150000,deadlineISO:'2027-12-31T21:00:00Z'},model:{touch:{lo:.00001,hi:.99999},atExpiry:{lo:.000001,hi:.999999}}};
  const assessment=concludeClaim(claim,market,model);
  assert.match(assessment.summary,/<0\.1%–>99\.9%/);
  assert.doesNotMatch(assessment.summary,/\b(?:0\.0|100\.0)%/);
  assert.match(assessment.summary,/BTC above \$150000 by December 31, 2027 at 1:00 PM PST/);
});

test('edited claims never pass their superseded quote to Claude for numeric grounding',async()=>{
  let sent;
  const report=createEvidenceReporter({...options,ai:{explain:async input=>{
    sent=input;return {answer:'No exact market.',reason:'Related only.',evidenceIds:['conclusion']};
  }}});
  const result=await report('check',{claim:{...claim,text:'Tesla expects production to increase in 2028.',quote:'Tesla expects production to increase in 2027.'}});
  assert.equal(result.claim.quote,'Tesla expects production to increase in 2027.');
  assert.equal(sent.claim.text,'Tesla expects production to increase in 2028.');
  assert.equal(Object.hasOwn(sent.claim,'quote'),false);
});

test('an invalid optional Claude model setting cannot prevent public Gemini reports',async()=>{
  const previousKey=process.env.ANTHROPIC_API_KEY,previousModel=process.env.CLAUDE_MODEL;
  try {
    process.env.ANTHROPIC_API_KEY='test-only';process.env.CLAUDE_MODEL='invalid model setting';
    const {ai:ignored,...withoutAI}=options;
    const result=await createEvidenceReporter(withoutAI)('check',{claim});
    assert.deepEqual(result.market,market);assert.equal(result.explanation.status,'disabled');
  } finally {
    if(previousKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=previousKey;
    if(previousModel===undefined)delete process.env.CLAUDE_MODEL;else process.env.CLAUDE_MODEL=previousModel;
  }
});

test('market deadlines sent to Claude retain the local settlement date and timezone',()=>{
  const midnightMarket={...market,matches:[{...market.matches[0],expiryDate:'2027-01-01T04:59:00Z'}]};
  const assessment=concludeClaim(claim,midnightMarket,null);
  const evidence=reportEvidence({claim,market:midnightMarket,assessment,model:null});
  const contract=evidence.find(item=>item.id==='market-1');
  assert.match(contract.text,/December 31, 2026 at 8:59 PM PST/);
  assert.doesNotMatch(contract.text,/2027-01-01/);
});
