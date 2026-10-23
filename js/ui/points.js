// Points, levels & leaderboards screens. Everything shown here comes from the backend; amounts are never
// calculated or sent by the client.
import { el, esc, fmtAgo, fmtDistance } from '../util.js';
import { state } from '../state.js';
import { ALERT_CATEGORIES } from '../backend/rules.js';
import { RULES as LOCAL_RULES, LEVELS as LOCAL_LEVELS, levelInfo, weekStart, nextWeekStart } from '../backend/pointsPolicy.js';
import { openModal } from './modal.js';
import { toast } from './sheet.js';
import { avatar } from './avatar.js';
import { openAccount, openAuth } from './account.js';
import { motionOk } from '../prefs.js';

const MODE_LABEL = { walk: '🚶 Walk', bike: '🚲 Bike', scooter: '🛴 Scooter', drive: '🚗 Drive' };
const ENTRY_STATUS = {
  awarded: { text: 'Added', cls: 'live' },
  capped: { text: 'Daily limit reached', cls: 'pending' },
  reversed: { text: 'Reversed', cls: 'danger' },
  reversal: { text: 'Reversal', cls: 'danger' },
};
const CONTRIB_STATUS = {
  pending: { text: 'Awaiting review', cls: 'pending' }, verified: { text: 'Verified', cls: 'live' }, approved: { text: 'Approved', cls: 'live' },
  rejected: { text: 'Not approved', cls: 'danger' }, changes: { text: 'Changes requested', cls: 'pending' }, resolved: { text: 'Resolved', cls: '' },
};
const TRIP_STATUS = {
  completed: { text: 'Verified', cls: 'live' }, no_award: { text: 'Not eligible', cls: '' }, review: { text: 'Being checked', cls: 'pending' },
  rejected: { text: 'Not verified', cls: 'danger' }, abandoned: { text: 'Ended early', cls: '' }, expired: { text: 'Expired', cls: '' },
};

let policyCache = null;
async function policy(ctx) {
  if (policyCache) return policyCache;
  try { policyCache = await ctx.backend.pointsPolicy(); } catch { policyCache = { rules: LOCAL_RULES, levels: LOCAL_LEVELS, source: 'local' }; }
  return policyCache;
}
const loading = (txt) => el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), txt);
const errorBox = (e, retry) => el('div', { class: 'notice danger' }, navigator.onLine ? `Couldn't load this: ${esc(e.message || 'error')}. ` : 'You are offline — points and leaderboards need a connection. ',
  retry ? el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); retry(); } }, 'Try again') : null);
const chip = (s) => el('span', { class: `chip ${s.cls}` }, s.text);
const levelName = (n, levels) => (levels[n - 1] || levels[levels.length - 1]).name;
function ruleLabel(rule, rules) { return rules[rule]?.label || LOCAL_RULES[rule]?.label || rule; }
function untilReset() {
  const ms = nextWeekStart() - Date.now();
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d} day${d > 1 ? 's' : ''} ${h} h` : `${h} h`;
}

/** Back-compat entry point: 'leaderboard' → Leaderboard tab, 'progress' → Profile tab, 'guide' → rules sheet. */
export function openPoints(ctx, tab = 'progress') {
  if (tab === 'guide') return openGuide(ctx);
  ctx.showTab?.(tab === 'leaderboard' ? 'leaderboard' : 'profile', { focus: true });
}
/** "How points work" — rules, trip checks, levels and leaderboard rules, from the live policy. */
export async function openGuide(ctx) {
  openModal('How points work', [loading('Loading…')]);
  try { openModal('How points work', [await guideTab(ctx)]); }
  catch (e) { openModal('How points work', [errorBox(e, () => openGuide(ctx))]); }
}

// Shared bits used by the Activity and Profile tabs.
export { policy, chip, ruleLabel, ENTRY_STATUS, CONTRIB_STATUS, TRIP_STATUS, MODE_LABEL, errorBox };
export function contribTitle(c) {
  return c.kind === 'path' ? `🛤️ ${c.name || 'Path suggestion'}` : `${ALERT_CATEGORIES[c.category]?.emoji || '⚠️'} ${ALERT_CATEGORIES[c.category]?.label || 'Report'}`;
}

// ================================================================ Leaderboard tab
const lb = { scope: 'public', period: 'week' };
const MEDAL = ['🥇', '🥈', '🥉'];

function pills(label, options, value, onPick, disabled = []) {
  const group = el('div', { class: 'pills', role: 'group', 'aria-label': label });
  const draw = (v) => group.replaceChildren(...options.map(([k, text]) => el('button', {
    type: 'button', 'aria-pressed': String(k === v), disabled: disabled.includes(k),
    title: disabled.includes(k) ? 'Sign in to see your friends board' : null,
    onclick: () => { draw(k); onPick(k); } }, text)));
  draw(value);
  return group;
}

export async function renderLeaderboardPage(ctx, page) {
  const signed = !!state.user;
  if (!signed) lb.scope = 'public';
  const [pol, sum] = await Promise.all([policy(ctx), signed ? ctx.backend.myPointsSummary().catch(() => null) : Promise.resolve(null)]);
  page.setActions(el('button', { class: 'btn sm ghost', onclick: () => openGuide(ctx) }, 'ⓘ How points work'));

  const you = el('div');
  const podium = el('div');
  const list = el('ol', { class: 'lb-list', 'aria-label': 'Leaderboard' });
  const foot = el('div');
  const note = el('p', { class: 'small muted', style: 'margin:0 2px 10px' });
  let offset = 0, total = 0;
  const pageSize = 20;
  const boardName = () => `${lb.scope === 'friends' ? 'Friends' : 'Everyone'} · ${lb.period === 'week' ? 'this week' : 'all-time'}`;

  const row = (r) => el('li', { class: `lb-row ${r.isMe ? 'me' : ''}` },
    el('span', { class: 'rank' }, el('span', { class: 'sr-only' }, 'Rank '), `#${r.rank}`),
    avatar(r.alias, { size: 34 }),
    el('div', { style: 'min-width:0' },
      el('div', { class: 'lb-name' }, r.alias, r.isMe ? el('span', { class: 'chip live', style: 'margin-left:6px' }, 'You') : null, r.sample ? el('span', { class: 'chip sample', style: 'margin-left:6px' }, 'Sample') : null),
      el('div', { class: 'small muted' }, `Level ${r.level} · ${levelName(r.level, pol.levels)}`)),
    el('span', { class: 'pts' }, String(r.points), el('span', { class: 'sr-only' }, ' points')));

  const pod = (r, i) => r ? el('div', { class: `pod ${i === 0 ? 'first' : ''} ${r.isMe ? 'me' : ''}`, role: 'listitem' },
    el('span', { class: 'medal', 'aria-hidden': 'true' }, MEDAL[r.rank - 1] || `#${r.rank}`),
    avatar(r.alias, { size: i === 0 ? 52 : 42 }),
    el('div', { class: 'nm' }, r.alias),
    el('div', { class: 'pt' }, String(r.points)),
    el('div', { class: 'lv' }, `Rank ${r.rank} · Lv ${r.level}`)) : el('div');

  function youCard(me) {
    if (!signed) return el('div', { class: 'hero you-card' },
      el('div', { class: 'row' }, el('span', { class: 'av', style: '--av:44px;--av-bg:var(--bg-3);color:var(--text-2)', 'aria-hidden': 'true' }, '?'),
        el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'hero-name' }, 'Join the board'),
          el('div', { class: 'hero-sub' }, 'Guests can look around. Sign in to earn points for verified reports, approved paths and finished trips.'))),
      el('div', { class: 'row wrap', style: 'margin-top:12px' },
        el('button', { class: 'btn primary sm', onclick: () => openAccount(ctx) }, 'Sign in'),
        el('button', { class: 'btn sm', onclick: () => openAuth(ctx, 'register') }, 'Create account')));
    const lv = levelInfo(state.user.points, state.user.levelFloor);
    const hiddenPublic = lb.scope === 'public' && sum && !sum.leaderboardOptIn;
    const head = el('div', { class: 'row' }, avatar(state.user.alias, { size: 48 }),
      el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'hero-name' }, state.user.alias), el('div', { class: 'hero-sub' }, `Level ${lv.level.n} · ${lv.level.name}`)),
      me ? el('div', { style: 'text-align:right' }, el('div', { class: 'rank-big' }, `#${me.rank}`), el('div', { class: 'small muted' }, `of ${me.total || total}`)) : null);
    const stats = el('div', { class: 'hero-stats' },
      el('div', {}, el('strong', {}, String(me ? me.points : (lb.period === 'week' ? sum?.week ?? 0 : state.user.points))), el('span', {}, lb.period === 'week' ? 'pts this week' : 'pts all-time')),
      el('div', {}, el('strong', {}, me ? `#${me.rank}` : '—'), el('span', {}, 'rank')),
      el('div', {}, el('strong', {}, lv.next ? String(lv.toNext) : '✓'), el('span', {}, lv.next ? `to ${lv.next.name}` : 'top level')));
    const msg = hiddenPublic
      ? el('div', { class: 'notice', style: 'margin:12px 0 0' }, 'You are hidden from the public board, so only you see your rank here. ',
          el('a', { href: '#lb-privacy', onclick: (e) => { e.preventDefault(); document.getElementById('lb-privacy')?.scrollIntoView({ behavior: motionOk() ? 'smooth' : 'auto', block: 'center' }); } }, 'Visibility settings'))
      : !me ? el('div', { class: 'notice', style: 'margin:12px 0 0' }, lb.period === 'week' ? 'No points yet this week. You appear as soon as a contribution is verified or you finish a trip.' : 'You appear once you have points.') : null;
    return el('div', { class: 'hero you-card', 'aria-label': `Your standing: ${boardName()}` }, head, stats, msg);
  }

  async function load(append = false) {
    note.textContent = lb.period === 'week'
      ? `Week from Mon ${weekStart().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · resets Monday 00:00 UK time (in ${untilReset()}). Tied scores share a rank.`
      : 'All-time points after any reversals. Tied scores share a rank.';
    if (!append) { offset = 0; list.replaceChildren(el('li', {}, loading('Loading leaderboard…'))); podium.replaceChildren(); foot.replaceChildren(); }
    try {
      const res = await ctx.backend.leaderboardPage({ scope: lb.scope, period: lb.period, offset, limit: pageSize });
      total = res.total;
      if (!append) {
        list.replaceChildren();
        you.replaceChildren(youCard(res.me));
        const onlyMe = lb.scope === 'friends' && res.rows.length <= 1;
        if (!res.rows.length || onlyMe) {
          podium.replaceChildren(el('div', { class: 'state-card' },
            el('div', { class: 'big', 'aria-hidden': 'true' }, lb.scope === 'friends' ? '🫂' : '🏁'),
            el('strong', {}, lb.scope === 'friends' ? 'No friends on this board yet' : lb.period === 'week' ? 'Fresh week, empty board' : 'Nobody on the board yet'),
            el('p', { class: 'muted small' }, lb.scope === 'friends' ? 'Friends appear here once they turn on “Friends leaderboard” in their Profile.' : 'Verified reports, approved paths and finished trips all count.'),
            lb.scope === 'friends' ? el('button', { class: 'btn sm', onclick: () => ctx.showTab('friends', { focus: true }) }, 'Find friends') : null));
          if (!onlyMe) return;
        }
        if (!onlyMe && res.rows.length >= 3) {
          const [a, b, c] = res.rows;
          podium.replaceChildren(el('div', { class: 'podium', role: 'list', 'aria-label': 'Top three' }, pod(b, 1), pod(a, 0), pod(c, 2)));
          list.append(...res.rows.slice(3).map(row));
        } else list.append(...res.rows.map(row));
      } else list.append(...res.rows.map(row));
      offset += res.rows.length;
      const meShown = res.rows.some((r) => r.isMe) || !!list.querySelector('.lb-row.me') || !!podium.querySelector('.pod.me');
      foot.replaceChildren(...[
        offset < total ? el('button', { class: 'btn sm ghost block', style: 'margin-top:8px', onclick: (e) => { e.currentTarget.disabled = true; load(true); } }, `Show more (${total - offset})`) : null,
        !meShown && res.me ? el('div', { style: 'margin-top:10px' }, el('div', { class: 'small muted', style: 'margin:0 2px 6px' }, 'Your position'), el('ol', { class: 'lb-list' }, row(res.me))) : null].filter(Boolean));
    } catch (e) { list.replaceChildren(el('li', {}, errorBox(e, () => load()))); }
  }

  const switchers = el('div', { class: 'pills-row' },
    pills('Who', [['public', 'Everyone'], ['friends', 'Friends']], lb.scope, (v) => { lb.scope = v; load(); }, signed ? [] : ['friends']),
    pills('Period', [['week', 'This week'], ['all', 'All-time']], lb.period, (v) => { lb.period = v; load(); }));

  let privacy = null;
  if (signed && sum) {
    const sw = (checked, key, okMsg) => {
      const i = el('input', { type: 'checkbox', class: 'switch', role: 'switch', checked });
      i.onchange = async () => { i.disabled = true; try { await ctx.backend.setPointsPrefs({ [key]: i.checked }); sum[key] = i.checked; toast(okMsg(i.checked)); load(); } catch (e) { i.checked = !i.checked; toast(e.message, 'error'); } i.disabled = false; };
      return i;
    };
    privacy = el('section', { class: 'sec', id: 'lb-privacy', 'aria-labelledby': 'lb-priv-h' },
      el('div', { class: 'sec-title' }, el('h2', { id: 'lb-priv-h' }, '🔒 Who can see me')),
      el('div', { class: 'settings' },
        el('label', { class: 'set-row' }, el('span', { class: 'tx' }, el('strong', {}, 'Public leaderboards'), el('span', {}, 'Show my alias, level and points to everyone')), sw(sum.leaderboardOptIn, 'leaderboardOptIn', (v) => (v ? 'You now appear on public leaderboards' : 'Hidden from public leaderboards'))),
        el('label', { class: 'set-row' }, el('span', { class: 'tx' }, el('strong', {}, 'Friends leaderboard'), el('span', {}, 'Show my alias, level and points to accepted friends')), sw(sum.friendsBoardOptIn, 'friendsBoardOptIn', (v) => (v ? 'Friends can see you on their board' : 'Hidden from friends’ boards')))),
      el('p', { class: 'small muted', style: 'margin:8px 2px 0' }, 'Boards never show locations, routes, trip distances or times. Hidden or not, you still earn points and levels.'));
  }

  load();
  return el('div', {},
    el('p', { class: 'lead' }, 'Points for helping the map — verified reports, approved paths and finished trips.'),
    switchers, you, el('div', { style: 'height:12px' }), podium, note, list, foot,
    el('div', { class: 'row wrap', style: 'margin-top:14px' },
      el('button', { class: 'btn sm', onclick: () => openGuide(ctx) }, '📜 Points rules'),
      el('button', { class: 'btn sm', onclick: () => (signed ? ctx.showTab('profile', { focus: true }) : openGuide(ctx)) }, '🏅 Levels & progress')),
    privacy,
    el('p', { class: 'motivate' }, 'Never travel just for points — trips only count when you finish a route you were taking anyway, and longer detours never earn more.'),
    !ctx.backend.isShared ? el('p', { class: 'small muted', style: 'margin-top:6px' }, 'Demo mode: boards only include sample users and accounts created on this device.') : null);
}

// ---------------------------------------------------------------- guide
async function guideTab(ctx) {
  const [pol, sum] = await Promise.all([policy(ctx), state.user ? ctx.backend.myPointsSummary().catch(() => null) : Promise.resolve(null)]);
  const r = pol.rules, t = pol.trip || {};
  const groups = {};
  for (const [k, v] of Object.entries(r)) if (!v.retired && v.points != null && k !== 'reversal') (groups[v.group] ||= []).push(v);
  const capTxt = (v) => (v.dailyCap ? `max ${v.dailyCap}/day` : '');
  const tripToggle = el('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: !!sum?.tripPoints });
  tripToggle.onchange = async () => { tripToggle.disabled = true; try { await ctx.backend.setPointsPrefs({ tripPoints: tripToggle.checked }); toast(tripToggle.checked ? 'Trip points on' : 'Trip points off — no trip checks will be sent'); } catch (e) { tripToggle.checked = !tripToggle.checked; toast(e.message, 'error'); } tripToggle.disabled = false; };
  const modes = t.modes || {};
  return el('div', { class: 'guide' },
    el('p', {}, 'Points reward helpful, checked contributions and genuinely completed trips. Nothing is earned for time in the app, for adding friends, for sharing your location, or for going further or faster than a trip needs.'),
    el('h3', { class: 'pts-h' }, 'Map contributions'),
    el('table', { class: 'rules' }, ...(groups['Map contributions'] || []).map((v) => el('tr', {}, el('td', {}, v.label, el('div', { class: 'small muted' }, capTxt(v))), el('td', {}, `+${v.points}`)))),
    el('p', { class: 'small muted' }, 'Submitting a report or path earns nothing on its own — points are added only when a moderator verifies or approves it, once per contribution. Rejected, duplicate or withdrawn submissions earn nothing. Never go somewhere unsafe, private or off-limits to report something, and never report while driving.'),
    el('h3', { class: 'pts-h' }, 'Trips'),
    el('table', { class: 'rules' },
      el('tr', {}, el('td', {}, 'Completed walk, bike or scooter trip', el('div', { class: 'small muted' }, `${r.trip_completed?.dailyCap ? `max ${r.trip_completed.dailyCap} completion pts/day` : ''}`)), el('td', {}, `+${modes.walk?.basePoints ?? 4}`)),
      el('tr', {}, el('td', {}, 'Completed drive', el('div', { class: 'small muted' }, 'no distance bonus — we never reward driving further')), el('td', {}, `+${modes.drive?.basePoints ?? 2}`)),
      ...(t.bands || []).map((b) => el('tr', {}, el('td', {}, `Distance bonus from ${fmtDistance(b.minM)}`), el('td', {}, `+${b.points}`)))),
    el('p', { class: 'small muted' }, `Bike and scooter distances count at ${Math.round((modes.bike?.distanceFactor ?? 0.5) * 100)}% of walking distance. Max ${t.maxPerTrip} points per trip; distance bonus max ${r.trip_distance?.dailyCap ?? 30} pts/day. Trips under ${fmtDistance(t.minEligibleM)} earn nothing.`),
    el('div', { class: 'card' },
      el('strong', {}, 'How a trip is checked'),
      el('ul', { class: 'small', style: 'margin:6px 0 0;padding-left:18px' },
        el('li', {}, 'Start navigation on a planned route, with trip points on.'),
        el('li', {}, `Travel at least ${Math.round((t.minProgress ?? 0.8) * 100)}% of the route and finish within ${t.arrivalRadiusM} m of the destination.`),
        el('li', {}, 'Distance counts only along your route, up to the shortest sensible distance — detours and longer routes never earn more.'),
        el('li', {}, 'Trips that look too fast for the travel mode are held for a moderator to check.'),
        el('li', {}, 'Points arrive once, after the trip. Nothing pops up while you travel — keep your eyes on the road.'))),
    !sum ? el('div', { class: 'notice' }, 'Trip points are for signed-in members. Navigation works the same either way.') : el('label', { class: 'card row', style: 'gap:12px;align-items:flex-start;margin-top:8px' }, tripToggle,
      el('span', { class: 'small' }, el('strong', {}, 'Earn points for trips'),
        ` — while you navigate, the app sends a coarse position check about every ${t.checkpointEverySec || 30} s. Only the latest check is kept, it is used to measure progress and plausibility, and it is deleted with the route when the trip ends. Nobody else can see it, and it never appears on a leaderboard. Turn this off and navigation works exactly the same.`)),
    el('h3', { class: 'pts-h' }, 'Levels'),
    el('table', { class: 'rules' }, ...pol.levels.map((l) => el('tr', {}, el('td', {}, `${l.n}. ${l.name}`), el('td', {}, `${l.min} pts`)))),
    el('p', { class: 'small muted' }, 'Your level comes from your lifetime points. If a moderator reverses points (for example a report later found to be false), those points come off your balance and leaderboards, but you keep the highest level you reached. Every reversal is recorded with a reason in your activity.'),
    el('h3', { class: 'pts-h' }, 'Leaderboards'),
    el('p', { class: 'small muted' }, 'Weekly boards run Monday 00:00 to Sunday 23:59 UK time; all-time uses your balance. You only appear if you opt in (public and friends are separate choices). Boards show your alias, level and points — never locations, routes, distances or times.'),
    el('h3', { class: 'pts-h' }, 'Fair play'),
    el('p', { class: 'small muted' }, 'Each contribution or trip can only earn once, even if the app retries. Daily limits stop points snowballing. Unusual activity goes to a moderator rather than being blocked automatically.'),
    pol.source === 'server' ? el('p', { class: 'small', style: 'color:var(--text-3)' }, 'Values shown come from the live points policy.') : null);
}

/** Post-trip result (called only after navigation has ended). */
export function showTripResult(res) {
  if (!res) return;
  const pts = (res.basePoints || 0) + (res.distancePoints || 0);
  if (res.outcome === 'completed' && pts > 0) {
    openModal('Trip verified', [
      el('div', { class: 'trip-result' }, el('div', { class: 'big' }, `+${pts}`), el('div', { class: 'muted' }, 'points')),
      el('table', { class: 'rules' },
        el('tr', {}, el('td', {}, 'Completed trip'), el('td', {}, `+${res.basePoints}`)),
        res.distancePoints ? el('tr', {}, el('td', {}, `Distance bonus (~${fmtDistance(res.eligibleM)})`), el('td', {}, `+${res.distancePoints}`)) : null),
      ...(res.reasons || []).map((r) => el('div', { class: 'notice', style: 'margin-top:8px' }, esc(r)))]);
  } else if (res.outcome === 'review') {
    toast('Trip saved — a moderator will check it before any points are added', 'success');
  } else if (res.outcome === 'completed') {
    toast(res.reasons?.[0] || 'Trip complete', 'success');
  } else if (res.reasons?.length) {
    toast(`No trip points this time: ${res.reasons[0]}`);
  }
}
