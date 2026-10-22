// Friends, live-location sharing and trip sharing screens.
import { $, el, esc, fmtAgo, fmtDistance, fmtDuration, haversine } from '../util.js';
import { state, set, selectedRoute } from '../state.js';
import { SHARE_DURATIONS, SHARED_TRIP_BONUS, SHARE_STALE_SECONDS, SHARE_LOST_SECONDS, FRIEND_LIMITS, POINTS, TRIP_LIMITS, sharedTripBonusFor } from '../backend/rules.js';
import { openModal, closeModal, isModalOpen } from './modal.js';
import { toast } from './sheet.js';
import { requireSignIn } from './account.js';

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
              out ? el('span', { class: 'chip accent' }, out.type === 'trip' ? 'Sharing trip' : 'Sharing location') : null,
              inc ? el('span', { class: 'chip verified' }, inc.type === 'trip' ? 'Following their trip' : 'Can see their location') : null),
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
// Trip sharing (offered when navigation starts)
// ============================================================
export async function openShareTrip(ctx, onDone) {
  const r = selectedRoute(); const dest = state.destination;
  if (!r || !dest) return onDone?.(null);
  const social = await ctx.backend.listSocial();
  if (!social.friends.length) { toast('Add a friend first to share trips'); return onDone?.(null); }
  let friend = social.friends[0];
  const picker = el('select', { onchange: (e) => { friend = social.friends.find((f) => f.id === e.target.value); } }, ...social.friends.map((f) => el('option', { value: f.id }, f.alias)));
  const optIn = el('input', { type: 'checkbox', id: 'tripRewardOptIn' });
  const bonusPreview = sharedTripBonusFor(r.distanceM);
  const share = el('button', { class: 'btn primary block', onclick: async () => {
    try {
      const s = await ctx.backend.startTripShare(friend.id, { destName: dest.name, destLat: dest.lat, destLng: dest.lng, geometry: r.geometry, routeDistanceM: r.distanceM, durationS: r.durationS, rewardOptIn: optIn.checked });
      if (state.position) await ctx.backend.updateSharePosition(s.id, state.position);
      closeModal(); onDone?.(s);
    } catch (e) { toast(e.message, 'error'); }
  } }, 'Share this trip');
  openModal('Share your trip?', [
    el('p', { class: 'muted small' }, `${esc(dest.name)} · ${fmtDistance(r.distanceM)} · about ${fmtDuration(r.durationS)}`),
    el('div', { class: 'field' }, el('label', {}, 'Share with'), picker),
    el('div', { class: 'consent' },
      el('div', { class: 'consent-row' }, '🗺️', el('div', {}, el('strong', {}, 'They see your route, position and progress'), el('div', { class: 'small muted' }, 'plus an estimated arrival time, only while this trip is active and the app is open.'))),
      el('div', { class: 'consent-row' }, '🏁', el('div', {}, el('strong', {}, 'Ends when you arrive, cancel, or the session times out'), el('div', { class: 'small muted' }, `Session limit ${Math.min(240, Math.ceil(r.durationS / 30) + 15)} min. Your position is deleted when it ends.`))),
      el('div', { class: 'consent-row' }, '↔️', el('div', {}, el('strong', {}, 'They do not share back'), el('div', { class: 'small muted' }, 'unless they separately choose to.')))),
    el('label', { class: 'row', style: 'gap:10px;margin:12px 0;align-items:flex-start' }, optIn, el('span', { class: 'small' }, el('strong', {}, 'Opt into shared-trip rewards'), ` — if ${esc(friend.alias)} also opts in and you check in at your destination, you both earn a bonus based on distance travelled along the route (this trip: up to +${bonusPreview}). Checking in earns the normal +${POINTS.trip_completed} either way.`)),
    share,
    el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: () => { closeModal(); onDone?.(null); } }, 'Navigate without sharing'),
  ], { onClose: () => onDone?.(undefined) });
}

// ============================================================
// Active-share banner (traveller side) + friend markers (viewer side)
// ============================================================
export function renderShareBanner(ctx, shares) {
  const host = $('#shareBanner');
  const outgoing = shares.filter((s) => s.direction === 'outgoing' && s.status !== 'ended');
  const recentlyEnded = shares.filter((s) => s.direction === 'outgoing' && s.status === 'ended' && s.endedAt && Date.now() - new Date(s.endedAt) < 60000 && !ctx.dismissed?.has(s.id));
  host.hidden = !outgoing.length && !recentlyEnded.length;
  host.replaceChildren(
    ...outgoing.map((s) => el('div', { class: `sharepill ${s.status}` },
      el('span', { class: 'dot' }),
      el('div', { class: 'sharepill-text' },
        el('strong', {}, s.status === 'paused' ? 'Paused' : s.type === 'trip' ? `Sharing trip with ${esc(s.to.alias)}` : `Sharing location with ${esc(s.to.alias)}`),
        el('span', {}, `since ${clock(s.startedAt)} · ends ${clock(s.endsAt)} (${minsLeft(s.endsAt)} min)`)),
      s.status === 'active'
        ? el('button', { class: 'btn sm', onclick: () => ctx.backend.pauseShare(s.id) }, 'Pause')
        : el('button', { class: 'btn sm', onclick: () => ctx.backend.resumeShare(s.id) }, 'Resume'),
      el('button', { class: 'btn sm danger', onclick: () => ctx.backend.stopShare(s.id) }, 'Stop'))),
    ...recentlyEnded.map((s) => el('div', { class: 'sharepill ended' }, el('span', { class: 'dot' }),
      el('div', { class: 'sharepill-text' }, el('strong', {}, 'Sharing ended'), el('span', {}, `${s.to.alias} · ${endedLabel(s.endedReason)}`)),
      el('button', { class: 'btn sm ghost', onclick: () => { (ctx.dismissed ||= new Set()).add(s.id); renderShareBanner(ctx, shares); } }, 'OK'))));
}
export const endedLabel = (r) => ({ expired: 'time limit reached', stopped: 'you stopped it', arrived: 'arrived', blocked: 'blocked', unfriended: 'no longer friends', replaced: 'replaced by a new session', cancelled: 'trip cancelled' }[r] || 'ended');

// ============================================================
// Viewing a friend's share (recipient side)
// ============================================================
export function openShareViewer(ctx, share) {
  const f = freshness(share);
  const liveTxt = { live: 'Live', stale: `Last seen ${fmtAgo(share.lastPos?.at)}`, lost: `Connection lost · last seen ${fmtAgo(share.lastPos?.at)}`, none: share.status === 'paused' ? 'Paused by them' : 'Waiting for first position…' }[f];
  const chipCls = { live: 'live', stale: 'pending', lost: 'danger', none: '' }[f];
  const body = [];
  if (share.status === 'ended') {
    body.push(el('div', { class: 'empty' }, el('div', { class: 'big' }, share.endedReason === 'arrived' ? '🏁' : '⏹️'), el('strong', {}, share.endedReason === 'arrived' ? `${esc(share.from.alias)} arrived` : 'Sharing ended'), el('div', { class: 'muted small' }, endedLabel(share.endedReason), share.endedAt ? ` · ${fmtAgo(share.endedAt)}` : '')));
    if (share.trip?.bonusPoints) body.push(el('div', { class: 'notice info' }, `Shared-trip bonus: +${share.trip.bonusPoints} points for both of you.`));
  } else {
    body.push(el('div', { class: 'row wrap', style: 'margin-bottom:8px' }, el('span', { class: `chip ${chipCls}` }, liveTxt), share.sample ? el('span', { class: 'chip sample' }, 'Sample · scripted') : null));
    body.push(el('p', { class: 'muted small' }, `Started ${clock(share.startedAt)} · ends ${clock(share.endsAt)} (${minsLeft(share.endsAt)} min left). Only you can see this.`));
    if (share.trip) {
      const t = share.trip; const pct = t.routeDistanceM ? Math.min(100, Math.round((t.progressM / t.routeDistanceM) * 100)) : 0;
      const rem = Math.max(0, t.routeDistanceM - t.progressM);
      const etaKnown = share.lastPos && f !== 'lost';
      const eta = etaKnown ? new Date(Date.now() + (rem / (t.routeDistanceM / t.durationS)) * 1000) : null;
      body.push(el('div', { class: 'card' },
        el('div', { class: 'row between' }, el('strong', {}, `→ ${esc(t.destName)}`), el('span', { class: 'muted small' }, `${fmtDistance(rem)} to go`)),
        el('div', { class: 'levelbar' }, el('i', { style: `width:${pct}%` })),
        el('div', { class: 'row between small muted' }, el('span', {}, `${pct}% of route`), el('span', {}, eta ? `ETA ~${clock(eta.toISOString())} (estimate)` : 'ETA unavailable'))));
      const both = t.rewardOptIn?.[share.from.id] && t.rewardOptIn?.[share.to.id];
      const mineOpt = t.rewardOptIn?.[state.user?.id];
      body.push(el('div', { class: 'notice' }, both ? `Shared-trip rewards: both opted in. Up to +${sharedTripBonusFor(t.routeDistanceM)} each if they check in at the destination.`
        : mineOpt ? 'You opted into shared-trip rewards; waiting for them.' : `${esc(share.from.alias)} ${t.rewardOptIn?.[share.from.id] ? 'opted into' : 'has not opted into'} shared-trip rewards.`),
        !mineOpt ? el('button', { class: 'btn sm', style: 'margin-top:6px', onclick: async () => { await ctx.backend.optInTripReward(share.id); toast('Opted in — this does not share your location', 'success'); closeModal(); } }, 'Opt in to rewards (no location sharing)') : null);
    }
    body.push(el('div', { class: 'row', style: 'margin-top:10px' },
      share.lastPos ? el('button', { class: 'btn primary', onclick: () => { closeModal(); ctx.map.flyTo([share.lastPos.lat, share.lastPos.lng], 16); } }, 'Show on map') : null,
      el('button', { class: 'btn', onclick: () => { closeModal(); openShareLocation(ctx, share.from); } }, 'Share mine back')));
    body.push(el('p', { class: 'small', style: 'color:var(--text-3);margin-top:8px' }, 'Sharing back is a separate choice — seeing their location does not give them yours.'));
  }
  openModal(share.type === 'trip' ? `${esc(share.from.alias)}'s trip` : `${esc(share.from.alias)}'s location`, body);
}

function sharingTab(ctx, shares) {
  const active = shares.filter((s) => s.status !== 'ended'), ended = shares.filter((s) => s.status === 'ended');
  const row = (s) => el('button', { class: 'item', style: 'text-align:left;border:0;width:100%', onclick: () => (s.direction === 'incoming' ? openShareViewer(ctx, s) : null) },
    el('div', { class: 'emoji' }, s.type === 'trip' ? '🧭' : '📡'),
    el('div', { class: 'body' },
      el('div', { class: 't' }, s.direction === 'outgoing' ? `You → ${esc(s.to.alias)}` : `${esc(s.from.alias)} → you`),
      el('div', { class: 's' }, s.status === 'ended' ? `Ended · ${endedLabel(s.endedReason)}` : `${s.type === 'trip' ? 'Trip' : 'Location'} · ${s.status} · ends ${clock(s.endsAt)}`),
      el('div', { class: 'meta' }, s.status !== 'ended' && s.direction === 'incoming' ? el('span', { class: `chip ${{ live: 'live', stale: 'pending', lost: 'danger', none: '' }[freshness(s)]}` }, { live: 'Live', stale: 'Stale', lost: 'Connection lost', none: 'No position yet' }[freshness(s)]) : null, s.sample ? el('span', { class: 'chip sample' }, 'Sample') : null)),
    s.direction === 'outgoing' && s.status !== 'ended' ? el('button', { class: 'btn sm danger', onclick: (e) => { e.stopPropagation(); ctx.backend.stopShare(s.id); } }, 'Stop') : null);
  return el('div', {},
    el('p', { class: 'muted small' }, 'Everything you are sharing and everything shared with you. Sharing is always time-limited and one-directional.'),
    active.length ? el('div', { class: 'list' }, ...active.map(row)) : el('div', { class: 'empty' }, 'Nothing is being shared right now.'),
    ended.length ? el('div', {}, el('h3', { style: 'font-size:14px;margin:12px 0 6px' }, 'Recently ended'), el('div', { class: 'list' }, ...ended.slice(0, 5).map(row))) : null,
    el('div', { class: 'notice', style: 'margin-top:12px' }, 'How the shared-trip bonus works: ', SHARED_TRIP_BONUS.bands.map((b) => `${fmtDistance(b.minM)}+ → +${b.points}`).join(' · '), `. Max +${SHARED_TRIP_BONUS.maxPerTrip} per trip, +${SHARED_TRIP_BONUS.dailyCap} per day. Distance counts progress along the chosen route only.`));
}

// ============================================================
// Arrival check-in
// ============================================================
export function openCheckIn(ctx, { shareId, route, dest }, onDone) {
  const near = state.position ? haversine([state.position.lat, state.position.lng], [dest.lat, dest.lng]) : null;
  const btn = el('button', { class: 'btn primary block', onclick: async () => {
    btn.disabled = true;
    try {
      const res = await ctx.backend.tripCheckIn({ shareId, routeDistanceM: route.distanceM, destLat: dest.lat, destLng: dest.lng, position: state.position });
      closeModal();
      const total = res.basePoints + res.bonusPoints;
      if (total > 0) toast(`Checked in: +${res.basePoints} trip${res.bonusPoints ? ` · +${res.bonusPoints} shared-trip bonus (${fmtDistance(res.eligibleM)})` : ''}`, 'success');
      else toast(res.reasons[0] || 'Checked in', res.reasons.length ? 'error' : 'success');
      if (total > 0 && res.reasons.length) toast(res.reasons[0]);
      onDone?.(res);
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  } }, 'Check in — I have arrived');
  openModal('Arrived?', [
    el('p', {}, `Check in at ${esc(dest.name)} to earn +${POINTS.trip_completed} points${shareId ? ', plus any shared-trip bonus' : ''}. Optional — you can skip it.`),
    near != null && near > TRIP_LIMITS.arrivalRadiusM ? el('div', { class: 'notice warn' }, `You appear to be ${fmtDistance(near)} from the destination. Check-in only awards points within ${TRIP_LIMITS.arrivalRadiusM} m.`) : null,
    btn,
    el('button', { class: 'btn block ghost', style: 'margin-top:8px', onclick: () => { closeModal(); onDone?.(null); } }, shareId ? 'Skip (ends trip sharing)' : 'Skip'),
  ], { onClose: () => onDone?.(null) });
}
