// Runtime configuration. Values come from config.local.js (window.GW_CONFIG), which is git-ignored.
// Nothing here is a secret; missing keys simply switch that feature to demo mode.
const user = (typeof window !== 'undefined' && window.GW_CONFIG) || {};

export const config = {
  ORS_API_KEY: user.ORS_API_KEY || '',
  OSRM_BASE_URL: (user.OSRM_BASE_URL || '').replace(/\/$/, ''),
  TILE_URL: user.TILE_URL || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  TILE_ATTRIBUTION: user.TILE_ATTRIBUTION ||
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  NOMINATIM_EMAIL: user.NOMINATIM_EMAIL || '',
  BACKEND: (user.BACKEND === 'supabase' && user.SUPABASE_URL && user.SUPABASE_ANON_KEY) ? 'supabase' : 'local',
  SUPABASE_URL: user.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: user.SUPABASE_ANON_KEY || '',
  // Default view: Coventry city centre (also where the sample data lives)
  DEFAULT_CENTER: [52.4068, -1.5097],
  DEFAULT_ZOOM: 15,
};

export const integrations = {
  routing: config.ORS_API_KEY ? 'openrouteservice' : (config.OSRM_BASE_URL ? 'osrm' : 'sample'),
  geocoding: 'nominatim',
  tiles: user.TILE_URL ? 'custom' : 'carto',
  backend: config.BACKEND,
};
