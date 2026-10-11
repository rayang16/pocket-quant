# Market workspace

The [market overview](https://pocket-quant-ashen.vercel.app/markets.html) connects saved Pocket Quant analyses to Gemini's public prediction markets. It adds discovery and comparison views while keeping Reel analysis, iPhone sharing, and the existing trading routes intact.

## Use it

1. Analyze a Reel or run the single crypto check. Successful results appear in **Recent analyses**.
2. Open an analysis's market overview to inspect its selected Gemini events. **Your Reels** preserves the report service's chosen matches; it does not broaden a report's subject match with generic keywords.
3. Choose **All markets** to browse the public directory independently. Search, categories, and expiry/title sorting narrow the displayed markets. **Load more** continues a bounded page when available.
4. Switch between **Map**, **Quotes**, **Markets**, and **Timeline**. The map arranges topics and events; the timeline arranges contract deadlines. Neither view establishes causation or measures trading performance.
5. **Open in Gemini** shows the source event. Eligible financial instruments also offer **Review trade**, which opens the existing private owner flow with a symbol preselected. That flow checks fresh eligibility, then still requires owner access, preview, and manual confirmation. Browsing never places an order.

## Saved analysis behavior

History holds up to 30 recent results in the current browser tab's `sessionStorage`, under `pocket-quant-workspace-v1`. A repeat check of the same text and source URL updates that entry. These are snapshots, including the transcript/claim text, source URL when supplied, evidence report or model output, and check time. They are not a cloud account, a team workspace, or an analytics system. A new tab or browser session may not have the same history.

The analysis page can reopen an entry with `/?analysis=<id>`; the market page accepts `/markets.html?check=<id>`. The market sidebar can remove a check or clear this tab's workspace. If browser storage is blocked, a just-completed check can remain available in memory, but navigation may not preserve it. Failed storage removal leaves visible history unchanged and reports the failure.

A saved model remains labeled with its calculation time. Refreshing market quotes does not recalculate that saved model. Refreshing a saved Reel report explicitly calls the existing report endpoint again and may use configured provider credits.

## Real data, visible limits

- Quotes come from Gemini's public events feed. Bid/ask midpoints, last trades, one-sided prices, crossed books, and missing prices retain their source/quality labels. A missing quote is a gap, never zero.
- Charts compare observed **YES contract quotes**, not price histories. Numeric cryptocurrency strike ladders require explicit `above` strike semantics, unique strikes, and the same contract expiry. Other outcomes use categorical bars.
- The evidence panel may display the original checked contract's **NO** side while the chart displays **YES**. The conversion preserves bid/ask orientation and is labeled.
- Only the original checked instrument receives its saved model comparison. Related events do not inherit another contract's model or become verification of a Reel.
- Gemini retrieval time is shown; the feed used here does not establish the age of each quote. Snapshot contracts may expire after retrieval and are labeled accordingly.
- The directory caps each normalized response at 100 events and 500 contracts. Oversized events disclose omitted contracts. The shared Gemini client bounds upstream discovery at 5,000 top-level events; an incomplete upstream scan fails rather than claiming full coverage.
- Category names are sent to Gemini's public category filter. The **Live** category means Gemini's upstream Live feed; it is not inferred from an event's `active` status.

## Source preview and privacy

The original Instagram link is validated as a Reel permalink. Instagram's embed loads only after **Load Instagram preview** is clicked. That request goes to Instagram and may be restricted by the Reel's visibility or the browser.

**Preview a local recording** plays a selected video in the browser using a temporary object URL. It does not upload, transcribe, save, or replace the analysis source. The analysis page's recording transcription flow remains separate. Preview files are capped at 100 MB, and their object URLs are released when removed or when the page closes.

## Read-only API

`GET /api/markets` requires no account credentials. It calls only public Gemini market data. It does not share an account session with `/api/live-trade` and accepts no order operation.

Supported query fields:

| Field | Purpose |
| --- | --- |
| `asset` | BTC, ETH, SOL, XRP, or ZEC; restricts discovery to that crypto asset |
| `category` or `sector` | Public Gemini category, or one of the visible category tab slugs |
| `q` | Original check text, up to 6,000 characters; related discovery only |
| `search` | Explicit directory search, up to 120 characters |
| `deadline` | ISO date/time to order related events by proximity |
| `cursor` | Continuation token returned by the prior response with the same filters |

Responses include normalized `events`, `fetchedAt`, totals, per-event truncation flags, `hasMore`, and `nextCursor`. Continuations use a deterministic seek key rather than applying an old offset to a changed live feed. Tokens expire after 15 minutes; malformed, expired, or mismatched tokens return `409` and require refreshing. Source listings can still change between pages, so totals and quotes are not an immutable market snapshot.

Invalid query input returns `400`. Upstream failure returns `502` with an explicit unavailable state, never synthetic prices. Repeated parameters and arbitrary upstream URLs are rejected. `OPTIONS` supports read-only preflight; other methods return `405`.

## Technology and checks

The workspace uses native HTML, CSS, and browser modules, with local Geist font assets, Lucide SVG icons, and Apache ECharts 6.1.0 for SVG quote charts and gauges. No chart CDN request is required. Licenses are retained in [`public/vendor`](../public/vendor/README.md) and [`public/fonts/OFL.txt`](../public/fonts/OFL.txt).

Focused tests cover read-only routing, query validation, active/unexpired filtering, quote quality, numeric-ladder eligibility, related report handoff, missing prices, bounds, and portable pagination. Browser checks should cover keyboard selection, theme changes, mobile layout, storage failure, and the existing manual trade handoff. The workspace does not prove a physical iPhone Shortcut flow or a completed real-money order.
