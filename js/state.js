// Tiny app store — one object, subscribers re-render on change.
const listeners = new Set();

export const state = {
  mode: 'walk',                 // walk | bike | scooter
  user: null,                   // current user (public shape) or null = guest
  origin: null,                 // { lat, lng, name, source: 'gps'|'map'|'place' }
  destination: null,            // Place
  routes: [],                   // Route[] from provider
  routeProvider: 'sample',
  selectedRouteId: null,
  routing: false,
  routeError: null,
  navigating: false,
  position: null,               // { lat, lng, accuracy, heading } — never persisted
  locationStatus: 'idle',       // idle | asking | ok | denied | unavailable
  alerts: [],
  paths: [],
  layers: { alerts: true, paths: true, pending: false, traffic: false },
  draw: null,                   // { points: [[lat,lng]] } while suggesting a path
  online: navigator.onLine,
};

export function set(patch) {
  Object.assign(state, patch);
  for (const cb of listeners) cb(state, patch);
}
export function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export const selectedRoute = () => state.routes.find((r) => r.id === state.selectedRouteId) || null;
