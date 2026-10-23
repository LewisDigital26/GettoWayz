// Initial-based avatars. GettoWayz has no photo uploads, so an avatar is the first letter of the alias on a
// colour picked from the brand palette (stable per alias). Nothing personal is encoded in it.
import { el } from '../util.js';

const PALETTE = ['#aaf129', '#2bb190', '#4fc3ff', '#ffb800', '#b49cff', '#ff8a6b'];
export function avatarColor(alias = '') {
  let h = 0;
  for (const c of String(alias).toLowerCase()) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export function initial(alias) { return (String(alias || '').trim()[0] || '?').toUpperCase(); }

/** <span class="av"> with the alias initial. size: px. Purely decorative unless `label` is given. */
export function avatar(alias, { size = 36, label = null, cls = '' } = {}) {
  return el('span', { class: `av ${cls}`, style: `--av:${size}px;--av-bg:${avatarColor(alias)}`, ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }) }, initial(alias));
}
