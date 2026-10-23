// Bottom sheet + toasts + status strip.
import { $, el } from '../util.js';

const sheet = $('#sheet'), content = $('#sheetContent'), handle = $('#sheetHandle');

export function renderSheet(nodes) {
  content.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]).filter((n) => n != null && n !== false));
  requestAnimationFrame(syncHeight);
}
export function collapse(v) { sheet.classList.toggle('collapsed', !!v); requestAnimationFrame(syncHeight); }
export function isCollapsed() { return sheet.classList.contains('collapsed'); }
export function hideSheet(h) { sheet.hidden = !!h; syncHeight(); }

function syncHeight() {
  const h = sheet.hidden ? 0 : (isCollapsed() ? 64 : Math.min(sheet.offsetHeight, (sheet.parentElement?.clientHeight || window.innerHeight) * .72));
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}
window.addEventListener('resize', syncHeight);

// drag / tap to toggle
let startY = null;
handle.addEventListener('pointerdown', (e) => { startY = e.clientY; });
handle.addEventListener('pointerup', (e) => {
  if (startY == null) return;
  const dy = e.clientY - startY; startY = null;
  if (Math.abs(dy) < 6) collapse(!isCollapsed());
  else collapse(dy > 0);
});

export function toast(msg, type = '') {
  const t = el('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
}
export function statusStrip(text) {
  const s = $('#statusStrip');
  if (!text) { s.hidden = true; return; }
  s.textContent = text; s.hidden = false;
}
