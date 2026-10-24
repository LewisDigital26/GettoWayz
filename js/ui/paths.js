// Suggest a missing path — map drawing flow, review form, detail view.
import { $, el, esc, fmtDistance, fmtAgo, lineLength } from '../util.js';
import { state, set } from '../state.js';
import { PATH_TYPES, SURFACES, RATE_LIMITS, POINTS, ACCESS_TAGS, PATH_STALE_DAYS } from '../backend/rules.js';
import { openModal, closeModal } from './modal.js';
import { toast, hideSheet } from './sheet.js';

const hud = $('#drawHud'), count = $('#drawCount'), done = $('#drawDone');

export function startSuggestPath(ctx) {
  set({ draw: { points: [] } });
  ctx.map.startDraw();
  hideSheet(true); $('#fabs').hidden = true;
  hud.hidden = false;
  updateHud();
  ctx.onDrawPoint = (ll) => { state.draw.points.push(ll); ctx.map.renderDraw(state.draw.points); updateHud(); };
  $('#drawUndo').onclick = () => { state.draw.points.pop(); ctx.map.renderDraw(state.draw.points); updateHud(); };
  $('#drawCancel').onclick = () => stopDraw(ctx);
  done.onclick = () => openPathForm(ctx);
  toast('Trace the missing path by tapping along it');
}
function updateHud() {
  const n = state.draw.points.length;
  const len = n > 1 ? fmtDistance(lineLength(state.draw.points)) : '';
  count.textContent = n === 0 ? '0 points · start where the missing path begins' : n === 1 ? '1 point · keep tapping along the path' : `${n} points · ${len}`;
  done.disabled = n < 2;
}
function stopDraw(ctx) {
  ctx.map.endDraw(); hud.hidden = true; $('#fabs').hidden = false; hideSheet(false);
  ctx.onDrawPoint = null; set({ draw: null });
}

function openPathForm(ctx) {
  const points = [...state.draw.points];
  const name = el('input', { placeholder: 'e.g. Cut-through behind the leisure centre', maxlength: '60' });
  const type = el('select', {}, ...Object.entries(PATH_TYPES).map(([k, v]) => el('option', { value: k }, v)));
  const surface = el('select', {}, ...Object.entries(SURFACES).map(([k, v]) => el('option', { value: k }, v)));
  const note = el('textarea', { placeholder: 'Anything that helps a reviewer: gates, signs, lighting, whether it is clearly public.', maxlength: '300' });
  const accessBoxes = Object.entries(ACCESS_TAGS).map(([k, t]) => ({ k, box: el('input', { type: 'checkbox' }), t }));
  const accessField = el('div', { class: 'field' }, el('label', {}, 'What is it like? (tick any you know are true)'),
    el('div', { class: 'access-grid' }, ...accessBoxes.map(({ box, t }) => el('label', { class: 'access-opt' }, box, el('span', {}, t.emoji, ' ', t.label)))));
  const publicChk = el('input', { type: 'checkbox' });
  const submit = el('button', { class: 'btn primary block', onclick: async () => {
    if (!publicChk.checked) { toast('Please confirm the path is public before submitting', 'error'); return; }
    submit.disabled = true;
    try {
      const access = Object.fromEntries(accessBoxes.filter(({ box }) => box.checked).map(({ k }) => [k, true]));
      await ctx.backend.suggestPath({ name: name.value, type: type.value, surface: surface.value, note: note.value, points, access });
      closeModal(); stopDraw(ctx);
      state.layers.pending = true; $('#layerPending').checked = true;
      await ctx.refreshData();
      toast('Suggestion submitted — status: Pending review', 'success');
    } catch (e) { toast(e.message, 'error'); submit.disabled = false; }
  } }, 'Submit for review');
  openModal('Suggest a missing path', [
    el('p', { class: 'muted small' }, `${points.length} points · ${fmtDistance(lineLength(points))}. We only collect what a reviewer needs; your identity is not shown with the suggestion.`),
    el('div', { class: 'field' }, el('label', {}, 'Path name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Type'), type),
    el('div', { class: 'field' }, el('label', {}, 'Surface'), surface),
    accessField,
    el('div', { class: 'field' }, el('label', {}, 'Notes for the reviewer'), note),
    el('label', { class: 'row', style: 'gap:10px;margin-bottom:12px' }, publicChk, el('span', { class: 'small' }, 'I believe this path is public and legal to use. It is not private property.')),
    el('div', { class: 'notice warn' }, `Suggestions are not routes until a moderator reviews them. If approved, the path is added to the map for everyone and you earn ${POINTS.path_approved} points. Limit: ${RATE_LIMITS.pathSuggestionsPerDay} per day.`),
    submit,
  ]);
}

/** Community check on an approved path: when someone last said they used it, and whether the latest says it's blocked. */
export function pathFreshness(p) {
  const confs = [...(p.confirmations || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const ok = confs.filter((c) => c.stillOk);
  const last = confs[0] || null;
  const lastAt = last ? new Date(last.at).getTime() : new Date(p.reviewedAt || p.createdAt).getTime();
  return {
    count: ok.length, last,
    blocked: !!last && !last.stillOk,
    stale: Date.now() - lastAt > PATH_STALE_DAYS * 86400000,
  };
}
export function accessChips(access = {}) {
  const on = Object.entries(access).filter(([k, v]) => v && ACCESS_TAGS[k]);
  return on.length ? el('div', { class: 'row wrap', style: 'gap:6px;margin:6px 0' }, ...on.map(([k]) => el('span', { class: 'chip' }, ACCESS_TAGS[k].emoji, ' ', ACCESS_TAGS[k].label))) : null;
}

export function openPathDetail(ctx, p) {
  const statusLabel = { approved: 'Approved · on the map', pending: 'Pending review', rejected: 'Rejected', changes: 'Changes requested' }[p.status];
  const me = state.user, f = pathFreshness(p);
  const mineConf = me && (p.confirmations || []).find((c) => c.userId === me.id);
  const canConfirm = me && p.status === 'approved' && p.createdBy !== me.id;
  const confirm = async (stillOk) => {
    try { await ctx.backend.confirmPath(p.id, stillOk); toast(stillOk ? 'Thanks — marked as still there' : 'Thanks — others will see it may be blocked', 'success'); closeModal(); ctx.refreshData(); }
    catch (e) { toast(e.message, 'error'); }
  };
  openModal(p.name, [
    el('div', { class: 'row wrap', style: 'margin-bottom:8px' },
      el('span', { class: `chip ${p.status === 'approved' ? 'verified' : p.status === 'pending' || p.status === 'changes' ? 'pending' : 'danger'}` }, statusLabel),
      p.status === 'approved' && f.blocked ? el('span', { class: 'chip danger' }, '🚧 Latest report: blocked') : null,
      p.status === 'approved' && !f.blocked && f.stale ? el('span', { class: 'chip pending' }, `Not confirmed in ${PATH_STALE_DAYS} days`) : null,
      p.status === 'approved' && f.count ? el('span', { class: 'chip accent' }, `✅ ${f.count} used it`) : null,
      p.sample ? el('span', { class: 'chip sample' }, 'Sample data') : null),
    el('p', { class: 'muted small' }, `${PATH_TYPES[p.type] || p.type} · ${SURFACES[p.surface] || p.surface} · ${fmtDistance(lineLength(p.points))} · suggested ${fmtAgo(p.createdAt)}`),
    accessChips(p.access),
    p.note ? el('p', {}, p.note) : null,
    p.status === 'approved' ? el('p', { class: 'small muted' }, f.last ? `Last checked by the community ${fmtAgo(f.last.at)}.` : 'Nobody has confirmed using this path yet.') : null,
    p.reviewMessage ? el('div', { class: 'notice info' }, 'Moderator: ', esc(p.reviewMessage)) : null,
    el('div', { class: 'notice' }, p.status === 'approved'
      ? 'Approved means moderators accepted this suggestion for the community map. It does not guarantee the path is safe, lit or always open.'
      : 'This suggestion has not been verified. It is not used for routing until approved.'),
    canConfirm ? el('div', { class: 'row wrap', style: 'margin:10px 0' },
      el('button', { class: 'btn primary', onclick: () => confirm(true) }, mineConf?.stillOk ? '✅ Used it again' : '✅ I\'ve used this — still there'),
      el('button', { class: 'btn danger', onclick: () => confirm(false) }, '🚧 It\'s blocked / gone')) : null,
    canConfirm ? el('p', { class: 'small', style: 'color:var(--text-3)' }, 'Confirmations keep the map honest. They don\'t earn points.') : null,
    el('button', { class: 'btn block', onclick: closeModal }, 'Close'),
  ]);
}
