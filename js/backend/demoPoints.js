// Points, levels, verified trips and leaderboards for the LOCAL DEMO backend.
// Mirrors supabase/migration-004-points.sql (the live, server-authoritative version) using the same policy
// (./pointsPolicy.js). In demo mode everything stays on this device.
//
// Ledger entry: { id, userId, rule, points, refType, refId, at, status: 'awarded'|'capped'|'reversed'|'reversal',
//                 pointsRequested, reversalOf?, reason?, actor?, policyVersion }

import { BackendError, uid, haversine, lineLength } from '../util.js';
import { RULES, TRIP, POLICY_VERSION, LEVELS, levelInfo, evaluateTrip, tripDistancePoints, weekStart, ukDate, ALERT_AWARD_RULE } from './pointsPolicy.js';

const iso = () => new Date().toISOString();
const MAX_PAGE = 50, MAX_OFFSET = 500;

export const pointsMethods = {
  _ensurePoints() {
    const d = this.db;
    d.points ||= []; d.tripSessions ||= []; d.adminActions ||= [];
    for (const u of d.users) { u.levelFloor ??= levelInfo(u.points || 0).level.n; u.friendsBoardOptIn ??= false; u.tripPoints ??= true; }
    for (const e of d.points) e.status ||= 'awarded';
  },
  _levelOf(u) { return levelInfo(u.points, u.levelFloor).level; },

  /** The only way points are added (server-side equivalent: gw_award). Idempotent per (user, rule, refId). */
  award(userId, rule, refType, refId, points = null) {
    this._ensurePoints();
    const r = RULES[rule];
    const u = this.db.users.find((x) => x.id === userId);
    if (!r || r.retired || rule === 'reversal' || !u || refId == null) return 0;
    const req = points ?? r.points ?? 0;
    if (req <= 0) return 0;
    if (this.db.points.some((e) => e.userId === userId && e.rule === rule && e.refId === refId)) return 0;
    let pts = req, status = 'awarded';
    if (r.dailyCap != null) {
      const today = ukDate();
      const used = this.db.points.filter((e) => e.userId === userId && e.rule === rule && e.status === 'awarded' && ukDate(new Date(e.at)) === today).reduce((n, e) => n + e.points, 0);
      if (used >= r.dailyCap) { pts = 0; status = 'capped'; } else if (used + pts > r.dailyCap) pts = r.dailyCap - used;
    }
    this.db.points.push({ id: 'pe-' + uid(), userId, rule, points: pts, refType, refId, at: iso(), status, pointsRequested: req, policyVersion: POLICY_VERSION });
    if (pts > 0) { u.points += pts; u.levelFloor = Math.max(u.levelFloor || 1, levelInfo(u.points).level.n); }
    return pts;
  },
  /** Back-compat name used by older code paths. */
  grant(userId, rule, refType, refId) { return this.award(userId, rule, refType, refId); },

  _reverseEntry(entryId, reason, actorId) {
    const e = this.db.points.find((x) => x.id === entryId);
    if (!e || !['awarded', 'capped'].includes(e.status) || e.rule === 'reversal') return 0;
    e.status = 'reversed';
    this.db.points.push({ id: 'pe-' + uid(), userId: e.userId, rule: 'reversal', points: -e.points, refType: 'point_entry', refId: e.id, at: iso(), status: 'reversal', reversalOf: e.id, reason: String(reason).slice(0, 300), actor: actorId, policyVersion: POLICY_VERSION });
    const u = this.db.users.find((x) => x.id === e.userId);
    if (u && e.points) u.points = Math.max(0, u.points - e.points); // level floor is kept
    return e.points;
  },

  // ---------- own data ----------
  async pointHistory(userId) {
    this._ensurePoints();
    const me = this.requireUser();
    if (userId && userId !== me.id && me.role !== 'admin') throw new BackendError('forbidden', 'You can only see your own points.');
    return this.db.points.filter((e) => e.userId === (userId || me.id)).sort((a, b) => new Date(b.at) - new Date(a.at));
  },
  async myLedger({ offset = 0, limit = 20 } = {}) {
    const all = await this.pointHistory();
    const o = Math.max(0, Math.min(MAX_OFFSET, offset | 0)), l = Math.max(1, Math.min(MAX_PAGE, limit | 0));
    return { entries: all.slice(o, o + l), total: all.length };
  },
  async myPointsSummary() {
    this._ensurePoints();
    const me = this.requireUser();
    const u = this.db.users.find((x) => x.id === me.id);
    const ws = weekStart();
    const week = this.db.points.filter((e) => e.userId === u.id && e.status === 'awarded' && new Date(e.at) >= ws).reduce((n, e) => n + e.points, 0);
    return { points: u.points, levelFloor: u.levelFloor, week, leaderboardOptIn: !!u.leaderboardOptIn, friendsBoardOptIn: !!u.friendsBoardOptIn, tripPoints: u.tripPoints !== false };
  },
  async myContributions() {
    this._ensurePoints();
    const me = this.requireUser();
    const award = (type, id, rules) => { const e = this.db.points.find((x) => x.userId === me.id && x.refType === type && x.refId === id && rules.includes(x.rule)); return e ? { status: e.status, points: e.points } : null; };
    const alerts = this.db.alerts.filter((a) => a.createdBy === me.id).map((a) => ({ kind: 'alert', id: a.id, category: a.category, status: a.status, createdAt: a.createdAt, award: award('alert', a.id, ['alert_verified', 'streetlight_verified', 'street_lighting_confirmed']) }));
    const paths = this.db.paths.filter((p) => p.createdBy === me.id).map((p) => ({ kind: 'path', id: p.id, name: p.name, status: p.status, createdAt: p.createdAt, message: p.reviewMessage, award: award('path', p.id, ['path_approved']) }));
    return [...alerts, ...paths].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 60);
  },
  async myTrips() {
    this._ensurePoints();
    const me = this.requireUser();
    return this.db.tripSessions.filter((t) => t.userId === me.id && t.status !== 'active').sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 20)
      .map(({ id, mode, status, startedAt, eligibleM, basePoints, distancePoints, reasons }) => ({ id, mode, status, startedAt, eligibleM, basePoints, distancePoints, reasons }));
  },
  async setPointsPrefs({ leaderboardOptIn, friendsBoardOptIn, tripPoints } = {}) {
    this._ensurePoints();
    const u = this.db.users.find((x) => x.id === this.requireUser().id);
    if (leaderboardOptIn != null) u.leaderboardOptIn = !!leaderboardOptIn;
    if (friendsBoardOptIn != null) u.friendsBoardOptIn = !!friendsBoardOptIn;
    if (tripPoints != null) u.tripPoints = !!tripPoints;
    this.save();
    return this.publicUser(u);
  },
  /** Live mode reads these from the server tables; demo returns the local policy. */
  async pointsPolicy() { return { rules: RULES, trip: TRIP, levels: LEVELS, source: 'local' }; },

  // ---------- verified trips ----------
  async startTrip(mode, geometry) {
    this._ensurePoints();
    const me = this.requireUser();
    const u = this.db.users.find((x) => x.id === me.id);
    if (u.tripPoints === false) throw new BackendError('off', 'Trip points are turned off in your settings.');
    if (!TRIP.modes[mode]) throw new BackendError('invalid', 'Unknown travel mode.');
    if (!Array.isArray(geometry) || geometry.length < 2 || geometry.length > 6000) throw new BackendError('invalid', 'Route is missing or too long.');
    const today = ukDate();
    if (this.db.tripSessions.filter((t) => t.userId === me.id && ukDate(new Date(t.startedAt)) === today).length >= 30) throw new BackendError('rate', 'Trip limit reached for today.');
    this._expireTrips();
    for (const t of this.db.tripSessions) if (t.userId === me.id && t.status === 'active') this._endTrip(t, 'abandoned', ['A new trip was started.']);
    const g = geometry.map(([a, b]) => [a, b]);
    const t = { id: 'trip-' + uid(), userId: me.id, mode, status: 'active', startedAt: iso(), routeM: lineLength(g), straightM: haversine(g[0], g[g.length - 1]),
      dest: [+g[g.length - 1][0].toFixed(5), +g[g.length - 1][1].toFixed(5)], route: g, progressM: 0, checkpoints: 0, last: null, flags: [], reasons: [] };
    this.db.tripSessions.push(t); this.save();
    return t.id;
  },
  _endTrip(t, status, reasons) {
    t.status = status; t.finishedAt ||= iso(); if (reasons) t.reasons = reasons;
    delete t.route; delete t.last; delete t.dest; // no location kept after the trip
  },
  _expireTrips() {
    const cutoff = Date.now() - TRIP.maxActiveHours * 3600000;
    for (const t of this.db.tripSessions) if (t.status === 'active' && new Date(t.startedAt).getTime() < cutoff) this._endTrip(t, 'expired', ['The trip was not finished in time.']);
  },
  async tripCheckpoint(id, pos) {
    this._ensurePoints();
    const me = this.requireUser();
    const t = this.db.tripSessions.find((x) => x.id === id && x.userId === me.id);
    if (!t || t.status !== 'active' || !pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
    if (Date.now() - new Date(t.startedAt).getTime() > TRIP.maxActiveHours * 3600000) { this._endTrip(t, 'expired', ['The trip was not finished in time.']); this.save(); return; }
    const now = Date.now();
    if (t.last && (now - t.last.at) / 1000 < TRIP.minCheckpointGapSec) return;
    const p = [pos.lat, pos.lng];
    if (t.last) {
      const seg = haversine([t.last.lat, t.last.lng], p), dt = (now - t.last.at) / 1000;
      if (seg > 50 && dt > 0 && seg / dt > TRIP.modes[t.mode].maxSegmentSpeed && !t.flags.includes('speed')) t.flags.push('speed');
    }
    let bestI = 0, bestD = Infinity;
    t.route.forEach((q, i) => { const d = haversine(p, q); if (d < bestD) { bestD = d; bestI = i; } });
    if (bestD < 60) {
      let rem = 0; for (let i = bestI; i < t.route.length - 1; i++) rem += haversine(t.route[i], t.route[i + 1]);
      t.progressM = Math.max(t.progressM, Math.min(t.routeM, t.routeM - rem));
      t.checkpoints++;
    }
    t.last = { lat: +pos.lat.toFixed(5), lng: +pos.lng.toFixed(5), at: now };
    this.save();
  },
  async finishTrip(id, pos) {
    this._ensurePoints();
    const me = this.requireUser();
    await this.tripCheckpoint(id, pos);
    const t = this.db.tripSessions.find((x) => x.id === id && x.userId === me.id);
    if (!t) throw new BackendError('missing', 'Trip not found.');
    const round100 = (m) => Math.round(m / 100) * 100;
    if (t.status !== 'active') return { outcome: t.status, basePoints: t.basePoints || 0, distancePoints: t.distancePoints || 0, eligibleM: round100(t.eligibleM || 0), reasons: t.reasons || [] };
    const near = (q) => q && haversine([q.lat, q.lng], t.dest) <= TRIP.arrivalRadiusM;
    const ev = evaluateTrip({ mode: t.mode, routeM: t.routeM, straightM: t.straightM, progressM: t.progressM, checkpoints: t.checkpoints,
      startedAt: t.startedAt, finishedAt: iso(), flags: t.flags, arrived: near(pos) || near(t.last) });
    t.eligibleM = Math.round(ev.eligibleM);
    if (ev.outcome === 'none') { this._endTrip(t, 'no_award', ev.reasons); this.save(); return { outcome: 'no_award', basePoints: 0, distancePoints: 0, eligibleM: round100(ev.eligibleM), reasons: ev.reasons }; }
    // keep the computed amounts so a moderator can approve a trip held for review
    const base = TRIP.modes[t.mode].basePoints;
    const dist = Math.min(tripDistancePoints(t.mode, ev.eligibleM), TRIP.maxPerTrip - base);
    t.basePoints = base; t.distancePoints = dist;
    if (ev.outcome === 'review') { this._endTrip(t, 'review', ev.reasons); this.save(); return { outcome: 'review', basePoints: 0, distancePoints: 0, eligibleM: round100(ev.eligibleM), reasons: ev.reasons }; }
    const gotBase = this.award(me.id, 'trip_completed', 'trip', t.id, base);
    const gotDist = dist > 0 ? this.award(me.id, 'trip_distance', 'trip', t.id, dist) : 0;
    const reasons = gotBase < base || gotDist < dist ? ['Daily trip points limit reached — some points for this trip were capped.'] : [];
    this._endTrip(t, 'completed', reasons); this.save();
    return { outcome: 'completed', basePoints: gotBase, distancePoints: gotDist, eligibleM: round100(ev.eligibleM), reasons };
  },
  async abandonTrip(id) {
    const me = this.requireUser();
    const t = this.db.tripSessions?.find((x) => x.id === id && x.userId === me.id && x.status === 'active');
    if (t) { this._endTrip(t, 'abandoned', ['Navigation was ended before arrival.']); this.save(); }
  },

  // ---------- leaderboards ----------
  _board(scope, period) {
    this._ensurePoints();
    const me = this.currentUser();
    if (scope === 'friends' && !me) return [];
    const ws = weekStart();
    const pool = this.db.users.filter((u) => (
      (scope === 'public' && u.leaderboardOptIn) ||
      (scope === 'friends' && (u.id === me.id || (u.friendsBoardOptIn && this._friendship?.(me.id, u.id) && !this._blockedEither?.(me.id, u.id))))));
    const scored = pool.map((u) => ({ u, score: period === 'week'
      ? this.db.points.filter((e) => e.userId === u.id && e.status === 'awarded' && new Date(e.at) >= ws).reduce((n, e) => n + e.points, 0)
      : u.points })).filter((r) => r.score > 0 || scope === 'friends');
    scored.sort((a, b) => b.score - a.score || a.u.alias.toLowerCase().localeCompare(b.u.alias.toLowerCase()) || a.u.id.localeCompare(b.u.id));
    let rank = 0, prev = null;
    return scored.map((r, i) => { if (r.score !== prev) { rank = i + 1; prev = r.score; } return { rank, alias: r.u.alias, level: this._levelOf(r.u).n, points: r.score, isMe: r.u.id === me?.id, sample: !!r.u.sample, total: scored.length }; });
  },
  async leaderboardPage({ scope = 'public', period = 'week', offset = 0, limit = 20 } = {}) {
    if (!['public', 'friends'].includes(scope) || !['week', 'all'].includes(period)) throw new BackendError('invalid', 'Unknown leaderboard.');
    const rows = this._board(scope, period);
    const o = Math.max(0, Math.min(MAX_OFFSET, offset | 0)), l = Math.max(1, Math.min(MAX_PAGE, limit | 0));
    return { rows: rows.slice(o, o + l), total: rows.length, me: rows.find((r) => r.isMe) || null };
  },
  /** Back-compat: public all-time top 25. */
  async leaderboard() { return (await this.leaderboardPage({ scope: 'public', period: 'all', limit: 25 })).rows.map((r) => ({ ...r, level: LEVELS[r.level - 1].name })); },

  // ---------- moderator tools ----------
  _logAdmin(action, targetUser, targetRef, reason) { this.db.adminActions.push({ id: 'aa-' + uid(), adminId: this.currentUser().id, action, targetUser, targetRef, reason: reason ? String(reason).slice(0, 300) : null, at: iso() }); },
  async adminUserPoints(alias) {
    this.requireAdmin(); this._ensurePoints();
    const u = this.db.users.find((x) => x.alias.toLowerCase() === String(alias || '').trim().toLowerCase());
    if (!u) return null;
    return { id: u.id, alias: u.alias, points: u.points, levelFloor: u.levelFloor, entries: this.db.points.filter((e) => e.userId === u.id).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 100) };
  },
  /** Moderator adjustment (testing / corrections): logged, shown in the user's history, reversible. */
  async adminGrantPoints(alias, points, reason) {
    this.requireAdmin(); this._ensurePoints();
    const p = Math.trunc(Number(points));
    if (!p || Math.abs(p) > 1000) throw new BackendError('invalid', 'Choose an amount between -1000 and 1000 (not 0).');
    if (String(reason || '').trim().length < 5) throw new BackendError('invalid', 'Give a reason (at least 5 characters).');
    const u = this.db.users.find((x) => x.alias.toLowerCase() === String(alias || '').trim().toLowerCase());
    if (!u) throw new BackendError('missing', 'No user with that alias.');
    const n = p < 0 ? Math.max(p, -u.points) : p;
    if (!n) throw new BackendError('invalid', 'That user has no points to remove.');
    this.db.points.push({ id: 'pe-' + uid(), userId: u.id, rule: 'manual_adjustment', points: n, refType: 'manual', refId: uid(), at: iso(), status: 'awarded', pointsRequested: p, reason: String(reason).trim().slice(0, 300), actor: this.currentUser().id, policyVersion: POLICY_VERSION });
    u.points += n;
    u.levelFloor = Math.max(u.levelFloor || 1, levelInfo(u.points).level.n);
    this._logAdmin('grant_points', u.id, 'points:' + n, reason); this.save(); this.emit?.();
    return { alias: u.alias, points: n, total: u.points };
  },
  async adminReverseAward(entryId, reason) {
    this.requireAdmin(); this._ensurePoints();
    if (String(reason || '').trim().length < 5) throw new BackendError('invalid', 'Give a reason (at least 5 characters).');
    const e = this.db.points.find((x) => x.id === entryId);
    if (!e) throw new BackendError('missing', 'Award not found.');
    const n = this._reverseEntry(entryId, reason, this.currentUser().id);
    this._logAdmin('reverse_award', e.userId, 'point_entry:' + entryId, reason); this.save();
    return n;
  },
  async adminReverseSource(refType, refId, reason) {
    this.requireAdmin(); this._ensurePoints();
    if (String(reason || '').trim().length < 5) throw new BackendError('invalid', 'Give a reason (at least 5 characters).');
    let total = 0;
    for (const e of this.db.points.filter((x) => x.refType === refType && x.refId === refId && ['awarded', 'capped'].includes(x.status) && x.rule !== 'reversal')) total += this._reverseEntry(e.id, reason, this.currentUser().id);
    if (refType === 'path') { const p = this.db.paths.find((x) => x.id === refId); if (p) { p.status = 'rejected'; p.reviewMessage = String(reason).slice(0, 300); } }
    if (refType === 'alert') { const a = this.db.alerts.find((x) => x.id === refId); if (a) a.status = 'rejected'; }
    this._logAdmin('reverse_source', null, `${refType}:${refId}`, reason); this.save();
    return total;
  },
  async adminTripsForReview() {
    this.requireAdmin(); this._ensurePoints();
    return this.db.tripSessions.filter((t) => t.status === 'review').map((t) => ({ id: t.id, alias: this.aliasOf(t.userId), mode: t.mode, eligibleM: t.eligibleM, routeM: Math.round(t.routeM),
      minutes: Math.round((new Date(t.finishedAt) - new Date(t.startedAt)) / 60000), checkpoints: t.checkpoints, flags: t.flags, basePoints: t.basePoints, distancePoints: t.distancePoints, day: ukDate(new Date(t.startedAt)) }));
  },
  async adminReviewTrip(id, decision, reason = '') {
    this.requireAdmin(); this._ensurePoints();
    const t = this.db.tripSessions.find((x) => x.id === id);
    if (!t || t.status !== 'review') throw new BackendError('invalid', 'This trip is not awaiting review.');
    let got = 0;
    if (decision === 'approve') {
      got = this.award(t.userId, 'trip_completed', 'trip', t.id, t.basePoints);
      if (t.distancePoints > 0) got += this.award(t.userId, 'trip_distance', 'trip', t.id, t.distancePoints);
      t.status = 'completed'; t.reasons = ['Checked and approved by a moderator.'];
    } else { t.status = 'rejected'; t.reasons = ['A moderator could not verify this trip' + (reason ? `: ${String(reason).slice(0, 200)}` : '.')]; }
    this._logAdmin('trip_' + decision, t.userId, 'trip:' + id, reason); this.save();
    return got;
  },
};

export { ALERT_AWARD_RULE };
