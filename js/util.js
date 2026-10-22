// Small shared helpers — geometry, formatting, DOM.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === false || v == null) continue;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Haversine distance in metres between [lat,lng] points. */
export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function lineLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

/** Initial bearing (degrees) from a to b. */
export function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Minimum distance from point p to polyline (metres), approximated per-vertex and per-segment. */
export function distanceToLine(p, line) {
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    best = Math.min(best, haversine(p, line[i]));
    if (i > 0) {
      // project onto segment in a flat approximation
      const a = line[i - 1], b = line[i];
      const kx = Math.cos((p[0] * Math.PI) / 180) * 111320, ky = 110540;
      const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
        const px = ax + t * dx, py = ay + t * dy;
        best = Math.min(best, Math.hypot(px, py));
      }
    }
  }
  return best;
}

export function fmtDistance(m) {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
export function fmtDuration(s) {
  const m = Math.round(s / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export function fmtAgo(ts) {
  const d = Date.now() - new Date(ts).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
export function fmtIn(ts) {
  const d = new Date(ts).getTime() - Date.now();
  if (d <= 0) return 'expired';
  const h = Math.ceil(d / 3600000);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.ceil(h / 24)} days`;
}

export class BackendError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const sleep =(ms) => new Promise((r) => setTimeout(r, ms));

/** Read a CSS colour token (Leaflet needs literal colours, so look them up at render time). */
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#aaf129';
export const MODES = {
  walk: { label: 'Walk', emoji: '🚶', speed: 1.35, color: 'var(--route-walk)', get hex() { return cssVar('--route-walk'); } },
  bike: { label: 'Bike', emoji: '🚲', speed: 4.2, color: 'var(--route-bike)', get hex() { return cssVar('--route-bike'); } },
  scooter: { label: 'Scooter', emoji: '🛴', speed: 3.6, color: 'var(--route-scooter)', get hex() { return cssVar('--route-scooter'); } },
};
