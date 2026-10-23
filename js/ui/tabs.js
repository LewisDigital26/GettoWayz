// App shell: five primary tabs — Leaderboard · Friends · Map · Activity · Profile.
// Phones/tablets: bottom bar with Map raised in the centre. ≥900px: a compact side rail with the same tabs in the same order.
// The map is never torn down — other tabs are pages laid over it — so a planned route, search and zoom survive tab switches.
// Each tab has its own URL hash (#leaderboard …; Map has none), so Back moves between tabs; an open modal is closed first.
import { $, el } from '../util.js';
import { state, subscribe } from '../state.js';
import { isModalOpen, closeModal, consumeModalPop, modalBackPending } from './modal.js';
import { avatar } from './avatar.js';
import { motionOk } from '../prefs.js';

const svg = (inner, filled = false) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="${filled ? 'filled' : ''}">${inner}</svg>`;
const ICONS = {
  leaderboard: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  friends: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.8a3.2 3.2 0 0 1 0 6.4M18 14.8c1.8.7 3 2.4 3 5.2"/>'),
  map: svg('<path d="M12 2.6 19.6 20.6 12 16.7 4.4 20.6Z"/>', true),
  activity: svg('<path d="M6 10a6 6 0 1 1 12 0c0 4.6 2 6 2 6H4s2-1.4 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  profile: svg('<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c.8-3.6 3.8-5.8 7.5-5.8s6.7 2.2 7.5 5.8"/>'),
};
export const TABS = [
  { key: 'leaderboard', label: 'Leaderboard', short: 'Ranks' },
  { key: 'friends', label: 'Friends' },
  { key: 'map', label: 'Map', center: true },
  { key: 'activity', label: 'Activity' },
  { key: 'profile', label: 'Profile' },
];
const KEYS = TABS.map((t) => t.key);

const pages = {};        // key → { title, render, section, body, actions, scroll, token, rendered }
const badges = {};       // key → { count, dot, label }
const buttons = {};
let current = null;
let ctxRef = null;
let afterModalPop = [];  // tab URL changes waiting for our own modal history.back() to finish

/** render(ctx, page) → Node | Promise<Node>. page.setActions(...nodes) fills the header's right side. */
export function registerPage(key, title, render) { pages[key] = { title, render }; }

export function initTabs(ctx) {
  ctxRef = ctx;
  ctx.showTab = showTab;
  ctx.refreshPage = refreshPage;
  ctx.currentTab = () => current;
  const bar = $('#tabbar');
  bar.replaceChildren(
    ...TABS.map((t) => {
      const b = el('button', { class: `tab ${t.center ? 'tab-center' : ''}`, 'data-tab': t.key, type: 'button', onclick: () => showTab(t.key, { focus: true }) },
        el('span', { class: 'tab-ico', html: ICONS[t.key] }),
        el('span', { class: 'tab-label', 'aria-hidden': t.short ? 'true' : null }, el('span', { class: 'lbl-long' }, t.label), t.short ? el('span', { class: 'lbl-short' }, t.short) : null),
        t.short ? el('span', { class: 'sr-only' }, t.label) : null,
        el('span', { class: 'tab-badge', hidden: true }));
      buttons[t.key] = b;
      return b;
    }));
  const host = $('#pages');
  for (const key of KEYS) {
    if (key === 'map') continue;
    const p = pages[key];
    p.body = el('div', { class: 'page-body' });
    p.actions = el('div', { class: 'page-actions' });
    p.heading = el('h1', { id: `h-${key}`, tabindex: '-1' }, p.title);
    p.section = el('section', { class: 'page', id: `page-${key}`, 'aria-labelledby': `h-${key}`, hidden: true },
      el('div', { class: 'page-inner' }, el('header', { class: 'page-head' }, p.heading, p.actions), p.body));
    p.setActions = (...nodes) => p.actions.replaceChildren(...nodes.filter(Boolean));
    host.append(p.section);
  }
  window.addEventListener('popstate', onPop);
  subscribe((_, patch) => { if ('navigating' in patch || 'draw' in patch) syncBarVisibility(); });
  syncBarVisibility();
  updateProfileTab();
  showTab(fromHash(), { push: false, replace: true });
}

function fromHash() { const h = location.hash.replace(/^#\/?/, ''); return KEYS.includes(h) ? h : 'map'; }
const urlFor = (key) => (key === 'map' ? location.pathname + location.search : `#${key}`);

/**
 * Switch tab. opts.push (default true) adds a history entry; opts.focus moves focus to the page heading
 * (for keyboard and screen-reader users); opts.refresh (default true) reloads the page's data.
 */
export function showTab(key, opts = {}) {
  const { push = true, replace = false, focus = false, refresh = true, anchor = null } = opts;
  if (!KEYS.includes(key)) key = 'map';
  if ((state.navigating || state.draw) && key !== 'map') key = 'map'; // nothing else while navigating or drawing
  const prev = current;
  if (prev && prev !== 'map' && pages[prev]?.section) pages[prev].scroll = pages[prev].section.scrollTop;
  current = key;
  document.documentElement.dataset.tab = key;
  for (const [k, b] of Object.entries(buttons)) {
    if (k === key) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const mapView = $('#mapView');
  mapView.inert = key !== 'map';
  if (key !== 'map') mapView.setAttribute('aria-hidden', 'true'); else mapView.removeAttribute('aria-hidden');
  for (const k of KEYS) {
    const p = pages[k];
    if (!p?.section) continue;
    const show = k === key;
    if (show && p.section.hidden) {
      p.section.hidden = false;
      if (motionOk() && prev && prev !== k) { p.section.classList.remove('enter'); void p.section.offsetWidth; p.section.classList.add('enter'); }
    } else if (!show) p.section.hidden = true;
  }
  if (key === 'map') {
    requestAnimationFrame(() => ctxRef?.map?.map?.invalidateSize?.());
  } else {
    if (anchor) pages[key].anchor = anchor;
    if (refresh || !pages[key].rendered) renderPage(key);
    if (focus && !anchor) requestAnimationFrame(() => pages[key].heading.focus({ preventScroll: true }));
  }
  document.title = key === 'map' ? 'Ghetto Wayz' : `${pages[key].title} · Ghetto Wayz`;
  // history
  const url = urlFor(key);
  const write = () => {
    if (replace) history.replaceState({ gwTab: key }, '', url);
    else if (push && prev !== key) history.pushState({ gwTab: key }, '', url);
  };
  if (modalBackPending()) afterModalPop.push(write); else write();
}

function onPop() {
  if (consumeModalPop()) { const q = afterModalPop; afterModalPop = []; q.forEach((f) => f()); return; }
  if (isModalOpen()) { closeModal({ fromHistory: true }); return; }
  const key = fromHash();
  if ((state.navigating || state.draw) && key !== 'map') { history.replaceState({ gwTab: 'map' }, '', urlFor('map')); return; }
  showTab(key, { push: false });
}

async function renderPage(key) {
  const p = pages[key];
  const token = (p.token = (p.token || 0) + 1);
  if (!p.rendered) p.body.replaceChildren(skeleton());
  p.section.setAttribute('aria-busy', 'true');
  try {
    const node = await p.render(ctxRef, p);
    if (token !== p.token) return;   // a newer render started (fast tab switching)
    p.body.replaceChildren(...[node].flat().filter(Boolean));
    p.rendered = true;
    if (p.anchor) {
      const target = document.getElementById(p.anchor); p.anchor = null;
      if (target) { target.scrollIntoView({ block: 'start', behavior: motionOk() ? 'smooth' : 'auto' }); target.querySelector('input, select, button')?.focus({ preventScroll: true }); }
    } else if (p.scroll != null) { p.section.scrollTop = p.scroll; p.scroll = null; }
  } catch (e) {
    if (token !== p.token) return;
    p.body.replaceChildren(el('div', { class: 'state-card' },
      el('div', { class: 'big', 'aria-hidden': 'true' }, navigator.onLine ? '⚠️' : '📡'),
      el('strong', {}, navigator.onLine ? 'Something went wrong' : 'You are offline'),
      el('p', { class: 'muted small' }, navigator.onLine ? (e.message || 'This screen could not load.') : 'This screen needs a connection. The map and directions you already have keep working.'),
      el('button', { class: 'btn', onclick: () => renderPage(key) }, 'Try again')));
  } finally {
    if (token === p.token) p.section.removeAttribute('aria-busy');
  }
}
function skeleton() {
  return el('div', { class: 'skeleton', 'aria-label': 'Loading', role: 'status' },
    el('div', { class: 'sk sk-card' }), el('div', { class: 'sk sk-line' }), el('div', { class: 'sk sk-line short' }), el('div', { class: 'sk sk-row' }), el('div', { class: 'sk sk-row' }), el('div', { class: 'sk sk-row' }));
}

/** Re-render a page if it is on screen (or the current page when no key is given). Other pages refresh when next opened. */
export function refreshPage(key = current) {
  if (key && key !== 'map' && key === current) renderPage(key);
}

/** count > 0 shows a number; dot shows a small live dot. label is announced to screen readers. */
export function setBadge(key, { count = 0, dot = false, label = '' } = {}) {
  badges[key] = { count, dot, label };
  const b = buttons[key]; if (!b) return;
  const badge = b.querySelector('.tab-badge');
  const show = count > 0 || dot;
  badge.hidden = !show;
  badge.textContent = count > 0 ? (count > 9 ? '9+' : String(count)) : '';
  badge.classList.toggle('dot', !count && dot);
  const t = TABS.find((x) => x.key === key);
  b.setAttribute('aria-label', show && label ? `${t.label}, ${label}` : t.label);
}

/** Profile tab shows the user's avatar initial once signed in. */
export function updateProfileTab() {
  const b = buttons.profile; if (!b) return;
  const ico = b.querySelector('.tab-ico');
  if (state.user) ico.replaceChildren(avatar(state.user.alias, { size: 26, cls: 'tab-av' }));
  else ico.innerHTML = ICONS.profile;
}

function syncBarVisibility() {
  const hide = !!(state.navigating || state.draw);
  document.documentElement.classList.toggle('bar-hidden', hide);
  if (hide && current && current !== 'map') showTab('map', { push: false, replace: true });
  requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); ctxRef?.map?.map?.invalidateSize?.(); });
}
