# Gemini sandbox connection

Gem Finder has a sandbox-only account connection and an explicit review → confirm → receipt flow for buying YES or NO prediction contracts with test funds. Start at `/trade.html`, also linked from the home page. Nothing in this integration can be configured to send orders to Gemini production: both the OAuth and API hosts are fixed sandbox constants.

## Register the app

1. Sign in to [Gemini sandbox](https://exchange.sandbox.gemini.com/) and create an OAuth application in API Settings. Select a **confidential/server client**.
2. Request `orders:read` (terms status) and `orders:create` (test orders). No withdrawal permissions are requested.
3. Register the exact callback for the environment you will demo:
   - Local: `http://localhost:3000/api/gemini-account?action=callback`
   - Deployed: `https://pocket-quant-ashen.vercel.app/api/gemini-account?action=callback`
4. Set the server's `GEMINI_SANDBOX_CLIENT_ID`, `GEMINI_SANDBOX_CLIENT_SECRET`, `GEMINI_REDIRECT_URI`, and a separate random `GEMINI_SESSION_SECRET` of at least 32 bytes. Generate that secret locally, for example with `openssl rand -hex 32`. Put values in an ignored `.env` locally or the deployment's secret settings. Never paste secrets into chat, client code, or Git.
5. Restart the local server or redeploy after setting environment variables. Open `/trade.html`, connect a sandbox account with Prediction Markets access and test funds, and complete Gemini's authorization screen.
6. If terms are required, review and accept them on Gemini's sandbox before returning. Gem Finder does not accept terms on the user's behalf.

## What the demo does

- Connects through OAuth with state checking and PKCE. Access tokens are encrypted in HttpOnly, SameSite cookies; the frontend receives only connection state and a CSRF token. HTTPS cookies use the `__Host-` prefix. Sessions last at most one hour; refresh tokens are discarded.
- Loads up to 300 open, unexpired contracts from the first 100 active sandbox events. Discovery returns actual `instrumentSymbol` values; no production symbol or result is automatically carried into a test order.
- Lets the user choose the market, YES/NO, 1–100 whole contracts, and a $0.01–$0.99 limit price. Where supplied, contract minimums and increments are checked again on the server.
- Shows the event, contract, available resolution description, expiry, quantity, limit price, and principal excluding fees before a separate confirmation. It does not recommend an outcome or automatically act on an analysis.
- Rechecks contract availability and terms before submitting a **buy limit order, immediate-or-cancel**. Any unmatched quantity is canceled; receipt status does not imply a complete fill. Inspect orders, fills, and positions directly in Gemini's sandbox.
- Consumes the review before calling Gemini. Concurrent duplicate confirmations cannot send the same review twice. An uncertain response is not retried; inspect Gemini history before creating another order.

## Current boundaries

This is a sandbox starter, not a production trading system. Review tokens are held in the issuing process for two minutes. A server restart or a different serverless instance safely rejects the token and requires a new review; a durable atomic store is needed for a reliable multi-instance release. The demo does not implement persistent order history, balance reconciliation, sell/cancel workflows, fees lookup, or production account onboarding. The principal shown excludes fees; Gemini enforces actual balances and permissions.

Disconnect clears the local browser session and attempts token revocation; the app does not claim that remote revocation succeeded. Revoke the app in Gemini's account settings when you want to ensure its authorization is removed. No account identifier, token, claim, or order is written to the repository or browser local storage. Gemini retains its own account/order records.

Production activation requires Gemini application review plus production-specific account eligibility, security, reconciliation, and durable order handling. Simply adding production credentials will not enable live trading in this build.

## Verification

`npm test` includes offline OAuth/cookie/CSRF checks and order-flow checks with mocked Gemini responses. The public sandbox event endpoint was checked and returned HTTP 200 with actual active/open prediction contracts on October 11, 2026. These checks do **not** establish that an account has been connected or a sandbox order accepted. End-to-end authorization and order testing require the registered sandbox app and a test account.

### Current setup status — October 11, 2026

The confidential OAuth application retains its registered name, **Pocket Quant Sandbox**, and is registered with `orders:read` and `orders:create`, the deployed callback above, and the original project icon. All four required server settings have been saved as Vercel secrets and redeployed. The deployed status endpoint returns `configured: true` and `sandbox: true`; no credentials are stored in this repository.

Gemini lists the registered app as **Pending**. A real browser attempt through Gem Finder's Connect button reached Gemini but was rejected with “The provided OAuth client is not approved with Gemini.” This is the current blocker even in the sandbox. Ask the Gemini team to approve the sandbox OAuth app, then repeat the connection through Gem Finder. No access token was obtained and no order was submitted. The local development server remains unconfigured; use the deployed page for this registration.

## Question for the Gemini team

“Our app checks financial predictions from Instagram Reels and shows the related Gemini prediction market. We saw that Gemini offers an API for placing trades. Can users connect their own Gemini account and place a trade from inside our app? Who can help us get that working for our hackathon demo?”

If asked what access is needed: “A Gemini test account and help enabling account connections for our app.” For a developer, the exact request is a confidential sandbox OAuth app with `orders:read` and `orders:create`, plus the production application approval requirements.

## Official references

- [OAuth and production application review](https://developer.gemini.com/authentication/oauth)
- [Prediction trading quickstart](https://developer.gemini.com/prediction-markets/trading-quickstart)
- [Place prediction order](https://developer.gemini.com/rest-api/prediction-markets/order-management/place-order)
- [Prediction terms status](https://developer.gemini.com/rest-api/prediction-markets/terms/get-terms-status)
- [Sandbox environment](https://developer.gemini.com/get-started/sandbox)
