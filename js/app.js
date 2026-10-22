// Ghetto Wayz — app entry: wires map, routing, search, navigation and the community screens.
import { config, integrations } from './config.js';
import { $, $$, el, esc, haversine, distanceToLine, fmtDistance, fmtDuration, bearing, MODES, uid } from './util.js';
import { state, set, subscribe, selectedRoute } from './state.js';
import { GwMap } from './map.js';
import { createRoutingProvider } from './providers/routing.js';
import { createGeocoder, searchSamplePlaces, reverseGeocode } from './providers/geocoding.js';
import { SAMPLE_PLACES } from './providers/sampleData.js';
import { createBackend } from './backend/index.js';
import { ALERT_CATEGORIES } from './backend/rules.js';
import { renderSheet, collapse, hideSheet, toast, statusStrip } from './ui/sheet.js';
import { openModal, closeModal } from './ui/modal.js';
import { openReportFlow, openAlertDetail, alertsNearRoute } from './ui/alerts.js';
import { startSuggestPath, openPathDetail } from './ui/paths.js';
import { openAccount, requireSignIn, updateAvatar, openAppearance } from './ui/account.js';
import { createRealtime } from './providers/realtime.js';
import { openFriends, openShareTrip, openCheckIn, renderShareBanner, openShareViewer, freshness } from './ui/friends.js';

// ---------- services ----------
export const ctx = {
  backend: createBackend(),
  routing: createRoutingProvider(),
  geocoder: createGeocoder(),
  map: null,
  realtime: null,
  shares: [],
  activeTripShare: null,   // outgoing trip share id while navigating
  refreshData,
  locate: (o) => locate(o),
  focusShare,
  redrawMap() {
    ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute, { fit: false });
    ctx.map.renderPaths(state.paths, { showPending: state.layers.pending, myId: state.user?.id });
    ctx.map.renderFriends(ctx.shares, { freshness, onClick: (s) => openShareViewer(ctx, s) });
    if (state.position) { ctx.map.setMe(null); ctx.map.setMe(state.position); }
  },
  planRoute,
  setDestination,
  showHome,
};

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

ctx.map = new GwMap($('#map'), {
  onAlertClick: (a) => openAlertDetail(ctx, a),
  onPathClick: (p) => openPathDetail(ctx, p),
  onMapTap: (ll) => onMapTap(ll),
  onDrawPoint: (ll) => ctx.onDrawPoint?.(ll),
});

await Promise.race([ctx.backend.ready || Promise.resolve(), new Promise((r) => setTimeout(r, 6000))]); // never block the UI on auth
set({ user: ctx.backend.currentUser() });
ctx.backend.onChange(() => { set({ user: ctx.backend.currentUser() }); refreshData(); });
ctx.realtime = await createRealtime(ctx.backend);
ctx.realtime.onUpdate(refreshShares);
updateAvatar();
refreshData();
showHome();
if (!ctx.backend.isShared) statusStrip('Demo mode · data is stored on this device only and is not shared');
window.addEventListener('online', () => set({ online: true }));
window.addEventListener('offline', () => set({ online: false }));
subscribe((_, patch) => { if ('online' in patch) toast(state.online ? 'Back online' : 'You are offline — search and live routing are unavailable', state.online ? 'success' : 'error'); });

// ---------- sharing data ----------
let lastShareIds = '';
async function refreshShares() {
  if (!state.user) { ctx.shares = []; ctx.map.renderFriends([]); renderShareBanner(ctx, []); return; }
  const shares = await ctx.backend.listShares();
  ctx.shares = shares;
  ctx.map.renderFriends(shares, { freshness, onClick: (s) => openShareViewer(ctx, s) });
  renderShareBanner(ctx, shares);
  // notify about new incoming shares
  const incoming = shares.filter((s) => s.direction === 'incoming' && s.status !== 'ended');
  const ids = incoming.map((s) => s.id).join(',');
  if (ids && ids !== lastShareIds) {
    for (const s of incoming) if (!lastShareIds.includes(s.id)) toast(`${s.from.alias} is sharing their ${s.type === 'trip' ? 'trip' : 'location'} with you — tap Friends › Sharing to view`);
  }
  lastShareIds = ids;
  // my active trip share ended remotely (blocked / expired)?
  if (ctx.activeTripShare && !shares.some((s) => s.id === ctx.activeTripShare && s.status !== 'ended')) ctx.activeTripShare = null;
}
function focusShare(id) {
  const s = ctx.shares.find((x) => x.id === id);
  if (!s) return;
  if (s.lastPos) ctx.map.flyTo([s.lastPos.lat, s.lastPos.lng], 16);
  openShareViewer(ctx, s);
}

// ---------- data ----------
async function refreshData() {
  const [alerts, paths] = await Promise.all([ctx.backend.listAlerts().catch(() => []), ctx.backend.listPaths().catch(() => [])]);
  if (ctx.backend.cacheAliases) await ctx.backend.cacheAliases([...alerts.map((a) => a.createdBy), ...paths.map((p) => p.createdBy)]);
  set({ alerts, paths });
  ctx.map.renderAlerts(alerts);
  ctx.map.renderPaths(paths, { showPending: state.layers.pending, myId: state.user?.id });
  updateAvatar();
  if (!state.destination && !state.navigating && !state.draw && !ctx.pickingOrigin) showHome();
  refreshShares();
}

// ---------- home sheet ----------
function showHome() {
  set({ destination: null, routes: [], selectedRouteId: null, routeError: null });
  ctx.map.clearRoutes(); ctx.map.setDestination(null); ctx.map.setOrigin(null);
  hideSheet(false); collapse(false);
  const live = integrations.routing !== 'sample';
  const nearby = state.alerts.length;
  const quick = SAMPLE_PLACES.slice(0, 4);
  renderSheet([
    el('div', { class: 'sheet-title' },
      el('h2', {}, 'Where to?'),
      el('span', { class: `chip ${live ? 'live' : 'sample'}` }, live ? 'Live routing' : 'Sample routes')),
    el('p', { class: 'muted small', style: 'margin:0 0 10px' },
      live ? 'Routes use public ways from OpenStreetMap. Community paths show once moderators approve them.'
           : 'No routing key is configured, so routes between these sample places are hand-made examples. Other destinations get a labelled straight-line estimate.'),
    el('div', { class: 'row wrap', style: 'margin-bottom:12px' },
      ...quick.map((p) => el('button', { class: 'btn sm', onclick: () => setDestination({ ...p, source: 'sample' }) }, p.kind === 'park' ? '🌳' : p.kind === 'transport' ? '🚉' : '📍', ' ', p.name.replace('Coventry ', '')))),
    el('div', { class: 'row between', style: 'margin-bottom:6px' },
      el('div', { class: 'stat' }, el('strong', {}, String(nearby)), el('span', {}, 'active alerts nearby')),
      el('div', { class: 'stat' }, el('strong', {}, String(state.paths.filter((p) => p.status === 'approved').length)), el('span', {}, 'community paths approved')),
      el('button', { class: 'btn sm', onclick: () => openAlertsList() }, 'View alerts')),
    state.user
      ? el('div', { class: 'notice info' }, `Signed in as ${esc(state.user.alias)}. Report hazards or suggest missing paths from the buttons on the map.`)
      : el('div', { class: 'notice' }, 'You are exploring as a guest. Sign in to report alerts, suggest paths and earn points. ',
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); openAccount(ctx); } }, 'Sign in / create account')),
    el('p', { class: 'small', style: 'color:var(--text-3);margin:8px 0 0' }, 'Route labels describe what a route is built from — they are not safety ratings. Always use your own judgement. ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); openAppearance(ctx); } }, 'Change colourway')),
  ]);
}

function openAlertsList() {
  const list = state.alerts;
  openModal('Community alerts', [
    el('p', { class: 'muted small' }, 'Reports are from the community. "Verified" means a moderator checked it; "Awaiting confirmation" means it has not been reviewed yet. Alerts expire automatically unless renewed.'),
    list.length ? el('div', { class: 'list' }, ...list.map((a) => alertRow(a))) : el('div', { class: 'empty' }, el('div', { class: 'big' }, '🗺️'), 'No active alerts around here.'),
  ]);
}
export function alertRow(a) {
  const cat = ALERT_CATEGORIES[a.category];
  return el('button', { class: 'item', style: 'text-align:left;border:0;width:100%', onclick: () => { closeModal(); ctx.map.flyTo([a.lat, a.lng], 17); openAlertDetail(ctx, a); } },
    el('div', { class: 'emoji' }, cat.emoji),
    el('div', { class: 'body' },
      el('div', { class: 't' }, cat.label),
      el('div', { class: 's' }, a.note || 'No details given'),
      el('div', { class: 'meta' },
        el('span', { class: `chip ${a.status}` }, a.status === 'verified' ? 'Verified' : 'Awaiting confirmation'),
        a.communityConfirmed && el('span', { class: 'chip accent' }, `${a.confirmations.length} confirmed`),
        a.sample && el('span', { class: 'chip sample' }, 'Sample'))));
}

// ---------- search ----------
const input = $('#searchInput'), results = $('#searchResults'), clearBtn = $('#searchClear');
let searchTimer = null;
input.addEventListener('input', () => {
  clearBtn.hidden = !input.value;
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (q.length < 2) { results.hidden = true; return; }
  searchTimer = setTimeout(() => runSearch(q), 320);
});
input.addEventListener('focus', () => { if (input.value.trim().length >= 2) results.hidden = false; });
clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; results.hidden = true; input.focus(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.searchbox') && !e.target.closest('.search-results')) results.hidden = true; });

async function runSearch(q) {
  const near = state.position ? [state.position.lat, state.position.lng] : ctx.map.center();
  const sample = searchSamplePlaces(q, near);
  renderResults(sample, { loading: state.online });
  if (!state.online) { renderResults(sample, { note: 'Offline — showing sample places only.' }); return; }
  try {
    const live = await ctx.geocoder.search(q, { near });
    renderResults([...sample, ...live.filter((l) => !sample.some((s) => haversine([s.lat, s.lng], [l.lat, l.lng]) < 60))], { note: live.length ? 'Search results © OpenStreetMap contributors' : null });
  } catch (e) {
    if (e.name === 'AbortError') return;
    renderResults(sample, { note: 'Live search unavailable right now — showing sample places.' });
  }
}
function renderResults(places, { loading, note } = {}) {
  results.replaceChildren(
    ...places.map((p) => el('button', { class: 'result', onclick: () => { results.hidden = true; input.value = p.name; clearBtn.hidden = false; setDestination(p); } },
      el('div', { class: 'result-ico' }, p.source === 'sample' ? '🧭' : '📍'),
      el('div', {}, el('div', { class: 'result-name' }, p.name), el('div', { class: 'result-sub' }, p.sub, p.source === 'sample' ? ' · sample place' : '')))),
    loading ? el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Searching OpenStreetMap…') : null,
    !loading && !places.length ? el('div', { class: 'result-note' }, 'No matches. Try a street, venue or postcode.') : null,
    note ? el('div', { class: 'result-note' }, note) : null,
  );
  results.hidden = false;
}

// ---------- destination & origin ----------
async function setDestination(place) {
  set({ destination: place, routes: [], selectedRouteId: null, routeError: null });
  ctx.map.setDestination(place);
  ctx.map.flyTo([place.lat, place.lng], 16);
  if (state.position) {
    set({ origin: { lat: state.position.lat, lng: state.position.lng, name: 'Your location', source: 'gps' } });
    planRoute();
  } else if (state.origin && state.origin.source !== 'gps') {
    planRoute();
  } else {
    showOriginPicker();
  }
}

function showOriginPicker() {
  hideSheet(false); collapse(false);
  renderSheet([
    el('div', { class: 'sheet-title' }, el('h2', {}, `To ${esc(state.destination.name)}`), el('button', { class: 'btn sm ghost', onclick: showHome }, 'Change')),
    el('p', { class: 'muted small' }, 'Where are you starting from?'),
    el('div', { class: 'stack' },
      el('button', { class: 'btn primary block', onclick: () => locate({ thenRoute: true }) }, '📡 Use my location'),
      el('button', { class: 'btn block', onclick: () => { toast('Tap the map where you want to start'); ctx.pickingOrigin = true; } }, '🗺️ Choose a start point on the map'),
      el('div', { class: 'row wrap' }, ...SAMPLE_PLACES.slice(0, 3).map((p) => el('button', { class: 'btn sm', onclick: () => { set({ origin: { lat: p.lat, lng: p.lng, name: p.name, source: 'place' } }); ctx.map.setOrigin(state.origin); planRoute(); } }, 'From ', p.name.replace('Coventry ', ''))))),
    el('p', { class: 'small', style: 'color:var(--text-3);margin-top:10px' }, 'Your location is only used on this device to plan and follow the route. It is never stored or shared.'),
  ]);
}

function onMapTap(ll) {
  if (ctx.pickingOrigin) {
    ctx.pickingOrigin = false;
    set({ origin: { lat: ll[0], lng: ll[1], name: 'Map point', source: 'map' } });
    ctx.map.setOrigin(state.origin);
    reverseGeocode(ll[0], ll[1]).then((n) => { if (n && state.origin?.source === 'map') { state.origin.name = n; ctx.map.setOrigin(state.origin); } });
    if (state.destination) planRoute();
    return;
  }
  if (ctx.pickingAlert) {
    ctx.pickingAlert = false;
    openReportFlow(ctx, ll);
    return;
  }
  // Tap on empty map: offer "route here"
  if (!state.destination && !state.navigating) {
    const place = { id: 'pt-' + uid(), name: 'Dropped pin', sub: `${ll[0].toFixed(4)}, ${ll[1].toFixed(4)}`, lat: ll[0], lng: ll[1], source: 'map' };
    ctx.map.setDestination(place);
    renderSheet([
      el('div', { class: 'sheet-title' }, el('h2', {}, 'Dropped pin'), el('button', { class: 'btn sm ghost', onclick: showHome }, 'Clear')),
      el('p', { class: 'muted small' }, place.sub),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', onclick: () => setDestination(place) }, 'Route here'),
        el('button', { class: 'btn', onclick: () => requireSignIn(ctx, 'report an alert') && openReportFlow(ctx, ll) }, 'Report here')),
    ]);
    reverseGeocode(ll[0], ll[1]).then((n) => { if (n) { place.name = n; ctx.map.setDestination(place); } });
  }
}

// ---------- geolocation ----------
let watchId = null;
function locate({ thenRoute = false, follow = false, onFirst = null } = {}) {
  if (!('geolocation' in navigator)) { set({ locationStatus: 'unavailable' }); toast('Location is not available on this device', 'error'); return; }
  set({ locationStatus: 'asking' });
  const onPos = (p) => {
    const pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading };
    const first = !state.position;
    set({ position: pos, locationStatus: 'ok' });
    ctx.map.setMe(pos);
    if (first || !follow) ctx.map.flyTo([pos.lat, pos.lng], 16);
    if (thenRoute && state.destination && first) {
      set({ origin: { lat: pos.lat, lng: pos.lng, name: 'Your location', source: 'gps' } });
      ctx.map.setOrigin(null);
      planRoute();
    }
    if (state.navigating) onNavTick(pos);
    if (first && onFirst) onFirst();
    pushPosition(pos);
  };
  const onErr = (e) => {
    set({ locationStatus: e.code === 1 ? 'denied' : 'unavailable' });
    if (e.code === 1) {
      toast('Location permission was denied. You can still pick a start point on the map.', 'error');
      if (state.destination && !state.origin) showOriginPicker();
    } else toast('Could not get your location right now.', 'error');
  };
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}
$('#locateBtn').addEventListener('click', () => {
  if (state.position) { ctx.map.flyTo([state.position.lat, state.position.lng], 16); return; }
  openModal('Use your location?', [
    el('p', {}, 'Ghetto Wayz uses your location to show where you are, plan routes from here and follow the route while navigating.'),
    el('p', { class: 'muted small' }, 'Your location stays on this device. We do not store a history of where you go, and your reports never include your live position.'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => { closeModal(); locate(); } }, 'Allow'), el('button', { class: 'btn', onclick: closeModal }, 'Not now')),
  ]);
});

// Push my position to every active outgoing share (throttled). Only the latest sample is kept server-side.
let lastPush = 0;
function pushPosition(pos) {
  if (!state.user || Date.now() - lastPush < 4000) return;
  const outgoing = ctx.shares.filter((s) => s.direction === 'outgoing' && s.status === 'active');
  if (!outgoing.length) return;
  lastPush = Date.now();
  for (const s of outgoing) ctx.backend.updateSharePosition(s.id, { lat: pos.lat, lng: pos.lng }).catch(() => {});
}

// ---------- routing ----------
async function planRoute() {
  if (!state.destination || !state.origin) return;
  const dest = state.destination, origin = state.origin;
  set({ routing: true, routeError: null, routes: [], selectedRouteId: null });
  renderRouteSheet();
  try {
    if (haversine([origin.lat, origin.lng], [dest.lat, dest.lng]) < 15) throw new Error('You are already there.');
    const result = await ctx.routing.route({ from: [origin.lat, origin.lng], to: [dest.lat, dest.lng], mode: state.mode });
    if (state.destination !== dest) return; // stale
    const routes = annotateRoutes(result.routes);
    set({ routes, routeProvider: result.provider, selectedRouteId: routes[0]?.id || null, routing: false });
  } catch (e) {
    set({ routing: false, routeError: e.message || 'Routing failed' });
  }
  ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute);
  renderRouteSheet();
}

/** Adds community-path coverage, nearby alerts and friendly labels to each route. */
function annotateRoutes(routes) {
  const approved = state.paths.filter((p) => p.status === 'approved');
  for (const r of routes) {
    const used = new Set(r.communityPathIds || []);
    for (const p of approved) {
      const hits = p.points.filter((pt) => distanceToLine(pt, r.geometry) < 25).length;
      if (hits >= Math.max(2, Math.ceil(p.points.length * .6))) used.add(p.id);
    }
    r.communityPathIds = [...used];
    r.alertsNear = alertsNearRoute(state.alerts, r.geometry, 40);
  }
  const withPaths = routes.filter((r) => r.source !== 'estimate' && r.communityPathIds.length > 0);
  const mostPaths = withPaths.length && routes.length > 1 ? withPaths.reduce((a, b) => (a.communityPathIds.length >= b.communityPathIds.length ? a : b)) : null;
  const rest = routes.filter((r) => r !== mostPaths && r.source !== 'estimate');
  const fastest = rest.length ? rest.reduce((a, b) => (a.durationS <= b.durationS ? a : b)) : null;
  for (const r of routes) {
    if (r.source === 'estimate') continue;
    if (r === mostPaths) r.label = 'More verified paths';
    else if (r === fastest) r.label = 'Quickest';
    else if (r.label === 'Quickest' || r.label === 'More verified paths') r.label = 'Alternative';
  }
  return routes;
}

function selectRoute(id) {
  set({ selectedRouteId: id });
  ctx.map.renderRoutes(state.routes, id, state.mode, selectRoute);
  renderRouteSheet();
}

function renderRouteSheet() {
  hideSheet(false); collapse(false);
  const dest = state.destination, r = selectedRoute();
  const head = el('div', { class: 'sheet-title' },
    el('div', {}, el('h2', {}, esc(dest.name)), el('div', { class: 'muted small' }, `From ${esc(state.origin?.name || '…')} · ${MODES[state.mode].emoji} ${MODES[state.mode].label}`)),
    el('button', { class: 'btn sm ghost', onclick: showHome }, 'Close'));
  if (state.routing) return renderSheet([head, el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Finding routes…')]);
  if (state.routeError) return renderSheet([head,
    el('div', { class: 'notice danger' }, state.routeError),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: planRoute }, 'Try again'), el('button', { class: 'btn', onclick: () => { ctx.pickingOrigin = true; toast('Tap the map to choose a start point'); } }, 'Change start'))]);
  if (!state.routes.length) return renderSheet([head, el('div', { class: 'empty' }, el('div', { class: 'big' }, '🤷'), 'No route found for this mode.')]);

  const cards = el('div', { class: 'route-list' }, ...state.routes.map((rt) => el('button', {
    class: `route-card ${rt.id === state.selectedRouteId ? 'selected' : ''}`, style: `--route-color:${MODES[state.mode].hex}`, onclick: () => selectRoute(rt.id) },
    el('span', { class: 'bar' }),
    el('div', {},
      el('div', { class: 'label' }, rt.label, el('span', { class: `chip ${rt.source}` }, rt.source === 'live' ? 'Live' : rt.source === 'sample' ? 'Sample' : 'Estimate'),
        rt.communityPathIds.length ? el('span', { class: 'chip verified' }, `${rt.communityPathIds.length} community path${rt.communityPathIds.length > 1 ? 's' : ''}`) : null,
        rt.alertsNear.length ? el('span', { class: 'chip pending' }, `${rt.alertsNear.length} alert${rt.alertsNear.length > 1 ? 's' : ''}`) : null),
      el('div', { class: 'basis' }, labelBasis(rt))),
    el('div', { class: 'stats' }, el('strong', {}, fmtDuration(rt.durationS)), el('span', {}, fmtDistance(rt.distanceM))))));

  const alertsBlock = r.alertsNear.length
    ? el('div', {}, el('h3', { style: 'font-size:14px;margin:8px 0 6px' }, 'Alerts along this route'), el('div', { class: 'list' }, ...r.alertsNear.map(alertRow)))
    : null;

  const steps = el('ul', { class: 'steps' }, ...r.steps.map((s, i) => el('li', {}, el('span', { class: 'ic' }, i === r.steps.length - 1 ? '🏁' : '→'), el('span', {}, s.text), el('span', { class: 'd' }, fmtDistance(s.dist)))));

  renderSheet([head, cards,
    el('div', { class: `notice ${r.source === 'estimate' ? 'warn' : 'info'}` }, r.basis),
    el('div', { class: 'row', style: 'margin:10px 0' },
      el('button', { class: 'btn primary block', onclick: startNavigation }, r.source === 'estimate' ? 'Start (estimate only)' : 'Start navigation'),
      el('button', { class: 'btn', onclick: () => { ctx.pickingOrigin = true; toast('Tap the map to choose a new start point'); } }, 'Start point')),
    alertsBlock,
    el('h3', { style: 'font-size:14px;margin:12px 0 4px' }, 'Directions'), steps,
    el('p', { class: 'small', style: 'color:var(--text-3)' }, 'Community paths are user suggestions approved by moderators for inclusion on the map. Alerts are community reports and may be out of date. Nothing here is a guarantee of safety or legality — follow signs and local rules.'),
  ]);
}
function labelBasis(rt) {
  if (rt.label === 'Quickest') return 'Shortest estimated time for this mode.';
  if (rt.label === 'More verified paths') return 'Uses more moderator-approved community paths. Approval means the path is on the map — not a safety rating.';
  if (rt.source === 'estimate') return 'Straight-line estimate — no real path data.';
  return 'Alternative route from the routing provider.';
}

// mode switcher
$$('#modebar button').forEach((b) => b.addEventListener('click', () => {
  $$('#modebar button').forEach((x) => x.setAttribute('aria-selected', x === b));
  set({ mode: b.dataset.mode });
  if (state.destination && state.origin) planRoute();
}));

// ---------- navigation ----------
async function startNavigation() {
  const r = selectedRoute();
  if (!r) return;
  if (state.user && r.source !== 'estimate') {
    const social = await ctx.backend.listSocial();
    if (social.friends.length) {
      openShareTrip(ctx, (share) => { ctx.activeTripShare = share?.id || null; beginNavigation(r); if (share) toast(`Sharing this trip with ${share.to.alias} — ends when you arrive or stop`, 'success'); });
      return;
    }
  }
  beginNavigation(r);
}
function beginNavigation(r) {
  arrivedShown = false;
  set({ navigating: true });
  hideSheet(true);
  $('#navbar').hidden = false; $('#fabs').hidden = true; $('#modebar').hidden = true; $('.topbar').hidden = true;
  ctx.map.renderRoutes([r], r.id, state.mode, () => {});
  $('#endNavBtn').onclick = endNavigation;
  if (state.position) { onNavTick(state.position); locate({ follow: true }); }
  else {
    openModal('Follow along?', [
      el('p', {}, 'To follow your progress, Ghetto Wayz needs your location while navigating. Without it, you can still read the directions.'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => { closeModal(); locate({ follow: true }); } }, 'Use location'), el('button', { class: 'btn', onclick: () => { closeModal(); showStep(0, r); } }, 'Just show steps')),
    ]);
    showStep(0, r);
  }
}
function endNavigation() {
  const r = selectedRoute(), dest = state.destination;
  const shareId = ctx.activeTripShare;
  const finish = () => {
    if (shareId) ctx.backend.stopShare(shareId, 'cancelled').catch(() => {});
    ctx.activeTripShare = null;
    exitNavigationUi();
  };
  if (state.user && r && dest && r.source !== 'estimate') {
    openCheckIn(ctx, { shareId, route: r, dest }, (res) => { if (res) { ctx.activeTripShare = null; exitNavigationUi(); } else finish(); });
  } else finish();
}
let arrivedShown = false;
function exitNavigationUi() {
  set({ navigating: false });
  $('#navbar').hidden = true; $('#fabs').hidden = false; $('#modebar').hidden = false; $('.topbar').hidden = false;
  hideSheet(false);
  ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute);
  renderRouteSheet();
}
function showStep(i, r, remainingM) {
  const step = r.steps[Math.min(i, r.steps.length - 1)];
  $('#navInstr').textContent = step?.text || 'Continue';
  $('#navSub').textContent = step ? `${fmtDistance(step.dist)} · step ${Math.min(i, r.steps.length - 1) + 1} of ${r.steps.length}` : '';
  $('#navIcon').textContent = /left/i.test(step?.text) ? '↰' : /right/i.test(step?.text) ? '↱' : i >= r.steps.length - 1 ? '🏁' : '↑';
  const rem = remainingM ?? r.distanceM;
  $('#navRemain').textContent = `${fmtDistance(rem)} left`;
  const eta = new Date(Date.now() + (rem / MODES[state.mode].speed) * 1000);
  $('#navEta').textContent = `${eta.getHours()}:${String(eta.getMinutes()).padStart(2, '0')}`;
}
function onNavTick(pos) {
  const r = selectedRoute(); if (!r) return;
  const me = [pos.lat, pos.lng];
  // find nearest vertex, compute remaining distance and current step by cumulative distance
  let bestI = 0, bestD = Infinity;
  r.geometry.forEach((g, i) => { const d = haversine(me, g); if (d < bestD) { bestD = d; bestI = i; } });
  let remaining = 0; for (let i = bestI; i < r.geometry.length - 1; i++) remaining += haversine(r.geometry[i], r.geometry[i + 1]);
  const done = r.distanceM - remaining;
  let acc = 0, stepI = 0;
  for (let i = 0; i < r.steps.length; i++) { acc += r.steps[i].dist; if (done < acc) { stepI = i; break; } stepI = i; }
  if (haversine(me, r.geometry[r.geometry.length - 1]) < 25) {
    showStep(r.steps.length - 1, r, 0);
    if (!arrivedShown) { arrivedShown = true; toast('You have arrived 🎉', 'success'); if (state.user && r.source !== 'estimate') endNavigation(); }
    return;
  }
  if (bestD > 80) toast('You look off-route — directions may not match where you are', 'error');
  showStep(stepI, r, remaining);
  ctx.map.map.panTo(me, { animate: true });
}

// ---------- map controls, layers, fabs ----------
$('#zoomIn').addEventListener('click', () => ctx.map.zoomIn());
$('#zoomOut').addEventListener('click', () => ctx.map.zoomOut());
$('#layersBtn').addEventListener('click', () => { $('#layersPanel').hidden = !$('#layersPanel').hidden; });
$('#layerAlerts').addEventListener('change', (e) => { state.layers.alerts = e.target.checked; ctx.map.toggleAlerts(e.target.checked); });
$('#layerPaths').addEventListener('change', (e) => { state.layers.paths = e.target.checked; ctx.map.togglePaths(e.target.checked); });
$('#layerPending').addEventListener('change', (e) => { state.layers.pending = e.target.checked; ctx.map.renderPaths(state.paths, { showPending: e.target.checked, myId: state.user?.id }); });
$('#brandBtn').addEventListener('click', () => { closeModal(); if (!state.navigating) showHome(); });
$('#profileBtn').addEventListener('click', () => openAccount(ctx));
$('#reportBtn').addEventListener('click', () => {
  if (!requireSignIn(ctx, 'report an alert')) return;
  if (state.position) openReportFlow(ctx, [state.position.lat, state.position.lng], { fromGps: true });
  else { ctx.pickingAlert = true; toast('Tap the map where the issue is'); }
});
$('#suggestBtn').addEventListener('click', () => { if (requireSignIn(ctx, 'suggest a path')) startSuggestPath(ctx); });
$('#friendsBtn').addEventListener('click', () => openFriends(ctx));
