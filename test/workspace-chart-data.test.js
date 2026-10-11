import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareContractQuotes} from '../public/workspace-chart-data.js';

test('chart quotes preserve real zero, reject invalid values and leave missing data as gaps',()=>{
 const result=prepareContractQuotes([{label:'Zero',prob:0},{label:'Missing',prob:null},{label:'String',prob:'0.5'},{label:'High',prob:1.2},{label:'Full',prob:1}]);
 assert.deepEqual(result.points.map(point=>point.probability),[0,null,null,null,100]);
 assert.equal(result.quoted,2);
 assert.equal(result.priceLadder,false);
});
test('price ladders sort true numeric strikes and retain original contract selection indexes',()=>{
 const result=prepareContractQuotes([{label:'$95K',strike:95000,strikeType:'above',expiryDate:'2027-01-01T00:00:00Z',prob:.12},{label:'$85K',strike:85000,strikeType:'above',expiryDate:'2027-01-01T00:00:00Z',prob:.6},{label:'$90K',strike:90000,strikeType:'above',expiryDate:'2027-01-01T00:00:00Z',prob:null}]);
 assert.equal(result.priceLadder,true);
 assert.deepEqual(result.points.map(point=>[point.strike,point.index,point.probability]),[[85000,1,60],[90000,2,null],[95000,0,12]]);
});
test('outcomes and duplicate strikes do not become fabricated numerical curves',()=>{
 assert.equal(prepareContractQuotes([{label:'Home',prob:.4},{label:'Away',prob:.6}]).priceLadder,false);
 assert.equal(prepareContractQuotes([{label:'Above',strike:100,prob:.4},{label:'Below',strike:100,prob:.6}]).priceLadder,false);
 assert.deepEqual(prepareContractQuotes(),{points:[],priceLadder:false,quoted:0});
});

test('different settlement semantics and deadlines use categorical quotes, never a numeric ladder',()=>{
 const pair=[{strike:100,strikeType:'above',expiryDate:'2027-01-01T00:00:00Z',prob:.5},{strike:200,strikeType:'above',expiryDate:'2027-01-01T00:00:00Z',prob:.2}];
 assert.equal(prepareContractQuotes(pair).priceLadder,true);
 for (const patch of [{strikeType:'below'},{strikeType:null},{expiryDate:'2027-02-01T00:00:00Z'},{expiryDate:null}]) assert.equal(prepareContractQuotes([pair[0],{...pair[1],...patch}]).priceLadder,false);
});
