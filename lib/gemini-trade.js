import {randomBytes} from 'node:crypto';
import {getSession,requireMutation,sandboxRequest,HttpError} from './gemini-account.js';

const API='https://api.sandbox.gemini.com';
const PREVIEW_MS=120000;
function fail(status,message,code){const error=new HttpError(status,message);error.code=code;throw error;}
function richText(value,depth=0){
  if(depth>12||!value)return '';
  if(typeof value==='string')return value.slice(0,6000);
  return [typeof value.value==='string'?value.value:'',...(Array.isArray(value.content)?value.content.slice(0,100).map(v=>richText(v,depth+1)):[])].filter(Boolean).join(' ').slice(0,6000);
}
const quote=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<1?Number(value):null;
function units(value){if(!/^\d+(?:\.\d{1,8})?$/.test(String(value)))return null;const [whole,fraction='']=String(value).split('.');return BigInt(whole)*100000000n+BigInt(fraction.padEnd(8,'0'));}
function grid(value,minimum,increment){
  if(minimum===undefined&&increment===undefined)return true;
  const v=units(value),min=units(minimum??'0'),step=units(increment??'0.00000001');
  return v!==null&&min!==null&&step!==null&&step>0n&&v>=min&&(v-min)%step===0n;
}
export function normalizeMarkets(events,now=Date.now()){
  const markets=new Map();
  function visit(event,depth=0){
    if(depth>3||event?.status!=='active')return;
    for(const contract of event.contracts??[]){
      const expiresAt=contract.expiryDate??event.expiryDate;
      if(contract.status!=='active'||contract.marketState!=='open'||contract.isCombo===true||!(Date.parse(expiresAt)>now))continue;
      if(typeof contract.instrumentSymbol!=='string'||contract.instrumentSymbol.length>200||!contract.instrumentSymbol.startsWith('GEMI-'))continue;
      markets.set(contract.instrumentSymbol,{
        symbol:contract.instrumentSymbol,title:String(contract.label??contract.instrumentSymbol).slice(0,500),
        eventTitle:String(event.title??'Prediction market').slice(0,500),description:richText(contract.description)||richText(event.description),
        yesAsk:quote(contract.prices?.buy?.yes??contract.prices?.bestAsk),noAsk:quote(contract.prices?.buy?.no),expiresAt,
        quantityMinimum:contract.quantityMinimum,quantityIncrement:contract.quantityIncrement,
        priceMinimum:contract.priceMinimum,priceIncrement:contract.priceIncrement
      });
    }
    for(const child of event.events??[])visit(child,depth+1);
  }
  for(const event of events)visit(event);
  return [...markets.values()].slice(0,300);
}

// Single-use previews live only in their issuing process. Another instance or a
// restart fails closed instead of replaying a stateless order authorization.
// Replace this store with atomic durable storage before production trading.
export function createGeminiTrade({account={getSession,requireMutation,sandboxRequest},fetchImpl=globalThis.fetch,now=Date.now}={}){
  const previews=new Map();
  async function markets(){
    let response,data;
    try{response=await fetchImpl(API+'/v1/prediction-markets/events?status=active&limit=100',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(12000),redirect:'error'});}
    catch{fail(502,'Gemini’s sandbox markets are unavailable. Try again shortly.');}
    if(!response.ok)fail(502,'Gemini’s sandbox could not load markets.');
    try{data=await response.json();}catch{fail(502,'Gemini’s sandbox returned unreadable markets.');}
    if(!Array.isArray(data?.data))fail(502,'Gemini’s sandbox returned an unexpected market list.');
    return normalizeMarkets(data.data,now());
  }
  async function checkTerms(session){
    const terms=await account.sandboxRequest(session,'/v1/prediction-markets/terms/status');
    if(terms?.hasAcceptedLatest!==true)fail(409,'Open Gemini’s sandbox and accept the latest Prediction Markets terms, then try again.','TERMS_REQUIRED');
  }
  function validate(body,market){
    if(!['yes','no'].includes(body.outcome))fail(400,'Choose YES or NO.');
    if(typeof body.quantity!=='string'||!/^\d{1,3}$/.test(body.quantity)||+body.quantity<1||+body.quantity>100)fail(400,'Choose 1 to 100 whole test contracts.');
    if(typeof body.price!=='string'||!/^0?\.\d{1,2}$/.test(body.price)||+body.price<0.01||+body.price>0.99)fail(400,'Enter a limit price from $0.01 to $0.99 in whole cents.');
    if(!grid(body.quantity,market.quantityMinimum,market.quantityIncrement)||!grid(body.price,market.priceMinimum,market.priceIncrement))fail(400,'That amount or price does not fit this contract’s trading increments.');
    const quantity=String(Number(body.quantity)),price=Number(body.price).toFixed(2);
    return {symbol:market.symbol,title:market.title,eventTitle:market.eventTitle,description:market.description,
      expiresAt:market.expiresAt,outcome:body.outcome,quantity,price,notional:(Number(quantity)*Math.round(Number(price)*100)/100).toFixed(2)};
  }
  async function preview(req,body){
    const session=account.requireMutation(req,body);
    if(typeof body.symbol!=='string'||body.symbol.length>200)fail(400,'Choose an available sandbox market.');
    const market=(await markets()).find(m=>m.symbol===body.symbol);
    if(!market)fail(409,'This sandbox contract is no longer available. Refresh the markets.');
    const order=validate(body,market);
    await checkTerms(session);
    for(const [key,value]of previews)if(value.expiresAt<=now())previews.delete(key);
    if(previews.size>=1000)fail(503,'The sandbox demo is busy. Please try again shortly.');
    // A new review replaces every previous review for this connected session.
    for(const [key,value]of previews)if(value.sessionId===session.id&&!value.used)previews.delete(key);
    const token=randomBytes(32).toString('base64url'),expiresAt=Math.min(now()+PREVIEW_MS,session.expiresAt);
    previews.set(token,{sessionId:session.id,order,expiresAt,used:false});
    return {sandbox:true,previewToken:token,previewExpiresAt:new Date(expiresAt).toISOString(),order};
  }
  async function submit(req,body){
    const session=account.requireMutation(req,body);
    if(body.confirmed!==true)fail(400,'Review and confirm this test order first.');
    const ticket=typeof body.previewToken==='string'?previews.get(body.previewToken):null;
    if(!ticket||ticket.sessionId!==session.id||ticket.expiresAt<=now())fail(409,'This review expired or the demo restarted. Review the order again.','PREVIEW_EXPIRED');
    if(ticket.used)fail(409,'This test order was already submitted. Check Gemini’s sandbox order history.','ALREADY_SUBMITTED');
    // Consume before any asynchronous work; concurrent requests cannot submit twice.
    ticket.used=true;
    const market=(await markets()).find(m=>m.symbol===ticket.order.symbol);
    if(!market)fail(409,'This sandbox contract is no longer open. No order was sent.');
    validate(ticket.order,market);
    if(market.expiresAt!==ticket.order.expiresAt||market.title!==ticket.order.title||market.description!==ticket.order.description)fail(409,'The market conditions changed. Review the order again.');
    await checkTerms(session);
    if(ticket.expiresAt<=now()||Date.parse(market.expiresAt)<=now())fail(409,'This order review expired. No order was sent.','PREVIEW_EXPIRED');
    const {symbol,outcome,quantity,price}=ticket.order;
    let result;
    try{result=await account.sandboxRequest(session,'/v1/prediction-markets/order',{method:'POST',body:{symbol,outcome,quantity,price,side:'buy',orderType:'limit',timeInForce:'immediate-or-cancel'}});}
    catch{fail(502,'We could not confirm whether Gemini accepted the test order. Check your sandbox order history before creating another order. Do not retry this submission.','UNKNOWN_RESULT');}
    if(!result?.orderId||!['open','filled','cancelled','canceled','partially_filled'].includes(result.status))fail(502,'Gemini returned an uncertain order result. Check your sandbox order history before creating another order.','UNKNOWN_RESULT');
    return {sandbox:true,order:{orderId:result.orderId,status:result.status,symbol,outcome,quantity,price,
      filledQuantity:result.filledQuantity??null,remainingQuantity:result.remainingQuantity??null}};
  }
  return {markets,preview,submit,getSession:account.getSession};
}
