export function headers(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-File-Name');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='OPTIONS') {res.statusCode=204;res.end();return false;}
  if(req.method!=='POST') {send(res,405,{error:'Use POST for this endpoint.'});return false;}
  return true;
}
export function send(res,status,data) {res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));}
export async function rawBody(req,limit) {
  const fail=()=>{const e=new Error(`Upload is too large. Maximum ${(limit/1000000).toFixed(0)} MB.`);e.status=413;throw e;};
  if(Number(req.headers['content-length'])>limit) fail();
  if(req.body!==undefined) {
    const body=Buffer.isBuffer(req.body)?req.body:Buffer.from(typeof req.body==='string'?req.body:JSON.stringify(req.body));
    if(body.length>limit) fail();return body;
  }
  let size=0; const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>limit) fail();chunks.push(chunk);}
  return Buffer.concat(chunks);
}
