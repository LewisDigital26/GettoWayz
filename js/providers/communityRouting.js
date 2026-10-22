// Community-path routing.
//
// Public routing engines (OpenRouteService, OSRM) only know OpenStreetMap. A footpath or alley that the
// community added and a moderator approved is not in OSM, so the engine can never route along it.
// This module bridges the gap on the client:
//
//   1. pick approved community paths that suit the travel mode and could plausibly shorten the trip;
//   2. ask the routing engine for  start → path entrance  and  path exit → destination;
//   3. stitch  leg 1 + the community path + leg 2  into one route;
//   4. keep it only if it is genuinely competitive with the engine's own quickest route.
//
// The engine's legs are real routes. The community section is timed at the mode's average speed and is
// labelled as a community path, so nobody mistakes it for an OSM-verified way.

import { COMMUNITY_ROUTING as CR } from '../backend/rules.js';
import { haversine, lineLength, uid, MODES } from '../util.js';

// Which community path types each mode may use. Driving never uses community paths.
const ALLOWED = {
  walk: ['footpath', 'shared', 'steps'],
  bike: ['cycle', 'shared'],
  scooter: ['cycle', 'shared'],
  drive: [],
};

const isArrive = (s) => /^arrive/i.test(String(s.text || '').trim());

/**
 * Candidate paths, each with the orientation (which end you enter from) that gives the shortest
 * straight-line estimate. Sorted best first.
 */
export function pickCandidates({ from, to, mode, paths, baseDistanceM, exclude = new Set() }) {
  const ok = ALLOWED[mode] || [];
  const out = [];
  for (const p of paths) {
    if (p.status !== 'approved' || !ok.includes(p.type) || exclude.has(p.id)) continue;
    if (!Array.isArray(p.points) || p.points.length < 2) continue;
    const len = lineLength(p.points);
    const a = p.points[0], b = p.points[p.points.length - 1];
    const fwd = haversine(from, a) + len + haversine(b, to);
    const rev = haversine(from, b) + len + haversine(a, to);
    const reversed = rev < fwd;
    const est = Math.min(fwd, rev);
    // Straight-line estimates undercount real streets, so this is a generous first filter —
    // the real check happens after the engine has routed the legs.
    if (est > baseDistanceM * CR.candidateSlack) continue;
    // Skip paths far off the trip altogether.
    if (haversine(from, a) > baseDistanceM && haversine(to, a) > baseDistanceM) continue;
    out.push({ path: p, points: reversed ? [...p.points].reverse() : p.points, len, est });
  }
  return out.sort((x, y) => x.est - y.est).slice(0, CR.maxCandidates);
}

/** Join an engine leg to a community-path end. Returns the connector length, or null if the gap is too wide. */
function gap(a, b) {
  const d = haversine(a, b);
  return d <= CR.maxJoinGapM ? d : null;
}

async function stitch({ routing, from, to, mode, cand, providerLabel }) {
  const entry = cand.points[0], exit = cand.points[cand.points.length - 1];
  const needLeg1 = haversine(from, entry) > CR.skipLegUnderM;
  const needLeg2 = haversine(exit, to) > CR.skipLegUnderM;
  const [leg1, leg2] = await Promise.all([
    needLeg1 ? routing.leg(from, entry, mode) : null,
    needLeg2 ? routing.leg(exit, to, mode) : null,
  ]);

  // Where the engine's legs actually start/end (it snaps to the nearest road it knows).
  const g1 = leg1 ? gap(leg1.geometry[leg1.geometry.length - 1], entry) : 0;
  const g2 = leg2 ? gap(exit, leg2.geometry[0]) : 0;
  if (g1 === null || g2 === null) return null; // path end isn't near anything the engine can reach

  const speed = MODES[mode].speed;
  const communityM = cand.len + g1 + g2;
  const communityS = communityM / speed;

  const geometry = [
    ...(leg1 ? leg1.geometry : [from]),
    ...cand.points,
    ...(leg2 ? leg2.geometry : [to]),
  ];
  const steps = [
    ...(leg1 ? leg1.steps.filter((s) => !isArrive(s)) : []),
    { text: `Take the community path “${cand.path.name || 'unnamed path'}”`, dist: communityM, community: true },
    ...(leg2 ? leg2.steps : [{ text: 'Arrive at your destination', dist: 0 }]),
  ];
  return {
    id: uid(), label: 'Alternative', source: 'live', traffic: false,
    basis: `Live route from ${providerLabel}, joined to the moderator-approved community path “${cand.path.name || 'unnamed path'}”, which isn’t in OpenStreetMap yet. The community section (${Math.round(communityM)} m) is timed at an average ${MODES[mode].label.toLowerCase()} pace.`,
    geometry,
    distanceM: (leg1?.distanceM || 0) + communityM + (leg2?.distanceM || 0),
    durationS: (leg1?.durationS || 0) + communityS + (leg2?.durationS || 0),
    steps,
    communityPathIds: [cand.path.id],
    viaCommunity: { pathId: cand.path.id, startIndex: leg1 ? leg1.geometry.length : 1, length: cand.points.length },
  };
}

/**
 * Extra routes that use approved community paths. Never throws; returns [] when nothing helps.
 * `base` are the engine's own routes (already annotated with communityPathIds).
 */
export async function communityRoutes({ routing, from, to, mode, paths, base }) {
  if (typeof routing?.leg !== 'function') return []; // sample provider: sample routes already include community paths
  const live = base.filter((r) => r.source === 'live');
  if (!live.length) return [];
  const quickest = live.reduce((a, b) => (a.durationS <= b.durationS ? a : b));
  const exclude = new Set(base.flatMap((r) => r.communityPathIds || []));
  const cands = pickCandidates({ from, to, mode, paths, baseDistanceM: quickest.distanceM, exclude });
  if (!cands.length) return [];
  const providerLabel = routing.name === 'osrm' ? 'OSRM' : 'OpenRouteService';
  const results = await Promise.all(cands.map((cand) => stitch({ routing, from, to, mode, cand, providerLabel }).catch(() => null)));
  return results
    .filter(Boolean)
    .filter((r) => r.durationS <= quickest.durationS * CR.maxSlowdown)
    .sort((a, b) => a.durationS - b.durationS)
    .slice(0, CR.maxExtraRoutes);
}
