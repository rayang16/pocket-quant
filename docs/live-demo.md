# Owner-only live demo

`/live.html` provides a private real-money order flow for the owner's configured Gemini account. Live trading requires explicit `GEMINI_LIVE_TRADING_ENABLED=true` opt-in, personal master-key credentials, private owner-session configuration, and durable Upstash storage. Credentials alone do not activate trading. The owner reviews and manually submits each order; report generation, funding, login, refresh, and account checks never submit orders.

The source includes the integrated account checks, market discovery, order reviews, submission transport, and durable journal. Upstash has been configured and exercised using synthetic records, including duplicate submissions, unknown-outcome blocking, persistent budgets, and over-budget rejection. On October 11, 2026, the deployed private production flow successfully checked the owner's account access, roles, available balance, and prediction-market terms, and produced an order preview. The latest offline suite passed 393 tests. **No real Gemini order has been placed; end-to-end order execution remains unverified.**

The sandbox flow remains separate at `/trade.html`, uses test funds and separate credentials, and is documented in [Gemini sandbox setup](gemini-sandbox.md).

## Private configuration

Enter secrets only through ignored local configuration or the hosting provider's secret settings. Never put them in client code, source control, chat, screenshots, or API responses.

1. Set `GEMINI_LIVE_API_KEY` and `GEMINI_LIVE_API_SECRET` to the intended Gemini master key and secret. Confirm that the key uses time-based nonces before setting `GEMINI_LIVE_NONCE_MODE=time`. The key needs access to the account reads and the Trader role for orders; no withdrawal permission is needed for this flow.
2. If the key exposes multiple open exchange accounts, set `GEMINI_LIVE_ACCOUNT` to the exact intended account shortname returned by Gemini. The server verifies the selection. Browser requests cannot supply an account name, API host, or arbitrary API path.
3. Generate a random 32-byte base64url owner code and retain it privately. Set `GEMINI_LIVE_OWNER_CODE_HASH` to its SHA-256 hex digest, `GEMINI_LIVE_SESSION_SECRET` to a separate random secret of at least 32 bytes, and `GEMINI_LIVE_APP_ORIGIN` to the exact HTTPS origin without a trailing slash. Never deploy the raw code or reuse a Gemini credential as the code or session secret. Local HTTP requires `NODE_ENV=development` and an explicit loopback origin.
4. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for the persistent database with eviction disabled. Preserve that database and its budget records across deployments. Do not use temporary storage, clear the account namespace, or replace the database to restore spending capacity.
5. Set `GEMINI_LIVE_TRADING_ENABLED=true` when enabling the owner's order-review flow. Leave it false or unset for account checks without trading. Configuration readiness does not prove that the Gemini account is eligible, funded, or permitted to trade.

The current live flow uses the personal master-key path. Leave `GEMINI_LIVE_CLIENT_ID` and `GEMINI_LIVE_CLIENT_SECRET` unset; a future multi-user OAuth product needs its own integration and Gemini application approval. Configuring both credential modes disables readiness. Pending sandbox OAuth approval is separate from this owner-only personal-key connection.

## Review and submission behavior

- The owner code creates a fifteen-minute encrypted HttpOnly, SameSite=Strict cookie. Protected actions check authentication and expiry; mutations also require the configured origin and CSRF token. Rotating the code hash, session secret, or origin invalidates existing sessions.
- The private account check reads Gemini roles, accounts, available USD, and prediction-market terms. Public visitors receive only setup flags. Account responses exclude API credentials, raw provider errors, and the private stable account identity.
- Live market discovery reads active production events from Gemini, with bounded pagination and timeouts. Eligible categories are Crypto, Economics, Business, Commodities, and Tech. Only eligible open, unexpired contracts with authoritative identities, resolution details, and supported quantity/price increments are offered. Missing or unsupported metadata blocks that contract rather than supplying a default grid.
- The owner chooses YES or NO, 1–100 whole contracts, and a limit price from $0.01 to $0.99 in whole cents. The amount must also fit the contract's verified minimum and increment and the available balance and remaining budget. Valid fractional quantity grids are supported; a whole-contract order may receive fractional execution fills. Only limit buys with `immediate-or-cancel` are supported: an order may fill fully, fill partly, or cancel unfilled quantity.
- A review shows the exact event, contract, resolution description, expiry, outcome, quantity, price, principal, fee allowance, and total reservation. It expires after at most two minutes, or sooner if the owner session or market expires. Its token is tied to that private session and verified Gemini account.
- Submission requires an explicit confirmation of that review. The server rereads the account, available USD, Trader role, and terms; obtains fresh market data; and verifies that the contract details and trading grid still match the review. It checks expiry again after asynchronous checks and after obtaining the reservation. Accept prediction-market terms directly in Gemini through the owner's action.
- Before the sole exchange attempt, an atomic Upstash operation consumes the review and reserves its total against the account's lifetime budget. Repeated confirmations return the stored submission state. They do not create a second order.
- The transport signs the fixed production REST order path using Gemini's HMAC headers and an empty request body. It never follows redirects or retries placement. Order IDs remain exact decimal strings even when larger than JavaScript's safe integer range.

## The lifetime $5 reservation limit

The live flow reserves **limit price × whole contracts + a conservative fee allowance based on the contract's verified minimum fill step**. This principal-plus-fee allowance must fit both the currently available USD balance and the unused portion of the account's **$5 lifetime demo reservation limit**. Monetary arithmetic uses integer cents and exact quantity-grid calculations.

The allowance accounts for the possibility that Gemini rounds fees up separately for every execution fill. For a verified quantity increment `s` of at most one contract, the allowance per whole requested contract is `ceil(1 / s) × ceil(2.5 × s)` cents. This uses the larger published fee maximum of 2.5¢ per contract and rounds each possible fill's allowance up to a cent. Integer increments of one contract or larger use 3¢ per whole requested contract. Noninteger increments larger than one, missing grids, and unsupported precision are rejected. The increment comes from authoritative contract metadata, and the requested whole quantity must also satisfy the exact minimum and increment grid.

For a 0.01-contract fill step, each whole contract can produce 100 fills. Reserving 1¢ for each gives a **$1 fee allowance per whole contract**. A one-contract fill step reserves **3¢ per whole contract**. Two contracts at a $0.45 limit therefore reserve $2.90 with a 0.01 fill step ($0.90 principal + $2.00 allowance), or $0.96 with a one-contract fill step ($0.90 + $0.06). The owner still enters whole-contract quantities in both cases.

Actual fees may be much lower. This conservative allowance is a budgeting reserve, not a Gemini fee quote or a guarantee about future fee changes. The pure review-policy module also supports schedule-specific estimates, but the integrated live flow uses the allowance calculated from the verified fill step.

Once a submission reservation is created, it remains counted even if an order is rejected, cancelled, partly filled, or unfilled, or if the review expires before the exchange call. There is no automatic refund of unused principal or fees. Previewing alone does not reserve money. A new session, key rotation for the same account, restart, or deployment must not reset the lifetime total. This limit applies to this app's submissions; it does not limit transactions made directly in Gemini or through another client.

Unknown or still-submitting results block further submissions for the account. An IOC response that still reports an open order is also treated as unknown, with any validated order details preserved. The owner must inspect orders directly in Gemini; refreshing a result never retries placement. There is no automatic reconciliation, reservation-release, budget-reset, or gate-clearing action in the app. Any future reconciliation workflow must verify the provider outcome before changing journal state.

## API and verification scope

`GET /api/live-trade?action=status` reports configuration and private-session status; it does not establish a Gemini connection. `login` and `logout` manage owner access. Authenticated `account` reads current account readiness. When live review is enabled, authenticated `markets`, `preview`, `submit`, and `result` provide the review and journal flow. `preview` and `submit` require JSON POST requests with origin and CSRF checks. A valid session may read a prior result for the same Gemini account after logging in again, but cannot submit a review created in an earlier session.

Offline tests use mocked exchange responses and cover authentication, immutable reviews, expiry, fresh preflight, fee-inclusive budgeting, duplicate consumption, uncertain outcomes, and transport signing. Synthetic Upstash checks establish storage behavior only. The October 11 deployed account and preview checks establish those stages for the configured owner account at that time; current account state is rechecked before submission. A successful preview is not proof of execution. Real order placement and its outcome remain unverified.

## Official references

- [Gemini API-key authentication and time-based nonces](https://developer.gemini.com/authentication/api-key)
- [Master keys and prediction-market account targeting](https://developer.gemini.com/rest-api/common/admin/subaccounts)
- [Prediction-market order placement](https://developer.gemini.com/rest-api/prediction-markets/order-management/place-order)
- [Prediction-market contract metadata](https://developer.gemini.com/rest-api/prediction-markets/events/list-events)
- [Current fee schedule](https://www.gemini.com/fees/predictions)
- [Legacy fee schedule](https://www.gemini.com/fees/predictions-2026-03-18)
- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi)
