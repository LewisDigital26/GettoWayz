// Routing provider abstraction.
//
// Every provider implements:  route({ from:[lat,lng], to:[lat,lng], mode }) -> Promise<RouteResult>
//   RouteResult = { provider: string, routes: Route[] }
//   Route = { id, label, basis, source: 'live'|'sample'|'estimate', geometry: [[lat,lng]...],
//             distanceM, durationS, steps: [{ text, dist }], communityPathIds?: string[] }
//
// `source` and `basis` are shown to the user so sample/estimated routes are never presented as live.

import { config, integrations } from '../config.js';
import { haversine, lineLength, uid, MODES } from '../util.js';
import { SAMPLE_PLACES, SAMPLE_ROUTES } from './sampleData.js';

const ORS_PROFILES = { walk: 'foot-walking', bike: 'cycling-regular', scooter: 'cycling-regular', drive: 'driving-car' };
const OSRM_PROFILES = { walk: 'foot', bike: 'bike', scooter: 'bike', drive: 'driving' };
// Drive profiles follow each engine's car access rules (no footways, cycleways, pedestrian zones or private roads).
// Neither engine provides live traffic or real-time closures, so durations are free-flow estimates.

function scooterNote(mode) {
  return mode === 'scooter'
    ? ' Scooter mode uses the cycling road network with scooter speed estimates — check local rules on where scooters are allowed.'
    : '';
}

/** OpenRouteService — live routing when ORS_API_KEY is configured. */
export class OpenRouteServiceProvider {
  constructor(key) { this.key = key; this.name = 'openrouteservice'; }
  async route({ from, to, mode }) {
    const profile = ORS_PROFILES[mode];
    const res = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.key },
      body: JSON.stringify({
        coordinates: [[from[1], from[0]], [to[1], to[0]]],
        instructions: true,
        alternative_routes: { target_count: 3, weight_factor: 1.6, share_factor: 0.6 },
      }),
    });
    if (!res.ok) throw new Error(`Routing failed (${res.status})`);
    const json = await res.json();
    const routes = (json.features || []).map((f, i) => {
      const geometry = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const seg = f.properties.segments?.[0];
      const distanceM = f.properties.summary.distance;
      const durationS = mode === 'scooter' ? distanceM / MODES.scooter.speed : f.properties.summary.duration;
      return {
        id: uid(), label: i === 0 ? 'Quickest' : 'Alternative',
        basis: (mode === 'drive' ? 'Live driving route from OpenRouteService on roads open to cars (OpenStreetMap access rules). Travel time is a free-flow estimate — no live traffic.' : 'Live route from OpenRouteService over OpenStreetMap public ways.') + scooterNote(mode),
        traffic: false,
        source: 'live', geometry, distanceM, durationS,
        steps: (seg?.steps || []).map((s) => ({ text: s.instruction, dist: s.distance })),
      };
    });
    return { provider: this.name, routes };
  }
  /** One plain leg (no alternatives) — used to join community paths onto the road network. */
  async leg(from, to, mode) {
    const res = await fetch(`https://api.openrouteservice.org/v2/directions/${ORS_PROFILES[mode]}/geojson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.key },
      body: JSON.stringify({ coordinates: [[from[1], from[0]], [to[1], to[0]]], instructions: true }),
    });
    if (!res.ok) throw new Error(`Routing failed (${res.status})`);
    const f = (await res.json()).features?.[0];
    if (!f) throw new Error('No route');
    const distanceM = f.properties.summary.distance;
    return {
      geometry: f.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distanceM,
      durationS: mode === 'scooter' ? distanceM / MODES.scooter.speed : f.properties.summary.duration,
      steps: (f.properties.segments?.[0]?.steps || []).map((s) => ({ text: s.instruction, dist: s.distance })),
    };
  }
}

/** OSRM — live routing against a self-hosted server with foot/bike profiles. */
export class OsrmProvider {
  constructor(base) { this.base = base; this.name = 'osrm'; }
  async route({ from, to, mode }) {
    const profile = OSRM_PROFILES[mode];
    const url = `${this.base}/route/v1/${profile}/${from[1]},${from[0]};${to[1]},${to[0]}?alternatives=true&overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Routing failed (${res.status})`);
    const json = await res.json();
    if (json.code !== 'Ok') throw new Error(json.message || 'No route found');
    const routes = json.routes.map((r, i) => ({
      id: uid(), label: i === 0 ? 'Quickest' : 'Alternative',
      basis: (mode === 'drive' ? 'Live driving route from OSRM on roads open to cars. Travel time is a free-flow estimate — no live traffic.' : 'Live route from OSRM over OpenStreetMap public ways.') + scooterNote(mode),
      traffic: false,
      source: 'live',
      geometry: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distanceM: r.distance,
      durationS: mode === 'scooter' ? r.distance / MODES.scooter.speed : r.duration,
      steps: (r.legs?.[0]?.steps || []).map((s) => ({ text: `${s.maneuver?.type || 'Continue'} ${s.name ? 'onto ' + s.name : ''}`.trim(), dist: s.distance })),
    }));
    return { provider: this.name, routes };
  }
  async leg(from, to, mode) {
    const url = `${this.base}/route/v1/${OSRM_PROFILES[mode]}/${from[1]},${from[0]};${to[1]},${to[0]}?alternatives=false&overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Routing failed (${res.status})`);
    const json = await res.json();
    const r = json.routes?.[0];
    if (json.code !== 'Ok' || !r) throw new Error('No route');
    return {
      geometry: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distanceM: r.distance,
      durationS: mode === 'scooter' ? r.distance / MODES.scooter.speed : r.duration,
      steps: (r.legs?.[0]?.steps || []).map((s) => ({ text: `${s.maneuver?.type || 'Continue'} ${s.name ? 'onto ' + s.name : ''}`.trim(), dist: s.distance })),
    };
  }
}

/** Sample provider — used when no routing credentials are configured. */
export class SampleRoutingProvider {
  constructor() { this.name = 'sample'; }
  nearestPlace(pt) {
    let best = null, bestD = 150; // within 150 m of a sample place
    for (const p of SAMPLE_PLACES) {
      const d = haversine(pt, [p.lat, p.lng]);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }
  async route({ from, to, mode }) {
    await new Promise((r) => setTimeout(r, 350)); // simulate network
    if (mode === 'drive') {
      // Sample data only covers walking/cycling paths. Never fabricate a car route.
      return { provider: this.name, routes: [], unsupported: 'Driving routes need a configured routing provider (OpenRouteService key or OSRM URL in config.local.js). The built-in sample data only covers walking and cycling, and a straight-line estimate would be misleading for cars.' };
    }
    const a = this.nearestPlace(from), b = this.nearestPlace(to);
    const speed = MODES[mode].speed;
    let pair = null, reversed = false;
    if (a && b) {
      pair = SAMPLE_ROUTES.find((r) => r.from === a.id && r.to === b.id);
      if (!pair) { pair = SAMPLE_ROUTES.find((r) => r.from === b.id && r.to === a.id); reversed = !!pair; }
    }
    if (pair) {
      const routes = pair.routes.map((r) => {
        const geometry = reversed ? [...r.geometry].reverse() : r.geometry;
        const steps = reversed ? [...r.steps].reverse() : r.steps;
        const distanceM = lineLength(geometry);
        return {
          id: uid(), label: r.label, basis: r.basis + scooterNote(mode), source: 'sample',
          geometry, distanceM, durationS: distanceM / speed, steps, communityPathIds: r.usesCommunityPaths || [],
        };
      });
      return { provider: this.name, routes };
    }
    // Fallback: straight-line estimate, clearly labelled. Not a path — just distance/time guidance.
    const distanceM = haversine(from, to) * 1.3;
    return {
      provider: this.name,
      routes: [{
        id: uid(), label: 'Rough estimate', source: 'estimate',
        basis: 'No routing provider is configured, so this is a straight-line estimate (+30%) — not a real path. Add an OpenRouteService key in config.local.js to get live routes.' + scooterNote(mode),
        geometry: [from, to], distanceM, durationS: distanceM / speed,
        steps: [{ text: 'Head toward your destination using public streets and paths', dist: distanceM }],
      }],
    };
  }
}

export function createRoutingProvider() {
  if (integrations.routing === 'openrouteservice') return new OpenRouteServiceProvider(config.ORS_API_KEY);
  if (integrations.routing === 'osrm') return new OsrmProvider(config.OSRM_BASE_URL);
  return new SampleRoutingProvider();
}
