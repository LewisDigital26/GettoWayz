// Nearby places ("Quick finds") via the Overpass API — OpenStreetMap data, no key, fair-use.
// findNearby(category, [lat,lng]) -> Promise<Place[]>  Place = { id, name, sub, lat, lng, kind, source:'osm', dist }
import { haversine } from '../util.js';

export const QUICK_FINDS = [
  { key: 'food',    label: 'Food',    emoji: '🍔', amenity: ['restaurant', 'cafe', 'fast_food', 'pub'] },
  { key: 'petrol',  label: 'Petrol',  emoji: '⛽', amenity: ['fuel'] },
  { key: 'shops',   label: 'Shops',   emoji: '🛒', shop: ['supermarket', 'convenience'] },
  { key: 'cash',    label: 'Cash',    emoji: '💷', amenity: ['atm', 'bank'] },
  { key: 'chemist', label: 'Chemist', emoji: '💊', amenity: ['pharmacy'] },
  { key: 'toilets', label: 'Toilets', emoji: '🚻', amenity: ['toilets'] },
  { key: 'parks',   label: 'Parks',   emoji: '🌳', leisure: ['park'] },
];

// Fastest mirrors first; overpass-api.de is the busiest so it's the last resort.
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const PER_REQUEST_MS = 8000;   // fail fast and move to the next mirror
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();       // key -> { at, places }
let controller = null;

function cacheKey(cat, [lat, lng], radius) {
  // ~100 m grid so small GPS drift re-uses the same result
  return `${cat.key}:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}`;
}

export async function findNearby(cat, near, radius = 1000, { background = false } = {}) {
  const key = cacheKey(cat, near, radius);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.places;

  // A user tap cancels the previous tap; background prefetches never cancel anything.
  let outer;
  if (background) {
    outer = new AbortController().signal;
  } else {
    if (controller) controller.abort();
    controller = new AbortController();
    outer = controller.signal;
  }
  const [lat, lng] = near;
  const sel = (k, vals) => `nwr["${k}"~"^(${vals.join('|')})$"](around:${radius},${lat},${lng});`;
  const body = ['amenity', 'shop', 'leisure'].filter((k) => cat[k]).map((k) => sel(k, cat[k])).join('');
  const q = `[out:json][timeout:8];(${body});out center 30;`;
  let lastErr;
  for (const url of ENDPOINTS) {
    if (outer.aborted) throw new DOMException('aborted', 'AbortError');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PER_REQUEST_MS);
    const onOuter = () => ctl.abort();
    outer.addEventListener('abort', onOuter, { once: true });
    try {
      const res = await fetch(url, { method: 'POST', body: `data=${encodeURIComponent(q)}`, signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      const places = (json.elements || [])
        .map((e) => {
          const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
          if (la == null) return null;
          const t = e.tags || {};
          const type = (t.amenity || t.shop || t.leisure || '').replace(/_/g, ' ');
          const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
          return { id: `osm-${e.type}-${e.id}`, name: t.name || t.brand || `${cat.label} (unnamed)`,
            sub: [type, street].filter(Boolean).join(' · '), lat: la, lng: lo, kind: type, source: 'osm',
            dist: haversine(near, [la, lo]) };
        })
        .filter(Boolean)
        .sort((a, b) => a.dist - b.dist);
      cache.set(key, { at: Date.now(), places });
      return places;
    } catch (e) {
      if (outer.aborted) throw new DOMException('aborted', 'AbortError'); // user moved on
      lastErr = e; // timeout or mirror error: try the next one
    } finally {
      clearTimeout(timer);
      outer.removeEventListener('abort', onOuter);
    }
  }
  throw lastErr || new Error('Nearby search failed');
}

// Warm the cache for the categories people tap most, so the first tap is instant.
export function prefetchNearby(near) {
  for (const cat of QUICK_FINDS.slice(0, 3)) findNearby(cat, near, 1000, { background: true }).catch(() => {});
}
