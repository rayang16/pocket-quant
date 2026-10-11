# Gem Finder

**A little less hype.** Turn a financial Instagram Reel into checkable claims, live Gemini Exchange market context, and transparent crypto probability estimates.

**[Open the app](https://pocket-quant-ashen.vercel.app/)** · **[Market overview](https://pocket-quant-ashen.vercel.app/markets.html)** · **[Send a Reel from iPhone](https://pocket-quant-ashen.vercel.app/share.html)** · **[Owner trading demo](https://pocket-quant-ashen.vercel.app/live.html)**

Built for the **Blockchain at Berkeley hackathon — Gemini Exchange Prediction Markets API track**. The current product is a mobile web app with an iPhone Share Sheet shortcut. The trading demo requires the owner's private access code.

## From the feed to a better question

A creator says, “Bitcoin will reach $150,000 by October 31, 2026.” Before accepting the certainty, a viewer needs to know what is being predicted, what a relevant market actually prices, and how sensitive a model is to its assumptions.

Gem Finder connects those steps:

1. **Bring the claim.** Share an accessible public Reel through the iPhone shortcut, paste its link or text, or upload a recording when transcription is configured.
2. **Keep the source visible.** Supadata transcribes public Reels. The app selects up to three editable claims, preserves their source quotes, and distinguishes facts, forecasts, and recommendations. Optional Claude selection has a text-rule fallback.
3. **See what Gemini can tell you.** Each claim gets a conclusion, related Gemini contracts, and any supported crypto calculation. Checks start automatically after transcription. Pasted text needs one **Check with Gemini** action.
4. **Inspect, share, or prepare a trade.** Open the actual Gemini contract and its conditions. The separate single-crypto checker exports a PNG card. **Prepare YES/NO trade** carries the contract and chosen side to the owner-only order screen. After unlocking, it fills in Gemini's current asking price and whole-contract quantity within an editable $1 demo preset, balance, remaining demo budget, and fee allowance. Submitting always requires a separate review and manual confirmation.
5. **Revisit the analysis.** The session history retains up to 30 completed checks. Open a saved snapshot without rerunning it, explicitly recheck for fresh evidence, or inspect its related contracts in the [market overview](https://pocket-quant-ashen.vercel.app/markets.html). The dashboard also supports browsing current Gemini markets.

A useful answer can also be **“No matching market”** or **“Market prices cannot verify this historical claim.”** A related contract is not automatically the probability of the Reel's exact statement. Provider failures produce an explicit unavailable state, never invented odds.

## Why build this for Gemini?

In our team's hackathon conversations with Gemini representatives, two themes stood out: people may not know Gemini offers prediction markets, and they may see the product only as betting. These are team-reported observations recorded in the original [CONTEXT.md](CONTEXT.md), not measured company-wide findings or an endorsement of Gem Finder.

Gemini itself describes prediction markets as a way to aggregate information and help people prepare for future events. Its product explains contract prices as market probability estimates and emphasizes reviewing settlement rules. Gem Finder brings that information into a familiar moment: checking a claim from the feed. [Gemini's launch announcement](https://www.gemini.com/blog/gemini-predictions-tm-is-now-live) · [Gemini Predictions product guide](https://www.gemini.com/lp/predictions)

| Gem Finder feature | Intended benefit for Gemini | What we would measure |
| --- | --- | --- |
| Relevant contracts appear beside claims people already care about | **Awareness and discovery:** introduce Gemini Predictions through a concrete use case | First-time product discovery and contract-page visits |
| Reel sharing, pasted text, and single-crypto PNG cards | **Acquisition:** give new audiences a route from social content to Gemini markets | Consenting testers who complete a report and follow a market link |
| Source quotes, plain-language explanations, visible mismatches, and model assumptions | **Understanding and trust:** show how market information can inform a question | Comprehension checks and feedback about what users learned |
| Separate, explicitly reviewed owner trading demo | **Optional trading:** demonstrate the API path from discovery to an intentional order | Successful reviews and, if submitted, confirmed fills |

These are **product hypotheses**. We have not measured acquisition lift, improved trust, repeat engagement, or incremental trading volume. The next validation is a small tester cohort: observe completion, time to result, failures, market-link visits, and whether people return. No user count, conversion rate, or social proof is claimed here.

## What is running, and what is verified?

Verification snapshot: **October 11, 2026**. The automated baseline is **419 passing tests** plus the static-asset build. Offline tests use fixtures and mocked providers; they are separate from live checks.

| Area | Current scope |
| --- | --- |
| Public app and Gemini checks | Deployed web app; public Gemini data and browser flows have been checked. Data availability still depends on Gemini and the selected contract. |
| Public Reel reports | Supadata transcription and optional Claude integration are implemented. Accessible media, provider configuration, and clear transcript wording determine whether a Reel completes. |
| Owner production account and review | Private account reads and an order preview have been verified. **No real Gemini order has been placed.** A successful preview does not establish execution. |
| Durable trading storage | Upstash journal and budget behavior tested with synthetic records, including duplicate attempts, uncertain outcomes, and over-budget rejection. |
| iPhone sharing | Signed shortcut and mobile browser layout available. Actual iPhone import, Instagram Share Sheet handoff, and native file sharing remain unverified on hardware. |
| Recording transcription | Optional ElevenLabs integration implemented and tested with mocks; requires `ELEVENLABS_API_KEY`. Real-recording transcription remains unverified. |
| Sandbox account flow | Separate at [`/trade.html`](https://pocket-quant-ashen.vercel.app/trade.html). Gemini OAuth approval is pending; account connection and test orders are not verified end to end. |

The source includes order submission, but its real-money use is limited to the configured owner account. This is not a multi-user OAuth trading product. See [current product direction](docs/product-direction.md) and [verification notes](docs/mobile-verification.md) for detail.

## Run locally — no keys needed

Use **Node 22+**; **Node 24 is recommended** and used in CI. No `npm install` step is required; the browser chart library and font/icon assets are bundled.

```sh
git clone https://github.com/rayang16/pocket-quant.git
cd pocket-quant
npm run build
npm run dev
```

Open [localhost:3000](http://localhost:3000). Paste a financial claim to try the Gemini report, or use **Check one crypto prediction instead** for the quantitative checker and PNG card. Both work without API keys, using public Gemini data and deterministic fallback text. Internet access is needed for market data.

```sh
npm test              # offline node:test suite
npm run verify:live   # calls Gemini; writes timestamped checks to ignored output/
```

For optional features, copy [`.env.example`](.env.example) to `.env`. Keep all credentials on the server.

| Feature | Server configuration | Without it |
| --- | --- | --- |
| Public Gemini reports and crypto math | None | Available with live public data |
| Public Reel transcription | `SUPADATA_API_KEY` | Paste the transcript or claim |
| Claude claim selection and explanations | `ANTHROPIC_API_KEY`; optional `CLAUDE_MODEL` (default `claude-sonnet-5-5`) | Text rules and deterministic conclusions |
| Recording transcription | `ELEVENLABS_API_KEY` | Paste text or use a configured public Reel flow |
| Owner account and real-money review | Gemini personal master key, owner-session settings, explicit live opt-in, and Upstash credentials | Live review/submission stays disabled; follow the [live setup guide](docs/live-demo.md) |
| Sandbox account connection | Separate Gemini sandbox OAuth app and session settings | Follow the [sandbox setup guide](docs/gemini-sandbox.md) after app approval |

Supadata, Anthropic, and ElevenLabs usage can incur provider charges. The public-data demo needs none of those services.

## The stack and each piece's job

| Technology | Role in Gem Finder |
| --- | --- |
| **Node ESM, native HTML/CSS/JavaScript** | Shared calculation engine, browser modules, and HTTP handlers; no application framework |
| **Vercel** | Static `public/` files and `api/` server functions |
| **Gemini Exchange REST APIs** | Public prediction events, contract quotes, spot prices, daily candles; private signed account reads and owner order submission |
| **Anthropic Claude structured outputs** | Optional source-quoted claim selection and explanations of supplied results; validated on the server with fallback behavior |
| **Supadata** | Transcribes accessible public Instagram Reels, including asynchronous provider jobs |
| **ElevenLabs** | Optional audio/video recording transcription, up to 4 MB |
| **Apple Shortcuts** | Sends a shared Instagram permalink to the web app; no extension installation |
| **ECharts 6.1.0, Geist, and Lucide** | Bundled market charts, a locally served font (SIL Open Font License), and icons (ISC license); no application framework |
| **Browser storage** | Up to 30 saved analyses in `sessionStorage`; the `pq-theme` preference in `localStorage` |
| **Canvas and Web Share API** | Render a 1080×1350 single-crypto PNG and share it where the browser supports file sharing |
| **Upstash Redis REST + atomic Lua** | Persist owner order reviews, consume each review once, and enforce the account's lifetime $5 reservation budget |
| **`node:test` and GitHub Actions** | Offline tests for math, parsing, provider failures, APIs, and trading safeguards; test/build checks on pushes and pull requests |

**Gemini means Gemini Exchange, not Google Gemini.** Claude selects and explains; it is not a web fact-checker and does not supply the market odds. Its prompts receive only the transcript and/or retrieved evidence, with no web-search tools. Gemini's documented API separates public market discovery from authenticated order management. [Gemini Prediction Markets API](https://developer.gemini.com/prediction-markets-spec)

## The quantitative part

Gemini event contracts settle at $1 for the winning outcome and $0 otherwise; their traded prices provide an indicative market probability. [Gemini event-contract guide](https://support.gemini.com/hc/en-us/articles/44234371543579-Gemini-Predictions)

For **BTC, ETH, SOL, XRP, and ZEC** price targets, Gem Finder calculates probabilities separately from the contract quote. **Both the model's price history and the market quotes come from Gemini**: this is an independent calculation, not an independent data source.

- **Three volatility windows:** annualized realized volatility from 14, 30, and 90 days of daily log returns. The engine requires 91 contiguous completed daily closes and excludes the open candle. The resulting range shows sensitivity to the windows, not a confidence interval.
- **Touch versus expiry:** a binary-option calculation estimates finishing beyond a target at the deadline; a reflection-principle calculation estimates touching it at any time beforehand. “Hits $150K” and “closes above $150K” are different questions.
- **Honest contract matching:** market/model comparisons use the listed contract's own strike and expiry. A nearby quote is labeled as nearby. Estimates at an unlisted target are model extrapolations, not Gemini prices.
- **Two possible implied volatilities:** a binary price can imply two volatility roots. The solver preserves both within its 5%–400% search range rather than silently choosing one.
- **Spread-aware comparisons:** rich/cheap labels require a usable two-sided quote and a difference beyond the model range greater than `max(halfSpread, 1¢)`. Language-based “hype” labels use a disclosed heuristic, not a measured speaker belief.

Reel-report math requires a supported price target and a recognized explicit calendar deadline with a year. Ambiguous dates need review. The separate single-crypto checker accepts more date formats and shows its date assumptions. Historical facts are not market-verifiable; recommendations remain opinions.

The model assumes zero price drift and lognormal returns, omits jump risk, and can understate crypto tail risk. Gemini spot may differ from a contract's settlement index. Market prices, model ranges, and hype labels do not establish predictive accuracy, profitability, or trade suitability. [Formulas, assumptions, parsing, and engine interfaces](docs/technical-reference.md#probability-model)

## Owner-only trading: deliberate and bounded

Reports never trade automatically. The owner opens a private fifteen-minute session, chooses an eligible financial contract, reviews a YES or NO limit buy, and explicitly confirms it. Reviews expire within two minutes. Submission rechecks the account, available USD, Trader role, accepted terms, contract details, and trading increments.

The order form auto-fills from the selected contract's current ask, with an editable **$1 demo amount including fees**. This is mechanical sizing for a small demo, not a personalized investment recommendation. Model probabilities and HYPE labels never set a trade price or select the opposite outcome. Changing the outcome or auto-fill amount recalculates the ticket; quantity and price remain editable. Drafting creates no order, reservation, or confirmation token. Missing quotes, unsupported increments, or insufficient funds leave the ticket unfilled.

Orders use whole-contract quantities and immediate-or-cancel execution; partial fills can be fractional. Before the sole exchange submission attempt, atomic Upstash operations consume the review and reserve **principal plus a conservative fee allowance against a $5 lifetime account budget**. The allowance depends on the verified fill step. This is a demo reservation limit, not a per-session allowance or a quote of actual fees.

Reservations are never automatically refunded, including rejected or unfilled orders. Unknown outcomes block further submissions; the owner checks directly in Gemini. Placement is never retried automatically. Preserve the same Upstash database across redeployments. The app's limit does not govern trades placed outside Gem Finder. [Full setup, fee allowance, journal behavior, and limitations](docs/live-demo.md)

## Data handling and failure behavior

Public links go to Supadata for transcription. If enabled, Anthropic receives the transcript for selection and claims with Gemini evidence for explanation; ElevenLabs receives uploaded recordings. Provider processing policies apply. The app does not request Instagram passwords or cookies and validates permalink hosts and paths before calling the fixed transcription provider.

Server-side reports and transcripts are cached briefly in memory, not stored in a database. The browser keeps up to 30 completed analysis snapshots, claim text, and source links in `sessionStorage`; clear them through the market overview. Browser session restore can retain that storage, so closing a tab is not a guaranteed deletion method. The theme preference uses `localStorage` under `pq-theme`. Upstash persists only the separate owner trading journal and budget. Request limits are bounded per instance, not durable per-user quotas. Missing quotes stay missing; a provider error never becomes a fabricated market result. [Report API and data handling](docs/evidence-reports.md) · [Reel transcription details](docs/reel-transcription.md)

## Deploy and contribute

```sh
npm test
npm run build
npx vercel --prod
```

Vercel configuration lives in [`vercel.json`](vercel.json). Set optional secrets in Vercel environment settings. Live trading needs explicit opt-in and its full private configuration; preserve persistent budget storage across deployments. After publishing, check a useful market match, an unmatched claim, a historical statement, and the sharing guide from the actual deployment. Test iPhone behavior on an iPhone.

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [market workspace guide](docs/market-workspace.md), then use the [technical reference](docs/technical-reference.md) for module layout, HTTP APIs, math, and engine interfaces. The [current product direction](docs/product-direction.md) supersedes the original browser-extension plan; [CONTEXT.md](CONTEXT.md) remains the original brief verbatim.

Existing repository and deployment URLs and internal storage keys retain the original project slug so links, browser sessions, and trading-budget records continue to work.
