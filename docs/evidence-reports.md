# Reel evidence reports

The app separates a transcript into up to three source-anchored claims. Users review the words and claim type before explicitly starting source checks. Each claim is a separate request so one unavailable service does not erase other cards. Editing a transcript or card cancels stale UI updates.

## Configuration

`ANTHROPIC_API_KEY` enables Claude extraction and server-side web search. `EVIDENCE_MODEL` defaults to `claude-sonnet-4-6`; the model and account must support the Anthropic web search tool. These are server secrets, separate from Gemini Exchange OAuth and Supadata. A Claude consumer subscription is not an API key. Configure the key in the server environment and redeploy; never put it in browser code or Git.

Without the key, deterministic text rules select claim drafts and public Gemini market discovery still runs. Each card explicitly states that live source research did not complete. No demo evidence is substituted.

## Endpoints

- `POST /api/evidence-report?action=extract`, JSON `{text, sourceUrl?}`. Transcript: 3–6,000 characters. Returns `{claims, extraction, warnings, checkedAt}`. Each claim has `id`, `text`, `quote`, and `type` (`fact`, `forecast`, `recommendation`). The displayed words are anchored to a verified substring of the supplied transcript, even when AI proposes a paraphrase.
- `POST /api/evidence-report?action=check`, JSON `{claim, sourceUrl?}`. Claim text: 3–500 characters; original quote: at most 2,000. Returns `{claim, assessment, sources, market, model, checkedAt}`. At most three cards are submitted concurrently by the UI.

Both endpoints require JSON, limit bodies to 26 KB, reject cross-origin browser requests, and never fetch user-supplied URLs. The optional Reel URL is a validated reference only. There is a process-local limit of 12 fresh requests per client per minute and eight concurrent requests; these are not an authenticated quota or a global spending limit. Identical requests share an in-flight result and may be reused for five minutes, with a maximum of 100 entries. Provider failures are not retained as completed reports. Serverless instances do not share limits or caches. Set a spending limit on the research API account before sharing publicly.

## Evidence and uncertainty

Claude searches first, then returns a structured assessment. Source URLs, titles and publication dates come only from actual provider web-search results. Plain model-written URLs cannot create source cards. Optional excerpts come from provider citation metadata and are capped at 20 words per source. Missing dates stay unknown. A source type is marked primary only for a small known set of government/issuer hosts; others remain unclassified. A company announcement is evidence of the announcement, not independent proof of completion.

Factual assessments use supported, contradicted, mixed, or unverified. A conclusion without usable cited sources becomes unverified. A source-service failure is unavailable. Future predictions stay forecasts and investment recommendations stay opinions; neither is given a true/false outcome or suitable-trade verdict. Search results and AI interpretations can be incomplete or wrong, so source links remain inspectable. A failed search is not evidence of fraud or nonexistence.

Related Gemini markets are separate from factual evidence. Keyword overlap never establishes exact metric, threshold, settlement rules, or deadline. Quotes are labeled as prices of their listed contracts, not odds of the Reel claim. The independent crypto model runs only for a supported asset, target, and explicit calendar deadline with a year. Undated Reel phrases such as “this year” are flagged rather than silently assigned the current year. The existing single-crypto checker remains available separately.

## Validation status

Offline tests cover claim anchoring, unsupported sources, URL safety, missing configuration, input/origin limits, concurrent requests, cancellation and partial failures. A live sourced report also requires a configured research API key and a successful provider call. Offline fixtures and manually researched examples do not establish live provider success.

Provider references: [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
