import {send} from '../lib/http.js';
export default function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return send(res,405,{error:'Use GET for this endpoint.'});
  send(res,200,{transcription:!!process.env.ELEVENLABS_API_KEY,reelTranscription:!!process.env.SUPADATA_API_KEY,marketReports:true,claimExtraction:true,claudeAnalysis:!!process.env.ANTHROPIC_API_KEY});
}
