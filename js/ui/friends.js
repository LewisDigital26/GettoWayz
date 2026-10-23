// Friends, live-location sharing and trip sharing screens.
import { $, el, esc, fmtAgo, fmtDistance, fmtDuration, haversine, MODES } from '../util.js';
import { state, set, selectedRoute } from '../state.js';
import { SHARE_DURATIONS, SHARED_TRIP_BONUS, SHARE_STALE_SECONDS, SHARE_LOST_SECONDS, FRIEND_LIMITS, POINTS, TRIP_LIMITS, sharedTripBonusFor } from '../backend/rules.js';
import { openModal, closeModal, isModalOpen } from './modal.js';
import { toast } from './sheet.js';
import { requireSignIn } from './account.js';

const once = (fn) => { let called = false; return (v) => { if (!called) { called = true; fn?.(v); } }; };
const clock = (iso) => { const d = new Date(iso); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const minsLeft = (iso) => Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 60000));
function copyText(text, btn) {
  const done = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1500); };
  navigator.clipboard?.writeText(text).then(done).catch(() => { const r = document.createRange(); r.selectNodeContents(btn.previousSibling); getSelection().removeAllRanges(); getSelection().addRange(r); });
}

/** Position freshness for a share: 'live' | 'stale' | 'lost' | 'none' */
export function freshness(share) {
  if (!share.lastPos) return 'none';
  const age = (Date.now() - new Date(share.lastPos.at)) / 1000;
  if (age > SHARE_LOST_SECONDS) return 'lost';
  if (age > SHARE_STALE_SECONDS) return 'stale';
  return 'live';
}

// ============================================================
// Friends screen
// ============================================================
export async function openFriends(ctx, tab = 'friends') {
  if (!requireSignIn(ctx, 'add friends and share trips')) return;
  const social = await ctx.backend.listSocial();
  const shares = await ctx.backend.listShares();
  const tabs = el('div', { class: 'tabs' });
  const body = el('div');
  const views = {
    friends: () => friendsTab(ctx, social, shares),
    requests: () => requestsTab(ctx, social),
    sharing: () => sharingTab(ctx, shares),
  };
  const labels = { friends: `Friends (${social.friends.length})`, requests: `Requests${social.incoming.length ? ` (${social.incoming.length})` : ''}`, sharing: `Sharing${shares.filter((s) => s.status !== 'ended').length ? ' ●' : ''}` };
  for (const k of Object.keys(views)) tabs.append(el('button', { class: k === tab ? 'active' : '', onclick: () => openFriends(ctx, k) }, labels[k]));
  body.append(views[tab]());

  const idRow = el('div', { class: 'card idcard' },
    el('div', { class: 'small muted' }, 'Your Ghetto Wayz ID — share it with people you want to add'),
    el('div', { class: 'row between' }, el('code', { class: 'gwid' }, social.gwId), el('button', { class: 'btn sm', onclick: (e) => copyText(social.gwId, e.target) }, 'Copy')),
    el('div', { class: 'small', style: 'color:var(--text-3)' }, 'Your ID reveals only your alias. Never your location, email or points.'));

  openModal('Friends', [idRow, tabs, body,
    !ctx.realtime.isCrossDevice ? el('div', { class: 'notice warn', style: 'margin-top:12px' }, ctx.realtime.note, ' Try adding sample user ', el('code', {}, 'GW-KERB-H0P1'), '.') : null]);
}

function friendsTab(ctx, social, shares) {
  const idInput = el('input', { placeholder: 'GW-XXXX-XXXX', autocapitalize: 'characters', spellcheck: 'false', maxlength: '14', id: 'friendIdInput' });
  const result = el('div');
  const find = el('button', { class: 'btn primary', onclick: async () => {
    find.disabled = true; result.replaceChildren(el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Looking up ID…'));
    try {
      const u = await ctx.backend.lookupId(idInput.value);
      result.replaceChildren(u
        ? el('div', { class: 'item' }, el('div', { class: 'emoji' }, '👤'), el('div', { class: 'body' }, el('div', { class: 't' }, esc(u.alias), u.sample ? el('span', { class: 'chip sample', style: 'margin-left:6px' }, 'Sample') : ''), el('div', { class: 's' }, u.gwId)),
            el('button', { class: 'btn sm primary', onclick: async (e) => { try { await ctx.backend.sendFriendRequest(u.id); toast('Request sent — they need to accept before either of you can see the other', 'success'); openFriends(ctx, 'requests'); } catch (err) { toast(err.message, 'error'); } } }, 'Send request'))
        : el('div', { class: 'notice' }, 'No user with that ID. Check the letters and dashes.'));
    } catch (e) { result.replaceChildren(el('div', { class: 'notice danger' }, e.message)); }
    find.disabled = false;
  } }, 'Find');

  const list = social.friends.length
    ? el('div', { class: 'list' }, ...social.friends.map((f) => {
        const out = shares.find((s) => s.direction === 'outgoing' && s.to.id === f.id && s.status !== 'ended');
        const inc = shares.find((s) => s.direction === 'incoming' && s.from.id === f.id && s.status !== 'ended');
        return el('div', { class: 'item' },
          el('div', { class: 'emoji' }, '👤'),
          el('div', { class: 'body' },
            el('div', { class: 't' }, esc(f.alias), f.sample ? el('span', { class: 'chip sample', style: 'margin-left:6px' }, 'Sample') : ''),
            el('div', { class: 's' }, f.gwId),
            el('div', { class: 'meta' },
              out ? el('span', { class: 'chip accent' }, out.type === 'trip' ? (out.status === 'invited' ? 'Trip invite sent' : 'Sharing trip') : 'Sharing location') : null,
              inc ? el('span', { class: 'chip verified' }, inc.type === 'trip' ? (inc.status === 'invited' ? 'Trip invitation' : 'Following their trip') : 'Can see their location') : null),
            el('div', { class: 'row wrap', style: 'margin-top:8px' },
              el('button', { class: 'btn sm primary', onclick: () => openShareLocation(ctx, f) }, '📡 Share location'),
              inc ? el('button', { class: 'btn sm', onclick: () => { closeModal(); ctx.focusShare(inc.id); } }, 'View') : null,
              f.sample ? el('button', { class: 'btn sm ghost', onclick: async () => { try { await ctx.backend.demoSimulateIncomingTrip(f.id); closeModal(); toast('Sample trip started — this is scripted demo movement, not a real person', 'success'); } catch (e) { toast(e.message, 'error'); } } }, '▶ Simulate their trip') : null,
              el('button', { class: 'btn sm ghost', onclick: () => openFriendOptions(ctx, f) }, '⋯'))));
      }))
    : el('div', { class: 'empty' }, el('div', { class: 'big' }, '🫂'), 'No friends yet. Add someone by their ID.');

  return el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Add a friend by ID'), el('div', { class: 'row' }, idInput, find), el('span', { class: 'hint' }, `They must accept before either of you can see the other. Limit ${FRIEND_LIMITS.idLookupsPerHour} searches/hour, ${FRIEND_LIMITS.requestsPerDay} requests/day.`)),
    result,
    el('h3', { style: 'font-size:14px;margin:12px 0 6px' }, 'Your friends'), list);
}

function requestsTab(ctx, social) {
  const setting = el('select', { onchange: async (e) => { await ctx.backend.setRequestSetting(e.target.value); toast(e.target.value === 'none' ? 'Incoming requests turned off' : 'Anyone with your ID can send a request'); } },
    el('option', { value: 'anyone', selected: social.requestSetting === 'anyone' }, 'Anyone with my ID'),
    el('option', { value: 'none', selected: social.requestSetting === 'none' }, 'Nobody (turn off requests)'));
  return el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Who can send me requests'), setting),
    el('h3', { style: 'font-size:14px;margin:12px 0 6px' }, 'Incoming'),
    social.incoming.length ? el('div', { class: 'list' }, ...social.incoming.map((r) => el('div', { class: 'item' }, el('div', { class: 'emoji' }, '📨'),
      el('div', { class: 'body' }, el('div', { class: 't' }, esc(r.from.alias)), el('div', { class: 's' }, `${r.from.gwId} · ${fmtAgo(r.createdAt)}`),
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('button', { class: 'btn sm primary', onclick: async () => { await ctx.backend.respondFriendRequest(r.id, true); toast(`You and ${esc(r.from.alias)} are now friends. Nothing is shared until one of you chooses to.`, 'success'); openFriends(ctx, 'friends'); } }, 'Accept'),
          el('button', { class: 'btn sm', onclick: async () => { await ctx.backend.respondFriendRequest(r.id, false); openFriends(ctx, 'requests'); } }, 'Reject'),
          el('button', { class: 'btn sm ghost', onclick: async () => { await ctx.backend.blockUser(r.from.id); toast('Blocked'); openFriends(ctx, 'requests'); } }, 'Block'))))))
      : el('p', { class: 'muted small' }, 'No incoming requests.'),
    el('h3', { style: 'font-size:14px;margin:12px 0 6px' }, 'Sent'),
    social.outgoing.length ? el('div', { class: 'list' }, ...social.outgoing.map((r) => el('div', { class: 'item' }, el('div', { class: 'emoji' }, '⏳'),
      el('div', { class: 'body' }, el('div', { class: 't' }, esc(r.to.alias)), el('div', { class: 's' }, `Waiting for them to accept · ${fmtAgo(r.createdAt)}`)),
      el('button', { class: 'btn sm ghost', onclick: async () => { await ctx.backend.cancelFriendRequest(r.id); openFriends(ctx, 'requests'); } }, 'Cancel'))))
      : el('p', { class: 'muted small' }, 'No pending sent requests.'),
    social.blocked.length ? el('div', {}, el('h3', { style: 'font-size:14px;margin:12px 0 6px' }, 'Blocked'),
      el('div', { class: 'list' }, ...social.blocked.map((b) => el('div', { class: 'item' }, el('div', { class: 'emoji' }, '🚫'), el('div', { class: 'body' }, el('div', { class: 't' }, esc(b.alias))),
        el('button', { class: 'btn sm ghost', onclick: async () => { await ctx.backend.unblockUser(b.id); openFriends(ctx, 'requests'); } }, 'Unblock'))))) : null);
}

function openFriendOptions(ctx, f) {
  const reason = el('textarea', { placeholder: 'What happened? (optional)', maxlength: '300' });
  openModal(esc(f.alias), [
    el('p', { class: 'muted small' }, f.gwId),
    el('div', { class: 'stack' },
      el('button', { class: 'btn block', onclick: async () => { await ctx.backend.removeFriend(f.id); toast('Friend removed — any sharing between you has ended'); openFriends(ctx); } }, 'Remove friend'),
      el('button', { class: 'btn block danger', onclick: async () => { await ctx.backend.blockUser(f.id); toast('Blocked — all sharing between you ended immediately'); openFriends(ctx); } }, 'Block'),
      el('div', { class: 'field' }, el('label', {}, 'Report misuse'), reason),
      el('button', { class: 'btn block ghost', onclick: async () => { await ctx.backend.reportUser(f.id, reason.value); toast('Report sent to moderators', 'success'); openFriends(ctx); } }, 'Send report'),
      el('button', { class: 'btn block ghost', onclick: () => openFriends(ctx) }, 'Back')),
  ]);
}

// ============================================================
// Location sharing
// ============================================================
export function openShareLocation(ctx, friend) {
  let minutes = SHARE_DURATIONS[1].minutes;
  const pills = el('div', { class: 'row wrap' });
  const render = () => pills.replaceChildren(...SHARE_DURATIONS.map((d) => el('button', { class: `btn sm ${d.minutes === minutes ? 'primary' : ''}`, onclick: () => { minutes = d.minutes; render(); } }, d.label)));
  render();
  const go = async () => {
    try {
      const s = await ctx.backend.startLocationShare(friend.id, minutes);
      await ctx.backend.updateSharePosition(s.id, state.position);
      ctx.locate({ follow: true });
      closeModal(); toast(`Sharing your location with ${esc(friend.alias)} until ${clock(s.endsAt)}`, 'success');
    } catch (e) { toast(e.message, 'error'); start.textContent = 'Start sharing'; start.disabled = false; }
  };
  const start = el('button', { class: 'btn primary block', onclick: () => {
    start.disabled = true;
    if (state.position) return go();
    // Permission is requested here, at the moment it is needed, with the reason shown above.
    start.textContent = 'Waiting for your location…';
    ctx.locate({ onFirst: go });
    setTimeout(() => { if (!state.position && isModalOpen()) { start.textContent = 'Start sharing'; start.disabled = false; if (state.locationStatus === 'denied') toast('Location permission was denied, so sharing cannot start. You can allow it in your browser settings.', 'error'); } }, 16000);
  } }, 'Start sharing');
  openModal('Share live location', [
    el('div', { class: 'consent' },
      el('div', { class: 'consent-row' }, '👤', el('div', {}, el('strong', {}, `Only ${esc(friend.alias)}`), el('div', { class: 'small muted' }, 'can see it. Nobody else — not other friends, not the leaderboard.'))),
      el('div', { class: 'consent-row' }, '⏱️', el('div', {}, el('strong', {}, 'Stops automatically'), el('div', { class: 'small muted' }, 'after the time you pick. There is no "share forever" option. You can pause or stop sooner.'))),
      el('div', { class: 'consent-row' }, '↔️', el('div', {}, el('strong', {}, 'One direction only'), el('div', { class: 'small muted' }, `${esc(friend.alias)} will not share their location with you unless they choose to themselves.`))),
      el('div', { class: 'consent-row' }, '🗑️', el('div', {}, el('strong', {}, 'No history'), el('div', { class: 'small muted' }, 'Only your latest position is kept while sharing, and it is deleted when sharing ends.'))),
      el('div', { class: 'consent-row' }, '📱', el('div', {}, el('strong', {}, 'Works while the app is open'), el('div', { class: 'small muted' }, 'This web app cannot share in the background. If you close it or your phone sleeps, your friend sees "last seen" with the time.')))),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', {}, 'How long?'), pills),
    start,
    el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: closeModal }, 'Not now'),
  ]);
}

// ============================================================
// Route sharing with ONE chosen friend (from the route sheet, or when navigation starts)
// ============================================================
const modeLabel = (m) => `${MODES[m]?.emoji || ''} ${MODES[m]?.label || 'Walk'}`.trim();
/** Outgoing, not-ended trip share for the current destination (if any). */
export function shareForDestination(shares, dest) {
  if (!dest) return null;
  return shares.find((s) => s.direction === 'outgoing' && s.type === 'trip' && s.status !== 'ended' && s.trip
    && haversine([s.trip.destLat, s.trip.destLng], [dest.lat, dest.lng]) < 40) || null;
}

/**
 * Share the selected route with a friend.
 * opts.live      — whether "share my live progress" starts ticked (true when navigation is starting)
 * opts.preselect — friend id to pre-select (used when routing to that friend's location)
 * opts.navigating — shows "Navigate without sharing" instead of "Cancel"
 * onDone(share | null) — null when the user chose not to share
 */
export async function openShareTrip(ctx, onDone, opts = {}) {
  const done = once(onDone);
  const r = selectedRoute(); const dest = state.destination;
  if (!r || !dest) return done(null);
  if (!requireSignIn(ctx, 'share routes with friends')) return done(null);
  openModal('Share route with a friend', [el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Loading your friends…')], { onClose: () => done(null) });
  let social;
  try { social = await ctx.backend.listSocial(); } catch (e) {
    openModal('Share route with a friend', [el('div', { class: 'notice danger' }, `Could not load your friends: ${esc(e.message)}`), el('button', { class: 'btn block', onclick: () => { closeModal(); done(null); } }, 'Close')], { onClose: () => done(null) });
    return;
  }
  if (!social.friends.length) {
    openModal('Share route with a friend', [
      el('div', { class: 'empty' }, el('div', { class: 'big' }, '🫂'), 'You need an accepted friend to share a route.'),
      el('button', { class: 'btn primary block', onclick: () => { closeModal(); done(null); ctx.openFriends?.(); } }, 'Add a friend'),
      el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: () => { closeModal(); done(null); } }, opts.navigating ? 'Navigate without sharing' : 'Close')], { onClose: () => done(null) });
    return;
  }
  // No friend is chosen by default — the traveller picks exactly one.
  let friendId = social.friends.some((f) => f.id === opts.preselect) ? opts.preselect : null;
  let result = null;
  const list = el('div', { class: 'list pick-list' });
  const share = el('button', { class: 'btn primary block', disabled: !friendId }, 'Send invitation');
  const renderList = () => list.replaceChildren(...social.friends.map((f) => el('label', { class: `item pick ${f.id === friendId ? 'on' : ''}` },
    el('input', { type: 'radio', name: 'shareFriend', checked: f.id === friendId, onchange: () => { friendId = f.id; share.disabled = false; renderList(); optLabel(); } }),
    el('div', { class: 'body' }, el('div', { class: 't' }, esc(f.alias), f.sample ? el('span', { class: 'chip sample', style: 'margin-left:6px' }, 'Sample') : ''), el('div', { class: 's' }, f.gwId)))));
  renderList();
  const live = el('input', { type: 'checkbox', checked: !!opts.live });
  const optIn = el('input', { type: 'checkbox' });
  const optText = el('span', { class: 'small' });
  const optLabel = () => { const f = social.friends.find((x) => x.id === friendId); optText.replaceChildren(el('strong', {}, 'Opt into shared-trip rewards'), ` — only counts if ${f ? esc(f.alias) : 'your friend'} accepts and opts in too, your live progress is on, and you check in at the destination (this trip: up to +${sharedTripBonusFor(r.distanceM)} each). Sharing itself never earns points.`); };
  optLabel();
  share.onclick = async () => {
    share.disabled = true; share.textContent = 'Sending…';
    try {
      const s = await ctx.backend.startTripShare(friendId, { destName: dest.name, mode: state.mode, geometry: r.geometry, durationS: r.durationS, rewardOptIn: optIn.checked, live: live.checked, toFriendLocation: dest.friendId === friendId });
      result = s; closeModal(); // onClose → done(result), after the modal is gone (so a follow-up modal isn't closed)
      toast(`Invitation sent to ${esc(s.to.alias)}. They'll see your route once they accept.`, 'success');
      if (live.checked && !state.position) ctx.locate({ follow: true });
    } catch (e) { toast(e.message, 'error'); share.disabled = false; share.textContent = 'Send invitation'; }
  };
  openModal('Share route with a friend', [
    el('p', { class: 'muted small' }, `${esc(dest.name)} · ${modeLabel(state.mode)} · ${fmtDistance(r.distanceM)} · about ${fmtDuration(r.durationS)}`),
    el('div', { class: 'field' }, el('label', {}, 'Who should see this route?'), list, el('span', { class: 'hint' }, 'Only the friend you pick. Never your other friends or the public map.')),
    el('label', { class: 'row', style: 'gap:10px;margin:10px 0;align-items:flex-start' }, live,
      el('span', { class: 'small' }, el('strong', {}, 'Share my live progress during this trip'), ' — your position, progress and ETA, only while you navigate with the app open. You can turn it off or stop sharing at any time.')),
    el('div', { class: 'consent' },
      el('div', { class: 'consent-row' }, '✉️', el('div', {}, el('strong', {}, 'They get an invitation first'), el('div', { class: 'small muted' }, 'They see where you are heading, your travel mode, distance and time. Your route line and position are only shown if they accept.'))),
      el('div', { class: 'consent-row' }, '🏁', el('div', {}, el('strong', {}, 'Ends when you arrive or stop'), el('div', { class: 'small muted' }, `It also expires after ${Math.min(240, Math.ceil(r.durationS / 30) + 15)} min. When it ends your route and position are deleted.`))),
      el('div', { class: 'consent-row' }, '↔️', el('div', {}, el('strong', {}, 'One direction only'), el('div', { class: 'small muted' }, 'They do not share their location back unless they choose to.')))),
    el('label', { class: 'row', style: 'gap:10px;margin:12px 0;align-items:flex-start' }, optIn, optText),
    share,
    el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: () => closeModal() }, opts.navigating ? 'Navigate without sharing' : 'Cancel'),
  ], { onClose: () => done(result) });
}

/** Asked when navigation starts and the route is already shared but live progress is off. */
export function askGoLive(ctx, share, onDone) {
  const done = once(onDone);
  openModal('Share live progress?', [
    el('p', {}, share.status === 'invited'
      ? `You invited ${esc(share.to.alias)} to follow this route. Turn on live progress so they can see where you are once they accept?`
      : `${esc(share.to.alias)} can see your planned route. Turn on live progress so they can see your position, progress and ETA during this trip?`),
    el('p', { class: 'muted small' }, 'Only while you navigate with the app open. Stops when you arrive or press Stop.'),
    el('button', { class: 'btn primary block', onclick: async () => { try { await ctx.backend.setTripLive(share.id, true); } catch (e) { toast(e.message, 'error'); } closeModal(); } }, 'Share live progress'),
    el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: () => closeModal() }, 'Not this time — route only'),
  ], { onClose: () => done(share) });
}

/** Pick a friend who is currently sharing their location with you, and route to where they are. */
export async function openGoToFriend(ctx) {
  if (!requireSignIn(ctx, 'route to a friend')) return;
  openModal('Go to a friend', [el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Checking who is sharing with you…')]);
  let social, shares;
  try { [social, shares] = await Promise.all([ctx.backend.listSocial(), ctx.backend.listShares()]); }
  catch (e) { openModal('Go to a friend', [el('div', { class: 'notice danger' }, esc(e.message))]); return; }
  const rows = social.friends.map((f) => {
    const sh = shares.find((s) => s.direction === 'incoming' && s.from.id === f.id && s.status === 'active' && s.lastPos);
    const fr = sh ? freshness(sh) : 'none';
    return el('div', { class: 'item' }, el('div', { class: 'emoji' }, '👤'),
      el('div', { class: 'body' }, el('div', { class: 't' }, esc(f.alias)),
        el('div', { class: 's' }, sh ? `Location from ${clock(sh.lastPos.at)}${fr === 'live' ? ' · live' : ` · last update ${fmtAgo(sh.lastPos.at)}`}` : 'Not sharing their location with you')),
      sh ? el('button', { class: 'btn sm primary', onclick: () => {
        closeModal();
        if (fr !== 'live') toast(`${esc(f.alias)}'s location is from ${fmtAgo(sh.lastPos.at)} — they may have moved`, 'error');
        ctx.setDestination({ id: 'friend-' + f.id, name: `${f.alias} (location at ${clock(sh.lastPos.at)})`, sub: 'Friend’s shared location — a snapshot, it does not follow them', lat: sh.lastPos.lat, lng: sh.lastPos.lng, source: 'friend', friendId: f.id });
      } }, 'Route here') : null);
  });
  openModal('Go to a friend', [
    el('p', { class: 'muted small' }, 'You can route to a friend while they are sharing their live location with you. The destination is where they were at that moment, it does not move with them.'),
    social.friends.length ? el('div', { class: 'list' }, ...rows) : el('div', { class: 'empty' }, 'No friends yet.'),
    el('p', { class: 'small', style: 'color:var(--text-3);margin-top:8px' }, 'If a friend isn’t listed as sharing, ask them to tap Friends › Share location. Their location is never available without their say-so.'),
  ]);
}

// ============================================================
// Active-share banner (traveller side) + friend markers (viewer side)
// ============================================================
export function renderShareBanner(ctx, shares) {
  const host = $('#shareBanner');
  const outgoing = shares.filter((s) => s.direction === 'outgoing' && s.status !== 'ended');
  const incoming = shares.filter((s) => s.direction === 'incoming' && s.type === 'trip' && s.status !== 'ended');
  // Show at most one recent "ended" notice, and only for endings the other person (or the system) caused —
  // the user already got a toast for the ones they did themselves.
  const ownAction = (s) => (s.direction === 'outgoing' ? ['stopped', 'cancelled', 'replaced'] : ['declined', 'left']).includes(s.endedReason);
  const recentlyEnded = shares.filter((s) => s.status === 'ended' && s.endedAt && Date.now() - new Date(s.endedAt) < 120000 && !ctx.dismissed?.has(s.id)
    && (s.direction === 'outgoing' || s.type === 'trip') && !ownAction(s)).sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt)).slice(0, 1);
  host.hidden = !outgoing.length && !incoming.length && !recentlyEnded.length;
  const noLoc = ['denied', 'unavailable'].includes(state.locationStatus);
  const pill = (cls, title, sub, ...btns) => el('div', { class: `sharepill ${cls}` }, el('span', { class: 'dot' }), el('div', { class: 'sharepill-text' }, el('strong', {}, title), el('span', {}, sub)), ...btns);
  const stopBtn = (s, label = 'Stop sharing') => el('button', { class: 'btn sm danger', onclick: async () => { try { await ctx.backend.stopShare(s.id); if (ctx.activeTripShare === s.id) ctx.activeTripShare = null; toast('Sharing stopped. Your route and position were deleted.'); } catch (e) { toast(e.message, 'error'); } } }, label);
  host.replaceChildren(
    ...outgoing.map((s) => {
      if (s.type !== 'trip') return pill(s.status, s.status === 'paused' ? 'Paused' : `Sharing location with ${esc(s.to.alias)}`, `since ${clock(s.startedAt)} · ends ${clock(s.endsAt)} (${minsLeft(s.endsAt)} min)`,
        s.status === 'active' ? el('button', { class: 'btn sm', onclick: () => ctx.backend.pauseShare(s.id) }, 'Pause') : el('button', { class: 'btn sm', onclick: () => ctx.backend.resumeShare(s.id) }, 'Resume'), stopBtn(s, 'Stop'));
      const liveBtn = s.live
        ? el('button', { class: 'btn sm', onclick: () => ctx.backend.setTripLive(s.id, false).catch((e) => toast(e.message, 'error')) }, 'Pause live')
        : el('button', { class: 'btn sm', onclick: () => ctx.backend.setTripLive(s.id, true).then(() => { if (!state.position) ctx.locate({ follow: true }); }).catch((e) => toast(e.message, 'error')) }, 'Go live');
      if (s.status === 'invited') return pill('invited', `Invitation sent to ${esc(s.to.alias)}`, `Waiting for them to accept · ${s.live ? 'live progress on' : 'route only'} · expires ${clock(s.endsAt)}`, liveBtn, stopBtn(s, 'Cancel'));
      if (s.live) return pill(noLoc ? 'paused' : 'active', `Live: ${esc(s.to.alias)} is following your trip`,
        noLoc ? 'Your location is unavailable, so they see your last update only' : `${modeLabel(s.trip.mode)} to ${esc(s.trip.destName)} · ends when you arrive`, liveBtn, stopBtn(s));
      return pill('paused', `${esc(s.to.alias)} can see your route`, 'Live progress is off — no position is being shared', liveBtn, stopBtn(s));
    }),
    ...incoming.map((s) => s.status === 'invited'
      ? pill('invited', `${esc(s.from.alias)} wants to share a trip`, `${modeLabel(s.trip.mode)} to ${esc(s.trip.destName)}`, el('button', { class: 'btn sm primary', onclick: () => openShareViewer(ctx, s) }, 'View'))
      : pill(s.live && freshness(s) === 'live' ? 'active' : 'paused', `Following ${esc(s.from.alias)}’s trip`,
          !s.live ? 'Live progress is off · route only' : s.lastPos ? (freshness(s) === 'live' ? 'Live' : `Last update ${fmtAgo(s.lastPos.at)}`) : 'Waiting for their first update',
          el('button', { class: 'btn sm', onclick: () => ctx.focusShare(s.id) }, 'View'))),
    ...recentlyEnded.map((s) => pill('ended', s.direction === 'outgoing' ? `Sharing with ${esc(s.to.alias)} ended` : `${esc(s.from.alias)}’s trip sharing ended`, endedLabel(s.endedReason, s.direction),
      el('button', { class: 'btn sm ghost', onclick: () => { (ctx.dismissed ||= new Set()).add(s.id); renderShareBanner(ctx, shares); } }, 'OK'))));
  // let the controls below the banner move down by its real height (it wraps on small screens)
  document.documentElement.style.setProperty('--share-h', `${host.hidden ? 0 : host.offsetHeight}px`);
}
export const endedLabel = (r, dir = 'outgoing') => ({
  expired: 'time limit reached', stopped: dir === 'outgoing' ? 'you stopped it' : 'they stopped sharing', arrived: 'arrived at the destination',
  blocked: 'blocked', unfriended: 'no longer friends', replaced: 'replaced by a newer share', cancelled: 'trip cancelled',
  declined: dir === 'outgoing' ? 'they declined' : 'you declined', left: dir === 'outgoing' ? 'they stopped following' : 'you stopped following',
}[r] || 'ended');

// ============================================================
// Viewing a friend's share (recipient side)
// ============================================================
export function openShareViewer(ctx, share) {
  const f = freshness(share);
  const body = [];
  const title = share.type === 'trip' ? `${esc(share.from.alias)}'s trip` : `${esc(share.from.alias)}'s location`;
  if (share.status === 'ended') {
    body.push(el('div', { class: 'empty' }, el('div', { class: 'big' }, share.endedReason === 'arrived' ? '🏁' : '⏹️'), el('strong', {}, share.endedReason === 'arrived' ? `${esc(share.from.alias)} arrived` : 'Sharing ended'), el('div', { class: 'muted small' }, endedLabel(share.endedReason, 'incoming'), share.endedAt ? ` · ${fmtAgo(share.endedAt)}` : '')));
    if (share.trip?.bonusPoints) body.push(el('div', { class: 'notice info' }, `Shared-trip bonus: +${share.trip.bonusPoints} points for both of you.`));
    return openModal(title, body);
  }
  if (share.type === 'trip' && share.status === 'invited') {
    const t = share.trip;
    const btns = el('div', { class: 'row', style: 'margin-top:12px' });
    const respond = async (accept) => {
      btns.replaceChildren(el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), accept ? 'Accepting…' : 'Declining…'));
      try {
        await ctx.backend.respondTripShare(share.id, accept);
        closeModal();
        toast(accept ? `You're following ${esc(share.from.alias)}'s trip. You'll see their progress while they share it live.` : 'Invitation declined', accept ? 'success' : undefined);
        ctx.refreshData?.();
      } catch (e) { closeModal(); toast(e.message, 'error'); ctx.refreshData?.(); }
    };
    btns.replaceChildren(el('button', { class: 'btn primary', onclick: () => respond(true) }, 'Accept'), el('button', { class: 'btn', onclick: () => respond(false) }, 'Decline'));
    return openModal(`${esc(share.from.alias)} wants to share a trip`, [
      share.sample ? el('span', { class: 'chip sample' }, 'Sample · scripted') : null,
      el('div', { class: 'card' },
        el('div', { class: 'row between' }, el('strong', {}, `→ ${esc(t.destName)}`), el('span', { class: 'muted small' }, modeLabel(t.mode))),
        el('div', { class: 'muted small' }, `${fmtDistance(t.routeDistanceM)} · about ${fmtDuration(t.durationS)}${t.toFriendLocation ? ' · heading to where you shared your location' : ''}`)),
      el('div', { class: 'consent', style: 'margin-top:10px' },
        el('div', { class: 'consent-row' }, '🗺️', el('div', {}, el('strong', {}, 'If you accept'), el('div', { class: 'small muted' }, `you'll see ${esc(share.from.alias)}'s route — and their position, progress and ETA only while they have live sharing on.`))),
        el('div', { class: 'consent-row' }, '🙈', el('div', {}, el('strong', {}, 'Your location stays private'), el('div', { class: 'small muted' }, 'Accepting does not share anything of yours.')))),
      btns,
      el('p', { class: 'small muted', style: 'margin-top:8px' }, `Invitation expires at ${clock(share.endsAt)}.`),
    ]);
  }
  const liveTxt = share.type === 'trip' && !share.live ? 'Live progress off'
    : { live: 'Live', stale: `Last update ${fmtAgo(share.lastPos?.at)}`, lost: `Offline · last update ${fmtAgo(share.lastPos?.at)}`, none: share.status === 'paused' ? 'Paused by them' : 'Waiting for their first update…' }[f];
  const chipCls = share.type === 'trip' && !share.live ? '' : { live: 'live', stale: 'pending', lost: 'danger', none: '' }[f];
  body.push(el('div', { class: 'row wrap', style: 'margin-bottom:8px' }, el('span', { class: `chip ${chipCls}` }, liveTxt), share.sample ? el('span', { class: 'chip sample' }, 'Sample · scripted') : null));
  body.push(el('p', { class: 'muted small' }, `Started ${clock(share.startedAt)} · ends ${clock(share.endsAt)} (${minsLeft(share.endsAt)} min left). Only you can see this.`));
  if (share.trip) {
    const t = share.trip;
    const card = el('div', { class: 'card' }, el('div', { class: 'row between' }, el('strong', {}, `→ ${esc(t.destName)}`), el('span', { class: 'muted small' }, modeLabel(t.mode))));
    if (share.live && share.lastPos) {
      const pct = t.routeDistanceM ? Math.min(100, Math.round((t.progressM / t.routeDistanceM) * 100)) : 0;
      const rem = Math.max(0, t.routeDistanceM - t.progressM);
      const speed = t.durationS ? t.routeDistanceM / t.durationS : MODES[t.mode]?.speed || 1.35;
      const eta = new Date(new Date(share.lastPos.at).getTime() + (rem / speed) * 1000); // from their last update, not from now
      card.append(
        el('div', { class: 'levelbar' }, el('i', { style: `width:${pct}%` })),
        el('div', { class: 'row between small muted' }, el('span', {}, `${pct}% · ${fmtDistance(rem)} to go`),
          el('span', {}, f === 'live' ? `ETA ~${clock(eta.toISOString())} (estimate)` : `ETA was ~${clock(eta.toISOString())} at ${clock(share.lastPos.at)}`)));
      if (f !== 'live') card.append(el('div', { class: 'notice warn', style: 'margin-top:8px' }, `No update since ${clock(share.lastPos.at)} — they may be offline or have closed the app. This is not their current position.`));
    } else {
      card.append(el('div', { class: 'muted small', style: 'margin-top:6px' }, `${fmtDistance(t.routeDistanceM)} · about ${fmtDuration(t.durationS)}`),
        el('div', { class: 'notice', style: 'margin-top:8px' }, share.live ? 'Live progress is on, but no position has arrived yet.' : `${esc(share.from.alias)} hasn't turned on live progress, so you can see the planned route only.`));
    }
    body.push(card);
    const both = t.rewardOptIn?.[share.from.id] && t.rewardOptIn?.[share.to.id];
    const mineOpt = t.rewardOptIn?.[state.user?.id];
    body.push(el('div', { class: 'notice' }, both ? `Shared-trip rewards: both opted in. Up to +${sharedTripBonusFor(t.routeDistanceM)} each if they check in at the destination after travelling it with live progress on.`
      : mineOpt ? 'You opted into shared-trip rewards; waiting for them.' : `${esc(share.from.alias)} ${t.rewardOptIn?.[share.from.id] ? 'opted into' : 'has not opted into'} shared-trip rewards.`),
      !mineOpt ? el('button', { class: 'btn sm', style: 'margin-top:6px', onclick: async () => { try { await ctx.backend.optInTripReward(share.id); toast('Opted in — this does not share your location', 'success'); } catch (e) { toast(e.message, 'error'); } closeModal(); } }, 'Opt in to rewards (no location sharing)') : null);
  }
  body.push(el('div', { class: 'row wrap', style: 'margin-top:10px' },
    share.lastPos ? el('button', { class: 'btn primary', onclick: () => { closeModal(); ctx.map.flyTo([share.lastPos.lat, share.lastPos.lng], 16); } }, 'Show on map')
      : share.trip?.geometry ? el('button', { class: 'btn primary', onclick: () => { closeModal(); const g = share.trip.geometry; ctx.map.flyTo(g[Math.floor(g.length / 2)], 15); } }, 'Show route') : null,
    share.type === 'trip' ? el('button', { class: 'btn', onclick: async () => { try { await ctx.backend.stopShare(share.id); toast('You stopped following this trip'); } catch (e) { toast(e.message, 'error'); } closeModal(); } }, 'Stop following') : null,
    el('button', { class: 'btn ghost', onclick: () => { closeModal(); openShareLocation(ctx, share.from); } }, 'Share mine back')));
  body.push(el('p', { class: 'small', style: 'color:var(--text-3);margin-top:8px' }, 'Sharing back is a separate choice — seeing their trip does not give them your location.'));
  openModal(title, body);
}

function sharingTab(ctx, shares) {
  const active = shares.filter((s) => s.status !== 'ended'), ended = shares.filter((s) => s.status === 'ended');
  const statusText = (s) => s.status === 'ended' ? `Ended · ${endedLabel(s.endedReason, s.direction)}`
    : s.type !== 'trip' ? `Location · ${s.status} · ends ${clock(s.endsAt)}`
    : s.status === 'invited' ? (s.direction === 'outgoing' ? `Invitation sent · waiting · ${s.trip.destName}` : `Invitation · ${modeLabel(s.trip.mode)} to ${s.trip.destName}`)
    : `${modeLabel(s.trip.mode)} to ${s.trip.destName} · ${s.live ? 'live' : 'route only'} · ends ${clock(s.endsAt)}`;
  const row = (s) => el('button', { class: 'item', style: 'text-align:left;border:0;width:100%', onclick: () => (s.direction === 'incoming' ? openShareViewer(ctx, s) : null) },
    el('div', { class: 'emoji' }, s.type === 'trip' ? (s.status === 'invited' ? '✉️' : '🧭') : '📡'),
    el('div', { class: 'body' },
      el('div', { class: 't' }, s.direction === 'outgoing' ? `You → ${esc(s.to.alias)}` : `${esc(s.from.alias)} → you`),
      el('div', { class: 's' }, esc(statusText(s))),
      el('div', { class: 'meta' }, s.status === 'active' && s.direction === 'incoming' && s.live ? el('span', { class: `chip ${{ live: 'live', stale: 'pending', lost: 'danger', none: '' }[freshness(s)]}` }, { live: 'Live', stale: 'Stale', lost: 'Offline', none: 'No position yet' }[freshness(s)]) : null,
        s.status === 'invited' && s.direction === 'incoming' ? el('span', { class: 'chip pending' }, 'Tap to accept or decline') : null, s.sample ? el('span', { class: 'chip sample' }, 'Sample') : null)),
    s.direction === 'outgoing' && s.status !== 'ended' ? el('button', { class: 'btn sm danger', onclick: (e) => { e.stopPropagation(); ctx.backend.stopShare(s.id).then(() => openFriends(ctx, 'sharing')); } }, s.status === 'invited' ? 'Cancel' : 'Stop') : null);
  return el('div', {},
    el('p', { class: 'muted small' }, 'Everything you are sharing and everything shared with you. Sharing is always with one friend, time-limited and one-directional.'),
    active.length ? el('div', { class: 'list' }, ...active.map(row)) : el('div', { class: 'empty' }, 'Nothing is being shared right now.'),
    ended.length ? el('div', {}, el('h3', { style: 'font-size:14px;margin:12px 0 6px' }, 'Recently ended'), el('div', { class: 'list' }, ...ended.slice(0, 5).map(row))) : null,
    el('div', { class: 'notice', style: 'margin-top:12px' }, 'How the shared-trip bonus works: ', SHARED_TRIP_BONUS.bands.map((b) => `${fmtDistance(b.minM)}+ → +${b.points}`).join(' · '), `. Max +${SHARED_TRIP_BONUS.maxPerTrip} per trip, +${SHARED_TRIP_BONUS.dailyCap} per day. Only progress recorded live along the chosen route counts, after your friend accepted. Sharing alone never earns points.`));
}

// ============================================================
// Arrival check-in
// ============================================================
export function openCheckIn(ctx, { shareId, route, dest }, onDoneRaw) {
  const onDone = once(onDoneRaw);
  const near = state.position ? haversine([state.position.lat, state.position.lng], [dest.lat, dest.lng]) : null;
  const btn = el('button', { class: 'btn primary block', onclick: async () => {
    btn.disabled = true;
    try {
      const res = await ctx.backend.tripCheckIn({ shareId, routeDistanceM: route.distanceM, destLat: dest.lat, destLng: dest.lng, position: state.position });
      onDone(res); closeModal();
      const total = res.basePoints + res.bonusPoints;
      if (total > 0) toast(`Checked in: +${res.basePoints} trip${res.bonusPoints ? ` · +${res.bonusPoints} shared-trip bonus (${fmtDistance(res.eligibleM)})` : ''}`, 'success');
      else toast(res.reasons[0] || 'Checked in', res.reasons.length ? 'error' : 'success');
      if (total > 0 && res.reasons.length) toast(res.reasons[0]);
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  } }, 'Check in — I have arrived');
  openModal('Arrived?', [
    el('p', {}, `Check in at ${esc(dest.name)} to earn +${POINTS.trip_completed} points${shareId ? ', plus any shared-trip bonus' : ''}. Optional — you can skip it.`),
    near != null && near > TRIP_LIMITS.arrivalRadiusM ? el('div', { class: 'notice warn' }, `You appear to be ${fmtDistance(near)} from the destination. Check-in only awards points within ${TRIP_LIMITS.arrivalRadiusM} m.`) : null,
    btn,
    el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: () => { closeModal(); onDone?.(null); } }, 'Skip'),
  ], { onClose: () => onDone?.(null) });
}
