import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../api/markets.js';
import {createGeminiClient,DataError} from '../lib/gemini.js';
import {fixtureEvents,NOW} from '../fixtures/gemini.js';

function response(){return {headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=value===undefined?null:JSON.parse(value);}};}
async function call(handler,url='/api/markets',method='GET'){const res=response();await handler({url,method},res);return res;}

test('market discovery is read-only, supports preflight, and rejects other methods before fetching',async()=>{
  let calls=0;const handler=createHandler({client:{events:async()=>{calls++;return {events:[],fetchedAt:+NOW};}},now:()=>+NOW});
  const preflight=await call(handler,'/api/markets','OPTIONS');assert.equal(preflight.statusCode,204);
  const post=await call(handler,'/api/markets','POST');assert.equal(post.statusCode,405);assert.equal(post.headers.Allow,'GET, OPTIONS');assert.equal(calls,0);
  const get=await call(handler);assert.equal(get.statusCode,200);assert.equal(get.headers['Cache-Control'],'no-store');assert.equal(get.headers['X-Content-Type-Options'],'nosniff');
});

test('invalid discovery query fails before an upstream request',async()=>{
  let calls=0;const handler=createHandler({client:{events:async()=>{calls++;}},now:()=>+NOW});
  for(const suffix of ['asset=NOT-BTC','asset=BTC&asset=ETH','q='+encodeURIComponent('x'.repeat(6001)),'search='+encodeURIComponent('x'.repeat(121)),'deadline=not-a-date','category=%00','offset=-1','offset=0.5','offset=10001','offset=0&offset=1','snapshot=invalid','snapshot=one&snapshot=two'])assert.equal((await call(handler,'/api/markets?'+suffix)).statusCode,400);
  assert.equal(calls,0);
});

test('related discovery reuses Gemini pagination cache and does not send a full claim as literal search',async()=>{
  let calls=0;const urls=[];const client=createGeminiClient({now:()=>+NOW,fetch:async url=>{calls++;urls.push(new URL(url));return {ok:true,json:async()=>fixtureEvents()};}});
  const handler=createHandler({client,now:()=>+NOW});
  const first=await call(handler,'/api/markets?asset=BTC&q=Bitcoin+to+150K+guaranteed');
  const second=await call(handler,'/api/markets?asset=BTC&q=BTC+may+go+up');
  assert.equal(calls,1);assert.equal(first.statusCode,200);assert.equal(second.statusCode,200);assert.equal(first.body.total,1);assert.equal(first.body.events[0].contracts[0].symbol,'GEMI-BTC2610312100-HI100000');assert.equal(first.body.events[0].contracts[1].prob,null);
  assert.equal(urls[0].searchParams.get('category'),'Crypto');assert.equal(urls[0].searchParams.has('search'),false);assert.equal(first.body.fetchedAt,NOW.toISOString());
});

test('sector browsing uses the exact upstream filter, including Gemini’s dedicated Live feed',async()=>{
  const categories=[];const handler=createHandler({client:{events:async({category})=>{categories.push(category);return {events:[{...fixtureEvents().data[0],category:'Sports',tags:['Pro Football']}],fetchedAt:+NOW};}},now:()=>+NOW});
  const live=await call(handler,'/api/markets?sector=live');const football=await call(handler,'/api/markets?sector=pro-football');
  assert.deepEqual(categories,['Live','Pro Football']);assert.equal(live.body.total,1);assert.equal(football.body.total,1);assert.match(live.body.scope,/Live feed/);
});

test('discovery paginates its filtered result locally and preserves upstream category filtering',async()=>{
  const filters=[];const source=fixtureEvents().data[0];
  const events=Array.from({length:102},(_,index)=>({...source,id:`event-${index}`,title:`Market ${String(index).padStart(3,'0')}`}));
  const handler=createHandler({client:{events:async options=>{filters.push(options);return {events,fetchedAt:+NOW};}},now:()=>+NOW});
  const first=await call(handler,'/api/markets?sector=crypto');
  const last=await call(handler,`/api/markets?sector=crypto&cursor=${first.body.nextCursor}`);
  assert.equal(first.statusCode,200);assert.equal(last.statusCode,200);assert.equal(first.body.hasMore,true);assert.equal(last.body.hasMore,false);
  assert.equal(first.body.offset,0);assert.equal(last.body.offset,100);assert.equal(last.body.nextOffset,null);assert.equal(last.body.total,102);
  assert.deepEqual([...first.body.events,...last.body.events].map(event=>event.id),events.map(event=>event.id));
  assert.equal(last.body.nextCursor,null);assert.deepEqual(filters,[{category:'Crypto'},{category:'Crypto'}]);
});

test('portable cursors do not skip or repeat surviving events when earlier events expire and instances change',async()=>{
  let clock=+NOW;const source=fixtureEvents().data[0];
  const original=Array.from({length:205},(_,index)=>({...source,id:`event-${index}`,title:`Market ${String(index).padStart(3,'0')}`,expiryDate:index<2?new Date(clock+60000).toISOString():source.expiryDate}));
  let listing=original;
  const instance=()=>createHandler({client:{events:async()=>({events:listing,fetchedAt:clock})},now:()=>clock});
  const first=await call(instance());assert.equal(first.statusCode,200);assert.equal(first.body.nextOffset,100);
  clock+=120000;
  listing=[{...source,id:'new-before',title:'A new first event'},...original.slice(2).reverse(),{...source,id:'new-after',title:'Z new last event'}];
  const second=await call(instance(),`/api/markets?cursor=${first.body.nextCursor}`);
  const third=await call(instance(),`/api/markets?cursor=${second.body.nextCursor}`);
  assert.equal(second.statusCode,200);assert.equal(third.statusCode,200);assert.equal(third.body.hasMore,false);
  assert.equal(second.body.fetchedAt,new Date(clock).toISOString());assert.equal(second.body.evaluatedAt,NOW.toISOString());
  const ids=[...first.body.events,...second.body.events,...third.body.events].map(event=>event.id);
  assert.deepEqual(ids,[...original.map(event=>event.id),'new-after']);assert.equal(new Set(ids).size,ids.length);
  const refreshed=await call(instance());assert.equal(refreshed.body.events[0].id,'new-before');assert.equal(refreshed.body.events.some(event=>event.id==='event-0'),false);
});

test('missing, mismatched, expired and malformed continuations require a refresh before fetching',async()=>{
  let clock=+NOW,calls=0;const source=fixtureEvents().data[0];
  const events=Array.from({length:102},(_,index)=>({...source,id:String(index),title:`Market ${index}`}));
  const handler=createHandler({client:{events:async()=>{calls++;return {events,fetchedAt:clock};}},now:()=>clock});
  const first=await call(handler,'/api/markets?category=Crypto');
  for(const suffix of ['offset=1',`category=Sports&cursor=${first.body.nextCursor}`,`category=Crypto&search=BTC&cursor=${first.body.nextCursor}`,'cursor=invalid','offset=1&snapshot=00000000-0000-0000-0000-000000000000']){
    const result=await call(handler,'/api/markets?'+suffix);assert.equal(result.statusCode,409);assert.match(result.body.error,/Refresh/);assert.equal('events' in result.body,false);
  }
  clock+=15*60*1000;
  const expired=await call(handler,`/api/markets?category=Crypto&cursor=${first.body.nextCursor}`);
  assert.equal(expired.statusCode,409);assert.equal(calls,1);
  const refreshed=await call(handler,'/api/markets?category=Crypto');assert.equal(refreshed.statusCode,200);assert.equal(calls,2);assert.notEqual(refreshed.body.nextCursor,first.body.nextCursor);
});

test('portable cursors break equal-title ties deterministically across differently ordered instances',async()=>{
  const source=fixtureEvents().data[0],events=Array.from({length:102},(_,index)=>({...source,id:`event-${String(index).padStart(3,'0')}`}));
  const first=await call(createHandler({client:{events:async()=>({events,fetchedAt:+NOW})},now:()=>+NOW}));
  const last=await call(createHandler({client:{events:async()=>({events:[...events].reverse(),fetchedAt:+NOW})},now:()=>+NOW}),`/api/markets?cursor=${first.body.nextCursor}`);
  assert.equal(last.statusCode,200);assert.deepEqual([...first.body.events,...last.body.events].map(event=>event.id),events.map(event=>event.id));
});

test('cursor metadata is bounded and validated before it can drive listing evaluation',async()=>{
  let calls=0;const source=fixtureEvents().data[0],events=Array.from({length:102},(_,index)=>({...source,id:String(index)}));
  const handler=createHandler({client:{events:async()=>{calls++;return {events,fetchedAt:+NOW};}},now:()=>+NOW});
  const first=await call(handler),cursor=JSON.parse(Buffer.from(first.body.nextCursor,'base64url').toString('utf8'));
  for(const mutation of [{version:2},{at:+NOW+1},{count:-1},{count:10001},{after:[0,0,0,'title']},{after:[0,1,0,'title','id']},{fingerprint:'wrong'}]){
    const token=Buffer.from(JSON.stringify({...cursor,...mutation})).toString('base64url');
    assert.equal((await call(handler,`/api/markets?cursor=${token}`)).statusCode,409);
  }
  assert.equal(calls,1);
});

test('generated continuations remain valid at Unicode and JSON-escaping title and ID boundaries',async()=>{
  const source=fixtureEvents().data[0];
  for(const character of ['市','\u0000']){
    const events=Array.from({length:102},(_,index)=>({...source,id:character.repeat(250)+String(index).padStart(6,'0'),title:character.repeat(1000)}));
    const instance=()=>createHandler({client:{events:async()=>({events,fetchedAt:+NOW})},now:()=>+NOW});
    const first=await call(instance());assert.equal(first.statusCode,200);assert.ok(first.body.nextCursor.length>4096);assert.ok(first.body.nextCursor.length<=16384);
    const last=await call(instance(),`/api/markets?cursor=${first.body.nextCursor}`);
    assert.equal(last.statusCode,200);assert.equal(last.body.events.length,2);assert.equal(last.body.hasMore,false);
  }
});

test('explicit search is applied with an asset filter and stays local to the cached listing',async()=>{
  const filters=[],source=fixtureEvents().data[0];
  const handler=createHandler({client:{events:async options=>{filters.push(options);return {events:[source,{...source,id:'later',title:'BTC price on November 15'}],fetchedAt:+NOW};}},now:()=>+NOW});
  const result=await call(handler,'/api/markets?asset=BTC&q=Bitcoin+is+going+up&search=October+31');
  assert.equal(result.statusCode,200);assert.equal(result.body.total,1);assert.equal(result.body.events[0].title,source.title);assert.deepEqual(filters,[{category:'Crypto'}]);
});

test('discovery upstream failures return an error and never synthetic or empty success data',async()=>{
  for(const error of [new DataError('Gemini is unreachable.'),new Error('private diagnostic')]){
    const handler=createHandler({client:{events:async()=>{throw error;}},now:()=>+NOW});const res=await call(handler);
    assert.equal(res.statusCode,502);assert.equal('events' in res.body,false);assert.equal(JSON.stringify(res.body).includes('private diagnostic'),false);
  }
  const malformed=createHandler({client:{events:async()=>({events:{},fetchedAt:+NOW})},now:()=>+NOW});assert.equal((await call(malformed)).statusCode,502);
  const missingTimestamp=createHandler({client:{events:async()=>({events:[]})},now:()=>+NOW});assert.equal((await call(missingTimestamp)).statusCode,502);
});
