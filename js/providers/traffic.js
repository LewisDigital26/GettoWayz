// Live car-traffic provider — TomTom Traffic API (free tier: ~2,500 incident requests + 50,000 tiles per day).
// Two things come from here:
//   1. flowTileUrl()      — a raster tile overlay colouring roads by how fast traffic is moving right now
//   2. fetchIncidents()   — crashes, closures, roadworks, floods etc. inside a bounding box, as GeoJSON-ish objects
// Both are read straight from the browser with the key in config. That is fine for a test app on a
// handful of phones; before a public launch move the incidents call behind a Supabase Edge Function.
import { config } from '../config.js';

export const TRAFFIC_CATEGORIES = {
  0: { emoji: '⚠️', label: 'Incident' },
  1: { emoji: '💥', label: 'Accident' },
  2: { emoji: '🌫️', label: 'Fog' },
  3: { emoji: '⚠️', label: 'Dangerous conditions' },
  4: { emoji: '🌧️', label: 'Heavy rain' },
  5: { emoji: '🧊', label: 'Ice' },
  6: { emoji: '🚗', label: 'Traffic jam' },
  7: { emoji: '🚧', label: 'Lane closed' },
  8: { emoji: '⛔', label: 'Road closed' },
  9: { emoji: '🚧', label: 'Roadworks' },
  10: { emoji: '💨', label: 'Strong wind' },
  11: { emoji: '🌊', label: 'Flooding' },
  14: { emoji: '🚙', label: 'Broken-down vehicle' },
};
export const DELAY_LABELS = ['Unknown delay', 'Minor delay', 'Moderate delay', 'Major delay', 'Road closed'];

const FIELDS = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}';

export class TomTomTraffic {
  constructor(key) {
    this.name = 'tomtom';
    this.key = key;
    this.cache = new Map();            // bbox string -> { at, incidents }
    this.ttl = 60000;                  // re-fetch the same view at most once a minute (keeps the free tier happy)
  }
  /** Roads tinted by live speed vs. free-flow. Leaflet tile template. */
  flowTileUrl() { return `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(this.key)}`; }

  /** @param bounds Leaflet LatLngBounds. Returns [{ id, category, lat, lng, geometry:[[lat,lng]], delay, delayLevel, description, from, to, roads, start, end }] */
  async fetchIncidents(bounds) {
    // Accepts a Leaflet LatLngBounds or a plain { south, west, north, east } (what GwMap.bounds() returns).
    const b = typeof bounds.getWest === 'function' ? { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() } : bounds;
    const bbox = [b.west, b.south, b.east, b.north].map((n) => Number(n).toFixed(4)).join(',');
    const hit = this.cache.get(bbox);
    if (hit && Date.now() - hit.at < this.ttl) return hit.incidents;
    const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(this.key)}&bbox=${bbox}&fields=${encodeURIComponent(FIELDS)}&language=en-GB&timeValidityFilter=present`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status === 403 ? 'Traffic key rejected — check TOMTOM_API_KEY' : `Traffic service error (${res.status})`);
    const data = await res.json();
    const incidents = (data.incidents || []).map(normalise).filter(Boolean);
    this.cache.set(bbox, { at: Date.now(), incidents });
    if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
    return incidents;
  }
}

function normalise(f) {
  const p = f.properties || {};
  const g = f.geometry || {};
  const coords = g.type === 'Point' ? [g.coordinates] : (g.coordinates || []);
  if (!coords.length) return null;
  const geometry = coords.map(([lng, lat]) => [lat, lng]);
  const mid = geometry[Math.floor(geometry.length / 2)];
  return {
    id: p.id || `${p.iconCategory}:${mid.join(',')}`,
    category: p.iconCategory ?? 0,
    lat: mid[0], lng: mid[1],
    geometry,
    delay: p.delay || 0,                                   // seconds
    delayLevel: p.magnitudeOfDelay ?? 0,                   // 0–4
    description: (p.events || []).map((e) => e.description).filter(Boolean).join(' · '),
    from: p.from || '', to: p.to || '',
    roads: p.roadNumbers || [],
    length: p.length || 0,
    start: p.startTime ? new Date(p.startTime) : null,
    end: p.endTime ? new Date(p.endTime) : null,
  };
}

export function createTraffic() {
  return config.TOMTOM_API_KEY ? new TomTomTraffic(config.TOMTOM_API_KEY) : null;
}
