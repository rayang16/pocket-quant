# Mobile web release verification — October 11, 2026

Current direction: web app and iPhone sharing. Browser extension source, packaging, install guide, and ZIP were removed at the user's request. CONTEXT.md preserves the original brief unchanged.

## Verified

- 71 automated tests pass, including shared-link validation, URL spoofing rejection, multiple-link handling, transcription byte forwarding, missing-key/provider/rate-limit/empty-audio/size failures, and the existing math and engine suite.
- Build verifies all required web and signed shortcut artifacts.
- Apple Shortcuts created Check with Pocket Quant with Share Sheet input, URL Encode, Text containing the production URL plus encoded input, and Open URLs. Export for Anyone completed and generated the downloadable signed file.
- Browser tested the shared URL handoff locally and in production: displays the normalized Instagram link, clears tracking and the incoming fragment, and requests the actual spoken prediction rather than producing a verdict from a URL.
- Live production BTC and ETH checks returned HTTP 200 and live market data; past-fact input returned NOT A PREDICTION.
- Downloaded a real 1080×1350 BTC verdict PNG from the browser and visually inspected it.
- iPhone-width 390×844 browser layout checked, including the installation guide and received-link state.
- Public production home, sharing guide, shortcut file and capabilities endpoint returned HTTP 200 without authentication. Removed extension ZIP returns 404.

## Remaining device / configuration checks

- Actual iPhone Shortcuts import, Instagram's system Share Sheet placement, and native file sharing have not been tested on an iPhone. Browser viewport testing is not device testing.
- No ELEVENLABS_API_KEY is configured in Vercel. The recording pipeline is implemented and tested with a mocked provider; real transcription requires the key and a real audio test. The production UI disables upload and explains the missing setup.
- A shared Instagram URL is not a transcript. Automatic video download or Instagram scraping is intentionally not implemented. Users must supply the spoken claim or, once configured, upload a recording.
