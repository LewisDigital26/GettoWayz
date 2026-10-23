// Live traffic layer controller: toggle in the layers panel, refresh on map move + every 60 s,
// incident detail view, and a "traffic along this route" helper for the route sheet.
import { $, el, esc, fmtIn, fmtDistance, distanceToLine } from '../util.js';
import { state, set } from '../state.js';
import { TRAFFIC_CATEGORIES, DELAY_LABELS } from '../providers/traffic.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';

const PREF_KEY = 'gw:traffic';
const MIN_ZOOM = 11;            // below this the bbox gets too big for the API (10,000 km² cap) and too busy to read

export class Traffic {
  constructor(ctx) {
    this.ctx = ctx;
    this.provider = ctx.traffic;          // null when TOMTOM_API_KEY is empty
    this.incidents = [];
    this.timer = null; this.loading = false;
    const row = $('#layerTrafficRow');
    if (!this.provider) { row.hidden = true; return; }
    row.hidden = false;
    let on = false;
    try { on = localStorage.getItem(PREF_KEY) === '1'; } catch { /* ignore */ }
    const box = $('#layerTraffic');
    box.checked = on;
    box.addEventListener('change', () => this.setVisible(box.checked));
    ctx.map.onMove(() => { if (this.visible()) this.load(); });
    this.setVisible(on, { silent: true });
  }
  visible() { return !!this.provider && state.layers.traffic; }

  setVisible(on, { silent = false } = {}) {
    set({ layers: { ...state.layers, traffic: on } });
    try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    this.ctx.map.toggleTraffic(on, this.provider.flowTileUrl());
    $('#trafficLegend').hidden = !on;
    $('#trafficNote').hidden = !on;
    clearInterval(this.timer); this.timer = null;
    if (on) {
      this.timer = setInterval(() => this.load(), 60000);
      this.load();
      this.ctx.refreshRouteSheet?.();
      if (!silent) toast('Live traffic on — roads are coloured by current speed');
    } else {
      this.incidents = []; this.ctx.map.renderTraffic([]);
      this.ctx.refreshRouteSheet?.();
    }
  }

  async load() {
    if (!this.visible() || this.loading) return;
    const note = $('#trafficNote');
    if (this.ctx.map.zoom() < MIN_ZOOM) { note.textContent = 'Zoom in to see incidents'; this.incidents = []; this.ctx.map.renderTraffic([]); return; }
    this.loading = true;
    try {
      this.incidents = await this.provider.fetchIncidents(this.ctx.map.bounds());
      this.ctx.map.renderTraffic(this.incidents, { categories: TRAFFIC_CATEGORIES, onClick: (t) => this.openDetail(t) });
      const closed = this.incidents.filter((t) => t.category === 8).length;
      note.textContent = `${this.incidents.length} incident${this.incidents.length === 1 ? '' : 's'} in view${closed ? ` · ${closed} road closure${closed > 1 ? 's' : ''}` : ''} · TomTom, updates every minute`;
      this.ctx.refreshRouteSheet?.();
    } catch (e) {
      note.textContent = e.message;
    } finally { this.loading = false; }
  }

  /**
   * Incidents for the area covered by a set of route options (used to rank driving routes by real travel time).
   * Works with the map layer off. Skips areas over the API's size limit. Returns null if nothing could be fetched.
   */
  async fetchForRoutes(routes) {
    if (!this.provider || !routes?.length) return null;
    let s = 90, w = 180, n = -90, e = -180;
    for (const r of routes) for (const [la, ln] of r.geometry || []) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln); }
    if (s > n) return null;
    s -= 0.005; n += 0.005; w -= 0.008; e += 0.008;
    const km2 = (n - s) * 111 * (e - w) * 111 * Math.cos(((s + n) / 2) * Math.PI / 180);
    if (km2 > 9000) return null;           // TomTom caps a bbox at 10,000 km²
    try { this.routeIncidents = await this.provider.fetchIncidents({ south: s, west: w, north: n, east: e }); return this.routeIncidents; }
    catch { return null; }
  }

  /**
   * Incidents that lie along a route line: most of the incident's own points must be within `metres` of the route,
   * so a jam on a road that merely crosses the route doesn't count.
   */
  nearRoute(geometry, metres = 30) {
    const seen = new Set(), out = [];
    for (const t of [...(this.routeIncidents || []), ...this.incidents]) {
      if (seen.has(t.id)) continue; seen.add(t.id);
      const close = t.geometry.filter((p) => distanceToLine(p, geometry) <= metres).length;
      if (close && close >= Math.ceil(t.geometry.length * 0.5)) out.push(t);
    }
    return out;
  }

  openDetail(t) {
    const cat = TRAFFIC_CATEGORIES[t.category] || TRAFFIC_CATEGORIES[0];
    const where = [t.from && `From ${t.from}`, t.to && `to ${t.to}`].filter(Boolean).join(' ');
    openModal(`${cat.emoji} ${cat.label}`, [
      el('div', { class: 'row wrap', style: 'margin-bottom:8px' },
        el('span', { class: `chip ${t.delayLevel >= 3 ? 'pending' : 'accent'}` }, DELAY_LABELS[t.delayLevel] || DELAY_LABELS[0]),
        t.roads.length ? el('span', { class: 'chip' }, t.roads.join(', ')) : null,
        t.length ? el('span', { class: 'chip' }, fmtDistance(t.length)) : null),
      el('p', {}, t.description || el('span', { class: 'muted' }, 'No further details from the traffic service.')),
      where ? el('p', { class: 'small muted' }, where) : null,
      el('p', { class: 'small muted' }, [t.delay ? `Adds about ${Math.round(t.delay / 60)} min for drivers. ` : '', t.end ? `Expected to clear ${fmtIn(t.end)}.` : ''].join('')),
      el('div', { class: 'notice' }, 'Live data from TomTom, mainly from vehicles. It covers roads, not footpaths — but a closed or jammed road usually means busy pavements and bad crossings nearby.'),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: closeModal }, 'Close')),
    ]);
  }
}

export function trafficRow(t, ctx) {
  const cat = TRAFFIC_CATEGORIES[t.category] || TRAFFIC_CATEGORIES[0];
  return el('button', { class: 'item', style: 'text-align:left;border:0;width:100%', onclick: () => { closeModal(); ctx.map.flyTo([t.lat, t.lng], 16); ctx.trafficUi.openDetail(t); } },
    el('span', { class: 'emoji' }, cat.emoji),
    el('div', {}, el('div', { class: 't' }, cat.label), el('div', { class: 's' }, esc(t.description || t.roads.join(', ') || DELAY_LABELS[t.delayLevel]))));
}
