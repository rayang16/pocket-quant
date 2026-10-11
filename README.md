# Pocket Quant

**A little less hype.** Check a crypto prediction from an Instagram Reel against live Gemini Prediction Markets and volatility math. Download the evidence as a portrait card or open the matched market on Gemini.

Plain Node ESM, native browser modules, no application dependencies, no database. No canned odds or simulated market data in the app. Test fixtures live only in `fixtures/` and are imported only by tests.

## Run

Requires Node 22+ (Node 24 recommended; uses built-in fetch, FormData, Blob and environment-file loading).

```sh
npm run build
npm run dev
```

Open http://localhost:3000. The BTC/ETH/SOL/XRP/ZEC checker needs **no API keys**. `npm test` runs offline; `npm run verify:live` calls actual Gemini endpoints and writes timestamped checks under the ignored `output/` folder.

Optional: copy `.env.example` to `.env`. `ANTHROPIC_API_KEY` enables Claude extraction with field validation and regex fallback. `CLAUDE_MODEL` defaults to the brief's `claude-haiku-5-5`; set it to a model available on your Anthropic account. An unavailable model automatically falls back. `ELEVENLABS_API_KEY` enables `scribe_v1` audio/video transcription; without it the upload endpoint returns an actionable 501. Keys never enter client code.

## Chrome side panel

1. Run `npm run build` to sync the shared renderer, styles and card code into `extension/` and create `public/pocket-quant-extension.zip`.
2. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked → extension/**.
3. Open an Instagram Reel in Chrome 116+, then click the extension icon. That user gesture grants access to the active tab.
4. Choose **Check this Reel**, or turn on **Auto**. The paste box always works.
5. In **Connection & privacy**, configure the API origin. Local builds default to `http://localhost:3000`; Vercel builds embed the deployment origin. Set `PUBLIC_API_BASE` to a stable production URL when packaging a release.
6. **Listen 12s** captures tab audio, restores playback through an AudioContext, stops capture, sends the clip to ElevenLabs, and checks the transcript. This optional flow requires a key and real Chrome tab-capture permissions.

The content script reads only rendered text near the most visible video, with an 800 ms debounce and URL-change detection. Instagram markup changes can break caption extraction; paste is the reliable fallback. No server-side Instagram scraping. DM sharing is roadmap only, pending Meta app review. Extension permissions cover Vercel and localhost by default; a custom HTTPS origin prompts for that origin only.

## Deploy

```sh
npm test
npx vercel --prod
```

Vercel serves `public/` and `api/` functions. `vercel.json` sets the build/output directory and a 60-second function limit. Configure optional secrets in Vercel, not public files. After deployment, test BTC, ETH, a no-market claim, and the extension ZIP from the actual URL. This project does not override Vercel account access protections. The paid optional providers have no durable quota system in this hackathon build; apply provider budgets before broad public use.

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

Regex handles BTC/ETH/SOL/XRP/ZEC aliases, k/m amounts, commas, percentage moves, caption noise, and relative/calendar deadlines. A target must be between 0.2× and 10× live spot. Multiple plausible targets require clarification. Calendar context is America/Los_Angeles; deadlines resolve to **21:00 UTC**, as requested for the demo. This equals 5 PM Eastern only during daylight saving time. No date means +30 days, visibly labeled. “This week” ends Sunday. Past deadlines are rejected.

Speaker confidence is inferred from words, not a scientific measurement. Negation and hedging take priority over confidence words. Non-crypto searches show **possible matches**, actual quoted contract odds and links; they do not pretend that keyword matching confirms resolution criteria. There is no weather/sports probability model or settled-market calibration layer in this build.

### Market data and failures

Public Gemini API: active events (paginated), spot ticker, daily candles. In-memory caches: events 30 seconds, spot 15 seconds, candles 10 minutes. Concurrent calls share in-flight requests. Retrieval timestamps are displayed; the API does not establish last-trade freshness. Missing price fields are not zero. Crossed books disable spread-based judgments. No market means no hype verdict. Network/API failure produces an explicit error, never demo data.

## Architecture

```
lib/math.js        pure probability, volatility, confidence and comparison functions
lib/gemini.js      cached public Gemini client and quote normalization
lib/claim.js       strict optional Claude extraction + regex fallback
lib/engine.js      shared claim-checking engine
lib/http.js        bounded body handling and CORS
api/check.js       POST {text} → structured verdict
api/transcribe.js  POST raw audio/video ≤4,000,000 bytes → {text}
public/           responsive web app, shared UI and 1080×1350 canvas card
extension/        MV3 caption reader, Auto side panel and optional audio capture
scripts/          local server, asset packaging and live verification
test/             node:test tests and deterministic Monte Carlo
fixtures/         real-shaped offline data, imported only by tests
```

## API

`POST /api/check`, JSON `{ "text": "Bitcoin to 150K by end of month, guaranteed" }`.

`POST /api/transcribe`, raw audio/video bytes with an appropriate audio/video `Content-Type`. Maximum 4 MB. It is intentionally **not** a multipart client upload; the server creates the ElevenLabs multipart request. Both endpoints support CORS and reject unsupported methods and oversized inputs.

No claims, audio, or cards are stored by the app. Provider processing policies still apply. Optional Claude receives the claim; ElevenLabs receives uploaded/captured media. Auto mode is opt-in. Downloading a card does not publish it.

## Pitch and demo

“Most people use prediction markets like a sportsbook. Pocket Quant treats them like a financial market: check a confident claim against live Gemini odds and volatility math, and only flag a market gap when it exceeds the spread and the model range.”

The current focus is Step 1: the engine. See `CONTEXT.md` for the verbatim brief and `docs/step-1-verification.md` for what was tested. The R2 connection is methodological: sensitivity across regimes and refusing to claim an edge smaller than the noise. No R2 code or track record is used to claim predictive accuracy for this app.

## Official references

- [Gemini market data](https://developer.gemini.com/trading/rest-api/market-data)
- [Chrome tab capture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
- [ElevenLabs transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
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
