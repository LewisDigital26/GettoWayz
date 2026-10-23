// Ghetto Wayz points policy — the ONE place point values, caps, trip bands, levels and leaderboard
// periods are defined.
//
// • Demo mode uses these values directly.
// • Live (Supabase) mode is authoritative on the server: the same defaults are seeded into the
//   `point_rules` and `points_settings` tables by supabase/migration-004-points.sql, and every award is
//   calculated there. To change live values, edit those tables (or this file + the migration seed for
//   new installs) — never send a points amount from the client.
//
// Principles: points reward verified, useful activity. Nothing is earned for time in the app, for adding
// friends, for sharing a location, or for travelling further or faster than a trip needs.

export const POLICY_VERSION = 2;

/**
 * Award rules. `points` is the amount for one award; `dailyCap` limits that rule's points per user per day
 * (UK date). An award that would pass the cap is still recorded, as "capped" with 0 points, so the user can
 * see why. Retired rules stay here so old ledger entries keep a readable label.
 */
export const RULES = {
  path_approved:        { label: 'Missing path approved by a moderator', group: 'Map contributions', points: 25, dailyCap: 75 },
  alert_verified:       { label: 'Hazard report verified by a moderator', group: 'Map contributions', points: 8, dailyCap: 40 },
  streetlight_verified: { label: 'Streetlight report verified by a moderator', group: 'Map contributions', points: 3, dailyCap: 15 },
  confirm_helpful:      { label: 'You confirmed a report that was then verified', group: 'Map contributions', points: 2, dailyCap: 10 },
  trip_completed:       { label: 'Completed a verified trip', group: 'Trips', points: 4, dailyCap: 16 },      // 4 rewarded trips/day
  trip_distance:        { label: 'Distance bonus for a verified trip', group: 'Trips', points: null, dailyCap: 30 }, // points from TRIP.bands
  reversal:             { label: 'Points reversed by a moderator', group: 'Adjustments', points: null },
  manual_adjustment:    { label: 'Points adjusted by a moderator', group: 'Adjustments', points: null },
  // retired — kept for history only
  alert_confirmed:      { label: 'Your report was confirmed by others (retired rule)', group: 'Retired', points: 0, retired: true },
  shared_trip_bonus:    { label: 'Shared-trip bonus (retired rule)', group: 'Retired', points: 0, retired: true },
};

/** Which verification rule applies to an alert category. */
export const ALERT_AWARD_RULE = (category) => (category === 'light_out' || category === 'light_ok' ? 'streetlight_verified' : 'alert_verified');

/**
 * Trips. Points are only awarded for a trip the server could check:
 *   started in the app with a route → periodic coarse position checks during navigation →
 *   reached ≥ minProgress of the route → finished within arrivalRadiusM of the destination →
 *   took at least a plausible amount of time and never moved implausibly fast.
 * Eligible distance = min(progress along the route, route length, straight-line × detourFactor), so a longer
 * or roundabout route never earns more. Distance is never typed in by the user.
 */
export const TRIP = {
  minEligibleM: 400,              // shorter trips earn nothing
  minProgress: 0.8,               // share of the route that must be travelled
  arrivalRadiusM: 75,
  detourFactor: 1.4,              // cap vs. straight-line distance
  checkpointEverySec: 30,         // client cadence while navigating (only if trip points are on)
  minCheckpointGapSec: 10,        // server ignores faster updates
  checkpointsPerKm: 1,            // at least max(2, ceil(km)) checks spread over the trip
  // Distance bands (walking-equivalent metres → bonus points). Bike/scooter distances are scaled first.
  bands: [
    { minM: 400, points: 1 },
    { minM: 1000, points: 3 },
    { minM: 2500, points: 5 },
    { minM: 5000, points: 8 },
    { minM: 8000, points: 10 },   // cap
  ],
  maxPerTrip: 14,                 // base + distance
  modes: {
    walk:    { distanceFactor: 1.0, maxSegmentSpeed: 4.0, maxAverageSpeed: 2.6, basePoints: 4, distanceBonus: true },
    bike:    { distanceFactor: 0.5, maxSegmentSpeed: 14,  maxAverageSpeed: 9,   basePoints: 4, distanceBonus: true },
    scooter: { distanceFactor: 0.5, maxSegmentSpeed: 9,   maxAverageSpeed: 7,   basePoints: 4, distanceBonus: true },
    // Driving: a small completion award only. No distance bonus, so the app never rewards driving further.
    drive:   { distanceFactor: 0,   maxSegmentSpeed: 45,  maxAverageSpeed: 30,  basePoints: 2, distanceBonus: false },
  },
  maxActiveHours: 6,              // an unfinished trip expires after this
};

/** Distance bonus for a walking-equivalent eligible distance. */
export function tripDistancePoints(mode, eligibleM) {
  const m = TRIP.modes[mode];
  if (!m || !m.distanceBonus) return 0;
  const equiv = eligibleM * m.distanceFactor;
  let pts = 0;
  for (const b of TRIP.bands) if (equiv >= b.minM) pts = b.points;
  return pts;
}

/**
 * Evaluate a finished trip. Pure — used by the demo backend and mirrored in SQL (finish_trip).
 * t = { mode, routeM, straightM, progressM, checkpoints, startedAt, finishedAt, flags: [], arrived }
 * Returns { outcome: 'award'|'review'|'none', eligibleM, base, distance, reasons[] }
 */
export function evaluateTrip(t) {
  const reasons = [];
  const m = TRIP.modes[t.mode] || TRIP.modes.walk;
  const eligibleM = Math.max(0, Math.min(t.progressM, t.routeM, t.straightM * TRIP.detourFactor));
  const secs = (new Date(t.finishedAt) - new Date(t.startedAt)) / 1000;
  if (!t.arrived) reasons.push(`Finish within ${TRIP.arrivalRadiusM} m of your destination for a trip to count.`);
  if (t.progressM < t.routeM * TRIP.minProgress) reasons.push('Not enough of the route was recorded — trip points need location checks during the trip.');
  if (eligibleM < TRIP.minEligibleM) reasons.push(`Trips under ${TRIP.minEligibleM} m don't earn points.`);
  const needChecks = Math.max(2, Math.ceil(eligibleM / 1000 * TRIP.checkpointsPerKm));
  if (t.checkpoints < needChecks) reasons.push('Too few location checks were received to verify this trip.');
  if (reasons.length) return { outcome: 'none', eligibleM, base: 0, distance: 0, reasons };
  if ((t.flags || []).includes('speed') || secs < eligibleM / m.maxAverageSpeed) {
    return { outcome: 'review', eligibleM, base: 0, distance: 0, reasons: ['This trip looked unusually fast for the travel mode, so a moderator will check it before any points are added.'] };
  }
  const base = m.basePoints;
  const distance = Math.min(tripDistancePoints(t.mode, eligibleM), TRIP.maxPerTrip - base);
  return { outcome: 'award', eligibleM, base, distance, reasons };
}

/**
 * Levels: derived from lifetime eligible points with a steady curve — threshold(n) = round5(base × (n−1)^exponent).
 * Early levels come quickly; later ones need ongoing contribution. If a moderator reverses points, your level is
 * NOT taken away (we keep the highest level reached); the reversed points do come off your balance and rankings.
 */
export const LEVEL_CURVE = { base: 25, exponent: 1.75 };
export const LEVEL_NAMES = [
  'Newcomer', 'Corner Scout', 'Block Walker', 'Shortcut Finder', 'Wayfinder',
  'Street Mapper', 'Route Keeper', 'Local Guide', 'Neighbourhood Legend', 'City Cartographer',
];
export const LEVELS = LEVEL_NAMES.map((name, i) => ({ n: i + 1, name, min: i === 0 ? 0 : Math.round((LEVEL_CURVE.base * Math.pow(i, LEVEL_CURVE.exponent)) / 5) * 5 }));

/** Level from points, respecting a never-decreasing floor. */
export function levelInfo(points, floor = 1) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) if (points >= LEVELS[i].min) idx = i;
  idx = Math.max(idx, Math.min(LEVELS.length, Math.max(1, floor)) - 1);
  const level = LEVELS[idx], next = LEVELS[idx + 1] || null;
  const progress = next ? Math.max(0, Math.min(1, (points - level.min) / (next.min - level.min))) : 1;
  return { level, next, progress, toNext: next ? Math.max(0, next.min - points) : 0 };
}

/** Leaderboards. Weekly runs Monday 00:00 → Sunday 23:59 UK time. */
export const LEADERBOARD = { timeZone: 'Europe/London', pageSize: 20, maxRows: 500 };

/** Start of the current leaderboard week (Monday 00:00 Europe/London) as a Date. */
export function weekStart(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: LEADERBOARD.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  // London wall-clock midnight of this Monday, converted back to an instant via the zone offset.
  const londonMidnight = Date.UTC(+parts.year, +parts.month - 1, +parts.day - dow);
  const offsetMin = tzOffsetMinutes(new Date(londonMidnight));
  return new Date(londonMidnight - offsetMin * 60000);
}
export const nextWeekStart = (now = new Date()) => new Date(weekStart(new Date(weekStart(now).getTime() + 8 * 86400000)));
function tzOffsetMinutes(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: LEADERBOARD.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - d.getTime()) / 60000;
}
/** UK calendar date (YYYY-MM-DD) — used for daily caps. */
export const ukDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: LEADERBOARD.timeZone }).format(d);
