// Accounts, points, levels, leaderboard, rules.
import { $, el, esc, fmtAgo } from '../util.js';
import { state } from '../state.js';
import { POINT_RULES, LEVELS, RATE_LIMITS, levelFor } from '../backend/rules.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';
import { openAdmin } from './admin.js';
import { openFriends } from './friends.js';

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
  return el('div', {}, el('img', { class: 'wordmark', src: 'icons/wordmark.jpg', alt: 'Ghetto Wayz' }), el('h3', { style: 'font-size:14px;margin:0 0 8px' }, 'Colourway'), grid,
    el('p', { class: 'small muted', style: 'margin-top:8px' }, 'All three use the logo palette (navy, lime, teal). Your choice is remembered on this device.'));
}
export function openAppearance(ctx) { openModal('Appearance', [colourwayPicker(ctx)]); }

export function updateAvatar() {
  const a = $('#profileAvatar');
  a.textContent = state.user ? state.user.alias[0].toUpperCase() : 'G';
  a.classList.toggle('signed', !!state.user);
}

/** Returns true if signed in; otherwise opens the sign-in prompt and returns false. */
export function requireSignIn(ctx, action) {
  if (state.user) return true;
  openModal('Sign in to continue', [
    el('p', {}, `You need an account to ${action}. Browsing, searching and routing work without one.`),
    el('div', { class: 'card', style: 'margin-bottom:12px' },
      el('div', { class: 'small' }, '🔓 Guest: map, search, routes, view alerts'),
      el('div', { class: 'small', style: 'margin-top:4px' }, '🔐 Account: report alerts, confirm reports, suggest paths, earn points, leaderboard')),
    el('button', { class: 'btn primary block', onclick: () => openAccount(ctx) }, 'Sign in / create account'),
  ]);
  return false;
}

export function openAccount(ctx) {
  if (!state.user) return openAuth(ctx);
  openProfile(ctx);
}

function openAuth(ctx, mode = 'signin') {
  const emailMode = ctx.backend.authMode === 'email';
  const alias = el('input', { placeholder: 'alias (shown on leaderboard if you opt in)', autocomplete: 'username', maxlength: '20' });
  const email = el('input', { type: 'email', placeholder: 'email (used only to sign in, never shown)', autocomplete: 'email' });
  const pin = emailMode
    ? el('input', { type: 'password', placeholder: 'password (8+ characters)', autocomplete: mode === 'signin' ? 'current-password' : 'new-password' })
    : el('input', { type: 'password', inputmode: 'numeric', placeholder: '4-digit PIN', maxlength: '4', autocomplete: 'current-password' });
  const go = el('button', { class: 'btn primary block', onclick: async () => {
    go.disabled = true;
    try {
      const creds = emailMode ? { alias: alias.value, email: email.value.trim(), password: pin.value } : { alias: alias.value, pin: pin.value };
      const u = mode === 'signin' ? await ctx.backend.signIn(creds) : await ctx.backend.register(creds);
      closeModal(); toast(`Welcome, ${esc(u?.alias || alias.value.trim())}`, 'success');
      ctx.showHome();
    } catch (e) { toast(e.message, 'error'); go.disabled = false; }
  } }, mode === 'signin' ? 'Sign in' : 'Create account');
  openModal(mode === 'signin' ? 'Sign in' : 'Create account', [
    el('div', { class: 'tabs' },
      el('button', { class: mode === 'signin' ? 'active' : '', onclick: () => openAuth(ctx, 'signin') }, 'Sign in'),
      el('button', { class: mode === 'register' ? 'active' : '', onclick: () => openAuth(ctx, 'register') }, 'Create account')),
    (!emailMode || mode === 'register') ? el('div', { class: 'field' }, el('label', {}, 'Alias'), alias, el('span', { class: 'hint' }, 'Use an alias, not your real name. This is all other users ever see.')) : null,
    emailMode ? el('div', { class: 'field' }, el('label', {}, 'Email'), email) : null,
    el('div', { class: 'field' }, el('label', {}, emailMode ? 'Password' : 'PIN'), pin),
    go,
    !emailMode ? el('div', { class: 'notice warn', style: 'margin-top:12px' }, 'Demo accounts live only in this browser and are not a secure login. Connect a real auth provider for production (see README).') : null,
    ctx.backend.signInDemoModerator ? el('button', { class: 'btn ghost block', style: 'margin-top:8px', onclick: async () => { await ctx.backend.signInDemoModerator(); closeModal(); toast('Signed in as demo moderator', 'success'); ctx.showHome(); } }, '🛠️ Try the moderator demo') : null,
  ]);
}

async function openProfile(ctx) {
  const u = state.user;
  const { level, next, progress } = levelFor(u.points);
  const history = await ctx.backend.pointHistory(u.id);
  const stats = await ctx.backend.myStats?.();
  const optIn = el('input', { type: 'checkbox' }); optIn.checked = !!u.leaderboardOptIn;
  optIn.addEventListener('change', async () => { await ctx.backend.updateUser({ leaderboardOptIn: optIn.checked }); toast(optIn.checked ? 'You are on the leaderboard' : 'Removed from leaderboard'); });

  const tabs = { Points: pointsTab, Leaderboard: leaderboardTab, Rules: rulesTab };
  const tabBar = el('div', { class: 'tabs' }), tabBody = el('div');
  for (const name of Object.keys(tabs)) tabBar.append(el('button', { onclick: (e) => show(name, e.target) }, name));
  async function show(name, btn) { [...tabBar.children].forEach((b) => b.classList.toggle('active', b === btn)); tabBody.replaceChildren(await tabs[name]()); }

  function pointsTab() {
    return el('div', {},
      stats ? el('p', { class: 'muted small' }, `Today: ${stats.alertsToday}/${RATE_LIMITS.alertsPerDay} reports · ${stats.pathsToday}/${RATE_LIMITS.pathSuggestionsPerDay} path suggestions`) : null,
      history.length
        ? el('div', { class: 'list' }, ...history.map((h) => el('div', { class: 'item' }, el('div', { class: 'emoji' }, '⭐'), el('div', { class: 'body' }, el('div', { class: 't' }, POINT_RULES.find((r) => r.key === h.rule)?.label || h.rule), el('div', { class: 's' }, fmtAgo(h.at))), el('strong', { style: 'color:var(--accent)' }, `+${h.points}`))))
        : el('div', { class: 'empty' }, el('div', { class: 'big' }, '🌱'), 'No points yet. Points arrive when a moderator approves or verifies one of your contributions.'));
  }
  async function leaderboardTab() {
    const rows = await ctx.backend.leaderboard();
    return el('div', {},
      el('label', { class: 'row', style: 'gap:10px;margin-bottom:10px' }, optIn, el('span', { class: 'small' }, 'Show my alias on the leaderboard (opt-in). Only your alias, points and level are shown — never your location or travel.')),
      rows.length ? el('div', { class: 'list' }, ...rows.map((r, i) => el('div', { class: `lb-row ${r.isMe ? 'me' : ''}` }, el('span', { class: 'rank' }, `#${i + 1}`), el('div', {}, el('div', { style: 'font-weight:600' }, r.alias, r.isMe ? ' (you)' : ''), el('div', { class: 'small muted' }, r.level, r.sample ? ' · sample' : '')), el('strong', {}, r.points))))
             : el('div', { class: 'empty' }, 'Nobody has opted in yet.'),
      !ctx.backend.isShared ? el('p', { class: 'small muted', style: 'margin-top:8px' }, 'Demo mode: this leaderboard only contains sample users and accounts created on this device.') : null);
  }
  function rulesTab() {
    return el('div', {},
      el('table', { class: 'rules' }, ...POINT_RULES.map((r) => el('tr', {}, el('td', {}, r.label), el('td', {}, typeof r.points === 'number' ? `+${r.points}` : r.points)))),
      el('h3', { style: 'font-size:14px;margin:12px 0 6px' }, 'Levels'),
      el('table', { class: 'rules' }, ...LEVELS.map((l) => el('tr', {}, el('td', {}, l.name), el('td', {}, `${l.min} pts`)))),
      el('div', { class: 'notice', style: 'margin-top:12px' }, `Abuse prevention: max ${RATE_LIMITS.alertsPerDay} reports, ${RATE_LIMITS.pathSuggestionsPerDay} path suggestions and ${RATE_LIMITS.confirmationsPerDay} confirmations per day. Submitting earns nothing — only approved or verified contributions count, and you cannot confirm your own reports. Duplicate reports at the same spot are blocked.`));
  }

  openModal('Your account', [
    el('div', { class: 'card', style: 'margin-bottom:10px' },
      el('div', { class: 'row between' },
        el('div', {}, el('div', { style: 'font-family:var(--font-display);font-weight:700;font-size:18px' }, esc(u.alias)), el('div', { class: 'small muted' }, `${level.name}${u.role === 'admin' ? ' · Moderator' : ''}`)),
        el('div', { class: 'stat', style: 'text-align:right' }, el('strong', {}, String(u.points)), el('span', {}, 'points'))),
      el('div', { class: 'levelbar' }, el('i', { style: `width:${Math.round(progress * 100)}%` })),
      el('div', { class: 'small muted' }, next ? `${next.min - u.points} pts to ${next.name}` : 'Max level reached')),
    el('div', { class: 'row', style: 'margin-bottom:10px' },
      el('button', { class: 'btn', style: 'flex:1', onclick: () => openFriends(ctx) }, '🫂 Friends & sharing'),
      el('button', { class: 'btn', onclick: () => openAppearance(ctx) }, '🎨 Appearance')),
    u.role === 'admin' ? el('button', { class: 'btn block', style: 'margin-bottom:10px', onclick: () => openAdmin(ctx) }, '🛠️ Moderation queue') : '',
    tabBar, tabBody,
    el('div', { class: 'row', style: 'margin-top:14px' },
      el('button', { class: 'btn ghost', onclick: async () => { await ctx.backend.signOut(); closeModal(); toast('Signed out'); ctx.showHome(); } }, 'Sign out'),
      ctx.backend.resetDemo ? el('button', { class: 'btn ghost', onclick: () => { if (confirm('Reset all demo data on this device?')) { ctx.backend.resetDemo(); closeModal(); toast('Demo data reset'); ctx.showHome(); } } }, 'Reset demo data') : null),
  ]);
  show('Points', tabBar.children[0]);
}
