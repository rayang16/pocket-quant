const clamp = x => Math.max(0, Math.min(1, x));
export function normCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + .3275911 * z);
  const tail = .5 * (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-z * z);
  return x===0 ? .5 : clamp(x<0 ? tail : 1-tail);
}
function valid(S, K, T, sigma) {
  if (![S,K,T,sigma].every(Number.isFinite) || S <= 0 || K <= 0 || T < 0 || sigma < 0) throw new RangeError('Invalid pricing inputs');
}
export function probCloseAbove(S, K, T, sigma) {
  valid(S,K,T,sigma);
  if (!T || !sigma) return S >= K ? 1 : 0;
  return normCdf((Math.log(S/K) - sigma*sigma*T/2) / (sigma*Math.sqrt(T)));
}
export function probCloseBelow(S,K,T,sigma) {
  valid(S,K,T,sigma);
  if(!T||!sigma) return S<K ? 1 : 0;
  return normCdf(-(Math.log(S/K)-sigma*sigma*T/2)/(sigma*Math.sqrt(T)));
}
// A barrier that is already met has already been touched. Direction matters.
export function probTouch(S, K, T, sigma, direction = K >= S ? 'above' : 'below') {
  valid(S,K,T,sigma);
  if ((direction === 'above' && S >= K) || (direction === 'below' && S <= K)) return 1;
  if (!T || !sigma) return 0;
  const b = Math.abs(Math.log(K/S));
  const nu = (direction === 'above' ? -1 : 1) * sigma*sigma/2;
  const scale = sigma*Math.sqrt(T);
  return clamp(normCdf((-b+nu*T)/scale) + Math.exp(2*nu*b/(sigma*sigma))*normCdf((-b-nu*T)/scale));
}
export function realizedVol(closes, window) {
  if (!Number.isInteger(window) || window < 2 || closes.length < window+1) return null;
  const sample = closes.slice(-(window+1));
  if (sample.some(x => !Number.isFinite(x) || x <= 0)) return null;
  const r = sample.slice(1).map((x,i) => Math.log(x/sample[i]));
  const mean = r.reduce((a,b) => a+b,0)/r.length;
  return Math.sqrt(r.reduce((a,b) => a+(b-mean)**2,0)/(r.length-1))*Math.sqrt(365);
}
// Binary prices can imply TWO volatility roots when K > S. Do not silently choose one.
export function impliedVolSolutions(S,K,T,p) {
  if (!(p > 0 && p < 1 && T > 0)) return [];
  const f = v => probCloseAbove(S,K,T,v)-p;
  const tolerance=1e-12*Math.min(p,1-p);
  const roots = [];
  let a=.05, fa=f(a);
  for (let i=1;i<=790;i++) {
    const b=.05+i*.005, fb=f(b);
    if (Math.abs(fa)<tolerance && !roots.some(x=>Math.abs(x-a)<1e-5)) roots.push(a);
    if (fa*fb<0) {
      let lo=a, hi=b;
      for(let j=0;j<45;j++) { const m=(lo+hi)/2; if(f(lo)*f(m)<=0) hi=m; else lo=m; }
      const root=(lo+hi)/2;
      if(!roots.some(x=>Math.abs(x-root)<1e-5)) roots.push(root);
    }
    a=b; fa=fb;
  }
  if(Math.abs(fa)<tolerance && !roots.some(x=>Math.abs(x-4)<1e-5)) roots.push(4);
  return roots;
}
export function impliedVolFromBinary(S,K,T,p) {
  const roots=impliedVolSolutions(S,K,T,p);
  return roots.length===1 ? roots[0] : null;
}
export function speakerConfidence(text) {
  const s=text.toLowerCase().replace(/[’]/g,"'");
  // Hedging or explicit negation takes precedence over a confidence keyword.
  if (/\b(?:not|isn't|isnt|is not|no)\s+(?:a\s+)?(?:guarantee\w*|certain|sure)|\b(?:could|might|maybe)\b/.test(s)) return .4;
  if (/guaranteed|100\s*%|\block\b|can't lose|cannot lose|mark my words/.test(s)) return .97;
  if (/definitely|for sure/.test(s)) return .93;
  if (/\b(?:likely|probably|should)\b/.test(s)) return .70;
  if (/\bi think\b/.test(s)) return .65;
  if (/\b(?:will|going to|gonna|about to)\b/.test(s)) return .85;
  return .80;
}
export function hypeVerdict(speaker,evidence) {
  const gap=speaker-evidence;
  return {label:gap>=.5?'HYPE':gap>=.2?'STRETCH':gap>-.2?'FAIR CALL':'UNDERSOLD',gap};
}
export function marketVsModel(p,lo,hi,halfSpread) {
  if (![p,lo,hi,halfSpread].every(Number.isFinite)) return {label:'INSUFFICIENT QUOTES',threshold:null};
  const threshold=Math.max(halfSpread,.01);
  return {label:p-hi>threshold?'MARKET RICH':lo-p>threshold?'MARKET CHEAP':'FAIR',threshold};
}
export const range = values => ({lo:Math.min(...values),hi:Math.max(...values)});
