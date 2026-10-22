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
    this.sb = supabase.createClient(url, anonKey);
    this.kind = 'supabase';
    this.isShared = true;
    this.authMode = 'email';
    this.listeners = new Set();
    this.profile = null;
    this.ready = this.sb.auth.getSession().then(({ data }) => this.loadProfile(data.session?.user?.id));
    this.sb.auth.onAuthStateChange((_evt, session) => this.loadProfile(session?.user?.id).then(() => this.emit()));
  }
  emit() { for (const cb of this.listeners) cb(); }
  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  async loadProfile(userId) {
    if (!userId) { this.profile = null; return; }
    const { data } = await this.sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    this.profile = data ? { id: data.id, alias: data.alias, role: data.role, points: data.points, leaderboardOptIn: data.leaderboard_opt_in, gwId: data.gw_id, requestSetting: data.request_setting, createdAt: data.created_at } : null;
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
  async updateUser(patch) {
    await this.rpc('set_my_prefs', { p_opt_in: patch.leaderboardOptIn ?? null, p_request_setting: null });
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

  // ---------- points ----------
  async pointHistory(userId) {
    const { data, error } = await this.sb.from('point_entries').select('*').eq('user_id', userId).order('at', { ascending: false });
    if (error) throw wrap(error);
    return (data || []).map((e) => ({ id: e.id, userId: e.user_id, rule: e.rule, points: e.points, refType: e.ref_type, refId: e.ref_id, at: e.at }));
  }
  async leaderboard() {
    const rows = await this.rpc('leaderboard', {});
    const { levelFor } = await import('./rules.js');
    return rows.map((r) => ({ alias: r.alias, points: r.points, level: levelFor(r.points).level.name, isMe: r.is_me }));
  }
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
    const v = { id: s.id, type: s.type, status: s.status, startedAt: s.started_at, endsAt: s.ends_at, endedReason: s.ended_reason, endedAt: s.ended_at, from: P(s.from_user), to: P(s.to_user), direction: s.from_user === me ? 'outgoing' : 'incoming' };
    if (s.trip) v.trip = { ...s.trip };
    if (s.last_lat != null) v.lastPos = { lat: s.last_lat, lng: s.last_lng, at: s.last_at };
    return v;
  }
  async listShares() {
    this.requireUser();
    const since = new Date(Date.now() - 6 * 3600000).toISOString();
    const { data, error } = await this.sb.from('shares').select('*').or(`status.neq.ended,ended_at.gt.${since}`).order('started_at', { ascending: false });
    if (error) throw wrap(error);
    await this.cacheAliases((data || []).flatMap((s) => [s.from_user, s.to_user]));
    return (data || []).map((s) => this.shareView(s));
  }
  async startLocationShare(friendId, minutes) { const s = await this.rpc('start_share', { p_to: friendId, p_minutes: minutes, p_type: 'location', p_trip: null }); this.emit(); return this.shareView(s); }
  async startTripShare(friendId, { destName, destLat, destLng, geometry, routeDistanceM, durationS, rewardOptIn }) {
    const me = this.requireUser();
    const minutes = Math.min(240, Math.ceil((durationS / 60) * 2) + 15);
    const trip = { destName, destLat, destLng, geometry, routeDistanceM, durationS, progressM: 0, arrived: false, rewardOptIn: rewardOptIn ? { [me.id]: true } : {} };
    const s = await this.rpc('start_share', { p_to: friendId, p_minutes: minutes, p_type: 'trip', p_trip: trip }); this.emit(); return this.shareView(s);
  }
  async pauseShare(id) { await this.rpc('set_share_status', { p_share: id, p_status: 'paused', p_reason: null }); this.emit(); }
  async resumeShare(id) { await this.rpc('set_share_status', { p_share: id, p_status: 'active', p_reason: null }); this.emit(); }
  async stopShare(id, reason = 'stopped') { await this.rpc('set_share_status', { p_share: id, p_status: 'ended', p_reason: reason }); this.emit(); }
  async updateSharePosition(id, { lat, lng }) { await this.rpc('update_share_position', { p_share: id, p_lat: lat, p_lng: lng }); }
  async optInTripReward(id) { await this.rpc('opt_in_trip_reward', { p_share: id }); this.emit(); }
  async tripCheckIn({ shareId, routeDistanceM, destLat, destLng, position }) {
    const res = await this.rpc('trip_check_in', { p_share: shareId || null, p_route_m: routeDistanceM, p_dest_lat: destLat, p_dest_lng: destLng, p_lat: position?.lat ?? null, p_lng: position?.lng ?? null });
    await this.loadProfile(this.profile.id); this.emit();
    return res;
  }
  async listReports() { const { data, error } = await this.sb.from('reports').select('*'); if (error) throw wrap(error); return data; }
}

/** Realtime provider: fires whenever a share row the signed-in user may read changes (RLS scopes the stream). */
export class SupabaseRealtime {
  constructor(backend) {
    this.name = 'supabase-realtime';
    this.isCrossDevice = true;
    this.note = 'Live sharing works between phones while the app is open on both.';
    this.cbs = new Set();
    const fire = () => this.cbs.forEach((cb) => cb());
    backend.onChange(fire);
    this.subscribe = () => {
      this.channel?.unsubscribe();
      this.channel = backend.sb.channel('gw-shares')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shares' }, fire)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friends' }, fire)
        .subscribe();
    };
    backend.sb.auth.onAuthStateChange(() => this.subscribe());
    this.subscribe();
    setInterval(fire, 10000); // staleness / expiry ticks
  }
  onUpdate(cb) { this.cbs.add(cb); return () => this.cbs.delete(cb); }
}
