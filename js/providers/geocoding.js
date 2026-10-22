// Geocoding provider abstraction.
// search(query, { near:[lat,lng] }) -> Promise<Place[]>   Place = { id, name, sub, lat, lng, kind, source }
// Default: Nominatim (OpenStreetMap) public API — fair-use, no key, results are live but not verified by us.
// Sample places are always merged in first so the demo works offline / when the API is rate-limited.

import { config } from '../config.js';
import { haversine } from '../util.js';
import { SAMPLE_PLACES } from './sampleData.js';

export class NominatimGeocoder {
  constructor() { this.name = 'nominatim'; this.controller = null; }
  async search(query, { near } = {}) {
    if (this.controller) this.controller.abort();
    this.controller = new AbortController();
    const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '6', addressdetails: '1' });
    if (config.NOMINATIM_EMAIL) params.set('email', config.NOMINATIM_EMAIL);
    if (near) {
      const d = 0.25;
      params.set('viewbox', `${near[1] - d},${near[0] + d},${near[1] + d},${near[0] - d}`);
    }
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      signal: this.controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const json = await res.json();
    return json.map((r) => ({
      id: `osm-${r.osm_type}-${r.osm_id}`,
      name: r.name || r.display_name.split(',')[0],
      sub: r.display_name.split(',').slice(1, 4).join(',').trim(),
      lat: +r.lat, lng: +r.lon, kind: r.type || 'place', source: 'osm',
    }));
  }
}

export function searchSamplePlaces(query, near) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SAMPLE_PLACES
    .filter((p) => p.name.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q))
    .map((p) => ({ ...p, source: 'sample', dist: near ? haversine(near, [p.lat, p.lng]) : 0 }))
    .sort((a, b) => a.dist - b.dist);
}

export async function reverseGeocode(lat, lng) {
  try {
    const params = new URLSearchParams({ lat, lon: lng, format: 'jsonv2' });
    if (config.NOMINATIM_EMAIL) params.set('email', config.NOMINATIM_EMAIL);
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`);
    if (!res.ok) return null;
    const j = await res.json();
    return j.name || j.display_name?.split(',').slice(0, 2).join(',') || null;
  } catch { return null; }
}

export function createGeocoder() { return new NominatimGeocoder(); }
