// Accounts (sign in / create account), the Profile tab and its settings.
import { $, el, esc, fmtAgo } from '../util.js';
import { state, set } from '../state.js';
import { RATE_LIMITS } from '../backend/rules.js';
import { levelInfo } from '../backend/pointsPolicy.js';
import { openGuide, policy, chip, CONTRIB_STATUS, contribTitle } from './points.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';
import { openAdmin } from './admin.js';
import { openFriends, liveSharingCard } from './friends.js';
import { avatar } from './avatar.js';
import { updateProfileTab } from './tabs.js';
import { prefs, setPref } from '../prefs.js';
import { setActivityFilter } from './activity.js';

export const COLOURWAYS = [
  { key: '', name: 'Night Route', desc: 'Charcoal + navy, lime accent', bg: '#16181f', a: '#aaf129', b: '#2bb190', c: '#202b47' },
  { key: 'navy', name: 'Deep Navy', desc: 'All-navy ground, lime + teal', bg: '#141c33', a: '#aaf129', b: '#2bb190', c: '#2b3860' },
  { key: 'day', name: 'Daylight', desc: 'Light, for bright sun', bg: '#eef1f6', a: '#2bb190', b: '#aaf129', c: '#202b47' },
];
export function applyColourway(key, ctx) {
  if (key) document.documentElement.setAttribute('data-colourway', key); else document.documentElement.removeAttribute('data-colourway');
  try { key ? localStorage.setItem('gw:colourway', key) : localStorage.removeItem('gw:colourway'); } catch { /* ignore */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLOURWAYS.find((c) => c.key === key)?.bg || '#16181f');
  ctx?.map?.refreshTiles?.();
  ctx?.redrawMap?.();
}
export function colourwayPicker(ctx) {
  const cur = document.documentElement.getAttribute('data-colourway') || '';
  const grid = el('div', { class: 'swatches' });
  const render = () => grid.replaceChildren(...COLOURWAYS.map((c) => el('button', { class: `swatch ${c.key === (document.documentElement.getAttribute('data-colourway') || '') ? 'selected' : ''}`, onclick: () => { applyColourway(c.key, ctx); render(); } },
    el('div', { class: 'sw', style: `background:${c.bg}` }, el('i', { style: `background:${c.a}` }), el('i', { style: `background:${c.b}` }), el('i', { style: `background:${c.c}` })),
    el('div', { class: 't' }, c.name), el('div', { class: 's' }, c.desc))));
  render();
  return el('div', {}, el('img', { class: 'wordmark', src: 'icons/wordmark.jpg', alt: 'GettoWayz' }), el('h3', { style: 'font-size:14px;margin:0 0 8px' }, 'Colourway'), grid,
    el('p', { class: 'small muted', style: 'margin-top:8px' }, 'All three use the logo palette (navy, lime, teal). Your choice is remembered on this device.'));
}
export function openAppearance(ctx) { openModal('Appearance', [colourwayPicker(ctx)]); }

/** Profile tab avatar (the map's old account button is now the Profile tab). */
export function updateAvatar() { updateProfileTab(); }

/** Returns true if signed in; otherwise opens the sign-in prompt and returns false. */
export function requireSignIn(ctx, action) {
  if (state.user) return true;
  openModal('Sign in to continue', [
    el('p', {}, `You need an account to ${action}. Browsing the map, searching and routing work without one.`),
    el('div', { class: 'card', style: 'margin-bottom:12px' },
      el('div', { class: 'small' }, '🔓 Guest: map, search, routes, alerts, public leaderboard'),
      el('div', { class: 'small', style: 'margin-top:4px' }, '🔐 Account: report and confirm alerts, suggest paths, earn points, friends and trip sharing')),
    el('button', { class: 'btn primary block', onclick: () => openAuth(ctx, 'signin') }, 'Sign in'),
    el('button', { class: 'btn block', style: 'margin-top:8px', onclick: () => openAuth(ctx, 'register') }, 'Create account'),
    el('button', { class: 'btn ghost block', style: 'margin-top:8px', onclick: () => closeModal() }, 'Not now'),
  ]);
  return false;
}

/** Signed-out placeholder for account-only tabs: explains the feature, never shows private data. */
export function guestState(ctx, { icon, title, text, bullets = [] }) {
  return el('div', { class: 'state-card' },
    el('div', { class: 'big', 'aria-hidden': 'true' }, icon),
    el('strong', {}, title),
    el('p', { class: 'muted small' }, text),
    bullets.length ? el('ul', { class: 'guest-list' }, ...bullets.map((b) => el('li', {}, '✓ ', b))) : null,
    el('div', { class: 'row', style: 'margin-top:6px' },
      el('button', { class: 'btn primary', onclick: () => openAuth(ctx, 'signin') }, 'Sign in'),
      el('button', { class: 'btn', onclick: () => openAuth(ctx, 'register') }, 'Create account')),
    el('p', { class: 'small', style: 'color:var(--text-3);margin-top:4px' }, 'The map, search and routes work without an account.'));
}

export function openAccount(ctx) {
  if (!state.user) return openAuth(ctx);
  closeModal();
  ctx.showTab?.('profile', { focus: true });
}

export function openAuth(ctx, mode = 'signin') {
  const emailMode = ctx.backend.authMode === 'email';
  const alias = el('input', { id: 'authAlias', placeholder: 'alias (shown on leaderboard if you opt in)', autocomplete: 'username', maxlength: '20' });
  const email = el('input', { id: 'authEmail', type: 'email', placeholder: 'email (used only to sign in, never shown)', autocomplete: 'email' });
  const pin = emailMode
    ? el('input', { id: 'authPin', type: 'password', placeholder: 'password (8+ characters)', autocomplete: mode === 'signin' ? 'current-password' : 'new-password' })
    : el('input', { id: 'authPin', type: 'password', inputmode: 'numeric', placeholder: '4-digit PIN', maxlength: '4', autocomplete: 'current-password' });
  const go = el('button', { class: 'btn primary block', type: 'submit' }, mode === 'signin' ? 'Sign in' : 'Create account');
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    go.disabled = true;
    try {
      const creds = emailMode ? { alias: alias.value, email: email.value.trim(), password: pin.value } : { alias: alias.value, pin: pin.value };
      const u = mode === 'signin' ? await ctx.backend.signIn(creds) : await ctx.backend.register(creds);
      closeModal(); toast(`Welcome, ${esc(u?.alias || alias.value.trim())}`, 'success');
      ctx.showHome(); ctx.refreshPage?.();
    } catch (err) { toast(err.message, 'error'); go.disabled = false; }
  } },
    (!emailMode || mode === 'register') ? el('div', { class: 'field' }, el('label', { for: 'authAlias' }, 'Alias'), alias, el('span', { class: 'hint' }, 'Use an alias, not your real name. This is all other users ever see.')) : null,
    emailMode ? el('div', { class: 'field' }, el('label', { for: 'authEmail' }, 'Email'), email) : null,
    el('div', { class: 'field' }, el('label', { for: 'authPin' }, emailMode ? 'Password' : 'PIN'), pin),
    go);
  openModal(mode === 'signin' ? 'Sign in' : 'Create account', [
    el('div', { class: 'tabs', role: 'tablist' },
      el('button', { role: 'tab', 'aria-selected': String(mode === 'signin'), class: mode === 'signin' ? 'active' : '', onclick: () => openAuth(ctx, 'signin') }, 'Sign in'),
      el('button', { role: 'tab', 'aria-selected': String(mode === 'register'), class: mode === 'register' ? 'active' : '', onclick: () => openAuth(ctx, 'register') }, 'Create account')),
    form,
    !emailMode ? el('div', { class: 'notice warn', style: 'margin-top:12px' }, 'Demo accounts live only in this browser and are not a secure login. Connect a real auth provider for production (see README).') : null,
    ctx.backend.signInDemoModerator ? el('button', { class: 'btn ghost block', style: 'margin-top:8px', onclick: async () => { await ctx.backend.signInDemoModerator(); closeModal(); toast('Signed in as demo moderator', 'success'); ctx.showHome(); ctx.refreshPage?.(); } }, '🛠️ Try the moderator demo') : null,
  ]);
}

// ================================================================ Profile tab
function sw(checked, onToggle, label) {
  const i = el('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: !!checked, 'aria-label': label });
  i.onchange = async () => { i.disabled = true; try { await onToggle(i.checked); } catch (e) { i.checked = !i.checked; toast(e.message, 'error'); } i.disabled = false; };
  return i;
}
const setRow = (ic, title, sub, control, attrs = {}) => el(control ? 'label' : 'button', { class: 'set-row', ...(control ? {} : { type: 'button' }), ...attrs },
  el('span', { class: 'ic', 'aria-hidden': 'true' }, ic),
  el('span', { class: 'tx' }, el('strong', {}, title), sub ? el('span', {}, sub) : null),
  control || el('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
const group = (id, title, ...rows) => el('section', { class: 'sec', id, 'aria-labelledby': `${id}-h` },
  el('div', { class: 'sec-title' }, el('h2', { id: `${id}-h` }, title)), el('div', { class: 'settings' }, ...rows.filter(Boolean)));

function deviceSettings(ctx) {
  const p = prefs();
  return [
    group('set-access', 'Accessibility',
      setRow('🔠', 'Larger text', 'Bigger text in pages, sheets and directions', sw(p.largeText, (v) => setPref('largeText', v), 'Larger text')),
      setRow('🌀', 'Reduce motion', 'Turns off animations (your system setting is respected too)', sw(p.reduceMotion, (v) => setPref('reduceMotion', v), 'Reduce motion')),
      setRow('🎨', 'Colourway', 'Night Route, Deep Navy or Daylight (high-glare outdoors)', null, { onclick: () => openAppearance(ctx) })),
  ];
}

export async function renderProfilePage(ctx, page) {
  page.setActions();
  if (!state.user) {
    return el('div', {},
      el('div', { class: 'hero' },
        el('div', { class: 'row' }, el('span', { class: 'av', style: '--av:60px;--av-bg:var(--bg-3);color:var(--text-2)', 'aria-hidden': 'true' }, 'G'),
          el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'hero-name' }, 'Guest'), el('div', { class: 'hero-sub' }, 'You are exploring without an account.'))),
        el('ul', { class: 'guest-list', style: 'margin-top:12px' },
          el('li', {}, '✓ Map, search, routes and community alerts'),
          el('li', {}, '✓ The public leaderboard'),
          el('li', {}, '🔐 With an account: earn points, report and confirm alerts, suggest paths, add friends and share trips')),
        el('div', { class: 'row wrap', style: 'margin-top:12px' },
          el('button', { class: 'btn primary', onclick: () => openAuth(ctx, 'signin') }, 'Sign in'),
          el('button', { class: 'btn', onclick: () => openAuth(ctx, 'register') }, 'Create account'))),
      ...deviceSettings(ctx),
      group('set-app', 'About', setRow('📜', 'How points work', 'Rules, trip checks and levels', null, { onclick: () => openGuide(ctx) })),
      el('p', { class: 'small', style: 'color:var(--text-3);margin:14px 2px 0' }, 'Route labels describe what a route is built from — they are not safety ratings.'));
  }
  const u = state.user;
  const [pol, sum, social, shares, contribs, stats] = await Promise.all([
    policy(ctx), ctx.backend.myPointsSummary().catch(() => null), ctx.backend.listSocial().catch(() => null),
    ctx.backend.listShares().catch(() => []), ctx.backend.myContributions().catch(() => []), ctx.backend.myStats?.().catch(() => null) ?? null,
  ]);
  const points = sum?.points ?? u.points;
  const lv = levelInfo(points, sum?.levelFloor ?? u.levelFloor);
  const levels = pol.levels || [];
  const gwId = social?.gwId || u.gwId || '';
  const approved = contribs.filter((c) => ['approved', 'verified'].includes(c.status)).length;
  const pending = contribs.filter((c) => ['pending', 'changes'].includes(c.status)).length;

  const hero = el('section', { class: 'hero', 'aria-label': 'Your profile' },
    el('div', { class: 'row' }, avatar(u.alias, { size: 64 }),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'hero-name' }, u.alias, u.role === 'admin' ? el('span', { class: 'chip accent', style: 'margin-left:8px;vertical-align:middle' }, 'Moderator') : null),
        el('div', { class: 'hero-sub' }, `Level ${lv.level.n} · ${lv.level.name}`),
        gwId ? el('div', { class: 'row', style: 'gap:6px;margin-top:4px' }, el('code', { class: 'gwid', style: 'font-size:14px' }, gwId),
          el('button', { class: 'btn sm ghost', style: 'height:30px', 'aria-label': 'Copy your GettoWayz ID', onclick: (e) => { navigator.clipboard?.writeText(gwId).then(() => toast('ID copied')).catch(() => {}); } }, 'Copy')) : null)),
    el('div', { class: 'levelbar', role: 'progressbar', 'aria-label': 'Progress to next level', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(lv.progress * 100)), style: 'margin-top:14px' }, el('i', { style: `width:${Math.round(lv.progress * 100)}%` })),
    el('div', { class: 'row between small muted' }, el('span', {}, lv.next ? `${lv.toNext} pts to ${lv.next.name}` : 'Top level reached'), el('span', {}, sum ? `+${sum.week} this week` : '')),
    el('div', { class: 'hero-stats' },
      el('div', {}, el('strong', {}, String(points)), el('span', {}, 'points')),
      el('div', {}, el('strong', {}, String(approved)), el('span', {}, 'contributions verified')),
      el('div', {}, el('strong', {}, String(social?.friends.length ?? '—')), el('span', {}, 'friends'))));

  const milestones = el('section', { class: 'sec', 'aria-labelledby': 'ms-h' },
    el('div', { class: 'sec-title' }, el('h2', { id: 'ms-h' }, 'Levels'), el('button', { class: 'link', onclick: () => openGuide(ctx) }, 'How points work')),
    el('div', { class: 'milestones', role: 'list' }, ...levels.map((l) => {
      const cls = l.n < lv.level.n ? 'done' : l.n === lv.level.n ? 'done now' : 'locked';
      return el('div', { class: `ms ${cls}`, role: 'listitem', 'aria-label': `Level ${l.n}, ${l.name}, ${l.n <= lv.level.n ? 'reached' : `needs ${l.min} points`}` },
        el('div', { class: 'lvn', 'aria-hidden': 'true' }, l.n <= lv.level.n ? String(l.n) : '🔒'),
        el('div', { class: 'nm' }, l.name), el('div', { class: 'req' }, l.n === lv.level.n ? 'You are here' : `${l.min} pts`));
    })),
    lv.level.n > levelInfo(points).level.n ? el('p', { class: 'small muted', style: 'margin:4px 2px 0' }, 'Some points were reversed, but you keep the highest level you reached.') : null);

  const recent = contribs.slice(0, 4);
  const contribSec = el('section', { class: 'sec', 'aria-labelledby': 'co-h' },
    el('div', { class: 'sec-title' }, el('h2', { id: 'co-h' }, 'Contributions'), contribs.length ? el('button', { class: 'link', onclick: () => { setActivityFilter('contrib'); ctx.showTab('activity', { focus: true }); } }, 'See all') : null),
    contribs.length ? el('p', { class: 'small muted', style: 'margin:0 2px 8px' }, `${approved} verified or approved · ${pending} awaiting review`) : null,
    recent.length ? el('div', { class: 'list' }, ...recent.map((c) => {
      const st = CONTRIB_STATUS[c.status] || { text: c.status, cls: '' };
      return el('div', { class: 'item', style: 'background:var(--bg-2)' }, el('div', { class: 'body' },
        el('div', { class: 't' }, contribTitle(c)), el('div', { class: 's' }, fmtAgo(c.createdAt)),
        el('div', { class: 'meta' }, chip(st), c.award?.status === 'awarded' ? chip({ text: `+${c.award.points} pts`, cls: 'live' }) : null)));
    })) : el('div', { class: 'state-card' }, el('div', { class: 'big', 'aria-hidden': 'true' }, '🗺️'), el('strong', {}, 'No contributions yet'),
      el('p', { class: 'muted small' }, 'Report a hazard or suggest a missing path from the Map. Points arrive once a moderator checks it.'),
      el('button', { class: 'btn sm', onclick: () => ctx.showTab('map', { focus: true }) }, 'Go to map')));

  const live = liveSharingCard(ctx, shares, () => ctx.refreshPage('profile'));
  const sharingSec = el('section', { class: 'sec', 'aria-labelledby': 'sh-h' },
    el('div', { class: 'sec-title' }, el('h2', { id: 'sh-h' }, 'Location sharing')),
    live || el('p', { class: 'small muted', style: 'margin:0 2px 8px' }, 'You are not sharing your location or a trip with anyone.'),
    el('div', { class: 'settings', style: live ? 'margin-top:10px' : '' },
      setRow('📡', 'Manage sharing', 'Everything you share and everything shared with you', null, { onclick: () => openFriends(ctx, 'sharing') })));

  const reqSel = el('select', { 'aria-label': 'Who can send me friend requests', onchange: async (e) => { try { await ctx.backend.setRequestSetting(e.target.value); toast(e.target.value === 'none' ? 'Friend requests turned off' : 'Anyone with your ID can send a request'); } catch (err) { toast(err.message, 'error'); } } },
    el('option', { value: 'anyone', selected: social?.requestSetting === 'anyone' }, 'Anyone with my ID'),
    el('option', { value: 'none', selected: social?.requestSetting === 'none' }, 'Nobody'));
  const pointsPref = (key, msg) => async (v) => { await ctx.backend.setPointsPrefs({ [key]: v }); set({ user: ctx.backend.currentUser() }); toast(msg(v)); };
  const p = prefs();
  const privacy = group('set-privacy', 'Privacy & visibility',
    sum ? setRow('🏆', 'Public leaderboards', 'Show my alias, level and points to everyone', sw(sum.leaderboardOptIn, pointsPref('leaderboardOptIn', (v) => (v ? 'You now appear on public leaderboards' : 'Hidden from public leaderboards')), 'Public leaderboards')) : null,
    sum ? setRow('🫂', 'Friends leaderboard', 'Show my alias, level and points to accepted friends', sw(sum.friendsBoardOptIn, pointsPref('friendsBoardOptIn', (v) => (v ? 'Friends can see you on their board' : 'Hidden from friends’ boards')), 'Friends leaderboard')) : null,
    el('div', { class: 'set-row' }, el('span', { class: 'ic', 'aria-hidden': 'true' }, '📨'), el('span', { class: 'tx' }, el('strong', {}, 'Friend requests'), el('span', {}, 'Who can send you a request')), reqSel),
    sum ? setRow('🧭', 'Earn points for trips', 'Coarse position checks while navigating, deleted when the trip ends', sw(sum.tripPoints, pointsPref('tripPoints', (v) => (v ? 'Trip points on' : 'Trip points off — no trip checks will be sent')), 'Earn points for trips')) : null);
  const notif = group('set-notify', 'Notifications',
    setRow('👥', 'Friend sharing alerts', 'Pop-ups when a friend shares a trip or location with you', sw(p.notifyShares, (v) => setPref('notifyShares', v), 'Friend sharing alerts')),
    setRow('📨', 'Friend request alerts', 'Pop-ups when someone sends you a friend request', sw(p.notifyRequests, (v) => setPref('notifyRequests', v), 'Friend request alerts')));
  const notifNote = el('p', { class: 'small muted', style: 'margin:8px 2px 0' }, 'Alerts appear only while the app is open and never include a friend’s position. Pending items always show in Activity.');

  const app = group('set-app', 'App',
    setRow('📜', 'How points work', 'Rules, trip checks, levels and leaderboards', null, { onclick: () => openGuide(ctx) }),
    u.role === 'admin' ? setRow('🛠️', 'Moderation & points review', 'Review reports, paths, held trips and reversals', null, { onclick: () => openAdmin(ctx) }) : null,
    u.role === 'admin' ? setRow('➕', 'Add test points', 'Moderators: add or remove points for any user (logged)', null, { onclick: () => openAdmin(ctx, { focus: 'grant' }) }) : null,
    ctx.backend.resetDemo ? setRow('♻️', 'Reset demo data', 'Clears everything stored on this device', null, { onclick: () => { if (confirm('Reset all demo data on this device?')) { ctx.backend.resetDemo(); toast('Demo data reset'); ctx.showHome(); ctx.refreshPage(); } } }) : null,
    setRow('↩️', 'Sign out', null, null, { onclick: async () => { await ctx.backend.signOut(); toast('Signed out'); ctx.showHome(); ctx.refreshPage(); } }));

  return el('div', {}, hero, milestones, contribSec, sharingSec, privacy, notif, notifNote, ...deviceSettings(ctx), app,
    stats ? el('p', { class: 'small muted', style: 'margin:14px 2px 0' }, `Today: ${stats.alertsToday}/${RATE_LIMITS.alertsPerDay} reports · ${stats.pathsToday}/${RATE_LIMITS.pathSuggestionsPerDay} path suggestions`) : null);
}
