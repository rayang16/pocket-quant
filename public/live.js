const byId = (id) => document.getElementById(id);
const panel = document.querySelector('.live-readiness');
const refreshButton = byId('refresh-live');
const message = byId('live-message');
const requirements = byId('live-requirements');
const ownerForm = byId('owner-form');
const ownerCode = byId('owner-code');
const ownerError = byId('owner-error');
const ownerStatus = byId('owner-status');
let checking = false;
let ownerAccessConfigured = null;
let authenticated = false;
let csrfToken = '';
let sessionExpiresAt = 0;
let sessionTimer;
let activeController;
let operationVersion = 0;
let accountRequirementState;

function setAccountRequirement(ready) {
  if (!accountRequirementState) return;
  accountRequirementState.textContent = ready ? 'Verified' : 'Pending';
  accountRequirementState.className = ready ? 'requirement-state is-ready' : 'requirement-state';
}

function validSession(data) {
  return data?.authenticated === true && typeof data.csrfToken === 'string' &&
    data.csrfToken.length > 0 && Number.isSafeInteger(data.sessionExpiresAt) &&
    data.sessionExpiresAt > Date.now();
}

function validStatus(data) {
  return data && data.environment === 'production' &&
    typeof data.tradingEnabled === 'boolean' && typeof data.connected === 'boolean' &&
    typeof data.ownerAccessConfigured === 'boolean' && typeof data.authenticated === 'boolean' &&
    (!data.authenticated || (data.ownerAccessConfigured && validSession(data))) &&
    data.budget === '5.00' && ['pending', 'oauth', 'personal'].includes(data.credentialMode) &&
    typeof data.message === 'string' && data.message.length > 0 &&
    Array.isArray(data.requirements) && data.requirements.length <= 20 &&
    data.requirements.every((item) => item && typeof item.id === 'string' &&
      typeof item.label === 'string' && item.label.length > 0 && typeof item.ready === 'boolean');
}

function validAccount(data) {
  return data?.environment === 'production' && data.connected === true &&
    data.tradingEnabled === false && data.budget === '5.00' &&
    typeof data.account?.label === 'string' && data.account.label.length > 0 &&
    typeof data.account.availableUsd === 'string' && /^\d{1,20}\.\d{2}$/.test(data.account.availableUsd) &&
    typeof data.account.termsAccepted === 'boolean' && typeof data.account.roles?.trader === 'boolean' &&
    typeof data.checkedAt === 'string' && Number.isFinite(Date.parse(data.checkedAt));
}

function clearSnapshot() {
  setAccountRequirement(false);
  byId('private-account').hidden = true;
  for (const id of ['account-label', 'account-balance', 'account-terms', 'account-trader', 'account-checked']) {
    byId(id).textContent = '';
  }
  byId('live-connection').textContent = 'Not verified';
}

function renderOwnerAccess() {
  ownerForm.hidden = ownerAccessConfigured !== true || authenticated;
  byId('owner-session').hidden = !authenticated;
  byId('owner-summary').textContent = authenticated
    ? 'Private access is unlocked for a read-only account check. Orders remain unavailable.'
    : ownerAccessConfigured === true
      ? 'Unlock to check the owner’s Gemini account, available USD, and account permissions. Orders remain unavailable.'
      : ownerAccessConfigured === false
        ? 'Private owner access has not been configured. The public setup checklist is still available.'
        : 'Private access availability could not be verified. Refresh readiness to try again.';
  byId('owner-expiry').textContent = authenticated
    ? `Private access locks at ${new Date(sessionExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
    : '';
}

function clearPrivateData() {
  clearTimeout(sessionTimer);
  authenticated = false;
  csrfToken = '';
  sessionExpiresAt = 0;
  ownerCode.value = '';
  clearSnapshot();
  renderOwnerAccess();
}

function expireSession() {
  operationVersion += 1;
  activeController?.abort();
  clearPrivateData();
  ownerError.textContent = '';
  ownerStatus.textContent = 'Private access expired. Enter your owner access code to check the account again.';
  byId('live-state').textContent = 'Private access locked';
  message.textContent = 'Your private session has ended. Orders remain unavailable.';
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
  byId('live-state').textContent = 'Setup pending';
  message.textContent = data.message;
  message.classList.remove('is-error');
  byId('live-connection').textContent = data.connected ? 'Connection reported' : 'Not connected';
  byId('live-method').textContent = {
    pending: 'Not chosen yet',
    oauth: 'Gemini sign-in (your own account)',
    personal: 'Personal key (private owner access)',
  }[data.credentialMode];
  requirements.replaceChildren();
  accountRequirementState = undefined;
  for (const item of data.requirements) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    const state = document.createElement('span');
    label.textContent = item.label;
    const ready = item.id === 'account' ? false : item.ready;
    state.textContent = ready ? (['credentials', 'storage'].includes(item.id) ? 'Added' : 'Verified') : 'Pending';
    state.className = ready ? 'requirement-state is-ready' : 'requirement-state';
    if (item.id === 'account') accountRequirementState = state;
    row.append(label, state);
    requirements.append(row);
  }
  byId('live-checked').textContent = `Checked at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Refresh after completing setup.`;
}

function beginOperation(label) {
  checking = true;
  operationVersion += 1;
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
  return operationVersion;
}

function finishOperation() {
  panel.setAttribute('aria-busy', 'false');
  refreshButton.disabled = false;
  byId('unlock-owner').disabled = false;
  byId('logout-owner').disabled = false;
  ownerCode.disabled = false;
  refreshButton.textContent = 'Refresh readiness';
  checking = false;
}

async function request(action, options = {}) {
  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort(), action === 'account' ? 55000 : 15000);
  try {
    const response = await fetch(`/api/live-trade?action=${action}`, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...options.headers },
      ...(options.body ? { body: options.body } : {}),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error.slice(0, 500) : 'The request could not be completed. Try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = undefined;
  }
}

function showOwnerError(error, fallback) {
  clearSnapshot();
  if (error.status === 401) {
    clearPrivateData();
    ownerError.textContent = 'Private access is locked or has expired. Enter your owner access code again.';
    return;
  }
  ownerError.textContent = error.status ? error.message : fallback;
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
    const [whole, cents] = snapshot.account.availableUsd.split('.');
    byId('account-label').textContent = snapshot.account.label;
    byId('account-balance').textContent = `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents} USD`;
    byId('account-terms').textContent = snapshot.account.termsAccepted ? 'Accepted' : 'Not accepted';
    byId('account-trader').textContent = snapshot.account.roles.trader ? 'Present' : 'Not present';
    byId('account-checked').textContent = `Account checked ${new Date(snapshot.checkedAt).toLocaleString()}. This is a snapshot; refresh to check again.`;
    byId('private-account').hidden = false;
    setAccountRequirement(true);
    byId('live-connection').textContent = 'Verified for this account check';
    byId('live-state').textContent = 'Account checked';
    message.textContent = 'The private account check is complete. Trading is disabled; no orders can be placed from this page.';
    ownerStatus.textContent = 'Read-only account snapshot verified.';
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
  if (checking) return;
  const version = beginOperation('Checking readiness…');
  byId('live-state').textContent = 'Checking';
  message.textContent = 'Checking what’s ready for your live demo…';
  message.classList.remove('is-error');
  try {
    await refreshReadiness(version);
  } catch (error) {
    if (version === operationVersion) showReadinessError(error);
  } finally {
    finishOperation();
  }
}

ownerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (checking || ownerAccessConfigured !== true || authenticated || !ownerForm.reportValidity()) return;
  const code = ownerCode.value;
  ownerCode.value = '';
  const version = beginOperation('Unlocking private access…');
  try {
    const data = await request('login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (version !== operationVersion) return;
    if (!validSession(data)) throw new Error('Private session could not be verified');
    setSession(data);
    await refreshReadiness(version);
    if (version === operationVersion && !authenticated && !ownerError.textContent) {
      ownerError.textContent = 'Private access could not be confirmed. Enter your owner access code again.';
    }
  } catch (error) {
    if (version !== operationVersion) return;
    clearPrivateData();
    showOwnerError(error, 'Private access could not be verified. Enter your code and try again.');
    if (error.status === 401) {
      ownerError.textContent = error.message;
      ownerCode.setAttribute('aria-invalid', 'true');
    }
  } finally {
    ownerCode.value = '';
    finishOperation();
    if (version === operationVersion) {
      if (authenticated) byId('logout-owner').focus();
      else if (!ownerForm.hidden) ownerCode.focus();
    }
  }
});

byId('logout-owner').addEventListener('click', async () => {
  if (checking || !authenticated) return;
  const token = csrfToken;
  const version = beginOperation('Locking private access…');
  clearPrivateData();
  byId('live-state').textContent = 'Private access locked';
  message.textContent = 'Private account details have been cleared. Orders remain unavailable.';
  message.classList.remove('is-error');
  try {
    await request('logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
    if (version === operationVersion) ownerStatus.textContent = 'Private access is locked. Account details have been cleared.';
  } catch (error) {
    if (version !== operationVersion) return;
    ownerError.textContent = error.status === 401
      ? 'Private access has already expired. Account details have been cleared.'
      : 'Account details have been cleared here, but locking the session could not be confirmed. Unlock and try locking again.';
  } finally {
    finishOperation();
  }
});

refreshButton.addEventListener('click', loadReadiness);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && authenticated && Date.now() >= sessionExpiresAt) expireSession();
});
window.addEventListener('pagehide', () => {
  operationVersion += 1;
  activeController?.abort();
  clearPrivateData();
  ownerStatus.textContent = '';
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) loadReadiness();
});
loadReadiness();
