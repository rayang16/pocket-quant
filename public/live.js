const byId = (id) => document.getElementById(id);
const panel = document.querySelector('.live-readiness');
const refreshButton = byId('refresh-live');
const message = byId('live-message');
const requirements = byId('live-requirements');
const ownerForm = byId('owner-form');
const ownerCode = byId('owner-code');
const ownerError = byId('owner-error');
const ownerStatus = byId('owner-status');
const tradePanel = document.querySelector('.live-trade');
const marketSelect = byId('market-select');
const outcomeInput = byId('order-outcome');
const quantityInput = byId('order-quantity');
const priceInput = byId('order-price');
const controllers = new Set();
const tradeControllers = new Set();
const requestedSymbol = new URLSearchParams(window.location.search).get('symbol');
let requestedSymbolPending = Boolean(requestedSymbol);
let checking = false;
let ownerAccessConfigured = null;
let authenticated = false;
let tradingEnabled = false;
let accountReady = false;
let csrfToken = '';
let sessionExpiresAt = 0;
let sessionTimer;
let operationVersion = 0;
let accountRequirementState;
let tradeVersion = 0;
let tradeBusy = '';
let markets = [];
let budget = null;
let preview = null;
let previewTimer;
// Submission tokens stay in memory only. The server remains authoritative after a reload.
let pendingSubmission = null;

const moneyValue = (value) => typeof value === 'string' && /^\d{1,20}\.\d{2}$/.test(value);
const money = (value) => moneyValue(value) ? `$${value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : 'Unavailable';
const dateValue = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const expiryLabel = (value) => dateValue(value) ? new Date(value).toLocaleString() : 'Not available';
const selectedMarket = () => markets.find((market) => market.symbol === marketSelect.value);
const marketConditions = (description) => description || 'Gemini did not provide additional settlement conditions. Check this contract in Gemini before trading.';

function setAccountRequirement(ready) {
  if (!accountRequirementState) return;
  accountRequirementState.textContent = ready ? 'Verified' : 'Pending';
  accountRequirementState.className = ready ? 'requirement-state is-ready' : 'requirement-state';
}

function validSession(data) {
  return data?.authenticated === true && typeof data.csrfToken === 'string' &&
    data.csrfToken.length > 0 && Number.isSafeInteger(data.sessionExpiresAt) && data.sessionExpiresAt > Date.now();
}

function validStatus(data) {
  return data && data.environment === 'production' && typeof data.tradingEnabled === 'boolean' &&
    typeof data.connected === 'boolean' && typeof data.ownerAccessConfigured === 'boolean' &&
    typeof data.authenticated === 'boolean' && (!data.authenticated || (data.ownerAccessConfigured && validSession(data))) &&
    data.budget === '5.00' && ['pending', 'oauth', 'personal'].includes(data.credentialMode) &&
    typeof data.message === 'string' && data.message.length > 0 && Array.isArray(data.requirements) &&
    data.requirements.length <= 20 && data.requirements.every((item) => item && typeof item.id === 'string' &&
      typeof item.label === 'string' && item.label.length > 0 && typeof item.ready === 'boolean');
}

function validAccount(data) {
  return data?.environment === 'production' && data.connected === true &&
    typeof data.tradingEnabled === 'boolean' && data.budget === '5.00' &&
    typeof data.account?.label === 'string' && data.account.label.length > 0 &&
    moneyValue(data.account.availableUsd) && typeof data.account.termsAccepted === 'boolean' &&
    typeof data.account.roles?.trader === 'boolean' && dateValue(data.checkedAt);
}

function validBudget(data) {
  return data && moneyValue(data.remainingUsd) && moneyValue(data.reservedUsd) &&
    Number(data.remainingUsd) <= 5 && typeof data.unresolved === 'boolean';
}

function validMarket(market) {
  return market && typeof market.symbol === 'string' && market.symbol.length > 0 &&
    typeof market.title === 'string' && market.title.length > 0 &&
    typeof market.eventTitle === 'string' && typeof market.description === 'string' &&
    dateValue(market.expiresAt);
}

function validPreview(data) {
  const order = data?.order;
  return typeof data?.previewToken === 'string' && data.previewToken.length > 0 &&
    dateValue(data.previewExpiresAt) && Date.parse(data.previewExpiresAt) > Date.now() && validMarket(order) &&
    ['yes', 'no'].includes(order.outcome?.toLowerCase()) && /^[1-9]\d{0,2}$/.test(String(order.quantity)) &&
    ['price', 'principal', 'estimatedFee', 'estimatedTotal', 'remainingBudgetUsd'].every((key) => moneyValue(order[key])) &&
    Number(order.estimatedTotal) > 0 && Number(order.estimatedTotal) <= 5 &&
    typeof order.feeNote === 'string' && typeof order.accountLabel === 'string';
}

function validOrder(order) {
  return order && typeof order.orderId === 'string' && order.orderId.length > 0 &&
    typeof order.status === 'string' && typeof order.symbol === 'string' &&
    ['yes', 'no'].includes(order.outcome?.toLowerCase()) &&
    /^\d+(?:\.\d+)?$/.test(String(order.quantity)) && /^0?\.\d+$/.test(String(order.price));
}

function clearSnapshot() {
  accountReady = false;
  setAccountRequirement(false);
  byId('private-account').hidden = true;
  for (const id of ['account-label', 'account-balance', 'account-terms', 'account-trader', 'account-checked']) byId(id).textContent = '';
  byId('live-connection').textContent = 'Not verified';
}

function renderOwnerAccess() {
  ownerForm.hidden = ownerAccessConfigured !== true || authenticated;
  byId('owner-session').hidden = !authenticated;
  byId('owner-summary').textContent = authenticated
    ? 'Private access is unlocked. Check the account, then review each real-money order before confirming it.'
    : ownerAccessConfigured === true
      ? 'Unlock to check the owner’s account and access the manual $5 live demo.'
      : ownerAccessConfigured === false
        ? 'Private owner access has not been configured. The public setup checklist is still available.'
        : 'Private access availability could not be verified. Refresh readiness to try again.';
  byId('owner-expiry').textContent = authenticated
    ? `Private access locks at ${new Date(sessionExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
    : '';
  renderTradeControls();
}

function clearPreview() {
  clearTimeout(previewTimer);
  preview = null;
  byId('order-review').hidden = true;
  byId('real-money-confirm').checked = false;
  byId('place-order').disabled = true;
  byId('place-order').textContent = 'Place real-money order';
  for (const id of ['review-event', 'review-title', 'review-description', 'review-expiry', 'review-fee-note', 'review-validity']) byId(id).textContent = '';
  byId('review-details').replaceChildren();
}

function abortTradeReads() {
  for (const controller of tradeControllers) controller.abort();
}

function clearTradeData() {
  tradeVersion += 1;
  abortTradeReads();
  clearPreview();
  markets = [];
  budget = null;
  pendingSubmission = null;
  tradeBusy = '';
  marketSelect.replaceChildren(new Option('Choose a market', ''));
  quantityInput.value = '1';
  outcomeInput.value = 'yes';
  priceInput.value = '';
  byId('market-details').hidden = true;
  for (const id of ['market-event', 'market-title', 'market-description', 'market-expiry', 'budget-remaining', 'budget-reserved', 'trade-status', 'trade-error', 'result-message']) byId(id).textContent = '';
  byId('market-link').removeAttribute('href');
  byId('market-link').hidden = true;
  byId('result-details').replaceChildren();
  byId('order-result').hidden = true;
  byId('check-order').hidden = true;
  byId('live-budget-details').hidden = true;
  renderTradeControls();
}

function clearPrivateData() {
  clearTimeout(sessionTimer);
  authenticated = false;
  csrfToken = '';
  sessionExpiresAt = 0;
  ownerCode.value = '';
  clearSnapshot();
  clearTradeData();
  renderOwnerAccess();
}

function expireSession() {
  operationVersion += 1;
  for (const controller of controllers) controller.abort();
  clearPrivateData();
  checking = false;
  finishOperation();
  ownerError.textContent = '';
  ownerStatus.textContent = 'Private access expired. Unlock again to check the account and any outstanding order.';
  byId('live-state').textContent = 'Private access locked';
  message.textContent = 'Your private session has ended. Private account and order details have been cleared.';
  message.classList.remove('is-error');
}

function setSession(data) {
  clearTimeout(sessionTimer);
  authenticated = true;
  csrfToken = data.csrfToken;
  sessionExpiresAt = data.sessionExpiresAt;
  sessionTimer = setTimeout(expireSession, Math.min(sessionExpiresAt - Date.now(), 2147483647));
  renderOwnerAccess();
}

function renderStatus(data) {
  tradingEnabled = data.tradingEnabled;
  byId('live-state').textContent = data.tradingEnabled ? 'Review flow available' : 'Setup pending';
  message.textContent = data.message;
  message.classList.remove('is-error');
  byId('live-connection').textContent = data.connected ? 'Connection reported' : 'Not connected';
  byId('live-method').textContent = { pending: 'Not chosen yet', oauth: 'Gemini sign-in (your own account)', personal: 'Personal key (private owner access)' }[data.credentialMode];
  requirements.replaceChildren();
  accountRequirementState = undefined;
  for (const item of data.requirements) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    const state = document.createElement('span');
    label.textContent = item.label;
    const reviewFlow = ['verification', 'review', 'order-review'].includes(item.id);
    const ready = item.id === 'account' ? false : reviewFlow ? data.tradingEnabled : item.ready;
    state.textContent = ready ? (reviewFlow ? 'Available' : ['credentials', 'storage'].includes(item.id) ? 'Added' : 'Verified') : 'Pending';
    state.className = ready ? 'requirement-state is-ready' : 'requirement-state';
    if (item.id === 'account') accountRequirementState = state;
    row.append(label, state);
    requirements.append(row);
  }
  byId('live-checked').textContent = `Checked at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Refresh after completing setup.`;
}

function renderTradeControls() {
  const available = authenticated && tradingEnabled && accountReady;
  const locked = !available || checking || Boolean(tradeBusy) || Boolean(pendingSubmission) || !budget || budget.unresolved || Number(budget.remainingUsd) <= 0;
  byId('trade-workspace').hidden = !available;
  byId('trade-locked').hidden = available;
  byId('trade-locked').textContent = !authenticated
    ? 'Unlock private access and verify the account to choose a market.'
    : !tradingEnabled ? 'The live order flow is not configured yet. Account checks remain available.'
      : 'Verify account access, accepted terms, and trader permission before choosing a market.';
  marketSelect.disabled = locked;
  byId('order-inputs').disabled = locked || !selectedMarket();
  byId('preview-order').disabled = locked || !selectedMarket();
  byId('preview-order').textContent = tradeBusy === 'preview' ? 'Preparing review…' : 'Review real-money order';
  byId('refresh-markets').disabled = !available || checking || Boolean(tradeBusy) || Boolean(pendingSubmission);
  byId('refresh-markets').textContent = tradeBusy === 'markets' ? 'Loading markets…' : 'Refresh markets';
  byId('real-money-confirm').disabled = locked || !preview;
  byId('place-order').disabled = locked || !preview || !byId('real-money-confirm').checked || Date.parse(preview.previewExpiresAt) <= Date.now();
  byId('check-order').disabled = !authenticated || checking || Boolean(tradeBusy);
  refreshButton.disabled = checking || tradeBusy === 'submit';
  tradePanel.setAttribute('aria-busy', tradeBusy ? 'true' : 'false');
}

function renderBudget(data) {
  budget = data;
  byId('live-budget-details').hidden = false;
  byId('budget-remaining').textContent = money(data.remainingUsd);
  byId('budget-reserved').textContent = money(data.reservedUsd);
  renderTradeControls();
}

function beginOperation(label) {
  checking = true;
  operationVersion += 1;
  tradeVersion += 1;
  abortTradeReads();
  tradeBusy = '';
  clearPreview();
  refreshButton.disabled = true;
  byId('unlock-owner').disabled = true;
  byId('logout-owner').disabled = true;
  ownerCode.disabled = true;
  refreshButton.textContent = label;
  panel.setAttribute('aria-busy', 'true');
  ownerCode.removeAttribute('aria-invalid');
  ownerError.textContent = '';
  ownerStatus.textContent = '';
  clearSnapshot();
  renderTradeControls();
  return operationVersion;
}

function finishOperation() {
  panel.setAttribute('aria-busy', 'false');
  byId('unlock-owner').disabled = false;
  byId('logout-owner').disabled = false;
  ownerCode.disabled = false;
  refreshButton.textContent = 'Refresh readiness';
  checking = false;
  renderTradeControls();
}

async function request(action, { method = 'GET', body, token = csrfToken, query = {} } = {}) {
  const controller = new AbortController();
  controllers.add(controller);
  if (['markets', 'preview', 'result'].includes(action)) tradeControllers.add(controller);
  const timeout = ['preview', 'submit', 'markets'].includes(action) ? 90000 : action === 'account' ? 55000 : 15000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`/api/live-trade?${new URLSearchParams({ action, ...query })}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(action === 'login' ? {} : { 'X-CSRF-Token': token }) } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error.slice(0, 500) : 'The request could not be completed.');
      error.status = response.status;
      error.code = data?.code;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
    tradeControllers.delete(controller);
  }
}

function showOwnerError(error, fallback) {
  clearSnapshot();
  if (error.status === 401) {
    clearPrivateData();
    ownerError.textContent = 'Private access is locked or has expired. Enter your owner access code again.';
  } else ownerError.textContent = error.status ? error.message : fallback;
  renderTradeControls();
}

function showTradeError(error, fallback) {
  if (error.status === 401) {
    clearPrivateData();
    ownerError.textContent = 'Private access is locked or has expired. Unlock again to check any outstanding order.';
  } else {
    byId('trade-error').textContent = error.status ? error.message : fallback;
    if (error.code === 'LIVE_TRADE_UNRESOLVED_SUBMISSION') {
      if (budget) budget = { ...budget, unresolved: true };
      else budget = null;
      showUnresolved();
    }
  }
}

async function refreshReadiness(version) {
  const data = await request('status');
  if (version !== operationVersion) return;
  if (!validStatus(data)) throw new Error('Readiness response could not be verified');
  ownerAccessConfigured = data.ownerAccessConfigured;
  if (data.authenticated) setSession(data);
  else clearPrivateData();
  renderStatus(data);
  renderOwnerAccess();
  if (!authenticated) return;
  ownerStatus.textContent = 'Checking the private account…';
  try {
    const snapshot = await request('account');
    if (version !== operationVersion || !authenticated) return;
    if (Date.now() >= sessionExpiresAt) { expireSession(); return; }
    if (!validAccount(snapshot)) throw new Error('Account response could not be verified');
    tradingEnabled = snapshot.tradingEnabled;
    byId('account-label').textContent = snapshot.account.label;
    byId('account-balance').textContent = `${money(snapshot.account.availableUsd)} USD`;
    byId('account-terms').textContent = snapshot.account.termsAccepted ? 'Accepted' : 'Not accepted';
    byId('account-trader').textContent = snapshot.account.roles.trader ? 'Present' : 'Not present';
    byId('account-checked').textContent = `Account checked ${new Date(snapshot.checkedAt).toLocaleString()}. Available USD is a snapshot.`;
    byId('private-account').hidden = false;
    setAccountRequirement(true);
    accountReady = snapshot.account.termsAccepted && snapshot.account.roles.trader;
    byId('live-connection').textContent = 'Verified for this account check';
    byId('live-state').textContent = 'Account checked';
    message.textContent = tradingEnabled
      ? 'Account check complete. Each real-money order requires a separate review and your confirmation.'
      : 'Account check complete. The live order flow is not configured yet.';
    ownerStatus.textContent = 'Account snapshot verified.';
    renderTradeControls();
    if (tradingEnabled && accountReady) await loadMarkets();
  } catch (error) {
    if (version !== operationVersion) return;
    ownerStatus.textContent = '';
    showOwnerError(error, 'The private account could not be verified. Refresh to try again.');
  }
}

function showReadinessError(error) {
  clearPrivateData();
  requirements.replaceChildren();
  byId('live-state').textContent = 'Could not check';
  byId('live-method').textContent = 'Not verified';
  byId('live-checked').textContent = '';
  message.textContent = 'We couldn’t check readiness. Refresh to try again. No connection, balance, or trading access has been confirmed.';
  message.classList.add('is-error');
  if (error.status) showOwnerError(error, 'Private access could not be verified.');
}

async function loadReadiness() {
  if (checking || tradeBusy === 'submit') return;
  const version = beginOperation('Checking readiness…');
  byId('live-state').textContent = 'Checking';
  message.textContent = 'Checking what’s ready for your live demo…';
  message.classList.remove('is-error');
  try { await refreshReadiness(version); }
  catch (error) { if (version === operationVersion) showReadinessError(error); }
  finally { if (version === operationVersion) finishOperation(); }
}

async function loadMarkets() {
  if (!authenticated || !tradingEnabled || !accountReady || tradeBusy === 'submit') return;
  const version = ++tradeVersion;
  abortTradeReads();
  clearPreview();
  tradeBusy = 'markets';
  budget = null;
  markets = [];
  marketSelect.replaceChildren(new Option('Choose a market', ''));
  byId('market-details').hidden = true;
  priceInput.value = '';
  byId('trade-error').textContent = '';
  byId('trade-status').textContent = 'Loading available markets and checking the remaining demo budget…';
  renderTradeControls();
  try {
    const data = await request('markets');
    if (version !== tradeVersion || !authenticated) return;
    if (!Array.isArray(data.markets) || !data.markets.every(validMarket) || !validBudget(data.budget)) throw new Error('Markets response could not be verified');
    markets = data.markets;
    marketSelect.replaceChildren(new Option('Choose a market', ''), ...markets.map((market) => new Option(`${market.eventTitle ? `${market.eventTitle} — ` : ''}${market.title}`, market.symbol)));
    renderBudget(data.budget);
    byId('trade-status').textContent = data.budget.unresolved || pendingSubmission
      ? 'An order needs to be resolved. New orders are locked. Check order status and your Gemini order history before proceeding.'
      : Number(data.budget.remainingUsd) <= 0
        ? 'The $5 demo budget is fully reserved. No further orders are available.'
        : markets.length ? 'Markets loaded. Choose a market and the YES or NO outcome you want to buy.' : 'No eligible markets are available right now. Refresh to check again.';
    if (data.budget.unresolved && !pendingSubmission) showUnresolved();
    if (requestedSymbolPending && !data.budget.unresolved && !pendingSubmission) {
      const requestedMarket = markets.find((market) => market.symbol === requestedSymbol);
      if (requestedMarket) {
        marketSelect.value = requestedMarket.symbol;
        requestedSymbolPending = false;
        renderMarket();
        byId('trade-status').textContent = 'The market from your report is selected. Read its full conditions, choose YES or NO, and review the order when ready.';
      } else {
        byId('trade-status').textContent = 'The market from your report is not currently available for this live demo. Refresh markets or choose another eligible market.';
      }
    }
  } catch (error) {
    if (version !== tradeVersion) return;
    byId('trade-status').textContent = '';
    showTradeError(error, 'Markets and budget could not be verified. Refresh markets to try again.');
  } finally {
    if (version === tradeVersion) { tradeBusy = ''; renderTradeControls(); }
  }
}

function prefillPrice() {
  const market = selectedMarket();
  const ask = outcomeInput.value === 'yes' ? market?.yesAsk : market?.noAsk;
  const numeric = ask === null || ask === '' || ask === undefined ? NaN : Number(ask);
  priceInput.value = Number.isFinite(numeric) && numeric > 0 && numeric < 1 && Math.abs(numeric * 100 - Math.round(numeric * 100)) < 1e-8 ? numeric.toFixed(2) : '';
}

function renderMarket() {
  const market = selectedMarket();
  byId('market-details').hidden = !market;
  if (!market) { priceInput.value = ''; renderTradeControls(); return; }
  byId('market-event').textContent = market.eventTitle;
  byId('market-title').textContent = market.title;
  byId('market-description').textContent = marketConditions(market.description);
  byId('market-expiry').textContent = `Market expiry: ${expiryLabel(market.expiresAt)}`;
  const link = byId('market-link');
  link.hidden = true;
  link.removeAttribute('href');
  try {
    const url = new URL(market.marketUrl);
    if (url.protocol === 'https:' && (url.hostname === 'gemini.com' || url.hostname.endsWith('.gemini.com'))) { link.href = url.href; link.hidden = false; }
  } catch { /* An optional market link is displayed only when verified. */ }
  prefillPrice();
  renderTradeControls();
}

function appendDetail(container, label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value;
  row.append(term, description);
  container.append(row);
}

function renderPreview(data) {
  clearPreview();
  preview = data;
  const order = data.order;
  byId('review-event').textContent = order.eventTitle;
  byId('review-title').textContent = order.title;
  byId('review-description').textContent = marketConditions(order.description);
  byId('review-expiry').textContent = `Market expiry: ${expiryLabel(order.expiresAt)}`;
  const details = byId('review-details');
  for (const [label, value] of [
    ['Account', order.accountLabel], ['Market symbol', order.symbol], ['Order', `BUY ${order.outcome.toUpperCase()} · Limit · IOC`],
    ['Whole contracts', String(order.quantity)], ['Limit price per contract', money(order.price)], ['Order cost at limit', money(order.principal)],
    ['Fee allowance', money(order.estimatedFee)], ['Maximum reserved spend', money(order.estimatedTotal)], ['Remaining demo budget before order', money(order.remainingBudgetUsd)],
  ]) appendDetail(details, label, value);
  byId('review-fee-note').textContent = order.feeNote;
  byId('review-validity').textContent = `Review expires at ${new Date(data.previewExpiresAt).toLocaleTimeString()}. Any change requires a new review.`;
  byId('place-order').textContent = `Place real-money order · ${money(order.estimatedTotal)} max`;
  byId('order-review').hidden = false;
  previewTimer = setTimeout(() => {
    if (preview !== data) return;
    clearPreview();
    byId('trade-status').textContent = 'Your review expired. Review the order again before confirming.';
    renderTradeControls();
  }, Math.max(0, Date.parse(data.previewExpiresAt) - Date.now()));
  byId('order-review').focus();
}

function invalidateOrder() {
  if (pendingSubmission) return;
  tradeVersion += 1;
  abortTradeReads();
  if (tradeBusy === 'preview') tradeBusy = '';
  clearPreview();
  byId('trade-error').textContent = '';
  renderTradeControls();
}

function showUnresolved() {
  byId('order-result').hidden = false;
  byId('result-heading').textContent = 'Order needs a status check';
  byId('result-message').textContent = 'The order outcome is not confirmed. Do not place it again. New orders are locked while this is unresolved. Check Gemini order history for fills or cancellations.';
  byId('check-order').hidden = !pendingSubmission;
  renderTradeControls();
}

function renderOrder(order) {
  byId('order-result').hidden = false;
  byId('result-heading').textContent = 'Gemini order response';
  byId('result-details').replaceChildren();
  for (const [label, value] of [
    ['Order ID', order.orderId], ['Status reported by Gemini', order.status], ['Market symbol', order.symbol],
    ['Outcome', `BUY ${order.outcome.toUpperCase()}`], ['Requested contracts', String(order.quantity)], ['Limit price (USD)', String(order.price)],
  ]) appendDetail(byId('result-details'), label, value);
  if (order.filledQuantity !== undefined) appendDetail(byId('result-details'), 'Filled contracts', String(order.filledQuantity));
  if (order.remainingQuantity !== undefined) appendDetail(byId('result-details'), 'Remaining contracts', String(order.remainingQuantity));
  byId('result-message').textContent = 'Gemini returned the order status shown here. Verify final fills and charges in your Gemini order history. The demo keeps its maximum reservation counted toward the $5 limit.';
  byId('check-order').hidden = true;
  byId('order-result').focus();
}

const uncertainResult = (data) => ['unknown', 'submitting'].includes(data?.status) || ['UNKNOWN_RESULT', 'ORDER_IN_PROGRESS'].includes(data?.code);

async function acceptSubmissionResult(data) {
  if (uncertainResult(data)) { showUnresolved(); return; }
  if (data?.status === 'rejected') {
    pendingSubmission = null;
    byId('order-result').hidden = false;
    byId('result-heading').textContent = 'Order rejected';
    byId('result-message').textContent = 'The server reports that this order was rejected. Review Gemini order history if you need to verify its status. A new order requires a new review.';
    byId('check-order').hidden = true;
    tradeBusy = '';
    await loadMarkets();
    return;
  }
  if (!validOrder(data?.order)) { showUnresolved(); return; }
  pendingSubmission = null;
  renderOrder(data.order);
  tradeBusy = '';
  // Re-fetch authoritative budget; absent or failed budget data must keep ordering disabled.
  await loadMarkets();
}

byId('order-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (byId('preview-order').disabled || !byId('order-form').reportValidity()) return;
  const market = selectedMarket();
  if (!market) return;
  const inputs = { symbol: market.symbol, outcome: outcomeInput.value, quantity: quantityInput.value, price: priceInput.value };
  const version = ++tradeVersion;
  clearPreview();
  tradeBusy = 'preview';
  byId('trade-error').textContent = '';
  byId('trade-status').textContent = 'Checking the order, balance, and remaining budget. No order has been submitted.';
  renderTradeControls();
  try {
    const data = await request('preview', { method: 'POST', body: inputs });
    if (version !== tradeVersion || !authenticated) return;
    if (!validPreview(data) || data.order.symbol !== inputs.symbol || data.order.outcome.toLowerCase() !== inputs.outcome || Number(data.order.quantity) !== Number(inputs.quantity) || Number(data.order.price) !== Number(inputs.price)) throw new Error('Order review did not match the request');
    renderPreview(data);
    byId('trade-status').textContent = 'Review ready. Nothing has been submitted. Read the conditions and confirm only if you want this real-money order.';
  } catch (error) {
    if (version !== tradeVersion) return;
    byId('trade-status').textContent = '';
    showTradeError(error, 'The order review could not be verified. No order was submitted. Review again to try again.');
  } finally {
    if (version === tradeVersion) { tradeBusy = ''; renderTradeControls(); }
  }
});

byId('place-order').addEventListener('click', async () => {
  if (byId('place-order').disabled || !preview || !authenticated || pendingSubmission || !byId('real-money-confirm').checked) return;
  if (Date.parse(preview.previewExpiresAt) <= Date.now()) { clearPreview(); renderTradeControls(); return; }
  const token = preview.previewToken;
  const version = ++tradeVersion;
  // Lock immediately, before making the only submission request for this confirmation.
  pendingSubmission = { token };
  tradeBusy = 'submit';
  clearPreview();
  byId('trade-error').textContent = '';
  byId('trade-status').textContent = 'Submitting your confirmed real-money order. Do not submit it again.';
  byId('order-result').hidden = false;
  byId('result-heading').textContent = 'Order submission in progress';
  byId('result-details').replaceChildren();
  byId('result-message').textContent = 'Waiting for Gemini’s response. This order may already be processing.';
  byId('check-order').hidden = true;
  renderTradeControls();
  try {
    const data = await request('submit', { method: 'POST', body: { previewToken: token, confirmed: true } });
    if (version !== tradeVersion || !authenticated) return;
    await acceptSubmissionResult(data);
  } catch (error) {
    if (version !== tradeVersion) return;
    if (error.status === 401) { showTradeError(error, 'Private access expired.'); return; }
    if (!error.status || error.status >= 500 || uncertainResult(error)) showUnresolved();
    else {
      pendingSubmission = null;
      byId('order-result').hidden = true;
      byId('trade-status').textContent = '';
      showTradeError(error, 'The submission was rejected. Review again before placing an order.');
    }
  } finally {
    if (version === tradeVersion) { tradeBusy = ''; renderTradeControls(); }
  }
});

byId('check-order').addEventListener('click', async () => {
  if (!pendingSubmission || tradeBusy || checking || !authenticated) return;
  const token = pendingSubmission.token;
  const version = ++tradeVersion;
  tradeBusy = 'result';
  byId('trade-error').textContent = '';
  byId('result-message').textContent = 'Checking the existing order. This does not submit another order.';
  renderTradeControls();
  try {
    const data = await request('result', { query: { previewToken: token } });
    if (version !== tradeVersion || !authenticated) return;
    await acceptSubmissionResult(data);
  } catch (error) {
    if (version !== tradeVersion) return;
    if (error.status === 401) showTradeError(error, 'Private access expired.');
    else { showUnresolved(); byId('trade-error').textContent = 'Order status could not be checked. New orders remain locked. Check Gemini order history.'; }
  } finally {
    if (version === tradeVersion) { tradeBusy = ''; renderTradeControls(); }
  }
});

marketSelect.addEventListener('change', () => { requestedSymbolPending = false; invalidateOrder(); renderMarket(); });
outcomeInput.addEventListener('change', () => { invalidateOrder(); prefillPrice(); });
quantityInput.addEventListener('input', invalidateOrder);
priceInput.addEventListener('input', invalidateOrder);
byId('real-money-confirm').addEventListener('change', renderTradeControls);
byId('refresh-markets').addEventListener('click', () => { if (!byId('refresh-markets').disabled) loadMarkets(); });

ownerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (checking || ownerAccessConfigured !== true || authenticated || !ownerForm.reportValidity()) return;
  const code = ownerCode.value;
  ownerCode.value = '';
  const version = beginOperation('Unlocking private access…');
  try {
    const data = await request('login', { method: 'POST', body: { code } });
    if (version !== operationVersion) return;
    if (!validSession(data)) throw new Error('Private session could not be verified');
    setSession(data);
    await refreshReadiness(version);
    if (version === operationVersion && !authenticated && !ownerError.textContent) ownerError.textContent = 'Private access could not be confirmed. Enter your owner access code again.';
  } catch (error) {
    if (version !== operationVersion) return;
    clearPrivateData();
    showOwnerError(error, 'Private access could not be verified. Enter your code and try again.');
    if (error.status === 401) { ownerError.textContent = error.message; ownerCode.setAttribute('aria-invalid', 'true'); }
  } finally {
    ownerCode.value = '';
    if (version === operationVersion) {
      finishOperation();
      if (authenticated) byId('logout-owner').focus();
      else if (!ownerForm.hidden) ownerCode.focus();
    }
  }
});

byId('logout-owner').addEventListener('click', async () => {
  if (checking || !authenticated) return;
  const token = csrfToken;
  const version = beginOperation('Locking private access…');
  for (const controller of controllers) controller.abort();
  clearPrivateData();
  byId('live-state').textContent = 'Private access locked';
  message.textContent = 'Private account and order details have been cleared. Check Gemini order history for any order already submitted.';
  message.classList.remove('is-error');
  try {
    await request('logout', { method: 'POST', token });
    if (version === operationVersion) ownerStatus.textContent = 'Private access is locked. Account and order details have been cleared.';
  } catch (error) {
    if (version !== operationVersion) return;
    ownerError.textContent = error.status === 401 ? 'Private access has already expired. Private details have been cleared.'
      : 'Private details have been cleared here, but locking the session could not be confirmed. Unlock and try locking again.';
  } finally { if (version === operationVersion) finishOperation(); }
});

refreshButton.addEventListener('click', loadReadiness);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && authenticated && Date.now() >= sessionExpiresAt) expireSession();
});
window.addEventListener('pagehide', () => {
  operationVersion += 1;
  for (const controller of controllers) controller.abort();
  clearPrivateData();
  ownerStatus.textContent = '';
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { checking = false; loadReadiness(); }
});
loadReadiness();
