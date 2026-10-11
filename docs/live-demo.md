# Live demo preparation

The live demo uses a personal Gemini master API key with private owner access. The current release supports authenticated, read-only account checks and prepares independent order components. **Real-money order placement is not enabled.**

## Prepared

- `/live.html` shows setup status and links to the real Gemini account, payment methods, and API settings. A separate owner access code unlocks the account check. The page never requests Gemini keys and has no transaction buttons.
- `GET /api/live-trade?action=status` returns non-secret configuration flags. It never claims a connection or live trading is enabled. Credentials alone do not activate anything. Transaction actions return `LIVE_TRADING_NOT_READY`.
- `POST ...?action=login` checks the owner code against a SHA-256 hash and creates a fifteen-minute authenticated, encrypted HttpOnly/SameSite=Strict cookie. Origin, expiry, CSRF, and environment isolation are enforced. `POST ...?action=logout` clears the cookie after checking CSRF and origin.
- `GET ...?action=account` requires the owner cookie and performs only four allowlisted production reads: roles, accounts, available balances, and prediction terms. It returns only the account label, available USD floored to cents, trading permission, terms status, and check time. It never exposes API credentials, raw provider errors, or the private stable account identity.
- `lib/live-order-policy.js` validates whole-contract limit buys, available USD, remaining demo budget, and a known current or legacy fee schedule with integer cents. It rejects orders whose principal plus **estimated** taker fee exceeds $5 or the remaining budget/balance. It is not yet called by an order endpoint.
- `lib/live-order-store.js` provides a durable Redis journal and atomic, one-use submission reservations across server instances. A persistent Upstash database with eviction disabled has been configured and exercised using synthetic records: concurrent duplicate submissions, unknown-outcome blocking, budget persistence across clients, and over-budget rejection passed. No Gemini orders were involved. The journal is not yet attached to order endpoints.
- Sandbox account and order endpoints remain separate and continue to use test funds.

## Connection choice

For a product where users connect their own accounts, use production OAuth with `balances:read,orders:read,orders:create` and Gemini's application approval. A personal API key instead represents the owner's account and must not be exposed through a public trading endpoint. That demo needs authenticated owner-only access first. Neither connection should request withdrawal permission.

Enter secrets only through ignored local configuration or the hosting provider's secret settings. Do not put them in client code, source control, chat, screenshots, or API responses. Live credentials use separate variable names from sandbox credentials.

## Remaining before live trading

1. Complete real-account eligibility/verification and confirm trading permission and prediction terms using the private account check. The personal-key path does not use the pending OAuth application. A future multi-user OAuth flow still requires Gemini application approval.
2. Bind the authenticated owner session and verified account identity to the order flow. The read-only adapter currently supports master keys with explicitly confirmed time-based nonces only. Prediction-market WebSockets do not accept master keys; do not treat successful REST account reads as verification of an order connection.
3. Preserve the configured durable Upstash Redis database and its credentials across deployments. Do not use temporary trial storage, enable eviction, or clear/reset the account budget namespace. Tokens, provider credentials, and raw errors must never be stored in order records.
4. Attach the journal to the complete order flow. Confirm current available USD from `POST /v1/balances`, resolve the contract's fee schedule and price/quantity increments from authoritative data, and recheck these and terms before submission. Recheck the review expiry after asynchronous preflight. Accept terms only in Gemini through the user's action.
5. Bind the preview to the exact account, market, outcome, quantity, price, expiry, and evidence of user confirmation. Atomically reserve the estimated total before the one permitted order attempt. Never treat adding credentials, funding, or clicking refresh as a trade authorization.
6. Reconcile uncertain outcomes with Gemini before another order. REST placement does not document an idempotency guarantee; never retry an ambiguous placement automatically. Order IDs may exceed JavaScript's safe integer range, so retain them losslessly.
7. Complete authenticated integration tests and review the user-visible real-money confirmation. The user submits the actual financial transaction themselves.

The initial journal is deliberately conservative: reservations survive session changes and server restarts, and are not automatically refunded after a failed or unfilled submission. Unknown/submitting results block additional submissions for the account. Budget reset/release requires a separately designed reconciliation workflow; reconnecting must never reset the $5 budget.

## Private account configuration

Set `GEMINI_LIVE_API_KEY`, `GEMINI_LIVE_API_SECRET`, and `GEMINI_LIVE_NONCE_MODE=time` only after confirming time-based support. If multiple open exchange accounts exist, set `GEMINI_LIVE_ACCOUNT` to an exact shortname returned by Gemini. The adapter never lets a browser choose arbitrary account names or API paths.

Generate a random 32-byte base64url owner code and retain it in a private password manager or ignored file. Set `GEMINI_LIVE_OWNER_CODE_HASH` to its SHA-256 hex digest, `GEMINI_LIVE_SESSION_SECRET` to a separate random secret, and `GEMINI_LIVE_APP_ORIGIN` to the exact public HTTPS origin without a trailing slash. Never deploy the raw access code. Local HTTP is allowed only with `NODE_ENV=development` and an explicit loopback origin. Rotating the code hash, session secret, or origin invalidates existing cookies.

The owner code protects one operator's demo account; it is not a multi-user Gemini account-linking system. Provider calls are read-only and shared while a check is in flight on one instance. This does not implement a durable cross-instance rate limit or an order authentication mechanism.

## Fees and the $5 budget

The current published taker fee is `0.07 × contracts × price × (1 − price)` for contracts listed from March 18, 2026, rounded up to a cent. The legacy schedule uses `0.05 × contracts × min(price, 1 − price)`. The review policy rounds both estimates upward for budgeting. Unknown schedules are rejected rather than guessed.

The $5 check includes an estimated trading fee; it is not a guaranteed maximum final charge. Per-fill rounding and fee changes can affect actual fees. Before enabling orders, verify the applicable fee behavior with Gemini, leave funding headroom, and keep the available-balance check. Depositing $5 does not itself establish production app approval or that all $5 is immediately available to trade.

## Official references

- [Gemini OAuth and production application approval](https://developer.gemini.com/authentication/oauth)
- [Available balances](https://developer.gemini.com/trading/rest-api/fund-management/get-available-balances)
- [Prediction-market order placement](https://developer.gemini.com/rest-api/prediction-markets/order-management/place-order)
- [Current fee schedule](https://www.gemini.com/fees/predictions)
- [Legacy fee schedule](https://www.gemini.com/fees/predictions-2026-03-18)
- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi)
