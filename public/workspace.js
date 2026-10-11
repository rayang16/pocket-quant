import { readChecks, clearChecks, removeCheck, recordCheck } from './workspace-data.js';
import { node, percent, percentRange, money, request } from './ui.js';
import { parseSharedReel } from './shared-reel.js';
import { renderContractChart, renderQuoteGauge, disposeChart } from './workspace-charts.js';

import {reportWorkspaceEvents,reportWorkspaceResult} from './report-workspace.js';

const byId = id => document.getElementById(id);
const empty = byId('workspace-empty');
const content = byId('workspace-content');
const list = byId('check-list');
const search = byId('workspace-search');
const category = byId('workspace-category');
const panes = { graph: byId('workspace-graph'), quotes: byId('workspace-quotes'), cards: byId('workspace-cards'), timeline: byId('workspace-timeline') };
let checks = readChecks();
let selectedCheck = null;
let events = [];
let selectedEvent = null;
let selectedContract = null;
let listing = null;
let listingQuery = '';
let retryAppend = false;
let controller;
let requestSerial = 0;
let searchTimer;
let videoUrl = null;
let zoom = 1;
let graphPositions = new Map();
let workspaceScope = 'related';
let sector = 'all';
let sortOrder = 'relevance';
let activeView = matchMedia('(max-width: 760px)').matches ? 'cards' : 'graph';

const dateLabel = (value, full = false) => {
  if (value === null || value === undefined || value === '') return 'Not provided';
  const d = new Date(value);
  if (!Number.isFinite(+d)) return 'Not provided';
  return d.toLocaleString(undefined, full ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } : { month: 'short', day: 'numeric', year: 'numeric' });
};
const checkedTime = entry => dateLabel(entry.result.checkedAt || entry.addedAt, true);
const titleCase = value => typeof value === 'string' ? value.toLowerCase().replace(/^\w/, c => c.toUpperCase()) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const probability = value => number(value) !== null && value >= 0 && value <= 1 ? value : null;
const validRange = value => value && probability(value.lo) !== null && probability(value.hi) !== null && value.lo <= value.hi;
const eventKey = (event, index = events.indexOf(event)) => `${event.id || 'event'}-${index}`;
const contractKey = (contract, index) => `${contract.symbol || contract.id || 'contract'}-${index}`;
function eventWindowLabel(event) {
  if (event?.category !== 'Crypto' || !event.startTime) return '';
  const start = Date.parse(event.startTime), end = Date.parse(event.expiryDate);
  const duration = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0 || duration > 86400000) return '';
  const minutes = duration / 60000;
  if (Number.isInteger(minutes) && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  if (Number.isInteger(minutes)) return `${minutes}-minute window`;
  const seconds = duration / 1000;
  return Number.isInteger(seconds) ? `${seconds}-second window` : '';
}


function setText(id, text) { const target = byId(id); if (target) target.textContent = text; }
function status(text, error = false) {
  const target = byId('workspace-status');
  if (!target) return;
  target.textContent = text;
  target.classList.toggle('is-error', error);
}
function safeMarketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (!url.port || url.port === '443') && ['www.gemini.com', 'gemini.com'].includes(url.hostname) && !url.username && !url.password && /^\/predictions(?:\/|$)/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
function link(label, href, className = '') {
  const element = node('a', className, label);
  element.href = href;
  element.target = '_blank';
  element.rel = 'noopener noreferrer';
  return element;
}
function note(text) { return node('p', 'analytics-note', text); }
function selectedOriginalInstrument() {
  const original = selectedCheck?.result?.market?.instrumentSymbol;
  return workspaceScope === 'related' && !!original && selectedContract?.symbol === original;
}
function topicLabel(entry) { return entry.result.claim?.asset || (entry.result.report ? titleCase(entry.result.report.claim?.type) : entry.result.claim?.category) || 'Prediction'; }
function relationLabel(entry) {
  if(entry.result.report)return entry.result.report.assessment?.label || titleCase(entry.result.report.assessment?.status) || 'Analyzed';
  const match = entry.result.market?.match;
  if (match === 'exact') return 'Exact contract at check time';
  if (match === 'nearest') return 'Nearest contract · different conditions';
  if (match === 'AI-selected') return 'AI-selected · verify conditions';
  return titleCase(entry.result.verdict) || 'Claim checked';
}

function renderChecks() {
  list.replaceChildren();
  setText('checks-count', String(checks.length));
  for (const entry of checks) {
    const button = node('button', 'workspace-check');
    button.type = 'button';
    button.dataset.checkId = entry.id;
    const selected = workspaceScope === 'related' && entry.id === selectedCheck?.id;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.append(node('span', 'check-topic', topicLabel(entry)), node('strong', 'check-title', entry.text || entry.result.claim?.summary || 'Checked prediction'), node('span', 'check-relation', relationLabel(entry)));
    button.addEventListener('click', () => chooseCheck(entry));
    list.append(button);
  }
  const hasChecks = checks.length > 0;
  empty.hidden = hasChecks || workspaceScope === 'browse';
  content.hidden = !hasChecks && workspaceScope !== 'browse';
  byId('clear-workspace').disabled = !hasChecks;
  if (byId('selected-check-remove')) { byId('selected-check-remove').disabled = !hasChecks || workspaceScope === 'browse'; byId('selected-check-remove').hidden = workspaceScope === 'browse'; }
}
function defaultCategory(entry) {
  if(entry.result.report)return '';
  const value = entry.result.claim?.category;
  if (!value || value === 'Other') return '';
  if (![...category.options].some(option => option.value === value)) {
    const option = node('option', '', value); option.value = value; category.append(option);
  }
  return value;
}
function chooseCheck(entry) {
  selectedCheck = entry;
  workspaceScope = 'related';
  sortOrder = 'relevance'; if (byId('workspace-sort')) byId('workspace-sort').value = sortOrder;
  sector = 'all';
  renderScope();
  search.value = '';
  category.value = defaultCategory(entry);
  graphPositions = new Map();
  zoom = 1;
  setText('selected-claim', entry.text || entry.result.claim?.summary || 'Checked prediction');
  const claim = entry.result.claim;
  setText('selected-claim-meta', `${topicLabel(entry)} · Checked ${checkedTime(entry)}${claim?.deadlineISO ? ` · Claim deadline ${dateLabel(claim.deadlineISO, true)}${claim.deadlineAssumed ? ' (assumed)' : ''}` : ''}`);
  renderChecks();
  renderSource();
  const url = new URL(location.href);
  url.searchParams.set('check', entry.id);
  url.searchParams.delete('scope'); url.searchParams.delete('sector');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  loadMarkets();
}
function resetListing() {
  events = []; selectedEvent = null; selectedContract = null; listing = null;
  updateMoreButton();
  renderViews(); renderInspector();
}
function updateOverview() {
  const contracts = events.flatMap(event => event.contracts);
  setText('overview-events', listing ? events.length.toLocaleString() : '—');
  setText('overview-contracts', listing ? contracts.length.toLocaleString() : '—');
  setText('overview-coverage', contracts.length ? `${Math.round(contracts.filter(contract => probability(contract.prob) !== null).length / contracts.length * 100)}%` : '—');
  const selector = byId('workspace-event-select');
  selector.replaceChildren();
  if (!events.length) { const option = node('option', '', 'No markets loaded'); selector.append(option); }
  events.forEach((event, index) => {
    const option = node('option', '', `${event.title}${eventWindowLabel(event) ? ` (${eventWindowLabel(event)})` : ''}`);
    option.value = String(index); option.selected = event === selectedEvent; selector.append(option);
  });
  selector.disabled = !events.length;
}
function renderQuotes() {
  if (panes.quotes.hidden) return;
  setText('quote-chart-title', selectedEvent?.title || 'Choose a market');
  setText('quote-chart-caption', selectedEvent ? 'YES quotes · Select a contract · Not price history' : 'Select a market below.');
  renderContractChart(byId('quote-chart'), selectedEvent, selectedContract, contract => selectEvent(selectedEvent, contract));
}
function updateMoreButton(busy = false) {
  const button = byId('workspace-more');
  if (!button) return;
  button.hidden = !listing?.hasMore;
  button.disabled = busy;
  button.textContent = busy ? 'Loading more…' : 'Load more markets';
}
function eventIdentity(event) {
  if (event.id !== null && event.id !== undefined) return `id:${event.id}`;
  if (event.url) return `url:${event.url}`;
  return `event:${event.title}|${event.expiryDate}|${event.contracts[0]?.symbol || ''}`;
}
async function loadMarkets({ append = false, refreshReport = false } = {}) {
  if (append && (!listing?.hasMore || content.getAttribute('aria-busy') === 'true')) return;
  if (append && (typeof listing.nextCursor !== 'string' || !listing.nextCursor)) {
    retryAppend = false; status('This market list cannot be continued. Refresh it to load current events.', true);
    byId('workspace-retry').textContent = 'Refresh market list'; byId('workspace-retry').hidden = false;
    return;
  }
  controller?.abort();
  const serial = ++requestSerial;
  if (!selectedCheck && workspaceScope !== 'browse') return;
  const nextCursor = append ? listing.nextCursor : null;
  const pageRankStart = append ? events.length : 0;
  controller = new AbortController();
  const currentController = controller;
  const timeout = setTimeout(() => currentController.abort(), 45000);
  if (!append) resetListing();
  content.setAttribute('aria-busy', 'true');
  byId('workspace-retry').hidden = true;
  byId('workspace-retry').textContent = 'Try again';
  updateMoreButton(true);
  status(append ? 'Loading more Gemini markets…' : workspaceScope === 'browse' ? 'Loading the Gemini market directory…' : 'Finding real Gemini markets related to this claim…');
  let params;
  if (append) {
    params = new URLSearchParams(listingQuery); params.set('cursor', nextCursor);
  } else {
    params = new URLSearchParams();
    const claim = selectedCheck?.result?.claim || {};
    const chosenCategory = category.value;
    if (chosenCategory) params.set('category', chosenCategory);
    if (workspaceScope === 'related') {
      if (claim.asset && (!chosenCategory || chosenCategory === 'Crypto')) params.set('asset', claim.asset);
      params.set('q', selectedCheck?.text || claim.summary || '');
      if (claim.deadlineISO) params.set('deadline', claim.deadlineISO);
    } else {
      if (sector !== 'all') params.set('sector', sector);

    }
    if (search.value.trim()) params.set('search', search.value.trim());
    listingQuery = params.toString();
  }
  try {
    if(workspaceScope==='related' && selectedCheck?.result?.report){
      if(refreshReport){
        const entry=selectedCheck;
        const data=await request('','/api/evidence-report?action=check',{claim:entry.result.report.claim,...(entry.reelUrl?{sourceUrl:entry.reelUrl}:{})},{signal:currentController.signal});
        if(serial!==requestSerial)return;
        const saved=recordCheck(reportWorkspaceResult(data),{text:data.claim.text,reelUrl:entry.reelUrl});
        selectedCheck=saved || {...entry,result:reportWorkspaceResult(data)};checks=readChecks();renderChecks();
        const claim=selectedCheck.result.claim;setText('selected-claim-meta',`${topicLabel(selectedCheck)} · Checked ${checkedTime(selectedCheck)}${claim?.deadlineISO?' · Claim deadline '+dateLabel(claim.deadlineISO,true):''}`);
      }
      const report=selectedCheck.result.report,query=search.value.trim().toLowerCase();
      events=reportWorkspaceEvents(report).filter(event=>(!category.value || event.category===category.value) && (!query || [event.title,...event.contracts.map(c=>c.label)].join(' ').toLowerCase().includes(query)));
      listing={total:events.length,hasMore:false,fetchedAt:report.checkedAt};sortEvents();
      const original=selectedCheck.result.market?.instrumentSymbol;
      selectedEvent=events.find(event=>original&&event.contracts.some(c=>c.symbol===original))||events[0]||null;
      chooseInitialContract();renderViews();renderInspector();
      status(`${events.length} related ${events.length===1?'event':'events'} · Selected report quotes · ${dateLabel(report.checkedAt,true)}${events.length?'':'. No matching markets.'}`);
      return;
    }
    const response = await fetch(`/api/markets?${params}`, { signal: currentController.signal, headers: { Accept: 'application/json' } });
    let data;
    try { data = await response.json(); } catch { throw new Error('The market response could not be read. Try again.'); }
    if (append && response.status === 409) {
      if (serial !== requestSerial) return;
      graphPositions.clear(); resetListing(); retryAppend = false;
      status(data.error || 'The market list changed or expired. Refresh it before loading more events.', true);
      byId('workspace-retry').textContent = 'Refresh market list';
      byId('workspace-retry').hidden = false;
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Gemini markets are unavailable. Try again.');
    if (!Array.isArray(data.events)) throw new Error('The market response did not include an event list. Try again.');
    if (serial !== requestSerial) return;
    const page = data.events.filter(event => event && typeof event.title === 'string' && Array.isArray(event.contracts)).map((event, index) => ({ ...event, _fetchedAt: data.fetchedAt, _rank: pageRankStart + index, contracts: event.contracts.filter(contract => contract && typeof contract === 'object') }));
    if (append) {
      const known = new Set(events.map(eventIdentity));
      for (const event of page) if (!known.has(eventIdentity(event))) { known.add(eventIdentity(event)); events.push(event); }
    } else events = page;
    listing = data;
    sortEvents();
    if (!append || !selectedEvent) {
      const original = workspaceScope === 'related' ? selectedCheck?.result?.market?.instrumentSymbol : null;
      selectedEvent = events.find(event => original && event.contracts.some(contract => contract.symbol === original)) || events[0] || null;
      chooseInitialContract();
    }
    renderViews(); renderInspector();
    const total = Number.isFinite(data.total) ? data.total : events.length;
    const count = append
      ? `${events.length} ${events.length === 1 ? 'event' : 'events'} loaded across pages. ${total} matching ${total === 1 ? 'event' : 'events'} in the latest feed.`
      : `Loaded ${events.length} of ${total} ${workspaceScope === 'related' ? 'related ' : ''}${total === 1 ? 'event' : 'events'}.`;
    const more = data.hasMore ? ' Load more to see the next events.' : '';
    const contractCap = events.some(event => event.contractsTruncated) ? ' Some events contain additional contracts; open them on Gemini for the full list.' : data.truncated && data.hasMore === undefined ? ' The response is partial; narrow your filters for more detail.' : '';
    const retrieved = data.fetchedAt ? ` Latest retrieval ${dateLabel(data.fetchedAt, true)}.` : '';
    status(events.length ? `${events.length} of ${total} events${data.hasMore?' · Load more available':''}${contractCap}${data.fetchedAt?' · Updated '+dateLabel(data.fetchedAt,true):''}` : 'No markets found for these filters. Change the search or category, or check another prediction.');
  } catch (error) {
    if (serial !== requestSerial) return;
    retryAppend = append;
    status(error.name === 'AbortError' ? 'The market request timed out. Try again.' : error.message, true);
    byId('workspace-retry').hidden = false;
  } finally {
    clearTimeout(timeout);
    if (serial === requestSerial) { content.setAttribute('aria-busy', 'false'); updateMoreButton(); }
  }
}
function chooseInitialContract() {
  const original = workspaceScope === 'related' ? selectedCheck?.result?.market?.instrumentSymbol : null;
  selectedContract = selectedEvent?.contracts.find(contract => original && contract.symbol === original) || selectedEvent?.contracts.find(contract => probability(contract.prob) !== null) || selectedEvent?.contracts[0] || null;
}
function selectEvent(event, contract) {
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.eventKey;
  const focusContract = focused?.dataset?.contractKey;
  selectedEvent = event;
  if (contract) selectedContract = contract; else chooseInitialContract();
  renderViews(); renderInspector();
  if (focusKey) {
    const replacement = [...panes[activeView].querySelectorAll('[data-event-key]')].find(element => element.dataset.eventKey === focusKey && element.dataset.contractKey === focusContract);
    replacement?.focus({ preventScroll: true });
  }
}
function setView(view, focus = false) {
  if (!panes[view]) return;
  const changed = activeView !== view;
  activeView = view;
  if (changed) renderActiveView();
  const mapControls = document.querySelector('.map-bottom');
  if (mapControls) mapControls.hidden = view !== 'graph';
  if (byId('workspace-sort')) byId('workspace-sort').disabled = view === 'timeline';
  for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== view;
  for (const button of byId('workspace-views').querySelectorAll('[data-view]')) {
    const selected = button.dataset.view === view;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.classList.toggle('is-active', selected);
    if (selected && focus) button.focus();
  }
  updateZoom();
  if (view === 'quotes') requestAnimationFrame(renderQuotes);
}
function renderActiveView() {
  if (activeView === 'graph') renderGraph();
  else if (activeView === 'quotes') renderQuotes();
  else if (activeView === 'cards') renderCards();
  else renderTimeline();
}
function renderViews() {
  updateOverview();
  renderActiveView(); setView(activeView);
}

function renderGraph() {
  const root = panes.graph;
  root.replaceChildren();
  if (!selectedCheck && workspaceScope !== 'browse') return;
  const stage = node('div', 'graph-stage');
  stage.style.setProperty('--graph-zoom', String(zoom));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('graph-links');
  svg.setAttribute('viewBox', '0 0 760 440');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  stage.append(svg);
  const firstEvents = events.slice(0, 8);
  const graphEvents = selectedEvent && !firstEvents.includes(selectedEvent) ? [selectedEvent, ...firstEvents.slice(0, 7)] : firstEvents;
  const positions = workspaceScope === 'browse' ? [[20,18],[46,13],[72,18],[85,48],[72,79],[46,83],[20,79],[9,48]] : [[65,15],[85,32],[72,52],[85,77],[61,84],[34,83],[12,80],[20,15]];
  const topic = { id: 'topic', type: 'topic', label: workspaceScope === 'browse' ? 'Market category' : 'Related topic', text: workspaceScope === 'browse' ? sectorName() : topicLabel(selectedCheck), x: workspaceScope === 'browse' ? 49 : 42, y: 48, action() { status(workspaceScope === 'browse' ? 'Category connections organize the directory. They do not establish a relationship between outcomes or a profitable trade.' : 'Connections show a shared topic or search terms. They do not establish identical conditions, causation, or a profitable trade.'); } };
  const claimNode = selectedCheck && workspaceScope === 'related' ? { id: 'claim', type: 'claim', label: selectedCheck.reelUrl ? 'Reel claim' : 'Your claim', text: selectedCheck.text || 'Checked prediction', x: 16, y: 50, action() { byId('selected-claim').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); } } : null;
  const nodes = [
    ...(claimNode ? [claimNode] : []), topic,
    ...graphEvents.map((event, index) => ({ id: eventKey(event), type: 'event', label: eventWindowLabel(event) || event.category || 'Gemini event', text: event.title, x: positions[index][0], y: positions[index][1], event, action() { selectEvent(event); } })),
  ];
  for (const data of nodes) {
    const previous = graphPositions.get(data.id);
    if (previous) { data.x = previous.x; data.y = previous.y; }
  }
  const edges = nodes.filter(data => data !== topic).map(data => ({ from: topic, to: data, path: document.createElementNS('http://www.w3.org/2000/svg', 'path') }));
  const drawEdges = () => {
    for (const { from, to, path } of edges) {
      const startX = from.x * 7.6, startY = from.y * 4.4, endX = to.x * 7.6, endY = to.y * 4.4;
      path.setAttribute('d', `M ${startX} ${startY} C ${(startX + endX) / 2} ${startY}, ${(startX + endX) / 2} ${endY}, ${endX} ${endY}`);
      path.classList.toggle('is-selected', to.event === selectedEvent);
    }
  };
  for (const edge of edges) svg.append(edge.path);
  drawEdges();
  for (const data of nodes) {
    const button = node('button', `graph-node ${data.type}-node`);
    button.type = 'button'; button.style.touchAction = 'none';
    button.style.left = `${data.x}%`; button.style.top = `${data.y}%`;
    button.title = data.text;
    button.setAttribute('aria-label', `${data.label}: ${data.text}`);
    if (data.type === 'event') { button.setAttribute('aria-pressed', String(data.event === selectedEvent)); button.dataset.eventKey = eventKey(data.event); }
    button.classList.toggle('is-selected', data.event === selectedEvent && data.type === 'event');
    button.append(node('span', 'graph-node-label', data.label), node('strong', '', data.text));
    let drag = null;
    let suppressClick = false;
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, startX: data.x, startY: data.y, moved: false };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) < 5 && !drag.moved) return;
      drag.moved = true; button.classList.add('is-dragging');
      const rect = stage.getBoundingClientRect();
      data.x = Math.max(10, Math.min(90, drag.startX + dx / rect.width * 100));
      data.y = Math.max(9, Math.min(91, drag.startY + dy / rect.height * 100));
      button.style.left = `${data.x}%`; button.style.top = `${data.y}%`;
      graphPositions.set(data.id, { x: data.x, y: data.y });
      drawEdges();
    });
    const endDrag = event => {
      if (!drag) return;
      suppressClick = drag.moved;
      drag = null; button.classList.remove('is-dragging');
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    };
    button.addEventListener('pointerup', endDrag);
    button.addEventListener('pointercancel', endDrag);
    button.addEventListener('click', event => {
      if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
      suppressClick = false; data.action();
    });
    stage.append(button);
  }
  root.append(stage, node('p', 'graph-caption', `${events.length > 8 ? `8 of ${events.length} events shown. Markets and Timeline include all loaded events. ` : ''}Related topics · Drag to arrange · Select to inspect`));
}
function updateZoom() {
  const stage = panes.graph.querySelector('.graph-stage');
  if (stage) stage.style.setProperty('--graph-zoom', String(zoom));
  setText('graph-scale', `${Math.round(zoom * 100)}%`);
  if (byId('graph-zoom-in')) byId('graph-zoom-in').disabled = zoom >= 1.5;
  if (byId('graph-zoom-out')) byId('graph-zoom-out').disabled = zoom <= .75;
}
function emptyMarkets() {
  return node('p', 'organizer-empty', listing ? 'No events match these filters. Try another search or category.' : 'Related Gemini markets will appear here when the request completes.');
}
function renderCards() {
  const expanded = new Set([...panes.cards.querySelectorAll('details[open][data-event-key]')].map(details => details.dataset.eventKey));
  panes.cards.replaceChildren();
  if (!events.length) { panes.cards.append(emptyMarkets()); return; }
  for (const event of events) {
    const card = node('article', 'market-card');
    card.classList.toggle('is-selected', selectedEvent === event);
    card.append(node('p', 'market-card-category', [event.category || 'Gemini prediction', eventWindowLabel(event)].filter(Boolean).join(' · ')));
    const heading = node('h3'); const title = node('button', 'market-card-title', event.title);
    title.type = 'button'; title.dataset.eventKey = eventKey(event); title.addEventListener('click', () => selectEvent(event)); heading.append(title); card.append(heading);
    card.append(node('p', 'market-card-expiry', `Expires ${dateLabel(event.expiryDate, true)}`));
    const addContract = (contract, container) => {
      const button = node('button', 'market-contract');
      button.type = 'button'; button.dataset.eventKey = eventKey(event); button.dataset.contractKey = contractKey(contract, event.contracts.indexOf(contract)); button.setAttribute('aria-pressed', String(selectedEvent === event && selectedContract === contract));
      button.classList.toggle('is-empty', probability(contract.prob) === null);
      button.append(node('span', '', contract.label || 'Prediction contract'), node('strong', '', probability(contract.prob) === null ? 'No quote' : `${percent(contract.prob)} YES`));
      button.addEventListener('click', () => selectEvent(event, contract)); container.append(button);
    };
    for (const contract of event.contracts.slice(0, 4)) addContract(contract, card);
    if (event.contracts.length > 4) {
      const more = node('details', 'market-more'); more.dataset.eventKey = eventKey(event); more.open = expanded.has(eventKey(event)); more.append(node('summary', '', `${event.contracts.length - 4} more ${event.contracts.length === 5 ? 'contract' : 'contracts'}`));
      for (const contract of event.contracts.slice(4)) addContract(contract, more);
      card.append(more);
    }
    if (event.contractsTruncated) card.append(note(`Showing ${event.contracts.length} of ${event.contractTotal || 'more'} contracts. Open this event on Gemini for the full list.`));
    if (!event.contracts.length) card.append(note('No contracts were returned for this event.'));
    panes.cards.append(card);
  }
}
function renderTimeline() {
  panes.timeline.replaceChildren();
  if (!events.length) { panes.timeline.append(emptyMarkets()); return; }
  const sorted = [...events].sort((a, b) => (Date.parse(a.expiryDate) || Infinity) - (Date.parse(b.expiryDate) || Infinity));
  const intro = note('Market deadlines');
  panes.timeline.append(intro);
  for (const event of sorted) {
    const row = node('button', 'timeline-event'); row.type = 'button'; row.dataset.eventKey = eventKey(event);
    row.classList.toggle('is-selected', event === selectedEvent); row.setAttribute('aria-pressed', String(event === selectedEvent));
    const title = node('span', 'timeline-copy'); title.append(node('strong', '', event.title), node('small', '', `${[event.category || 'Gemini', eventWindowLabel(event)].filter(Boolean).join(' · ')} · ${event.contracts.length} ${event.contracts.length === 1 ? 'contract' : 'contracts'}`));
    row.append(node('time', 'timeline-date', dateLabel(event.expiryDate, true)), title);
    if (Number.isFinite(Date.parse(event.expiryDate))) row.querySelector('time').dateTime = event.expiryDate;
    row.addEventListener('click', () => selectEvent(event)); panes.timeline.append(row);
  }
}

function quoteForSelected() {
  if (!selectedContract) return { side: 'YES', prob: null, bid: null, ask: null };
  const side = selectedOriginalInstrument() && selectedCheck.result.market.side === 'NO' ? 'NO' : 'YES';
  const quote = { side, prob: probability(selectedContract.prob), bid: probability(selectedContract.bid), ask: probability(selectedContract.ask) };
  if (side === 'NO') return { side, prob: quote.prob === null ? null : 1 - quote.prob, bid: quote.ask === null ? null : 1 - quote.ask, ask: quote.bid === null ? null : 1 - quote.bid };
  return quote;
}
function analyticsRow(label, value) {
  const row = node('div', 'analytics-row'); row.append(node('span', '', label), node('strong', '', value)); return row;
}
function probabilityBar(label, value, className = '') {
  const wrapper = node('div', `analytics-bars ${className}`);
  const row = node('div', 'analytics-bar');
  row.append(node('span', '', label), node('strong', '', percent(value)));
  const track = node('span', 'analytics-track');
  const fill = node('span'); fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`; track.append(fill); row.append(track); wrapper.append(row);
  return wrapper;
}
function renderInspector() {
  const marketPanel = byId('analytics-market');
  const modelPanel = byId('analytics-model');
  const assessment = byId('analytics-assessment');
  const oldGauge = marketPanel.querySelector('.quote-gauge'); if (oldGauge) disposeChart(oldGauge);
  marketPanel.replaceChildren(); modelPanel.replaceChildren(); assessment.replaceChildren();
  const marketLink = byId('selected-market-link');
  const liveLink = byId('selected-live-link');
  if (liveLink) { liveLink.hidden = true; liveLink.removeAttribute('href'); }
  marketLink.hidden = !selectedEvent;
  if (!selectedEvent || !selectedContract) {
    setText('selected-event-title', selectedEvent?.title || 'Choose a market to inspect');
    setText('selected-event-meta', workspaceScope === 'browse' ? 'Select an event in this market directory to inspect its contracts.' : 'Related events appear after a claim has been checked.');
    marketLink.removeAttribute('href'); marketLink.hidden = true;
    marketPanel.append(note('Current quotes for the selected contract appear here. Missing prices are never treated as zero.'));
    modelPanel.append(note('A model comparison is available only for the original checked instrument.'));
    assessment.append(note('Select a real market to review its relationship to the claim and the quality of its available evidence.'));
    return;
  }
  const result = workspaceScope === 'related' ? selectedCheck?.result || {} : {};
  const original = selectedOriginalInstrument();
  const quote = quoteForSelected();
  const contractExpiry = Date.parse(selectedContract.expiryDate || selectedEvent.expiryDate);
  const expired = Number.isFinite(contractExpiry) && contractExpiry <= Date.now();
  setText('selected-event-title', selectedEvent.title);
  setText('selected-event-meta', `${[selectedEvent.category || 'Gemini prediction', eventWindowLabel(selectedEvent)].filter(Boolean).join(' · ')} · Expires ${dateLabel(selectedEvent.expiryDate, true)} · ${selectedEvent.contracts.length}${selectedEvent.contractsTruncated ? ` of ${selectedEvent.contractTotal || 'more'}` : ''} ${selectedEvent.contracts.length === 1 && !selectedEvent.contractsTruncated ? 'contract' : 'contracts'}${selectedEvent.contractsTruncated ? ' shown' : ''}`);
  marketLink.href = safeMarketUrl(selectedEvent.url) || 'https://www.gemini.com/predictions';
  marketLink.target = '_blank'; marketLink.rel = 'noopener noreferrer'; marketLink.hidden = false;
  // This only opens the existing owner review flow. That route obtains a fresh,
  // eligible contract and keeps authentication, preview, and confirmation intact.
  if (liveLink && !expired && /^(Crypto|Economics|Business|Commodities|Tech)$/i.test(selectedEvent.category || '') && /^GEMI-[A-Za-z0-9_-]{1,195}$/.test(selectedContract.symbol || '')) {
    liveLink.href = `/live.html?symbol=${encodeURIComponent(selectedContract.symbol)}`;
    liveLink.hidden = false;
  }
  const label = node('label', 'contract-select-label', 'Selected contract'); label.htmlFor = 'market-contract-select';
  const select = node('select', 'contract-select'); select.id = 'market-contract-select';
  selectedEvent.contracts.forEach((contract, index) => {
    const option = node('option', '', contract.label || contract.symbol || `Contract ${index + 1}`);
    option.value = contractKey(contract, index); option.selected = contract === selectedContract; select.append(option);
  });
  select.addEventListener('change', () => {
    selectedContract = selectedEvent.contracts.find((contract, index) => contractKey(contract, index) === select.value) || null;
    renderViews(); renderInspector(); byId('market-contract-select')?.focus();
  });
  marketPanel.append(label, select);
  const valueLabel = node('strong', 'analytics-value', quote.prob === null ? 'No quote' : percent(quote.prob));
  marketPanel.append(valueLabel);
  if (quote.prob !== null) {
    const gauge = node('div', 'quote-gauge'); marketPanel.append(gauge);
    if (renderQuoteGauge(gauge, quote.prob * 100, quote.side)) valueLabel.classList.add('sr-only');
    else gauge.remove();
  }
  marketPanel.append(note(`${expired ? 'Expired contract’s snapshot' : 'Indicative'} ${quote.side} probability · ${selectedContract.source || 'quote source unavailable'}`));
  marketPanel.append(analyticsRow(`${quote.side} bid / ask`, `${percent(quote.bid)} / ${percent(quote.ask)}`));
  const quoteDetails = node('details'); quoteDetails.append(node('summary', '', 'Quote details'), note(`Contract expiry: ${dateLabel(selectedContract.expiryDate || selectedEvent.expiryDate, true)}. Retrieved ${dateLabel(selectedEvent?._fetchedAt || listing?.fetchedAt, true)}. Gemini does not supply quote age here.`));
  if (selectedContract.symbol) quoteDetails.append(node('p', 'instrument-symbol', selectedContract.symbol));
  marketPanel.append(quoteDetails);

  const range = result.model?.matchedContract;
  if (original && validRange(range)) {
    const savedNotice = note(`Saved ${quote.side} closing-probability range for this instrument. Calculated ${checkedTime(selectedCheck)}; not recalculated against these quotes.`);
    savedNotice.classList.add('model-snapshot-notice');
    modelPanel.append(node('strong', 'analytics-value', percentRange(range)), savedNotice);
    modelPanel.append(probabilityBar('Low', range.lo, 'model-bar'), probabilityBar('High', range.hi, 'model-bar'));
    if (number(result.inputs?.spot) !== null) modelPanel.append(analyticsRow('Spot at check time', money(result.inputs.spot)));
    if (result.marketVsModel?.label) modelPanel.append(analyticsRow('Comparison at check time', titleCase(result.marketVsModel.label)));
    modelPanel.append(note('14 / 30 / 90-day historical volatility sensitivity range. This is not a confidence interval or a forecast of returns. The model has not been recalculated against these refreshed quotes.'));
  } else {
    modelPanel.append(node('strong', 'analytics-empty', 'No matching model'), note(workspaceScope === 'browse' ? 'The market directory does not calculate a probability model for each listed instrument.' : original ? 'This check did not produce a quantitative model for this instrument.' : 'This instrument differs from the one used in the saved check. Its odds cannot be compared with that check’s model.'), note(workspaceScope === 'browse' ? 'Check a prediction, then open it in Your Reels to compare its original instrument with the saved model.' : 'Select the original checked contract, when available, for a comparison with its saved model.'));
  }
  const match = original ? result.market?.match : null;
  const quality = selectedContract.quality;
  const headline = expired ? 'Expired since retrieval' : workspaceScope === 'browse' ? 'Review conditions first' : !original || quote.prob === null || quality !== 'two-sided' ? 'Insufficient matching evidence' : match === 'exact' ? 'Review before trading' : 'Review conditions first';
  assessment.append(node('h3', 'assessment-title', headline));
  if (expired) {
    assessment.append(note('This contract’s deadline has passed. These are snapshot quotes, not currently tradable odds. Refresh the list and check the settlement status on Gemini.'));
    const refresh = node('button', 'quiet-button', 'Refresh market list'); refresh.type = 'button'; refresh.addEventListener('click', () => loadMarkets()); assessment.append(refresh);
  }
  if (workspaceScope === 'browse') assessment.append(note('This is a public market listing. No Reel claim is linked to it in this view. Read the contract’s settlement conditions and deadline on Gemini.'));
  else if (match === 'exact') assessment.append(note('The saved check matched this instrument’s strike and expiry. Verify its full resolution rules before drawing a conclusion.'));
  else if (original) assessment.append(note(result.matchNote || result.market?.matchReason || 'The saved check linked this contract to the claim. A link does not establish identical resolution conditions.'));
  else assessment.append(note('Shared topics or keywords do not establish that this event prices the original prediction. No quantitative advantage is calculated for this instrument.'));
  assessment.append(analyticsRow('Quote evidence', quality === 'two-sided' ? 'Two-sided quote' : quote.prob === null ? 'No usable quote' : 'Limited quote'));
  assessment.append(note(quality === 'two-sided' ? 'Bid and ask are available, but fees, liquidity and quote age still affect execution.' : 'A missing side, last trade, or absent price is insufficient evidence of an executable trading opportunity.'));
  if (original && Array.isArray(result.warnings)) for (const warning of result.warnings.slice(0, 3)) assessment.append(note(warning));
  assessment.append(note('Review evidence and contract rules. These relationships and model ranges are not instructions to buy or sell.'));
  if(result.report){
    const open=node('a','quiet-button','Open analysis');open.href=`/?analysis=${encodeURIComponent(selectedCheck.id)}`;assessment.append(open);
  }
  for(const panel of [modelPanel,assessment]){
    const notes=[...panel.querySelectorAll(':scope > .analytics-note:not(.model-snapshot-notice)')];
    if(notes.length){const details=node('details');details.append(node('summary','','Details & limits'),...notes);panel.append(details);}
  }
}

function clearLocalVideo() {
  const video = byId('source-video');
  if (video) { video.pause(); video.removeAttribute('src'); video.hidden = true; video.load(); }
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
  byId('source-video-upload').value = '';
  if (byId('source-clear-video')) byId('source-clear-video').hidden = true;
}
function renderSource() {
  clearLocalVideo();
  const sourceLink = byId('source-reel-link');
  const embedButton = byId('source-embed-button');
  const embedContainer = byId('source-embed-container');
  embedContainer.replaceChildren(); embedContainer.hidden = true;
  let placeholder = byId('source-panel').querySelector('.source-placeholder');
  if (!placeholder) { placeholder = node('div', 'source-placeholder'); byId('source-panel').prepend(placeholder); }
  placeholder.hidden = false;
  const sourceEntry = workspaceScope === 'related' ? selectedCheck : null;
  const reel = sourceEntry?.reelUrl ? parseSharedReel(sourceEntry.reelUrl) : null;
  const validReel = reel && !reel.error;
  content.classList.toggle('no-source',!validReel);
  sourceLink.hidden = !validReel; embedButton.hidden = !validReel;
  let sourceTitle = placeholder.querySelector('p');
  if (!sourceTitle) { sourceTitle = node('p'); placeholder.append(sourceTitle); }
  let sourceCaption = placeholder.querySelector(':scope > span:not(.viewfinder-corner)');
  if (!sourceCaption) { sourceCaption = node('span'); placeholder.append(sourceCaption); }
  if (validReel) {
    sourceLink.href = reel.url; sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer';
    sourceTitle.textContent = 'Your original Reel'; sourceCaption.textContent = '';
    setText('source-status', 'Preview loads from Instagram.');
  } else {
    sourceLink.removeAttribute('href');
    sourceTitle.textContent = 'No video attached'; sourceCaption.textContent = '';
    setText('source-status', workspaceScope === 'browse' ? 'Select an analysis to view its Reel.' : 'Local preview only. Not used for analysis.');
  }
  embedButton.textContent = 'Load Instagram preview';
}
byId('source-embed-button').addEventListener('click', () => {
  const sourceEntry = workspaceScope === 'related' ? selectedCheck : null;
  const reel = sourceEntry?.reelUrl ? parseSharedReel(sourceEntry.reelUrl) : null;
  if (!reel || reel.error) return;
  clearLocalVideo();
  const url = new URL(reel.url);
  const iframe = document.createElement('iframe');
  iframe.className = 'source-embed'; iframe.title = 'Instagram preview of the source Reel';
  iframe.src = `https://www.instagram.com${url.pathname.replace(/\/$/, '')}/embed/`;
  iframe.loading = 'lazy'; iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
  const container = byId('source-embed-container'); container.replaceChildren(iframe); container.hidden = false;
  byId('source-panel').querySelector('.source-placeholder').hidden = true;
  byId('source-embed-button').hidden = true;
  setText('source-status', 'Preview unavailable? Open the original Reel.');
});
byId('source-video-upload').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('video/')) { setText('source-status', 'Choose a video file to preview.'); event.target.value = ''; return; }
  if (file.size > 100 * 1024 * 1024) { setText('source-status', 'Choose a video smaller than 100 MB for a local preview.'); event.target.value = ''; return; }
  clearLocalVideo();
  videoUrl = URL.createObjectURL(file);content.classList.remove('no-source');
  const video = byId('source-video'); video.src = videoUrl; video.hidden = false;
  video.controls = true; video.preload = 'metadata'; video.playsInline = true;
  byId('source-embed-container').replaceChildren(); byId('source-embed-container').hidden = true;
  byId('source-panel').querySelector('.source-placeholder').hidden = true;
  byId('source-embed-button').hidden = true;
  if (byId('source-clear-video')) byId('source-clear-video').hidden = false;
  setText('source-status', `${file.name} · Local preview only. This video is not uploaded, transcribed, or part of the saved analysis.`);
});
byId('source-video').addEventListener('error', () => { if (videoUrl) setText('source-status', 'This browser could not play that video format. Choose a different local video.'); });
byId('source-clear-video')?.addEventListener('click', renderSource);
addEventListener('pagehide', () => { if (videoUrl) URL.revokeObjectURL(videoUrl); });

function sectorName() {
  if (category.value) return category.selectedOptions[0]?.textContent || category.value;
  const button = [...(byId('market-sectors')?.querySelectorAll('[data-sector]') || [])].find(item => item.dataset.sector === sector);
  return sector === 'all' ? 'All markets' : button?.textContent.trim() || titleCase(sector.replaceAll('-', ' '));
}
function renderScope() {
  setText('workspace-context', workspaceScope === 'related' ? 'Your analyses' : 'Gemini prediction markets');
  const relevanceOption = byId('workspace-sort')?.querySelector('[value="relevance"]');
  if (relevanceOption) { relevanceOption.disabled = workspaceScope === 'browse'; relevanceOption.hidden = workspaceScope === 'browse'; }
  for (const button of byId('workspace-scope')?.querySelectorAll('[data-scope]') || []) {
    const selected = button.dataset.scope === workspaceScope;
    button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('is-active', selected);
  }
  for (const button of byId('market-sectors')?.querySelectorAll('[data-sector]') || []) {
    const selected = workspaceScope === 'browse' && button.dataset.sector === sector;
    button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('is-active', selected);
  }
  const sectors = byId('market-sectors');
  if (sectors) {
    sectors.hidden = false;
    const active = sectors.querySelector('[aria-pressed="true"]');
    if (active) requestAnimationFrame(() => {
      if (active.getAttribute('aria-pressed') !== 'true') return;
      const viewport = sectors.getBoundingClientRect(), item = active.getBoundingClientRect();
      if (item.left < viewport.left || item.right > viewport.right) sectors.scrollTo({ left: sectors.scrollLeft + item.left - viewport.left - (viewport.width - item.width) / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
  }
}
function renderBrowseHeading() {
  const label = sectorName();
  setText('selected-claim', label === 'All markets' ? 'All prediction markets' : label);
  setText('selected-claim-meta', 'Public market directory');
}
function browseMarkets(nextSector = 'all') {
  controller?.abort(); clearTimeout(searchTimer);
  workspaceScope = 'browse'; sortOrder = 'expiry'; if (byId('workspace-sort')) byId('workspace-sort').value = sortOrder; sector = nextSector; category.value = ''; search.value = ''; graphPositions.clear(); zoom = 1;
  const url = new URL(location.href); url.searchParams.set('scope', 'browse');
  if (sector === 'all') url.searchParams.delete('sector'); else url.searchParams.set('sector', sector);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  renderScope(); renderChecks(); renderBrowseHeading(); renderSource(); loadMarkets();
}
function sortEvents() {
  events.sort(sortOrder === 'relevance' ? (a, b) => a._rank - b._rank : sortOrder === 'title' ? (a, b) => a.title.localeCompare(b.title) : (a, b) => (Date.parse(a.expiryDate) || Infinity) - (Date.parse(b.expiryDate) || Infinity));
}
byId('workspace-scope')?.addEventListener('click', event => {
  const button = event.target.closest('[data-scope]');
  if (!button) return;
  if (button.dataset.scope === 'browse') browseMarkets();
  else if (selectedCheck || checks.length) chooseCheck(selectedCheck || checks[0]);
  else { controller?.abort(); ++requestSerial; clearTimeout(searchTimer); workspaceScope = 'related'; const url = new URL(location.href); url.searchParams.delete('scope'); url.searchParams.delete('sector'); history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); renderScope(); renderChecks(); status('Run a check to connect a Reel claim to market evidence, or browse all markets.'); }
});
byId('market-sectors')?.addEventListener('click', event => { const button = event.target.closest('[data-sector]'); if (button) browseMarkets(button.dataset.sector); });
byId('browse-all-markets')?.addEventListener('click', () => browseMarkets());
byId('workspace-sort')?.addEventListener('change', event => { sortOrder = ['relevance', 'title', 'expiry'].includes(event.target.value) ? event.target.value : 'expiry'; sortEvents(); graphPositions.clear(); renderViews(); });

byId('workspace-views').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view); });
byId('workspace-views').addEventListener('keydown', event => {
  const views = ['graph', 'quotes', 'cards', 'timeline'];
  let next;
  if (event.key === 'ArrowRight') next = (views.indexOf(activeView) + 1) % views.length;
  else if (event.key === 'ArrowLeft') next = (views.indexOf(activeView) + views.length - 1) % views.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = views.length - 1;
  if (next !== undefined) { event.preventDefault(); setView(views[next], true); }
});
byId('workspace-refresh').addEventListener('click', () => { clearTimeout(searchTimer); loadMarkets({refreshReport:true}); });
byId('workspace-event-select').addEventListener('change', event => { const selected = events[Number(event.target.value)]; if (selected) selectEvent(selected); });
addEventListener('keydown', event => {
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable) { event.preventDefault(); search.focus(); }
});
byId('graph-zoom-in')?.addEventListener('click', () => { zoom = Math.min(1.5, +(zoom + .15).toFixed(2)); updateZoom(); });
byId('graph-zoom-out')?.addEventListener('click', () => { zoom = Math.max(.75, +(zoom - .15).toFixed(2)); updateZoom(); });
byId('graph-reset')?.addEventListener('click', () => { zoom = 1; graphPositions.clear(); renderGraph(); updateZoom(); });
byId('workspace-retry').addEventListener('click', () => loadMarkets({ append: retryAppend }));
byId('workspace-more')?.addEventListener('click', () => loadMarkets({ append: true }));
search.addEventListener('input', () => {
  clearTimeout(searchTimer); controller?.abort(); ++requestSerial;
  if (byId('workspace-more')) { byId('workspace-more').hidden = true; byId('workspace-more').disabled = true; }
  status('Updating markets…');
  searchTimer = setTimeout(loadMarkets, 300);
});
category.addEventListener('change', () => { clearTimeout(searchTimer); graphPositions.clear(); if (workspaceScope === 'browse') { sector = 'all'; renderScope(); renderBrowseHeading(); } loadMarkets(); });
function finishEmptyWorkspace() {
  controller?.abort(); ++requestSerial; clearTimeout(searchTimer);
  checks = []; selectedCheck = null;
  // Tear down both object URLs and third-party iframe playback even while hidden.
  renderSource(); resetListing(); renderChecks();
  const url = new URL(location.href); url.searchParams.delete('check'); history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  content.setAttribute('aria-busy', 'false');
  status('This session’s checks were cleared.');
  if (workspaceScope === 'browse') loadMarkets();
}
byId('clear-workspace').addEventListener('click', () => {
  const cleared = clearChecks();
  if (!cleared.ok) { status('The workspace could not be cleared because browser storage is unavailable. Your checks are still listed. Try again when storage is available.', true); return; }
  finishEmptyWorkspace();
});
byId('selected-check-remove')?.addEventListener('click', () => {
  if (!selectedCheck || workspaceScope === 'browse') return;
  const removed = removeCheck(selectedCheck.id);
  if (!removed.ok) { status('This check could not be removed because browser storage is unavailable. It remains in your workspace. Try again when storage is available.', true); return; }
  checks = removed.checks;
  if (checks.length) chooseCheck(checks[0]);
  else finishEmptyWorkspace();
});

if (byId('workspace-sort') && !byId('workspace-sort').querySelector('[value="relevance"]')) {
  const option = node('option', '', 'Closest to claim'); option.value = 'relevance'; byId('workspace-sort').prepend(option); byId('workspace-sort').value = sortOrder;
}
for (const button of byId('market-sectors')?.querySelectorAll('[data-sector]') || []) {
  if (button.dataset.sector === 'all') continue;
  const value = button.textContent.trim();
  if (![...category.options].some(option => option.value === value)) { const option = node('option', '', value); option.value = value; category.append(option); }
}
addEventListener('themechange', () => { if (selectedEvent) renderInspector(); });
renderScope(); renderChecks(); setView(activeView);
const launch = new URL(location.href);
if (launch.searchParams.get('scope') === 'browse') {
  selectedCheck = checks.find(entry => entry.id === launch.searchParams.get('check')) || checks[0] || null;
  const requestedSector = launch.searchParams.get('sector') || 'all';
  const allowed = [...(byId('market-sectors')?.querySelectorAll('[data-sector]') || [])].some(button => button.dataset.sector === requestedSector);
  browseMarkets(allowed ? requestedSector : 'all');
} else if (checks.length) {
  chooseCheck(checks.find(entry => entry.id === launch.searchParams.get('check')) || checks[0]);
}
