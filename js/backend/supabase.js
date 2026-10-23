// SupabaseBackend — implements the Backend interface (see index.js) against a Supabase project.
// All rules, rate limits, points and access checks live in supabase/schema.sql (RLS + SECURITY DEFINER functions);
// this file is a thin client. Requires supabase-js UMD loaded on the page (window.supabase).
/* global supabase */
import { BackendError } from '../util.js';
import { normalizeGwId } from './social.js';

const wrap = (e) => new BackendError(e.code || 'db', (e.message || 'Request failed').replace(/^.*?:\s*/, ''));

export class SupabaseBackend {
  constructor({ url, anonKey }) {
    if (!window.supabase) throw new Error('supabase-js is not loaded');
    // No cross-tab auth lock: supabase-js's default Web Lock means one stuck tab freezes every other tab
    // on the site. Token refresh races across tabs are harmless for this app (last writer wins).
    this.sb = supabase.createClient(url, anonKey, { auth: { lock: (_name, _timeout, fn) => fn() } });
    this.kind = 'supabase';
    this.isShared = true;
    this.authMode = 'email';
    this.listeners = new Set();
    this.profile = null;
    this.ready = this.sb.auth.getSession().then(({ data }) => this.loadProfile(data.session?.user?.id));
    // Defer: supabase-js holds an internal lock while firing this callback, and awaiting another
    // supabase call inside it deadlocks (documented in the supabase-js auth docs).
    this.sb.auth.onAuthStateChange((_evt, session) => { setTimeout(() => this.loadProfile(session?.user?.id).then(() => this.emit()), 0); });
  }
  emit() { for (const cb of this.listeners) cb(); }
  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  async loadProfile(userId) {
    if (!userId) { this.profile = null; return; }
    const { data } = await this.sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    this.profile = data ? { id: data.id, alias: data.alias, role: data.role, points: data.points, levelFloor: data.level_floor ?? 1, leaderboardOptIn: data.leaderboard_opt_in,
      friendsBoardOptIn: !!data.friends_board_opt_in, tripPoints: data.trip_points !== false, gwId: data.gw_id, requestSetting: data.request_setting, createdAt: data.created_at } : null;
  }
  async rpc(fn, args) {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw wrap(error);
    return data;
  }

  // ---------- auth (email + password; email is never exposed to other users) ----------
  currentUser() { return this.profile; }
  requireUser() { if (!this.profile) throw new BackendError('auth', 'Sign in to do this.'); return this.profile; }
  async register({ alias, email, password }) {
    alias = (alias || '').trim();
    if (!/^[a-z0-9_.-]{3,20}$/i.test(alias)) throw new BackendError('invalid', 'Alias must be 3–20 letters, numbers, _ . or -');
    if (!password || password.length < 8) throw new BackendError('invalid', 'Password must be at least 8 characters.');
    const { data, error } = await this.sb.auth.signUp({ email, password, options: { data: { alias } } });
    if (error) throw wrap(error);
    if (!data.session) throw new BackendError('confirm', 'Check your email to confirm your account, then sign in.');
    await this.loadProfile(data.user.id); this.emit();
    return this.profile;
  }
  async signIn({ email, password }) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw wrap(error);
    await this.loadProfile(data.user.id); this.emit();
    return this.profile;
  }
  async signOut() {
    for (const s of await this.listShares().catch(() => [])) if (s.direction === 'outgoing' && s.status !== 'ended') await this.stopShare(s.id).catch(() => {});
    await this.sb.auth.signOut(); this.profile = null; this.emit();
  }
  async updateUser(patch) { return this.setPointsPrefs(patch); }
  async setPointsPrefs({ leaderboardOptIn, friendsBoardOptIn, tripPoints } = {}) {
    await this.rpc('set_points_prefs', { p_public: leaderboardOptIn ?? null, p_friends: friendsBoardOptIn ?? null, p_trip_points: tripPoints ?? null });
    await this.loadProfile(this.requireUser().id); this.emit(); return this.profile;
  }

  // ---------- alerts ----------
  rowToAlert(a, confs) {
    const confirmations = confs.filter((c) => c.alert_id === a.id).map((c) => c.user_id);
    return { id: a.id, category: a.category, lat: a.lat, lng: a.lng, note: a.note, status: a.status, createdBy: a.created_by, createdAt: a.created_at, expiresAt: a.expires_at, confirmations, communityConfirmed: confirmations.length >= 2 };
  }
  async listAlerts() {
    const [{ data: alerts, error }, { data: confs }] = await Promise.all([this.sb.from('alerts').select('*').order('created_at', { ascending: false }), this.sb.from('alert_confirmations').select('alert_id,user_id')]);
    if (error) throw wrap(error);
    return (alerts || []).filter((a) => a.status === 'pending' || a.status === 'verified').map((a) => this.rowToAlert(a, confs || []));
  }
  async createAlert({ lat, lng, category, note }) { const a = await this.rpc('create_alert', { p_category: category, p_lat: lat, p_lng: lng, p_note: note }); this.emit(); return this.rowToAlert(a, []); }
  async confirmAlert(id) { await this.rpc('confirm_alert', { p_alert: id }); this.emit(); }
  async reviewAlert(id, decision) { await this.rpc('review_alert', { p_alert: id, p_decision: decision }); await this.loadProfile(this.profile?.id); this.emit(); }

  // ---------- paths ----------
  rowToPath(p) { return { id: p.id, name: p.name, type: p.type, surface: p.surface, note: p.note, points: p.points, status: p.status, createdBy: p.created_by, createdAt: p.created_at, reviewedAt: p.reviewed_at, reviewMessage: p.review_message }; }
  async listPaths({ status } = {}) {
    let q = this.sb.from('paths').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q; if (error) throw wrap(error);
    return (data || []).map((p) => this.rowToPath(p));
  }
  async suggestPath({ name, type, surface, note, points }) { const p = await this.rpc('suggest_path', { p_name: name, p_type: type, p_surface: surface, p_note: note, p_points: points.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]) }); this.emit(); return this.rowToPath(p); }
  async reviewPath(id, decision, message = '') { await this.rpc('review_path', { p_path: id, p_decision: decision, p_message: message }); this.emit(); }

  // ---------- points (all awards are calculated server-side; see migration-004-points.sql) ----------
  rowToEntry(e) { return { id: e.id, userId: e.user_id, rule: e.rule, points: e.points, refType: e.ref_type, refId: e.ref_id, at: e.at, status: e.status || 'awarded', reason: e.reason, reversalOf: e.reversal_of, pointsRequested: e.points_requested }; }
  async pointHistory() { return (await this.myLedger({ limit: 50 })).entries; }
  async myLedger({ offset = 0, limit = 20 } = {}) {
    const me = this.requireUser();
    const o = Math.max(0, Math.min(500, offset | 0)), l = Math.max(1, Math.min(50, limit | 0));
    const { data, error, count } = await this.sb.from('point_entries').select('*', { count: 'exact' }).eq('user_id', me.id).order('at', { ascending: false }).range(o, o + l - 1);
    if (error) throw wrap(error);
    return { entries: (data || []).map((e) => this.rowToEntry(e)), total: count ?? (data || []).length };
  }
  async myPointsSummary() {
    const me = this.requireUser();
    await this.loadProfile(me.id);
    const { weekStart } = await import('./pointsPolicy.js');
    const { data } = await this.sb.from('point_entries').select('points').eq('user_id', me.id).eq('status', 'awarded').gte('at', weekStart().toISOString());
    const p = this.profile;
    return { points: p.points, levelFloor: p.levelFloor, week: (data || []).reduce((n, e) => n + e.points, 0), leaderboardOptIn: p.leaderboardOptIn, friendsBoardOptIn: p.friendsBoardOptIn, tripPoints: p.tripPoints };
  }
  async myContributions() { return (await this.rpc('my_contributions', { p_limit: 30 })) || []; }
  async myTrips() {
    const me = this.requireUser();
    const { data, error } = await this.sb.from('trip_sessions').select('id,mode,status,started_at,eligible_m,base_points,distance_points,reasons').eq('user_id', me.id).neq('status', 'active').order('started_at', { ascending: false }).limit(20);
    if (error) throw wrap(error);
    return (data || []).map((t) => ({ id: t.id, mode: t.mode, status: t.status, startedAt: t.started_at, eligibleM: t.eligible_m, basePoints: t.base_points, distancePoints: t.distance_points, reasons: t.reasons || [] }));
  }
  async pointsPolicy() {
    const [{ data: rules }, { data: settings }] = await Promise.all([this.sb.from('point_rules').select('*'), this.sb.from('points_settings').select('*').eq('id', 1).maybeSingle()]);
    const local = await import('./pointsPolicy.js');
    if (!rules?.length || !settings) return { rules: local.RULES, trip: local.TRIP, levels: local.LEVELS, source: 'local' };
    const map = Object.fromEntries(rules.map((r) => [r.key, { label: r.label, group: r.grp, points: r.points, dailyCap: r.daily_cap, retired: r.retired }]));
    const c = settings.level_curve || {};
    const levels = local.LEVEL_NAMES.slice(0, c.levels || 10).map((name, i) => ({ n: i + 1, name, min: i === 0 ? 0 : Math.round(((c.base ?? 25) * Math.pow(i, c.exponent ?? 1.75)) / 5) * 5 }));
    return { rules: map, trip: settings.trip, levels, source: 'server' };
  }
  // trips
  async startTrip(mode, geometry) { return this.rpc('start_trip', { p_mode: mode, p_geometry: geometry.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]) }); }
  async tripCheckpoint(id, pos) { if (pos) await this.rpc('trip_checkpoint', { p_trip: id, p_lat: pos.lat, p_lng: pos.lng }); }
  async finishTrip(id, pos) { const r = await this.rpc('finish_trip', { p_trip: id, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null }); await this.loadProfile(this.profile?.id); this.emit(); return r; }
  async abandonTrip(id) { await this.rpc('abandon_trip', { p_trip: id }); }
  // leaderboards
  async leaderboardPage({ scope = 'public', period = 'week', offset = 0, limit = 20 } = {}) {
    const map = (r) => ({ rank: Number(r.rank), alias: r.alias, level: r.level, points: Number(r.points), isMe: r.is_me, total: Number(r.total) });
    const [rows, mine] = await Promise.all([
      this.rpc('leaderboard_page', { p_scope: scope, p_period: period, p_offset: offset, p_limit: limit }),
      this.profile ? this.rpc('leaderboard_me', { p_scope: scope, p_period: period }) : Promise.resolve([]),
    ]);
    const list = (rows || []).map(map);
    return { rows: list, total: list[0]?.total ?? (mine?.[0] ? Number(mine[0].total) : 0), me: mine?.[0] ? map(mine[0]) : null };
  }
  async leaderboard() {
    const { LEVELS } = await import('./pointsPolicy.js');
    return (await this.leaderboardPage({ scope: 'public', period: 'all', limit: 25 })).rows.map((r) => ({ ...r, level: LEVELS[r.level - 1]?.name }));
  }
  // moderator tools (the server rejects these for non-moderators)
  async adminUserPoints(alias) {
    const r = await this.rpc('admin_user_points', { p_alias: alias });
    return r ? { ...r, entries: (r.entries || []).map((e) => ({ ...e, status: e.status || 'awarded' })) } : null;
  }
  async adminGrantPoints(alias, points, reason) { const r = await this.rpc('admin_grant_points', { p_alias: alias, p_points: Math.trunc(Number(points)) || 0, p_reason: reason }); this.emit(); return r; }
  async adminReverseAward(entryId, reason) { const n = await this.rpc('admin_reverse_award', { p_entry: entryId, p_reason: reason }); this.emit(); return n; }
  async adminReverseSource(refType, refId, reason) { const n = await this.rpc('admin_reverse_source', { p_ref_type: refType, p_ref_id: refId, p_reason: reason }); this.emit(); return n; }
  async adminTripsForReview() { return (await this.rpc('admin_trips_for_review', {})) || []; }
  async adminReviewTrip(id, decision, reason = '') { return this.rpc('admin_review_trip', { p_trip: id, p_decision: decision, p_reason: reason }); }
  async myStats() {
    const me = this.requireUser(); const today = new Date().toISOString().slice(0, 10);
    const [{ data: a }, { data: p }] = await Promise.all([this.sb.from('alerts').select('id,created_at').eq('created_by', me.id), this.sb.from('paths').select('id,created_at').eq('created_by', me.id)]);
    return { alerts: a?.length || 0, paths: p?.length || 0, alertsToday: (a || []).filter((x) => x.created_at.startsWith(today)).length, pathsToday: (p || []).filter((x) => x.created_at.startsWith(today)).length };
  }
  aliasOf(userId) { return this.aliases?.[userId] || 'member'; }
  async cacheAliases(ids) {
    this.aliases ||= {};
    const missing = [...new Set(ids)].filter((id) => id && !this.aliases[id]);
    await Promise.all(missing.map(async (id) => { this.aliases[id] = await this.rpc('alias_of', { p_user: id }).catch(() => 'member'); }));
  }

  // ---------- social ----------
  myId() { return this.requireUser().gwId; }
  async setRequestSetting(setting) { await this.rpc('set_my_prefs', { p_opt_in: null, p_request_setting: setting }); await this.loadProfile(this.profile.id); return setting; }
  async lookupId(rawId) {
    const rows = await this.rpc('lookup_id', { p_id: normalizeGwId(rawId) });
    return rows?.[0] ? { id: rows[0].id, alias: rows[0].alias, gwId: rows[0].gw_id } : null;
  }
  async sendFriendRequest(userId) { await this.rpc('send_friend_request', { p_target: userId }); this.emit(); }
  async respondFriendRequest(id, accept) { await this.rpc('respond_friend_request', { p_request: id, p_accept: accept }); this.emit(); }
  async cancelFriendRequest(id) { await this.rpc('cancel_friend_request', { p_request: id }); this.emit(); }
  async removeFriend(userId) { await this.rpc('remove_friend', { p_user: userId }); this.emit(); }
  async blockUser(userId) { await this.rpc('block_user', { p_user: userId }); this.emit(); }
  async unblockUser(userId) { const { error } = await this.sb.from('blocks').delete().eq('by_user', this.requireUser().id).eq('target', userId); if (error) throw wrap(error); this.emit(); }
  async reportUser(userId, reason) { const { error } = await this.sb.from('reports').insert({ by_user: this.requireUser().id, target: userId, reason: (reason || '').slice(0, 300) }); if (error) throw wrap(error); }
  async peer(id) { await this.cacheAliases([id]); const gw = this.gwIds?.[id]; return { id, alias: this.aliases[id], gwId: gw || '' }; }
  async listSocial() {
    const me = this.requireUser();
    const [{ data: fr, error }, { data: bl }] = await Promise.all([this.sb.from('friends').select('*'), this.sb.from('blocks').select('target').eq('by_user', me.id)]);
    if (error) throw wrap(error);
    const others = [...(fr || []).map((f) => (f.from_user === me.id ? f.to_user : f.from_user)), ...(bl || []).map((b) => b.target)];
    await this.cacheAliases(others);
    // gw_ids of friends come from the lookup/public view
    this.gwIds ||= {};
    const need = others.filter((id) => !this.gwIds[id]);
    if (need.length) { const { data } = await this.sb.from('public_profiles').select('id,gw_id').in('id', need); for (const r of data || []) this.gwIds[r.id] = r.gw_id; }
    const P = (id) => ({ id, alias: this.aliases[id] || 'member', gwId: this.gwIds[id] || '' });
    return {
      gwId: me.gwId, requestSetting: me.requestSetting,
      friends: (fr || []).filter((f) => f.status === 'accepted').map((f) => P(f.from_user === me.id ? f.to_user : f.from_user)),
      incoming: (fr || []).filter((f) => f.status === 'pending' && f.to_user === me.id).map((f) => ({ id: f.id, from: P(f.from_user), createdAt: f.created_at })),
      outgoing: (fr || []).filter((f) => f.status === 'pending' && f.from_user === me.id).map((f) => ({ id: f.id, to: P(f.to_user), createdAt: f.created_at })),
      blocked: (bl || []).map((b) => P(b.target)),
    };
  }
  shareView(s) {
    const me = this.profile?.id;
    const P = (id) => ({ id, alias: this.aliases?.[id] || 'member', gwId: this.gwIds?.[id] || '' });
    const v = { id: s.id, type: s.type, status: s.status, live: s.live !== false, startedAt: s.started_at, endsAt: s.ends_at, endedReason: s.ended_reason, endedAt: s.ended_at, respondedAt: s.responded_at, from: P(s.from_user), to: P(s.to_user), direction: s.from_user === me ? 'outgoing' : 'incoming' };
    if (s.trip) { v.trip = { ...s.trip }; v.trip.mode ||= 'walk'; }
    if (s.last_lat != null) v.lastPos = { lat: s.last_lat, lng: s.last_lng, at: s.last_at };
    return v;
  }
  async listShares() {
    this.requireUser();
    const since = new Date(Date.now() - 6 * 3600000).toISOString();
    const { data, error } = await this.sb.from('shares').select('*').or(`status.neq.ended,ended_at.gt.${since}`).order('started_at', { ascending: false });
    if (error) throw wrap(error);
    await this.cacheAliases((data || []).flatMap((s) => [s.from_user, s.to_user]));
    const views = (data || []).map((s) => this.shareView(s));
    // Route lines: RLS only returns them to the owner, or to the recipient after accepting. Fetched once per share.
    this.routeCache ||= new Map();
    const need = views.filter((v) => v.type === 'trip' && v.status !== 'ended' && !v.trip?.geometry && !this.routeCache.has(v.id) && (v.direction === 'outgoing' || v.status === 'active')).map((v) => v.id);
    if (need.length) {
      const { data: rows } = await this.sb.from('share_routes').select('share_id, geometry').in('share_id', need);
      for (const r of rows || []) this.routeCache.set(r.share_id, r.geometry);
    }
    for (const v of views) if (v.trip && v.status !== 'ended' && this.routeCache.has(v.id)) v.trip.geometry = this.routeCache.get(v.id);
    return views;
  }
  async startLocationShare(friendId, minutes) { const s = await this.rpc('start_share', { p_to: friendId, p_minutes: minutes, p_type: 'location', p_trip: null }); this.emit(); return this.shareView(s); }
  async startTripShare(friendId, { destName, mode, geometry, durationS, live = false, toFriendLocation = false }) {
    this.requireUser();
    const g = geometry.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]);
    const s = await this.rpc('start_trip_share', { p_to: friendId, p_trip: { destName, mode, durationS, toFriendLocation: !!toFriendLocation }, p_geometry: g, p_live: !!live });
    (this.routeCache ||= new Map()).set(s.id, g);
    this.emit(); return this.shareView(s);
  }
  async respondTripShare(id, accept) { await this.rpc('respond_trip_share', { p_share: id, p_accept: !!accept }); this.emit(); }
  async setTripLive(id, live) { await this.rpc('set_trip_live', { p_share: id, p_live: !!live }); this.emit(); }
  async pauseShare(id) { await this.rpc('set_share_status', { p_share: id, p_status: 'paused', p_reason: null }); this.emit(); }
  async resumeShare(id) { await this.rpc('set_share_status', { p_share: id, p_status: 'active', p_reason: null }); this.emit(); }
  async stopShare(id, reason = 'stopped') { await this.rpc('set_share_status', { p_share: id, p_status: 'ended', p_reason: reason }); this.emit(); }
  async updateSharePosition(id, { lat, lng }) { await this.rpc('update_share_position', { p_share: id, p_lat: lat, p_lng: lng }); }
  async listReports() { const { data, error } = await this.sb.from('reports').select('*'); if (error) throw wrap(error); return data; }
}

/** Realtime provider: fires whenever a share row the signed-in user may read changes (RLS scopes the stream). */
export class SupabaseRealtime {
  constructor(backend) {
    this.name = 'supabase-realtime';
    this.isCrossDevice = true;
    this.note = 'Live sharing works between phones while the app is open on both.';
    this.cbs = new Set();
    this.alertCbs = new Set();
    const fire = () => this.cbs.forEach((cb) => cb());
    const fireAlerts = () => this.alertCbs.forEach((cb) => cb());
    backend.onChange(fire);
    this.subscribe = () => {
      this.channel?.unsubscribe();
      this.channel = backend.sb.channel('gw-shares')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shares' }, fire)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friends' }, fire)
        .subscribe();
      // Community alerts: every phone with the app open sees a new report (or confirmation / review) within a second or two.
      // Needs the tables added to the realtime publication — see supabase/migration-006-realtime-alerts.sql
      this.alertChannel?.unsubscribe();
      this.alertChannel = backend.sb.channel('gw-alerts')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, fireAlerts)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'alert_confirmations' }, fireAlerts)
        .subscribe();
    };
    backend.sb.auth.onAuthStateChange(() => this.subscribe());
    this.subscribe();
    setInterval(fire, 10000); // staleness / expiry ticks
  }
  onUpdate(cb) { this.cbs.add(cb); return () => this.cbs.delete(cb); }
  onAlerts(cb) { this.alertCbs.add(cb); return () => this.alertCbs.delete(cb); }
}
