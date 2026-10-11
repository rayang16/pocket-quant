# Pocket Quant — current product direction

Updated October 11, 2026 from Rayan's latest hackathon context. This supplements the original, verbatim CONTEXT.md. The current product is an outside mobile web app with iPhone sharing, not a Chrome extension.

## The problem and intended experience

People encounter confident financial and trading predictions while scrolling Instagram Reels. Investigating each prediction means leaving the feed, finding relevant evidence, and interpreting it. Pocket Quant is intended to make that investigation a short detour from the Reel itself.

Target flow: Instagram Reel → Share → Pocket Quant → review the extracted prediction → compare Gemini market evidence and a quantitative model → inspect the relevant Gemini market or share an evidence card → return to the feed.

The core output answers: What exactly is being predicted? What do relevant Gemini contracts price in? What does a disclosed volatility model estimate? How much confidence does the evidence justify?

## Why this fits the Gemini track

- Distribution: introduce Gemini Prediction Markets when a user already cares about a specific prediction.
- Trust: display real quotes, contract conditions, model assumptions, and uncertainty; explicitly say when evidence is missing.
- Market discovery: link from a Reel's prediction to a relevant existing Gemini market so the user can inspect its terms and decide what to do.
- Shareable evidence: a readable verdict card gives users something concrete to discuss or send back to friends.

Potential future feedback to Gemini about frequently requested but unavailable markets is a separate idea. It would require an explicit data-collection design and permission; the current app neither creates markets nor collects a demand dataset.

## Language that matches the evidence

Use “prediction checker” or “hype checker” for future price claims. “Fact-check every financial claim” would require evidence sources and methods beyond the current prediction-market engine.

Call the quantitative model a second analytical lens. Realized-volatility estimates are computed separately from prediction-market quotes, but both currently use Gemini data; the model is not an independent data source or proof that a prediction is true. A model calibrated to market prices is even more directly dependent on those prices.

Distinguish a plausible prediction from suitable trading advice. Market odds and a model estimate do not establish that a trade is profitable or appropriate for a particular person. Analysis results offer market discovery with explicit matching conditions. A separate sandbox page lets users test an account connection and manually review a test order; production trading remains disabled.

Use “a quick check from your feed” as the intended experience. Do not claim that users lose no time or that the entire analysis happens inside Instagram: the current flow opens a separate app and still needs the claim text.

## Current build versus the target flow

| Piece | Current state |
| --- | --- |
| Receive a Reel | iPhone Share Sheet shortcut opens a validated Instagram link in the web app; actual iPhone import and Instagram handoff still need a device test. |
| Extract the spoken prediction automatically from the shared link | Not implemented. Instagram link sharing does not supply the video/audio to this app. Users currently enter the prediction. |
| Transcribe an uploaded recording | Implemented with ElevenLabs; production requires ELEVENLABS_API_KEY and a real-audio check. |
| Compare market and model | Live Gemini quotes plus probability estimates across 14/30/90-day volatility windows for supported crypto claims. |
| Explain missing or imperfect evidence | No-market states, nearest-contract conditions, quote limits, and model assumptions are disclosed. |
| Inspect a Gemini market | Existing market links are available on results. A sandbox-only connection and order-review flow is implemented; Gemini app credentials are still required for end-to-end verification. No live trading or market creation. |
| Share evidence | PNG card download is verified; native sharing depends on browser support and still needs an iPhone test. |

The largest gap in the promised experience is reliable, permitted extraction of the Reel's spoken prediction without asking users to type it. Improving ingestion matters more to the “seamless” claim than adding more verdict labels or trading features.

## Pitch

“Your feed is full of financial predictions. Pocket Quant brings a second opinion to the moment you encounter one: compare the claim with live Gemini Prediction Market odds and a transparent volatility model, see where the evidence agrees or falls short, and open the relevant market on Gemini. We turn attention from a Reel into an informed look at a prediction market.”

In the live demo, describe the exact input used: shared link plus entered claim today, or uploaded recording once transcription is configured. Present automatic Reel-to-verdict analysis as the next ingestion milestone until it has been demonstrated on a real phone.

## Hackathon evidence to collect

Track distinct people who actually complete a check, time and steps from Reel to result, failures in sharing or claim extraction, and how many testers choose to inspect the Gemini market. Ask what changed their understanding, including when nothing changed. Use consenting testers' quotes; separate survey interest from actual product usage. These are proposed measurements, not existing analytics or collected results.
