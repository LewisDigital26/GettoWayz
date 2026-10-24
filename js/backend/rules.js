// Rate limits, alert categories and other shared constants.
// Point values, caps, trip rewards, levels and leaderboard periods live in ./pointsPolicy.js (one place).
import { RULES, LEVELS, levelInfo, TRIP } from './pointsPolicy.js';
export { RULES as POINT_RULE_MAP, LEVELS, levelInfo };
export const POINT_RULES = Object.entries(RULES).filter(([, r]) => !r.retired && r.points != null).map(([key, r]) => ({ key, label: r.label, points: r.points }));
export const POINTS = Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, r.points || 0]));
/** @deprecated use levelInfo(points, floor) */
export const levelFor = (points, floor) => levelInfo(points, floor);

export const RATE_LIMITS = {
  alertsPerDay: 5,
  pathSuggestionsPerDay: 3,
  confirmationsPerDay: 20,
  minMetresBetweenOwnAlerts: 25, // no duplicate pins on the same spot
};

// Alert categories with default expiry. Verified alerts get a review date instead of silent expiry.
export const ALERT_CATEGORIES = {
  blocked:  { label: 'Blocked path',   emoji: '🚧', desc: 'Obstruction, works, fencing', expiryDays: 7 },
  pothole:  { label: 'Pothole / surface', emoji: '🕳️', desc: 'Broken surface, debris, glass', expiryDays: 30 },
  lighting: { label: 'Poor lighting',  emoji: '💡', desc: 'Lamp out, dark stretch', expiryDays: 60 },
  closure:  { label: 'Temporary closure', emoji: '⛔', desc: 'Path or bridge closed', expiryDays: 14 },
  flooding: { label: 'Flooded / muddy', emoji: '🌊', desc: 'Standing water, impassable', expiryDays: 3 },
  bike_theft: { label: 'Bike theft spot', emoji: '🔓', desc: 'Bikes stolen or stripped here — lock up well', expiryDays: 14 },
  other:    { label: 'Other hazard',   emoji: '⚠️', desc: 'Anything else worth knowing', expiryDays: 14 },
  // Streetlight reports — attached to a lamp on the streetlight layer. Status is derived from these, never assumed.
  light_out: { label: 'Streetlight out', emoji: '🔦', desc: 'This lamp is not working', expiryDays: 30, lamp: true },
  light_ok:  { label: 'Streetlight working', emoji: '💡', desc: 'Seen working recently', expiryDays: 14, lamp: true },
  // Street lighting — "this street is lit / dark at night". Recolours the street on the lit-streets layer once
  // trusted (moderator verified or 2+ confirmations). Works on any street, tagged on OpenStreetMap or not.
  street_lit:  { label: 'Street is lit',  emoji: '🔆', desc: 'Lit at night along this stretch', expiryDays: 180, street: true },
  street_dark: { label: 'Street is dark', emoji: '🌑', desc: 'No working lights along this stretch', expiryDays: 180, street: true },
};

// Lit-streets layer rules
export const STREET_LIGHTING = {
  matchRadiusM: 15,          // a street report within this distance of a street is about that street
  routeRadiusM: 15,          // a route sample within this distance of a tagged street takes its lighting
  confirmationsToTrust: 2,   // community confirmations that make a report count (and earn points)
};

// Streetlight layer rules
export const STREETLIGHTS = {
  matchRadiusM: 12,        // a report within this distance of a lamp is about that lamp
  routeRadiusM: 30,        // a lamp within this distance of the route counts for that stretch
  sampleStepM: 25,         // route is sampled every N metres when scoring lighting
  minZoom: 15,             // lamps are only fetched/shown at this zoom or closer
  confirmedDays: 14,       // "recently confirmed working" means a light_ok report within N days
  preferLitMinConfirmedPct: 20, // the "prefer confirmed-lit" option is only offered when some route has at least this coverage
};

export const PATH_TYPES = {
  footpath: 'Footpath (walking only)',
  cycle: 'Cycle path',
  shared: 'Shared path (walk + cycle)',
  steps: 'Steps / stairs',
};
// Accessibility tags on a path suggestion (all optional). Shown on the path and used to filter routing.
export const ACCESS_TAGS = {
  stepFree:     { label: 'Step-free', emoji: '♿' },
  pushchair:    { label: 'Pushchair OK', emoji: '👶' },
  cargoBike:    { label: 'Cargo bike / trike fits', emoji: '🚲' },
  droppedKerbs: { label: 'Dropped kerbs at ends', emoji: '⬇️' },
  lit:          { label: 'Lit at night', emoji: '💡' },
  gated:        { label: 'Has a gate or barrier', emoji: '🚪' },
};
// A path nobody has confirmed using for this long is marked "not confirmed recently".
export const PATH_STALE_DAYS = 90;

// ---------- Safety ----------
// Arrival timer: "I should be there in N min". The friend is told if you haven't checked in by then.
// The share itself runs a bit longer so they can still see your last position after the deadline.
export const ARRIVAL_TIMERS = [
  { dueMinutes: 15, shareMinutes: 30, label: '15 min' },
  { dueMinutes: 30, shareMinutes: 60, label: '30 min' },
  { dueMinutes: 60, shareMinutes: 120, label: '1 hour' },
];
export const SOS_SHARE_MINUTES = 60;
export const EMERGENCY_NUMBER = '999';

export const SURFACES = { paved: 'Paved', gravel: 'Gravel', dirt: 'Dirt / grass', unknown: 'Not sure' };

export const CONFIRMATIONS_TO_AUTO_FLAG = 2; // alerts with 2+ confirmations get the "community confirmed" marker

// ---------- Trips, friends and sharing ----------
// Sharing a trip or location never earns points (see pointsPolicy.js). Trip points come from verified trips only.
export const TRIP_LIMITS = { arrivalRadiusM: TRIP.arrivalRadiusM, minTripMetres: TRIP.minEligibleM };

export const FRIEND_LIMITS = {
  idLookupsPerHour: 10,         // ID searches — reduces ID guessing
  requestsPerDay: 10,
  maxFriends: 50,
};

// Location-sharing durations offered to the user. There is no "until I stop" option by design.
export const SHARE_DURATIONS = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
];
export const SHARE_MAX_MINUTES = 240;         // hard ceiling, incl. trip shares
export const SHARE_STALE_SECONDS = 45;        // position older than this is shown as "last seen", not live
export const SHARE_LOST_SECONDS = 120;        // older than this = connection lost

// ---------- Community paths in routing ----------
// Approved community paths aren't in OpenStreetMap, so the routing engine can't see them. The app routes
// to the path entrance and from the path exit, then stitches the community path in between.
export const COMMUNITY_ROUTING = {
  maxCandidates: 2,     // paths tried per route request (each costs up to 2 routing calls)
  candidateSlack: 1.3,  // straight-line estimate via the path must be within 130% of the quickest route's distance
  maxJoinGapM: 40,      // path ends must be within this distance of a road/path the engine can reach
  skipLegUnderM: 15,    // if you're already this close to the path entrance/exit, no engine leg is needed
  maxSlowdown: 1.25,    // offer a community route if it's at most 25% slower than the quickest
  maxExtraRoutes: 1,
};
