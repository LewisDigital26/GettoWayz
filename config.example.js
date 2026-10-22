// Copy this file to config.local.js (git-ignored) and fill in keys to enable live services.
// Leave a key empty to keep that feature in demo mode. Never commit real keys.
window.GW_CONFIG = {
  // Routing: OpenRouteService (https://openrouteservice.org) — free tier available. Enables live walking, cycling AND driving routes.
  ORS_API_KEY: "",
  // Optional: a self-hosted OSRM base URL with foot/bike/driving profiles, e.g. "https://osrm.example.com"
  OSRM_BASE_URL: "",
  // Map tiles: default is OpenStreetMap standard tiles (fair-use; set your own provider for a launched app).
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
  OVERPASS_URL: ""         // optional self-hosted Overpass endpoint
};
