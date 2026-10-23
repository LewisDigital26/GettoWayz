// Runtime configuration. Values come from config.local.js (window.GW_CONFIG), which is git-ignored.
// Nothing here is a secret; missing keys simply switch that feature to demo mode.
const user = (typeof window !== 'undefined' && window.GW_CONFIG) || {};

export const config = {
  ORS_API_KEY: user.ORS_API_KEY || '',
  OSRM_BASE_URL: (user.OSRM_BASE_URL || '').replace(/\/$/, ''),
  // Basemap: 'vector' (default — OpenFreeMap vector tiles via MapLibre, no key, recoloured to the brand palette)
  // or 'raster' (plain OSM tiles darkened with a CSS filter). Vector falls back to raster automatically without WebGL.
  BASEMAP: user.BASEMAP === 'raster' ? 'raster' : 'vector',
  VECTOR_STYLE_URL: user.VECTOR_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty',
  VECTOR_ATTRIBUTION: user.VECTOR_ATTRIBUTION || '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  // Raster fallback: OpenStreetMap standard tiles (no key; fair-use policy - set TILE_URL for a provider of your own at scale).
  TILE_URL: user.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILE_ATTRIBUTION: user.TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  NOMINATIM_EMAIL: user.NOMINATIM_EMAIL || '',
  BACKEND: (user.BACKEND === 'supabase' && user.SUPABASE_URL && user.SUPABASE_ANON_KEY) ? 'supabase' : 'local',
  SUPABASE_URL: user.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: user.SUPABASE_ANON_KEY || '',
  // Streetlights: 'overpass' (OpenStreetMap lamp positions, live, no key) | 'sample' (demo) | 'none'
  STREETLIGHT_SOURCE: user.STREETLIGHT_SOURCE || 'overpass',
  OVERPASS_URL: user.OVERPASS_URL || '',
  // Live car traffic (flow tiles + incidents): TomTom Traffic API key, free tier. Empty = traffic layer hidden.
  TOMTOM_API_KEY: user.TOMTOM_API_KEY || '',
  // Default view: Coventry city centre (also where the sample data lives)
  DEFAULT_CENTER: [52.4068, -1.5097],
  DEFAULT_ZOOM: 15,
};

export const integrations = {
  routing: config.ORS_API_KEY ? 'openrouteservice' : (config.OSRM_BASE_URL ? 'osrm' : 'sample'),
  geocoding: 'nominatim',
  tiles: config.BASEMAP === 'vector' ? 'openfreemap' : (user.TILE_URL ? 'custom' : 'osm'),
  backend: config.BACKEND,
  streetlights: config.STREETLIGHT_SOURCE,
  traffic: config.TOMTOM_API_KEY ? 'tomtom' : 'none',
};
