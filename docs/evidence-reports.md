# Reel reports with Gemini Exchange

The report uses **Gemini Exchange** public market data and optional Claude interpretation. Gemini Exchange is the exchange being showcased; it is not Google Gemini. No API key is required for market discovery, text-rule claim extraction, or the supported crypto probability model. A server-only `ANTHROPIC_API_KEY` enables Claude to select source-anchored claims and explain the supplied evidence. `CLAUDE_MODEL` defaults to `claude-sonnet-5-5`. Claude does not search the web or verify historical facts. Sandbox trading uses a separate OAuth connection, which is still awaiting Gemini approval.

## Flow

Supadata transcribes an accessible public Reel when configured. Up to three distinct claims are selected while preserving original quotes, qualifications, quantities, and deadlines. Claude can select the claims when configured; source validation and deterministic fallback keep the flow working if its output is unavailable or unusable. Gemini comparisons and supported crypto math start immediately after extraction, without a review click. Uploaded recordings follow the same automatic flow after ElevenLabs transcription. For pasted transcripts, **Check with Gemini** extracts and checks in one action; sample buttons also run the full flow.

Claims remain editable as facts, forecasts, or recommendations. Each card runs separately, so one failed request does not erase other results. Editing the transcript or a claim stops active checks and prevents stale UI updates. Users can explicitly recheck corrected text. Automatic reports use public data and never place trades; sandbox orders remain a separate flow with explicit confirmation.

Supadata transcription and optional Claude interpretation incur their respective provider charges. Pasted transcripts do not need a transcription key. The separate recording-upload feature can use ElevenLabs when configured; it is not required for reports.

## Endpoints

- `POST /api/evidence-report?action=extract`, JSON `{text, sourceUrl?}`. Transcript: 3–6,000 characters. Returns `{claims, extraction, warnings, checkedAt}`. Each claim has `id`, `text`, `quote`, and `type` (`fact`, `forecast`, `recommendation`). Extraction uses optional Claude selection with source validation and a deterministic fallback, and returns editable claims; the UI proceeds directly to the check endpoint.
- `POST /api/evidence-report?action=check`, JSON `{claim, sourceUrl?}`. Claim text: 3–500 characters; original quote: at most 2,000. Returns `{claim, assessment, market, model, evidence, explanation, checkedAt}`. `assessment.headline` is a deterministic conclusion that Claude cannot replace. `evidence` contains `{id,text}` items; `explanation` records `status` (`complete`, `unavailable`, or `disabled`), `provider: "claude"`, and optional `answer`, `reason`, and `evidenceIds`. A successful Claude explanation is labeled separately. The UI submits at most three cards concurrently. There are no external source-verification cards.

Both endpoints require JSON, limit bodies to 26 KB, reject cross-origin browser requests, and never fetch user-supplied URLs. An optional Reel URL is a validated reference. Identical requests share in-flight work and may be reused for five minutes, with a maximum of 100 cache entries. Limits are process-local: 12 fresh requests per client per minute and eight concurrent requests. Serverless instances do not share these limits or caches; they are not authenticated user quotas. Reports and transcripts are not stored in a database.

## Interpretation and data handling

Each card leads with a conclusion about the Reel’s actual claim, followed by the relevant Gemini contract and any supported model calculation. With Claude enabled, Anthropic receives the transcript for claim selection, then the claim, retrieved Gemini results, and applicable model output for explanation. The provider has no web-search tools and is instructed to use only supplied evidence, preserve quoted probabilities, and distinguish a related contract from an exact match. Server validation and fallback conclusions preserve the non-verifiable-fact, no-market, mismatch, and unavailable-data states. Missing credentials or a failed Claude call never prevent the automatic Gemini checks from completing. `/api/capabilities` exposes only a `claudeAnalysis` availability flag, never credentials.

Keys remain on the server and are never sent to the browser. Transcripts and reports are not stored in a database; provider processing policies still apply. Automatic reporting does not connect an account or place an order.

## What the results mean

- **Facts — `not_market_verifiable`:** Gemini contract prices cannot verify a historical agreement, endorsement, financial result, or product claim. No supported/contradicted factual verdict is issued.
- **Forecasts:** future outcomes remain uncertain. Related contracts provide market context, not proof that a forecast will happen.
- **Recommendations:** buying or selling suggestions remain opinions. Neither a quoted price nor a model estimate establishes suitability or profitability.

Related markets must match a sufficiently specific subject. Topic overlap still does not establish the same metric, quantity, settlement conditions, or deadline. Contract prices are labeled as quotes for those contracts, not as the probability of the Reel’s exact claim. A release market does not measure annual production volume. No matching market does not prove or disprove a claim.

The independent calculation is available only for a supported crypto price target with an explicit calendar deadline and year. It compares probability estimates across realized-volatility windows; both the price history and prediction-market quotes come from Gemini. The calculation is separate from the market quote, but it is not an independent data source. Relative deadlines from undated Reels need review. The single-crypto checker remains available separately with its disclosed date assumptions.

## Validation limits

Offline tests use fixtures and mocked services to check claim preservation, classification, request boundaries, market matching, caching, concurrency, cancellation, and partial failures. They do not prove that a specific live market is available or that every Reel can be transcribed. Report live Gemini checks, Supadata transcription, and actual iPhone Share Sheet tests separately. No simulated quotes or fabricated factual evidence are substituted when a service is unavailable.
