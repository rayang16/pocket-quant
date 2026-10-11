import test from 'node:test';
import assert from 'node:assert/strict';
import {reportWorkspaceResult,reportWorkspaceEvents} from '../public/report-workspace.js';
const report={claim:{id:'claim-1',type:'forecast',text:'Tesla could launch a robot.'},checkedAt:'2026-10-11T22:00:00Z',assessment:{status:'forecast'},market:{matches:[{title:'Tesla robot launch',category:'Tech',url:'https://www.gemini.com/predictions/tesla',expiryDate:'2027-01-01T00:00:00Z',contracts:[{label:'Yes',prob:0,source:'last trade'},{label:'Missing',prob:null}]}]}};
test('report handoff retains upstream evidence and only its approved market matches',()=>{
 const saved=reportWorkspaceResult(report);assert.equal(saved.report,report);assert.equal(saved.claim.summary,report.claim.text);
 const events=reportWorkspaceEvents(saved.report);assert.equal(events.length,1);assert.equal(events[0].category,'Tech');assert.equal(events[0].contracts[0].prob,0);assert.equal(events[0].contracts[1].prob,null);assert.equal(events[0]._fetchedAt,report.checkedAt);assert.equal(events[0].contracts[0].symbol,null);
});
test('report handoff does not accept unsafe links or malformed quote values',()=>{
 const events=reportWorkspaceEvents({...report,market:{matches:[null,{...report.market.matches[0],url:'javascript:alert(1)'},{...report.market.matches[0],contracts:[{label:'String',prob:'0.9'},{label:'Invalid',prob:1.1},null]}]}});
 assert.equal(events.length,1);assert.deepEqual(events[0].contracts.map(c=>c.prob),[null,null]);assert.deepEqual(reportWorkspaceEvents({market:{matches:{}}}),[]);
});
test('a saved NO-side model restores YES quotes for charts without inventing a second model',()=>{
 const model={claim:{asset:'BTC'},checkedAt:report.checkedAt,model:{matchedContract:{lo:.3,hi:.6}},market:{eventTitle:'Bitcoin',contractLabel:'Below 100k',instrumentSymbol:'GEMI-TEST',url:'https://www.gemini.com/predictions/bitcoin',strike:100000,expiryDate:'2027-01-01T00:00:00Z',side:'NO',prob:.4,bid:.3,ask:.5,source:'bid/ask midpoint'}};
 const data={...report,model};const saved=reportWorkspaceResult(data),events=reportWorkspaceEvents(data),contract=events[1].contracts[0];
 assert.deepEqual(saved.model,model.model);assert.equal(saved.market.side,'NO');assert.equal(contract.prob,.6);assert.equal(contract.bid,.5);assert.equal(contract.ask,.7);assert.equal(contract.symbol,'GEMI-TEST');assert.equal(contract.quality,'two-sided');
});
test('original modeled contract replaces its saved quote rather than duplicating it',()=>{
 const model={claim:{asset:'BTC'},checkedAt:report.checkedAt,model:{matchedContract:{lo:.2,hi:.5}},market:{url:report.market.matches[0].url,contractLabel:'Yes',instrumentSymbol:'GEMI-BTC-TEST',prob:.4,bid:.5,ask:.3,side:'YES'}};
 const events=reportWorkspaceEvents({...report,model});assert.equal(events.length,1);assert.equal(events[0].contracts.length,2);assert.equal(events[0].contracts[0].symbol,'GEMI-BTC-TEST');assert.equal(events[0].contracts[0].quality,'limited');
});

test('report snapshot preserves only validated Gemini instrument symbols for reviewed trade navigation',()=>{
 const match={...report.market.matches[0],contracts:[{label:'Valid',prob:.4,symbol:'GEMI-BTC261031-HI100000'},{label:'Invalid',prob:.2,symbol:'javascript:alert(1)'}]};
 assert.deepEqual(reportWorkspaceEvents({...report,market:{matches:[match]}})[0].contracts.map(c=>c.symbol),['GEMI-BTC261031-HI100000',null]);
});
