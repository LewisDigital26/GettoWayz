// Social backend methods — friends, blocks, reports, location/trip sharing sessions.
// Mixed into LocalDemoBackend. A real backend must implement the same methods SERVER-SIDE with the
// same access checks: every call is scoped to the signed-in user, and a session's position is only
// ever returned to that session's recipient.
//
// Data (all in the demo db, this device only):
//   friends:  { id, from, to, status: 'pending'|'accepted', createdAt, respondedAt? }
//   blocks:   { by, target, at }
//   reports:  { id, by, target, reason, at }
//   shares:   { id, from, to, type: 'location'|'trip', startedAt, endsAt, status: 'invited'|'active'|'paused'|'ended',
//               live: boolean,                                   // trip shares: traveller's per-trip "send my position" switch
//               endedReason?, lastPos?: { lat, lng, at }        // ONLY the latest position — no history; only while active && live
//               route?: [[lat,lng]...]                          // trip route line — owner always; recipient only after accepting
//               trip?: { destName, destLat, destLng, mode, routeDistanceM, progressM, durationS, arrived, acceptedAt? } }
// Trip shares start as 'invited'. The friend accepts ('active') or declines ('ended', reason 'declined').
// Sharing never earns points. Trip points come from verified trips (demoPoints.js).

import { BackendError, uid, haversine, distanceToLine } from '../util.js';
import { SAMPLE_ROUTES } from '../providers/sampleData.js';
import { FRIEND_LIMITS, SHARE_DURATIONS, SHARE_MAX_MINUTES, TRIP_LIMITS } from './rules.js';

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
    delete s.route;
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
  _startShare({ to, minutes, type, trip, status = 'active', live = true, route }) {
    this._ensureSocial(); this._expireShares();
    const me = this.requireUser();
    if (!this._friendship(me.id, to)) throw new BackendError('forbidden', 'You can only share with an accepted friend.');
    if (this._blockedEither(me.id, to)) throw new BackendError('forbidden', 'Sharing is not available with this user.');
    minutes = Math.min(SHARE_MAX_MINUTES, Math.max(5, Math.round(minutes || 0)));
    if (type === 'location' && !SHARE_DURATIONS.some((d) => d.minutes === minutes)) throw new BackendError('invalid', 'Pick one of the offered durations.');
    // one active outgoing session per friend per type
    for (const s of this.db.shares) if (s.status !== 'ended' && s.from === me.id && s.to === to && s.type === type) this._endShare(s, 'replaced');
    const s = { id: 'sh-' + uid(), from: me.id, to, type, startedAt: iso(), endsAt: new Date(now() + minutes * 60000).toISOString(), status, live, trip, route };
    this.db.shares.push(s); this.save(); return this._shareView(s, me.id);
  },
  async startLocationShare(friendUserId, minutes, extra = null) { return this._startShare({ to: friendUserId, minutes, type: 'location', trip: extra || undefined }); },
  /**
   * Share a planned or active route with ONE accepted friend. It starts as an invitation: the friend sees who,
   * where to, travel mode, distance and time — not the route line or any position — until they accept.
   */
  async startTripShare(friendUserId, { destName, mode, geometry, durationS, live = false, toFriendLocation = false }) {
    const me = this.requireUser();
    if (friendUserId === me.id) throw new BackendError('invalid', 'Choose a friend to share with.');
    if (!Array.isArray(geometry) || geometry.length < 2) throw new BackendError('invalid', 'No route to share.');
    const recent = this.db.shares.filter((x) => x.from === me.id && x.type === 'trip' && now() - new Date(x.startedAt) < 3600000).length;
    if (recent >= 20) throw new BackendError('rate', 'Too many route shares in the last hour — try again later.');
    let routeDistanceM = 0; for (let i = 1; i < geometry.length; i++) routeDistanceM += haversine(geometry[i - 1], geometry[i]); // measured, not trusted
    const dur = Math.max(60, Math.min(6 * 3600, +durationS || routeDistanceM / 1.35));
    const minutes = Math.min(SHARE_MAX_MINUTES, Math.ceil((dur / 60) * 2) + 15); // session = 2× ETA + 15 min, capped
    const dest = geometry[geometry.length - 1];
    const trip = { destName: String(destName || 'Destination').slice(0, 80), destLat: +dest[0].toFixed(5), destLng: +dest[1].toFixed(5),
      mode: ['walk', 'bike', 'scooter', 'drive'].includes(mode) ? mode : 'walk', routeDistanceM: Math.round(routeDistanceM), durationS: Math.round(dur),
      progressM: 0, arrived: false, toFriendLocation: !!toFriendLocation };
    const view = this._startShare({ to: friendUserId, minutes, type: 'trip', trip, status: 'invited', live: !!live, route: geometry.map(([a, b]) => [a, b]) });
    // Demo only: a sample friend accepts the invitation after a moment, so the flow can be seen.
    const target = this.db.users.find((u) => u.id === friendUserId);
    if (target?.sample) setTimeout(() => {
      const x = this.db.shares.find((y) => y.id === view.id);
      if (x && x.status === 'invited') { x.status = 'active'; x.trip.acceptedAt = iso(); this.save(); }
    }, 2500);
    return view;
  },
  /** Recipient accepts or declines a route invitation. */
  async respondTripShare(id, accept) {
    this._ensureSocial(); this._expireShares();
    const me = this.requireUser();
    const s = this.db.shares.find((x) => x.id === id && x.to === me.id && x.type === 'trip');
    if (!s) throw new BackendError('forbidden', 'Invitation not found.');
    if (s.status !== 'invited') throw new BackendError('invalid', `This invitation is no longer open (${s.endedReason || s.status}).`);
    if (!this._friendship(s.from, s.to)) { this._endShare(s, 'unfriended'); this.save(); throw new BackendError('forbidden', 'You are no longer friends, so this invitation has ended.'); }
    if (accept) { s.status = 'active'; s.trip.acceptedAt = iso(); } else this._endShare(s, 'declined');
    s.respondedAt = iso(); this.save();
  },
  /** Traveller turns live progress on/off for this trip only. Off = position deleted and no longer sent. */
  async setTripLive(id, live) {
    this._expireShares();
    const s = this._ownShare(id);
    if (s.type !== 'trip' || !['invited', 'active'].includes(s.status)) throw new BackendError('invalid', 'This route share has ended.');
    s.live = !!live;
    if (!s.live) delete s.lastPos;
    else s.endsAt = new Date(Math.max(new Date(s.endsAt).getTime(), now() + Math.min(SHARE_MAX_MINUTES, Math.ceil((s.trip.durationS / 60) * 2) + 15) * 60000)).toISOString();
    this.save();
  },
  _ownShare(id) {
    const me = this.requireUser();
    const s = this.db.shares.find((x) => x.id === id);
    if (!s || s.from !== me.id) throw new BackendError('forbidden', 'Not your sharing session.');
    return s;
  },
  async pauseShare(id) { const s = this._ownShare(id); if (s.status === 'active' && s.type === 'location') { s.status = 'paused'; delete s.lastPos; } this.save(); },
  async resumeShare(id) { const s = this._ownShare(id); if (s.status === 'paused' && new Date(s.endsAt) > now()) s.status = 'active'; this.save(); },
  /** Traveller stops (any time), or the recipient stops following ('left'). "arrived" is only recorded at the destination. */
  async stopShare(id, reason = 'stopped') {
    const me = this.requireUser();
    const s = this.db.shares.find((x) => x.id === id);
    if (!s || (s.from !== me.id && s.to !== me.id)) throw new BackendError('forbidden', 'Not your sharing session.');
    if (s.status === 'ended') return;
    let r = s.to === me.id ? 'left' : (['stopped', 'cancelled', 'arrived', 'safe'].includes(reason) ? reason : 'stopped');
    if (r === 'safe' && !s.trip?.safety) r = 'stopped'; // only arrival-timer shares check in
    if (r === 'arrived' && !(s.lastPos && s.trip && haversine([s.lastPos.lat, s.lastPos.lng], [s.trip.destLat, s.trip.destLng]) <= TRIP_LIMITS.arrivalRadiusM)) r = 'stopped';
    this._endShare(s, r); this.save();
  },
  /** Traveller pushes a position. Stored as the single latest sample only. */
  async updateSharePosition(id, { lat, lng }) {
    this._expireShares();
    const s = this._ownShare(id);
    if (s.status !== 'active' || s.live === false) return; // never stored for an unaccepted invitation or with live off
    s.lastPos = { lat: +lat.toFixed(5), lng: +lng.toFixed(5), at: iso() };
    const g = s.route || s.trip?.geometry;
    if (s.trip && g) {
      // progress = route length − remaining from nearest vertex; monotonic, capped at route length (no detour credit)
      let bestI = 0, bestD = Infinity;
      g.forEach((p, i) => { const d = haversine([lat, lng], p); if (d < bestD) { bestD = d; bestI = i; } });
      if (bestD < 60) {
        let rem = 0; for (let i = bestI; i < g.length - 1; i++) rem += haversine(g[i], g[i + 1]);
        s.trip.progressM = Math.max(s.trip.progressM, Math.min(s.trip.routeDistanceM, s.trip.routeDistanceM - rem));
      }
    }
    this.save();
  },
  _shareView(s, viewerId) {
    const isOwner = s.from === viewerId;
    const v = {
      id: s.id, type: s.type, status: s.status, live: s.live !== false, startedAt: s.startedAt, endsAt: s.endsAt, endedReason: s.endedReason, endedAt: s.endedAt,
      respondedAt: s.respondedAt, sample: !!s.sample,
      from: this._publicPeer(s.from), to: this._publicPeer(s.to), direction: isOwner ? 'outgoing' : 'incoming',
    };
    if (s.to !== viewerId && !isOwner) return null;
    if (s.trip) v.trip = { safety: s.trip.safety, sos: s.trip.sos, destName: s.trip.destName, destLat: s.trip.destLat, destLng: s.trip.destLng, mode: s.trip.mode || 'walk', routeDistanceM: s.trip.routeDistanceM, durationS: s.trip.durationS, progressM: s.trip.progressM, arrived: s.trip.arrived, acceptedAt: s.trip.acceptedAt, toFriendLocation: s.trip.toFriendLocation };
    // ACCESS CHECK: the route line goes to the owner, and to the recipient only after they accepted.
    const route = s.route || s.trip?.geometry;
    if (v.trip && route && s.status !== 'ended' && (isOwner || s.status === 'active')) v.trip.geometry = route;
    // ACCESS CHECK: the position is only ever returned to the two participants, and only while active and live.
    if (s.lastPos && s.status === 'active' && s.live !== false) v.lastPos = s.lastPos;
    return v;
  },
  async listShares() {
    this._ensureSocial(); this._expireShares();
    const me = this.requireUser();
    const mine = this.db.shares.filter((s) => (s.from === me.id || s.to === me.id) && (s.status !== 'ended' || (s.endedAt && now() - new Date(s.endedAt) < 6 * 3600000)));
    return mine.map((s) => this._shareView(s, me.id)).filter(Boolean).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
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
    const share = { id: 'sh-' + uid(), from: friend.id, to: me.id, type: 'trip', startedAt: iso(), endsAt: new Date(now() + 20 * 60000).toISOString(), status: 'invited', live: true, sample: true, route: geometry,
      trip: { destName: 'Coventry Cathedral', destLat: geometry.at(-1)[0], destLng: geometry.at(-1)[1], mode: 'walk', routeDistanceM: Math.round(dist), durationS: Math.round(dist / 1.35), progressM: 0, arrived: false } };
    this.db.shares.push(share);
    let i = 0;
    const tick = () => {
      const live = this.db.shares.find((s) => s.id === share.id);
      if (!live || live.status === 'ended') return;
      if (live.status === 'invited') { setTimeout(tick, 1500); return; } // scripted movement starts only after you accept
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
