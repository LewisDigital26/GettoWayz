// Offline map packs — save an area of the map on this device so it still shows with no signal.
//
// What a pack holds (all in Cache Storage "gw-offline-map-v1", served by sw.js when the network fails):
//   • OpenFreeMap vector tiles for the area, zoom 10–14 (MapLibre over-zooms 14 for street level)
//   • the map style, tile index, sprites and Latin fonts it needs
//   • the low-zoom shaded-relief tiles for the whole UK (tiny)
// Community paths and alerts are kept separately (last copy in localStorage, see snapshotCommunity).
// Routing and search still need a connection — the app says so when offline.
import { config } from './config.js';

export const OFFLINE_CACHE = 'gw-offline-map-v1';
const META_KEY = 'gw:offlinePacks';
const DATA_KEY = 'gw:offlineData';
const MIN_Z = 10, MAX_Z = 14;
export const MAX_TILES = 2500;
const AVG_TILE_BYTES = 90000; // rough average for OpenFreeMap city tiles, for the size estimate only
const STYLE_BYTES = 900000;   // style, fonts, icons and relief tiles (downloaded once)
const FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];
const GLYPH_RANGES = ['0-255', '256-511', '8192-8447'];

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full / private mode */ } };

/** Version-free cache key for an OpenFreeMap tile, so packs survive OpenFreeMap's weekly data refresh. (sw.js uses the same rule.) */
export function tileKey(url) {
  return url.replace(/^(https:\/\/tiles\.openfreemap\.org\/planet)\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, '$1/_/$2');
}

// slippy-map tile maths
const lon2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };

/** Tiles covering a bbox {south, west, north, east} for zooms MIN_Z..MAX_Z. */
export function tilesFor(b, minZ = MIN_Z, maxZ = MAX_Z) {
  const out = [];
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = lon2x(b.west, z), x1 = lon2x(b.east, z), y0 = lat2y(b.north, z), y1 = lat2y(b.south, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}
export const estimateBytes = (n) => STYLE_BYTES + n * AVG_TILE_BYTES;

/** A bbox of radius `km` around a point. */
export function bboxAround([lat, lng], km) {
  const dLat = km / 111, dLng = km / (111 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

export const listPacks = () => load(META_KEY, []);
export const offlineSupported = () => 'caches' in window && 'serviceWorker' in navigator && config.BASEMAP === 'vector' && /openfreemap\.org/.test(config.VECTOR_STYLE_URL);

async function getJSON(url, signal) { const r = await fetch(url, { signal }); if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`); return r.json(); }

/** Fetch everything the style needs apart from tiles; returns the vector tile URL template. */
async function styleAssets(cache, signal) {
  const style = await getJSON(config.VECTOR_STYLE_URL, signal);
  const urls = [config.VECTOR_STYLE_URL];
  let template = null;
  for (const src of Object.values(style.sources || {})) {
    if (src.type === 'vector' && src.url) { urls.push(src.url); template = (await getJSON(src.url, signal)).tiles?.[0] || null; }
  }
  if (style.sprite) for (const s of ['', '@2x']) urls.push(`${style.sprite}${s}.json`, `${style.sprite}${s}.png`);
  if (style.glyphs) for (const f of FONTS) for (const r of GLYPH_RANGES) urls.push(style.glyphs.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', r));
  // shaded relief (z0–6) for the UK only — a few small images
  const ne = Object.values(style.sources || {}).find((s) => s.type === 'raster' && s.tiles?.[0]);
  if (ne) for (const [z, x, y] of tilesFor({ south: 49.8, west: -8.7, north: 60.9, east: 1.9 }, 0, Math.min(6, ne.maxzoom ?? 6))) urls.push(ne.tiles[0].replace('{z}', z).replace('{x}', x).replace('{y}', y));
  for (const u of urls) {
    const r = await fetch(u, { signal });
    if (r.ok) await cache.put(u, r);
  }
  if (!template) throw new Error('Could not find the map tile address in the style.');
  return template;
}

/**
 * Download a pack. onProgress({ done, total, failed, bytes }). Returns the saved pack's metadata.
 * Tiles already saved by another pack are skipped.
 */
export async function downloadPack({ name, bbox }, { onProgress, signal } = {}) {
  const tiles = tilesFor(bbox);
  if (tiles.length > MAX_TILES) throw new Error(`That area is too big (${tiles.length} map tiles). Zoom in or pick a smaller area.`);
  try { await navigator.storage?.persist?.(); } catch { /* best effort: ask the browser not to clear it */ }
  const cache = await caches.open(OFFLINE_CACHE);
  const template = await styleAssets(cache, signal);
  let done = 0, failed = 0, bytes = 0;
  const queue = [...tiles];
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const [z, x, y] = queue.shift();
      const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const key = tileKey(url);
      try {
        const hit = await cache.match(key);
        if (hit) { bytes += Number(hit.headers.get('content-length')) || 0; }
        else {
          const r = await fetch(url, { signal });
          if (!r.ok && r.status !== 204) throw new Error(String(r.status));
          const buf = await r.clone().arrayBuffer(); bytes += buf.byteLength;
          await cache.put(key, r);
        }
      } catch (e) { if (e.name === 'AbortError') throw e; failed++; }
      done++; onProgress?.({ done, total: tiles.length, failed, bytes });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker)); // 6 at a time: quick, and polite to the free tile server
  const pack = { id: `pk-${Date.now().toString(36)}`, name: String(name || 'Saved area').slice(0, 40), bbox, tiles: tiles.length, failed, bytes, at: new Date().toISOString() };
  save(META_KEY, [...listPacks(), pack]);
  return pack;
}

/** Delete a pack's tiles (keeping any another pack still needs) and its record. */
export async function deletePack(id) {
  const packs = listPacks(), pack = packs.find((p) => p.id === id);
  if (!pack) return;
  const rest = packs.filter((p) => p.id !== id);
  save(META_KEY, rest);
  const cache = await caches.open(OFFLINE_CACHE);
  if (!rest.length) { await caches.delete(OFFLINE_CACHE); return; }
  const keep = new Set(rest.flatMap((p) => tilesFor(p.bbox).map(([z, x, y]) => `${z}/${x}/${y}`)));
  for (const [z, x, y] of tilesFor(pack.bbox)) if (!keep.has(`${z}/${x}/${y}`)) await cache.delete(`https://tiles.openfreemap.org/planet/_/${z}/${x}/${y}.pbf`);
}

/** Is a point inside any saved pack? */
export const coveredBy = (lat, lng) => listPacks().find((p) => lat >= p.bbox.south && lat <= p.bbox.north && lng >= p.bbox.west && lng <= p.bbox.east) || null;

// ---------- community data for offline use ----------
// The last approved paths and active alerts are kept on the device so the map still shows them with no signal.
export function snapshotCommunity({ alerts, paths }) {
  save(DATA_KEY, { at: new Date().toISOString(), alerts: alerts.slice(0, 500), paths: paths.filter((p) => p.status === 'approved').slice(0, 500) });
}
export function loadCommunitySnapshot() { return load(DATA_KEY, null); }

export async function storageUse() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; }
}
