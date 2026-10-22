// Seed data for the local demo backend — built from the sample set and clearly flagged `sample: true`.
import { SAMPLE_ALERTS, SAMPLE_APPROVED_PATHS, SAMPLE_PENDING_PATHS, SAMPLE_USERS } from '../providers/sampleData.js';
import { ALERT_CATEGORIES } from './rules.js';

export const SEED_VERSION = 2;

// Fixed IDs for sample users so the demo can be explored: try adding GW-KERB-H0P1 as a friend.
const SAMPLE_IDS = { 'u-sample-1': 'GW-KERB-H0P1', 'u-sample-2': 'GW-NYTE-CYCL', 'u-sample-3': 'GW-TOWP-ATH3', 'u-sample-4': 'GW-QUIE-TM0D' };

export function buildSeed() {
  const users = SAMPLE_USERS.map((u) => ({
    id: u.id, alias: u.alias, role: 'user', points: u.points, leaderboardOptIn: u.leaderboardOptIn,
    createdAt: '2026-09-01T00:00:00Z', sample: true, pinHash: null, gwId: SAMPLE_IDS[u.id], requestSetting: 'anyone',
  }));
  users.push({ id: 'u-demo-mod', alias: 'demo-moderator', role: 'admin', points: 0, leaderboardOptIn: false, createdAt: '2026-09-01T00:00:00Z', sample: true, pinHash: null });

  const alerts = SAMPLE_ALERTS.map((a) => ({
    ...a,
    expiresAt: new Date(new Date(a.createdAt).getTime() + ALERT_CATEGORIES[a.category].expiryDays * 86400000).toISOString(),
  }));
  const paths = [...SAMPLE_APPROVED_PATHS, ...SAMPLE_PENDING_PATHS];
  const points = [
    { id: 'pe-1', userId: 'u-sample-1', rule: 'path_approved', points: 50, refType: 'path', refId: 'path-greyfriars-cut', at: '2026-10-01T09:00:00Z', sample: true },
    { id: 'pe-2', userId: 'u-sample-1', rule: 'alert_verified', points: 10, refType: 'alert', refId: 'a-1', at: '2026-10-20T10:00:00Z', sample: true },
  ];
  return { version: SEED_VERSION, users, alerts, paths, points, session: null, friends: [], blocks: [], reports: [], shares: [], trips: [], idLookups: [] };
}
