// Lit / unlit streets — roads and paths OpenStreetMap tags lit=yes or lit=no, from the weekly snapshot
// data/coventry-lit.json (scripts/fetch-lit.mjs). Community "street is lit / dark" reports can override a
// street's tag, but only once they're trusted: verified by a moderator or confirmed by 2+ other people.
//
// Street = { id, lit: true|false, coords: [[lat,lng]…], s, w, n, e }
import { distanceToLine } from '../util.js';
import { STREET_LIGHTING } from '../backend/rules.js';

const CELL = 0.004;   // grid cell (deg) for the spatial index (~450 m north-south)
const cellKey = (i, j) => i * 100000 + j;

export class LitStreets {
  constructor(url = 'data/coventry-lit.json') {
    this.url = url;
    this.streets = null; this.grid = null; this.bbox = null; this.updated = null; this.stats = null;
    this.loading = null;
  }
  load() {
    this.loading ||= fetch(this.url, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((j) => {
        this.bbox = j.bbox; this.updated = j.updated; this.stats = j.stats || null;
        this.streets = [];
        this.grid = new Map();
        for (const [lit, id, flat] of j.ways || []) {
          const coords = [];
          for (let k = 0; k + 1 < flat.length; k += 2) coords.push([flat[k], flat[k + 1]]);
          if (coords.length < 2) continue;
          let s = 90, w = 180, n = -90, e = -180;
          for (const [la, lo] of coords) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
          const st = { id, lit: lit === 1, coords, s, w, n, e };
          const idx = this.streets.push(st) - 1;
          for (let i = Math.floor(s / CELL); i <= Math.floor(n / CELL); i++)
            for (let jj = Math.floor(w / CELL); jj <= Math.floor(e / CELL); jj++) {
              const k = cellKey(i, jj);
              let arr = this.grid.get(k); if (!arr) this.grid.set(k, (arr = []));
              arr.push(idx);
            }
        }
        return this;
      })
      .catch((e) => { this.loading = null; throw e; });
    return this.loading;
  }
  get ready() { return !!this.streets; }
  covers(b) { const x = this.bbox; return !!x && b.south >= x.south && b.north <= x.north && b.west >= x.west && b.east <= x.east; }

  /** Streets whose box overlaps b. */
  inBounds(b) {
    if (!this.streets) return [];
    const seen = new Set(), out = [];
    for (let i = Math.floor(b.south / CELL); i <= Math.floor(b.north / CELL); i++)
      for (let j = Math.floor(b.west / CELL); j <= Math.floor(b.east / CELL); j++)
        for (const idx of this.grid.get(cellKey(i, j)) || []) {
          if (seen.has(idx)) continue; seen.add(idx);
          const st = this.streets[idx];
          if (st.n >= b.south && st.s <= b.north && st.e >= b.west && st.w <= b.east) out.push(st);
        }
    return out;
  }

  /** Nearest street within maxM of pt, or null. */
  nearest(pt, maxM = STREET_LIGHTING.matchRadiusM) {
    const dLat = maxM / 111000, dLng = maxM / (111000 * Math.cos(pt[0] * Math.PI / 180));
    let best = null, bestD = Infinity;
    for (const st of this.inBounds({ south: pt[0] - dLat, north: pt[0] + dLat, west: pt[1] - dLng, east: pt[1] + dLng })) {
      const d = distanceToLine(pt, st.coords);
      if (d < bestD) { bestD = d; best = st; }
    }
    return best && bestD <= maxM ? { street: best, d: bestD } : null;
  }
}

/** A street-lighting report counts once a moderator verified it or 2+ other people confirmed it. */
export const isTrustedReport = (a) => a.status === 'verified' || (a.confirmations?.length || 0) >= STREET_LIGHTING.confirmationsToTrust;

/** Community reports (street_lit / street_dark) that sit on this street. Newest first. */
export function reportsOnStreet(street, alerts) {
  return alerts
    .filter((a) => (a.category === 'street_lit' || a.category === 'street_dark') && distanceToLine([a.lat, a.lng], street.coords) <= STREET_LIGHTING.matchRadiusM)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * A street's lighting: the newest TRUSTED community report wins, otherwise the OpenStreetMap tag.
 * Returns { lit: boolean, source: 'community'|'osm', trusted?: Alert, pending: Alert[], reports: Alert[] }
 */
export function streetStatus(street, alerts) {
  const reports = reportsOnStreet(street, alerts);
  const trusted = reports.find(isTrustedReport);
  const pending = reports.filter((a) => !isTrustedReport(a));
  if (trusted) return { lit: trusted.category === 'street_lit', source: 'community', trusted, pending, reports };
  return { lit: street.lit, source: 'osm', pending, reports };
}

/** For route scoring: 'lit' | 'dark' | null for the street nearest pt (within routeRadiusM). */
export function streetLightingAt(lit, alerts, pt) {
  if (!lit?.ready) return null;
  const hit = lit.nearest(pt, STREET_LIGHTING.routeRadiusM);
  if (!hit) return null;
  return streetStatus(hit.street, alerts).lit ? 'lit' : 'dark';
}

