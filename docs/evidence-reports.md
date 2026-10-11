# Reel reports with Gemini Exchange

The report uses Gemini Exchange public market data and deterministic text rules. It does not use Claude, Google Gemini, or an external web fact-checking service. No API key is required for claim review, market discovery, or the supported crypto probability model. Sandbox trading uses a separate OAuth connection, which is still awaiting Gemini approval.

## Flow

Supadata transcribes an accessible public Reel when configured. Text rules select up to three distinct claims while preserving the original words, qualifications, quantities, and deadlines. Users review each draft as a fact, forecast, or recommendation, then choose **Check with Gemini**. Each card runs separately, so one failed request does not erase other results. Editing the transcript or a claim cancels stale UI updates.

Supadata is the only paid provider in this Reel-to-report flow. Pasted transcripts do not need a transcription key. The separate recording-upload feature can use ElevenLabs when configured; it is not required for reports.

## Endpoints

- `POST /api/evidence-report?action=extract`, JSON `{text, sourceUrl?}`. Transcript: 3–6,000 characters. Returns `{claims, extraction, warnings, checkedAt}`. Each claim has `id`, `text`, `quote`, and `type` (`fact`, `forecast`, `recommendation`). Extraction uses text rules and requires user review.
- `POST /api/evidence-report?action=check`, JSON `{claim, sourceUrl?}`. Claim text: 3–500 characters; original quote: at most 2,000. Returns `{claim, assessment, market, model, checkedAt}`. The UI submits at most three cards concurrently. There are no external source-verification cards.

Both endpoints require JSON, limit bodies to 26 KB, reject cross-origin browser requests, and never fetch user-supplied URLs. An optional Reel URL is a validated reference. Identical requests share in-flight work and may be reused for five minutes, with a maximum of 100 cache entries. Limits are process-local: 12 fresh requests per client per minute and eight concurrent requests. Serverless instances do not share these limits or caches; they are not authenticated user quotas. Reports and transcripts are not stored in a database.

## What the results mean

- **Facts — `not_market_verifiable`:** Gemini contract prices cannot verify a historical agreement, endorsement, financial result, or product claim. No supported/contradicted factual verdict is issued.
- **Forecasts:** future outcomes remain uncertain. Related contracts provide market context, not proof that a forecast will happen.
- **Recommendations:** buying or selling suggestions remain opinions. Neither a quoted price nor a model estimate establishes suitability or profitability.

Related markets must match a sufficiently specific subject. Topic overlap still does not establish the same metric, quantity, settlement conditions, or deadline. Contract prices are labeled as quotes for those contracts, not as the probability of the Reel’s exact claim. A release market does not measure annual production volume. No matching market does not prove or disprove a claim.

The independent calculation is available only for a supported crypto price target with an explicit calendar deadline and year. It compares probability estimates across realized-volatility windows; both the price history and prediction-market quotes come from Gemini. The calculation is separate from the market quote, but it is not an independent data source. Relative deadlines from undated Reels need review. The single-crypto checker remains available separately with its disclosed date assumptions.

## Validation limits

Offline tests use fixtures and mocked services to check claim preservation, classification, request boundaries, market matching, caching, concurrency, cancellation, and partial failures. They do not prove that a specific live market is available or that every Reel can be transcribed. Report live Gemini checks, Supadata transcription, and actual iPhone Share Sheet tests separately. No simulated quotes or fabricated factual evidence are substituted when a service is unavailable.
