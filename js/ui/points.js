// Points, levels & leaderboards screens. Everything shown here comes from the backend; amounts are never
// calculated or sent by the client.
import { el, esc, fmtAgo, fmtDistance } from '../util.js';
import { state } from '../state.js';
import { ALERT_CATEGORIES } from '../backend/rules.js';
import { RULES as LOCAL_RULES, LEVELS as LOCAL_LEVELS, levelInfo, weekStart, nextWeekStart } from '../backend/pointsPolicy.js';
import { openModal } from './modal.js';
import { toast } from './sheet.js';

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

/** Points & levels hub. tab: 'progress' | 'leaderboard' | 'guide' */
export async function openPoints(ctx, tab = 'progress') {
  if (!state.user) return;
  const tabs = el('div', { class: 'tabs' });
  const body = el('div', { class: 'points-body' }, loading('Loading…'));
  const names = { progress: 'Progress', leaderboard: 'Leaderboards', guide: 'How it works' };
  for (const k of Object.keys(names)) tabs.append(el('button', { class: k === tab ? 'active' : '', onclick: () => openPoints(ctx, k) }, names[k]));
  openModal('Points & levels', [tabs, body]);
  const render = { progress: progressTab, leaderboard: leaderboardTab, guide: guideTab }[tab];
  try { body.replaceChildren(await render(ctx)); }
  catch (e) { body.replaceChildren(errorBox(e, () => openPoints(ctx, tab))); }
}

// ---------------------------------------------------------------- progress
async function progressTab(ctx) {
  const [pol, sum, contribs, trips, ledger] = await Promise.all([
    policy(ctx), ctx.backend.myPointsSummary(), ctx.backend.myContributions().catch(() => []),
    ctx.backend.myTrips().catch(() => []), ctx.backend.myLedger({ offset: 0, limit: 15 }),
  ]);
  const lv = levelInfo(sum.points, sum.levelFloor);
  const keptLevel = levelInfo(sum.points).level.n < lv.level.n;
  const card = el('div', { class: 'card level-card' },
    el('div', { class: 'row between' },
      el('div', { class: 'level-badge', 'aria-hidden': 'true' }, String(lv.level.n)),
      el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'small muted' }, `Level ${lv.level.n}`), el('div', { class: 'level-name' }, lv.level.name)),
      el('div', { class: 'stat', style: 'text-align:right' }, el('strong', {}, String(sum.points)), el('span', {}, 'points'))),
    el('div', { class: 'levelbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(lv.progress * 100)), 'aria-label': 'Progress to next level' }, el('i', { style: `width:${Math.round(lv.progress * 100)}%` })),
    el('div', { class: 'row between small muted' },
      el('span', {}, lv.next ? `${lv.toNext} pts to ${lv.next.name}` : 'Top level reached'),
      el('span', {}, `+${sum.week} this week`)),
    keptLevel ? el('div', { class: 'small muted', style: 'margin-top:6px' }, 'Some points were reversed, but you keep the highest level you reached.') : null);

  // recent activity (paginated)
  const list = el('div', { class: 'list' });
  let offset = 0;
  const more = el('button', { class: 'btn sm ghost block', style: 'margin-top:6px' }, 'Show more');
  const addEntries = (entries) => list.append(...entries.map((e) => el('div', { class: 'item' },
    el('div', { class: 'emoji' }, e.rule === 'reversal' ? '↩️' : e.rule.startsWith('trip') ? '🧭' : e.rule === 'path_approved' ? '🗺️' : '⭐'),
    el('div', { class: 'body' },
      el('div', { class: 't' }, ruleLabel(e.rule, pol.rules)),
      el('div', { class: 's' }, new Date(e.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), e.reason ? ` · ${esc(e.reason)}` : ''),
      el('div', { class: 'meta' }, chip(ENTRY_STATUS[e.status] || ENTRY_STATUS.awarded))),
    el('strong', { class: e.points < 0 ? 'neg' : '', style: e.points < 0 ? 'color:var(--danger)' : 'color:var(--accent)' }, e.points > 0 ? `+${e.points}` : String(e.points)))));
  addEntries(ledger.entries); offset = ledger.entries.length;
  more.hidden = offset >= ledger.total;
  more.onclick = async () => {
    more.disabled = true; more.textContent = 'Loading…';
    try { const p = await ctx.backend.myLedger({ offset, limit: 15 }); addEntries(p.entries); offset += p.entries.length; more.hidden = offset >= p.total; }
    catch (e) { toast(e.message, 'error'); }
    more.disabled = false; more.textContent = 'Show more';
  };

  const contribList = contribs.length ? el('div', { class: 'list' }, ...contribs.slice(0, 8).map((c) => {
    const st = CONTRIB_STATUS[c.status] || { text: c.status, cls: '' };
    const title = c.kind === 'path' ? `🛤️ ${esc(c.name)}` : `${ALERT_CATEGORIES[c.category]?.emoji || '⚠️'} ${ALERT_CATEGORIES[c.category]?.label || 'Report'}`;
    return el('div', { class: 'item' }, el('div', { class: 'body' },
      el('div', { class: 't' }, title),
      el('div', { class: 's' }, fmtAgo(c.createdAt), c.message ? ` · “${esc(c.message)}”` : ''),
      el('div', { class: 'meta' }, chip(st), c.award ? chip({ ...(ENTRY_STATUS[c.award.status] || ENTRY_STATUS.awarded), text: c.award.status === 'awarded' ? `+${c.award.points} pts` : (ENTRY_STATUS[c.award.status] || {}).text }) : null)));
  })) : el('div', { class: 'empty small' }, 'No reports or path suggestions yet. Points arrive when a moderator verifies them.');

  const tripList = trips.length ? el('div', { class: 'list' }, ...trips.slice(0, 5).map((t) => el('div', { class: 'item' }, el('div', { class: 'body' },
    el('div', { class: 't' }, MODE_LABEL[t.mode] || t.mode, t.eligibleM ? ` · ~${fmtDistance(Math.round(t.eligibleM / 100) * 100)}` : ''),
    el('div', { class: 's' }, new Date(t.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), t.reasons?.[0] ? ` · ${esc(t.reasons[0])}` : ''),
    el('div', { class: 'meta' }, chip(TRIP_STATUS[t.status] || { text: t.status, cls: '' }), t.status === 'completed' && (t.basePoints + t.distancePoints) ? chip({ text: `+${t.basePoints + t.distancePoints} pts`, cls: 'live' }) : null)))))
    : el('div', { class: 'empty small' }, sum.tripPoints ? 'No finished trips yet. Navigate a route to its end to earn trip points.' : 'Trip points are off. Turn them on under “How it works”.');

  return el('div', {}, card,
    el('h3', { class: 'pts-h' }, 'Your contributions'), contribList,
    el('h3', { class: 'pts-h' }, 'Recent trips'), tripList,
    el('h3', { class: 'pts-h' }, 'Points activity'),
    ledger.entries.length ? list : el('div', { class: 'empty' }, el('div', { class: 'big' }, '🌱'), 'No points yet. Verified reports, approved paths and verified trips all count.'),
    more);
}

// ---------------------------------------------------------------- leaderboards
let lbState = { scope: 'public', period: 'week' };
async function leaderboardTab(ctx) {
  const [pol, sum] = await Promise.all([policy(ctx), ctx.backend.myPointsSummary()]);
  const wrap = el('div');
  const seg = el('div', { class: 'segmented', role: 'tablist' });
  const opts = [['public:week', 'Weekly'], ['public:all', 'All-time'], ['friends:week', 'Friends · week'], ['friends:all', 'Friends · all']];
  const key = () => `${lbState.scope}:${lbState.period}`;
  const drawSeg = () => seg.replaceChildren(...opts.map(([k, label]) => el('button', { role: 'tab', 'aria-selected': String(k === key()), class: k === key() ? 'on' : '', onclick: () => { [lbState.scope, lbState.period] = k.split(':'); drawSeg(); load(); } }, label)));
  drawSeg();

  const pub = el('input', { type: 'checkbox', checked: sum.leaderboardOptIn });
  const fr = el('input', { type: 'checkbox', checked: sum.friendsBoardOptIn });
  const savePref = async (patch, input) => { input.disabled = true; try { await ctx.backend.setPointsPrefs(patch); toast('Saved'); load(); } catch (e) { input.checked = !input.checked; toast(e.message, 'error'); } input.disabled = false; };
  pub.onchange = () => savePref({ leaderboardOptIn: pub.checked }, pub);
  fr.onchange = () => savePref({ friendsBoardOptIn: fr.checked }, fr);
  const privacy = el('details', { class: 'card privacy-card' },
    el('summary', {}, '🔒 Who can see me on leaderboards'),
    el('label', { class: 'row', style: 'gap:10px;margin:8px 0' }, pub, el('span', { class: 'small' }, el('strong', {}, 'Public leaderboards'), ' — show my alias, level and points to everyone.')),
    el('label', { class: 'row', style: 'gap:10px;margin:8px 0' }, fr, el('span', { class: 'small' }, el('strong', {}, 'Friends leaderboard'), ' — show my alias, level and points to my accepted friends.')),
    el('p', { class: 'small muted', style: 'margin:4px 0 0' }, 'Leaderboards never show your location, routes, trip distances or times. Hidden or not, you still earn points and levels, and navigation and trip sharing work the same.'));

  const table = el('div', { class: 'lb-list' });
  const foot = el('div');
  let offset = 0, total = 0;
  const pageSize = 20;
  const row = (r) => el('div', { class: `lb-row ${r.isMe ? 'me' : ''}` },
    el('span', { class: 'rank', 'aria-label': `Rank ${r.rank}` }, `#${r.rank}`),
    el('div', { style: 'min-width:0' }, el('div', { class: 'lb-name' }, esc(r.alias), r.isMe ? el('span', { class: 'chip live', style: 'margin-left:6px' }, 'You') : null, r.sample ? el('span', { class: 'chip sample', style: 'margin-left:6px' }, 'Sample') : null),
      el('div', { class: 'small muted' }, `Level ${r.level} · ${levelName(r.level, pol.levels)}`)),
    el('strong', {}, String(r.points)));
  const periodNote = el('p', { class: 'small muted', style: 'margin:8px 0' });
  async function load(append = false) {
    periodNote.textContent = lbState.period === 'week'
      ? `This week (from Mon ${weekStart().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}). Resets Monday 00:00 UK time — in ${untilReset()}. Reversed and unverified points don't count. Tied scores share a rank.`
      : 'All-time points (after any reversals). Tied scores share a rank.';
    if (!append) { offset = 0; table.replaceChildren(loading('Loading leaderboard…')); foot.replaceChildren(); }
    try {
      const page = await ctx.backend.leaderboardPage({ scope: lbState.scope, period: lbState.period, offset, limit: pageSize });
      if (!append) table.replaceChildren();
      total = page.total;
      if (!page.rows.length && !append) {
        table.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'big' }, lbState.scope === 'friends' ? '🫂' : '🏁'),
          lbState.scope === 'friends' ? 'No friends on this board yet. Friends appear once they turn on “Friends leaderboard”.'
            : lbState.period === 'week' ? 'No points yet this week — verified reports, approved paths and verified trips all count.' : 'Nobody has joined the public leaderboard yet.'));
      }
      table.append(...page.rows.map(row));
      offset += page.rows.length;
      const onPage = page.rows.some((r) => r.isMe) || [...table.querySelectorAll('.lb-row.me')].length;
      foot.replaceChildren(...[
        offset < total ? el('button', { class: 'btn sm ghost block', style: 'margin-top:6px', onclick: (e) => { e.target.disabled = true; load(true); } }, `Show more (${total - offset} more)`) : null,
        !onPage && page.me ? el('div', { style: 'margin-top:8px' }, el('div', { class: 'small muted', style: 'margin-bottom:4px' }, 'Your position'), row(page.me)) : null,
        !page.me && !append ? el('div', { class: 'notice', style: 'margin-top:8px' }, lbState.scope === 'public'
          ? (sum.leaderboardOptIn ? (lbState.period === 'week' ? 'You will appear here once you earn points this week.' : 'You will appear here once you have points.') : 'You are hidden from public leaderboards. Turn it on above if you want to join in.')
          : 'Friends only see you if you turn on “Friends leaderboard” above.') : null].filter(Boolean));
    } catch (e) { table.replaceChildren(errorBox(e, () => load())); }
  }
  wrap.append(seg, periodNote, table, foot, privacy,
    !ctx.backend.isShared ? el('p', { class: 'small muted', style: 'margin-top:8px' }, 'Demo mode: leaderboards only include sample users and accounts created on this device.') : null);
  load();
  return wrap;
}

// ---------------------------------------------------------------- guide
async function guideTab(ctx) {
  const [pol, sum] = await Promise.all([policy(ctx), ctx.backend.myPointsSummary()]);
  const r = pol.rules, t = pol.trip;
  const groups = {};
  for (const [k, v] of Object.entries(r)) if (!v.retired && v.points != null && k !== 'reversal') (groups[v.group] ||= []).push(v);
  const capTxt = (v) => (v.dailyCap ? `max ${v.dailyCap}/day` : '');
  const tripToggle = el('input', { type: 'checkbox', checked: sum.tripPoints });
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
    el('label', { class: 'card row', style: 'gap:10px;align-items:flex-start;margin-top:8px' }, tripToggle,
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
