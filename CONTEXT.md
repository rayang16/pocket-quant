

## Who I am
- Rayan ("King"), freshman in Haas at UC Berkeley, building with my co-founder Elijah (his first hackathon). Teams are 2–4 people.
- I've shipped real software: an outreach automation pipeline (Supabase + Instantly + Inngest + Vercel) sold to a Berkeley consulting club, restaurant websites and ordering systems (Next.js/Vercel, Supabase), an AI text humanizer, and a free SAT prep app rolling out across my school district.
- **Most relevant: R2 Quant**, my backtesting "AI quant." It tested 136,916 strategy variants through an 8-stage gauntlet (in-sample → sensitivity → out-of-sample → walk-forward → Monte Carlo → deflated Sharpe → plateau → regime). 111 survived. A noise check on shuffled data let 0 fake strategies through. Philosophy: **only trust what survives data it has never seen; never claim an edge you can't tell apart from luck.** I'm also learning options (implied vol, Greeks).
- The project must be built TODAY. We reuse R2's methodology in the pitch, not its code.
- Preferences: polished, direct, no filler. Stack: Vercel + Node.

## The hackathon (Blockchain at Berkeley, one-day sprint)
- **Hacking ends 5:15 PM PT.** Lunch 2:00. Final demos 7:15 (top 2 per general track). Winners 7:45.
- **Submit:** public GitHub repo, ~2-min demo video, deployment link. Must be new and must actually work: "Don't hard-code functionality. We'll be checking."
- **Judging:** technical impressiveness, creativity, functionality. Bonus: **social proof** (posting on X/LinkedIn, real users during the event).
- **Advice from organizers:** do one or two things really well. They want things that leave the hackathon and reach real users, not "AI slop."
- **Tracks:** one general track (Most Technically Impressive or Most Creative) plus any sponsor tracks: **Gemini Prediction API** (our target), AUSD/Agora, Ripple, a programmable-capital track. Bonus: **ElevenLabs**, Context.dev.
- **Our entry:** Gemini + Most Technically Impressive + ElevenLabs.
- **Judges:** a YC visiting partner (co-created x402) and Foundation Capital's accelerator director. They reward real users, a clear problem, and technical depth.

## What Gemini's rep (Grace) told us 1:1
- Gemini = the Winklevoss crypto exchange: 11 years old, public since last September, aiming to be a "Web3 financial markets super app." Prediction markets are the #1 focus (~35 engineers vs. 5 on their card). The platform is ~1 year old.
- **Edge: trust and regulation.** One of only 3 crypto platforms with a CFTC DCM license for US prediction markets. Positions against Polymarket/Kalshi gray areas and FTX-style recklessness.
- **Pain 1, awareness:** "People don't know that you have a prediction platform."
- **Pain 2, perception:** people see it as betting. They want it used "as a legitimate tool, not a trash tool," i.e. a financial instrument.
- **Tired of:** students "overthinking arbitrage bots" between Kalshi and Polymarket. They want creative use cases and feedback.
- **Biggest markets:** sports; **weather** (popular, not saturated); **crypto price markets incl. 15-min and hourly Bitcoin** (used for hedging); midterms.

## The product: Pocket Quant
A hype checker for Instagram Reels. Influencers say "Bitcoin hits $150K this month, guaranteed." Pocket Quant shows, right beside the video:
> **Claim:** BTC ≥ $150,000 by Oct 31 · *speaker sounds 97% sure*
> **Gemini market:** ≤2% · **Math:** 0.1–0.8% (touch any time: 0.3–1.5%)
> **Verdict: HYPE.** The market and the math both say long shot. → View on Gemini

Then you get a shareable verdict card (PNG).

**Pitch:** "Most people use prediction markets like a sportsbook. Pocket Quant treats them like a financial market: it prices any claim like a quant would, using live Gemini odds and real volatility math, and only calls something mispriced when the evidence beats the noise."

**Framing rules (enforce in all copy):**
- Checks whether claims and odds are *fair*. NOT a tipster, never "makes you money," NOT an arbitrage bot.
- Checks *predictions*, not past facts. Call it a hype/prediction checker, not a fake-news detector.
- No matching market → say so. Never invent a verdict. No hard-coded numbers anywhere.

**Front ends:**
1. Chrome extension side panel next to Instagram (main demo).
2. Web demo for paste or screen-recording upload (the deployment link).
3. Roadmap only: an Instagram DM bot (share a Reel to @pocketquant). Instagram's messaging webhooks deliver `ig_reel` attachments with caption/URL/video id, but it needs Meta app review. Never scrape Instagram server-side.

## Architecture
```
pocket-quant/
  CONTEXT.md
  lib/math.js        pure math (unit-tested)
  lib/gemini.js      Gemini public API client (no key needed)
  lib/claim.js       claim extraction: Claude API if ANTHROPIC_API_KEY, else regex fallback
  lib/engine.js      checkClaim(text) → full verdict object
  api/check.js       Vercel function: POST {text} → verdict JSON          (step 2)
  api/transcribe.js  Vercel function: audio → ElevenLabs → {text}         (step 3)
  public/            web demo + card.js                                    (step 2)
  extension/         Chrome MV3 side panel                                 (step 3)
  scripts/dev.js     local server: serves public/, routes /api/*           (step 2)
  test/              node:test
```
- Plain Node ESM (`"type": "module"`), no framework, zero-config Vercel (`api/` functions, `public/` static), global fetch.
- Env: `ANTHROPIC_API_KEY` (optional), `ELEVENLABS_API_KEY` (optional), `CLAUDE_MODEL` (default `claude-haiku-5-5`).
- The BTC/ETH demo path must work with NO keys.

## Gemini API: verified live today (public, no auth, base https://api.gemini.com)
- `GET /v1/prediction-markets/events?status=active&category=Crypto&limit=100&offset=0` → `{data: Event[], pagination: {limit, offset, total}}`. `search=` matches title text literally ("BTC" works, "bitcoin" returns 0).
- `GET /v1/prediction-markets/categories` → Sports, Crypto, Politics, Weather, Economics, Midterms, Commodities, Tech, Culture, Finance…
- Others: `/events/{eventTicker}`, `/events/{eventTicker}/strike`, `/events/recently-settled`, `/events/upcoming`.
- **Event:** `id, title ("BTC price on October 31"), slug, category, ticker, series ("BTC" monthly | "BTC1H" | "BTC15M" | "BTC05M"), expiryDate (ISO UTC), status, contracts[]`.
- **Contract:** `label, instrumentSymbol ("GEMI-BTC2610312100-HI72500"), expiryDate, strike {type:"above", value:"72500"}`. 5/15-min "UP" contracts use `{type:"reference", value}` = price at window start. `prices: {buy:{yes,no}, sell:{yes,no}, bestBid, bestAsk, lastTradePrice}`: strings, any may be missing, some contracts have no quotes.
- **Ticker format:** `GEMI-{ASSET}[05M|15M]{YYMMDDHHmm UTC}-{UP | HI<price>}`, `D` = decimal point.
- **Snapshot (Oct 11, 12:20 PM PT):** BTC ≈ $83.6K. BTC/ETH/SOL/XRP/ZEC have 5-min, 15-min, hourly (~9 strikes) and monthly Oct 31 events (9+ strikes). ~98 weather events with range buckets ("Highest temperature in Austin…", "92°F to 93°F" @ 0.76).
- **Spot:** `GET /v1/pubticker/btcusd` → `{bid, ask, last}`.
- **Daily candles:** `GET /v2/candles/btcusd/1day` → `[[ms, open, high, low, close, volume], ...]`, NEWEST FIRST.
- **Market prob** = mid(bestBid, bestAsk) if both exist, else lastTradePrice, else whichever side exists. Keep halfSpread.
- **Link:** `https://www.gemini.com/predictions/{slug}`.

## The math (why it's "technically impressive")
A contract pays $1 if YES and $0 if NO, so its price = the crowd's probability.
1. **normCdf**: Abramowitz–Stegun erf approximation.
2. **probCloseAbove(S,K,T,σ)** = N(d₂), d₂ = [ln(S/K) − σ²T/2]/(σ√T). The binary-option price; the same contract Gemini lists. T in years.
3. **probTouch(S,K,T,σ)**: hits K any time before T (reflection principle, ν = −σ²/2, b = |ln(K/S)|, flip ν for down-barriers): P = N((−b+νT)/(σ√T)) + exp(2νb/σ²)·N((−b−νT)/(σ√T)). Influencers say "hits," so this is the most generous honest evidence.
4. **realizedVol(closes, window)**: stdev of daily log returns × √365, at 14/30/90-day windows. The min–max of the resulting probabilities = **model range** (R2's regime-robustness idea).
5. **impliedVolFromBinary(S,K,T,p)**: grid σ ∈ [0.05, 4] plus refinement. Estimates market odds at the influencer's exact target when Gemini doesn't list that strike.
6. **speakerConfidence(text)**: "guaranteed/100%/lock/can't lose/mark my words" 0.97 · "definitely/for sure" 0.93 · "will/going to/gonna/about to" 0.85 · "likely/probably/should" 0.70 · "I think" 0.65 · "could/might/maybe" 0.40 · flat assertion 0.80.
7. **hypeVerdict:** gap = speaker − evidence. ≥0.5 HYPE · ≥0.2 STRETCH · >−0.2 FAIR CALL · else UNDERSOLD.
8. **marketVsModel:** MARKET RICH/CHEAP only if outside the model range by more than max(halfSpread, 1¢); else FAIR. **Honesty rule: never claim an edge smaller than the noise.**
9. **Assumptions shown in the UI:** lognormal understates crypto fat tails; realized vol ≠ implied vol; zero drift = no directional view; not financial advice.

