import test from 'node:test';
import assert from 'node:assert/strict';

const symbol = 'GEMI-TEST-YES';
class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.children = []; this.hidden = false;
    this.disabled = false; this.checked = false; this.listeners = new Map();
    this.classList = {add() {}, remove() {}};
  }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute() {}
  removeAttribute() {}
  reportValidity() { return true; }
  focus() {}
  async emit(event) { await this.listeners.get(event)?.({preventDefault() {}}); }
}

async function harness(run, {search = `?symbol=${symbol}&outcome=no&spendLimit=1.00`, draftResponse, locked = false} = {}) {
  const keys = ['document', 'window', 'Option', 'fetch'];
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const elements = new Map(), actions = [], windowListeners = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const market = {symbol, title: 'Test contract', eventTitle: 'Test event', description: 'Test conditions',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), yesAsk: .42, noAsk: .37};
  const budget = {remainingUsd: '5.00', reservedUsd: '0.00', unresolved: false};
  let authenticated = !locked;
  const session = () => ({authenticated: true, csrfToken: 'test-csrf', sessionExpiresAt: Date.now() + 60000});
  const draft = body => ({draft: {...market, outcome: body.outcome, quantity: '2',
    price: body.outcome === 'no' ? '0.37' : '0.42', principal: body.outcome === 'no' ? '0.74' : '0.84',
    estimatedFee: '0.06', estimatedTotal: body.outcome === 'no' ? '0.80' : '0.90', spendLimit: body.spendLimit,
    feeNote: 'Test fee allowance'}, budget, checkedAt: new Date().toISOString()});
  globalThis.document = {getElementById: el, querySelector: el, createElement: () => new Element(), addEventListener() {}};
  globalThis.window = {location: {search}, addEventListener: (event, handler) => windowListeners.set(event, handler)};
  globalThis.Option = class extends Element { constructor(label, value) { super(); this.textContent = label; this.value = value; } };
  globalThis.fetch = async (url, options) => {
    const action = new URL(url, 'http://localhost').searchParams.get('action');
    const body = options.body ? JSON.parse(options.body) : undefined;
    actions.push({action, body, options});
    let data;
    if (action === 'status') data = {environment: 'production', tradingEnabled: true, connected: false,
      credentialMode: 'personal', budget: '5.00', ownerAccessConfigured: true, authenticated,
      ...(authenticated ? session() : {}), message: 'Test setup', requirements: []};
    else if (action === 'login') { authenticated = true; data = session(); }
    else if (action === 'account') data = {environment: 'production', connected: true, tradingEnabled: true, budget: '5.00',
      account: {label: 'Test account', availableUsd: '5.00', termsAccepted: true, roles: {trader: true}}, checkedAt: new Date().toISOString()};
    else if (action === 'markets') data = {markets: [market], budget};
    else if (action === 'draft') data = draftResponse ? await draftResponse(body, draft) : draft(body);
    else throw new Error(`Unexpected action ${action}`);
    return {ok: true, json: async () => data};
  };
  el('draft-spend').value = '1.00'; el('order-outcome').value = 'yes';
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    await import(`../public/live.js?test=${Math.random()}`);
    await flush();
    await run({el, actions, flush, windowListeners});
  } finally {
    windowListeners.get('pagehide')?.();
    for (const key of keys) if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key];
  }
}

test('report handoff fills the exact NO contract, price and quantity without creating or submitting a review', async () => {
  await harness(async ({el, actions}) => {
    assert.deepEqual(actions.map(item => item.action), ['status', 'account', 'markets', 'draft']);
    assert.deepEqual(actions.at(-1).body, {symbol, outcome: 'no', spendLimit: '1.00'});
    assert.equal(actions.at(-1).options.headers['X-CSRF-Token'], 'test-csrf');
    assert.equal(el('market-select').value, symbol);
    assert.equal(el('order-outcome').value, 'no');
    assert.equal(el('order-price').value, '0.37');
    assert.equal(el('order-quantity').value, '2');
    assert.match(el('draft-summary').textContent, /BUY NO.*\$0\.80/);
    assert.equal(el('preview-order').disabled, false);
    assert.equal(el('real-money-confirm').checked, false);
    assert.equal(el('place-order').disabled, true);
    assert.equal(el('order-review').hidden, true);
  });
});

test('the trade intent survives owner login and makes no private request before unlocking', async () => {
  await harness(async ({el, actions}) => {
    assert.deepEqual(actions.map(item => item.action), ['status']);
    el('owner-code').value = 'synthetic-test-code';
    await el('owner-form').emit('submit');
    assert.equal(el('order-outcome').value, 'no');
    assert.equal(el('order-price').value, '0.37');
    assert.deepEqual(actions.at(-1).body, {symbol, outcome: 'no', spendLimit: '1.00'});
    assert.equal(el('owner-code').value, '');
    assert.equal(el('place-order').disabled, true);
  }, {locked: true});
});

test('changing the outcome recalculates and a manual price edit never triggers another draft or submission', async () => {
  await harness(async ({el, actions}) => {
    el('order-outcome').value = 'yes'; await el('order-outcome').emit('change');
    assert.equal(el('order-price').value, '0.42');
    assert.equal(actions.at(-1).body.outcome, 'yes');
    const count = actions.length;
    el('order-price').value = '0.20'; await el('order-price').emit('input');
    assert.equal(actions.length, count); assert.equal(el('order-price').value, '0.20');
    assert.equal(el('draft-summary').textContent, ''); assert.equal(el('place-order').disabled, true);
  });
});

test('a mismatched server draft cannot fill editable inputs or enable a review', async () => {
  await harness(async ({el, actions}) => {
    assert.equal(el('order-price').value, ''); assert.equal(el('order-quantity').value, '');
    assert.equal(el('preview-order').disabled, true); assert.equal(el('place-order').disabled, true);
    assert.match(el('trade-error').textContent, /could not be filled in/);
    assert.ok(actions.every(item => !['preview', 'submit'].includes(item.action)));
  }, {draftResponse: (body, make) => { const data = make(body); data.draft.outcome = 'yes'; return data; }});
});

test('a late auto-fill cannot overwrite newer amount edits, even if cancellation is ignored', async () => {
  let finish;
  await harness(async ({el, actions, flush}) => {
    el('draft-spend').value = '0.50'; await el('draft-spend').emit('input');
    finish(); await flush();
    assert.equal(el('draft-spend').value, '0.50');
    assert.equal(el('order-price').value, ''); assert.equal(el('order-quantity').value, '');
    assert.equal(el('preview-order').disabled, true);
    assert.ok(actions.every(item => item.action !== 'submit'));
  }, {draftResponse: (body, make) => new Promise(resolve => { finish = () => resolve(make(body)); })});
});

test('opening the general trading page does not choose a market or request a draft', async () => {
  await harness(async ({el, actions}) => {
    assert.deepEqual(actions.map(item => item.action), ['status', 'account', 'markets']);
    assert.equal(el('order-price').value, ''); assert.equal(el('preview-order').disabled, true);
  }, {search: ''});
});

test('refreshing markets with an invalid auto-fill amount leaves the form editable', async () => {
  await harness(async ({el, flush}) => {
    el('draft-spend').value = ''; await el('draft-spend').emit('input');
    await el('refresh-markets').emit('click'); await flush();
    assert.equal(el('order-inputs').disabled, false);
    assert.equal(el('refresh-markets').disabled, false);
    assert.equal(el('fill-draft').disabled, false);
    assert.equal(el('preview-order').disabled, true);
    el('draft-spend').value = '1.00'; await el('draft-spend').emit('change');
    assert.equal(el('order-price').value, '0.37');
    assert.equal(el('preview-order').disabled, false);
  });
});
