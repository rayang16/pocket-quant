import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarketQuery,normalizeWorkspaceMarkets,matchesAsset,MARKET_CATEGORIES} from '../lib/workspace-markets.js';

const NOW=Date.parse('2026-10-11T19:30:00Z');
const EXPIRY='2026-10-31T21:00:00.000Z';
const query=values=>parseMarketQuery(new URLSearchParams(values));
const contract=(overrides={})=>({id:'contract-1',label:'$100,000 or above',instrumentSymbol:'GEMI-BTC261031-HI100000',status:'active',marketState:'open',expiryDate:EXPIRY,strike:{type:'above',value:'100000'},prices:{bestBid:'0.08',bestAsk:'0.12'},...overrides});
const event=(overrides={})=>({id:'event-1',title:'BTC price on October 31',ticker:'BTC2610312100',series:'BTC',category:'Crypto',status:'active',expiryDate:EXPIRY,slug:'btc-october-31',contracts:[contract()],...overrides});
const normalize=(events,values={},options={})=>normalizeWorkspaceMarkets(events,query(values),{now:NOW,fetchedAt:NOW-12000,...options});

test('workspace query canonicalizes supported assets and categories without claiming exact matches',()=>{
  assert.deepEqual(query({asset:' btc ',category:'crypto',q:' BTC to 100K ',deadline:EXPIRY}),{asset:'BTC',category:'Crypto',sector:null,q:'BTC to 100K',search:'',deadline:EXPIRY,offset:0,snapshot:null,cursor:null});
  assert.equal(query({category:'Other'}).category,null);
  assert.equal(query({category:'Culture'}).category,'Culture');
  assert.match(normalize([event()],{asset:'BTC'}).scope,/Related BTC/);
  assert.match(normalize([event()],{category:'Crypto'}).scope,/category browse/);
});

test('all current Gemini category buttons map to their actual upstream category names',()=>{
  for(const category of MARKET_CATEGORIES){
    assert.equal(query({category:category.toLowerCase()}).category,category);
    assert.equal(query({sector:category.toLowerCase().replaceAll(' ','-')}).category,category);
  }
  assert.equal(query({category:'All',sector:'all'}).category,null);
  assert.throws(()=>query({sector:'for-you'}),error=>error.status===400);
  assert.throws(()=>query({sector:'pro-football',category:'Crypto'}),error=>error.status===400);
});

test('narrow sectors match explicit source tags and category paths, not all parent-category markets',()=>{
  const football=event({id:'football',title:'Denver vs Los Angeles C',category:'Sports',tags:['Pro Football'],subcategory:{path:['Sports','Pro Football']}});
  const baseball=event({id:'baseball',category:'Sports',tags:['Pro Baseball']});
  const midterms=event({id:'midterms',title:'Texas US Senate Winner',category:'Politics',subcategory:{path:['Politics','Midterms','Senate']}});
  const otherPolitics=event({id:'other-politics',category:'Politics'});
  assert.deepEqual(normalize([football,baseball],{sector:'pro-football'}).events.map(item=>item.id),['football']);
  assert.deepEqual(normalize([football,baseball],{sector:'pro-baseball'}).events.map(item=>item.id),['baseball']);
  assert.deepEqual(normalize([midterms,otherPolitics],{sector:'midterms'}).events.map(item=>item.id),['midterms']);
});

test('Live discovery requires explicit live source membership and never equates active with live',()=>{
  const sports=event({category:'Sports'});
  assert.equal(normalize([sports],{sector:'live'}).total,0);
  const liveFeed=normalize([sports],{sector:'live'},{upstreamCategory:'Live'});
  assert.equal(liveFeed.total,1);assert.match(liveFeed.scope,/upstream category/);assert.equal('isLive' in liveFeed.events[0],false);
});

test('workspace query rejects ambiguous, oversized, malformed and conflicting filters',()=>{
  for(const params of [new URLSearchParams('asset=BTC&asset=ETH'),new URLSearchParams('unexpected=1'),new URLSearchParams({asset:'Bitcoin'}),new URLSearchParams({asset:'DOGE'}),new URLSearchParams({asset:'BTC',category:'Sports'}),new URLSearchParams({category:'<script>'}),new URLSearchParams({category:'a'.repeat(65)}),new URLSearchParams({q:'a'.repeat(6001)}),new URLSearchParams({q:'BTC\0'}),new URLSearchParams({deadline:'tomorrow'}),new URLSearchParams({deadline:'2026-02-30T00:00:00Z'}),new URLSearchParams({deadline:'2026-10-31T24:00:00Z'})])assert.throws(()=>parseMarketQuery(params),error=>error.status===400);
});

test('pagination accepts bounded whole-number offsets and rejects malformed or repeated offsets',()=>{
  assert.equal(query({}).offset,0);assert.equal(query({offset:'10000'}).offset,10000);
  for(const offset of ['','-1','1.5','1e2','Infinity','NaN','10001',' 1','1 '])assert.throws(()=>query({offset}),error=>error.status===400);
  assert.throws(()=>parseMarketQuery(new URLSearchParams('offset=0&offset=1')),error=>error.status===400);
});

test('explicit directory search has a separate bounded, validated query value',()=>{
  assert.equal(query({q:'A long original claim',search:' October 31 '}).search,'October 31');
  for(const search of ['x'.repeat(121),'BTC\0'])assert.throws(()=>query({search}),error=>error.status===400);
  assert.throws(()=>parseMarketQuery(new URLSearchParams('search=BTC&search=ETH')),error=>error.status===400);
});

test('crypto relationships use exact symbol prefixes, not title mentions or neighboring assets',()=>{
  assert.equal(matchesAsset({ticker:'BTC05M2610112000'},'BTC'),true);
  assert.equal(matchesAsset({series:'btc'},'BTC'),true);
  assert.equal(matchesAsset({ticker:'BTCASH'},'BTC'),false);
  assert.equal(matchesAsset({ticker:'WBTC100K'},'BTC'),false);
  const result=normalize([event(),event({id:'eth',ticker:'ETH261031',series:'ETH',title:'ETH versus BTC'}),event({id:'fake',ticker:'BTCASH',series:null}),event({id:'title-only',ticker:'OTHER',series:null,title:'Bitcoin BTC news'})],{asset:'BTC',q:'Bitcoin to 150K guaranteed'});
  assert.deepEqual(result.events.map(item=>item.id),['event-1']);
});

test('expired, resolved, inactive and undated events and unavailable contracts are excluded',()=>{
  const past='2026-10-10T21:00:00Z';
  const result=normalize([event({contracts:[contract(),contract({id:'past',expiryDate:past}),contract({id:'closed',marketState:'closed'}),contract({id:'settled',status:'settled'}),contract({id:'resolved',resolvedAt:past}),contract({id:'bad-time',expiryDate:'invalid'}),contract({id:'blank-label',label:''}),null]}),event({id:'expired-event',expiryDate:past}),event({id:'settled-event',status:'settled'}),event({id:'resolved-event',resolvedAt:past}),event({id:'undated',expiryDate:null}),event({id:'empty',contracts:[]})]);
  assert.equal(result.events.length,1);assert.equal(result.events[0].contracts.length,1);assert.equal(result.totalContracts,1);
});

test('source contract expiry can inherit its active event expiry, and missing identifiers stay null',()=>{
  const result=normalize([event({id:undefined,ticker:undefined,series:undefined,slug:undefined,contracts:[contract({id:undefined,instrumentSymbol:undefined,expiryDate:null,status:undefined,marketState:undefined})]})]);
  const found=result.events[0];assert.equal(found.id,null);assert.equal(found.url,null);assert.equal(found.contracts[0].symbol,null);assert.equal(found.contracts[0].id,null);assert.equal(found.contracts[0].expiryDate,EXPIRY);
});

test('same-title interval events retain validated source start times and series without inferred windows',()=>{
  const events=[event({id:'five',series:'BTC05M',startTime:'2026-10-31T20:55:00Z'}),event({id:'fifteen',series:'BTC15M',startTime:'2026-10-31T20:45:00Z'})];
  const result=normalize(events),byId=new Map(result.events.map(event=>[event.id,event]));
  assert.equal(byId.get('five').series,'BTC05M');assert.equal(byId.get('fifteen').series,'BTC15M');
  assert.equal(byId.get('five').startTime,'2026-10-31T20:55:00.000Z');assert.equal(byId.get('fifteen').startTime,'2026-10-31T20:45:00.000Z');
  for(const startTime of [undefined,null,123,'invalid',EXPIRY,'2026-11-01T00:00:00Z'])assert.equal(normalize([event({startTime})]).events[0].startTime,null);
  for(const series of [undefined,null,123,[],{},'x'.repeat(65)])assert.equal(normalize([event({series})]).events[0].series,null);
});

test('quotes preserve genuine zero and missing odds without coercing malformed fields',()=>{
  const prices=[{}, {lastTradePrice:'0'}, {bestBid:false,bestAsk:[],lastTradePrice:' '},{bestBid:'.2',bestAsk:'0.4'}, {bestBid:'NaN',bestAsk:'2',lastTradePrice:null}];
  const result=normalize([event({contracts:prices.map((value,index)=>contract({id:String(index),prices:value}))})]);
  const found=result.events[0].contracts;
  assert.deepEqual(found.map(item=>item.prob),[null,0,null,.30000000000000004,null]);
  assert.equal(found[0].source,'unavailable');assert.equal(found[2].bid,null);assert.equal(found[2].ask,null);assert.equal(found[3].quality,'two-sided');
});

test('crossed quotes retain source limitations and do not manufacture a midpoint',()=>{
  const result=normalize([event({contracts:[contract({prices:{bestBid:'.8',bestAsk:'.2'}}),contract({id:'last',prices:{bestBid:'.8',bestAsk:'.2',lastTradePrice:'.35'}})]})]);
  const [missing,last]=result.events[0].contracts;assert.equal(missing.prob,null);assert.equal(missing.quality,'crossed');assert.equal(last.prob,.35);assert.equal(last.source,'last trade (crossed book)');
});

test('noncrypto search requires meaningful title keywords as well as category',()=>{
  const result=normalize([event({id:'austin',title:'Highest temperature in Austin tomorrow',category:'Weather'}),event({id:'dallas',title:'Highest temperature in Dallas tomorrow',category:'Weather'}),event({id:'politics',title:'Austin election result',category:'Politics'})],{category:'Weather',q:"It's definitely going to be over 95 degrees in Austin tomorrow"});
  assert.deepEqual(result.events.map(item=>item.id),['austin']);assert.match(result.scope,/Keyword-related Weather/);
  assert.equal(normalize([event()],{q:'guaranteed price by tomorrow'}).total,0);
});

test('typed directory dates narrow crypto asset results even when original claim matching uses the asset',()=>{
  const events=[event(),event({id:'later',title:'BTC price on November 15',expiryDate:'2026-11-15T21:00:00Z'}),event({id:'eth',title:'ETH price on October 31',ticker:'ETH261031',series:'ETH'})];
  const result=normalize(events,{asset:'BTC',q:'Bitcoin to 150K guaranteed',search:'October 31'});
  assert.deepEqual(result.events.map(item=>item.id),['event-1']);assert.equal(result.total,1);
  assert.equal(normalize(events,{asset:'BTC',search:'October 32'}).total,0);
});

test('browse search handles contract amounts, punctuation and title terms without dropping numbers',()=>{
  const events=[event({contracts:[contract({label:'$92,500 or above'})]}),event({id:'other',title:'ETH price on October 31',contracts:[contract({label:'$3,500 or above'})]})];
  assert.deepEqual(normalize(events,{search:'BTC $92500'}).events.map(item=>item.id),['event-1']);
  assert.deepEqual(normalize(events,{search:'$92,500'}).events.map(item=>item.id),['event-1']);
  assert.deepEqual(normalize(events,{search:'ETH: October / 31'}).events.map(item=>item.id),['other']);
  assert.equal(normalize(events,{search:'---'}).total,0);assert.equal(normalize(events,{search:'unknown'}).total,0);
});

test('deadline proximity controls ordering while keyword score orders unbounded discovery',()=>{
  const events=[event({id:'near',title:'Lakers game',category:'Sports',expiryDate:'2026-10-20T21:00:00Z'}),event({id:'far',title:'Lakers vs Celtics',category:'Sports',expiryDate:EXPIRY})];
  assert.deepEqual(normalize(events,{q:'Lakers Celtics',category:'Sports'}).events.map(item=>item.id),['far','near']);
  assert.deepEqual(normalize(events,{q:'Lakers Celtics',category:'Sports',deadline:'2026-10-21T21:00:00Z'}).events.map(item=>item.id),['near','far']);
});

test('nested active sports events are included once using their own conditions',()=>{
  const child=event({id:'child',title:'Lakers vs Celtics total points',category:'Sports'});
  const parent=event({id:'parent',title:'Lakers vs Celtics',category:'Sports',contracts:[],events:[child]});
  const result=normalize([parent,child],{category:'Sports',q:'Lakers'});assert.deepEqual(result.events.map(item=>item.id),['child']);
});

test('response caps disclose complete matching event and contract counts',()=>{
  const events=[event({id:'one',contracts:[contract({id:'one-a'}),contract({id:'one-b'})]}),event({id:'two'}),event({id:'three'})];
  const capped=normalize(events,{}, {maxEvents:2,maxContracts:3});assert.equal(capped.events.length,2);assert.equal(capped.total,3);assert.equal(capped.totalContracts,4);assert.equal(capped.truncated,true);
  assert.equal(capped.offset,0);assert.equal(capped.nextOffset,2);assert.equal(capped.hasMore,true);
  const partial=normalize(events,{}, {maxEvents:3,maxContracts:1});assert.equal(partial.events[0].contracts.length,1);assert.equal(partial.events[0].contractTotal,2);assert.equal(partial.events[0].contractsTruncated,true);assert.equal(partial.nextOffset,1);assert.equal(partial.truncated,true);
  const all=normalize(events);assert.equal(all.truncated,false);assert.equal(all.fetchedAt,new Date(NOW-12000).toISOString());
  assert.equal(all.nextOffset,null);assert.equal(all.hasMore,false);assert.equal(all.events[0].contractsTruncated,false);
});

test('contract-limited pages preserve whole ordinary events without duplicate or missing active events',()=>{
  const events=[3,3,1,2,1].map((count,index)=>event({id:`event-${index}`,title:`Market ${index}`,contracts:Array.from({length:count},(_,j)=>contract({id:`${index}-${j}`}))}));
  events.push(event({id:'expired',expiryDate:'2026-10-10T21:00:00Z'}));
  const emitted=[];let offset=0,pages=0;
  do{
    const page=normalize(events,{offset:String(offset)},{maxContracts:4});
    assert.equal(page.total,5);assert.equal(page.totalContracts,10);assert.equal(page.offset,offset);
    assert.ok(page.events.flatMap(item=>item.contracts).length<=4);
    assert.ok(page.events.every(item=>!item.contractsTruncated));
    emitted.push(...page.events);pages++;
    assert.equal(page.hasMore,page.nextOffset!==null);
    if(page.hasMore)assert.equal(page.nextOffset,offset+page.events.length);
    offset=page.nextOffset;
  }while(offset!==null&&pages<10);
  assert.equal(pages,3);assert.deepEqual(emitted.map(item=>item.id),events.slice(0,5).map(item=>item.id));
  assert.equal(emitted.flatMap(item=>item.contracts).length,10);
});

test('event-limited pages can reach every market and an exhausted offset returns a stable empty page',()=>{
  const events=Array.from({length:205},(_,index)=>event({id:`event-${index}`,title:`Market ${String(index).padStart(3,'0')}`}));
  const pages=[0,100,200].map(offset=>normalize(events,{offset:String(offset)}));
  assert.deepEqual(pages.map(page=>page.events.length),[100,100,5]);assert.deepEqual(pages.map(page=>page.nextOffset),[100,200,null]);
  assert.deepEqual(pages.flatMap(page=>page.events.map(item=>item.id)),events.map(item=>item.id));
  assert.ok(pages.every(page=>page.total===205&&page.totalContracts===205&&page.truncated));
  const exhausted=normalize(events,{offset:'205'});assert.deepEqual(exhausted.events,[]);assert.equal(exhausted.nextOffset,null);assert.equal(exhausted.hasMore,false);assert.equal(exhausted.total,205);
});

test('empty real data is empty while malformed listings or timestamps fail explicitly',()=>{
  assert.deepEqual(normalize([]).events,[]);assert.equal(normalize([]).total,0);assert.equal(normalize([]).truncated,false);
  assert.throws(()=>normalize(null),/unreadable market list/);
  assert.throws(()=>normalizeWorkspaceMarkets([],query({}),{now:NOW}),/unreadable market list/);
});
