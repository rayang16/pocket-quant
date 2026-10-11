import {createHash} from 'node:crypto';

const PREVIEW_MS = 120000;
const MAX_BUDGET_CENTS = 500;
const RESPONSE_BYTES = 65536;
const TIMEOUT_MS = 8000;
const TERMINAL = new Set(['complete', 'unknown', 'rejected']);
const JOURNAL_STATUSES = new Set(['submitting', ...TERMINAL]);

// Reservation, one-use consumption and the account gate precede the exchange call.
const BEGIN = `
local existing = redis.call('GET', KEYS[2])
if existing then
  local journal = cjson.decode(existing)
  if journal.sessionId ~= ARGV[1] then return cjson.encode({ok=false,reason='session_mismatch'}) end
  if journal.accountId ~= ARGV[2] then return cjson.encode({ok=false,reason='account_mismatch'}) end
  return cjson.encode({ok=false,reason='duplicate',submission=journal})
end
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false,reason='preview_missing'}) end
local preview = cjson.decode(raw)
if preview.sessionId ~= ARGV[1] then return cjson.encode({ok=false,reason='session_mismatch'}) end
if preview.accountId ~= ARGV[2] then return cjson.encode({ok=false,reason='account_mismatch'}) end
local now = tonumber(ARGV[3])
local amount = tonumber(preview.estimatedTotalCents)
if not amount or amount < 1 or amount > 500 or amount ~= math.floor(amount) then return cjson.encode({ok=false,reason='corrupt_state'}) end
if not tonumber(preview.expiresAt) or tonumber(preview.expiresAt) <= now then return cjson.encode({ok=false,reason='preview_expired'}) end
local reservedRaw = redis.call('HGET', KEYS[3], 'reservedCents')
local reserved = reservedRaw and tonumber(reservedRaw) or 0
if not reserved or reserved < 0 or reserved > 500 or reserved ~= math.floor(reserved) then return cjson.encode({ok=false,reason='corrupt_state'}) end
local gate = redis.call('HGET', KEYS[3], 'unresolved')
if gate and gate ~= '' then return cjson.encode({ok=false,reason='unresolved_submission',budget={reservedCents=reserved,unresolved=true}}) end
local maximum = tonumber(ARGV[4])
if not maximum or maximum < 1 or maximum > 500 or reserved + amount > maximum then return cjson.encode({ok=false,reason='budget_exceeded',budget={reservedCents=reserved,unresolved=false}}) end
local journal = {sessionId=preview.sessionId,accountId=preview.accountId,order=preview.order,estimatedTotalCents=amount,expiresAt=preview.expiresAt,status='submitting',startedAt=now,updatedAt=now}
redis.call('HSET', KEYS[3], 'reservedCents', reserved + amount, 'unresolved', KEYS[2])
redis.call('SET', KEYS[2], cjson.encode(journal))
redis.call('DEL', KEYS[1])
return cjson.encode({ok=true,submission=journal,budget={reservedCents=reserved+amount,unresolved=true}})
`;

const FINISH = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false,reason='submission_missing'}) end
local journal = cjson.decode(raw)
if journal.accountId ~= ARGV[3] then return cjson.encode({ok=false,reason='corrupt_state'}) end
if journal.status == 'complete' or journal.status == 'rejected' then return cjson.encode({ok=true,submission=journal}) end
if journal.status ~= 'submitting' and journal.status ~= 'unknown' then return cjson.encode({ok=false,reason='corrupt_state'}) end
local reserved = tonumber(redis.call('HGET', KEYS[2], 'reservedCents'))
local gate = redis.call('HGET', KEYS[2], 'unresolved')
if not reserved or reserved < journal.estimatedTotalCents or reserved > 500 or gate ~= KEYS[1] then return cjson.encode({ok=false,reason='corrupt_state'}) end
local result = cjson.decode(ARGV[1])
if result.status ~= 'complete' and result.status ~= 'unknown' and result.status ~= 'rejected' then return cjson.encode({ok=false,reason='invalid_result'}) end
journal.status = result.status
journal.result = result
journal.updatedAt = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(journal))
if result.status ~= 'unknown' then redis.call('HDEL', KEYS[2], 'unresolved') end
return cjson.encode({ok=true,submission=journal})
`;

function fail(code = 'STORE_UNAVAILABLE') {
  return Object.assign(new Error('Live order storage is unavailable. No new order can be authorized.'), {code});
}
function identifier(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
function validToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw fail('STORE_INVALID_INPUT');
  return value;
}
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function jsonObject(value, limit = 6000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('STORE_INVALID_INPUT');
  let encoded;
  try {encoded = JSON.stringify(value);} catch {throw fail('STORE_INVALID_INPUT');}
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > limit) throw fail('STORE_INVALID_INPUT');
  return JSON.parse(encoded);
}
function previewRecord(record) {
  if (!record || !identifier(record.sessionId) || !identifier(record.accountId)
    || !integer(record.estimatedTotalCents, 1, MAX_BUDGET_CENTS) || !integer(record.expiresAt, 1)) throw fail('STORE_INVALID_INPUT');
  return {sessionId: record.sessionId, accountId: record.accountId, order: jsonObject(record.order),
    estimatedTotalCents: record.estimatedTotalCents, expiresAt: record.expiresAt};
}
function journalRecord(record) {
  try {
    const preview = previewRecord(record);
    if (!JOURNAL_STATUSES.has(record.status) || !integer(record.startedAt, 1) || !integer(record.updatedAt, record.startedAt)) throw fail();
    const journal = {...preview, status: record.status, startedAt: record.startedAt, updatedAt: record.updatedAt};
    if (record.result !== undefined) {
      journal.result = jsonObject(record.result);
      if (journal.result.status !== record.status || !TERMINAL.has(journal.result.status)) throw fail();
    } else if (record.status !== 'submitting') throw fail();
    return journal;
  } catch {throw fail('STORE_CORRUPT_STATE');}
}
function budgetRecord(record) {
  if (!record || !integer(record.reservedCents, 0, MAX_BUDGET_CENTS) || typeof record.unresolved !== 'boolean') throw fail('STORE_CORRUPT_STATE');
  return {reservedCents: record.reservedCents, unresolved: record.unresolved};
}
function parsed(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16000) throw fail('STORE_CORRUPT_STATE');
  try {return JSON.parse(value);} catch {throw fail('STORE_CORRUPT_STATE');}
}
async function readBody(response) {
  if (Number(response.headers?.get?.('content-length')) > RESPONSE_BYTES) throw fail();
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > RESPONSE_BYTES) throw fail();
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_BYTES) {void reader.cancel().catch(() => {}); throw fail();}
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {reader.releaseLock();}
}

/** Durable, fail-closed storage. The caller must never place an order unless beginSubmission returns ok:true. */
export function createLiveOrderStore({url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN,
  fetchImpl = globalThis.fetch, namespace = 'pocket-quant-live-v1'} = {}) {
  if (!url || !token) return null;
  let endpoint;
  try {
    endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.upstash\.io$/.test(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw fail();
  } catch {throw fail('STORE_INVALID_CONFIG');}
  if (!identifier(token, 8192) || typeof fetchImpl !== 'function' || !/^[a-zA-Z0-9_-]{1,80}$/.test(namespace)) throw fail('STORE_INVALID_CONFIG');
  const key = (kind, value) => `${namespace}:${kind}:${createHash('sha256').update(value).digest('hex')}`;
  const previewKey = value => key('preview', validToken(value));
  const submissionKey = value => key('submission', validToken(value));
  function accountKey(accountId) {
    if (!identifier(accountId)) throw fail('STORE_INVALID_INPUT');
    return key('budget', accountId);
  }
  async function command(parts) {
    const body = JSON.stringify(parts);
    if (Buffer.byteLength(body) > 24000) throw fail('STORE_INVALID_INPUT');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(fail('STORE_TIMEOUT'));}, TIMEOUT_MS);});
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(endpoint.href, {method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body});
        if (!response.ok) throw fail();
        const data = JSON.parse(await readBody(response));
        if (!data || Object.hasOwn(data, 'error') || !Object.hasOwn(data, 'result')) throw fail();
        return data.result;
      })()]);
    } catch (error) {throw fail(error?.code === 'STORE_TIMEOUT' ? 'STORE_TIMEOUT' : 'STORE_UNAVAILABLE');}
    finally {clearTimeout(timer);}
  }
  async function getSubmission(value) {
    const raw = await command(['GET', submissionKey(value)]);
    return raw === null ? null : journalRecord(parsed(raw));
  }
  return {
    durable: true,
    async putPreview(value, record) {
      const storageKey = previewKey(value), safe = previewRecord(record), ttl = safe.expiresAt - Date.now();
      if (!integer(ttl, 1, PREVIEW_MS)) throw fail('STORE_INVALID_INPUT');
      const result = await command(['SET', storageKey, JSON.stringify(safe), 'NX', 'PX', ttl]);
      if (result === null) throw fail('STORE_PREVIEW_EXISTS');
      if (result !== 'OK') throw fail('STORE_CORRUPT_STATE');
      return safe;
    },
    async getPreview(value) {
      const raw = await command(['GET', previewKey(value)]);
      if (raw === null) return null;
      let record;
      try {record = previewRecord(parsed(raw));} catch {throw fail('STORE_CORRUPT_STATE');}
      return record.expiresAt > Date.now() ? record : null;
    },
    async beginSubmission(value, {sessionId, accountId, now, maxBudgetCents = MAX_BUDGET_CENTS} = {}) {
      if (!identifier(sessionId) || !identifier(accountId) || !integer(now, 1) || !integer(maxBudgetCents, 1, MAX_BUDGET_CENTS)) throw fail('STORE_INVALID_INPUT');
      const result = parsed(await command(['EVAL', BEGIN, 3, previewKey(value), submissionKey(value), accountKey(accountId), sessionId, accountId, now, maxBudgetCents]));
      if (!result || typeof result.ok !== 'boolean') throw fail('STORE_CORRUPT_STATE');
      if (result.ok) {
        const submission = journalRecord(result.submission), budget = budgetRecord(result.budget);
        if (submission.status !== 'submitting' || submission.sessionId !== sessionId || submission.accountId !== accountId
          || submission.expiresAt <= now || budget.reservedCents < submission.estimatedTotalCents || budget.reservedCents > maxBudgetCents || !budget.unresolved) throw fail('STORE_CORRUPT_STATE');
        return {ok: true, submission, budget};
      }
      const reasons = new Set(['duplicate', 'preview_missing', 'preview_expired', 'session_mismatch', 'account_mismatch', 'unresolved_submission', 'budget_exceeded']);
      if (!reasons.has(result.reason)) throw fail('STORE_CORRUPT_STATE');
      const rejected = {ok: false, reason: result.reason};
      if (result.submission !== undefined) {
        rejected.submission = journalRecord(result.submission);
        if (rejected.submission.sessionId !== sessionId || rejected.submission.accountId !== accountId) throw fail('STORE_CORRUPT_STATE');
      }
      if (result.budget !== undefined) rejected.budget = budgetRecord(result.budget);
      return rejected;
    },
    async finishSubmission(value, result) {
      const safe = jsonObject(result);
      if (!TERMINAL.has(safe.status)) throw fail('STORE_INVALID_INPUT');
      const previous = await getSubmission(value);
      if (!previous) throw fail('STORE_SUBMISSION_MISSING');
      const response = parsed(await command(['EVAL', FINISH, 2, submissionKey(value), accountKey(previous.accountId), JSON.stringify(safe), Date.now(), previous.accountId]));
      if (!response?.ok) throw fail('STORE_CORRUPT_STATE');
      const journal = journalRecord(response.submission);
      if (journal.accountId !== previous.accountId || journal.sessionId !== previous.sessionId || !TERMINAL.has(journal.status)) throw fail('STORE_CORRUPT_STATE');
      return journal;
    },
    getSubmission,
    async getBudget(accountId) {
      const result = await command(['HMGET', accountKey(accountId), 'reservedCents', 'unresolved']);
      if (!Array.isArray(result) || result.length !== 2) throw fail('STORE_CORRUPT_STATE');
      if (result[0] === null && result[1] === null) return {reservedCents: 0, unresolved: false};
      if (typeof result[0] !== 'string' || !/^\d+$/.test(result[0]) || (result[1] !== null && typeof result[1] !== 'string')) throw fail('STORE_CORRUPT_STATE');
      return budgetRecord({reservedCents: Number(result[0]), unresolved: result[1] !== null && result[1] !== ''});
    }
  };
}
