const byId = (id) => document.getElementById(id);
const panel = document.querySelector('.live-readiness');
const refreshButton = byId('refresh-live');
const message = byId('live-message');
const requirements = byId('live-requirements');
let checking = false;

function validStatus(data) {
  return data && data.environment === 'production' &&
    typeof data.tradingEnabled === 'boolean' && typeof data.connected === 'boolean' &&
    data.budget === '5.00' && ['pending', 'oauth', 'personal'].includes(data.credentialMode) &&
    typeof data.message === 'string' && data.message.length > 0 &&
    Array.isArray(data.requirements) && data.requirements.length <= 20 &&
    data.requirements.every((item) => item && typeof item.id === 'string' &&
      typeof item.label === 'string' && item.label.length > 0 && typeof item.ready === 'boolean');
}

function renderStatus(data) {
  byId('live-state').textContent = data.tradingEnabled ? 'Review setup' : 'Setup pending';
  message.textContent = data.message;
  message.classList.remove('is-error');
  byId('live-connection').textContent = data.connected ? 'Connection reported' : 'Not connected';
  byId('live-method').textContent = {
    pending: 'Not chosen yet',
    oauth: 'Gemini sign-in (your own account)',
    personal: 'Personal key (private owner access)',
  }[data.credentialMode];
  requirements.replaceChildren();
  for (const item of data.requirements) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    const state = document.createElement('span');
    label.textContent = item.label;
    state.textContent = item.ready ? (['credentials','storage'].includes(item.id) ? 'Added' : 'Verified') : 'Pending';
    state.className = item.ready ? 'requirement-state is-ready' : 'requirement-state';
    row.append(label, state);
    requirements.append(row);
  }
  byId('live-checked').textContent = `Checked at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Refresh after completing setup.`;
}

async function loadReadiness() {
  if (checking) return;
  checking = true;
  refreshButton.disabled = true;
  refreshButton.textContent = 'Checking readiness…';
  panel.setAttribute('aria-busy', 'true');
  byId('live-state').textContent = 'Checking';
  message.textContent = 'Checking what’s ready for your live demo…';
  message.classList.remove('is-error');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/live-trade?action=status', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Readiness unavailable');
    const data = await response.json();
    if (!validStatus(data)) throw new Error('Readiness response could not be verified');
    renderStatus(data);
  } catch {
    requirements.replaceChildren();
    byId('live-state').textContent = 'Could not check';
    byId('live-connection').textContent = 'Not verified';
    byId('live-method').textContent = 'Not verified';
    byId('live-checked').textContent = '';
    message.textContent = 'We couldn’t check readiness. Refresh to try again. No connection, balance, or trading access has been confirmed.';
    message.classList.add('is-error');
  } finally {
    clearTimeout(timer);
    panel.setAttribute('aria-busy', 'false');
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh readiness';
    checking = false;
  }
}

refreshButton.addEventListener('click', loadReadiness);
loadReadiness();
