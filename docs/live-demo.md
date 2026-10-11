# Live demo preparation

The user requested a real-money Gemini demo funded with $5. The current release prepares independent components while the production credential type and account setup are pending. **Real-money order placement is not enabled.**

## Prepared

- `/live.html` shows setup status and links to the real Gemini account, payment methods, and API settings. It has no credential fields or transaction buttons.
- `GET /api/live-trade?action=status` returns non-secret configuration flags. It never claims a connection or live trading is enabled. Credentials alone do not activate anything. Transaction actions return `LIVE_TRADING_NOT_READY`.
- `lib/live-order-policy.js` validates whole-contract limit buys, available USD, remaining demo budget, and a known current or legacy fee schedule with integer cents. It rejects orders whose principal plus **estimated** taker fee exceeds $5 or the remaining budget/balance. It is not yet called by an order endpoint.
- `lib/live-order-store.js` provides a durable Redis journal and atomic, one-use submission reservations across server instances. It is not yet attached to account authentication or Gemini order calls. No live Redis database has been configured or exercised.
- Sandbox account and order endpoints remain separate and continue to use test funds.

## Connection choice

For a product where users connect their own accounts, use production OAuth with `balances:read,orders:read,orders:create` and Gemini's application approval. A personal API key instead represents the owner's account and must not be exposed through a public trading endpoint. That demo needs authenticated owner-only access first. Neither connection should request withdrawal permission.

Enter secrets only through ignored local configuration or the hosting provider's secret settings. Do not put them in client code, source control, chat, screenshots, or API responses. Live credentials use separate variable names from sandbox credentials.

## Remaining before live trading

1. Confirm the credential type, complete real-account eligibility/verification, and verify permission to use prediction markets. OAuth requires approval of the production application and its exact callback.
2. Implement and verify the matching authentication flow, including stable server-verified account identity, environment-isolated sessions, origin/CSRF checks, and private owner access if using a personal key.
3. Configure a durable, non-expiring Upstash Redis database. Do not use temporary trial storage or clear/reset the account budget namespace. Tokens, provider credentials, and raw errors must never be stored in order records.
4. Attach the journal to the complete order flow. Confirm current available USD from `POST /v1/balances`, resolve the contract's fee schedule and price/quantity increments from authoritative data, and recheck these and terms before submission. Recheck the review expiry after asynchronous preflight. Accept terms only in Gemini through the user's action.
5. Bind the preview to the exact account, market, outcome, quantity, price, expiry, and evidence of user confirmation. Atomically reserve the estimated total before the one permitted order attempt. Never treat adding credentials, funding, or clicking refresh as a trade authorization.
6. Reconcile uncertain outcomes with Gemini before another order. REST placement does not document an idempotency guarantee; never retry an ambiguous placement automatically. Order IDs may exceed JavaScript's safe integer range, so retain them losslessly.
7. Complete authenticated integration tests and review the user-visible real-money confirmation. The user submits the actual financial transaction themselves.

The initial journal is deliberately conservative: reservations survive session changes and server restarts, and are not automatically refunded after a failed or unfilled submission. Unknown/submitting results block additional submissions for the account. Budget reset/release requires a separately designed reconciliation workflow; reconnecting must never reset the $5 budget.

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
