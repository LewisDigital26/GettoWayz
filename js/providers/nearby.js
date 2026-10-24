// Quick finds on the home sheet — a subset of the Explore categories (see places.js).
// Kept as a thin wrapper so older imports keep working.
import { QUICK, searchPlaces, prefetchPlaces, DEFAULT_RADIUS_M } from './places.js';

export const QUICK_FINDS = QUICK;
export async function findNearby(cat, near, radius = DEFAULT_RADIUS_M, opts = {}) { return searchPlaces(cat, near, { radius, ...opts }); }
export const prefetchNearby = prefetchPlaces;
