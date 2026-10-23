// Accounts, points, levels, leaderboard, rules.
import { $, el, esc, fmtAgo } from '../util.js';
import { state } from '../state.js';
import { RATE_LIMITS } from '../backend/rules.js';
import { levelInfo } from '../backend/pointsPolicy.js';
import { openPoints } from './points.js';
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
  const { level, next, progress, toNext } = levelInfo(u.points, u.levelFloor);
  const stats = await ctx.backend.myStats?.().catch(() => null);
  openModal('Your account', [
    el('button', { class: 'card level-card as-button', style: 'margin-bottom:10px;width:100%;text-align:left', onclick: () => openPoints(ctx, 'progress'), 'aria-label': 'Open points and levels' },
      el('div', { class: 'row between' },
        el('div', { class: 'level-badge', 'aria-hidden': 'true' }, String(level.n)),
        el('div', { style: 'flex:1;min-width:0' }, el('div', { style: 'font-family:var(--font-display);font-weight:700;font-size:18px' }, esc(u.alias)), el('div', { class: 'small muted' }, `Level ${level.n} · ${level.name}${u.role === 'admin' ? ' · Moderator' : ''}`)),
        el('div', { class: 'stat', style: 'text-align:right' }, el('strong', {}, String(u.points)), el('span', {}, 'points'))),
      el('div', { class: 'levelbar' }, el('i', { style: `width:${Math.round(progress * 100)}%` })),
      el('div', { class: 'small muted' }, next ? `${toNext} pts to ${next.name} · tap for details` : 'Top level reached · tap for details')),
    el('div', { class: 'row wrap', style: 'margin-bottom:10px' },
      el('button', { class: 'btn', style: 'flex:1', onclick: () => openPoints(ctx, 'leaderboard') }, '🏆 Leaderboards'),
      el('button', { class: 'btn', style: 'flex:1', onclick: () => openPoints(ctx, 'guide') }, '❓ How points work')),
    el('div', { class: 'row', style: 'margin-bottom:10px' },
      el('button', { class: 'btn', style: 'flex:1', onclick: () => openFriends(ctx) }, '🫂 Friends & sharing'),
      el('button', { class: 'btn', onclick: () => openAppearance(ctx) }, '🎨 Appearance')),
    u.role === 'admin' ? el('button', { class: 'btn block', style: 'margin-bottom:10px', onclick: () => openAdmin(ctx) }, '🛠️ Moderation & points review') : '',
    stats ? el('p', { class: 'muted small' }, `Today: ${stats.alertsToday}/${RATE_LIMITS.alertsPerDay} reports · ${stats.pathsToday}/${RATE_LIMITS.pathSuggestionsPerDay} path suggestions`) : null,
    el('div', { class: 'row', style: 'margin-top:14px' },
      el('button', { class: 'btn ghost', onclick: async () => { await ctx.backend.signOut(); closeModal(); toast('Signed out'); ctx.showHome(); } }, 'Sign out'),
      ctx.backend.resetDemo ? el('button', { class: 'btn ghost', onclick: () => { if (confirm('Reset all demo data on this device?')) { ctx.backend.resetDemo(); closeModal(); toast('Demo data reset'); ctx.showHome(); } } }, 'Reset demo data') : null),
  ]);
}
