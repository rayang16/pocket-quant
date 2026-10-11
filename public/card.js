import {percent,percentRange,money,date} from './ui.js';
function wrap(ctx,text,x,y,width,lineHeight,maxLines=6) {
  const words=text.split(/\s+/);let line='',lines=0;
  for(let i=0;i<words.length;i++) {
    const next=line+(line?' ':'')+words[i];
    if(ctx.measureText(next).width>width&&line) {ctx.fillText(line,x,y);y+=lineHeight;lines++;line=words[i];if(lines>=maxLines-1){line=[line,...words.slice(i+1)].join(' ');while(ctx.measureText(line+'…').width>width)line=line.slice(0,-1);ctx.fillText(line+'…',x,y);return y+lineHeight;}}
    else line=next;
  }
  if(line)ctx.fillText(line,x,y);return y+lineHeight;
}
export function drawCard(result,handle='') {
  if(!result.hypeVerdict)throw new Error('Only confirmed crypto checks can become verdict cards.');
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1350;const c=canvas.getContext('2d');
  c.fillStyle='#10141b';c.fillRect(0,0,1080,1350);c.fillStyle='#8aaaff';c.fillRect(64,64,12,34);
  c.font='bold 27px sans-serif';c.fillStyle='#eef2f8';c.fillText('GEM FINDER',96,92);c.font='20px monospace';c.fillStyle='#9aa8bb';c.fillText('A LITTLE LESS HYPE.',64,139);
  c.font='italic 44px Georgia';c.fillStyle='#eef2f8';wrap(c,`“${result.claim.summary}”`,64,230,952,54,4);
  c.font='22px monospace';c.fillStyle='#9aa8bb';c.fillText(handle?handle.slice(0,50):`Checked ${date(result.checkedAt)}`,64,452);
  const verdictColor={HYPE:'#ff9c9c',STRETCH:'#f2c57c','FAIR CALL':'#8ee0bf',UNDERSOLD:'#8aaaff'}[result.verdict]||'#8aaaff';
  c.strokeStyle=verdictColor;c.lineWidth=3;c.strokeRect(64,496,952,158);c.fillStyle=verdictColor;c.font=`bold ${result.verdict.length>8?85:115}px sans-serif`;c.fillText(result.verdict,90,618);
  const rows=[['SPEAKER SOUNDS',percent(result.claim.speakerConfidence)],
    [result.market.match==='exact'?'GEMINI MARKET':'NEAREST GEMINI CONTRACT',percent(result.market.prob)],['MATH · AT EXPIRY',percentRange(result.model.atExpiry)]];
  let y=725;
  for(const [label,value] of rows){c.fillStyle='#9aa8bb';c.font='22px monospace';c.fillText(label,64,y);c.fillStyle='#eef2f8';c.font='bold 45px sans-serif';c.textAlign='right';c.fillText(value,1016,y+4);c.textAlign='left';c.strokeStyle='#303b4b';c.lineWidth=1;c.beginPath();c.moveTo(64,y+30);c.lineTo(1016,y+30);c.stroke();y+=96;}
  c.font='23px sans-serif';c.fillStyle='#9aa8bb';wrap(c,`Touch before deadline: ${percentRange(result.model.touch)}. Confidence is a language heuristic.`,64,1015,952,31,2);
  c.font='21px sans-serif';wrap(c,`${result.claim.asset} ${result.claim.direction==='above'?'≥':'<'} ${money(result.claim.target)} · ${date(result.claim.deadlineISO)}${result.claim.deadlineAssumed?' · assumed deadline':''}`,64,1091,952,28,2);
  wrap(c,`Quoted contract: ${money(result.market.strike)} · ${date(result.market.expiryDate)} · ${result.market.side}. ${result.market.match==='exact'?'Exact match.':'Different target or expiry; not the claim’s odds.'}`,64,1154,952,28,2);
  c.fillStyle='#8aaaff';c.font='19px sans-serif';c.fillText('Odds: Gemini Prediction Markets · Math: lognormal / realized vol',64,1260);c.fillStyle='#9aa8bb';c.fillText('Sensitivity range, not a confidence interval. Not financial advice.',64,1292);
  return canvas;
}
export async function downloadCard(result,handle='') {
  const canvas=drawCard(result,handle);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('Could not create the card.');const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`gem-finder-${result.claim.asset.toLowerCase()}-${Date.now()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export async function shareCard(result,handle='') {
  const blob=await new Promise(resolve=>drawCard(result,handle).toBlob(resolve,'image/png'));
  if(!blob)throw new Error('Could not create the card.');
  const file=new File([blob],`gem-finder-${result.claim.asset.toLowerCase()}.png`,{type:'image/png'});
  if(!navigator.canShare?.({files:[file]}))throw new Error('File sharing is not available here. Download the card instead.');
  await navigator.share({files:[file],title:'Gem Finder — '+result.verdict});
}
