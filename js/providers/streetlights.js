// Streetlight data provider abstraction.
//
// interface StreetlightProvider {
//   name: string; isLive: boolean; note: string;
//   fetchLamps(bounds: { south, west, north, east }) -> Promise<Lamp[]>
// }
// Lamp = { id, lat, lng, source: 'osm'|'sample', ref?: string }
//
// IMPORTANT: a provider only tells us WHERE lamps are. Whether a lamp is WORKING is never inferred from
// its presence — status comes only from dated community reports (see deriveLampStatus) or, in future, a
// live council feed plugged in as another provider that sets `liveStatus` on each lamp.

import { config } from '../config.js';
import { STREETLIGHTS } from '../backend/rules.js';
import { haversine } from '../util.js';
import { SAMPLE_ROUTES } from './sampleData.js';

/** OpenStreetMap lamp positions via the public Overpass API (no key; fair-use). Positions are real, statuses are not known. */
export class OverpassStreetlightProvider {
  constructor(url) {
    this.name = 'overpass';
    this.isLive = true;
    // Primary + public mirrors; tried in order with a timeout each. A custom OVERPASS_URL is used alone.
    this.urls = url ? [url] : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
    this.note = 'Lamp positions from OpenStreetMap (mapped by volunteers; coverage varies by area). Working status comes only from community reports.';
    this.cache = new Map(); // bbox key → { at, lamps }
    this.controller = null;
  }
  key(b) { return [b.south, b.west, b.north, b.east].map((v) => v.toFixed(3)).join(','); }
  async fetchLamps(b) {
    const k = this.key(b);
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.lamps;
    // keep requests small: refuse boxes bigger than ~3 km across
    if (haversine([b.south, b.west], [b.north, b.east]) > 8000) throw new Error('Zoom in to load streetlights for this area.');
    this.controller?.abort();
    this.controller = new AbortController();
    const q = `[out:json][timeout:12];node["highway"="street_lamp"](${b.south},${b.west},${b.north},${b.east});out 2000;`;
    let json = null, lastErr = null;
    for (const url of this.urls) {
      const timer = setTimeout(() => this.controller.abort(), 8000);
      try {
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: this.controller.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error(res.status === 429 ? 'the OpenStreetMap lamp server is at capacity' : `HTTP ${res.status}`);
        json = await res.json(); break;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error('no response within 8 s') : e;
        if (e.name === 'AbortError' && !this.controller.signal.aborted) throw e; // superseded by a newer request
        this.controller = new AbortController(); // fresh controller for the next mirror
      } finally { clearTimeout(timer); }
    }
    if (!json) throw new Error('Lamp positions are unavailable right now (' + (lastErr?.message || 'no response') + '). Lighting is shown as "no data" — nothing is assumed. Try again in a few minutes.');
    const lamps = (json.elements || []).map((n) => ({ id: 'osm-' + n.id, lat: n.lat, lng: n.lon, source: 'osm', ref: n.tags?.ref || null }));
    this.cache.set(k, { at: Date.now(), lamps });
    return lamps;
  }
}

/**
 * Lamp positions from a snapshot file shipped with the app (data/coventry-lamps.json), refreshed weekly by
 * a GitHub Action (scripts/fetch-lamps.mjs). Instant and works when Overpass is down. Areas outside the
 * snapshot's box fall back to live Overpass. A council FOI dataset can later replace the file as-is.
 */
export class SnapshotStreetlightProvider {
  constructor(url = 'data/coventry-lamps.json', fallback = null) {
    this.name = 'snapshot';
    this.isLive = true;
    this.url = url;
    this.fallback = fallback;
    this.note = 'Lamp positions from OpenStreetMap (mapped by volunteers; coverage varies by area). Working status comes only from community reports.';
    this.data = null;      // { bbox, updated, lamps: Lamp[] }
    this.loading = null;
  }
  load() {
    this.loading ||= fetch(this.url, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((j) => {
        const lamps = (j.lamps || []).map(([lat, lng, id, ref]) => ({ id: 'osm-' + id, lat, lng, source: 'osm', ref: ref || null }));
        this.data = { bbox: j.bbox, updated: j.updated, lamps };
        if (j.updated) this.note = `Lamp positions from OpenStreetMap, updated ${new Date(j.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (mapped by volunteers; coverage varies). Working status comes only from community reports.`;
        return this.data;
      })
      .catch((e) => { this.loading = null; throw e; });   // allow a retry on the next view change
    return this.loading;
  }
  covers(b) {
    const x = this.data?.bbox;
    return !!x && b.south >= x.south && b.north <= x.north && b.west >= x.west && b.east <= x.east;
  }
  async fetchLamps(b) {
    let data = null;
    try { data = await this.load(); } catch { /* snapshot missing → live fallback */ }
    if (data && this.covers(b)) {
      return data.lamps.filter((l) => l.lat >= b.south && l.lat <= b.north && l.lng >= b.west && l.lng <= b.east);
    }
    if (this.fallback) return this.fallback.fetchLamps(b);
    throw new Error('Lamp positions are only available around Coventry for now.');
  }
}

/** Sample lamps — DEMO ONLY. Points are generated along the sample routes and clearly labelled; they are not real lamp locations. */
export class SampleStreetlightProvider {
  constructor() {
    this.name = 'sample';
    this.isLive = false;
    this.note = 'Sample streetlights: generated positions for the demo, not real lamps.';
    this.lamps = null;
  }
  build() {
    const out = []; let n = 0;
    for (const pair of SAMPLE_ROUTES) for (const r of pair.routes) {
      const g = r.geometry;
      for (let i = 1; i < g.length; i++) {
        const [a, b] = [g[i - 1], g[i]];
        const d = haversine(a, b); const steps = Math.max(1, Math.round(d / 35));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          out.push({ id: 'sample-' + (n++), lat: +(a[0] + (b[0] - a[0]) * t + 0.00008).toFixed(6), lng: +(a[1] + (b[1] - a[1]) * t).toFixed(6), source: 'sample' });
        }
      }
    }
    return out;
  }
  async fetchLamps(b) {
    this.lamps ||= this.build();
    return this.lamps.filter((l) => l.lat >= b.south && l.lat <= b.north && l.lng >= b.west && l.lng <= b.east);
  }
}

export function createStreetlightProvider() {
  const src = config.STREETLIGHT_SOURCE;
  if (src === 'none') return null;
  if (src === 'sample') return new SampleStreetlightProvider();
  if (src === 'overpass-live') return new OverpassStreetlightProvider(config.OVERPASS_URL);
  // Default ('overpass' / 'osm'): OpenStreetMap lamps from the shipped snapshot, live Overpass only outside its area.
  return new SnapshotStreetlightProvider(config.STREETLIGHT_SNAPSHOT_URL || 'data/coventry-lamps.json', new OverpassStreetlightProvider(config.OVERPASS_URL));
}

/**
 * Derive a lamp's status from community alerts near it. Returns
 *   { status: 'working'|'out'|'unknown', confirmedAt?, verified?: boolean, reports: Alert[] }
 * 'working' requires a light_ok report within STREETLIGHTS.confirmedDays; a newer light_out overrides it.
 */
export function deriveLampStatus(lamp, alerts, now = Date.now()) {
  const near = alerts
    .filter((a) => (a.category === 'light_out' || a.category === 'light_ok') && haversine([lamp.lat, lamp.lng], [a.lat, a.lng]) <= STREETLIGHTS.matchRadiusM)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (lamp.liveStatus) return { status: lamp.liveStatus, confirmedAt: lamp.liveAt, live: true, reports: near };
  if (!near.length) return { status: 'unknown', reports: [] };
  const latest = near[0];
  const ageDays = (now - new Date(latest.createdAt)) / 86400000;
  if (latest.category === 'light_ok' && ageDays <= STREETLIGHTS.confirmedDays) return { status: 'working', confirmedAt: latest.createdAt, verified: latest.status === 'verified', confirmations: latest.confirmations?.length || 0, reports: near };
  if (latest.category === 'light_out') return { status: 'out', confirmedAt: latest.createdAt, verified: latest.status === 'verified', confirmations: latest.confirmations?.length || 0, reports: near };
  return { status: 'unknown', reports: near, stale: true, confirmedAt: latest.createdAt };
}

/**
 * Score a route's lighting from nearby lamps + their derived statuses.
 * Samples the route every STREETLIGHTS.sampleStepM metres; each sample is classed by the best lamp within routeRadiusM:
 *   confirmed (a lamp recently confirmed working) > out (nearest lamp reported out) > unknown (lamp present, no report) > nodata (no lamp known)
 * `covered` is false when lamp data was not loaded for the route's area at all.
 */
export function scoreRouteLighting(geometry, lamps, statusOf, { covered = true } = {}) {
  const counts = { confirmed: 0, out: 0, unknown: 0, nodata: 0 };
  const segments = []; // [{ a:[lat,lng], b:[lat,lng], cls }]
  if (!covered || !geometry || geometry.length < 2) return { covered: false, pct: { confirmed: 0, out: 0, unknown: 0, nodata: 100 }, samples: 0, segments };
  const r = STREETLIGHTS.routeRadiusM;
  const classify = (pt) => {
    let best = 'nodata';
    for (const l of lamps) {
      if (haversine(pt, [l.lat, l.lng]) > r) continue;
      const s = statusOf(l).status;
      if (s === 'working') return 'confirmed';
      if (s === 'out' && best !== 'confirmed') best = 'out';
      else if (s === 'unknown' && best === 'nodata') best = 'unknown';
    }
    return best;
  };
  let total = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1], b = geometry[i];
    const d = haversine(a, b); const steps = Math.max(1, Math.ceil(d / STREETLIGHTS.sampleStepM));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const mid = [a[0] + (b[0] - a[0]) * (t0 + t1) / 2, a[1] + (b[1] - a[1]) * (t0 + t1) / 2];
      const cls = classify(mid);
      counts[cls]++; total++;
      segments.push({ a: [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], b: [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], cls });
    }
  }
  const pct = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, total ? Math.round((v / total) * 100) : 0]));
  return { covered: true, pct, samples: total, segments };
}
