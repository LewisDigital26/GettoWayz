// Places provider — "Explore nearby". Categories are OpenStreetMap tag sets, searched via Photon → Nominatim → Overpass.
// Place = { id, key, name, sub, lat, lng, kind, cat, source:'osm', dist, tags }
//   key  = "node/123" | "way/456" | "relation/789" — stable OSM ref used for community reviews
import { haversine } from '../util.js';
import { overpass } from './overpass.js';

export const DEFAULT_RADIUS_M = 1000;
export const MAX_RESULTS = 30;

// Each group has a marker shape so categories differ by more than colour: food = round, shops = square,
// services = diamond, out & about = leaf. The emoji carries the category itself.
export const GROUPS = {
  food:     { label: 'Food & drink', shape: 'round' },
  shops:    { label: 'Shops',        shape: 'square' },
  services: { label: 'Services',     shape: 'diamond' },
  outdoors: { label: 'Out & about',  shape: 'leaf' },
};

// `quick: true` marks the ones shown on the home sheet. Matching: any listed key → regex of values.
export const CATEGORIES = [
  { key: 'food',       group: 'food',     label: 'Food',        emoji: '🍽️', quick: true,  match: { amenity: ['restaurant'] } },
  { key: 'cafe',       group: 'food',     label: 'Cafés',       emoji: '☕',  quick: false, match: { amenity: ['cafe'] } },
  { key: 'fastfood',   group: 'food',     label: 'Takeaways',   emoji: '🍔',  quick: false, match: { amenity: ['fast_food'] } },
  { key: 'pub',        group: 'food',     label: 'Pubs & bars', emoji: '🍺',  quick: false, match: { amenity: ['pub', 'bar'] } },
  { key: 'bakery',     group: 'food',     label: 'Bakeries',    emoji: '🥐',  quick: false, match: { shop: ['bakery'] } },
  { key: 'icecream',   group: 'food',     label: 'Ice cream',   emoji: '🍦',  quick: false, match: { amenity: ['ice_cream'], shop: ['ice_cream'] } },

  { key: 'supermarket',group: 'shops',    label: 'Supermarkets',emoji: '🛒',  quick: true,  match: { shop: ['supermarket'] } },
  { key: 'shops',      group: 'shops',    label: 'Corner shops',emoji: '🏪',  quick: false, match: { shop: ['convenience', 'newsagent', 'kiosk'] } },
  { key: 'chemist',    group: 'shops',    label: 'Chemists',    emoji: '💊',  quick: true,  match: { amenity: ['pharmacy'], shop: ['chemist'] } },
  { key: 'clothes',    group: 'shops',    label: 'Clothes',     emoji: '👕',  quick: false, match: { shop: ['clothes', 'shoes', 'fashion'] } },
  { key: 'bikeshop',   group: 'shops',    label: 'Bike shops',  emoji: '🚲',  quick: false, match: { shop: ['bicycle'] } },
  { key: 'barber',     group: 'shops',    label: 'Barbers & hair', emoji: '💈', quick: false, match: { shop: ['hairdresser', 'barber', 'beauty'] } },

  { key: 'cash',       group: 'services', label: 'Cash',        emoji: '💷',  quick: true,  match: { amenity: ['atm', 'bank'] } },
  { key: 'petrol',     group: 'services', label: 'Petrol',      emoji: '⛽',  quick: true,  match: { amenity: ['fuel'] } },
  { key: 'charging',   group: 'services', label: 'EV charging', emoji: '🔌',  quick: false, match: { amenity: ['charging_station'] } },
  { key: 'toilets',    group: 'services', label: 'Toilets',     emoji: '🚻',  quick: true,  match: { amenity: ['toilets'] } },
  { key: 'post',       group: 'services', label: 'Post',        emoji: '📮',  quick: false, match: { amenity: ['post_office', 'post_box'] } },
  { key: 'station',    group: 'services', label: 'Stations',    emoji: '🚉',  quick: false, match: { railway: ['station', 'halt'], amenity: ['bus_station'] } },
  { key: 'hotel',      group: 'services', label: 'Hotels',      emoji: '🏨',  quick: false, match: { tourism: ['hotel', 'hostel', 'guest_house'] } },

  { key: 'parks',      group: 'outdoors', label: 'Parks',       emoji: '🌳',  quick: true,  match: { leisure: ['park', 'garden', 'nature_reserve'] } },
  { key: 'playground', group: 'outdoors', label: 'Playgrounds', emoji: '🛝',  quick: false, match: { leisure: ['playground'] } },
  { key: 'gym',        group: 'outdoors', label: 'Gyms & sport',emoji: '🏋️', quick: false, match: { leisure: ['fitness_centre', 'sports_centre', 'swimming_pool', 'pitch'] } },
  { key: 'library',    group: 'outdoors', label: 'Libraries',   emoji: '📚',  quick: false, match: { amenity: ['library'] } },
  { key: 'cinema',     group: 'outdoors', label: 'Cinemas',     emoji: '🎬',  quick: false, match: { amenity: ['cinema', 'theatre'] } },
];
export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
export const QUICK = CATEGORIES.filter((c) => c.quick);

const TAG_KEYS = ['amenity', 'shop', 'leisure', 'tourism', 'railway'];

/** Which category an element's tags fall under (first match wins). */
export function categoryOf(tags = {}) {
  for (const c of CATEGORIES) for (const [k, vals] of Object.entries(c.match)) if (tags[k] && vals.includes(tags[k])) return c;
  return null;
}

export function toPlace(e, near, cat = null) {
  const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
  if (la == null) return null;
  const t = e.tags || {};
  const c = cat || categoryOf(t);
  const type = (TAG_KEYS.map((k) => t[k]).find(Boolean) || c?.label || 'place').replace(/_/g, ' ');
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const key = `${e.type}/${e.id}`;
  return {
    id: `osm-${e.type}-${e.id}`, key, name: t.name || t.brand || (c ? `${c.label} (unnamed)` : 'Unnamed place'),
    sub: [type, street].filter(Boolean).join(' · '), lat: la, lng: lo, kind: type, cat: c?.key || null, source: 'osm',
    dist: near ? haversine(near, [la, lo]) : null, tags: t,
  };
}

const selector = (match, around) => Object.entries(match).map(([k, vals]) => `nwr["${k}"~"^(${vals.join('|')})$"]${around};`).join('');

// ---------- search backends ----------
// 1. Photon (komoot) reverse search filtered by OSM tag: ~50 ms, named places only.
// 2. Nominatim bounded search per tag ("[fuel]"): ~0.5 s, picks up some unnamed places Photon skips.
// 3. Overpass: one short attempt as a last resort (the public Overpass servers are often down or overloaded).
const OSM_TYPE = { N: 'node', W: 'way', R: 'relation', node: 'node', way: 'way', relation: 'relation' };
const CACHE_TTL_MS = 10 * 60 * 1000;
const placeCache = new Map();   // key -> { at, value }

function withTimeout(ms, outer) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  outer?.addEventListener('abort', () => ctl.abort(), { once: true });
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}
async function getJSON(url, ms, outer) {
  const t = withTimeout(ms, outer);
  try {
    const res = await fetch(url, { signal: t.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return await res.json();
  } finally { t.done(); }
}
const tagPairs = (match) => Object.entries(match).flatMap(([k, vals]) => vals.map((v) => [k, v]));

async function viaPhoton(cat, [lat, lng], radius, outer) {
  const p = new URLSearchParams({ lat, lon: lng, limit: '50', radius: String(Math.max(0.2, radius / 1000)), lang: 'en' });
  for (const [k, v] of tagPairs(cat.match)) p.append('osm_tag', `${k}:${v}`);
  const j = await getJSON(`https://photon.komoot.io/reverse?${p}`, 5000, outer);
  return (j.features || []).map((f) => {
    const pr = f.properties || {};
    const type = OSM_TYPE[pr.osm_type];
    if (!type || !f.geometry?.coordinates) return null;
    const tags = { [pr.osm_key]: pr.osm_value };
    if (pr.name) tags.name = pr.name;
    if (pr.housenumber) tags['addr:housenumber'] = pr.housenumber;
    if (pr.street) tags['addr:street'] = pr.street;
    if (pr.city) tags['addr:city'] = pr.city;
    if (pr.postcode) tags['addr:postcode'] = pr.postcode;
    return { type, id: pr.osm_id, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], tags };
  }).filter(Boolean);
}

function fromNominatim(r) {
  const type = OSM_TYPE[r.osm_type];
  if (!type) return null;
  const a = r.address || {};
  const tags = { ...(r.extratags || {}), [r.category]: r.type };
  if (r.name) tags.name = r.name;
  if (a.house_number) tags['addr:housenumber'] = a.house_number;
  if (a.road) tags['addr:street'] = a.road;
  if (a.city || a.town || a.village) tags['addr:city'] = a.city || a.town || a.village;
  if (a.postcode) tags['addr:postcode'] = a.postcode;
  return { type, id: r.osm_id, lat: +r.lat, lon: +r.lon, tags };
}

async function viaNominatim(cat, [lat, lng], radius, outer) {
  const dLat = radius / 111000, dLng = radius / (111000 * Math.cos(lat * Math.PI / 180));
  const viewbox = `${lng - dLng},${lat + dLat},${lng + dLng},${lat - dLat}`;
  const pairs = tagPairs(cat.match).slice(0, 4);   // keep it polite: at most 4 requests
  const lists = await Promise.all(pairs.map(([, v]) => {
    const p = new URLSearchParams({ q: `[${v}]`, format: 'jsonv2', limit: '40', bounded: '1', viewbox, addressdetails: '1' });
    return getJSON(`https://nominatim.openstreetmap.org/search?${p}`, 6000, outer).catch(() => []);
  }));
  const allowed = new Set(pairs.map(([k, v]) => `${k}=${v}`));
  return lists.flat().filter((r) => allowed.has(`${r.category}=${r.type}`)).map(fromNominatim).filter(Boolean);
}

async function viaOverpass(cat, [lat, lng], radius, background) {
  return overpass(`(${selector(cat.match, `(around:${radius},${lat},${lng})`)});out center ${MAX_RESULTS} tags;`, { background, timeoutS: 5, maxTries: 1 });
}

let userCtl = null;   // a new tap cancels the previous tap's search

/** Places of one category around [lat,lng]. Sorted by distance. */
export async function searchPlaces(cat, near, { radius = DEFAULT_RADIUS_M, background = false } = {}) {
  const [lat, lng] = near;
  const key = `places:${cat.key}:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}`;
  const hit = placeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let outer = null;
  if (!background) { userCtl?.abort(); userCtl = new AbortController(); outer = userCtl.signal; }
  const aborted = () => { if (outer?.aborted) throw new DOMException('aborted', 'AbortError'); };

  let elements = [];
  try { elements = await viaPhoton(cat, near, radius, outer); } catch (e) { aborted(); }
  aborted();
  if (elements.length < 3) {
    try {
      const more = await viaNominatim(cat, near, radius, outer);
      const seen = new Set(elements.map((e) => `${e.type}/${e.id}`));
      elements = elements.concat(more.filter((e) => !seen.has(`${e.type}/${e.id}`)));
    } catch (e) { aborted(); }
  }
  aborted();
  if (!elements.length) {
    try { elements = await viaOverpass(cat, near, radius, background); } catch (e) { aborted(); }
  }
  const places = elements.map((e) => toPlace(e, near, cat)).filter((p) => p && p.dist <= radius * 1.25)
    .sort((a, b) => a.dist - b.dist).slice(0, MAX_RESULTS);
  placeCache.set(key, { at: Date.now(), value: places });
  return places;
}

/** Warm the cache for the quick-pick categories so the first tap is instant (Photon is cheap). */
export function prefetchPlaces(near) {
  for (const cat of QUICK.slice(0, 3)) searchPlaces(cat, near, { background: true }).catch(() => {});
}

/** Full OSM tags (hours, phone, website…) for one place via Nominatim lookup. */
const detailCache = new Map();
async function lookupTags(key) {
  if (detailCache.has(key)) return detailCache.get(key);
  const [type, id] = key.split('/');
  const p = new URLSearchParams({ osm_ids: `${type[0].toUpperCase()}${id}`, format: 'jsonv2', extratags: '1', addressdetails: '1' });
  const j = await getJSON(`https://nominatim.openstreetmap.org/lookup?${p}`, 5000);
  const el = j[0] ? fromNominatim(j[0]) : null;
  detailCache.set(key, el);
  return el;
}

/** Add the extra tags to a place found by Photon. Never throws; returns the same place if lookup fails. */
export async function enrichPlace(place) {
  if (!place?.key || place.enriched) return place;
  try {
    const el = await lookupTags(place.key);
    if (el) place.tags = { ...place.tags, ...el.tags };
  } catch { /* keep what we have */ }
  place.enriched = true;
  return place;
}

/** Fetch one place by its OSM key ("node/123") — used to re-open a reviewed place from a review list. */
export async function fetchPlace(key, near = null) {
  const [type, id] = key.split('/');
  if (!['node', 'way', 'relation'].includes(type) || !/^\d+$/.test(id)) return null;
  try {
    const el = await lookupTags(key);
    if (el) { const p = toPlace(el, near); p.enriched = true; return p; }
  } catch { /* fall through to Overpass */ }
  const elements = await overpass(`${type}(${id});out center tags;`, { key: `place:${key}`, background: true, timeoutS: 5 });
  return elements[0] ? toPlace(elements[0], near) : null;
}

// ---------- details helpers ----------
const CUISINE = (s) => s.split(';').map((x) => x.trim().replace(/_/g, ' ')).filter(Boolean).join(', ');

/** Plain-language facts pulled from OSM tags for the place sheet. Only what the tags actually say. */
export function placeFacts(tags = {}) {
  const f = [];
  if (tags.cuisine) f.push({ ico: '🍴', label: 'Cuisine', value: CUISINE(tags.cuisine) });
  if (tags.opening_hours) f.push({ ico: '🕒', label: 'Hours', value: tags.opening_hours.replace(/;\s*/g, ' · ') });
  const addr = [[tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '), tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(', ');
  if (addr) f.push({ ico: '📍', label: 'Address', value: addr });
  const phone = tags.phone || tags['contact:phone'];
  if (phone) f.push({ ico: '📞', label: 'Phone', value: phone, href: `tel:${phone.replace(/\s+/g, '')}` });
  const web = tags.website || tags['contact:website'] || tags.url;
  if (web) f.push({ ico: '🌐', label: 'Website', value: web.replace(/^https?:\/\//, '').replace(/\/$/, ''), href: /^https?:/.test(web) ? web : `https://${web}` });
  if (tags.wheelchair) f.push({ ico: '♿', label: 'Step-free', value: { yes: 'Yes', limited: 'Partly', no: 'No' }[tags.wheelchair] || tags.wheelchair });
  if (tags.outdoor_seating === 'yes') f.push({ ico: '🪑', label: 'Outdoor seating', value: 'Yes' });
  if (tags.takeaway === 'yes' || tags.takeaway === 'only') f.push({ ico: '🥡', label: 'Takeaway', value: tags.takeaway === 'only' ? 'Takeaway only' : 'Yes' });
  if (tags.operator && !tags.name) f.push({ ico: '🏢', label: 'Operator', value: tags.operator });
  if (tags.fee) f.push({ ico: '💳', label: 'Fee', value: tags.fee === 'no' ? 'Free' : tags.fee === 'yes' ? 'Yes' : tags.fee });
  return f;
}
