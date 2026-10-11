# Pocket Quant technical reference

Implementation details for teammates extending the current mobile web app. Start with the [README](../README.md) for the product, setup, and verification status. All shell commands and JavaScript import examples below assume the repository root.

## Probability model


A YES contract pays $1 if the condition resolves true and $0 otherwise, so its price is an indicative market probability (with fees, liquidity, and risk preferences as caveats).

- **At expiry:** the lognormal binary-option formula `N(d2)`, where `d2 = (ln(S/K) − σ²T/2)/(σ√T)`. Below-target probabilities use a numerically stable lower-tail equivalent.
- **Touch:** the reflection-principle probability of crossing the barrier at any time before the deadline, with the drift sign flipped for down-barriers. Already-met barriers have touch probability 1.
- **Volatility range:** sample standard deviation of daily log returns × √365 over 14, 30 and 90 days. We require 91 contiguous completed daily closes and exclude the open daily candle. The range is sensitivity to those windows, **not a confidence interval**.
- **Hype gap:** a disclosed language-confidence heuristic minus the larger of the realized-volatility touch range midpoint and the market-implied target estimate (or an exact matching quote). If implied volatility has two roots, the larger target estimate is used. 50+ percentage points → HYPE; 20+ → STRETCH; above −20 → FAIR CALL; otherwise UNDERSOLD.
- **Market vs model:** compare the matched contract at its own strike AND expiry. Flag rich/cheap only beyond the model range plus `max(halfSpread, 1¢)`. Without a usable two-sided book, return **INSUFFICIENT QUOTES**.
- **Unlisted target:** show the closest quoted strike explicitly. An indicative upper bound is shown only beyond the listed strikes at the same expiry, and applies only to expiry—not touch. Exact-target estimates are model extrapolations, not Gemini prices.
- **Implied volatility ambiguity:** binary prices can have two volatility roots for above-spot strikes. Grid search + bisection preserves both roots in [5%, 400%] and includes both estimates. No attainable root means no implied estimate. The single-value helper returns null for ambiguous cases.

The zero-drift lognormal model ignores jump risk and understates fat tails. Realized volatility is not implied volatility. Gemini spot can differ from the index used to settle a prediction contract. Do not treat this as a recommendation, trade signal, calibrated forecast, or financial advice.

### Claim parsing and honest uncertainty

The Reel report selects up to three distinct claims, optionally with Claude, and validates that their quotes preserve original transcript wording. Without Claude or if it fails, deterministic text rules provide the fallback. Market checks and supported crypto calculations start automatically after transcription and extraction. Users can edit and classify each as a fact, forecast, or recommendation, then recheck any corrections. Each card leads with a plain-language conclusion tied to the actual claim. Historical facts receive `not_market_verifiable`; recommendations remain opinions; forecasts remain uncertain. Optional Claude explanations use only the supplied Gemini results and model output, with no external fact-checking or invented quotes. Related Gemini contracts never become a supported/contradicted verdict on a factual claim. The report applies crypto probability math only when the claim has a supported target and an explicit calendar deadline with a year. Relative dates in undated Reels need review.

The separate single-crypto checker handles BTC/ETH/SOL/XRP/ZEC aliases, k/m amounts, commas, percentage moves, caption noise, and relative/calendar deadlines. Absolute dollar target candidates must be between 0.2× and 10× live spot; percentage-move targets follow their separate parsing path. Multiple plausible targets require clarification. Calendar context is America/Los_Angeles; deadlines resolve to **21:00 UTC**, as requested for the demo. This equals 5 PM Eastern only during daylight saving time. No date means +30 days, visibly labeled. “This week” ends Sunday. Past deadlines are rejected.

Speaker confidence is inferred from words, not a scientific measurement. Negation and hedging take priority over confidence words. Non-crypto searches show **possible matches**, actual quoted contract odds and links; they do not pretend that keyword matching confirms resolution criteria. There is no weather/sports probability model or settled-market calibration layer in this build.

### Market data and failures

Public Gemini API: active events (paginated), spot ticker, daily candles. Both market quotes and model inputs come from Gemini; the model is a separate calculation, not an independent data source. In-memory caches: events 30 seconds, spot 15 seconds, candles 10 minutes. Concurrent calls share in-flight requests. Retrieval timestamps are displayed; the API does not establish last-trade freshness. Missing price fields are not zero. Crossed books disable spread-based judgments. No market means no hype verdict. Network/API failure produces an explicit error, never demo data.


## Architecture


```
lib/math.js        pure probability, volatility, confidence and comparison functions
lib/gemini.js      cached public Gemini client and quote normalization
lib/claim.js       crypto claim parsing; public checks use deterministic rules
lib/engine.js      shared claim-checking engine
lib/report-claims.js   validation and fallback extraction of up to three source-anchored claims
lib/report-markets.js  conservative discovery of related Gemini contracts
lib/evidence-report.js claim classification, market context, and optional crypto math
lib/http.js        bounded body handling and CORS
api/check.js       POST {text} → structured verdict
api/evidence-report.js POST extract/check → editable claims or Gemini market report
api/transcribe.js  POST raw audio/video ≤4,000,000 bytes → {text}
api/reel-transcript.js  POST {url} or {jobToken} → transcript or pending job
lib/reel-transcript.js  Supadata client, signed jobs, bounded instance-local deduplication
lib/live-owner-auth.js  private fifteen-minute owner sessions and mutation checks
lib/live-trade-engine.js  two-minute live reviews, fresh preflight checks and one-use submissions
lib/gemini-live-exchange.js  fixed-host public markets and signed production IOC buy orders
lib/live-order-store.js  durable Upstash order journal and lifetime $5 reservations
api/live-trade.js  owner-only account, market, preview, submission and result endpoints
public/           mobile web app, iPhone share intake and 1080×1350 canvas card
scripts/          local server, asset packaging and live verification
test/             node:test tests and deterministic Monte Carlo
fixtures/         real-shaped offline data, imported only by tests
```


The app uses native HTML, CSS and browser JavaScript modules. Its plain Node ESM server and Vercel functions use built-in APIs. No npm installation is needed; the market dashboard uses bundled ECharts 6.1.0, with locally served Geist font files and Lucide icons. Claude's structured output and source validation live in `lib/report-ai.js`; the deterministic report conclusion is separate in `lib/report-conclusion.js`. Gemini public market data and private signed trading requests use REST.

The public report flow uses bounded in-memory caches. Only the owner-only trading journal needs a database: `lib/live-order-store.js` runs atomic Lua operations through the Upstash Redis REST API to consume a review, reserve its fee-inclusive amount, and record submission state. See [live demo details](live-demo.md) for the durable account budget, private sessions, and one-attempt order flow.

## HTTP API and data handling


Reel reports select up to three editable claims and check each against public Gemini Exchange data. Optional Claude interpretation uses the server-only Anthropic key to select claims and explain the supplied results; it does not search external sources. See [Gemini report behavior, safeguards, and limitations](evidence-reports.md).

`POST /api/evidence-report?action=extract`, JSON `{ "text": "Reel transcript..." }`, returns claim drafts. `POST /api/evidence-report?action=check`, JSON `{ "claim": { "id": "claim-1", "text": "Claim to check", "quote": "Original words", "type": "fact" } }`, returns `{claim, assessment, market, model, evidence, explanation, checkedAt}`. Claim types are `fact`, `forecast`, and `recommendation`. The app automatically calls the check endpoint after extracting claims from a Reel or recording transcript. For pasted text, **Check with Gemini** extracts and checks in one action; sample buttons also run the full flow. Editing the input or a claim stops active checks and allows an explicit recheck. There are no external source-verification cards, and automatic checking never places orders.

`POST /api/check`, JSON `{ "text": "Bitcoin to 150K by end of month, guaranteed" }`.

`POST /api/transcribe`, raw audio/video bytes with an appropriate audio/video `Content-Type`. Maximum 4 MB. It is intentionally **not** a multipart client upload; the server creates the ElevenLabs multipart request. Both endpoints support CORS and reject unsupported methods and oversized inputs.

`POST /api/reel-transcript`, JSON `{ "url": "https://www.instagram.com/reel/SHORTCODE/" }`. It returns a completed transcript (200) or a signed `jobToken` (202). Poll with `{ "jobToken": "..." }` after `retryAfterMs`. Only start requests create provider work; polling never starts a new transcription. Errors never become a verdict.

Claims, audio, and cards are not written to a database. Report requests use a bounded process-local cache for five minutes, with limits of 12 fresh requests per client per minute and eight concurrent requests; these limits are not shared across serverless instances. Reel requests/transcripts are reused in memory for ten minutes to avoid duplicate paid requests, and signed job tokens expire after fifteen minutes. Supadata receives public Reel links and processes their content. If used separately, ElevenLabs receives uploaded recordings. When Claude is enabled, Anthropic receives transcript text for claim selection and claim text with retrieved Gemini market data and supported model output for interpretation. No external web-research service is used. Provider processing policies still apply. Downloading a card does not publish it; sharing uses the device’s share sheet.


For account and order routes, see [sandbox setup](gemini-sandbox.md) and [owner-only live API](live-demo.md#api-and-verification-scope). Public report generation never submits an order.

## Engine interfaces


```js
import { checkClaim } from './lib/engine.js';
import { extractClaim } from './lib/claim.js';
import { createGeminiClient, listEvents, spotPrice, dailyCloses, contractProb, eventUrl } from './lib/gemini.js';

const result = await checkClaim('Bitcoin to 150K by end of month, guaranteed');
const claim = await extractClaim('ETH under 2000 tomorrow', new Date());
// Tests may inject fetch and a fixed date into the entire engine:
// await checkClaim(text, { fetch: mockedFetch, now: fixedDate });
// Or create a separate cached client:
// const client = createGeminiClient({ fetch: mockedFetch, now: () => +fixedDate });
```

`listEvents({category, search, status})` returns an event array; `spotPrice(asset)` returns a number; `dailyCloses(asset)` returns an oldest-first array of completed daily closes; `contractProb(contract)` returns a quote object or null; `eventUrl(event)` returns the Gemini link or null. Client instances expose the same methods. `extractClaim` returns `targets: number[]`; compatibility aliases remain for the pre-existing UI. The engine takes `Date`, ISO string, or millisecond `now`.

Live CLI (no keys needed):

```sh
node scripts/try.js "Bitcoin to 150K by end of month, guaranteed"
node scripts/try.js "ETH is about to dump under 2,000 this week"
```


## Saved analyses and market overview

`public/analysis-history.js` integrates the existing report and single-crypto results with `public/workspace-data.js`. Up to 30 completed snapshots are retained in browser `sessionStorage` under `pocket-quant-workspace-v1`. The per-claim adapter in `public/report-workspace.js` retains the original report and exposes its selected market context to the dashboard. It does not broaden a report's subject match.

Opening `/?analysis=<id>` restores a timestamped snapshot without requesting new analysis or transcription. Restoring cancels active work; late results cannot replace or save over it. Saved Reel sources are revalidated and saved Gemini links are restricted to official prediction pages before rendering. Malformed snapshots fail with a manual recheck path. An explicit recheck obtains new evidence. `/markets.html?check=<id>` selects the matching saved analysis in the market overview.

The overview provides history removal/clearing and separately labeled public market discovery. Browser session restore can retain `sessionStorage`; closing a tab does not guarantee deletion. Storage failure keeps results on the current page and disables the cross-page dashboard link. The color-theme preference alone uses `localStorage` (`pq-theme`). See the [market workspace guide](market-workspace.md) for dashboard behavior and limitations.

## iPhone handoff and card output

The downloadable shortcut is at `public/Check with Pocket Quant.shortcut`. It was created in Apple Shortcuts and exported for Anyone. It uses URL Encode → Text → Open URLs and opens `https://pocket-quant-ashen.vercel.app/#shared=<encoded input>`. A domain change requires updating and re-exporting the shortcut. Actual iPhone import, Instagram Share Sheet placement, and native file sharing need device verification.

The app validates the incoming Instagram permalink with an exact hostname/path allowlist, removes tracking parameters, and clears the incoming fragment. The server calls only Supadata's fixed API host for Reel transcription; it does not fetch arbitrary supplied URLs. No Instagram password or login cookie is requested. There is no persisted Reel inbox.

The single-crypto checker renders a 1080×1350 PNG using Canvas. It supports PNG download and native file sharing when the browser supports the Web Share API. Exporting the full three-claim report is not implemented. See [Reel transcription](reel-transcription.md) for asynchronous jobs, request limits, and provider failure handling.

## Development and deployment

Node 22+ is required; Node 24 is recommended and used in GitHub Actions. `npm run build` checks required static assets; it is not a framework compilation step. `npm test` uses the built-in `node:test` runner and offline fixtures, including deterministic Monte Carlo checks. `npm run verify:live` contacts Gemini and writes timestamped results under the ignored `output/` directory.

Vercel serves `public/` and the `api/` functions; durations and response headers are configured in `vercel.json`. Keep secrets in ignored local `.env` files or Vercel environment settings. The app does not override Vercel account access protections. Public report and transcription limits are per instance, not durable per-user quotas. Retain the same persistent Upstash database across deployments so the lifetime trading budget is not reset.

The R2 connection is methodological: sensitivity across regimes and refusing to claim an edge smaller than the noise. No R2 code or track record establishes predictive accuracy for Pocket Quant.

## Provider references

- [Gemini Prediction Markets API](https://developer.gemini.com/prediction-markets-spec)
- [Gemini market data](https://developer.gemini.com/trading/rest-api/market-data)
- [Apple Share Sheet shortcuts](https://support.apple.com/guide/shortcuts/receive-onscreen-items-apd350ce757a/ios)
- [ElevenLabs transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- [Supadata Reel transcription](https://docs.supadata.ai/get-transcript)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js)
