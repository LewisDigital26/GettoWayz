// Map layer — wraps Leaflet. Owns tiles, route lines, markers, alert pins, community paths and the draw tool.
/* global L */
import { config } from './config.js';
import { MODES, esc, fmtAgo, cssVar } from './util.js';
import { ALERT_CATEGORIES } from './backend/rules.js';

export class GwMap {
  constructor(el, { onAlertClick, onPathClick, onMapTap, onDrawPoint } = {}) {
    this.map = L.map(el, { zoomControl: false, attributionControl: true, tap: true, maxZoom: 19 })
      .setView(config.DEFAULT_CENTER, config.DEFAULT_ZOOM);
    this.tiles = L.tileLayer(this.tileUrl(), { attribution: config.TILE_ATTRIBUTION, maxZoom: 19, subdomains: 'abcd' }).addTo(this.map);
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

    this.routeLayer = L.layerGroup().addTo(this.map);
    this.pathLayer = L.layerGroup().addTo(this.map);
    this.pendingLayer = L.layerGroup();
    this.alertLayer = L.layerGroup().addTo(this.map);
    this.drawLayer = L.layerGroup().addTo(this.map);
    this.friendLayer = L.layerGroup().addTo(this.map);
    this.meMarker = null; this.destMarker = null; this.originMarker = null; this.accuracyCircle = null;
    this.drawing = false;
    this.cb = { onAlertClick, onPathClick, onMapTap, onDrawPoint };

    this.map.on('click', (e) => {
      if (this.drawing) this.cb.onDrawPoint?.([e.latlng.lat, e.latlng.lng]);
      else this.cb.onMapTap?.([e.latlng.lat, e.latlng.lng]);
    });
  }

  /** Default CARTO basemap follows the colourway (dark/light); a custom TILE_URL is used as-is. */
  tileUrl() {
    const custom = config.TILE_URL !== 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    if (custom) return config.TILE_URL;
    return document.documentElement.getAttribute('data-colourway') === 'day' ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' : config.TILE_URL;
  }
  refreshTiles() { this.tiles.setUrl(this.tileUrl()); }
  zoomIn() { this.map.zoomIn(); }
  zoomOut() { this.map.zoomOut(); }
  flyTo(latlng, zoom = 16) { this.map.flyTo(latlng, zoom, { duration: .6 }); }
  center() { const c = this.map.getCenter(); return [c.lat, c.lng]; }

  pin(cls, emoji) {
    return L.divIcon({ className: '', html: `<div class="gw-pin ${cls}"><span>${emoji}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
  }

  setMe(pos) {
    if (!pos) { this.meMarker?.remove(); this.accuracyCircle?.remove(); this.meMarker = null; return; }
    const ll = [pos.lat, pos.lng];
    if (!this.meMarker) {
      this.meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="gw-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, interactive: false }).addTo(this.map);
      this.accuracyCircle = L.circle(ll, { radius: pos.accuracy || 20, color: cssVar('--teal'), weight: 1, fillOpacity: .08, interactive: false }).addTo(this.map);
    } else {
      this.meMarker.setLatLng(ll);
      this.accuracyCircle.setLatLng(ll).setRadius(pos.accuracy || 20);
    }
  }

  setDestination(place) {
    this.destMarker?.remove(); this.destMarker = null;
    if (!place) return;
    this.destMarker = L.marker([place.lat, place.lng], { icon: this.pin('dest', '📍'), zIndexOffset: 900 }).addTo(this.map)
      .bindPopup(`<div class="t">${esc(place.name)}</div><div class="muted small">${esc(place.sub || '')}</div>`);
  }
  setOrigin(origin) {
    this.originMarker?.remove(); this.originMarker = null;
    if (!origin || origin.source === 'gps') return;
    this.originMarker = L.circleMarker([origin.lat, origin.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#7b8094', fillOpacity: 1 }).addTo(this.map)
      .bindPopup(`<div class="t">Start: ${esc(origin.name || 'map point')}</div>`);
  }

  renderRoutes(routes, selectedId, mode, onSelect, { fit = true } = {}) {
    this.routeLayer.clearLayers();
    const hex = MODES[mode].hex;
    // draw unselected first so the selected sits on top
    const ordered = [...routes.filter((r) => r.id !== selectedId), ...routes.filter((r) => r.id === selectedId)];
    for (const r of ordered) {
      const sel = r.id === selectedId;
      const dash = r.source === 'estimate' ? '8 10' : null;
      L.polyline(r.geometry, { color: cssVar('--bg'), weight: sel ? 11 : 7, opacity: sel ? .9 : .5, lineCap: 'round', interactive: false }).addTo(this.routeLayer);
      const line = L.polyline(r.geometry, { color: sel ? hex : cssVar('--route-alt'), weight: sel ? 6 : 4, opacity: sel ? 1 : .85, lineCap: 'round', dashArray: dash });
      line.on('click', () => onSelect?.(r.id));
      line.addTo(this.routeLayer);
    }
    if (routes.length && fit) {
      const bounds = L.latLngBounds(routes.flatMap((r) => r.geometry));
      this.map.fitBounds(bounds, { paddingTopLeft: [40, 130], paddingBottomRight: [40, window.innerWidth >= 900 ? 60 : Math.min(window.innerHeight * .45, 360)] });
    }
  }
  clearRoutes() { this.routeLayer.clearLayers(); }

  renderPaths(paths, { showPending = false, myId = null } = {}) {
    this.pathLayer.clearLayers(); this.pendingLayer.clearLayers();
    for (const p of paths) {
      const approved = p.status === 'approved';
      if (!approved && !(showPending && p.createdBy === myId)) continue;
      const line = L.polyline(p.points, {
        color: approved ? cssVar('--verified') : cssVar('--pending'), weight: 4, opacity: .9, dashArray: approved ? '2 8' : '6 8', lineCap: 'round',
      });
      line.bindPopup(`<div class="t">${esc(p.name)}</div><div class="small muted">${approved ? 'Community-added · approved by moderators' : 'Your suggestion · ' + esc(p.status)}${p.sample ? ' · sample' : ''}</div>`);
      line.on('click', () => this.cb.onPathClick?.(p));
      line.addTo(approved ? this.pathLayer : this.pendingLayer);
    }
    if (showPending) this.pendingLayer.addTo(this.map); else this.pendingLayer.remove();
  }
  togglePaths(show) { show ? this.pathLayer.addTo(this.map) : this.pathLayer.remove(); }
  toggleAlerts(show) { show ? this.alertLayer.addTo(this.map) : this.alertLayer.remove(); }

  renderAlerts(alerts) {
    this.alertLayer.clearLayers();
    for (const a of alerts) {
      const cat = ALERT_CATEGORIES[a.category] || ALERT_CATEGORIES.other;
      const m = L.marker([a.lat, a.lng], { icon: this.pin('alert ' + a.status, cat.emoji) });
      m.bindPopup(`<div class="t">${esc(cat.label)}</div><div class="small muted">${a.status === 'verified' ? '✅ Verified by moderators' : '⏳ Awaiting confirmation'} · ${fmtAgo(a.createdAt)}${a.sample ? ' · sample' : ''}</div>`);
      m.on('click', () => this.cb.onAlertClick?.(a));
      m.addTo(this.alertLayer);
    }
  }

  /** Friends sharing with me: marker at their last position (labelled by freshness) + their trip route. */
  renderFriends(shares, { freshness, onClick } = {}) {
    this.friendLayer.clearLayers();
    for (const s of shares) {
      if (s.direction !== 'incoming' || s.status === 'ended') continue;
      if (s.trip?.geometry) {
        L.polyline(s.trip.geometry, { color: '#9b8cff', weight: 4, opacity: .7, dashArray: '1 10', lineCap: 'round', interactive: false }).addTo(this.friendLayer);
        L.marker([s.trip.destLat, s.trip.destLng], { icon: this.pin('friend-dest', '🏁'), interactive: false }).addTo(this.friendLayer);
      }
      if (!s.lastPos) continue;
      const f = freshness ? freshness(s) : 'live';
      const m = L.marker([s.lastPos.lat, s.lastPos.lng], {
        icon: L.divIcon({ className: '', html: `<div class="gw-friend ${f}"><span>${esc(s.from.alias[0].toUpperCase())}</span><em>${esc(s.from.alias)}${f === 'live' ? '' : f === 'stale' ? ' · stale' : ' · lost'}</em></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 950,
      });
      m.on('click', () => onClick?.(s));
      m.addTo(this.friendLayer);
    }
  }

  // ----- draw tool -----
  startDraw() { this.drawing = true; this.drawLayer.clearLayers(); this.map.getContainer().style.cursor = 'crosshair'; }
  renderDraw(points) {
    this.drawLayer.clearLayers();
    if (points.length > 1) L.polyline(points, { color: cssVar('--accent'), weight: 4, dashArray: '6 8' }).addTo(this.drawLayer);
    points.forEach((p) => L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="gw-vertex"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false }).addTo(this.drawLayer));
  }
  endDraw() { this.drawing = false; this.drawLayer.clearLayers(); this.map.getContainer().style.cursor = ''; }

  invalidate() { this.map.invalidateSize(); }
}
