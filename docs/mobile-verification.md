# Mobile web release verification — October 11, 2026

Current direction: web app and iPhone sharing. Browser extension source, packaging, install guide, and ZIP were removed at the user's request. CONTEXT.md preserves the original brief unchanged.

## Verified at the earlier mobile release stage

These checks record the initial October 11 mobile release, before automatic Supadata transcription and multi-claim reports were added. The test count and manual intake behavior below describe that stage.

- 71 automated tests passed, including shared-link validation, URL spoofing rejection, multiple-link handling, transcription byte forwarding, missing-key/provider/rate-limit/empty-audio/size failures, and the existing math and engine suite.
- Build verifies all required web and signed shortcut artifacts.
- Apple Shortcuts created Check with Pocket Quant with Share Sheet input, URL Encode, Text containing the production URL plus encoded input, and Open URLs. Export for Anyone completed and generated the downloadable signed file.
- Browser tested the shared URL handoff locally and in production: displays the normalized Instagram link, clears tracking and the incoming fragment, and requests the actual spoken prediction rather than producing a verdict from a URL.
- Live production BTC and ETH checks returned HTTP 200 and live market data; past-fact input returned NOT A PREDICTION.
- Downloaded a real 1080×1350 BTC verdict PNG from the browser and visually inspected it.
- iPhone-width 390×844 browser layout checked, including the installation guide and received-link state.
- Public production home, sharing guide, shortcut file and capabilities endpoint returned HTTP 200 without authentication. Removed extension ZIP returns 404.

## Later October 11 update

Supadata is now configured on the deployed app and has transcribed real public Reels through the browser. Completed transcripts automatically start extraction and Gemini checks for up to three editable claims, with crypto math where supported. The latest offline suite passed 341 tests. See [Reel transcription verification](reel-transcription.md). These later browser/provider checks do not establish physical iPhone behavior.

## Remaining device / configuration checks

- Actual iPhone Shortcuts import, Instagram's system Share Sheet placement, and native file sharing have not been tested on an iPhone. Browser viewport testing is not device testing.
- Optional ElevenLabs recording transcription is implemented with offline mocked-provider coverage. It requires `ELEVENLABS_API_KEY` on the server; real recording transcription remains unverified. The UI disables upload when the server reports that it is unconfigured.
- A shared Instagram URL is sent to Supadata for transcription; the app does not download or scrape Instagram video itself. Private, restricted, or unavailable Reels still need pasted words or a recording when enabled.


## UI and market workspace verification — October 11, 2026

The supplied UI was applied to the existing native web app, with the market dashboard and per-tab saved analysis history added at the user’s request. The existing Reel processing, single-crypto checker, signed Shortcut, owner-session trading handlers, and sandbox handlers remain in place.

- **393 offline tests pass**, plus the static asset build and whitespace checks.
- Browser-verified a pasted crypto forecast through automatic extraction, Gemini market comparisons, a quantitative conclusion, saving, reopening without a new analysis request, and handoff into the dashboard.
- Browser-verified real Gemini directory loading, category/search filtering, map, quote and timeline views, and light/dark themes. A configured Claude explanation was unavailable during this check; the existing Gemini/math fallback conclusion remained visible.
- Sharing instructions and private owner access render with the new theme. No real-money order was submitted during this work.
- Responsive CSS is included; the browser viewport override did not take effect in this verification session. A physical iPhone share flow and narrow-screen interaction still require device testing.
