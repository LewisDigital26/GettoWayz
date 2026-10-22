// Runtime configuration. Values come from config.local.js (window.GW_CONFIG), which is git-ignored.
// Nothing here is a secret; missing keys simply switch that feature to demo mode.
const user = (typeof window !== 'undefined' && window.GW_CONFIG) || {};

export const config = {
  ORS_API_KEY: user.ORS_API_KEY || '',
  OSRM_BASE_URL: (user.OSRM_BASE_URL || '').replace(/\/$/, ''),
  // Default basemap: OpenStreetMap standard tiles (no key; fair-use policy - set TILE_URL for a provider of your own at scale).
  // Dark colourways darken these tiles with a CSS filter.
  TILE_URL: user.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILE_ATTRIBUTION: user.TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  NOMINATIM_EMAIL: user.NOMINATIM_EMAIL || '',
  BACKEND: (user.BACKEND === 'supabase' && user.SUPABASE_URL && user.SUPABASE_ANON_KEY) ? 'supabase' : 'local',
  SUPABASE_URL: user.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: user.SUPABASE_ANON_KEY || '',
  // Streetlights: 'overpass' (OpenStreetMap lamp positions, live, no key) | 'sample' (demo) | 'none'
  STREETLIGHT_SOURCE: user.STREETLIGHT_SOURCE || 'overpass',
  OVERPASS_URL: user.OVERPASS_URL || '',
  // Default view: Coventry city centre (also where the sample data lives)
  DEFAULT_CENTER: [52.4068, -1.5097],
  DEFAULT_ZOOM: 15,
};

export const integrations = {
  routing: config.ORS_API_KEY ? 'openrouteservice' : (config.OSRM_BASE_URL ? 'osrm' : 'sample'),
  geocoding: 'nominatim',
  tiles: user.TILE_URL ? 'custom' : 'osm',
  backend: config.BACKEND,
  streetlights: config.STREETLIGHT_SOURCE,
};
