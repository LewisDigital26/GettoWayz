// Badges & streaks. Live mode: computed by my_badges() in SQL (migration-010) from verified data only.
// Demo mode: the same rules computed from the local demo DB. Badges never earn points.
export const BADGES = {
  first_trip: { emoji: '👟', name: 'First steps',        desc: 'Finish your first verified trip' },
  trips_10:   { emoji: '🛣️', name: 'Regular',            desc: '10 verified trips' },
  trips_50:   { emoji: '🏅', name: 'Road warrior',       desc: '50 verified trips' },
  km_10:      { emoji: '📏', name: '10 km club',         desc: '10 km of verified trips' },
  km_100:     { emoji: '🌍', name: '100 km club',        desc: '100 km of verified trips' },
  streak_3:   { emoji: '🔥', name: 'On a roll',          desc: 'Trips on 3 days in a row' },
  streak_7:   { emoji: '⚡', name: 'Week streak',        desc: 'Trips on 7 days in a row' },
  all_modes:  { emoji: '🔄', name: 'All-rounder',        desc: 'Verified trips walking, cycling and scooting' },
  hazard_5:   { emoji: '🦺', name: 'Hazard hunter',      desc: '5 hazard reports verified' },
  lights_5:   { emoji: '🔦', name: 'Lamp lighter',       desc: '5 lighting reports verified or confirmed' },
  path_1:     { emoji: '🛤️', name: 'Path maker',         desc: 'A path you suggested was approved' },
  path_5:     { emoji: '🗺️', name: 'Cartographer',       desc: '5 approved paths' },
  checker_10: { emoji: '✅', name: 'Path checker',       desc: 'Confirmed 10 community paths are still there' },
};

const ukDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
const dayNum = (s) => Math.round(Date.parse(s + 'T12:00:00Z') / 86400000);

/** Current and best streak from a list of trip finish times. */
export function streakFrom(times) {
  const days = [...new Set(times.map(ukDay))].map(dayNum).sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const d of days) { run = prev != null && d === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  const today = dayNum(ukDay(Date.now()));
  const current = prev != null && prev >= today - 1 ? run : 0;
  return { current, best };
}

/** Same shape as the server's my_badges(). */
export function buildBadges({ trips = [], awarded = [], pathChecks = 0 }) {
  const done = trips.filter((t) => t.status === 'completed');
  const dist = done.reduce((n, t) => n + (t.eligibleM || 0), 0);
  const modes = new Set(done.filter((t) => t.mode !== 'drive').map((t) => t.mode)).size;
  const count = (rules) => awarded.filter((e) => rules.includes(e.rule)).length;
  const hazards = count(['alert_verified']), lights = count(['streetlight_verified', 'street_lighting_confirmed']), paths = count(['path_approved']);
  const streak = streakFrom(done.map((t) => t.finishedAt || t.startedAt));
  const km = Math.round(dist / 1000);
  const prog = { first_trip: done.length, trips_10: done.length, trips_50: done.length, km_10: km, km_100: km, streak_3: streak.best, streak_7: streak.best,
    all_modes: modes, hazard_5: hazards, lights_5: lights, path_1: paths, path_5: paths, checker_10: pathChecks };
  const target = { first_trip: 1, trips_10: 10, trips_50: 50, km_10: 10, km_100: 100, streak_3: 3, streak_7: 7, all_modes: 3, hazard_5: 5, lights_5: 5, path_1: 1, path_5: 5, checker_10: 10 };
  return {
    streak,
    stats: { trips: done.length, distanceM: Math.round(dist), modes, hazards, lights, paths, pathChecks },
    badges: Object.keys(BADGES).map((key) => ({ key, progress: prog[key], target: target[key] })),
  };
}
