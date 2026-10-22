// Moderation screen — review path suggestions and alerts. Admin role only (enforced by the backend too).
import { el, esc, fmtAgo, fmtDistance, lineLength } from '../util.js';
import { state } from '../state.js';
import { ALERT_CATEGORIES, PATH_TYPES, SURFACES } from '../backend/rules.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';

export async function openAdmin(ctx) {
  if (state.user?.role !== 'admin') { toast('Moderators only', 'error'); return; }
  const pendingPaths = (await ctx.backend.listPaths()).filter((p) => p.status === 'pending' || p.status === 'changes');
  const pendingAlerts = (await ctx.backend.listAlerts()).filter((a) => a.status === 'pending');
  if (ctx.backend.cacheAliases) await ctx.backend.cacheAliases([...pendingPaths.map((p) => p.createdBy), ...pendingAlerts.map((a) => a.createdBy)]);

  const pathCard = (p) => {
    const msg = el('input', { placeholder: 'Message to the contributor (optional)', maxlength: '300' });
    const act = async (d) => { try { await ctx.backend.reviewPath(p.id, d, msg.value); toast(`Path ${d === 'approve' ? 'approved — now on the map' : d === 'reject' ? 'rejected' : 'sent back for changes'}`, 'success'); openAdmin(ctx); } catch (e) { toast(e.message, 'error'); } };
    return el('div', { class: 'card' },
      el('div', { class: 'row between' }, el('strong', {}, esc(p.name)), el('span', { class: `chip ${p.status === 'changes' ? 'pending' : 'pending'}` }, p.status === 'changes' ? 'Changes requested' : 'Pending')),
      el('div', { class: 'small muted', style: 'margin:4px 0' }, `${PATH_TYPES[p.type] || p.type} · ${SURFACES[p.surface] || p.surface} · ${fmtDistance(lineLength(p.points))} · ${p.points.length} points · by ${esc(ctx.backend.aliasOf?.(p.createdBy) || 'member')} · ${fmtAgo(p.createdAt)}${p.sample ? ' · sample' : ''}`),
      p.note ? el('div', { class: 'small', style: 'margin-bottom:6px' }, esc(p.note)) : null,
      el('button', { class: 'btn sm ghost', style: 'margin-bottom:8px', onclick: () => { closeModal(); ctx.map.flyTo(p.points[Math.floor(p.points.length / 2)], 17); state.layers.pending = true; ctx.map.renderPaths([p, ...state.paths], { showPending: true, myId: p.createdBy }); } }, 'Show on map'),
      el('div', { class: 'field' }, msg),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn sm primary', onclick: () => act('approve') }, '✅ Approve'),
        el('button', { class: 'btn sm', onclick: () => act('changes') }, '✏️ Request changes'),
        el('button', { class: 'btn sm danger', onclick: () => act('reject') }, 'Reject')));
  };
  const alertCard = (a) => {
    const cat = ALERT_CATEGORIES[a.category];
    const act = async (d) => { try { await ctx.backend.reviewAlert(a.id, d); toast(`Alert ${d === 'verify' ? 'verified' : d + 'ed'}`, 'success'); openAdmin(ctx); } catch (e) { toast(e.message, 'error'); } };
    return el('div', { class: 'card' },
      el('div', { class: 'row between' }, el('strong', {}, `${cat.emoji} ${cat.label}`), el('span', { class: 'chip pending' }, `${a.confirmations.length} confirmations`)),
      el('div', { class: 'small muted', style: 'margin:4px 0' }, `${a.note || 'no details'} · ${fmtAgo(a.createdAt)} · by ${esc(ctx.backend.aliasOf?.(a.createdBy) || 'member')}${a.sample ? ' · sample' : ''}`),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn sm ghost', onclick: () => { closeModal(); ctx.map.flyTo([a.lat, a.lng], 17); } }, 'Show'),
        el('button', { class: 'btn sm primary', onclick: () => act('verify') }, '✅ Verify'),
        el('button', { class: 'btn sm', onclick: () => act('resolve') }, 'Resolve'),
        el('button', { class: 'btn sm danger', onclick: () => act('reject') }, 'Reject')));
  };

  openModal('Moderation queue', [
    el('p', { class: 'muted small' }, 'Approve only paths that are clearly public and legal to use. Approval adds the path to the community map and awards points to the contributor. Verifying an alert awards points to the reporter and anyone who confirmed it.'),
    el('h3', { style: 'font-size:15px;margin:10px 0 6px' }, `Path suggestions (${pendingPaths.length})`),
    pendingPaths.length ? el('div', { class: 'list' }, ...pendingPaths.map(pathCard)) : el('div', { class: 'empty' }, 'Queue is empty.'),
    el('h3', { style: 'font-size:15px;margin:16px 0 6px' }, `Alerts awaiting review (${pendingAlerts.length})`),
    pendingAlerts.length ? el('div', { class: 'list' }, ...pendingAlerts.map(alertCard)) : el('div', { class: 'empty' }, 'Nothing to review.'),
  ]);
}
