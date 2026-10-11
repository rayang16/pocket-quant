#!/usr/bin/env node
import {checkClaim} from '../lib/engine.js';
const text=process.argv.slice(2).join(' ').trim();
if(!text) {
  console.error('Usage: node scripts/try.js "Bitcoin to 150K by end of month, guaranteed"');
  process.exitCode=1;
} else {
  try {console.log(JSON.stringify(await checkClaim(text),null,2));}
  catch(error) {console.error(JSON.stringify({error:error.message},null,2));process.exitCode=1;}
}
