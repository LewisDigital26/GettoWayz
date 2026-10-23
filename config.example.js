// Copy this file to config.local.js (git-ignored) and fill in keys to enable live services.
// Leave a key empty to keep that feature in demo mode. Never commit real keys.
window.GW_CONFIG = {
  // Routing: OpenRouteService (https://openrouteservice.org) — free tier available.
  ORS_API_KEY: "",
  // Optional: a self-hosted OSRM base URL with foot/bike profiles, e.g. "https://osrm.example.com"
  OSRM_BASE_URL: "",
  // Basemap: "vector" (default — OpenFreeMap, no key, brand-coloured) or "raster" (plain OSM tiles).
  BASEMAP: "vector",
  VECTOR_STYLE_URL: "",     // optional: another MapLibre style URL (e.g. MapTiler/your own) — default is OpenFreeMap Liberty
  // Raster fallback tiles: default is OpenStreetMap standard tiles (fair-use; set your own provider for a launched app).
  TILE_URL: "",
  TILE_ATTRIBUTION: "",
  // Geocoding: Nominatim public API is used by default (fair-use policy applies; put your contact email here).
  NOMINATIM_EMAIL: "",
  // Backend: "local" (demo, this device only) or "supabase" (see README → Go live with Supabase)
  BACKEND: "local",
  SUPABASE_URL: "",        // https://<project-id>.supabase.co
  SUPABASE_ANON_KEY: "",   // anon / publishable key — NOT service_role
  // Streetlights: "overpass" (OpenStreetMap lamp positions via public Overpass API, default) | "sample" (demo) | "none"
  STREETLIGHT_SOURCE: "overpass",
  OVERPASS_URL: "",        // optional self-hosted Overpass endpoint
  // Live traffic: TomTom Traffic API (https://developer.tomtom.com — free tier). Enables the "Live traffic" layer:
  // roads coloured by current speed plus incidents (crashes, closures, roadworks, floods). Empty = layer hidden.
  TOMTOM_API_KEY: ""
};
