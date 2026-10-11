# Pocket Quant — current product direction

Updated October 11, 2026. This supplements the original, verbatim `CONTEXT.md`. The current product is a mobile web app with iPhone sharing. Its report uses **Gemini Exchange Prediction Markets**, not Google Gemini or a browser extension.

## Experience

Instagram Reel → Share → Pocket Quant → Supadata transcript → up to three draft claims → user review → **Check with Gemini** → inspect related markets and any applicable crypto math → return to the feed.

People encounter confident financial claims while scrolling. Pocket Quant makes it easier to identify the actual claims, see whether Gemini has relevant contracts, and inspect what those contracts price. Text rules extract drafts without an AI-provider key. Users correct the words and classification before market checks begin.

The result answers: What is the claim? Is it a fact, forecast, or recommendation? Which Gemini contracts relate to it? Do their conditions match? Can the disclosed crypto model contribute a useful comparison?

## Gemini track positioning

- **Distribution:** introduce Gemini Prediction Markets when a user already cares about a prediction.
- **Trust:** display real contract quotes, matching limits, model assumptions, and missing-data states.
- **Discovery:** open an existing Gemini market so users can inspect its exact terms.
- **Quantitative comparison:** use a separate volatility calculation for supported crypto targets, without presenting it as proof or a trading recommendation.

Historical factual claims receive `not_market_verifiable`; they are not verified by market prices. Forecasts remain uncertain, and recommendations remain opinions. This build does not search external sources or claim to fact-check every financial statement. Both market prices and the quantitative model’s input data come from Gemini, so describe the model as a separate calculation rather than an independent data source.

The intended experience is a quick check from the feed. It opens a separate app, waits for transcription when needed, and asks for review. Do not claim it takes no time or operates entirely inside Instagram.

## Current build and remaining verification

| Piece | Current state |
| --- | --- |
| Receive a Reel | An iPhone Share Sheet shortcut opens a validated Instagram link. Actual iPhone import and Instagram handoff still need a device test. |
| Public Reel transcription | Supadata provides an editable transcript when the Reel is accessible. Requires `SUPADATA_API_KEY`, configured on the deployed app; private, restricted, missing, or silent media keeps a manual fallback. |
| Claim review | Deterministic rules select up to three distinct statements. Users edit the wording and classify facts, forecasts, and recommendations. |
| Gemini report | Public-data market discovery needs no API key. Related contract prices do not verify historical facts or the precise Reel forecast. |
| Crypto model | Supported price forecasts with explicit calendar deadlines can use Gemini data and 14/30/90-day volatility estimates. Unsupported or ambiguous claims do not receive a probability model. |
| Recording upload | Separate optional ElevenLabs integration; requires its key and a real-audio check. |
| Trading | Sandbox-only account connection and manual order review are implemented. Gemini OAuth approval is pending; end-to-end test orders are unverified. Production trading is disabled. |
| Sharing results | The single-crypto checker provides PNG cards. Native file sharing still needs an iPhone check; do not imply the full three-claim report is exported. |

Supadata is the only paid provider in the public-Reel-to-report flow. Report text is processed with local rules and public Gemini data; no Claude or external research API is involved. Reports use bounded process-local caching and request limits, not persistent user accounts or a database. An Instagram DM bot, market creation, and a dataset of unmet market demand remain future ideas.

## Pitch and demonstration

“Share a financial Reel to Pocket Quant, review its claims, and see what related Gemini Prediction Markets are pricing. For supported crypto forecasts, compare those prices with a transparent volatility model. Open the market’s exact terms before deciding what the prediction means.”

Describe the actual demo input: a public Reel transcribed through Supadata, a recording transcribed separately, or pasted text. Distinguish live provider and browser checks from an actual iPhone Share Sheet demonstration. Show a no-market or non-verifiable factual claim as honestly as a useful match.

For user feedback, measure consenting testers who complete the flow, time from Reel to result, failures in sharing or extraction, and whether they inspect a Gemini market. Ask what changed their understanding, including when nothing changed. These are proposed measurements, not existing analytics or collected results.
