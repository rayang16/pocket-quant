# Public Reel transcription

The iPhone shortcut already passes a Reel link into Gem Finder. Automatic transcription adds a server call to Supadata; a native iPhone wrapper alone would not supply the Reel's audio.

## Setup

1. Create a Supadata account and get its API key from the dashboard.
2. Set `SUPADATA_API_KEY` in the server environment (Vercel production secrets for the deployed app, ignored `.env` for local development).
3. Redeploy or restart the server. `/api/capabilities` reports `reelTranscription: true` when the key is present. This indicates configuration, not proof the provider accepts the key or has remaining credits.
4. Share or paste an actual public Instagram Reel. The completed transcript automatically starts extraction of up to three claims, Gemini market comparisons, and applicable crypto math. Review/correct the transcript or claims as needed; edits stop active checks, and corrected text can be rechecked. Validate several actual Reels and the iPhone handoff before promising device-wide support.

The key must never be prefixed for public/client use, committed to Git, or placed in the shortcut. Gemini sandbox OAuth approval is unrelated to this configuration.

## Request lifecycle

`POST /api/reel-transcript` accepts either `{url}` or `{jobToken}`, JSON only, up to 16 KB. Only validated Instagram HTTPS permalinks are accepted; tracking parameters are removed. The server always calls `https://api.supadata.ai/v1/transcript` with `mode=auto` and `text=true`, authenticated with the server-only key. No redirects or arbitrary upstream hosts are allowed.

Supadata can return the transcript immediately or a job ID. The app returns an HMAC-signed, fifteen-minute job token binding that ID and the source URL. Later requests verify that token and poll the existing job. No API key is included in it. This is stateless across serverless instances. Provider keys are used only for their own job-token signature domain; rotating the key invalidates outstanding jobs.

The initial provider request has a 110-second timeout, polling calls 20 seconds, and this Vercel function has a 120-second maximum. The UI has a bounded total wait and a cancel/manual option. Canceling stops the client wait; already-started provider processing may continue and may still be charged. An uncertain timeout never triggers an automatic new paid request.

Successful text is limited to 6,000 characters, with an explicit truncation flag when longer. Up to three editable claims are extracted and checked automatically; no second tap is required. Empty transcripts, partial/unavailable responses, failed jobs, malformed responses, provider errors, and expired tokens are explicit failures, never fabricated text or odds. Raw provider errors are not exposed.

## Access, privacy, and cost limits

- Only publicly accessible media is supported by the provider. Private, login-required, age-restricted, unavailable, or blocked Reels need a pasted claim or uploaded recording. We do not request Instagram passwords/cookies or bypass restrictions.
- Shared public links are sent to Supadata. Uploaded recordings use ElevenLabs separately and need `ELEVENLABS_API_KEY`. The UI names the provider before intake.
- Recording uploads remain capped at 4 MB for hosting compatibility. A short audio extract is more practical than a large iPhone screen recording. Larger uploads need a separate direct-storage upload path.
- Successful start requests are deduplicated/cached per process and normalized URL for ten minutes, bounded to 100 entries. Expired entries are cleared on the next start request or when the process ends. Failures are retained briefly to avoid immediate double submissions. Raw audio is not cached by this feature. Poll results are not persisted by the app.
- A best-effort process-local guard allows six new URLs per client per minute and eight concurrent starts. It is not a durable account quota or a security boundary. Cross-origin browser requests are rejected; a custom HTTP client can still reach this public endpoint. Set provider spending limits; add durable quotas/user authentication before broader distribution.
- Supadata's retention, processing, pricing, and credit rules apply separately. See the [official transcript documentation](https://docs.supadata.ai/get-transcript).

## Verification

`npm test` covers offline success/async/error paths, signed tokens, input validation, and cancellation behavior. Offline fixtures prove application handling only; a real successful provider call and a real iPhone share are separate verification steps.

Earlier October 11, 2026 transcription stage: A real Supadata request through both the local and deployed browser flows successfully transcribed the public example Reel `DEDbGqpyfkT` linked in Supadata's documentation. Two user-selected Reels also transcribed successfully on the deployed app:

- `DdsqGzuuEKV`: a VSOF promotion. The extracted October 7 price claim was not treated as a future prediction. Transcription does not verify endorsements, token legitimacy, or the other factual claims in the video.
- `Db8kR0kud6W`: a rare-earth/magnet investment discussion. A reviewed Tesla Optimus annual-production forecast found a related Gemini release market. Those are different conditions; the app labels this only a possible match and assigns no hype verdict. This test also exposed irrelevant results matching the generic word “year,” addressed by excluding generic time/prediction words from candidate search.

At that stage, all 122 offline tests passed after the search correction. The app displayed each transcript for editing and did not automatically run an analysis.

Later October 11 update: completed transcripts now automatically start extraction and checks for up to three editable claims, with optional Claude selection and explanation. The latest offline suite passed 393 tests. Physical iPhone Share Sheet import/handoff is still unverified; desktop browser and provider checks do not prove iPhone behavior.
