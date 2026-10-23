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

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let controller = null;

export async function findNearby(cat, near, radius = 1500) {
  if (controller) controller.abort();
  controller = new AbortController();
  const [lat, lng] = near;
  const sel = (k, vals) => `nwr["${k}"~"^(${vals.join('|')})$"](around:${radius},${lat},${lng});`;
  const body = ['amenity', 'shop', 'leisure'].filter((k) => cat[k]).map((k) => sel(k, cat[k])).join('');
  const q = `[out:json][timeout:15];(${body});out center 40;`;
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body: `data=${encodeURIComponent(q)}`, signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      return (json.elements || [])
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
    } catch (e) { if (e.name === 'AbortError') throw e; lastErr = e; }
  }
  throw lastErr || new Error('Nearby search failed');
}
