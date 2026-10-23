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

  /** Incidents within `metres` of a route line (the route sheet shows these next to community alerts). */
  nearRoute(geometry, metres = 30) {
    return this.incidents.filter((t) => t.geometry.some((p) => distanceToLine(p, geometry) <= metres));
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
