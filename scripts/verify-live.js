import {checkClaim} from '../lib/engine.js';
import {writeFile,mkdir} from 'node:fs/promises';
const claims=['Bitcoin to 150K by end of month, guaranteed 🚀','ETH is about to dump under 2,000 this week','SOL might hit 130 by Halloween',"It's definitely going to be over 95 degrees in Austin today"];
await mkdir(new URL('../output/',import.meta.url),{recursive:true});
for(const [i,text] of claims.entries()) {
  try {const r=await checkClaim(text);await writeFile(new URL(`../output/live-${i+1}.json`,import.meta.url),JSON.stringify(r,null,2));console.log(JSON.stringify({text,verdict:r.verdict,spot:r.inputs?.spot,vols:r.inputs?.vols,market:r.market?.eventTitle,strike:r.market?.strike,prob:r.market?.prob,model:r.model,explanation:r.message??r.explanation}));}
  catch(e){console.error(text+': '+e.message);process.exitCode=1;}
}
