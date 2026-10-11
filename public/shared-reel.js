// Share Sheet links are references, never a transcript or evidence of a claim.
export function parseSharedReel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 12000) return {error:'Share one Instagram Reel link (up to 12,000 characters).'};
  const urls = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const reels = [];
  for (const candidate of urls) {
    try {
      const url = new URL(candidate.replace(/[),.!?]+$/, ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !['instagram.com','www.instagram.com','m.instagram.com'].includes(url.hostname)) continue;
      const match = url.pathname.match(/^\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)\/?$/);
      if (match) reels.push(`https://www.instagram.com/${url.pathname.startsWith('/p/')?'p':'reel'}/${match[1]}/`);
    } catch { /* Treat malformed shared content as unsupported. */ }
  }
  const unique = [...new Set(reels)];
  if (unique.length !== 1) return {error:unique.length > 1 ? 'Share one Reel at a time.' : 'This share does not contain a supported Instagram Reel or post link. Use Share → Copy link on the Reel, or paste its prediction.'};
  return {url:unique[0]};
}

export function sharedInput(location) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  if (hash.has('shared')) return hash.get('shared');
  if (['url','text','title'].some(key=>query.has(key))) return ['url','text','title'].map(key=>query.get(key)||'').join('\n');
  return null;
}
