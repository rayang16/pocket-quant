# Pocket Quant

**A little less hype.** Turn an Instagram Reel into up to three reviewed claims, discover related Gemini Exchange Prediction Markets, and apply volatility math to supported crypto forecasts. Market prices provide context; they do not fact-check historical statements or make a trade suitable.

Plain Node ESM, native browser modules, no application dependencies, no database. No canned odds or simulated market data in the app. Test fixtures live only in `fixtures/` and are imported only by tests.

## Run

Requires Node 22+ (Node 24 recommended; uses built-in fetch, FormData, Blob and environment-file loading).

```sh
npm run build
npm run dev
```

Open http://localhost:3000. Claim extraction, the Gemini market report, and the BTC/ETH/SOL/XRP/ZEC checker need **no API keys**. `npm test` runs offline; `npm run verify:live` calls actual Gemini endpoints and writes timestamped checks under the ignored `output/` folder.

Optional: copy `.env.example` to `.env`. `SUPADATA_API_KEY` enables automatic transcription of public Reel links. The separate recording-upload feature uses `ELEVENLABS_API_KEY`; without it the upload endpoint returns an actionable 501. Keys never enter client code. Reports use deterministic claim extraction and public Gemini Exchange data, with no Claude, Google Gemini, or external web-research service.

## Connect Gemini and try a test order

Open `/trade.html` for the sandbox-only account connection, market selection, order review, and explicit test-order confirmation. This is separate from the public-data report. Server credentials are configured for the deployed app, but Gemini OAuth app approval is still pending; account connection and test orders have not completed end to end. Live-money trading is disabled in code. See [Gemini sandbox setup](docs/gemini-sandbox.md) for callback URLs, permissions, and limitations. No account state or receipts are fabricated.

## Send a Reel from iPhone

Pocket Quant is a mobile-friendly web app. There is no browser extension in the current product.

1. Open `/share.html` in Safari on your iPhone and download **Check with Pocket Quant**.
2. Open the downloaded `.shortcut` file in Apple Shortcuts and choose **Add Shortcut**.
3. In Instagram, choose **Share → More / Share to… → Check with Pocket Quant**.
4. The shortcut opens `https://pocket-quant-ashen.vercel.app/#shared=<encoded input>`. The app validates the Instagram permalink, removes tracking parameters, and clears the incoming fragment from the address bar.
5. When Supadata is configured, the app sends the public link to Supadata for transcription and selects up to three draft claims using text rules. Review the transcript, wording, and claim types, then choose **Check with Gemini**. Market checks start only after this review. Private, restricted, missing, or silent videos may fail; paste the claim or upload a recording as a fallback.

The exported shortcut was created in Apple Shortcuts and exported for Anyone (Apple validates a copy). It uses URL Encode → Text → Open URLs and points to the production domain above. If the production domain changes, update and re-export it. Actual Instagram Share Sheet placement and import must be checked on an iPhone; macOS/browser checks do not prove device behavior.

Link intake uses an exact Instagram hostname/path allowlist. Our server calls only Supadata's fixed API host; it does not fetch arbitrary user URLs. Supadata handles public media access. No Instagram password or login cookie is requested. There is no persisted Reel inbox. See [Reel transcription setup](docs/reel-transcription.md) for provider setup, async jobs, fallback behavior, and limits. The app supports PNG download and the native file-sharing sheet when the browser supports it. An Instagram DM bot remains a future integration.

## Deploy

```sh
npm test
npx vercel --prod
```

Vercel serves `public/` and `api/` functions. Function duration limits are set in `vercel.json`. Configure optional transcription and sandbox secrets in Vercel, not public files. After deployment, test the three-claim flow, BTC, ETH, a no-market claim, and the iPhone shortcut download from the actual URL. This project does not override Vercel account access protections. Report requests do not incur an AI-provider charge; paid transcription has no durable quota system in this hackathon build.

## The math, in plain English

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

The Reel report selects up to three distinct claims with deterministic text rules and keeps their original transcript wording. Users can edit and classify each as a fact, forecast, or recommendation. Historical facts receive `not_market_verifiable`; recommendations remain opinions; forecasts remain uncertain. Related Gemini contracts never become a supported/contradicted verdict on a factual claim. The report applies crypto probability math only when the claim has a supported target and an explicit calendar deadline with a year. Relative dates in undated Reels need review.

The separate single-crypto checker handles BTC/ETH/SOL/XRP/ZEC aliases, k/m amounts, commas, percentage moves, caption noise, and relative/calendar deadlines. A target must be between 0.2× and 10× live spot. Multiple plausible targets require clarification. Calendar context is America/Los_Angeles; deadlines resolve to **21:00 UTC**, as requested for the demo. This equals 5 PM Eastern only during daylight saving time. No date means +30 days, visibly labeled. “This week” ends Sunday. Past deadlines are rejected.

Speaker confidence is inferred from words, not a scientific measurement. Negation and hedging take priority over confidence words. Non-crypto searches show **possible matches**, actual quoted contract odds and links; they do not pretend that keyword matching confirms resolution criteria. There is no weather/sports probability model or settled-market calibration layer in this build.

### Market data and failures

Public Gemini API: active events (paginated), spot ticker, daily candles. In-memory caches: events 30 seconds, spot 15 seconds, candles 10 minutes. Concurrent calls share in-flight requests. Retrieval timestamps are displayed; the API does not establish last-trade freshness. Missing price fields are not zero. Crossed books disable spread-based judgments. No market means no hype verdict. Network/API failure produces an explicit error, never demo data.

## Architecture

```
lib/math.js        pure probability, volatility, confidence and comparison functions
lib/gemini.js      cached public Gemini client and quote normalization
lib/claim.js       crypto claim parsing; public checks use deterministic rules
lib/engine.js      shared claim-checking engine
lib/report-claims.js   deterministic extraction of up to three transcript-anchored claims
lib/report-markets.js  conservative discovery of related Gemini contracts
lib/evidence-report.js claim classification, market context, and optional crypto math
lib/http.js        bounded body handling and CORS
api/check.js       POST {text} → structured verdict
api/evidence-report.js POST extract/check → reviewed claims or Gemini market report
api/transcribe.js  POST raw audio/video ≤4,000,000 bytes → {text}
api/reel-transcript.js  POST {url} or {jobToken} → transcript or pending job
lib/reel-transcript.js  Supadata client, signed jobs, bounded instance-local deduplication
public/           mobile web app, iPhone share intake and 1080×1350 canvas card
scripts/          local server, asset packaging and live verification
test/             node:test tests and deterministic Monte Carlo
fixtures/         real-shaped offline data, imported only by tests
```

## API

Reel reports select up to three editable claims and check each against public Gemini Exchange data. No AI research key or external fact-checking service is used. See [Gemini report behavior, safeguards, and limitations](docs/evidence-reports.md).

`POST /api/evidence-report?action=extract`, JSON `{ "text": "Reel transcript..." }`, returns claim drafts. `POST /api/evidence-report?action=check`, JSON `{ "claim": { "id": "claim-1", "text": "Claim to check", "quote": "Original words", "type": "fact" } }`, returns `{claim, assessment, market, model, checkedAt}`. Claim types are `fact`, `forecast`, and `recommendation`. Public-market lookup starts when the user chooses **Check with Gemini**; there are no external source-verification cards.

`POST /api/check`, JSON `{ "text": "Bitcoin to 150K by end of month, guaranteed" }`.

`POST /api/transcribe`, raw audio/video bytes with an appropriate audio/video `Content-Type`. Maximum 4 MB. It is intentionally **not** a multipart client upload; the server creates the ElevenLabs multipart request. Both endpoints support CORS and reject unsupported methods and oversized inputs.

`POST /api/reel-transcript`, JSON `{ "url": "https://www.instagram.com/reel/SHORTCODE/" }`. It returns a completed transcript (200) or a signed `jobToken` (202). Poll with `{ "jobToken": "..." }` after `retryAfterMs`. Only start requests create provider work; polling never starts a new transcription. Errors never become a verdict.

Claims, audio, and cards are not written to a database. Report requests use a bounded process-local cache for five minutes, with limits of 12 fresh requests per client per minute and eight concurrent requests; these limits are not shared across serverless instances. Reel requests/transcripts are reused in memory for ten minutes to avoid duplicate paid requests, and signed job tokens expire after fifteen minutes. Supadata receives public Reel links and processes their content; it is the only paid provider in the Reel-to-Gemini report flow. If used separately, ElevenLabs receives uploaded recordings. No report text is sent to Claude or an external web-research service. Provider processing policies still apply. Downloading a card does not publish it; sharing uses the device’s share sheet.

## Pitch and demo

“Share a financial Reel to Pocket Quant, review its claims, and see what related Gemini Prediction Markets are pricing. For supported crypto forecasts, compare those prices with a transparent volatility model. Open the market’s exact terms before deciding what the prediction means.”

See [the current product direction](docs/product-direction.md) for the intended Reel-to-result experience and Gemini track positioning. Shared public Reels can be transcribed through Supadata when configured, followed by an editable review step. Actual provider and iPhone checks must be reported separately from offline tests. Market odds and model estimates assess predictions, not whether a trade is suitable for a particular user.

The current product includes the engine, mobile web experience, verdict cards, optional transcription, and iPhone Share Sheet shortcut. `CONTEXT.md` preserves the original brief verbatim; the current product direction supersedes its browser-extension requirements. See `docs/step-1-verification.md` for the earlier engine checks. The R2 connection is methodological: sensitivity across regimes and refusing to claim an edge smaller than the noise. No R2 code or track record is used to claim predictive accuracy for this app.

## Official references

- [Gemini market data](https://developer.gemini.com/trading/rest-api/market-data)
- [Apple Share Sheet shortcuts](https://support.apple.com/guide/shortcuts/receive-onscreen-items-apd350ce757a/ios)
- [ElevenLabs transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- [Supadata Reel transcription](https://docs.supadata.ai/get-transcript)
- [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js)

## Step 1 engine interfaces

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
