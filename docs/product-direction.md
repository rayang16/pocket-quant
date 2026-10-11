# Pocket Quant — current product direction

Updated October 11, 2026. This supplements the original, verbatim `CONTEXT.md`. The current product is a mobile web app with iPhone sharing. Its report uses **Gemini Exchange Prediction Markets**, not Google Gemini or a browser extension.

## Experience

Instagram Reel → Share → Pocket Quant → Supadata transcript → up to three editable claims → automatic Gemini comparisons and applicable crypto math → clear conclusion → inspect results → return to the feed.

People encounter confident financial claims while scrolling. Pocket Quant makes it easier to identify the actual claims, see whether Gemini has relevant contracts, and inspect what those contracts price. Optional Claude interpretation selects source-anchored claims and explains the supplied Gemini results and crypto math. Text rules and deterministic conclusions keep Gemini checks working without a Claude key or if the provider fails. Recording transcripts use the same flow. Pasted transcripts need one **Check with Gemini** action, and sample buttons run extraction and checks together. Users can correct words and classification; edits stop active checks and allow an explicit recheck.

The result answers the Reel first: what does the available evidence actually tell us about this claim? It then shows the claim type, related Gemini contracts, differences in conditions or deadlines, and any supported crypto calculation. A clear answer can be “Gemini cannot verify this past return” or “This market prices a release, not the claimed production volume.”

## Gemini track positioning

- **Distribution:** introduce Gemini Prediction Markets when a user already cares about a prediction.
- **Trust:** display real contract quotes, matching limits, model assumptions, and missing-data states.
- **Discovery:** open an existing Gemini market so users can inspect its exact terms.
- **Quantitative comparison:** use a separate volatility calculation for supported crypto targets, without presenting it as proof or a trading recommendation.

Historical factual claims receive `not_market_verifiable`; they are not verified by market prices. Forecasts remain uncertain, and recommendations remain opinions. This build does not search external sources or claim to fact-check every financial statement. Both market prices and the quantitative model’s input data come from Gemini, so describe the model as a separate calculation rather than an independent data source.

The intended experience is a quick check from the feed. It opens a separate app, waits for transcription when needed, and automatically fills results. Users can inspect and correct the extracted claims. Do not claim it takes no time or operates entirely inside Instagram.

## Current build and remaining verification

| Piece | Current state |
| --- | --- |
| Receive a Reel | An iPhone Share Sheet shortcut opens a validated Instagram link. Actual iPhone import and Instagram handoff still need a device test. |
| Public Reel transcription | Supadata provides an editable transcript when the Reel is accessible. Requires `SUPADATA_API_KEY`, configured on the deployed app; private, restricted, missing, or silent media keeps a manual fallback. |
| Claim extraction | Optional Claude selection returns up to three source-anchored statements, with text-rule fallback. Checks begin automatically; users can edit and recheck. |
| Gemini report | Public-data market discovery runs automatically after extraction and needs no API key. Each card leads with a conclusion. Optional Claude explains supplied quotes and model results, with deterministic fallback; related prices do not verify historical facts or the precise Reel forecast. |
| Crypto model | Supported price forecasts with explicit calendar deadlines can use Gemini data and 14/30/90-day volatility estimates. Unsupported or ambiguous claims do not receive a probability model. |
| Recording upload | Optional ElevenLabs integration; requires its key and a real-audio check. A completed transcript automatically starts claim extraction and Gemini checks. |
| Trading | Automatic reports never place orders. Sandbox-only account connection and manual order review are implemented. Gemini OAuth approval is pending; end-to-end test orders are unverified. Production trading is disabled. |
| Sharing results | The single-crypto checker provides PNG cards. Native file sharing still needs an iPhone check; do not imply the full three-claim report is exported. |

Supadata provides paid transcription; enabling Claude adds Anthropic API charges. With Claude enabled, Anthropic receives transcript text for claim selection and claims with Gemini results and applicable model output for explanation. Gemini remains the market-data source. This flow does not use Google Gemini or external web research. Claude credentials remain on the server. Reports use bounded process-local caching and request limits, not persistent user accounts or a database. An Instagram DM bot, market creation, and a dataset of unmet market demand remain future ideas.

## Pitch and demonstration

“Share a financial Reel to Pocket Quant and get a clear answer about what Gemini’s prediction markets can tell you. It automatically finds the claims, checks real Gemini contracts, and compares supported crypto forecasts with transparent volatility math. When enabled, Claude explains those results in plain English.”

Describe the actual demo input: a public Reel transcribed through Supadata, a recording transcribed separately, or pasted text. Distinguish live provider and browser checks from an actual iPhone Share Sheet demonstration. Show a no-market or non-verifiable factual claim as honestly as a useful match.

For user feedback, measure consenting testers who complete the flow, time from Reel to result, failures in sharing or extraction, and whether they inspect a Gemini market. Ask what changed their understanding, including when nothing changed. These are proposed measurements, not existing analytics or collected results.
