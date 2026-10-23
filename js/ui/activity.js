// Activity tab — one place for what happened: trips, points, map contributions and friend sharing.
// Things that need the user (friend requests, trip invitations, requested changes) sit at the top.
// Only the user's own records and shares they are part of are shown; ended shares never show a destination or position.
import { el, esc, fmtAgo, fmtDistance } from '../util.js';
import { state } from '../state.js';
import { ALERT_CATEGORIES } from '../backend/rules.js';
import { policy, chip, ruleLabel, ENTRY_STATUS, CONTRIB_STATUS, TRIP_STATUS, MODE_LABEL, contribTitle } from './points.js';
import { openShareViewer, endedLabel, openFriends } from './friends.js';
import { guestState } from './account.js';
import { avatar } from './avatar.js';
import { toast } from './sheet.js';

const FILTERS = [['all', 'All'], ['trips', 'Trips'], ['points', 'Points'], ['contrib', 'Contributions'], ['friends', 'Friends']];
let filter = 'all';
let shown = 30;
export function setActivityFilter(f) { if (FILTERS.some(([k]) => k === f)) { filter = f; shown = 30; } }

const dayKey = (d) => d.toISOString().slice(0, 10);
function dayLabel(d) {
  const today = new Date(); const y = new Date(Date.now() - 86400000);
  if (dayKey(d) === dayKey(today)) return 'Today';
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
const time = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const modeEmoji = (m) => (MODE_LABEL[m] || '🧭').split(' ')[0];

/** Count of things waiting for the user — shown as the Activity tab badge. */
export function attentionCount(social, shares) {
  const req = social?.incoming?.length || 0;
  const inv = (shares || []).filter((s) => s.direction === 'incoming' && s.type === 'trip' && s.status === 'invited').length;
  return req + inv;
}

function feedItem({ ico, title, sub, chips = [], right = null, at, action = null }) {
  return el('li', { class: 'item' },
    typeof ico === 'string' ? el('span', { class: 'ico', 'aria-hidden': 'true' }, ico) : ico,
    el('div', { class: 'body' },
      el('div', { class: 't' }, title),
      sub ? el('div', { class: 's' }, sub) : null,
      chips.filter(Boolean).length ? el('div', { class: 'meta' }, ...chips.filter(Boolean)) : null,
      action ? el('div', { class: 'row wrap', style: 'margin-top:8px' }, action) : null),
    el('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:4px' }, right, el('span', { class: 'when' }, time(at))));
}

export async function renderActivityPage(ctx, page) {
  page.setActions(state.user ? el('button', { class: 'btn sm ghost', 'aria-label': 'Notification settings', onclick: () => ctx.showTab('profile', { focus: true, anchor: 'set-notify' }) }, '🔔 Settings') : null);
  if (!state.user) return guestState(ctx, {
    icon: '🔔', title: 'Your activity lives here',
    text: 'Trip summaries, points, the progress of your reports and path suggestions, and friend sharing — all in one feed.',
    bullets: ['Points only for verified contributions and finished trips', 'Friend requests and trip invitations to respond to', 'Nothing about anyone’s location unless they shared it with you'],
  });

  const [pol, social, shares, ledger, trips, contribs] = await Promise.all([
    policy(ctx),
    ctx.backend.listSocial().catch(() => null),
    ctx.backend.listShares().catch(() => []),
    ctx.backend.myLedger({ offset: 0, limit: 50 }).catch(() => ({ entries: [], total: 0, failed: true })),
    ctx.backend.myTrips().catch(() => []),
    ctx.backend.myContributions().catch(() => []),
  ]);
  ctx.setAttention?.(attentionCount(social, shares));

  // ---------- needs you ----------
  const attn = [];
  for (const r of social?.incoming || []) {
    const btns = el('div', { class: 'row wrap' },
      el('button', { class: 'btn sm primary', onclick: async () => { btns.replaceChildren(el('span', { class: 'spinner' })); try { await ctx.backend.respondFriendRequest(r.id, true); toast(`You and ${esc(r.from.alias)} are now friends. Nothing is shared until one of you chooses to.`, 'success'); } catch (e) { toast(e.message, 'error'); } ctx.refreshPage('activity'); ctx.refreshBadges?.(); } }, 'Accept'),
      el('button', { class: 'btn sm', onclick: async () => { btns.replaceChildren(el('span', { class: 'spinner' })); try { await ctx.backend.respondFriendRequest(r.id, false); } catch (e) { toast(e.message, 'error'); } ctx.refreshPage('activity'); ctx.refreshBadges?.(); } }, 'Decline'));
    attn.push(feedItem({ ico: avatar(r.from.alias, { size: 38 }), title: `${r.from.alias} wants to be friends`, sub: `${r.from.gwId} · ${fmtAgo(r.createdAt)}`, at: new Date(r.createdAt), action: btns }));
  }
  for (const s of shares.filter((x) => x.direction === 'incoming' && x.type === 'trip' && x.status === 'invited')) {
    attn.push(feedItem({ ico: avatar(s.from.alias, { size: 38 }), title: `${s.from.alias} invited you to follow a trip`, sub: `${MODE_LABEL[s.trip.mode] || ''} to ${s.trip.destName}`, chips: [s.sample ? chip({ text: 'Sample', cls: 'sample' }) : null],
      at: new Date(s.startedAt || Date.now()), action: el('button', { class: 'btn sm primary', onclick: () => openShareViewer(ctx, s) }, 'Respond') }));
  }
  for (const c of contribs.filter((x) => x.status === 'changes')) {
    attn.push(feedItem({ ico: c.kind === 'path' ? '🛤️' : '⚠️', title: `Changes requested: ${contribTitle(c).replace(/^\S+\s/, '')}`, sub: c.message ? `“${c.message}”` : 'A moderator asked for changes.', at: new Date(c.reviewedAt || c.createdAt) }));
  }

  // ---------- feed ----------
  const items = [];
  for (const t of trips) {
    const st = TRIP_STATUS[t.status] || { text: t.status, cls: '' };
    const pts = t.status === 'completed' ? (t.basePoints || 0) + (t.distancePoints || 0) : 0;
    items.push({ kind: 'trips', at: new Date(t.endedAt || t.startedAt), node: (at) => feedItem({
      ico: modeEmoji(t.mode), title: `${(MODE_LABEL[t.mode] || 'Trip').replace(/^\S+\s/, '')} trip${t.eligibleM ? ` · ~${fmtDistance(Math.round(t.eligibleM / 100) * 100)}` : ''}`,
      sub: t.reasons?.[0] || (t.status === 'review' ? 'A moderator will check this trip before any points are added.' : null),
      chips: [chip(st)], right: pts ? el('span', { class: 'pts-plus' }, `+${pts}`) : null, at }) });
  }
  for (const c of contribs) {
    const st = CONTRIB_STATUS[c.status] || { text: c.status, cls: '' };
    const awarded = c.award?.status === 'awarded';
    items.push({ kind: 'contrib', at: new Date(c.reviewedAt || c.createdAt), node: (at) => feedItem({
      ico: c.kind === 'path' ? '🛤️' : (ALERT_CATEGORIES[c.category]?.emoji || '⚠️'),
      title: c.kind === 'path' ? `Path suggestion: ${c.name || 'untitled'}` : `${ALERT_CATEGORIES[c.category]?.label || 'Report'}`,
      sub: c.message ? `Moderator: “${c.message}”` : st.text === 'Awaiting review' ? 'Waiting for a moderator to check it.' : null,
      chips: [chip(st), c.award && !awarded ? chip(ENTRY_STATUS[c.award.status] || { text: c.award.status, cls: '' }) : null],
      right: awarded ? el('span', { class: 'pts-plus' }, `+${c.award.points}`) : null, at }) });
  }
  const coveredRules = new Set(['trip_completed', 'trip_distance', 'path_approved', 'alert_verified', 'streetlight_verified']);
  for (const e of ledger.entries) {
    const showInAll = !coveredRules.has(e.rule) || e.status === 'reversed' || e.status === 'reversal' || e.status === 'capped';
    items.push({ kind: 'points', alsoAll: showInAll, at: new Date(e.at), node: (at) => feedItem({
      ico: e.rule === 'reversal' ? '↩️' : e.rule === 'manual_adjustment' ? '🛠️' : e.rule.startsWith('trip') ? '🧭' : e.rule === 'path_approved' ? '🗺️' : '⭐',
      title: ruleLabel(e.rule, pol.rules), sub: e.reason || null,
      chips: [e.status !== 'awarded' ? chip(ENTRY_STATUS[e.status] || ENTRY_STATUS.awarded) : null],
      right: el('span', { class: e.points < 0 ? 'pts-minus' : 'pts-plus' }, e.points > 0 ? `+${e.points}` : String(e.points)), at }) });
  }
  for (const s of shares) {
    if (s.direction === 'incoming' && s.type === 'trip' && s.status === 'invited') continue; // already in "Needs you"
    const out = s.direction === 'outgoing', who = out ? s.to.alias : s.from.alias;
    const what = s.type === 'trip' ? 'trip' : 'location';
    const ended = s.status === 'ended';
    const title = out ? `You shared your ${what} with ${who}` : `${who} shared their ${what} with you`;
    // Destination only while the share is open (the recipient is authorised then); ended shares say only how they ended.
    const sub = ended ? `Ended · ${endedLabel(s.endedReason, s.direction)}` : s.type === 'trip' ? `${MODE_LABEL[s.trip.mode] || ''} to ${s.trip.destName} · ${s.live ? 'live' : 'route only'}` : `Until ${new Date(s.endsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    items.push({ kind: 'friends', at: new Date((ended && s.endedAt) || s.startedAt || Date.now()), node: (at) => feedItem({
      ico: avatar(who, { size: 38 }), title, sub,
      chips: [ended ? null : chip({ text: s.status === 'invited' ? 'Waiting' : 'Active', cls: s.status === 'invited' ? 'pending' : 'live' }), s.sample ? chip({ text: 'Sample', cls: 'sample' }) : null],
      action: !ended ? el('button', { class: 'btn sm', onclick: () => (out ? openFriends(ctx, 'sharing') : ctx.focusShare(s.id)) }, out ? 'Manage' : 'View') : null, at }) });
  }
  items.sort((a, b) => b.at - a.at);

  // ---------- render ----------
  const filters = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter activity' });
  const feedHost = el('div', { class: 'feed' });
  const drawFilters = () => filters.replaceChildren(...FILTERS.map(([k, label]) => el('button', { class: 'fchip', type: 'button', 'aria-pressed': String(k === filter), onclick: () => { filter = k; shown = 30; drawFilters(); drawFeed(); } }, label)));
  function drawFeed() {
    const list = items.filter((i) => (filter === 'all' ? (i.kind !== 'points' || i.alsoAll) : i.kind === filter));
    if (!list.length) {
      const empty = {
        all: ['🌱', 'Nothing here yet', 'Finish a trip, report a hazard or suggest a missing path — updates appear here.'],
        trips: ['🧭', 'No trips yet', state.user?.tripPoints === false ? 'Trip points are off. You can turn them on in Profile › Privacy.' : 'Navigate a planned route to its end to see a trip summary.'],
        points: ['⭐', 'No points yet', 'Points arrive when a moderator verifies your contribution or you finish a trip.'],
        contrib: ['🗺️', 'No contributions yet', 'Use Report or Add path on the Map. You’ll see each one’s review status here.'],
        friends: ['🫂', 'No sharing yet', 'Trips and locations you share with friends, or they share with you, show here.'],
      }[filter];
      feedHost.replaceChildren(el('div', { class: 'state-card' }, el('div', { class: 'big', 'aria-hidden': 'true' }, empty[0]), el('strong', {}, empty[1]), el('p', { class: 'muted small' }, empty[2]),
        filter === 'contrib' || filter === 'all' ? el('button', { class: 'btn sm', onclick: () => ctx.showTab('map', { focus: true }) }, 'Go to map') : null));
      return;
    }
    const nodes = [];
    let lastDay = null, ul = null;
    for (const it of list.slice(0, shown)) {
      const k = dayKey(it.at);
      if (k !== lastDay) { lastDay = k; nodes.push(el('h3', { class: 'feed-day' }, dayLabel(it.at))); ul = el('ul', { class: 'list', style: 'list-style:none;padding:0;margin:0' }); nodes.push(ul); }
      ul.append(it.node(it.at));
    }
    if (list.length > shown) nodes.push(el('button', { class: 'btn sm ghost block', style: 'margin-top:10px', onclick: () => { shown += 30; drawFeed(); } }, `Show more (${list.length - shown})`));
    if (filter === 'points' && ledger.total > ledger.entries.length) nodes.push(el('p', { class: 'small muted', style: 'margin-top:8px' }, `Showing your latest ${ledger.entries.length} of ${ledger.total} points entries.`));
    feedHost.replaceChildren(...nodes);
  }
  drawFilters(); drawFeed();

  return el('div', {},
    attn.length ? el('section', { class: 'attn', 'aria-labelledby': 'attn-h' },
      el('div', { class: 'sec-title' }, el('h2', { id: 'attn-h' }, `Needs you`, el('span', { class: 'count' }, String(attn.length)))),
      el('ul', { class: 'list feed', style: 'list-style:none;padding:0;margin:0 0 6px' }, ...attn)) : null,
    el('div', { class: 'sec' }, filters, feedHost),
    ledger.failed ? el('div', { class: 'notice warn', style: 'margin-top:10px' }, 'Points history could not load right now — the rest of your activity is shown.') : null);
}
