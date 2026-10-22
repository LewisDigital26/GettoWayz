// Modal dialog — one at a time; body is a DOM node or array.
import { $ } from '../util.js';

const modal = $('#modal'), title = $('#modalTitle'), body = $('#modalBody');
let onClose = null;

export function openModal(t, nodes, opts = {}) {
  title.textContent = t;
  body.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]).filter((n) => n != null && n !== false));
  modal.hidden = false;
  onClose = opts.onClose || null;
  body.scrollTop = 0;
}
export function closeModal() {
  if (modal.hidden) return;
  modal.hidden = true;
  const cb = onClose; onClose = null; cb?.();
}
export function isModalOpen() { return !modal.hidden; }

$('#modalClose').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
