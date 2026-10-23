// Bottom sheet + toasts + status strip.
import { $, el } from '../util.js';

const sheet = $('#sheet'), content = $('#sheetContent'), handle = $('#sheetHandle');

export function renderSheet(nodes) {
  content.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]).filter((n) => n != null && n !== false));
  requestAnimationFrame(syncHeight);
}
export function collapse(v) {
  sheet.classList.toggle('collapsed', !!v);
  handle.setAttribute('aria-expanded', String(!v));
  handle.setAttribute('aria-label', v ? 'Expand panel' : 'Minimise panel');
  requestAnimationFrame(syncHeight);
}
export function isCollapsed() { return sheet.classList.contains('collapsed'); }
export function hideSheet(h) { sheet.hidden = !!h; syncHeight(); }

const PEEK = 78; // collapsed: just the handle and the panel title stay visible
function syncHeight() {
  const h = sheet.hidden ? 0 : (isCollapsed() ? PEEK : Math.min(sheet.offsetHeight, (sheet.parentElement?.clientHeight || window.innerHeight) * .72));
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}
window.addEventListener('resize', syncHeight);

// ---- drag to move: the sheet follows the finger from the handle or the title row, then snaps open or minimised ----
// touch-action: none on those areas (CSS) stops the browser treating the drag as a page scroll.
let drag = null;
const maxOffset = () => Math.max(0, sheet.offsetHeight - PEEK);
sheet.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  const zone = e.target.closest('.sheet-handle, .sheet-title');
  if (!zone || (e.target.closest('button, a, input, select, textarea, label') && !e.target.closest('.sheet-handle'))) return;
  drag = { y0: e.clientY, t0: performance.now(), base: isCollapsed() ? maxOffset() : 0, off: null, moved: false, onHandle: !!e.target.closest('.sheet-handle') };
  try { sheet.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
sheet.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y0;
  if (!drag.moved && Math.abs(dy) < 6) return;
  if (!drag.moved) { drag.moved = true; sheet.classList.add('dragging'); }
  drag.off = Math.min(maxOffset(), Math.max(0, drag.base + dy));
  sheet.style.transform = `translateY(${drag.off}px)`;
});
function endDrag(e) {
  if (!drag) return;
  const d = drag; drag = null;
  sheet.classList.remove('dragging');
  sheet.style.transform = '';
  if (!d.moved) { if (e.type === 'pointerup' && d.onHandle) collapse(!isCollapsed()); return; }
  const dy = e.clientY - d.y0, v = dy / Math.max(1, performance.now() - d.t0); // px per ms
  collapse(v > 0.35 || (v > -0.35 && d.off > maxOffset() / 2));
}
sheet.addEventListener('pointerup', endDrag);
sheet.addEventListener('pointercancel', endDrag);
handle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); collapse(!isCollapsed()); } });

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
