// Community alerts — report flow, detail view, route proximity helper.
import { el, esc, fmtAgo, fmtIn, distanceToLine } from '../util.js';
import { state } from '../state.js';
import { ALERT_CATEGORIES, RATE_LIMITS } from '../backend/rules.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';

export function alertsNearRoute(alerts, geometry, metres = 40) {
  return alerts.filter((a) => distanceToLine([a.lat, a.lng], geometry) <= metres);
}

export function openReportFlow(ctx, [lat, lng], { fromGps = false } = {}) {
  let category = null;
  const note = el('textarea', { placeholder: 'What should people know? (optional, no personal details)', maxlength: '240' });
  const grid = el('div', { class: 'catgrid' });
  const submit = el('button', { class: 'btn primary block', disabled: true }, 'Submit report');
  for (const [key, c] of Object.entries(ALERT_CATEGORIES)) {
    const b = el('button', { class: 'catbtn', onclick: () => { category = key; [...grid.children].forEach((x) => x.classList.toggle('selected', x === b)); submit.disabled = false; } },
      el('span', { class: 'emoji' }, c.emoji), el('div', {}, el('div', { class: 't' }, c.label), el('div', { class: 's' }, c.desc)));
    grid.append(b);
  }
  submit.addEventListener('click', async () => {
    submit.disabled = true; submit.textContent = 'Submitting…';
    try {
      await ctx.backend.createAlert({ lat, lng, category, note: note.value });
      closeModal();
      toast('Report submitted — it shows as "awaiting confirmation" until reviewed', 'success');
      ctx.map.flyTo([lat, lng], 17);
    } catch (e) {
      toast(e.message, 'error');
      submit.disabled = false; submit.textContent = 'Submit report';
    }
  });
  openModal('Report an issue', [
    el('p', { class: 'muted small' }, fromGps
      ? 'Pinned at your current position (rounded). Your identity and live location are not shown to other users.'
      : `Pinned at ${lat.toFixed(4)}, ${lng.toFixed(4)}. Your identity is not shown to other users.`),
    grid,
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', {}, 'Details'), note),
    el('div', { class: 'notice' }, `Reports start as "awaiting confirmation". Points are only awarded if a moderator verifies the report or 2+ other users confirm it — never for the number of reports. Limit: ${RATE_LIMITS.alertsPerDay} reports per day.`),
    submit,
  ]);
}

export function openAlertDetail(ctx, a) {
  const cat = ALERT_CATEGORIES[a.category] || ALERT_CATEGORIES.other;
  const me = state.user;
  const isMine = me && a.createdBy === me.id;
  const confirmed = me && a.confirmations.includes(me.id);
  const confirmBtn = el('button', { class: 'btn primary', disabled: !me || isMine || confirmed, onclick: async () => {
    try { await ctx.backend.confirmAlert(a.id); toast('Thanks — confirmation recorded', 'success'); closeModal(); }
    catch (e) { toast(e.message, 'error'); }
  } }, confirmed ? 'Confirmed ✓' : 'I can confirm this');
  const adminRow = me?.role === 'admin' ? el('div', { class: 'row wrap', style: 'margin-top:10px' },
    el('button', { class: 'btn sm', onclick: () => review('verify') }, '✅ Verify'),
    el('button', { class: 'btn sm', onclick: () => review('resolve') }, 'Mark resolved'),
    el('button', { class: 'btn sm danger', onclick: () => review('reject') }, 'Reject')) : null;
  async function review(d) { try { await ctx.backend.reviewAlert(a.id, d); toast(`Alert ${d === 'verify' ? 'verified' : d + 'ed'}`, 'success'); closeModal(); } catch (e) { toast(e.message, 'error'); } }

  openModal(`${cat.emoji} ${cat.label}`, [
    el('div', { class: 'row wrap', style: 'margin-bottom:8px' },
      el('span', { class: `chip ${a.status}` }, a.status === 'verified' ? 'Verified by moderators' : 'Awaiting confirmation'),
      a.confirmations.length ? el('span', { class: 'chip accent' }, `${a.confirmations.length} user${a.confirmations.length > 1 ? 's' : ''} confirmed`) : null,
      a.sample ? el('span', { class: 'chip sample' }, 'Sample data') : null),
    el('p', {}, a.note || el('span', { class: 'muted' }, 'No details given.')),
    el('p', { class: 'muted small' }, `Reported ${fmtAgo(a.createdAt)} by ${isMine ? 'you' : 'a community member'} · ${a.status === 'verified' ? 'review due' : 'expires'} ${fmtIn(a.expiresAt)}`),
    el('div', { class: 'notice' }, a.status === 'verified'
      ? 'A moderator has checked this report. Conditions can still change — treat it as a heads-up, not a guarantee.'
      : 'This is an unreviewed community report. It may be inaccurate or already resolved.'),
    el('div', { class: 'row' }, confirmBtn, el('button', { class: 'btn', onclick: closeModal }, 'Close')),
    !me ? el('p', { class: 'small muted', style: 'margin-top:8px' }, 'Sign in to confirm reports.') : null,
    adminRow,
  ]);
}
