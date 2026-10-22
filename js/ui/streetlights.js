// Streetlight layer controller: night detection, auto/on/off control, lamp loading, lamp detail + reporting,
// and route lighting scoring. Lamp *positions* come from the provider; *status* comes only from community reports.
import { $, $$, el, esc, fmtAgo, sunTimes } from '../util.js';
import { state, set } from '../state.js';
import { STREETLIGHTS, ALERT_CATEGORIES } from '../backend/rules.js';
import { deriveLampStatus, scoreRouteLighting } from '../providers/streetlights.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';
import { requireSignIn } from './account.js';
import { openReportFlow } from './alerts.js';

const PREF_KEY = 'gw:lights';
const clock = (d) => d ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : '—';

export class Streetlights {
  constructor(ctx) {
    this.ctx = ctx;
    this.provider = ctx.streetlights;         // may be null (STREETLIGHT_SOURCE: 'none')
    this.lamps = [];                          // lamps loaded for the current view / route area
    this.loadedBounds = null;
    this.mode = 'auto';                       // auto | on | off (user preference, this device only)
    try { this.mode = localStorage.getItem(PREF_KEY) || 'auto'; } catch { /* ignore */ }
    this.loading = false; this.error = null;
    this.bindControls();
    ctx.map.onMove(() => this.onViewChange());
    setInterval(() => this.refreshNight(), 60000);
    this.refreshNight();
    this.apply();
  }

  // ---------- night detection (astronomical, computed locally — no location stored) ----------
  sun() {
    const [lat, lng] = state.position ? [state.position.lat, state.position.lng] : this.ctx.map.center();
    return sunTimes(new Date(), lat, lng);
  }
  refreshNight() {
    const s = this.sun();
    const was = this.isNight;
    this.isNight = s.isNight; this.sunInfo = s;
    const badge = $('#nightBadge');
    badge.hidden = false;
    badge.textContent = s.isNight ? `Night · sunrise ${clock(s.sunrise)}` : `Day · sunset ${clock(s.sunset)}`;
    badge.className = 'chip ' + (s.isNight ? 'accent' : '');
    if (was !== undefined && was !== this.isNight && this.mode === 'auto') { this.apply(); toast(this.isNight ? 'It is after sunset — streetlight layer is on' : 'Sunrise — streetlight layer is off'); }
  }
  visible() {
    if (!this.provider) return false;
    return this.mode === 'on' || (this.mode === 'auto' && this.isNight);
  }

  // ---------- controls ----------
  bindControls() {
    $$('#lightsMode button').forEach((b) => b.addEventListener('click', () => {
      this.mode = b.dataset.v;
      try { localStorage.setItem(PREF_KEY, this.mode); } catch { /* ignore */ }
      this.apply();
    }));
  }
  apply() {
    $$('#lightsMode button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === this.mode));
    const note = $('#lightsNote'), legend = $('#lightsLegend');
    if (!this.provider) { note.textContent = 'No streetlight data source is configured.'; legend.hidden = true; this.ctx.map.showLamps(false); return; }
    const vis = this.visible();
    this.ctx.map.showLamps(vis);
    legend.hidden = !vis;
    note.textContent = vis
      ? (this.provider.isLive ? 'Positions: OpenStreetMap. Status: community reports only — a lamp on the map is not known to be working.' : 'SAMPLE lamps — generated for the demo, not real positions.')
      : (this.mode === 'auto' ? `Turns on automatically after sunset (${clock(this.sunInfo?.sunset)}).` : 'Streetlight layer is off.');
    if (vis) this.onViewChange(true);
    this.ctx.rerenderRouteSheet?.();
  }

  // ---------- loading ----------
  async onViewChange(force = false) {
    try { await this._onViewChange(force); } catch (e) { $('#lightsNote').textContent = 'Streetlight layer error: ' + e.message; }
  }
  async _onViewChange(force = false) {
    if (!this.visible()) return;
    if (this.ctx.map.zoom() < STREETLIGHTS.minZoom) { $('#lightsNote').textContent = 'Zoom in to see streetlights.'; this.lamps = []; this.ctx.map.renderLamps([], () => ({ status: 'unknown' })); return; }
    const b = this.ctx.map.bounds();
    if (!force && this.loadedBounds && b.south >= this.loadedBounds.south && b.north <= this.loadedBounds.north && b.west >= this.loadedBounds.west && b.east <= this.loadedBounds.east) { this.render(); return; }
    await this.load(pad(b, 0.3));
    this.render();
  }
  async load(b) {
    if (!this.provider) return;
    this.loading = true; this.error = null;
    $('#lightsNote').textContent = 'Loading streetlight positions…';
    try {
      this.lamps = await this.provider.fetchLamps(b);
      this.loadedBounds = b;
      $('#lightsNote').textContent = `${this.lamps.length} lamp${this.lamps.length === 1 ? '' : 's'} in view · ${this.provider.isLive ? 'positions from OpenStreetMap' : 'SAMPLE data'}. Status comes only from community reports.`;
    } catch (e) {
      if (e.name !== 'AbortError') { this.error = e.message; this.loadedBounds = null; $('#lightsNote').textContent = e.message; }
    } finally { this.loading = false; }
  }
  /** Ensure lamps are loaded for an arbitrary bbox (used for route scoring). Returns true if data covers it. */
  async ensureCoverage(b) {
    if (!this.provider) return false;
    const inside = this.loadedBounds && b.south >= this.loadedBounds.south && b.north <= this.loadedBounds.north && b.west >= this.loadedBounds.west && b.east <= this.loadedBounds.east;
    if (inside) return true;
    try { await this.load(pad(b, 0.15)); return !this.error; } catch { return false; }
  }
  statusOf(lamp) { return deriveLampStatus(lamp, state.alerts); }
  render() {
    this.ctx.map.renderLamps(this.lamps, (l) => this.statusOf(l), (l, st) => this.openLamp(l, st));
  }

  // ---------- route scoring ----------
  async scoreRoute(route) {
    if (!this.provider) return { covered: false, pct: { nodata: 100 }, segments: [] };
    const lats = route.geometry.map((p) => p[0]), lngs = route.geometry.map((p) => p[1]);
    const b = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
    const covered = await this.ensureCoverage(b);
    return scoreRouteLighting(route.geometry, this.lamps, (l) => this.statusOf(l), { covered });
  }

  // ---------- lamp detail & reporting ----------
  openLamp(lamp, st) {
    const ctx = this.ctx;
    const label = { working: 'Recently confirmed working', out: 'Reported out', unknown: 'Unknown — not verified' }[st.status];
    const cls = { working: 'verified', out: 'danger', unknown: '' }[st.status];
    const report = (category) => {
      if (!requireSignIn(ctx, 'report a streetlight')) return;
      closeModal();
      openReportFlow(ctx, [lamp.lat, lamp.lng], { preset: category, lamp: true });
    };
    openModal('Streetlight', [
      el('div', { class: 'row wrap', style: 'margin-bottom:8px' },
        el('span', { class: `chip ${cls}` }, label),
        lamp.source === 'sample' ? el('span', { class: 'chip sample' }, 'Sample') : el('span', { class: 'chip' }, 'Position: OpenStreetMap'),
        st.verified ? el('span', { class: 'chip verified' }, 'Moderator verified') : null,
        st.confirmations ? el('span', { class: 'chip accent' }, `${st.confirmations} confirmed`) : null),
      el('p', { class: 'muted small' }, st.confirmedAt ? `Last report ${fmtAgo(st.confirmedAt)}${st.stale ? ' (too old to count as confirmed)' : ''}` : 'No community reports for this lamp.', lamp.ref ? ` · Lamp ref ${esc(lamp.ref)}` : ''),
      el('div', { class: 'notice' }, st.status === 'working'
        ? `Someone saw this lamp working within the last ${STREETLIGHTS.confirmedDays} days. That is a community report, not a live feed — it may have changed since.`
        : st.status === 'out'
          ? 'Reported as not working. Reports expire automatically; confirm or update it if you pass by.'
          : 'A lamp being on the map does not mean it works. Only community reports change its status.'),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'btn primary', onclick: () => report('light_ok') }, '💡 Seen it working'),
        el('button', { class: 'btn', onclick: () => report('light_out') }, '🔦 Report out')),
      st.reports.length ? el('div', { style: 'margin-top:10px' }, el('h3', { style: 'font-size:13px;margin:0 0 6px' }, 'Report history'),
        el('div', { class: 'list' }, ...st.reports.slice(0, 5).map((a) => el('div', { class: 'item' }, el('div', { class: 'emoji' }, ALERT_CATEGORIES[a.category].emoji),
          el('div', { class: 'body' }, el('div', { class: 't' }, ALERT_CATEGORIES[a.category].label), el('div', { class: 's' }, `${fmtAgo(a.createdAt)} · ${a.status === 'verified' ? 'verified' : 'awaiting confirmation'}`)))))) : null,
    ]);
  }
}

function pad(b, f) {
  const dh = (b.north - b.south) * f, dw = (b.east - b.west) * f;
  return { south: b.south - dh, north: b.north + dh, west: b.west - dw, east: b.east + dw };
}

/** Small UI block describing a route's lighting coverage honestly. */
export function lightingBlock(score, { night }) {
  if (!score) return null;
  if (!score.covered) return el('div', { class: 'notice' }, '🔦 No streetlight data loaded for this route, so nothing is known about its lighting.');
  const p = score.pct;
  const bar = el('div', { class: 'lightbar' },
    el('i', { class: 'c', style: `width:${p.confirmed}%` }), el('i', { class: 'o', style: `width:${p.out}%` }), el('i', { class: 'u', style: `width:${p.unknown}%` }), el('i', { class: 'n', style: `width:${p.nodata}%` }));
  const summary = p.confirmed >= 60 ? `${p.confirmed}% of this route has lamps confirmed working recently.`
    : p.confirmed > 0 ? `Only ${p.confirmed}% of this route has lamps confirmed working; ${p.unknown + p.nodata}% has no confirmed information.`
    : `No part of this route has a lamp confirmed working recently. ${p.unknown > 0 ? `${p.unknown}% has lamps of unknown status; ` : ''}${p.nodata}% has no lamp data at all.`;
  return el('div', { class: 'notice' },
    el('div', { style: 'font-weight:600' }, '🔦 Lighting data', night ? '' : ' (daytime)'),
    bar,
    el('div', { class: 'lightkey' }, el('span', {}, el('i', { style: 'background:#ffd34d' }), `${p.confirmed}% confirmed`), el('span', {}, el('i', { style: 'background:#ff5a7a' }), `${p.out}% reported out`), el('span', {}, el('i', { style: 'background:#8a93ad' }), `${p.unknown}% unknown`), el('span', {}, el('i', { style: 'background:transparent;border:1px solid var(--line)' }), `${p.nodata}% no data`)),
    el('div', { class: 'small', style: 'margin-top:6px' }, summary, ' Lighting is one factor, not a safety guarantee.'));
}
