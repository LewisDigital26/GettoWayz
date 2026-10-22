// Points, levels, rate limits and alert categories — shown to users verbatim in the "Points rules" screen.
// Points are only ever granted when a moderator approves/verifies a contribution (never on submission).

export const POINT_RULES = [
  { key: 'path_approved', label: 'Missing path approved by a moderator', points: 50 },
  { key: 'alert_verified', label: 'Alert verified by a moderator', points: 10 },
  { key: 'alert_confirmed', label: 'Your alert confirmed by 2+ other users', points: 5 },
  { key: 'confirm_helpful', label: 'You confirmed an alert that was later verified', points: 2 },
];
export const POINTS = Object.fromEntries(POINT_RULES.map((r) => [r.key, r.points]));

export const LEVELS = [
  { name: 'Newcomer', min: 0 },
  { name: 'Scout', min: 50 },
  { name: 'Pathfinder', min: 150 },
  { name: 'Wayfinder', min: 400 },
  { name: 'Legend', min: 1000 },
];
export function levelFor(points) {
  let lvl = LEVELS[0], next = LEVELS[1] || null;
  for (let i = 0; i < LEVELS.length; i++) {
    if (points >= LEVELS[i].min) { lvl = LEVELS[i]; next = LEVELS[i + 1] || null; }
  }
  const progress = next ? (points - lvl.min) / (next.min - lvl.min) : 1;
  return { level: lvl, next, progress: Math.max(0, Math.min(1, progress)) };
}

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
  other:    { label: 'Other hazard',   emoji: '⚠️', desc: 'Anything else worth knowing', expiryDays: 14 },
  // Streetlight reports — attached to a lamp on the streetlight layer. Status is derived from these, never assumed.
  light_out: { label: 'Streetlight out', emoji: '🔦', desc: 'This lamp is not working', expiryDays: 30, lamp: true },
  light_ok:  { label: 'Streetlight working', emoji: '💡', desc: 'Seen working recently', expiryDays: 14, lamp: true },
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
export const SURFACES = { paved: 'Paved', gravel: 'Gravel', dirt: 'Dirt / grass', unknown: 'Not sure' };

export const CONFIRMATIONS_TO_AUTO_FLAG = 2; // alerts with 2+ confirmations get the "community confirmed" marker

// ---------- Trips, friends and sharing ----------
// Normal trip-completion points: awarded for a voluntary arrival check-in, shared or not.
POINT_RULES.push(
  { key: 'trip_completed', label: 'Checked in at your destination after a trip', points: 5 },
  { key: 'shared_trip_bonus', label: 'Shared-trip bonus (both opted in; scales with distance)', points: 'up to 20' },
);
POINTS.trip_completed = 5;

// Shared-trip bonus bands: eligible distance = progress along the chosen route (capped at route length).
// Only applies when BOTH people opted into shared-trip rewards before the trip completed.
export const SHARED_TRIP_BONUS = {
  bands: [            // minimum eligible metres → bonus points
    { minM: 500,  points: 4 },
    { minM: 1500, points: 8 },
    { minM: 3000, points: 12 },
    { minM: 6000, points: 20 },
  ],
  maxPerTrip: 20,
  dailyCap: 40,
};
export function sharedTripBonusFor(metres) {
  let pts = 0;
  for (const b of SHARED_TRIP_BONUS.bands) if (metres >= b.minM) pts = b.points;
  return Math.min(pts, SHARED_TRIP_BONUS.maxPerTrip);
}

export const TRIP_LIMITS = {
  checkInsPerDay: 8,            // normal trip check-ins that can earn points per day
  minTripMetres: 200,           // shorter trips do not earn check-in points
  arrivalRadiusM: 75,           // check-in must be within this distance of the destination when a position is known
};

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
