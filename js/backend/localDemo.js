// LocalDemoBackend — implements the Backend interface (see index.js) on top of localStorage.
// DEMO ONLY: data lives on this device. Accounts use a hashed 4-digit PIN purely so the sign-in flow
// is realistic; this is not a security boundary. Replace with a real auth + database adapter for production.

import { BackendError, haversine, uid, lineLength } from '../util.js';
import { buildSeed, SEED_VERSION } from './seed.js';
import { ALERT_CATEGORIES, RATE_LIMITS, CONFIRMATIONS_TO_AUTO_FLAG } from './rules.js';
import { pointsMethods, ALERT_AWARD_RULE } from './demoPoints.js';
import { STREET_CONFIRMATIONS_TO_AWARD } from './pointsPolicy.js';
import { socialMethods, makeGwId } from './social.js';

const KEY = 'ghetto-wayz:demo-db:v2';

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gw:' + pin));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const today = () => new Date().toISOString().slice(0, 10);
const sameDay = (iso) => iso.slice(0, 10) === today();

export class LocalDemoBackend {
  constructor() {
    this.kind = 'local';
    this.isShared = false;
    this.listeners = new Set();
    this.db = this.load();
    // Demo realtime: other tabs in this browser write the same key; pick up their changes.
    window.addEventListener('storage', (e) => { if (e.key === KEY && e.newValue) { try { this.db = JSON.parse(e.newValue); for (const cb of this.listeners) cb(); } catch { /* ignore */ } } });
  }

  // ---------- persistence ----------
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const db = JSON.parse(raw);
        if (db.version === SEED_VERSION) return db;
      }
    } catch { /* ignore corrupt storage */ }
    const seed = buildSeed();
    try { localStorage.setItem(KEY, JSON.stringify(seed)); } catch { /* storage may be unavailable */ }
    return seed;
  }
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch { /* ignore */ }
    for (const cb of this.listeners) cb();
  }
  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  resetDemo() { localStorage.removeItem(KEY); this.db = this.load(); this.save(); }

  // ---------- auth ----------
  publicUser(u) {
    if (!u) return null;
    const { pinHash, ...pub } = u;
    return pub;
  }
  currentUser() {
    const u = this.db.users.find((x) => x.id === this.db.session);
    return this.publicUser(u);
  }
  requireUser() {
    const u = this.currentUser();
    if (!u) throw new BackendError('auth', 'Sign in to do this.');
    return u;
  }
  requireAdmin() {
    const u = this.requireUser();
    if (u.role !== 'admin') throw new BackendError('forbidden', 'Moderators only.');
    return u;
  }
  async register({ alias, pin }) {
    alias = (alias || '').trim();
    if (!/^[a-z0-9_.-]{3,20}$/i.test(alias)) throw new BackendError('invalid', 'Alias must be 3–20 letters, numbers, _ . or -');
    if (!/^\d{4}$/.test(pin)) throw new BackendError('invalid', 'PIN must be 4 digits.');
    if (this.db.users.some((u) => u.alias.toLowerCase() === alias.toLowerCase())) throw new BackendError('taken', 'That alias is taken.');
    const user = { id: 'u-' + uid(), alias, role: 'user', points: 0, levelFloor: 1, leaderboardOptIn: false, friendsBoardOptIn: false, tripPoints: true, createdAt: new Date().toISOString(), pinHash: await hashPin(pin), gwId: makeGwId(), requestSetting: 'anyone' };
    this.db.users.push(user);
    this.db.session = user.id;
    this.save();
    return this.publicUser(user);
  }
  async signIn({ alias, pin }) {
    const user = this.db.users.find((u) => u.alias.toLowerCase() === (alias || '').trim().toLowerCase());
    if (!user || !user.pinHash) throw new BackendError('auth', 'No account with that alias.');
    if (user.pinHash !== (await hashPin(pin))) throw new BackendError('auth', 'Wrong PIN.');
    this.db.session = user.id;
    this.save();
    return this.publicUser(user);
  }
  async signInDemoModerator() {
    this.db.session = 'u-demo-mod';
    this.save();
    return this.currentUser();
  }
  async signOut() {
    // Signing out ends anything this user was sharing.
    const me = this.db.session;
    for (const s of this.db.shares || []) if (s.from === me && s.status !== 'ended') this._endShare(s, 'stopped');
    this.db.session = null; this.save();
  }
  async updateUser(patch) {
    const u = this.db.users.find((x) => x.id === this.requireUser().id);
    return this.setPointsPrefs({ leaderboardOptIn: patch.leaderboardOptIn, friendsBoardOptIn: patch.friendsBoardOptIn, tripPoints: patch.tripPoints });
  }

  // ---------- alerts ----------
  async listAlerts({ includeExpired = false } = {}) {
    const now = Date.now();
    return this.db.alerts
      .filter((a) => a.status !== 'rejected' && a.status !== 'resolved')
      .filter((a) => includeExpired || new Date(a.expiresAt).getTime() > now)
      .map((a) => ({ ...a, communityConfirmed: a.confirmations.length >= CONFIRMATIONS_TO_AUTO_FLAG }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  async createAlert({ lat, lng, category, note }) {
    const user = this.requireUser();
    if (!ALERT_CATEGORIES[category]) throw new BackendError('invalid', 'Pick a category.');
    note = (note || '').trim().slice(0, 240);
    const mine = this.db.alerts.filter((a) => a.createdBy === user.id);
    if (mine.filter((a) => sameDay(a.createdAt)).length >= RATE_LIMITS.alertsPerDay)
      throw new BackendError('rate', `Limit reached: ${RATE_LIMITS.alertsPerDay} reports per day. Quality beats volume.`);
    if (mine.some((a) => a.status === 'pending' && a.category === category && haversine([lat, lng], [a.lat, a.lng]) < RATE_LIMITS.minMetresBetweenOwnAlerts))
      throw new BackendError('dupe', 'You already have a pending report at this spot.');
    const alert = {
      id: 'a-' + uid(), category, lat: +lat.toFixed(5), lng: +lng.toFixed(5), note, status: 'pending',
      createdBy: user.id, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ALERT_CATEGORIES[category].expiryDays * 86400000).toISOString(),
      confirmations: [],
    };
    this.db.alerts.push(alert);
    this.save();
    return alert;
  }
  async confirmAlert(id) {
    const user = this.requireUser();
    const a = this.db.alerts.find((x) => x.id === id);
    if (!a) throw new BackendError('missing', 'Alert not found.');
    if (a.createdBy === user.id) throw new BackendError('own', "You can't confirm your own report.");
    if (a.confirmations.includes(user.id)) throw new BackendError('dupe', 'Already confirmed.');
    const todays = this.db.alerts.reduce((n, x) => n + (x.confirmations.includes(user.id) && sameDay(x.createdAt) ? 1 : 0), 0);
    if (todays >= RATE_LIMITS.confirmationsPerDay) throw new BackendError('rate', 'Confirmation limit reached for today.');
    a.confirmations.push(user.id); // no points for confirming on its own — only if the report is verified
    // Street lighting reports pay out once enough other people confirm them (same rule as confirm_alert in SQL).
    if (ALERT_CATEGORIES[a.category]?.street && a.confirmations.length >= STREET_CONFIRMATIONS_TO_AWARD) {
      this.award(a.createdBy, ALERT_AWARD_RULE(a.category), 'alert', a.id);
      for (const uid_ of a.confirmations) this.award(uid_, 'confirm_helpful', 'alert', a.id);
      this._ensurePoints();
    }
    this.save();
    return a;
  }
  async reviewAlert(id, decision) {
    this.requireAdmin();
    const a = this.db.alerts.find((x) => x.id === id);
    if (!a) throw new BackendError('missing', 'Alert not found.');
    if (decision === 'verify') {
      if (a.status !== 'verified') {
        a.status = 'verified';
        a.reviewedAt = new Date().toISOString();
        this.award(a.createdBy, ALERT_AWARD_RULE(a.category), 'alert', a.id);
        for (const uid_ of a.confirmations) this.award(uid_, 'confirm_helpful', 'alert', a.id);
      }
    } else if (decision === 'reject') a.status = 'rejected';
    else if (decision === 'resolve') a.status = 'resolved';
    this._ensurePoints(); this._logAdmin('alert_' + decision, a.createdBy, 'alert:' + a.id);
    this.save();
    return a;
  }

  // ---------- paths ----------
  async listPaths({ status } = {}) {
    return this.db.paths
      .filter((p) => !status || p.status === status)
      .map((p) => ({ ...p, lengthM: lineLength(p.points) }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  async suggestPath({ name, type, surface, note, points }) {
    const user = this.requireUser();
    name = (name || '').trim().slice(0, 60);
    if (name.length < 3) throw new BackendError('invalid', 'Give the path a short name.');
    if (!Array.isArray(points) || points.length < 2) throw new BackendError('invalid', 'Draw at least two points.');
    const len = lineLength(points);
    if (len < 10) throw new BackendError('invalid', 'That path is too short to review.');
    if (len > 3000) throw new BackendError('invalid', 'Keep suggestions under 3 km — split long paths.');
    const todays = this.db.paths.filter((p) => p.createdBy === user.id && sameDay(p.createdAt)).length;
    if (todays >= RATE_LIMITS.pathSuggestionsPerDay) throw new BackendError('rate', `Limit reached: ${RATE_LIMITS.pathSuggestionsPerDay} path suggestions per day.`);
    const path = {
      id: 'path-' + uid(), name, type, surface, note: (note || '').trim().slice(0, 300),
      points: points.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]),
      status: 'pending', createdBy: user.id, createdAt: new Date().toISOString(),
    };
    this.db.paths.push(path);
    this.save();
    return path;
  }
  async reviewPath(id, decision, message = '') {
    this.requireAdmin();
    const p = this.db.paths.find((x) => x.id === id);
    if (!p) throw new BackendError('missing', 'Path not found.');
    if (decision === 'approve') {
      if (p.status !== 'approved') this.award(p.createdBy, 'path_approved', 'path', p.id);
      p.status = 'approved';
    } else if (decision === 'reject') p.status = 'rejected';
    else if (decision === 'changes') p.status = 'changes';
    p.reviewedAt = new Date().toISOString();
    p.reviewMessage = (message || '').trim().slice(0, 300);
    this._ensurePoints(); this._logAdmin('path_' + decision, p.createdBy, 'path:' + p.id, message);
    this.save();
    return p;
  }

  // ---------- points: see demoPoints.js ----------
  async myStats() {
    const me = this.currentUser();
    if (!me) return null;
    return {
      alertsToday: this.db.alerts.filter((a) => a.createdBy === me.id && sameDay(a.createdAt)).length,
      pathsToday: this.db.paths.filter((p) => p.createdBy === me.id && sameDay(p.createdAt)).length,
      alerts: this.db.alerts.filter((a) => a.createdBy === me.id).length,
      paths: this.db.paths.filter((p) => p.createdBy === me.id).length,
    };
  }
  aliasOf(userId) { return this.db.users.find((u) => u.id === userId)?.alias || 'member'; }

  // ---------- place reviews (demo). Same rules as supabase/migration-008-place-reviews.sql. Never award points. ----------
  _reviews() { this.db.reviews ||= []; this.db.reviewReports ||= []; return this.db.reviews; }
  _reviewView(r, me) {
    const own = r.userId === me?.id, admin = me?.role === 'admin';
    return { id: r.id, userId: r.userId, alias: this.aliasOf(r.userId), rating: r.rating, body: r.body, createdAt: r.createdAt, updatedAt: r.updatedAt, hidden: r.hidden,
      hiddenReason: own || admin ? r.hiddenReason : null, reportCount: own || admin ? r.reportCount : 0,
      reportedByMe: !!me && this.db.reviewReports.some((x) => x.reviewId === r.id && x.by === me.id), mine: own };
  }
  async listPlaceReviews(placeKey) {
    const me = this.currentUser();
    return this._reviews().filter((r) => r.placeKey === placeKey && (!r.hidden || r.userId === me?.id || me?.role === 'admin'))
      .sort((a, b) => (b.userId === me?.id) - (a.userId === me?.id) || b.updatedAt.localeCompare(a.updatedAt)).map((r) => this._reviewView(r, me));
  }
  async placeReviewSummary(keys) {
    const out = {};
    for (const k of keys) {
      const rs = this._reviews().filter((r) => r.placeKey === k && !r.hidden);
      if (rs.length) out[k] = { avg: Math.round((rs.reduce((n, r) => n + r.rating, 0) / rs.length) * 10) / 10, count: rs.length };
    }
    return out;
  }
  async writePlaceReview({ placeKey, placeName, lat, lng, rating, body }) {
    const me = this.requireUser();
    if (!/^(node|way|relation)\/\d{1,16}$/.test(placeKey)) throw new BackendError('invalid', 'Unknown place.');
    rating = Number(rating);
    if (!(rating >= 1 && rating <= 5)) throw new BackendError('invalid', 'Choose a star rating from 1 to 5.');
    body = (body || '').trim().slice(0, 500);
    const list = this._reviews();
    let r = list.find((x) => x.placeKey === placeKey && x.userId === me.id);
    const now = new Date().toISOString();
    if (!r) {
      if (list.filter((x) => x.userId === me.id && sameDay(x.createdAt)).length >= 5) throw new BackendError('limit', 'You have written 5 reviews today — more tomorrow.');
      r = { id: 'rv-' + uid(), placeKey, placeName: (placeName || '').slice(0, 120), lat, lng, userId: me.id, rating, body, createdAt: now, updatedAt: now, hidden: false, hiddenReason: null, reportCount: 0 };
      list.push(r);
    } else {
      Object.assign(r, { rating, body, placeName: (placeName || r.placeName).slice(0, 120), updatedAt: now });
      if (r.hiddenReason?.startsWith('reports:')) { r.hidden = false; r.hiddenReason = null; r.reportCount = 0; this.db.reviewReports = this.db.reviewReports.filter((x) => x.reviewId !== r.id); }
    }
    this.save();
    return this._reviewView(r, me);
  }
  async deleteMyReview(id) {
    const me = this.requireUser();
    this.db.reviews = this._reviews().filter((r) => !(r.id === id && r.userId === me.id));
    this.db.reviewReports = this.db.reviewReports.filter((x) => x.reviewId !== id);
    this.save();
  }
  async reportReview(id, reason) {
    const me = this.requireUser();
    const r = this._reviews().find((x) => x.id === id);
    if (!r) throw new BackendError('missing', 'That review no longer exists.');
    if (r.userId === me.id) throw new BackendError('invalid', 'You cannot report your own review.');
    if (!this.db.reviewReports.some((x) => x.reviewId === id && x.by === me.id)) this.db.reviewReports.push({ reviewId: id, by: me.id, reason: (reason || '').trim().slice(0, 300), at: new Date().toISOString() });
    r.reportCount = this.db.reviewReports.filter((x) => x.reviewId === id).length;
    if (r.reportCount >= 3 && !r.hidden) { r.hidden = true; r.hiddenReason = 'reports:' + r.reportCount; }
    this.save();
    return r.reportCount;
  }
  async myPlaceReviews() {
    const me = this.requireUser();
    return this._reviews().filter((r) => r.userId === me.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({ id: r.id, placeKey: r.placeKey, placeName: r.placeName, lat: r.lat, lng: r.lng, rating: r.rating, body: r.body, updatedAt: r.updatedAt, hidden: r.hidden, hiddenReason: r.hiddenReason }));
  }
  async adminHiddenReviews() {
    this.requireAdmin();
    return this._reviews().filter((r) => r.hidden).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({
      id: r.id, placeKey: r.placeKey, placeName: r.placeName, alias: this.aliasOf(r.userId), rating: r.rating, body: r.body, createdAt: r.createdAt, hiddenReason: r.hiddenReason, reportCount: r.reportCount,
      reports: this.db.reviewReports.filter((x) => x.reviewId === r.id).map((x) => ({ alias: this.aliasOf(x.by), reason: x.reason, at: x.at })) }));
  }
  async adminSetReviewHidden(id, hidden, reason = '') {
    const me = this.requireAdmin();
    const r = this._reviews().find((x) => x.id === id);
    if (!r) throw new BackendError('missing', 'That review no longer exists.');
    if (hidden) { r.hidden = true; r.hiddenReason = 'moderator:' + (reason || '').trim().slice(0, 200); r.hiddenBy = me.id; }
    else { r.hidden = false; r.hiddenReason = null; r.hiddenBy = null; r.reportCount = 0; this.db.reviewReports = this.db.reviewReports.filter((x) => x.reviewId !== id); }
    this._ensurePoints?.(); this._logAdmin?.(hidden ? 'hide_review' : 'restore_review', r.userId, 'review:' + id, reason);
    this.save();
  }
}
Object.assign(LocalDemoBackend.prototype, socialMethods, pointsMethods);
