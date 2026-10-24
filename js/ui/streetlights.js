// Streetlight layer controller: night detection, auto/on/off control, lamp loading, lamp detail + reporting,
// and route lighting scoring. Lamp *positions* come from the provider; *status* comes only from community reports.
import { $, $$, el, esc, fmtAgo, sunTimes } from '../util.js';
import { state, set } from '../state.js';
import { STREETLIGHTS, STREET_LIGHTING, ALERT_CATEGORIES } from '../backend/rules.js';
import { deriveLampStatus, scoreRouteLighting } from '../providers/streetlights.js';
import { LitStreets, streetStatus, streetLightingAt } from '../providers/litStreets.js';
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
    this.lit = this.provider?.name === 'sample' || !this.provider ? null : new LitStreets();   // lit/unlit streets snapshot
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
    if (!this.provider) { note.textContent = 'No streetlight data source is configured.'; legend.hidden = true; this.ctx.map.showLamps(false); this.ctx.map.showLitStreets(false); return; }
    const vis = this.visible();
    this.ctx.map.showLamps(vis);
    this.ctx.map.showLitStreets(vis && !!this.lit);
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
    if (this.ctx.map.zoom() < STREETLIGHTS.minZoom) { $('#lightsNote').textContent = 'Zoom in to see streetlights and lit streets.'; this.lamps = []; this.ctx.map.renderLamps([], () => ({ status: 'unknown' })); this.ctx.map.renderLitStreets([], () => ({})); return; }
    const b = this.ctx.map.bounds();
    if (!force && this.loadedBounds && b.south >= this.loadedBounds.south && b.north <= this.loadedBounds.north && b.west >= this.loadedBounds.west && b.east <= this.loadedBounds.east) { this.render(); return; }
    await this.load(pad(b, 0.3));
    this.render();
  }
  async load(b) {
    if (!this.provider) return;
    this.loading = true; this.error = null;
    $('#lightsNote').textContent = 'Loading streetlight positions…';
    const litLoad = this.lit ? this.lit.load().catch(() => null) : null;   // lit streets load alongside the lamps
    try {
      this.lamps = await this.provider.fetchLamps(b);
      this.loadedBounds = b;
      await litLoad;
      const nStreets = this.lit?.ready ? this.lit.inBounds(this.ctx.map.bounds()).length : 0;
      $('#lightsNote').textContent = `${this.lamps.length} lamp${this.lamps.length === 1 ? '' : 's'}${this.lit?.ready ? ` · ${nStreets} lit/unlit street section${nStreets === 1 ? '' : 's'}` : ''} in view · ${this.provider.isLive ? 'from OpenStreetMap' : 'SAMPLE data'}. Tap a street to say if it's lit.`;
    } catch (e) {
      await litLoad;
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
    if (this.lit?.ready) {
      const streets = this.lit.inBounds(pad(this.ctx.map.bounds(), 0.2));
      this.ctx.map.renderLitStreets(streets, (st) => streetStatus(st, state.alerts), (st, s, ll) => this.openStreet(st, s, ll));
    }
  }

  // ---------- route scoring ----------
  async scoreRoute(route) {
    if (!this.provider) return { covered: false, pct: { nodata: 100 }, segments: [] };
    const lats = route.geometry.map((p) => p[0]), lngs = route.geometry.map((p) => p[1]);
    const b = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
    let covered = await this.ensureCoverage(b);
    if (this.lit) { try { await this.lit.load(); if (this.lit.covers(b)) covered = true; } catch { /* lamps only */ } }
    return scoreRouteLighting(route.geometry, this.lamps, (l) => this.statusOf(l), { covered, streetAt: (pt) => streetLightingAt(this.lit, state.alerts, pt) });
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

/** Street sheet: OSM tag, trusted/pending community reports, and "it's lit / it's dark" buttons. */
Streetlights.prototype.openStreet = function openStreet(street, st, tapLL) {
  const ctx = this.ctx;
  const report = (category) => {
    if (!requireSignIn(ctx, 'report street lighting')) return;
    closeModal();
    openReportFlow(ctx, tapLL, { preset: category, street: true });
  };
  const confirm = async (a) => {
    if (!requireSignIn(ctx, 'confirm a report')) return;
    try { await ctx.backend.confirmAlert(a.id); toast('Thanks — confirmation recorded', 'success'); closeModal(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const me = state.user?.id;
  const label = st.lit ? '🔆 Lit at night' : '🌑 Dark at night';
  const sourceText = st.source === 'community'
    ? `From a community report ${st.trusted.status === 'verified' ? 'verified by a moderator' : `confirmed by ${st.trusted.confirmations.length} people`} ${fmtAgo(st.trusted.createdAt)}. It overrides OpenStreetMap, which says this street is ${street.lit ? 'lit' : 'unlit'}.`
    : `OpenStreetMap volunteers tagged this street as ${street.lit ? 'lit' : 'unlit'}. Tags can be out of date — if it's wrong, say so below.`;
  openModal('Street lighting', [
    el('div', { class: 'row wrap', style: 'margin-bottom:8px' },
      el('span', { class: `chip ${st.lit ? 'verified' : 'danger'}` }, label),
      el('span', { class: 'chip' }, st.source === 'community' ? 'Community' : 'OpenStreetMap')),
    el('p', { class: 'muted small' }, sourceText),
    st.pending.length ? el('div', { style: 'margin:8px 0' },
      el('h3', { style: 'font-size:13px;margin:0 0 6px' }, 'Waiting for confirmation'),
      el('div', { class: 'list' }, ...st.pending.slice(0, 3).map((a) => {
        const cat = ALERT_CATEGORIES[a.category];
        const mine = a.createdBy === me, done = a.confirmations.includes(me);
        return el('div', { class: 'item' }, el('div', { class: 'emoji' }, cat.emoji),
          el('div', { class: 'body' }, el('div', { class: 't' }, cat.label),
            el('div', { class: 's' }, `${fmtAgo(a.createdAt)} · ${a.confirmations.length}/${STREET_LIGHTING.confirmationsToTrust} confirmations`),
            el('div', { class: 'meta' }, mine ? el('span', { class: 'chip' }, 'Your report') : done ? el('span', { class: 'chip accent' }, 'Confirmed ✓')
              : el('button', { class: 'btn sm', onclick: () => confirm(a) }, 'I can confirm this'))));
      }))) : null,
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { class: 'btn primary', onclick: () => report('street_lit') }, '🔆 It\'s lit'),
      el('button', { class: 'btn', onclick: () => report('street_dark') }, '🌑 It\'s dark')),
    el('div', { class: 'notice', style: 'margin-top:10px' }, `Earn points when your report is confirmed by ${STREET_LIGHTING.confirmationsToTrust} other people or verified by a moderator. Only report what you've seen at night. Lighting is one factor, not a safety guarantee.`),
  ]);
};

function pad(b, f) {
  const dh = (b.north - b.south) * f, dw = (b.east - b.west) * f;
  return { south: b.south - dh, north: b.north + dh, west: b.west - dw, east: b.east + dw };
}

/** Small UI block describing a route's lighting coverage honestly. */
export function lightingBlock(score, { night }) {
  if (!score) return null;
  if (!score.covered) return el('div', { class: 'notice' }, '🔦 No streetlight data loaded for this route, so nothing is known about its lighting.');
  const p = score.pct;
  const sl = p.streetLit || 0, sd = p.streetDark || 0;
  const bar = el('div', { class: 'lightbar' },
    el('i', { class: 'c', style: `width:${p.confirmed}%` }), el('i', { class: 'l', style: `width:${sl}%` }), el('i', { class: 'o', style: `width:${p.out}%` }), el('i', { class: 'd', style: `width:${sd}%` }), el('i', { class: 'u', style: `width:${p.unknown}%` }), el('i', { class: 'n', style: `width:${p.nodata}%` }));
  const parts = [];
  if (p.confirmed) parts.push(`${p.confirmed}% has lamps confirmed working recently`);
  if (sl) parts.push(`${sl}% runs along streets tagged as lit`);
  if (sd) parts.push(`${sd}% is on streets marked dark`);
  if (p.out) parts.push(`${p.out}% has a lamp reported out`);
  if (p.unknown) parts.push(`${p.unknown}% has lamps of unknown status`);
  const summary = parts.length ? `${parts.join('; ')}. ${p.nodata}% has no lighting information.`
    : 'Nothing is known about the lighting on this route.';
  return el('div', { class: 'notice' },
    el('div', { style: 'font-weight:600' }, '🔦 Lighting data', night ? '' : ' (daytime)'),
    bar,
    el('div', { class: 'lightkey' }, el('span', {}, el('i', { style: 'background:#ffd34d' }), `${p.confirmed}% confirmed`), el('span', {}, el('i', { style: 'background:rgba(255,211,77,.45)' }), `${sl}% lit street`), el('span', {}, el('i', { style: 'background:#ff5a7a' }), `${p.out}% reported out`), el('span', {}, el('i', { style: 'background:repeating-linear-gradient(90deg,#ff5a7a 0 3px,transparent 3px 5px)' }), `${sd}% dark street`), el('span', {}, el('i', { style: 'background:#8a93ad' }), `${p.unknown}% unknown`), el('span', {}, el('i', { style: 'background:transparent;border:1px solid var(--line)' }), `${p.nodata}% no data`)),
    el('div', { class: 'small', style: 'margin-top:6px' }, summary, ' Lighting is one factor, not a safety guarantee.'));
}
