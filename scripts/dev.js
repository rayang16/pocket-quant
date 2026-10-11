import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import check from '../api/check.js';
import transcribe from '../api/transcribe.js';
import capabilities from '../api/capabilities.js';
import reelTranscript from '../api/reel-transcript.js';
import evidenceReport from '../api/evidence-report.js';
import geminiAccount from '../api/gemini-account.js';
import geminiTrade from '../api/gemini-trade.js';
import liveTrade from '../api/live-trade.js';
import markets from '../api/markets.js';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.zip':'application/zip','.json':'application/json','.shortcut':'application/octet-stream'};
const port=Number(process.env.PORT||3000);
createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/check') return check(req,res);
  if(url.pathname==='/api/transcribe') return transcribe(req,res);
  if(url.pathname==='/api/capabilities') return capabilities(req,res);
  if(url.pathname==='/api/reel-transcript') return reelTranscript(req,res);
  if(url.pathname==='/api/evidence-report') return evidenceReport(req,res);
  if(url.pathname==='/api/gemini-account') return geminiAccount(req,res);
  if(url.pathname==='/api/gemini-trade') return geminiTrade(req,res);
  if(url.pathname==='/api/live-trade') return liveTrade(req,res);
  if(url.pathname==='/api/markets') return markets(req,res);
  if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405);return res.end();}
  try {
    const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!path.startsWith(root.endsWith(sep)?root:root+sep)) {res.writeHead(403);return res.end();}
    const body=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:body);
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Gem Finder: http://localhost:${port}`));
