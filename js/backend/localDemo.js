// LocalDemoBackend — implements the Backend interface (see index.js) on top of localStorage.
// DEMO ONLY: data lives on this device. Accounts use a hashed 4-digit PIN purely so the sign-in flow
// is realistic; this is not a security boundary. Replace with a real auth + database adapter for production.

import { BackendError, haversine, uid, lineLength } from '../util.js';
import { buildSeed, SEED_VERSION } from './seed.js';
import { ALERT_CATEGORIES, POINTS, RATE_LIMITS, levelFor, CONFIRMATIONS_TO_AUTO_FLAG } from './rules.js';
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
    const user = { id: 'u-' + uid(), alias, role: 'user', points: 0, leaderboardOptIn: false, createdAt: new Date().toISOString(), pinHash: await hashPin(pin), gwId: makeGwId(), requestSetting: 'anyone' };
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
    const allowed = ['leaderboardOptIn'];
    for (const k of allowed) if (k in patch) u[k] = patch[k];
    this.save();
    return this.publicUser(u);
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
    a.confirmations.push(user.id);
    if (a.confirmations.length === CONFIRMATIONS_TO_AUTO_FLAG) this.grant(a.createdBy, 'alert_confirmed', 'alert', a.id);
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
        this.grant(a.createdBy, 'alert_verified', 'alert', a.id);
        for (const uid_ of a.confirmations) this.grant(uid_, 'confirm_helpful', 'alert', a.id);
      }
    } else if (decision === 'reject') a.status = 'rejected';
    else if (decision === 'resolve') a.status = 'resolved';
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
      if (p.status !== 'approved') this.grant(p.createdBy, 'path_approved', 'path', p.id);
      p.status = 'approved';
    } else if (decision === 'reject') p.status = 'rejected';
    else if (decision === 'changes') p.status = 'changes';
    p.reviewedAt = new Date().toISOString();
    p.reviewMessage = (message || '').trim().slice(0, 300);
    this.save();
    return p;
  }

  // ---------- points ----------
  grant(userId, rule, refType, refId) {
    const u = this.db.users.find((x) => x.id === userId);
    if (!u) return;
    if (this.db.points.some((e) => e.userId === userId && e.rule === rule && e.refId === refId)) return; // never double-grant
    const pts = POINTS[rule] || 0;
    u.points += pts;
    this.db.points.push({ id: 'pe-' + uid(), userId, rule, points: pts, refType, refId, at: new Date().toISOString() });
  }
  async pointHistory(userId) {
    return this.db.points.filter((e) => e.userId === userId).sort((a, b) => new Date(b.at) - new Date(a.at));
  }
  async leaderboard() {
    const me = this.currentUser();
    return this.db.users
      .filter((u) => u.leaderboardOptIn && u.role !== 'admin')
      .sort((a, b) => b.points - a.points)
      .slice(0, 25)
      .map((u) => ({ alias: u.alias, points: u.points, level: levelFor(u.points).level.name, isMe: me?.id === u.id, sample: !!u.sample }));
  }
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
}
Object.assign(LocalDemoBackend.prototype, socialMethods);
