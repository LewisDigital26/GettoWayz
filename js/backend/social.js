// Social backend methods — friends, blocks, reports, location/trip sharing sessions, trip rewards.
// Mixed into LocalDemoBackend. A real backend must implement the same methods SERVER-SIDE with the
// same access checks: every call is scoped to the signed-in user, and a session's position is only
// ever returned to that session's recipient.
//
// Data (all in the demo db, this device only):
//   friends:  { id, from, to, status: 'pending'|'accepted', createdAt, respondedAt? }
//   blocks:   { by, target, at }
//   reports:  { id, by, target, reason, at }
//   shares:   { id, from, to, type: 'location'|'trip', startedAt, endsAt, status: 'active'|'paused'|'ended',
//               endedReason?, lastPos?: { lat, lng, at }        // ONLY the latest position — no history
//               trip?: { destName, destLat, destLng, routeDistanceM, geometry, progressM, durationS, arrived, rewardOptIn: { [userId]: true } } }
//   trips:    { id, userId, shareId?, distanceM, bonusM, at }  // completed-trip ledger for dedupe/caps (no coordinates)

import { BackendError, uid, haversine, distanceToLine } from '../util.js';
import { SAMPLE_ROUTES } from '../providers/sampleData.js';
import { FRIEND_LIMITS, SHARE_DURATIONS, SHARE_MAX_MINUTES, TRIP_LIMITS, POINTS, sharedTripBonusFor, SHARED_TRIP_BONUS } from './rules.js';

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export function makeGwId() {
  const pick = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
  return `GW-${pick(4)}-${pick(4)}`;
}
export const normalizeGwId = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^GW/, '').replace(/^(.{4})(.{4})$/, 'GW-$1-$2');

const now = () => Date.now();
const iso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

export const socialMethods = {
  // ---------- helpers ----------
  _ensureSocial() {
    const d = this.db;
    d.friends ||= []; d.blocks ||= []; d.reports ||= []; d.shares ||= []; d.trips ||= []; d.idLookups ||= [];
    for (const u of d.users) { u.gwId ||= makeGwId(); u.requestSetting ||= 'anyone'; }
  },
  _blockedEither(a, b) { return this.db.blocks.some((x) => (x.by === a && x.target === b) || (x.by === b && x.target === a)); },
  _friendship(a, b) { return this.db.friends.find((f) => f.status === 'accepted' && ((f.from === a && f.to === b) || (f.from === b && f.to === a))); },
  _publicPeer(userId) {
    const u = this.db.users.find((x) => x.id === userId);
    return u ? { id: u.id, alias: u.alias, gwId: u.gwId, sample: !!u.sample } : { id: userId, alias: 'unknown', gwId: '' };
  },
  _expireShares() {
    const t = now();
    for (const s of this.db.shares) {
      if (s.status !== 'ended' && new Date(s.endsAt).getTime() <= t) this._endShare(s, 'expired');
    }
  },
  _endShare(s, reason) {
    s.status = 'ended'; s.endedReason = reason; s.endedAt = iso();
    delete s.lastPos; // session location data is deleted when sharing ends
    if (s.trip) delete s.trip.geometry;
  },

  // ---------- identity ----------
  myId() { this._ensureSocial(); const u = this.requireUser(); return this.db.users.find((x) => x.id === u.id).gwId; },
  setRequestSetting(setting) {
    const u = this.db.users.find((x) => x.id === this.requireUser().id);
    if (!['anyone', 'none'].includes(setting)) throw new BackendError('invalid', 'Unknown setting.');
    u.requestSetting = setting; this.save(); return setting;
  },

  // ---------- friends ----------
  async lookupId(rawId) {
    this._ensureSocial();
    const me = this.requireUser();
    const cutoff = now() - 3600000;
    this.db.idLookups = this.db.idLookups.filter((l) => l.at > cutoff);
    if (this.db.idLookups.filter((l) => l.by === me.id).length >= FRIEND_LIMITS.idLookupsPerHour)
      throw new BackendError('rate', `Too many ID searches — try again in an hour.`);
    this.db.idLookups.push({ by: me.id, at: now() });
    const id = normalizeGwId(rawId);
    const u = this.db.users.find((x) => x.gwId === id && x.id !== me.id && x.role !== 'admin');
    this.save();
    if (!u || this._blockedEither(me.id, u.id)) return null; // blocked users look like they don't exist
    // Only alias + ID are revealed. Never email/phone/points/location.
    return { id: u.id, alias: u.alias, gwId: u.gwId, sample: !!u.sample };
  },
  async sendFriendRequest(targetUserId) {
    this._ensureSocial();
    const me = this.requireUser();
    const target = this.db.users.find((x) => x.id === targetUserId);
    if (!target || target.id === me.id || this._blockedEither(me.id, target.id)) throw new BackendError('missing', 'Could not find that user.');
    if (target.requestSetting === 'none') throw new BackendError('closed', 'This user is not accepting friend requests.');
    if (this._friendship(me.id, target.id)) throw new BackendError('dupe', 'You are already friends.');
    const existing = this.db.friends.find((f) => f.status === 'pending' && ((f.from === me.id && f.to === target.id) || (f.from === target.id && f.to === me.id)));
    if (existing) throw new BackendError('dupe', existing.from === me.id ? 'Request already sent.' : 'They already sent you a request — accept it from your inbox.');
    if (this.db.friends.filter((f) => f.from === me.id && f.createdAt.slice(0, 10) === today()).length >= FRIEND_LIMITS.requestsPerDay)
      throw new BackendError('rate', `Limit reached: ${FRIEND_LIMITS.requestsPerDay} friend requests per day.`);
    if (this.db.friends.filter((f) => f.status === 'accepted' && (f.from === me.id || f.to === me.id)).length >= FRIEND_LIMITS.maxFriends)
      throw new BackendError('rate', 'Friend list is full.');
    const req = { id: 'fr-' + uid(), from: me.id, to: target.id, status: 'pending', createdAt: iso() };
    this.db.friends.push(req);
    // Demo only: sample users auto-accept after a moment so the flow can be explored.
    if (target.sample) setTimeout(() => { if (req.status === 'pending') { req.status = 'accepted'; req.respondedAt = iso(); this.save(); } }, 2500);
    this.save();
    return req;
  },
  async respondFriendRequest(requestId, accept) {
    const me = this.requireUser();
    const req = this.db.friends.find((f) => f.id === requestId && f.to === me.id && f.status === 'pending');
    if (!req) throw new BackendError('missing', 'Request not found.');
    if (accept) { req.status = 'accepted'; req.respondedAt = iso(); }
    else this.db.friends = this.db.friends.filter((f) => f !== req);
    this.save();
  },
  async cancelFriendRequest(requestId) {
    const me = this.requireUser();
    this.db.friends = this.db.friends.filter((f) => !(f.id === requestId && f.from === me.id && f.status === 'pending'));
    this.save();
  },
  async removeFriend(userId) {
    const me = this.requireUser();
    this.db.friends = this.db.friends.filter((f) => !((f.from === me.id && f.to === userId) || (f.from === userId && f.to === me.id)));
    for (const s of this.db.shares) if (s.status !== 'ended' && ((s.from === me.id && s.to === userId) || (s.from === userId && s.to === me.id))) this._endShare(s, 'unfriended');
    this.save();
  },
  async blockUser(userId) {
    const me = this.requireUser();
    if (!this.db.blocks.some((b) => b.by === me.id && b.target === userId)) this.db.blocks.push({ by: me.id, target: userId, at: iso() });
    // A block immediately ends sharing in BOTH directions and removes the friendship + pending requests.
    for (const s of this.db.shares) if (s.status !== 'ended' && ((s.from === me.id && s.to === userId) || (s.from === userId && s.to === me.id))) this._endShare(s, 'blocked');
    this.db.friends = this.db.friends.filter((f) => !((f.from === me.id && f.to === userId) || (f.from === userId && f.to === me.id)));
    this.save();
  },
  async unblockUser(userId) {
    const me = this.requireUser();
    this.db.blocks = this.db.blocks.filter((b) => !(b.by === me.id && b.target === userId));
    this.save();
  },
  async reportUser(userId, reason) {
    const me = this.requireUser();
    this.db.reports.push({ id: 'rp-' + uid(), by: me.id, target: userId, reason: (reason || '').slice(0, 300), at: iso() });
    this.save();
  },
  async listSocial() {
    this._ensureSocial(); this._expireShares();
    const me = this.requireUser();
    const meRow = this.db.users.find((x) => x.id === me.id);
    const friends = this.db.friends.filter((f) => f.status === 'accepted' && (f.from === me.id || f.to === me.id)).map((f) => this._publicPeer(f.from === me.id ? f.to : f.from));
    const incoming = this.db.friends.filter((f) => f.status === 'pending' && f.to === me.id).map((f) => ({ id: f.id, from: this._publicPeer(f.from), createdAt: f.createdAt }));
    const outgoing = this.db.friends.filter((f) => f.status === 'pending' && f.from === me.id).map((f) => ({ id: f.id, to: this._publicPeer(f.to), createdAt: f.createdAt }));
    const blocked = this.db.blocks.filter((b) => b.by === me.id).map((b) => this._publicPeer(b.target));
    return { gwId: meRow.gwId, requestSetting: meRow.requestSetting, friends, incoming, outgoing, blocked };
  },

  // ---------- sharing sessions ----------
  _startShare({ to, minutes, type, trip }) {
    this._ensureSocial(); this._expireShares();
    const me = this.requireUser();
    if (!this._friendship(me.id, to)) throw new BackendError('forbidden', 'You can only share with an accepted friend.');
    if (this._blockedEither(me.id, to)) throw new BackendError('forbidden', 'Sharing is not available with this user.');
    minutes = Math.min(SHARE_MAX_MINUTES, Math.max(5, Math.round(minutes || 0)));
    if (type === 'location' && !SHARE_DURATIONS.some((d) => d.minutes === minutes)) throw new BackendError('invalid', 'Pick one of the offered durations.');
    // one active outgoing session per friend per type
    for (const s of this.db.shares) if (s.status !== 'ended' && s.from === me.id && s.to === to && s.type === type) this._endShare(s, 'replaced');
    const s = { id: 'sh-' + uid(), from: me.id, to, type, startedAt: iso(), endsAt: new Date(now() + minutes * 60000).toISOString(), status: 'active', trip };
    this.db.shares.push(s); this.save(); return this._shareView(s, me.id);
  },
  async startLocationShare(friendUserId, minutes) { return this._startShare({ to: friendUserId, minutes, type: 'location' }); },
  async startTripShare(friendUserId, { destName, destLat, destLng, geometry, routeDistanceM, durationS, rewardOptIn }) {
    if (!Array.isArray(geometry) || geometry.length < 2) throw new BackendError('invalid', 'No route to share.');
    const minutes = Math.min(SHARE_MAX_MINUTES, Math.ceil((durationS / 60) * 2) + 15); // session = 2× ETA + 15 min, capped
    const me = this.currentUser();
    const trip = { destName, destLat, destLng, geometry, routeDistanceM, durationS, progressM: 0, arrived: false, rewardOptIn: rewardOptIn ? { [me.id]: true } : {} };
    const view = this._startShare({ to: friendUserId, minutes, type: 'trip', trip });
    // Demo only: a sample friend opts into shared-trip rewards after a moment, so the bonus flow can be seen.
    const target = this.db.users.find((u) => u.id === friendUserId);
    if (target?.sample && rewardOptIn) setTimeout(() => { const live = this.db.shares.find((x) => x.id === view.id); if (live && live.status !== 'ended') { live.trip.rewardOptIn[target.id] = true; this.save(); } }, 3000);
    return view;
  },
  _ownShare(id) {
    const me = this.requireUser();
    const s = this.db.shares.find((x) => x.id === id);
    if (!s || s.from !== me.id) throw new BackendError('forbidden', 'Not your sharing session.');
    return s;
  },
  async pauseShare(id) { const s = this._ownShare(id); if (s.status === 'active') { s.status = 'paused'; delete s.lastPos; } this.save(); },
  async resumeShare(id) { const s = this._ownShare(id); if (s.status === 'paused' && new Date(s.endsAt) > now()) s.status = 'active'; this.save(); },
  async stopShare(id, reason = 'stopped') { const s = this._ownShare(id); if (s.status !== 'ended') this._endShare(s, reason); this.save(); },
  /** Traveller pushes a position. Stored as the single latest sample only. */
  async updateSharePosition(id, { lat, lng }) {
    this._expireShares();
    const s = this._ownShare(id);
    if (s.status !== 'active') return;
    s.lastPos = { lat: +lat.toFixed(5), lng: +lng.toFixed(5), at: iso() };
    if (s.trip && s.trip.geometry) {
      // progress = route length − remaining from nearest vertex; monotonic, capped at route length (no detour credit)
      const g = s.trip.geometry; let bestI = 0, bestD = Infinity;
      g.forEach((p, i) => { const d = haversine([lat, lng], p); if (d < bestD) { bestD = d; bestI = i; } });
      if (bestD < 60) {
        let rem = 0; for (let i = bestI; i < g.length - 1; i++) rem += haversine(g[i], g[i + 1]);
        s.trip.progressM = Math.max(s.trip.progressM, Math.min(s.trip.routeDistanceM, s.trip.routeDistanceM - rem));
      }
    }
    this.save();
  },
  /** Recipient opts into shared-trip rewards for an incoming trip share. Separate from any location sharing. */
  async optInTripReward(id) {
    const me = this.requireUser();
    const s = this.db.shares.find((x) => x.id === id && x.type === 'trip' && x.status !== 'ended');
    if (!s || (s.to !== me.id && s.from !== me.id)) throw new BackendError('forbidden', 'Session not found.');
    s.trip.rewardOptIn[me.id] = true; this.save();
  },
  _shareView(s, viewerId) {
    const isOwner = s.from === viewerId;
    const v = {
      id: s.id, type: s.type, status: s.status, startedAt: s.startedAt, endsAt: s.endsAt, endedReason: s.endedReason, endedAt: s.endedAt,
      from: this._publicPeer(s.from), to: this._publicPeer(s.to), direction: isOwner ? 'outgoing' : 'incoming',
    };
    if (s.trip) v.trip = { destName: s.trip.destName, destLat: s.trip.destLat, destLng: s.trip.destLng, routeDistanceM: s.trip.routeDistanceM, durationS: s.trip.durationS, progressM: s.trip.progressM, arrived: s.trip.arrived, geometry: s.trip.geometry, rewardOptIn: s.trip.rewardOptIn, bonusPoints: s.trip.bonusPoints };
    // ACCESS CHECK: the position is only ever returned to the recipient (and owner for their own banner).
    if (s.lastPos && (s.to === viewerId || isOwner)) v.lastPos = s.lastPos;
    return v;
  },
  async listShares() {
    this._ensureSocial(); this._expireShares();
    const me = this.requireUser();
    const mine = this.db.shares.filter((s) => (s.from === me.id || s.to === me.id) && (s.status !== 'ended' || (s.endedAt && now() - new Date(s.endedAt) < 6 * 3600000)));
    return mine.map((s) => this._shareView(s, me.id)).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  },

  // ---------- trip completion & rewards (verified here; replay-safe) ----------
  /**
   * Voluntary arrival check-in. Works with or without a share.
   * @param {object} p  { shareId?, routeDistanceM, destLat, destLng, position?: {lat,lng}, progressM? }
   */
  async tripCheckIn(p) {
    this._ensureSocial(); this._expireShares();
    const me = this.requireUser();
    const result = { basePoints: 0, bonusPoints: 0, eligibleM: 0, reasons: [] };
    let share = null;
    if (p.shareId) {
      share = this.db.shares.find((s) => s.id === p.shareId && s.from === me.id);
      if (!share) throw new BackendError('forbidden', 'Trip session not found.');
      if (share.trip?.arrived) throw new BackendError('dupe', 'This trip was already checked in.');
    }
    if (p.position && haversine([p.position.lat, p.position.lng], [p.destLat, p.destLng]) > TRIP_LIMITS.arrivalRadiusM) {
      result.reasons.push('You are not at the destination yet, so no points were awarded.');
    } else {
      const todays = this.db.trips.filter((t) => t.userId === me.id && t.at.slice(0, 10) === today());
      const routeM = Math.max(0, +p.routeDistanceM || 0);
      if (routeM < TRIP_LIMITS.minTripMetres) result.reasons.push('Trips under 200 m do not earn points.');
      else if (todays.length >= TRIP_LIMITS.checkInsPerDay) result.reasons.push('Daily check-in limit reached.');
      else {
        const tripId = 'tr-' + uid();
        this.grant(me.id, 'trip_completed', 'trip', tripId);
        result.basePoints = POINTS.trip_completed;
        // Shared-trip bonus: both parties opted in, eligible distance = backend-tracked progress (fallback: route distance)
        let bonusM = 0, bonus = 0;
        if (share?.trip) {
          const opt = share.trip.rewardOptIn || {};
          if (opt[share.from] && opt[share.to]) {
            bonusM = share.trip.progressM > 0 ? Math.min(share.trip.progressM, routeM) : routeM;
            bonus = sharedTripBonusFor(bonusM);
            const spent = todays.reduce((n, t) => n + (t.bonusPoints || 0), 0);
            bonus = Math.max(0, Math.min(bonus, SHARED_TRIP_BONUS.dailyCap - spent));
            if (bonus > 0) {
              const u = this.db.users.find((x) => x.id === me.id);
              u.points += bonus;
              this.db.points.push({ id: 'pe-' + uid(), userId: me.id, rule: 'shared_trip_bonus', points: bonus, refType: 'trip', refId: tripId, at: iso() });
              // the friend who followed and opted in gets the same bonus (dedupe by share id)
              if (!this.db.points.some((e) => e.userId === share.to && e.refId === share.id)) {
                const f = this.db.users.find((x) => x.id === share.to);
                if (f) { f.points += bonus; this.db.points.push({ id: 'pe-' + uid(), userId: share.to, rule: 'shared_trip_bonus', points: bonus, refType: 'share', refId: share.id, at: iso() }); }
              }
            } else if (spent >= SHARED_TRIP_BONUS.dailyCap) result.reasons.push('Daily shared-trip bonus cap reached.');
          } else result.reasons.push('No shared-trip bonus: both of you need to opt in before arrival.');
        }
        result.bonusPoints = bonus; result.eligibleM = bonusM;
        this.db.trips.push({ id: tripId, userId: me.id, shareId: share?.id, distanceM: Math.round(routeM), bonusM: Math.round(bonusM), bonusPoints: bonus, at: iso() });
      }
    }
    if (share) { share.trip.arrived = true; share.trip.bonusPoints = result.bonusPoints; this._endShare(share, 'arrived'); }
    this.save();
    return result;
  },
  /**
   * DEMO ONLY — simulates a sample friend sharing a trip with you so the viewer screens can be explored.
   * The moving position is scripted, not a real person. Clearly labelled "Sample" in the UI.
   */
  async demoSimulateIncomingTrip(friendUserId) {
    this._ensureSocial();
    const me = this.requireUser();
    const friend = this.db.users.find((u) => u.id === friendUserId && u.sample);
    if (!friend || !this._friendship(me.id, friend.id)) throw new BackendError('forbidden', 'Only available for sample friends.');
    const r = SAMPLE_ROUTES[0].routes[0];
    const geometry = r.geometry.map(([a, b]) => [a, b]);
    let dist = 0; for (let i = 1; i < geometry.length; i++) dist += haversine(geometry[i - 1], geometry[i]);
    for (const s of this.db.shares) if (s.status !== 'ended' && s.from === friend.id && s.to === me.id) this._endShare(s, 'replaced');
    const share = { id: 'sh-' + uid(), from: friend.id, to: me.id, type: 'trip', startedAt: iso(), endsAt: new Date(now() + 20 * 60000).toISOString(), status: 'active', sample: true,
      trip: { destName: 'Coventry Cathedral', destLat: geometry.at(-1)[0], destLng: geometry.at(-1)[1], geometry, routeDistanceM: dist, durationS: dist / 1.35, progressM: 0, arrived: false, rewardOptIn: { [friend.id]: true } } };
    this.db.shares.push(share);
    let i = 0;
    const tick = () => {
      const live = this.db.shares.find((s) => s.id === share.id);
      if (!live || live.status === 'ended') return;
      if (i >= geometry.length) {
        live.trip.arrived = true; live.trip.progressM = dist; this._endShare(live, 'arrived'); this.save(); return;
      }
      const [lat, lng] = geometry[i++];
      live.lastPos = { lat, lng, at: iso() };
      let rem = 0; for (let k = i - 1; k < geometry.length - 1; k++) rem += haversine(geometry[k], geometry[k + 1]);
      live.trip.progressM = dist - rem;
      this.save();
      setTimeout(tick, 4000);
    };
    tick();
    return this._shareView(share, me.id);
  },
  /** Admin/debug: nothing here exposes locations. */
  listReports() { this.requireAdmin(); return this.db.reports.map((r) => ({ ...r, by: this.aliasOf(r.by), target: this.aliasOf(r.target) })); },
};
