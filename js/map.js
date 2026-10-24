// Map layer — wraps Leaflet. Owns tiles, route lines, markers, alert pins, community paths and the draw tool.
/* global L */
import { config } from './config.js';
import { MODES, esc, fmtAgo, cssVar } from './util.js';
import { ALERT_CATEGORIES } from './backend/rules.js';
import { VectorBasemap, vectorAvailable } from './basemap.js';

export class GwMap {
  constructor(el, { onAlertClick, onPathClick, onMapTap, onDrawPoint } = {}) {
    this.map = L.map(el, { zoomControl: false, attributionControl: true, tap: true, maxZoom: 19 })
      .setView(config.DEFAULT_CENTER, config.DEFAULT_ZOOM);
    this.basemap = null; this.tiles = null;
    if (config.BASEMAP === 'vector' && vectorAvailable()) {
      this.basemap = new VectorBasemap(this.map);
      this.map.attributionControl.addAttribution(config.VECTOR_ATTRIBUTION);
    } else {
      this.tiles = L.tileLayer(this.tileUrl(), { attribution: config.TILE_ATTRIBUTION, maxZoom: 19 }).addTo(this.map);
    }
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

    this.routeLayer = L.layerGroup().addTo(this.map);
    this.pathLayer = L.layerGroup().addTo(this.map);
    this.pendingLayer = L.layerGroup();
    this.alertLayer = L.layerGroup().addTo(this.map);
    this.drawLayer = L.layerGroup().addTo(this.map);
    this.friendLayer = L.layerGroup().addTo(this.map);
    this.lampLayer = L.layerGroup();
    this.lightOverlay = L.layerGroup().addTo(this.map);
    this.trafficTiles = null;                 // TomTom flow tiles (created on first show)
    this.trafficLayer = L.layerGroup();       // incident pins + lines
    this.meMarker = null; this.destMarker = null; this.originMarker = null; this.accuracyCircle = null;
    this.drawing = false;
    this.cb = { onAlertClick, onPathClick, onMapTap, onDrawPoint };

    this.map.on('click', (e) => {
      if (this.drawing) this.cb.onDrawPoint?.([e.latlng.lat, e.latlng.lng]);
      else this.cb.onMapTap?.([e.latlng.lat, e.latlng.lng]);
    });
  }

  /** Raster fallback tile URL (OSM by default). Dark colourways restyle raster tiles via the --map-filter CSS token. */
  tileUrl() { return config.TILE_URL; }
  /** Called when the colourway changes: recolours the vector basemap, or re-requests raster tiles. */
  refreshTiles() { if (this.basemap) this.basemap.applyColourway(); else this.tiles?.setUrl(this.tileUrl()); }
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
  /** Live traffic: flow tiles under the pins, incidents on top. tileUrl comes from the traffic provider. */
  toggleTraffic(show, tileUrl) {
    if (show) {
      if (!this.trafficTiles && tileUrl) this.trafficTiles = L.tileLayer(tileUrl, { maxZoom: 19, className: 'traffic-tiles', attribution: '&copy; <a href="https://www.tomtom.com">TomTom</a>' });
      this.trafficTiles?.addTo(this.map);
      this.trafficLayer.addTo(this.map);
    } else { this.trafficTiles?.remove(); this.trafficLayer.remove(); }
  }
  renderTraffic(incidents, { categories, onClick } = {}) {
    this.trafficLayer.clearLayers();
    for (const t of incidents) {
      const cat = categories?.[t.category] || { emoji: '⚠️', label: 'Incident' };
      const closed = t.category === 8 || t.delayLevel === 4;
      if (t.geometry.length > 1) L.polyline(t.geometry, { color: closed ? '#ff4d4f' : '#ffb020', weight: 5, opacity: .8, dashArray: closed ? '6 6' : null }).addTo(this.trafficLayer);
      const m = L.marker([t.lat, t.lng], { icon: this.pin('traffic' + (closed ? ' closed' : ''), cat.emoji) });
      m.bindPopup(`<div class="t">${esc(cat.label)}</div><div class="small muted">${esc(t.description || t.from || 'Live traffic report')}</div>`);
      m.on('click', () => onClick?.(t));
      m.addTo(this.trafficLayer);
    }
  }

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

  // ----- explore: places -----
  /** places: Place[] (from providers/places.js); shapes come from the category's group, so categories differ by shape + emoji, not only colour. */
  renderPlaces(places, { shapeOf, emojiOf, activeId = null, ratings = {}, onClick } = {}) {
    this.placeLayer ||= L.layerGroup();
    this.placeLayer.clearLayers();
    for (const p of places) {
      const active = p.id === activeId;
      const r = ratings[p.key];
      const html = `<div class="place-marker ${shapeOf?.(p) || 'round'} ${active ? 'active' : ''}" title="${esc(p.name)}"><span>${emojiOf?.(p) || '📍'}</span>${r ? `<i>★${r.avg}</i>` : ''}</div>`;
      const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html, iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: active ? 800 : 500 });
      m.on('click', () => onClick?.(p));
      m.addTo(this.placeLayer);
    }
    if (places.length) this.placeLayer.addTo(this.map); else this.placeLayer.remove();
  }
  clearPlaces() { this.placeLayer?.clearLayers(); this.placeLayer?.remove(); }
  fitPoints(points, { pad = 40 } = {}) {
    if (!points.length) return;
    this.map.fitBounds(L.latLngBounds(points), { paddingTopLeft: [pad, 130], paddingBottomRight: [pad, window.innerWidth >= 900 ? 60 : Math.min(window.innerHeight * .45, 360)], maxZoom: 17 });
  }

  // ----- streetlights -----
  bounds() { const b = this.map.getBounds(); return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }; }
  zoom() { return this.map.getZoom(); }
  onMove(cb) { this.map.on('moveend zoomend', cb); }
  showLamps(show) { show ? this.lampLayer.addTo(this.map) : this.lampLayer.remove(); }
  /** lamps: Lamp[]; statusOf(lamp) → { status } ; onClick(lamp, status) */
  renderLamps(lamps, statusOf, onClick) {
    this.lampLayer.clearLayers();
    for (const l of lamps) {
      const st = statusOf(l);
      const m = L.marker([l.lat, l.lng], { icon: L.divIcon({ className: '', html: `<div class="lamp-marker ${st.status}" title="Streetlight"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }), zIndexOffset: 300 });
      m.on('click', () => onClick?.(l, st));
      m.addTo(this.lampLayer);
    }
  }
  /** Draw lighting classes along the selected route as a thin overlay (confirmed = warm, out = red). */
  renderLightingOverlay(segments) {
    this.lightOverlay.clearLayers();
    if (!segments) return;
    const style = {
      confirmed:  { color: '#ffd34d', opacity: .95 },
      out:        { color: '#ff5a7a', opacity: .95 },
      streetLit:  { color: '#ffd34d', opacity: .5 },
      streetDark: { color: '#ff5a7a', opacity: .6, dashArray: '4 6' },
    };
    for (const sg of segments) {
      const s = style[sg.cls];
      if (!s) continue;
      L.polyline([sg.a, sg.b], { ...s, weight: 3, interactive: false, lineCap: 'butt' }).addTo(this.lightOverlay);
    }
  }

  // ----- lit / unlit streets (OpenStreetMap lit=* + trusted community reports) -----
  showLitStreets(show) {
    this.litLayer ||= L.layerGroup();
    show ? this.litLayer.addTo(this.map) : this.litLayer.remove();
  }
  /** streets: Street[] (providers/litStreets.js); statusOf(street) → { lit, source }; onClick(street, status, [lat,lng]) */
  renderLitStreets(streets, statusOf, onClick) {
    this.litLayer ||= L.layerGroup();
    this.litRenderer ||= L.canvas({ padding: 0.3, tolerance: 10 });   // canvas: thousands of lines stay smooth; tolerance = easy tapping
    this.litLayer.clearLayers();
    for (const st of streets) {
      const s = statusOf(st);
      const community = s.source === 'community';
      const line = L.polyline(st.coords, s.lit
        ? { renderer: this.litRenderer, color: '#ffd34d', weight: community ? 6 : 5, opacity: community ? .75 : .38, lineCap: 'round' }
        : { renderer: this.litRenderer, color: '#ff5a7a', weight: community ? 4 : 3, opacity: community ? .9 : .7, dashArray: '5 7', lineCap: 'butt' });
      line.on('click', (e) => { L.DomEvent.stopPropagation(e); onClick?.(st, s, [e.latlng.lat, e.latlng.lng]); });
      line.addTo(this.litLayer);
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

  invalidate() { this.map.invalidateSize(); this.basemap?.invalidate(); }
}
