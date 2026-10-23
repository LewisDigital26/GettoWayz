// Modal dialog — one at a time; body is a DOM node or array.
// Each open modal adds one browser-history entry, so the phone/browser Back button closes the modal
// before it changes tab (see ui/tabs.js).
import { $ } from '../util.js';

const modal = $('#modal'), title = $('#modalTitle'), body = $('#modalBody');
let onClose = null;
let pushed = false;      // a history entry exists for the open modal
let skipPops = 0;        // history.back() calls we made ourselves (their popstate must be ignored)
let lastFocus = null;

export function openModal(t, nodes, opts = {}) {
  title.textContent = t;
  body.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]).filter((n) => n != null && n !== false));
  if (modal.hidden) {
    lastFocus = document.activeElement;
    if (!pushed) { try { history.pushState({ gwModal: true }, ''); pushed = true; } catch { /* sandboxed frame */ } }
  }
  modal.hidden = false;
  onClose = opts.onClose || null;
  body.scrollTop = 0;
  requestAnimationFrame(() => $('#modalClose').focus({ preventScroll: true }));
}
/** opts.fromHistory: the user pressed Back, so the history entry is already gone. */
export function closeModal(opts = {}) {
  if (modal.hidden) return;
  modal.hidden = true;
  if (pushed) {
    pushed = false;
    if (!opts.fromHistory) { skipPops++; history.back(); }
  }
  if (lastFocus?.isConnected && !lastFocus.closest('[inert]')) lastFocus.focus?.({ preventScroll: true });
  lastFocus = null;
  const cb = onClose; onClose = null; cb?.();
}
export function isModalOpen() { return !modal.hidden; }
/** Called by the tab router on popstate: true if this pop was our own history.back() and should be ignored. */
export function consumeModalPop() { if (skipPops > 0) { skipPops--; return true; } return false; }
export const modalBackPending = () => skipPops > 0;

$('#modalClose').addEventListener('click', () => closeModal());
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
