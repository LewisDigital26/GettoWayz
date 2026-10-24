// Safety tools: quick share (SOS), arrival timer ("let a friend know if I don't check in"), and the recipient-side alerts.
// Both reuse ordinary location shares (one per friend), tagged on the share row:
//   { sos: true }                 — quick share, 60 min
//   { safety: { dueAt, destName } } — arrival timer; the friend is told if you haven't checked in by dueAt
// Checking in ends the share with reason 'safe'. Nothing extra is stored; positions are deleted when the share ends.
import { el, esc, fmtAgo } from '../util.js';
import { state } from '../state.js';
import { ARRIVAL_TIMERS, SOS_SHARE_MINUTES, EMERGENCY_NUMBER } from '../backend/rules.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';
import { requireSignIn } from './account.js';

const TRUSTED_KEY = 'gw:trusted';
const SEEN_KEY = 'gw:safetySeen';
const clock = (d) => { d = new Date(d); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const callBtn = (cls = 'btn danger block') => el('a', { class: cls, href: `tel:${EMERGENCY_NUMBER}` }, `📞 Call ${EMERGENCY_NUMBER}`);

/** Entry point (home sheet, route sheet, navigation bar). */
export function openSafety(ctx, opts = {}) {
  if (!state.user) {
    return openModal('Safety', [
      el('p', {}, 'In an emergency, call the emergency services.'), callBtn(),
      el('p', { class: 'muted small', style: 'margin-top:12px' }, 'Sign in to share your location with friends in one tap, or to set an arrival timer.'),
      el('button', { class: 'btn block', onclick: () => { closeModal(); requireSignIn(ctx, 'use safety sharing'); } }, 'Sign in'),
    ]);
  }
  const mine = ctx.shares.filter((s) => s.direction === 'outgoing' && s.status !== 'ended' && s.trip?.safety);
  openModal('🛡️ Safety', [
    el('button', { class: 'safety-option sos', onclick: () => openQuickShare(ctx) },
      el('span', { class: 'big' }, '🚨'), el('div', {}, el('strong', {}, 'Quick share'), el('div', { class: 'small muted' }, `Send your live location to trusted friends now, for ${SOS_SHARE_MINUTES} min. They get an SOS alert.`))),
    el('button', { class: 'safety-option', onclick: () => openArrivalTimer(ctx, opts) },
      el('span', { class: 'big' }, '⏱️'), el('div', {}, el('strong', {}, 'Arrival timer'), el('div', { class: 'small muted' }, 'A friend can see where you are, and is told if you don\'t check in by the time you choose.'))),
    mine.length ? el('button', { class: 'btn primary block', style: 'margin-top:8px', onclick: () => { closeModal(); checkInSafe(ctx, mine); } }, `✅ I'm here safe (${mine.length} timer${mine.length > 1 ? 's' : ''})`) : null,
    el('div', { style: 'margin-top:12px' }, callBtn()),
    el('p', { class: 'small', style: 'color:var(--text-3);margin-top:10px' }, 'GettoWayz is not an emergency service. Friends only see alerts while the app is open on their phone, and your location only updates while the app is open on yours.'),
  ]);
}

async function friendPicker(ctx, { title, intro, cta, multi, onGo }) {
  let social;
  try { social = await ctx.backend.listSocial(); } catch (e) { toast(e.message, 'error'); return; }
  if (!social.friends.length) {
    return openModal(title, [el('p', {}, 'You need at least one accepted friend first.'), callBtn(),
      el('button', { class: 'btn block', style: 'margin-top:8px', onclick: () => { closeModal(); ctx.openFriends('friends'); } }, 'Add friends')]);
  }
  const trusted = new Set(load(TRUSTED_KEY, []));
  const boxes = social.friends.map((f) => ({ f, box: el('input', { type: multi ? 'checkbox' : 'radio', name: 'gw-safety-friend', checked: multi ? trusted.has(f.id) : false }) }));
  const go = el('button', { class: 'btn primary block', style: 'margin-top:12px' }, cta);
  go.onclick = async () => {
    const picked = boxes.filter((b) => b.box.checked).map((b) => b.f);
    if (!picked.length) { toast('Pick at least one friend', 'error'); return; }
    if (multi) save(TRUSTED_KEY, picked.map((f) => f.id));
    go.disabled = true; go.textContent = 'Sharing…';
    try { await onGo(picked); } catch (e) { toast(e.message, 'error'); go.disabled = false; go.textContent = cta; }
  };
  openModal(title, [
    el('p', { class: 'muted small' }, intro),
    el('div', { class: 'list' }, ...boxes.map(({ f, box }) => el('label', { class: 'item', style: 'cursor:pointer' }, box, el('div', { class: 'body' }, el('div', { class: 't' }, esc(f.alias)), el('div', { class: 's' }, f.gwId || ''))))),
    go,
  ]);
}

export function openQuickShare(ctx) {
  friendPicker(ctx, {
    title: '🚨 Quick share', multi: true, cta: `Share my location now (${SOS_SHARE_MINUTES} min)`,
    intro: 'Your trusted friends (ticked from last time) see your live location and an SOS alert. Stop any time from the banner.',
    onGo: async (friends) => {
      const res = await Promise.allSettled(friends.map((f) => ctx.backend.startLocationShare(f.id, SOS_SHARE_MINUTES, { sos: true })));
      const ok = res.filter((r) => r.status === 'fulfilled').length;
      if (!ok) throw res[0].reason;
      ctx.locate({ follow: true });
      ctx.refreshShares();
      openModal('Location shared', [   // replaces the picker in place (closing then reopening would desync Back-button history)
        el('p', {}, `${ok} friend${ok > 1 ? 's' : ''} can now see your live location${ok < friends.length ? ` (${friends.length - ok} couldn't be reached)` : ''}.`),
        el('p', { class: 'muted small' }, 'Keep the app open so your position keeps updating. If you are in danger, call the emergency services.'),
        callBtn(),
      ]);
    },
  });
}

export function openArrivalTimer(ctx, { etaS, destName } = {}) {
  // suggest the first timer that covers the route's ETA plus a little slack
  const need = etaS ? etaS / 60 + 5 : 0;
  let pick = ARRIVAL_TIMERS.find((t) => t.dueMinutes >= need) || ARRIVAL_TIMERS.at(-1);
  const seg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Check-in time' },
    ...ARRIVAL_TIMERS.map((t) => { const b = el('button', { 'aria-checked': String(t === pick), onclick: () => { pick = t; [...seg.children].forEach((x) => x.setAttribute('aria-checked', String(x === b))); } }, t.label); return b; }));
  friendPicker(ctx, {
    title: '⏱️ Arrival timer', multi: false, cta: 'Start timer',
    intro: `Pick one friend. They see your live location until you check in, and get an alert if you haven't checked in by then.${destName ? ` Heading to ${destName}.` : ''}`,
    onGo: async ([friend]) => {
      const dueAt = new Date(Date.now() + pick.dueMinutes * 60000).toISOString();
      await ctx.backend.startLocationShare(friend.id, pick.shareMinutes, { safety: { dueAt, destName: destName || null } });
      ctx.locate({ follow: true });
      closeModal(); ctx.refreshShares();
      toast(`Timer set — check in by ${clock(dueAt)}. ${friend.alias} will be told if you don't.`, 'success');
    },
  }).then(() => {
    const body = document.querySelector('#modalBody');
    const list = body?.querySelector('.list');
    if (list) list.before(el('div', { class: 'field' }, el('label', {}, 'Check in within'), seg));
  });
}

/** End arrival-timer shares as "safe". */
export async function checkInSafe(ctx, shares) {
  let n = 0;
  for (const s of shares) { try { await ctx.backend.stopShare(s.id, 'safe'); n++; } catch { /* already ended */ } }
  if (n) toast('Checked in — your friend knows you\'re safe ✅', 'success');
  ctx.refreshShares();
}
/** On arrival while navigating: check in any timer automatically. */
export function autoCheckIn(ctx) {
  const mine = ctx.shares.filter((s) => s.direction === 'outgoing' && s.status !== 'ended' && s.trip?.safety);
  if (mine.length) checkInSafe(ctx, mine);
}

// ---------- recipient side ----------
function notify(title, body) {
  try { navigator.vibrate?.([300, 120, 300]); } catch { /* ignore */ }
  try {
    if ('Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then((r) => r.showNotification(title, { body, icon: 'icons/icon-192.png', tag: title })).catch(() => {});
  } catch { /* ignore */ }
}
/** Called whenever shares refresh (every ~10 s): raise SOS / overdue / checked-in notices once each. */
export function safetyWatch(ctx, shares) {
  if (!state.user) return;
  const seen = new Set(load(SEEN_KEY, []));
  let changed = false;
  const mark = (k) => { seen.add(k); changed = true; };
  for (const s of shares) {
    if (s.direction !== 'incoming' || s.type !== 'location' || !s.trip) continue;
    const who = esc(s.from.alias);
    if (s.trip.sos && s.status !== 'ended' && !seen.has(`sos:${s.id}`)) {
      mark(`sos:${s.id}`);
      notify(`🚨 ${s.from.alias} sent an SOS`, 'Open GettoWayz to see their location.');
      openModal(`🚨 ${who} sent an SOS`, [
        el('p', {}, `${who} used Quick share. You can see their live location for the next hour.`),
        s.lastPos ? el('p', { class: 'muted small' }, `Last update ${fmtAgo(s.lastPos.at)}.`) : el('p', { class: 'muted small' }, 'Waiting for their first position.'),
        el('button', { class: 'btn primary block', onclick: () => { closeModal(); ctx.focusShare(s.id); } }, 'Show on map'),
        el('div', { style: 'margin-top:8px' }, callBtn()),
        el('p', { class: 'small', style: 'color:var(--text-3);margin-top:8px' }, 'Try calling them first. If you think they are in danger, call the emergency services.'),
      ]);
    }
    const sf = s.trip.safety;
    if (!sf) continue;
    if (s.status !== 'ended' && Date.now() > new Date(sf.dueAt) && !seen.has(`late:${s.id}`)) {
      mark(`late:${s.id}`);
      notify(`⚠️ ${s.from.alias} hasn't checked in`, `They planned to arrive by ${clock(sf.dueAt)}.`);
      openModal(`⚠️ ${who} hasn't checked in`, [
        el('p', {}, `${who} set an arrival timer${sf.destName ? ` for ${esc(sf.destName)}` : ''} and expected to be there by ${clock(sf.dueAt)}. They haven't checked in yet.`),
        el('p', { class: 'muted small' }, s.lastPos ? `Their last position was ${fmtAgo(s.lastPos.at)}.` : 'No position has come through — their app may be closed.'),
        el('button', { class: 'btn primary block', onclick: () => { closeModal(); ctx.focusShare(s.id); } }, 'Show last position'),
        el('div', { style: 'margin-top:8px' }, callBtn('btn block')),
        el('p', { class: 'small', style: 'color:var(--text-3);margin-top:8px' }, 'They may just have forgotten — try messaging or calling them first.'),
      ]);
    }
    if (s.status === 'ended' && s.endedReason === 'safe' && !seen.has(`safe:${s.id}`)) {
      mark(`safe:${s.id}`);
      toast(`✅ ${s.from.alias} checked in safe`, 'success');
    }
  }
  if (changed) save(SEEN_KEY, [...seen].slice(-200));
}

/** Ask once for notification permission, so SOS / overdue alerts can show even when the tab is in the background. */
export function askNotifications() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
}
