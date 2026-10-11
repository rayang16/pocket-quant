const byId = (id) => document.getElementById(id);
const accountStatus = byId('account-status');
const connectButton = byId('connect-account');
const disconnectButton = byId('disconnect-account');
const refreshButton = byId('refresh-account');
const workspace = byId('trade-workspace');
const fields = byId('order-fields');
const form = byId('trade-form');
const marketSelect = byId('market');
const quantityInput = byId('quantity');
const priceInput = byId('limit-price');
const previewButton = byId('preview-order');
const submitButton = byId('submit-order');
const confirmation = byId('confirm-order');
const tradeStatus = byId('trade-status');
const reloadButton = byId('reload-markets');
let csrfToken = '';
let markets = [];
let preview = null;
let previewTimer;
let busy = false;

function text(id, value) {
  byId(id).textContent = value == null ? '' : String(value);
}

function money(value) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value));
}

function date(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function message(value = '', { error = false, history = false } = {}) {
  tradeStatus.textContent = value;
  tradeStatus.classList.toggle('is-error', error);
  if (history) {
    const link = document.createElement('a');
    link.href = 'https://exchange.sandbox.gemini.com/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Check Gemini sandbox order history ↗';
    tradeStatus.append(link);
  }
}

function invalidatePreview() {
  clearTimeout(previewTimer);
  preview = null;
  confirmation.checked = false;
  submitButton.disabled = true;
  byId('order-review').hidden = true;
  byId('review-empty').hidden = !byId('order-receipt').hidden;
}

function setBusy(value) {
  busy = value;
  fields.disabled = value || markets.length === 0;
  disconnectButton.disabled = value;
  refreshButton.disabled = value;
  reloadButton.disabled = value;
  confirmation.disabled = value;
  byId('edit-order').disabled = value;
  submitButton.disabled = value || !preview || !confirmation.checked;
}

async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    let data;
    try { data = await response.json(); } catch {
      const error = new Error('The sandbox returned an unreadable response.');
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : 'The sandbox request could not be completed.');
      error.code = data.code;
      error.status = response.status;
      throw error;
    }
    if (data.sandbox !== true) throw new Error('The sandbox could not be verified. Please refresh the connection.');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function showError(error) {
  byId('terms-notice').hidden = error.code !== 'TERMS_REQUIRED';
  message(error.name === 'AbortError' ? 'The sandbox took too long to respond. You can try again.' : error.message || 'The sandbox could not be reached. Please try again.', { error: true });
}

function showMarket() {
  const market = markets.find((item) => item.symbol === marketSelect.value);
  byId('market-details').hidden = !market;
  if (!market) return;
  text('market-event', market.eventTitle);
  text('market-symbol', market.symbol);
  text('market-expiry', date(market.expiresAt) ? `Market expiry: ${date(market.expiresAt)}` : 'Market expiry unavailable. Review the market on Gemini.');
  text('yes-ask', money(market.yesAsk));
  text('no-ask', money(market.noAsk));
}

async function loadMarkets() {
  if (busy) return;
  invalidatePreview();
  markets = [];
  marketSelect.replaceChildren(new Option('Loading sandbox markets…', ''));
  byId('market-details').hidden = true;
  reloadButton.hidden = true;
  setBusy(true);
  try {
    const data = await api('/api/gemini-trade?action=markets');
    if (!Array.isArray(data.markets)) throw new Error('The sandbox market list could not be read.');
    markets = data.markets.filter((market) => market && typeof market.symbol === 'string' && typeof market.title === 'string');
    marketSelect.replaceChildren(new Option(markets.length ? 'Choose a sandbox market' : 'No sandbox markets available', ''));
    for (const market of markets) marketSelect.append(new Option(market.title, market.symbol));
    if (!markets.length) message('No prediction markets are currently available in this sandbox. You can check again later.');
    else message();
  } catch (error) {
    marketSelect.replaceChildren(new Option('Sandbox markets unavailable', ''));
    showError(error);
  } finally {
    reloadButton.hidden = false;
    setBusy(false);
  }
}

async function loadAccount() {
  if (busy) return;
  invalidatePreview();
  workspace.hidden = true;
  connectButton.hidden = true;
  disconnectButton.hidden = true;
  csrfToken = '';
  accountStatus.textContent = 'Checking connection…';
  setBusy(true);
  let connected = false;
  try {
    const data = await api('/api/gemini-account?action=status');
    if (data.connected === true && typeof data.csrfToken === 'string' && data.csrfToken) {
      csrfToken = data.csrfToken;
      connected = true;
      accountStatus.textContent = 'Connected to Gemini sandbox. Your orders use test funds.';
      disconnectButton.hidden = false;
      workspace.hidden = false;
    } else if (data.configured === true) {
      accountStatus.textContent = 'Connect a Gemini sandbox account to choose a market and review a test order.';
      connectButton.hidden = false;
    } else {
      accountStatus.textContent = 'Awaiting Gemini sandbox setup. Account connection will be available once the app is registered and configured.';
    }
  } catch {
    accountStatus.textContent = 'We could not check the sandbox connection. Refresh to try again.';
  } finally {
    refreshButton.hidden = false;
    setBusy(false);
  }
  if (connected) await loadMarkets();
}

function renderPreview(data) {
  const order = data.order;
  if (!order || typeof data.previewToken !== 'string' || !data.previewToken || !['yes', 'no'].includes(order.outcome) || !order.symbol || !Number.isFinite(Number(order.quantity)) || !Number.isFinite(Number(order.price)) || !Number.isFinite(Number(order.notional))) {
    throw new Error('The order could not be reviewed. Please request a fresh review.');
  }
  preview = { token: data.previewToken };
  text('review-event', order.eventTitle);
  text('review-title', order.title);
  text('review-symbol', order.symbol);
  text('review-description', order.description);
  byId('review-description').hidden = !order.description;
  text('review-outcome', `Buy ${order.outcome.toUpperCase()} · Immediate-or-cancel limit`);
  text('review-quantity', order.quantity);
  text('review-price', money(order.price));
  text('review-notional', money(order.notional));
  text('review-expiry', date(order.expiresAt));
  byId('review-expiry-row').hidden = !date(order.expiresAt);
  const expiresAt = data.previewExpiresAt ? new Date(data.previewExpiresAt).getTime() : Date.now() + 120000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    invalidatePreview();
    throw new Error('This review has expired. Please review your order again.');
  }
  text('preview-expiry', `Review valid until ${new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.`);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!preview) return;
    invalidatePreview();
    message('Your order review expired. Review it again to see the latest details.');
  }, Math.min(expiresAt - Date.now(), 120000));
  byId('review-empty').hidden = true;
  byId('order-receipt').hidden = true;
  byId('order-review').hidden = false;
  confirmation.checked = false;
  byId('review-heading').focus({ preventScroll: true });
  byId('review-heading').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}

form.addEventListener('input', () => { if (!busy) invalidatePreview(); });
form.addEventListener('change', () => { if (!busy) invalidatePreview(); });
marketSelect.addEventListener('change', showMarket);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !csrfToken || !form.reportValidity()) return;
  invalidatePreview();
  message();
  byId('terms-notice').hidden = true;
  setBusy(true);
  previewButton.textContent = 'Preparing review…';
  try {
    const data = await api('/api/gemini-trade?action=preview', {
      csrfToken,
      symbol: marketSelect.value,
      outcome: form.querySelector('input[name="outcome"]:checked')?.value,
      quantity: quantityInput.value,
      price: priceInput.value,
    });
    renderPreview(data);
  } catch (error) {
    invalidatePreview();
    showError(error);
  } finally {
    previewButton.textContent = 'Review test order →';
    setBusy(false);
  }
});

confirmation.addEventListener('change', () => { submitButton.disabled = busy || !preview || !confirmation.checked; });
byId('edit-order').addEventListener('click', () => {
  if (busy) return;
  invalidatePreview();
  marketSelect.focus();
});

submitButton.addEventListener('click', async () => {
  if (busy || !preview || !confirmation.checked || !csrfToken) return;
  const token = preview.token;
  preview = null;
  clearTimeout(previewTimer);
  setBusy(true);
  submitButton.textContent = 'Submitting test order…';
  message();
  try {
    const data = await api('/api/gemini-trade?action=submit', { csrfToken, previewToken: token, confirmed: true });
    if (!data.order || !data.order.orderId) throw new Error('The order response could not be read.');
    const order = data.order;
    text('receipt-id', order.orderId);
    text('receipt-status', order.status || 'Submitted — check Gemini for the latest status');
    text('receipt-symbol', order.symbol);
    text('receipt-outcome', ['yes', 'no'].includes(order.outcome) ? `Buy ${order.outcome.toUpperCase()}` : 'Buy');
    text('receipt-quantity', order.quantity);
    text('receipt-price', money(order.price));
    byId('order-receipt').hidden = false;
    message('Your test order was submitted. Review its current status in Gemini sandbox.');
  } catch (error) {
    if (error.code === 'UNKNOWN_RESULT' || !error.status || error.status >= 500) {
      message('We could not confirm whether Gemini received this order. Do not submit it again until you check your Gemini sandbox order history. A fresh review is required for any new order.', { error: true, history: true });
    } else showError(error);
  } finally {
    invalidatePreview();
    submitButton.textContent = 'Submit test order ↗';
    setBusy(false);
  }
});

disconnectButton.addEventListener('click', async () => {
  if (busy || !csrfToken) return;
  setBusy(true);
  invalidatePreview();
  try {
    await api('/api/gemini-account?action=disconnect', { csrfToken });
    csrfToken = '';
    markets = [];
    workspace.hidden = true;
    byId('order-receipt').hidden = true;
    message();
  } catch (error) {
    accountStatus.textContent = 'We could not confirm the disconnect. Refresh the connection to check its status.';
    setBusy(false);
    return;
  }
  setBusy(false);
  await loadAccount();
});

refreshButton.addEventListener('click', loadAccount);
reloadButton.addEventListener('click', loadMarkets);

const url = new URL(location.href);
if (url.searchParams.has('connection')) {
  const success = url.searchParams.get('connection') === 'success';
  const notice = byId('connection-notice');
  notice.textContent = success ? 'You returned from Gemini. Your sandbox connection status is shown below.' : 'Your Gemini connection was not completed. You can try connecting again.';
  notice.hidden = false;
  url.searchParams.delete('connection');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

await loadAccount();
