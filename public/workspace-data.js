/** Session-only analysis history. Nothing here uses localStorage or a server. */
export const WORKSPACE_KEY = 'pocket-quant-workspace-v1';
const LIMIT = 30;
let volatileChecks = [];
let volatileOnly = false;

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}
function validEntry(entry) {
  return entry && typeof entry.id === 'string' && entry.id.length > 0 &&
    typeof entry.text === 'string' && typeof entry.reelUrl === 'string' &&
    typeof entry.addedAt === 'string' && Number.isFinite(Date.parse(entry.addedAt)) &&
    entry.result && typeof entry.result === 'object' && !Array.isArray(entry.result) &&
    (entry.result.claim === undefined || entry.result.claim && typeof entry.result.claim === 'object' && !Array.isArray(entry.result.claim)) &&
    (entry.result.report === undefined || entry.result.report && typeof entry.result.report === 'object' && !Array.isArray(entry.result.report) &&
      entry.result.report.claim && typeof entry.result.report.claim === 'object' && typeof entry.result.report.claim.text === 'string');
}
function sanitized(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries.filter(entry => {
    if (!validEntry(entry) || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).slice(0, LIMIT);
}
function storage() {
  try { return globalThis.sessionStorage; } catch { return null; }
}
function persist(entries) {
  const store = storage();
  if (!store) return false;
  try {
    const encoded = entries.length ? JSON.stringify(entries) : null;
    if (encoded !== null) store.setItem(WORKSPACE_KEY, encoded);
    else store.removeItem(WORKSPACE_KEY);
    if (store.getItem(WORKSPACE_KEY) !== encoded) return false;
    volatileChecks = clone(entries) || [];
    volatileOnly = false;
    return true;
  } catch {
    return false;
  }
}

export function readChecks() {
  if (volatileOnly) return clone(volatileChecks) || [];
  const store = storage();
  if (!store) return clone(volatileChecks) || [];
  try {
    const raw = store.getItem(WORKSPACE_KEY);
    const entries = raw === null ? [] : sanitized(JSON.parse(raw));
    volatileChecks = clone(entries) || [];
    return clone(entries) || [];
  } catch (error) {
    // Malformed browser data is not usable history; blocked reads can use memory.
    if (error instanceof SyntaxError) { volatileChecks = []; return []; }
    return clone(volatileChecks) || [];
  }
}

export function recordCheck(result, { text, reelUrl = '' } = {}) {
  const snapshot = clone(result);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const claimText = typeof text === 'string' ? text.trim() : String(snapshot.claim?.summary || '').trim();
  const source = typeof reelUrl === 'string' ? reelUrl.trim() : '';
  const checks = readChecks();
  const previous = checks.find(entry => entry.text === claimText && entry.reelUrl === source);
  const entry = {
    id: previous?.id || globalThis.crypto?.randomUUID?.() || `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    text: claimText,
    reelUrl: source,
    result: snapshot,
    addedAt: new Date().toISOString(),
  };
  const next = [entry, ...checks.filter(item => item.id !== entry.id)].slice(0, LIMIT);
  const persisted = persist(next);
  if (!persisted) { volatileChecks = clone(next) || []; volatileOnly = true; }
  return { ...clone(entry), persisted };
}

export function removeCheck(id) {
  const previous = readChecks();
  const remaining = previous.filter(entry => entry.id !== id);
  const ok = persist(remaining);
  // A failed write leaves the visible collection unchanged, matching navigation.
  if (!ok) { volatileChecks = clone(previous) || []; volatileOnly = true; }
  return { ok, checks: clone(ok ? remaining : previous) || [] };
}

export function clearChecks() {
  const previous = readChecks();
  const ok = persist([]);
  if (!ok) { volatileChecks = clone(previous) || []; volatileOnly = true; }
  return { ok, checks: clone(ok ? [] : previous) || [] };
}
