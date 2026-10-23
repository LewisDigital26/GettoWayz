// Moderation screen — review path suggestions and alerts. Admin role only (enforced by the backend too).
import { el, esc, fmtAgo, fmtDistance, lineLength } from '../util.js';
import { state } from '../state.js';
import { ALERT_CATEGORIES, PATH_TYPES, SURFACES, POINT_RULE_MAP } from '../backend/rules.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';

export async function openAdmin(ctx, opts = {}) {
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

  const trips = await ctx.backend.adminTripsForReview?.().catch(() => []) || [];
  const tripCard = (t) => {
    const reason = el('input', { placeholder: 'Reason (required to reject)', maxlength: '200' });
    const act = async (d) => {
      if (d === 'reject' && reason.value.trim().length < 3) return toast('Add a short reason', 'error');
      try { const n = await ctx.backend.adminReviewTrip(t.id, d, reason.value); toast(d === 'approve' ? `Approved — +${n} points` : 'Trip rejected', 'success'); openAdmin(ctx); } catch (e) { toast(e.message, 'error'); }
    };
    return el('div', { class: 'card' },
      el('div', { class: 'row between' }, el('strong', {}, `${esc(t.alias)} · ${t.mode}`), el('span', { class: 'chip pending' }, (t.flags || []).includes('speed') ? 'Fast segment' : 'Fast overall')),
      el('div', { class: 'small muted', style: 'margin:4px 0' }, `${t.day} · ~${fmtDistance(t.eligibleM || 0)} of ${fmtDistance(t.routeM || 0)} route · ${t.minutes} min · ${t.checkpoints} checks · would award +${(t.basePoints || 0) + (t.distancePoints || 0)}`),
      el('div', { class: 'field' }, reason),
      el('div', { class: 'row wrap' }, el('button', { class: 'btn sm primary', onclick: () => act('approve') }, 'Approve points'), el('button', { class: 'btn sm danger', onclick: () => act('reject') }, 'Reject')));
  };
  const lookupInput = el('input', { placeholder: 'Alias', maxlength: '20', autocapitalize: 'off' });
  const lookupOut = el('div');
  const lookup = async () => {
    lookupOut.replaceChildren(el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Looking up…'));
    try {
      const u = await ctx.backend.adminUserPoints(lookupInput.value);
      if (!u) return lookupOut.replaceChildren(el('div', { class: 'notice' }, 'No user with that alias.'));
      lookupOut.replaceChildren(el('div', { class: 'small muted', style: 'margin:6px 0' }, `${esc(u.alias)} · ${u.points} pts · level floor ${u.levelFloor}`),
        u.entries.length ? el('div', { class: 'list' }, ...u.entries.map((e) => {
          const reason = el('input', { placeholder: 'Reason for reversal (required)', maxlength: '300' });
          const canReverse = ['awarded', 'capped'].includes(e.status) && e.rule !== 'reversal';
          return el('div', { class: 'card' },
            el('div', { class: 'row between' }, el('strong', {}, POINT_RULE_MAP[e.rule]?.label || e.rule), el('strong', {}, `${e.points > 0 ? '+' : ''}${e.points}`)),
            el('div', { class: 'small muted' }, `${new Date(e.at).toLocaleString('en-GB')} · ${e.status}${e.refType ? ` · ${e.refType}:${String(e.refId).slice(0, 8)}` : ''}${e.reason ? ` · “${esc(e.reason)}”` : ''}`),
            canReverse ? el('div', {}, el('div', { class: 'field', style: 'margin-top:6px' }, reason),
              el('div', { class: 'row wrap' },
                el('button', { class: 'btn sm danger', onclick: async () => { try { await ctx.backend.adminReverseAward(e.id, reason.value); toast('Award reversed and logged', 'success'); lookup(); } catch (err) { toast(err.message, 'error'); } } }, 'Reverse this award'),
                ['path', 'alert'].includes(e.refType) ? el('button', { class: 'btn sm ghost', onclick: async () => { try { const n = await ctx.backend.adminReverseSource(e.refType, e.refId, reason.value); toast(`Contribution removed; ${n} pts reversed across all awards`, 'success'); lookup(); } catch (err) { toast(err.message, 'error'); } } }, `Remove ${e.refType} + reverse all its awards`) : null)) : null);
        })) : el('div', { class: 'empty' }, 'No points yet.'));
    } catch (e) { lookupOut.replaceChildren(el('div', { class: 'notice danger' }, esc(e.message))); }
  };

  // Add or remove points by hand — for testing, or to correct a mistake. Logged and shown in the user's history.
  const grantAlias = el('input', { placeholder: 'Alias', maxlength: '20', autocapitalize: 'off', value: state.user?.alias || '', 'aria-label': 'Alias to adjust' });
  const grantPts = el('input', { type: 'number', inputmode: 'numeric', min: '-1000', max: '1000', step: '1', value: '50', 'aria-label': 'Points (negative removes)' });
  const grantReason = el('input', { placeholder: 'Reason (required, e.g. testing levels)', maxlength: '300', value: 'Testing points', 'aria-label': 'Reason' });
  const grant = async (sign = 1) => {
    try {
      const r = await ctx.backend.adminGrantPoints(grantAlias.value, sign * Math.abs(Math.trunc(Number(grantPts.value) || 0)), grantReason.value);
      toast(`${r.points > 0 ? '+' : ''}${r.points} pts for ${r.alias} · total ${r.total}`, 'success');
      ctx.refreshBadges?.(); ctx.refreshPage?.();
      lookupInput.value = r.alias; lookup();
    } catch (err) { toast(err.message, 'error'); }
  };
  const grantForm = el('div', { class: 'card' },
    el('div', { class: 'row', style: 'align-items:stretch' }, el('div', { class: 'field', style: 'flex:1;margin:0' }, grantAlias), el('div', { class: 'field', style: 'width:96px;flex:none;margin:0' }, grantPts)),
    el('div', { class: 'field', style: 'margin-top:6px' }, grantReason),
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn sm primary', onclick: () => grant(1) }, 'Add points'),
      el('button', { class: 'btn sm ghost', onclick: () => grant(-1) }, 'Remove points')));

  openModal('Moderation queue', [
    el('p', { class: 'muted small' }, 'Approve only paths that are clearly public and legal to use. Approval adds the path to the community map and awards points to the contributor. Verifying an alert awards points to the reporter and anyone who confirmed it. Every action is logged.'),
    el('h3', { style: 'font-size:15px;margin:10px 0 6px' }, `Path suggestions (${pendingPaths.length})`),
    pendingPaths.length ? el('div', { class: 'list' }, ...pendingPaths.map(pathCard)) : el('div', { class: 'empty' }, 'Queue is empty.'),
    el('h3', { style: 'font-size:15px;margin:16px 0 6px' }, `Alerts awaiting review (${pendingAlerts.length})`),
    pendingAlerts.length ? el('div', { class: 'list' }, ...pendingAlerts.map(alertCard)) : el('div', { class: 'empty' }, 'Nothing to review.'),
    el('h3', { style: 'font-size:15px;margin:16px 0 6px' }, `Trips held for review (${trips.length})`),
    el('p', { class: 'muted small' }, 'Trips that looked too fast for their travel mode. No locations are stored — only the summary below. Approve only if it looks plausible.'),
    trips.length ? el('div', { class: 'list' }, ...trips.map(tripCard)) : el('div', { class: 'empty' }, 'No trips to check.'),
    el('h3', { id: 'adminGrant', style: 'font-size:15px;margin:16px 0 6px' }, 'Add or remove points'),
    el('p', { class: 'muted small' }, 'For testing, or to fix a mistake. Up to 1000 at a time. Each change is logged, shows in that user’s points history with your reason, and can be reversed below. Moderators appear on leaderboards like anyone else once they opt in.'),
    grantForm,
    el('h3', { style: 'font-size:15px;margin:16px 0 6px' }, 'Points lookup & reversals'),
    el('p', { class: 'muted small' }, 'Reverse an award that turned out to be fraudulent or mistaken. The original entry is kept and marked reversed; the user sees the reversal and your reason. Users keep their highest level.'),
    el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:1;margin:0' }, lookupInput), el('button', { class: 'btn', onclick: lookup }, 'Find')),
    lookupOut,
  ], { onClose: () => { ctx.refreshBadges?.(); ctx.refreshPage?.(); } });
  if (opts.focus === 'grant') requestAnimationFrame(() => { document.getElementById('adminGrant')?.scrollIntoView({ block: 'start' }); grantPts.focus({ preventScroll: true }); grantPts.select?.(); });
}
