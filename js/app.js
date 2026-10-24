// GettoWayz — app entry: wires map, routing, search, navigation and the community screens.
import { config, integrations } from './config.js';
import { $, $$, el, esc, haversine, distanceToLine, fmtDistance, fmtDuration, bearing, MODES, uid } from './util.js';
import { state, set, subscribe, selectedRoute } from './state.js';
import { GwMap } from './map.js';
import { createRoutingProvider } from './providers/routing.js';
import { createGeocoder, searchSamplePlaces, reverseGeocode } from './providers/geocoding.js';
import { QUICK_FINDS, prefetchNearby } from './providers/nearby.js';
import { openExplore, openCategory, clearExplore } from './ui/explore.js';
import { SAMPLE_PLACES } from './providers/sampleData.js';
import { createBackend } from './backend/index.js';
import { ALERT_CATEGORIES } from './backend/rules.js';
import { renderSheet, collapse, hideSheet, toast, statusStrip } from './ui/sheet.js';
import { openModal, closeModal } from './ui/modal.js';
import { openReportFlow, openAlertDetail, alertsNearRoute } from './ui/alerts.js';
import { startSuggestPath, openPathDetail } from './ui/paths.js';
import { openAccount, requireSignIn, updateAvatar, openAppearance, renderProfilePage } from './ui/account.js';
import { createRealtime } from './providers/realtime.js';
import { openFriends, openShareTrip, askGoLive, openGoToFriend, shareForDestination, renderShareBanner, openShareViewer, freshness, renderFriendsPage } from './ui/friends.js';
import { createStreetlightProvider } from './providers/streetlights.js';
import { Streetlights, lightingBlock } from './ui/streetlights.js';
import { createTraffic } from './providers/traffic.js';
import { Traffic, trafficRow } from './ui/traffic.js';
import { STREETLIGHTS } from './backend/rules.js';
import { communityRoutes } from './providers/communityRouting.js';
import { TRIP } from './backend/pointsPolicy.js';
import { showTripResult, renderLeaderboardPage } from './ui/points.js';
import { openTripCard } from './ui/tripCard.js';
import { renderActivityPage, attentionCount } from './ui/activity.js';
import { initTabs, registerPage, setBadge, updateProfileTab } from './ui/tabs.js';
import { prefs, setPref, applyPrefs } from './prefs.js';
import { openSafety, openArrivalTimer, safetyWatch, autoCheckIn, askNotifications } from './ui/safety.js';
import { pathFreshness } from './ui/paths.js';

// ---------- services ----------
export const ctx = {
  backend: createBackend(),
  routing: createRoutingProvider(),
  streetlights: createStreetlightProvider(),
  traffic: createTraffic(),   // TomTom live traffic, null without a key
  trafficUi: null,            // Traffic layer controller (set after map init)
  lights: null,               // Streetlights controller (set after map init)
  preferLit: false,           // user preference: rank routes by confirmed lighting (night only)
  rerenderRouteSheet: () => { if (state.destination && state.routes.length) renderRouteSheet(); },
  refreshRouteSheet: () => { if (state.destination && state.routes.length && !state.navigating && !state.routing) { annotateRoutes(state.routes); renderRouteSheet(); } },
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
  openFriends: (tab) => openFriends(ctx, tab),
  refreshShares: () => refreshShares(),
  refreshBadges: (force) => refreshBadges(force),
  setAttention: (n) => setAttention(n),
};
applyPrefs();
registerPage('leaderboard', 'Leaderboard', renderLeaderboardPage);
registerPage('friends', 'Friends', renderFriendsPage);
registerPage('activity', 'Activity', renderActivityPage);
registerPage('profile', 'Profile', renderProfilePage);

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // Reload once when a new version takes over, so one refresh is always enough to get the latest deploy.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded && !state.navigating && !state.draw) { reloaded = true; location.reload(); } });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update?.()).catch(() => {}));
}

ctx.map = new GwMap($('#map'), {
  onAlertClick: (a) => openAlertDetail(ctx, a),
  onPathClick: (p) => openPathDetail(ctx, p),
  onMapTap: (ll) => onMapTap(ll),
  onDrawPoint: (ll) => ctx.onDrawPoint?.(ll),
});

await Promise.race([ctx.backend.ready || Promise.resolve(), new Promise((r) => setTimeout(r, 6000))]); // never block the UI on auth
set({ user: ctx.backend.currentUser() });
ctx.backend.onChange(() => {
  const was = state.user?.id;
  set({ user: ctx.backend.currentUser() });
  updateProfileTab();
  refreshData();
  if (was !== state.user?.id) { ctx.lastSocial = null; ctx.refreshPage?.(); } // signed in/out: redraw the open tab
});
ctx.lights = new Streetlights(ctx);
ctx.trafficUi = new Traffic(ctx);
ctx.realtime = await createRealtime(ctx.backend);
ctx.realtime.onUpdate(refreshShares);
ctx.realtime.onAlerts?.(() => refreshAlerts());
initTabs(ctx);
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
  if (!state.user) { ctx.shares = []; ctx.map.renderFriends([]); renderShareBanner(ctx, []); refreshBadges(); return; }
  const shares = await ctx.backend.listShares();
  ctx.shares = shares;
  ctx.map.renderFriends(shares, { freshness, onClick: (s) => openShareViewer(ctx, s) });
  renderShareBanner(ctx, shares);
  safetyWatch(ctx, shares);
  // notify about new incoming shares
  const incoming = shares.filter((s) => s.direction === 'incoming' && s.status !== 'ended');
  const ids = incoming.map((s) => s.id).join(',');
  if (ids && ids !== lastShareIds && prefs().notifyShares) {
    for (const s of incoming) if (!lastShareIds.includes(s.id)) toast(s.type === 'trip' && s.status === 'invited' ? `${s.from.alias} wants to share a trip with you — tap View to accept or decline` : `${s.from.alias} is sharing their ${s.type === 'trip' ? 'trip' : 'location'} with you — tap Friends › Sharing to view`);
  }
  lastShareIds = ids;
  refreshBadges();
  // my active trip share ended remotely (declined / unfriended / blocked / expired)?
  if (ctx.activeTripShare && !shares.some((s) => s.id === ctx.activeTripShare && s.status !== 'ended')) ctx.activeTripShare = null;
  // refresh the route sheet's share line only when that share's state actually changed
  const sh = state.destination ? shareForDestination(shares, state.destination) : null;
  const key = sh ? `${sh.id}:${sh.status}:${sh.live}` : '';
  if (key !== ctx.shareKey) { ctx.shareKey = key; if (state.destination && state.routes.length && !state.navigating && !state.routing) renderRouteSheet(); }
}
// ---------- tab badges ----------
// Activity: things waiting for the user (friend requests + trip invitations). Friends: a live dot while you share.
let socialAt = 0, lastReqIds = null;
async function refreshBadges(force = false) {
  if (!state.user) { setBadge('activity'); setBadge('friends'); lastReqIds = null; return; }
  if (force || !ctx.lastSocial || Date.now() - socialAt > 30000) {
    try { ctx.lastSocial = await ctx.backend.listSocial(); socialAt = Date.now(); } catch { /* offline: keep the last counts */ }
  }
  const social = ctx.lastSocial;
  setAttention(attentionCount(social, ctx.shares));
  if (social?.friends?.length && !ctx.askedNotify) { ctx.askedNotify = true; document.addEventListener('pointerdown', askNotifications, { once: true }); } // SOS / overdue alerts in the background
  const sharing = ctx.shares.some((s) => s.direction === 'outgoing' && s.status !== 'ended' && s.status !== 'invited');
  setBadge('friends', { dot: sharing, label: sharing ? 'you are sharing live' : '' });
  const ids = (social?.incoming || []).map((r) => r.id);
  if (lastReqIds && prefs().notifyRequests) for (const r of social.incoming) if (!lastReqIds.includes(r.id)) toast(`${r.from.alias} sent you a friend request — see Activity`);
  lastReqIds = ids;
}
function setAttention(n) { setBadge('activity', { count: n, label: n ? `${n} waiting for you` : '' }); }

function focusShare(id) {
  const s = ctx.shares.find((x) => x.id === id);
  if (!s) return;
  ctx.showTab?.('map');
  if (s.lastPos) ctx.map.flyTo([s.lastPos.lat, s.lastPos.lng], 16);
  openShareViewer(ctx, s);
}

// ---------- data ----------
// Live community alerts: re-pull only the alerts (cheap) when realtime says one changed, and tell the user if it's new and nearby.
let knownAlertIds = null, alertsBusy = false;
async function refreshAlerts() {
  if (alertsBusy) return; alertsBusy = true;
  try {
    const alerts = await ctx.backend.listAlerts();
    if (ctx.backend.cacheAliases) await ctx.backend.cacheAliases(alerts.map((a) => a.createdBy));
    const fresh = knownAlertIds ? alerts.filter((a) => !knownAlertIds.has(a.id) && a.createdBy !== state.user?.id) : [];
    knownAlertIds = new Set(alerts.map((a) => a.id));
    set({ alerts });
    ctx.map.renderAlerts(alerts);
    for (const a of fresh) {
      const here = state.position || { lat: ctx.map.center()[0], lng: ctx.map.center()[1] };
      if (haversine([a.lat, a.lng], [here.lat, here.lng]) < 1500) toast(`${ALERT_CATEGORIES[a.category]?.emoji || '⚠️'} New community alert nearby: ${ALERT_CATEGORIES[a.category]?.label || 'report'}`);
    }
    ctx.refreshRouteSheet();
    if (!state.destination && !state.navigating && !state.draw && !ctx.pickingOrigin && !ctx.exploreOpen) showHome();
  } catch { /* offline: keep what we have */ } finally { alertsBusy = false; }
}
async function refreshData() {
  const [alerts, paths] = await Promise.all([ctx.backend.listAlerts().catch(() => []), ctx.backend.listPaths().catch(() => [])]);
  if (ctx.backend.cacheAliases) await ctx.backend.cacheAliases([...alerts.map((a) => a.createdBy), ...paths.map((p) => p.createdBy)]);
  knownAlertIds = new Set(alerts.map((a) => a.id));
  set({ alerts, paths });
  ctx.map.renderAlerts(alerts);
  ctx.map.renderPaths(paths, { showPending: state.layers.pending, myId: state.user?.id });
  if (ctx.lights?.visible()) ctx.lights.render();
  updateAvatar();
  if (!state.destination && !state.navigating && !state.draw && !ctx.pickingOrigin && !ctx.exploreOpen) showHome({ keepState: true }); // background refresh: don't re-open a panel the user minimised
  refreshShares();
}

// ---------- home sheet ----------
function showHome({ keepState = false } = {}) {
  set({ destination: null, routes: [], selectedRouteId: null, routeError: null });
  ctx.map.clearRoutes(); ctx.map.setDestination(null); ctx.map.setOrigin(null); clearExplore(ctx);
  hideSheet(false); if (!keepState) collapse(false);
  const live = integrations.routing !== 'sample';
  const nearby = state.alerts.length;
  if (state.online) prefetchNearby(state.position ? [state.position.lat, state.position.lng] : ctx.map.center());
  renderSheet([
    el('div', { class: 'sheet-title' },
      el('h2', {}, 'Where you headed?'),
      el('span', { class: `chip ${live ? 'live' : 'sample'}` }, live ? 'Live routing' : 'Sample routes')),
    el('p', { class: 'muted small', style: 'margin:0 0 10px' },
      live ? 'OpenStreetMap routes, plus moderator-approved community paths when they make a trip quicker.'
           : 'Sample routes between these places; other destinations get a labelled straight-line estimate.'),
    el('div', { class: 'quick-label' }, 'Quick finds'),
    el('div', { class: 'quick-finds', role: 'list' },
      el('button', { class: 'btn sm quick primary', role: 'listitem', onclick: () => openExplore(ctx) }, '🧭 Explore'),
      ...QUICK_FINDS.map((c) => el('button', { class: 'btn sm quick', role: 'listitem', onclick: () => openCategory(ctx, c) }, c.emoji, ' ', c.label)),
      el('button', { class: 'btn sm quick', role: 'listitem', onclick: () => openSafety(ctx) }, '🛡️ Safety'),
      state.user ? el('button', { class: 'btn sm quick', role: 'listitem', onclick: () => openGoToFriend(ctx) }, '🫂 Go to a friend') : null),
    el('div', { class: 'row between', style: 'margin-bottom:6px' },
      el('div', { class: 'stat' }, el('strong', {}, String(nearby)), el('span', {}, 'active alerts nearby')),
      el('div', { class: 'stat' }, el('strong', {}, String(state.paths.filter((p) => p.status === 'approved').length)), el('span', {}, 'community paths approved')),
      el('button', { class: 'btn sm', onclick: () => openAlertsList() }, 'View alerts')),
    state.user ? null
      : el('div', { class: 'notice' }, 'Guest mode — routes are all yours. ',
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); openAccount(ctx); } }, 'Sign in'), ' to report, add paths and earn points.'),
    el('p', { class: 'small', style: 'color:var(--text-3);margin:8px 0 0' }, 'Route labels describe what a route is built from — they are not safety ratings. Always use your own judgement.'),
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
function stopWatch() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
$('#locateBtn').addEventListener('click', () => {
  if (state.position) { ctx.map.flyTo([state.position.lat, state.position.lng], 16); return; }
  openModal('Use your location?', [
    el('p', {}, 'GettoWayz uses your location to show where you are, plan routes from here and follow the route while navigating.'),
    el('p', { class: 'muted small' }, 'Your location stays on this device. We do not store a history of where you go, and your reports never include your live position.'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => { closeModal(); locate(); } }, 'Allow'), el('button', { class: 'btn', onclick: closeModal }, 'Not now')),
  ]);
});

// Push my position to every active outgoing share (throttled). Only the latest sample is kept server-side.
let lastPush = 0;
function pushPosition(pos) {
  if (!state.user || Date.now() - lastPush < 4000) return;
  // Only accepted shares, and for trips only while the traveller has live progress on.
  const outgoing = ctx.shares.filter((s) => s.direction === 'outgoing' && s.status === 'active' && (s.type !== 'trip' || s.live));
  if (!outgoing.length) return;
  lastPush = Date.now();
  for (const s of outgoing) ctx.backend.updateSharePosition(s.id, { lat: pos.lat, lng: pos.lng }).catch(() => {});
}

// ---------- routing ----------
async function planRoute() {
  if (!state.destination || !state.origin) return;
  const dest = state.destination, origin = state.origin;
  set({ routing: true, routeError: null, routes: [], selectedRouteId: null });
  ctx.routePicked = false;
  if (ctx.trafficUi) ctx.trafficUi.routeIncidents = null;
  renderRouteSheet();
  try {
    if (haversine([origin.lat, origin.lng], [dest.lat, dest.lng]) < 15) throw new Error('You are already there.');
    const result = await ctx.routing.route({ from: [origin.lat, origin.lng], to: [dest.lat, dest.lng], mode: state.mode });
    if (state.destination !== dest) return; // stale
    if (result.unsupported) throw new Error(result.unsupported);
    const routes = annotateRoutes(result.routes);
    set({ routes, routeProvider: result.provider, selectedRouteId: routes[0]?.id || null, routing: false });
    applyRoutePrefs();
    applyRouteTraffic(routes);
    addCommunityRoutes(routes, [origin.lat, origin.lng], [dest.lat, dest.lng], state.mode)
      .then((latest) => scoreLighting(latest).then(() => latest))
      .then((latest) => { if (state.routes === latest && !state.navigating) { applyLitPreference(); applyRoutePrefs(); ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute, { fit: false }); renderRouteSheet(); } });
  } catch (e) {
    set({ routing: false, routeError: e.message || 'Routing failed' });
  }
  ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute);
  renderRouteSheet();
}

/**
 * Ask the routing engine for legs to/from nearby approved community paths and add a stitched route when it helps.
 * Runs after the engine's routes are shown, so routing is never delayed. Returns the route list now in state.
 */
async function addCommunityRoutes(routes, from, to, mode) {
  if (!state.paths.some((p) => p.status === 'approved')) return routes;
  const extra = await communityRoutes({ routing: ctx.routing, from, to, mode, paths: state.paths, base: routes }).catch(() => []);
  if (!extra.length || state.routes !== routes || state.navigating) return state.routes;
  const keepSelection = state.selectedRouteId !== routes[0]?.id; // user already picked one — don't move it
  const all = annotateRoutes([...routes, ...extra]).sort((a, b) => routeRank(a) - routeRank(b));
  set({ routes: all, selectedRouteId: keepSelection ? state.selectedRouteId : all[0].id });
  applyRoutePrefs();
  ctx.map.renderRoutes(all, state.selectedRouteId, state.mode, selectRoute, { fit: false });
  renderRouteSheet();
  return all;
}

/** Points every `step` metres along a polyline (including its vertices). */
function densify(line, step) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], n = Math.max(1, Math.ceil(haversine(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

/** Sort key for "quickest": travel time including live traffic; a route through a closed road goes last. */
const routeRank = (r) => r.durationS + (r.roadClosed ? 1e7 : 0);

/**
 * Driving: fetch live incidents for the area the route options cover, add their delays to each route's time,
 * and re-rank so "Quickest" is quickest in current traffic. Keeps a route the user picked themselves.
 */
async function applyRouteTraffic(routes) {
  if (state.mode !== 'drive' || !ctx.trafficUi?.provider) return;
  const dest = state.destination;
  const got = await ctx.trafficUi.fetchForRoutes(routes);
  if (!got || state.destination !== dest || state.navigating || !state.routes.length) return;
  annotateRoutes(state.routes);
  state.routes.sort((a, b) => routeRank(a) - routeRank(b));
  set({ routes: [...state.routes], selectedRouteId: ctx.routePicked ? state.selectedRouteId : state.routes[0].id });
  ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute, { fit: false });
  renderRouteSheet();
}

/** Adds community-path coverage, nearby alerts and friendly labels to each route. */
function annotateRoutes(routes) {
  const approved = state.paths.filter((p) => p.status === 'approved');
  for (const r of routes) {
    const used = new Set(r.communityPathIds || []);
    for (const p of approved) {
      // Sample along the path every ~5 m: a route only "uses" a path if it actually runs along most of it,
      // not just past its two ends (short cut-throughs otherwise look used by any route around them).
      const pts = densify(p.points, 5);
      const hits = pts.filter((pt) => distanceToLine(pt, r.geometry) < 12).length;
      if (hits >= Math.ceil(pts.length * .8)) used.add(p.id);
    }
    r.communityPathIds = [...used];
    // "Lit" / "working" reports are good news, not hazards
    r.alertsNear = alertsNearRoute(state.alerts.filter((a) => !['light_ok', 'street_lit'].includes(a.category)), r.geometry, 40);
    r.hazardScore = r.alertsNear.reduce((n, a) => n + (a.status === 'verified' ? 3 : a.communityConfirmed ? 2 : 1), 0);
    r.blockedPathIds = (r.communityPathIds || []).filter((id) => { const p = state.paths.find((x) => x.id === id); return p && pathFreshness(p).blocked; });
    // Live traffic: driving routes use incidents fetched for the route area (map layer on or off); other modes only list them.
    r.baseDurationS ??= r.durationS;
    const driveTraffic = state.mode === 'drive' && !!ctx.trafficUi?.routeIncidents;
    r.trafficNear = driveTraffic || ctx.trafficUi?.visible() ? ctx.trafficUi.nearRoute(r.geometry, 30) : [];
    r.trafficChecked = driveTraffic;
    r.trafficDelayS = driveTraffic ? r.trafficNear.reduce((n, t) => n + (t.delay || 0), 0) : 0;
    r.roadClosed = driveTraffic && r.trafficNear.some((t) => t.category === 8 || t.delayLevel === 4);
    r.durationS = r.baseDurationS + r.trafficDelayS;
    if (driveTraffic && r.basis) r.basis = r.basis.replace('Travel time is a free-flow estimate — no live traffic.', 'Travel time includes live traffic delays from TomTom.');
  }
  const withPaths = routes.filter((r) => r.source !== 'estimate' && r.communityPathIds.length > 0);
  const mostPaths = withPaths.length && routes.length > 1 ? withPaths.reduce((a, b) => (a.communityPathIds.length >= b.communityPathIds.length ? a : b)) : null;
  const rest = routes.filter((r) => r !== mostPaths && r.source !== 'estimate');
  const fastest = rest.length ? rest.reduce((a, b) => (routeRank(a) <= routeRank(b) ? a : b)) : null;
  const fastestAll = routes.filter((r) => r.source !== 'estimate').reduce((a, b) => (!a || routeRank(b) < routeRank(a) ? b : a), null);
  for (const r of routes) {
    if (r.source === 'estimate') continue;
    if (r === mostPaths && r === fastestAll && r.viaCommunity) r.label = 'Community shortcut';
    else if (r === mostPaths) r.label = 'More verified paths';
    else if (r === fastest) r.label = mostPaths && mostPaths === fastestAll && mostPaths.viaCommunity ? 'Mapped streets only' : 'Quickest';
    else if (['Quickest', 'More verified paths', 'Community shortcut', 'Mapped streets only'].includes(r.label)) r.label = 'Alternative';
  }
  return routes;
}

/** Score each route's lighting (needs lamp data for the route area). Runs after routes are shown so routing is never delayed. */
async function scoreLighting(routes) {
  if (!ctx.lights || !ctx.streetlights) return;
  for (const r of routes) { if (r.source === 'estimate') continue; r.lighting = await ctx.lights.scoreRoute(r); }
}
/** The "prefer confirmed-lit" option only exists at night and only when some route actually has enough confirmed coverage. */
function litPreferenceAvailable() {
  if (!ctx.lights?.isNight) return false;
  return state.routes.some((r) => r.lighting?.covered && r.lighting.pct.confirmed >= STREETLIGHTS.preferLitMinConfirmedPct);
}
function applyLitPreference() {
  const scored = state.routes.filter((r) => r.lighting?.covered);
  if (!scored.length) return;
  const best = scored.reduce((a, b) => (a.lighting.pct.confirmed >= b.lighting.pct.confirmed ? a : b));
  for (const r of state.routes) if (r.label === 'Most confirmed lighting') r.label = 'Alternative';
  if (best.lighting.pct.confirmed >= STREETLIGHTS.preferLitMinConfirmedPct && state.routes.length > 1 && !['Quickest', 'More verified paths', 'Community shortcut', 'Mapped streets only'].includes(best.label)) best.label = 'Most confirmed lighting';
  if (ctx.preferLit && litPreferenceAvailable()) {
    state.routes.sort((a, b) => (b.lighting?.pct.confirmed || 0) - (a.lighting?.pct.confirmed || 0));
    set({ selectedRouteId: state.routes[0].id });
  }
}

// ---------- route preferences: avoid reported hazards / avoid hills (device setting) ----------
const PREF_LABELS = ['Fewest hazards', 'Flattest'];
const hillsKnown = () => state.mode !== 'drive' && state.routes.some((r) => r.ascentM != null);
function applyRoutePrefs() {
  const live = state.routes.filter((r) => r.source !== 'estimate');
  for (const r of state.routes) if (PREF_LABELS.includes(r.label)) r.label = 'Alternative';
  if (live.length < 2) return;
  const p = prefs(), hills = p.avoidHills && hillsKnown();
  if (!p.avoidHazards && !hills) return;
  // each preference may cost at most this much extra time, so a "safer" pick is never absurdly long
  const best = Math.min(...live.map((r) => r.durationS)), cap = best * 1.5 + 300;
  const key = (r) => (r.durationS > cap ? 1e9 : 0) + (p.avoidHazards ? r.hazardScore * 1e5 : 0) + (hills ? (r.ascentM ?? 1e4) * 100 : 0) + r.durationS;
  state.routes.sort((a, b) => (a.source === 'estimate') - (b.source === 'estimate') || key(a) - key(b));
  const top = state.routes[0];
  if (top.label === 'Alternative') {
    const fewer = p.avoidHazards && live.some((r) => r.hazardScore > top.hazardScore);
    top.label = fewer ? 'Fewest hazards' : hills && top.ascentM != null && live.some((r) => r.ascentM == null || r.ascentM > top.ascentM + 5) ? 'Flattest' : top.label;
  }
  if (!ctx.routePicked) set({ selectedRouteId: top.id });
}
function routePrefsRow() {
  if (state.routes.filter((r) => r.source !== 'estimate').length < 2) return null; // nothing to choose between
  const p = prefs();
  const toggle = (key, label, hint) => el('button', { class: `btn sm ${p[key] ? 'primary' : ''}`, 'aria-pressed': String(!!p[key]), title: hint,
    onclick: () => { setPref(key, !p[key]); ctx.routePicked = false; annotateRoutes(state.routes); applyLitPreference(); applyRoutePrefs(); ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute, { fit: false }); renderRouteSheet(); } }, label);
  return el('div', { class: 'row wrap', style: 'gap:6px;margin:6px 0' },
    el('span', { class: 'small muted' }, 'Prefer:'),
    toggle('avoidHazards', '⚠️ Avoid reported hazards', 'Rank routes with fewer community alerts first (verified alerts count most)'),
    hillsKnown() ? toggle('avoidHills', '⛰️ Fewer hills', 'Rank routes with less climbing first') : null);
}

function selectRoute(id) {
  if (id !== state.selectedRouteId) ctx.routePicked = true;
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
        rt.alertsNear.length ? el('span', { class: 'chip pending' }, `⚠️ ${rt.alertsNear.length} alert${rt.alertsNear.length > 1 ? 's' : ''}`) : null,
        rt.blockedPathIds?.length ? el('span', { class: 'chip danger' }, '🚧 Path reported blocked') : null,
        rt.ascentM != null && state.mode !== 'drive' ? el('span', { class: 'chip' }, `⛰️ ${rt.ascentM} m up`) : null,
        rt.roadClosed ? el('span', { class: 'chip', style: 'color:#ff4d4f;border-color:#ff4d4f' }, '⛔ Road closed') : null,
        rt.trafficChecked
          ? (rt.trafficDelayS >= 60
            ? el('span', { class: 'chip', style: 'color:#ffb020;border-color:#ffb020' }, `🚦 +${Math.round(rt.trafficDelayS / 60)} min traffic`)
            : el('span', { class: 'chip', style: 'color:var(--verified);border-color:var(--verified)' }, '🚦 No delays'))
          : rt.trafficNear?.length ? el('span', { class: 'chip', style: 'color:#ffb020;border-color:#ffb020' }, `🚦 ${rt.trafficNear.length} traffic`) : null,
        rt.lighting?.covered ? el('span', { class: 'chip', style: 'color:#ffd34d;border-color:#ffd34d' }, `🔦 ${rt.lighting.pct.confirmed}% lit·confirmed`) : null,
        state.mode === 'drive' && rt.source === 'live' && !rt.trafficChecked && !ctx.trafficUi?.visible() ? el('span', { class: 'chip' }, 'No live traffic') : null),
      el('div', { class: 'basis' }, labelBasis(rt))),
    el('div', { class: 'stats' }, el('strong', {}, fmtDuration(rt.durationS)), el('span', {}, fmtDistance(rt.distanceM)), timeDiff(rt)))));

  const alertsBlock = r.alertsNear.length
    ? el('div', {}, el('h3', { style: 'font-size:14px;margin:8px 0 6px' }, 'Alerts along this route'), el('div', { class: 'list' }, ...r.alertsNear.map(alertRow)))
    : null;
  const trafficBlock = r.trafficNear?.length
    ? el('div', {}, el('h3', { style: 'font-size:14px;margin:8px 0 6px' }, '🚦 Live traffic on this route'), el('div', { class: 'list' }, ...r.trafficNear.map((t) => trafficRow(t, ctx))))
    : null;

  const steps = el('ul', { class: 'steps' }, ...r.steps.map((s, i) => el('li', {}, el('span', { class: 'ic' }, i === r.steps.length - 1 ? '🏁' : s.community ? '🟢' : '→'), el('span', {}, s.text), el('span', { class: 'd' }, fmtDistance(s.dist)))));

  const litToggle = litPreferenceAvailable() ? el('label', { class: 'row', style: 'gap:10px;margin:6px 0' },
    el('input', { type: 'checkbox', checked: ctx.preferLit, onchange: (e) => { ctx.preferLit = e.target.checked; applyLitPreference(); ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute, { fit: false }); renderRouteSheet(); } }),
    el('span', { class: 'small' }, el('strong', {}, 'Prefer routes with confirmed lighting'), ' — ranks by lamps recently reported working. Not a safety rating.')) : null;
  ctx.map.renderLightingOverlay(ctx.lights?.visible() ? r.lighting?.segments : null);
  const safetyRow = el('div', { class: 'row', style: 'gap:6px;margin:6px 0' },
    el('button', { class: 'btn sm', onclick: () => (state.user ? openArrivalTimer(ctx, { etaS: r.durationS, destName: dest.name }) : openSafety(ctx)) }, '⏱️ Arrival timer'),
    el('button', { class: 'btn sm', onclick: () => openSafety(ctx, { etaS: r.durationS, destName: dest.name }) }, '🛡️ Safety'));
  renderSheet([head, cards, routePrefsRow(), litToggle, r.source === 'estimate' ? null : shareBlock(), safetyRow,
    el('div', { class: `notice ${r.source === 'estimate' ? 'warn' : 'info'}` }, r.basis),
    ctx.streetlights ? lightingBlock(r.lighting, { night: !!ctx.lights?.isNight }) : null,
    el('div', { class: 'row', style: 'margin:10px 0' },
      el('button', { class: 'btn primary block', onclick: startNavigation }, r.source === 'estimate' ? 'Start (estimate only)' : 'Start navigation'),
      el('button', { class: 'btn', onclick: () => { ctx.pickingOrigin = true; toast('Tap the map to choose a new start point'); } }, 'Start point')),
    alertsBlock,
    trafficBlock,
    el('h3', { style: 'font-size:14px;margin:12px 0 4px' }, 'Directions'), steps,
    el('p', { class: 'small', style: 'color:var(--text-3)' }, 'Community paths are user suggestions approved by moderators for inclusion on the map. Alerts are community reports and may be out of date. Nothing here is a guarantee of safety or legality — follow signs and local rules.'),
  ]);
}
/** "Share route with a friend" — or, once shared, who it's shared with and its state. */
function shareBlock() {
  const sh = state.user ? shareForDestination(ctx.shares, state.destination) : null;
  if (!sh) return el('button', { class: 'btn block', style: 'margin:6px 0', onclick: () => { if (requireSignIn(ctx, 'share routes with friends')) openShareTrip(ctx, () => refreshShares(), { preselect: state.destination?.friendId }); } }, '👥 Share route with a friend');
  const txt = sh.status === 'invited' ? `Invitation sent to ${esc(sh.to.alias)} — waiting for them to accept`
    : sh.live ? `${esc(sh.to.alias)} is following · live progress on` : `${esc(sh.to.alias)} accepted · route only (live progress turns on when you start)`;
  return el('div', { class: 'notice info row between', style: 'margin:6px 0;gap:8px' }, el('span', { class: 'small' }, '👥 ', txt),
    el('button', { class: 'btn sm danger', onclick: async () => { try { await ctx.backend.stopShare(sh.id); toast('Route sharing stopped'); refreshShares(); } catch (e) { toast(e.message, 'error'); } } }, sh.status === 'invited' ? 'Cancel' : 'Stop'));
}
/** "+X min" against the quickest option (shown on the slower route cards). */
function timeDiff(rt) {
  const best = state.routes.filter((r) => r.source !== 'estimate' && !r.roadClosed).reduce((m, r) => Math.min(m, r.durationS), Infinity);
  const d = Math.round((rt.durationS - best) / 60);
  if (!Number.isFinite(best) || rt.source === 'estimate' || d < 1) return null;
  return el('span', { class: 'time-diff', title: `${d} min slower than the quickest option` }, `+${d} min`);
}

function labelBasis(rt) {
  if (rt.label === 'Quickest') return rt.trafficChecked ? 'Quickest in current traffic (live TomTom delays included).' : 'Shortest estimated time for this mode.';
  if (rt.label === 'Community shortcut') return 'Quickest option, thanks to a moderator-approved community path the map engine doesn’t know about yet.';
  if (rt.label === 'More verified paths') return 'Uses more moderator-approved community paths. Approval means the path is on the map — not a safety rating.';
  if (rt.label === 'Most confirmed lighting') return 'Highest share of lamps recently confirmed working by the community. Not a safety guarantee.';
  if (rt.label === 'Fewest hazards') return 'Passes the fewest community-reported hazards (verified reports count most). Reports can be out of date.';
  if (rt.label === 'Flattest') return 'Least climbing of the options, from elevation data. Gradients on short stretches may still be steep.';
  if (rt.label === 'Mapped streets only') return 'Quickest route using only ways already in OpenStreetMap.';
  if (rt.viaCommunity) return 'Uses a moderator-approved community path. Approval means the path is on the map — not a safety rating.';
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
  // Explain trip points once, before the trip — never during it.
  if (state.user && r.source !== 'estimate' && !tripNoticeSeen()) return showTripPointsNotice(() => startNavigation());
  if (state.user && r.source !== 'estimate') {
    // Already shared while planning? Offer live progress for this trip (opt-in, per trip).
    const existing = shareForDestination(ctx.shares, state.destination);
    if (existing) {
      ctx.activeTripShare = existing.id;
      if (existing.live) return beginNavigation(r);
      return askGoLive(ctx, existing, () => { refreshShares(); beginNavigation(r); });
    }
    let social = null;
    try { social = await ctx.backend.listSocial(); } catch { /* offline: navigate without offering */ }
    if (social?.friends.length) {
      openShareTrip(ctx, (share) => { ctx.activeTripShare = share?.id || null; beginNavigation(r); if (share) refreshShares(); }, { live: true, navigating: true, preselect: state.destination?.friendId });
      return;
    }
  }
  beginNavigation(r);
}
// ---------- verified trips (points) ----------
const tripNoticeSeen = () => { try { return localStorage.getItem('gw:tripPointsNotice') === '1'; } catch { return true; } };
function showTripPointsNotice(next) {
  const choose = async (on) => {
    try { localStorage.setItem('gw:tripPointsNotice', '1'); } catch { /* ignore */ }
    try { await ctx.backend.setPointsPrefs({ tripPoints: on }); set({ user: ctx.backend.currentUser() }); } catch (e) { toast(e.message, 'error'); }
    closeModal(); next();
  };
  openModal('Earn points for this trip?', [
    el('p', {}, `Finished trips can earn points (more for longer walks and rides, up to ${TRIP.maxPerTrip} per trip). Points arrive after you arrive — nothing pops up while you travel.`),
    el('div', { class: 'consent' },
      el('div', { class: 'consent-row' }, '📍', el('div', {}, el('strong', {}, 'What is used'), el('div', { class: 'small muted' }, `A coarse position check about every ${TRIP.checkpointEverySec} s while navigating, to confirm progress along your route.`))),
      el('div', { class: 'consent-row' }, '🗑️', el('div', {}, el('strong', {}, 'What is kept'), el('div', { class: 'small muted' }, 'Only the latest check during the trip. It is deleted with the route when the trip ends; your points history keeps the points, not the place.'))),
      el('div', { class: 'consent-row' }, '🙈', el('div', {}, el('strong', {}, 'Who sees it'), el('div', { class: 'small muted' }, 'Nobody. Leaderboards never show locations, routes or distances.')))),
    el('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: () => choose(true) }, 'Earn trip points'),
    el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: () => choose(false) }, 'Navigate without trip points'),
    el('p', { class: 'small', style: 'color:var(--text-3);margin-top:8px' }, 'You can change this any time in Profile › Privacy & visibility.'),
  ], { onClose: () => { try { localStorage.setItem('gw:tripPointsNotice', '1'); } catch { /* ignore */ } } });
}
function startTripTracking(r) {
  ctx.activeTrip = null;
  if (!state.user || state.user.tripPoints === false || r.source === 'estimate' || !r.geometry?.length) return;
  ctx.backend.startTrip?.(state.mode, r.geometry).then((id) => { if (state.navigating) ctx.activeTrip = { id, lastSent: 0 }; }).catch(() => {}); // silent: never interrupt navigation
}
function sendTripCheckpoint(pos) {
  const t = ctx.activeTrip;
  if (!t || Date.now() - t.lastSent < TRIP.checkpointEverySec * 1000) return;
  t.lastSent = Date.now();
  ctx.backend.tripCheckpoint(t.id, { lat: pos.lat, lng: pos.lng }).catch(() => {});
}

function beginNavigation(r) {
  arrivedShown = false;
  ctx.navStartedAt = Date.now();
  startTripTracking(r);
  set({ navigating: true });
  hideSheet(true);
  $('#navbar').hidden = false; $('#fabs').hidden = true; $('#modebar').hidden = true; $('.topbar').hidden = true;
  $('#navbar').classList.toggle('driving', state.mode === 'drive');
  ctx.map.renderRoutes([r], r.id, state.mode, () => {});
  ctx.map.renderLightingOverlay(ctx.lights?.visible() ? r.lighting?.segments : null);
  $('#endNavBtn').onclick = endNavigation;
  setupVoice();
  lastSpokenStep = -1;
  if (state.position) { onNavTick(state.position); locate({ follow: true }); }
  else {
    openModal('Follow along?', [
      el('p', {}, 'To follow your progress, GettoWayz needs your location while navigating. Without it, you can still read the directions.'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => { closeModal(); locate({ follow: true }); } }, 'Use location'), el('button', { class: 'btn', onclick: () => { closeModal(); showStep(0, r); } }, 'Just show steps')),
    ]);
    showStep(0, r);
  }
}
function endNavigation() {
  const shareId = ctx.activeTripShare, trip = ctx.activeTrip;
  const pos = state.position ? { lat: state.position.lat, lng: state.position.lng } : null;
  const r = selectedRoute();
  const info = arrivedShown && r ? { mode: state.mode, distanceM: r.distanceM, durationS: ctx.navStartedAt ? (Date.now() - ctx.navStartedAt) / 1000 : r.durationS,
    ascentM: state.mode !== 'drive' ? r.ascentM ?? null : null, destName: state.destination?.name, alias: state.user?.alias } : null;
  ctx.activeTripShare = null; ctx.activeTrip = null;
  if (shareId) ctx.backend.stopShare(shareId, 'cancelled').then(refreshShares).catch(() => {}); // ending navigation ends trip sharing
  exitNavigationUi();
  // The server checks the trip and decides any points — only now, after navigation has ended.
  if (trip) ctx.backend.finishTrip(trip.id, pos)
    .then(async (res) => {
      set({ user: ctx.backend.currentUser() }); updateAvatar();
      if (info) { const b = await ctx.backend.myBadges?.().catch(() => null); info.streak = b?.streak?.current || 0; }
      showTripResult(res, info);
    })
    .catch((e) => toast(navigator.onLine ? `Trip couldn't be checked: ${e.message}` : 'Offline — this trip could not be checked for points.', 'error'));
  else if (info && info.mode !== 'drive') openTripCardOffer(info);
}
let arrivedShown = false;
function openTripCardOffer(info) {
  openModal('You made it 🎉', [
    el('p', {}, `${fmtDistance(info.distanceM)} ${MODES[info.mode].label.toLowerCase()} in ${fmtDuration(info.durationS)}.`),
    el('button', { class: 'btn primary block', onclick: () => openTripCard(info) }, '📸 Share trip card'),
  ]);
}
function exitNavigationUi() {
  set({ navigating: false });
  $('#navbar').hidden = true; $('#fabs').hidden = false; $('#modebar').hidden = false; $('.topbar').hidden = false;
  $('#navbar').classList.remove('driving');
  stopVoice();
  // No background tracking after the trip: stop watching location unless a location share you started is still running.
  if (!ctx.shares.some((s) => s.direction === 'outgoing' && s.type === 'location' && s.status === 'active')) stopWatch();
  hideSheet(false);
  ctx.map.renderRoutes(state.routes, state.selectedRouteId, state.mode, selectRoute);
  renderRouteSheet();
}
function showStep(i, r, remainingM) {
  const step = r.steps[Math.min(i, r.steps.length - 1)];
  $('#navInstr').textContent = step?.text || 'Continue';
  $('#navSub').textContent = step ? `${fmtDistance(step.dist)} · step ${Math.min(i, r.steps.length - 1) + 1} of ${r.steps.length}` : '';
  $('#navIcon').textContent = /left/i.test(step?.text) ? '↰' : /right/i.test(step?.text) ? '↱' : i >= r.steps.length - 1 ? '🏁' : '↑';
  speakStep(Math.min(i, r.steps.length - 1), step);
  const rem = remainingM ?? r.distanceM;
  $('#navRemain').textContent = `${fmtDistance(rem)} left`;
  const eta = new Date(Date.now() + (rem / MODES[state.mode].speed) * 1000);
  $('#navEta').textContent = `${eta.getHours()}:${String(eta.getMinutes()).padStart(2, '0')}`;
}
// ---------- voice guidance (browser SpeechSynthesis; offered only where the browser supports it) ----------
let voiceOn = false, lastSpokenStep = -1;
const speechOk = () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
function setupVoice() {
  const b = $('#voiceBtn');
  if (!speechOk()) { b.hidden = true; return; }
  b.hidden = false;
  // default voice on for driving (hands stay on the wheel), off otherwise; user can toggle either way
  voiceOn = state.mode === 'drive';
  renderVoiceBtn();
  b.onclick = () => { voiceOn = !voiceOn; renderVoiceBtn(); if (voiceOn) { lastSpokenStep = -1; const r = selectedRoute(); if (r) speakStep(0, r.steps[0]); } else speechSynthesis.cancel(); };
}
function renderVoiceBtn() { const b = $('#voiceBtn'); b.textContent = voiceOn ? '🔊 Voice' : '🔇 Voice'; b.setAttribute('aria-pressed', String(voiceOn)); }
function speakStep(i, step) {
  if (!voiceOn || !speechOk() || !step || i === lastSpokenStep) return;
  lastSpokenStep = i;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(`${step.text}. ${fmtDistance(step.dist)}`); u.lang = 'en-GB'; u.rate = 1; speechSynthesis.speak(u); } catch { /* ignore */ }
}
function stopVoice() { if (speechOk()) try { speechSynthesis.cancel(); } catch { /* ignore */ } }

/** On arrival, send one final position (so the server can verify it) and end trip sharing straight away. */
async function shareArrived(pos) {
  const id = ctx.activeTripShare; if (!id) return;
  ctx.activeTripShare = null; // claimed here so endNavigation doesn't also end it as "cancelled"
  try { await ctx.backend.updateSharePosition(id, { lat: pos.lat, lng: pos.lng }); await ctx.backend.stopShare(id, 'arrived'); } catch { /* already ended */ }
  refreshShares();
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
    if (!arrivedShown) { arrivedShown = true; toast('You have arrived 🎉', 'success'); shareArrived(pos); autoCheckIn(ctx); if (ctx.activeTrip) ctx.activeTrip.lastSent = 0; if (state.user && r.source !== 'estimate') endNavigation(); }
    return;
  }
  sendTripCheckpoint(pos);
  if (bestD > 80) toast('You look off-route — directions may not match where you are', 'error');
  showStep(stepI, r, remaining);
  ctx.map.map.panTo(me, { animate: true });
}

// ---------- map controls, layers, fabs ----------
$('#zoomIn').addEventListener('click', () => ctx.map.zoomIn());
$('#safetyBtn').addEventListener('click', () => openSafety(ctx, state.destination && selectedRoute() ? { etaS: selectedRoute().durationS, destName: state.destination.name } : {}));
$('#navSafetyBtn').addEventListener('click', () => openSafety(ctx, { etaS: selectedRoute()?.durationS, destName: state.destination?.name }));
$('#zoomOut').addEventListener('click', () => ctx.map.zoomOut());
$('#layersBtn').addEventListener('click', () => { const p = $('#layersPanel'); p.hidden = !p.hidden; $('#layersBtn').setAttribute('aria-expanded', String(!p.hidden)); });
document.addEventListener('click', (e) => { const p = $('#layersPanel'); if (!p.hidden && !e.target.closest('#layersPanel') && !e.target.closest('#layersBtn')) { p.hidden = true; $('#layersBtn').setAttribute('aria-expanded', 'false'); } });
$('#layerAlerts').addEventListener('change', (e) => { state.layers.alerts = e.target.checked; ctx.map.toggleAlerts(e.target.checked); });
$('#layerPaths').addEventListener('change', (e) => { state.layers.paths = e.target.checked; ctx.map.togglePaths(e.target.checked); });
$('#layerPending').addEventListener('change', (e) => { state.layers.pending = e.target.checked; ctx.map.renderPaths(state.paths, { showPending: e.target.checked, myId: state.user?.id }); });
$('#brandBtn').addEventListener('click', () => { closeModal(); if (!state.navigating) showHome(); });
$('#reportBtn').addEventListener('click', () => {
  if (state.navigating && state.mode === 'drive') { toast('Reporting is off while driving. Pull over safely first, or report later.'); return; }
  if (!requireSignIn(ctx, 'report an alert')) return;
  if (state.position) openReportFlow(ctx, [state.position.lat, state.position.lng], { fromGps: true });
  else { ctx.pickingAlert = true; toast('Tap the map where the issue is'); }
});
$('#suggestBtn').addEventListener('click', () => { if (requireSignIn(ctx, 'suggest a path')) startSuggestPath(ctx); });
