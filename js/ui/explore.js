// Explore nearby — browse OpenStreetMap places by category, see them on the map, open a place sheet with
// directions, OSM facts and community reviews. Reviews never earn points (see backend / migration-008).
import { el, esc, fmtDistance, fmtAgo } from '../util.js';
import { state } from '../state.js';
import { CATEGORIES, CATEGORY_MAP, GROUPS, QUICK, searchPlaces, fetchPlace, enrichPlace, placeFacts } from '../providers/places.js';
import { renderSheet, collapse, hideSheet, toast } from './sheet.js';
import { openModal, closeModal } from './modal.js';
import { requireSignIn } from './account.js';

const here = (ctx) => (state.position ? [state.position.lat, state.position.lng] : ctx.map.center());
const hereLabel = () => (state.position ? 'you' : 'here');
export const shapeOf = (p) => GROUPS[CATEGORY_MAP[p.cat]?.group]?.shape || 'round';
export const emojiOf = (p) => CATEGORY_MAP[p.cat]?.emoji || '📍';

export function stars(n, { size = 'sm' } = {}) {
  const r = Math.round(Number(n) || 0);
  return el('span', { class: `stars ${r ? '' : 'muted'}`, 'aria-label': r ? `${r} out of 5 stars` : 'No rating', style: size === 'lg' ? 'font-size:18px' : '' }, '★'.repeat(r) + '☆'.repeat(5 - r));
}
function ratingChip(sum) {
  return sum ? el('span', { class: 'chip accent', title: `${sum.count} community review${sum.count === 1 ? '' : 's'}` }, `★ ${Number(sum.avg).toFixed(1)} · ${sum.count} review${sum.count === 1 ? '' : 's'}`) : null;
}

// Explore state kept between sheets so Back returns to the same list.
const ex = { cat: null, places: [], ratings: {}, near: null };

function drawMarkers(ctx, activeId = null) {
  ctx.map.renderPlaces(ex.places, { shapeOf, emojiOf, activeId, ratings: ex.ratings, onClick: (p) => openPlace(ctx, p) });
}
export function clearExplore(ctx) { ex.cat = null; ex.places = []; ctx.exploreOpen = false; ctx.map.clearPlaces(); }

/** Category picker (all ~24 categories, grouped). */
export function openExplore(ctx) {
  ctx.exploreOpen = true; // keeps background data refreshes from replacing this sheet with Home
  ctx.map.clearPlaces();
  hideSheet(false); collapse(false);
  const back = el('button', { class: 'btn sm ghost', onclick: () => ctx.showHome() }, 'Back');
  renderSheet([
    el('div', { class: 'sheet-title' }, el('h2', {}, `🧭 Explore near ${hereLabel()}`), back),
    el('p', { class: 'muted small', style: 'margin:0 0 10px' }, 'Places within 1 km from OpenStreetMap. Tap a category, then tap a place for details, directions and community reviews.'),
    el('div', { class: 'cat-groups' },
      ...Object.entries(GROUPS).map(([g, grp]) => el('div', { class: 'cat-group' },
        el('div', { class: 'quick-label' }, grp.label),
        el('div', { class: 'quick-finds', role: 'list' },
          ...CATEGORIES.filter((c) => c.group === g).map((c) => el('button', { class: 'btn sm quick', role: 'listitem', onclick: () => openCategory(ctx, c) }, c.emoji, ' ', c.label)))))),
    el('p', { class: 'small', style: 'color:var(--text-3);margin:4px 0 0' }, 'Shown exactly as mapped by OpenStreetMap contributors. Reviews are from GettoWayz members and are opinions, not facts.'),
  ]);
}

/** One category: list + markers. */
export async function openCategory(ctx, cat) {
  ctx.exploreOpen = true;
  const near = here(ctx);
  const title = `${cat.emoji} ${cat.label} near ${hereLabel()}`;
  const back = el('button', { class: 'btn sm ghost', onclick: () => openExplore(ctx) }, 'Back');
  const head = () => el('div', { class: 'sheet-title' }, el('h2', {}, title), back);
  hideSheet(false); collapse(false);
  if (!state.online) { renderSheet([head(), el('div', { class: 'empty' }, 'You are offline — nearby search needs a connection.')]); return; }
  renderSheet([head(), el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Searching OpenStreetMap…')]);
  let places;
  try { places = await searchPlaces(cat, near); }
  catch (e) { if (e.name === 'AbortError') return; renderSheet([head(), el('div', { class: 'empty' }, 'Nearby search is unavailable right now. Try again in a moment.')]); return; }
  if (state.destination) return; // user moved on
  ex.cat = cat; ex.places = places; ex.near = near; ex.ratings = {};
  drawMarkers(ctx);
  if (places.length) ctx.map.fitPoints([near, ...places.slice(0, 12).map((p) => [p.lat, p.lng])]);
  const list = el('div', { class: 'list' });
  const row = (p) => el('button', { class: 'item', style: 'text-align:left;border:0;width:100%', onclick: () => openPlace(ctx, p) },
    el('div', { class: 'emoji' }, cat.emoji),
    el('div', { class: 'body' },
      el('div', { class: 't' }, p.name),
      el('div', { class: 's' }, p.sub || cat.label),
      el('div', { class: 'meta' }, el('span', { class: 'chip' }, fmtDistance(p.dist)), ratingChip(ex.ratings[p.key]))));
  const fill = () => list.replaceChildren(...places.slice(0, 30).map(row));
  fill();
  renderSheet([
    head(),
    places.length ? list : el('div', { class: 'empty' }, el('div', { class: 'big' }, cat.emoji), `Nothing tagged as ${cat.label.toLowerCase()} within 1 km on OpenStreetMap.`),
    el('p', { class: 'small muted', style: 'margin-top:8px' }, 'Results © OpenStreetMap contributors. Tap one for details and reviews.'),
  ]);
  // Community star badges arrive after the list is shown so the search never waits on the backend.
  ctx.backend.placeReviewSummary?.(places.map((p) => p.key)).then((r) => { if (ex.cat !== cat) return; ex.ratings = r || {}; fill(); drawMarkers(ctx); }).catch(() => {});
}

/** Place sheet: facts, directions, reviews. */
export async function openPlace(ctx, place) {
  const cat = CATEGORY_MAP[place.cat];
  ctx.exploreOpen = true;
  hideSheet(false); collapse(false);
  ctx.map.flyTo([place.lat, place.lng], Math.max(ctx.map.zoom(), 16));
  if (ex.places.some((p) => p.id === place.id)) drawMarkers(ctx, place.id);
  else { ex.places = [place]; drawMarkers(ctx, place.id); }
  const back = el('button', { class: 'btn sm ghost', onclick: () => (ex.cat ? openCategory(ctx, ex.cat) : openExplore(ctx)) }, 'Back');
  const head = () => el('div', { class: 'sheet-title' }, el('h2', {}, `${cat?.emoji || '📍'} ${place.name}`), back);
  const reviewsBox = el('div', {}, el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Loading reviews…'));
  if (!place.enriched) {
    renderSheet([head(), el('div', { class: 'loading-row' }, el('span', { class: 'spinner' }), 'Loading details…')]);
    await enrichPlace(place);
    if (state.destination) return; // user moved on
  }
  const facts = placeFacts(place.tags);
  renderSheet([
    head(),
    el('div', { class: 'muted small', style: 'margin:-4px 0 8px' }, [place.sub, place.dist != null ? `${fmtDistance(place.dist)} from ${hereLabel()}` : null].filter(Boolean).join(' · ')),
    el('div', { class: 'row wrap', style: 'margin-bottom:10px' },
      el('button', { class: 'btn primary', onclick: () => { clearExplore(ctx); ctx.setDestination({ id: place.id, name: place.name, sub: place.sub, lat: place.lat, lng: place.lng, source: 'osm' }); } }, '➜ Directions'),
      el('button', { class: 'btn', onclick: () => requireSignIn(ctx, 'write a review') && openReviewForm(ctx, place, null, () => openPlace(ctx, place)) }, '✍️ Write a review')),
    facts.length ? el('div', { class: 'facts' }, ...facts.map((f) => el('div', { class: 'fact' },
      el('span', { class: 'ico', 'aria-hidden': 'true' }, f.ico),
      el('div', {}, el('div', { class: 'k' }, f.label), f.href ? el('a', { href: f.href, target: '_blank', rel: 'noopener' }, f.value) : el('div', {}, f.value)))))
      : el('p', { class: 'small muted' }, 'OpenStreetMap has no extra details for this place yet.'),
    el('div', { class: 'quick-label' }, 'Community reviews'),
    reviewsBox,
    el('p', { class: 'small', style: 'color:var(--text-3);margin-top:10px' }, 'Facts come from OpenStreetMap contributors. Reviews are members’ opinions; they never earn points and can be reported. © OpenStreetMap contributors.'),
  ]);
  await renderReviews(ctx, place, reviewsBox);
}

async function renderReviews(ctx, place, box) {
  let reviews = [];
  try { reviews = await ctx.backend.listPlaceReviews?.(place.key) || []; }
  catch (e) { box.replaceChildren(el('div', { class: 'notice warn' }, esc(e.message || 'Reviews are unavailable right now.'))); return; }
  const visible = reviews.filter((r) => !r.hidden);
  const avg = visible.length ? Math.round((visible.reduce((n, r) => n + r.rating, 0) / visible.length) * 10) / 10 : null;
  const summary = el('div', { class: 'row', style: 'margin-bottom:8px' },
    avg ? stars(avg, { size: 'lg' }) : stars(0, { size: 'lg' }),
    el('span', { class: 'muted small' }, avg ? `${avg.toFixed(1)} from ${visible.length} review${visible.length === 1 ? '' : 's'}` : 'No reviews yet — be the first.'));
  const card = (r) => {
    const own = r.mine, admin = state.user?.role === 'admin';
    const actions = [];
    if (own) {
      actions.push(el('button', { class: 'btn sm ghost', onclick: () => openReviewForm(ctx, place, r, () => openPlace(ctx, place)) }, 'Edit'));
      actions.push(el('button', { class: 'btn sm ghost', onclick: async () => { if (!confirm('Delete your review?')) return; try { await ctx.backend.deleteMyReview(r.id); toast('Review deleted'); openPlace(ctx, place); } catch (e) { toast(e.message, 'error'); } } }, 'Delete'));
    } else if (state.user) {
      actions.push(r.reportedByMe ? el('span', { class: 'chip' }, 'Reported') : el('button', { class: 'btn sm ghost', onclick: () => openReportReview(ctx, r, () => openPlace(ctx, place)) }, 'Report'));
    }
    if (admin && !own) actions.push(el('button', { class: `btn sm ${r.hidden ? 'primary' : 'danger'}`, onclick: async () => {
      const reason = r.hidden ? '' : (prompt('Reason for hiding (shown in the log):') ?? null);
      if (reason === null) return;
      try { await ctx.backend.adminSetReviewHidden(r.id, !r.hidden, reason); toast(r.hidden ? 'Review restored' : 'Review hidden', 'success'); openPlace(ctx, place); } catch (e) { toast(e.message, 'error'); }
    } }, r.hidden ? 'Restore' : 'Hide'));
    return el('div', { class: `review ${r.hidden ? 'hidden' : ''}` },
      el('div', { class: 'who' }, el('span', {}, el('strong', {}, esc(r.alias || 'member')), own ? el('span', { class: 'chip accent', style: 'margin-left:6px' }, 'You') : null), el('span', { class: 'muted' }, fmtAgo(r.updatedAt))),
      stars(r.rating),
      r.body ? el('div', { class: 'body' }, r.body) : null,
      r.hidden ? el('div', { class: 'small', style: 'color:var(--pending)' }, r.hiddenReason?.startsWith('reports:') ? `Hidden after ${r.reportCount} reports — a moderator will review it.` : 'Hidden by a moderator.') : null,
      actions.length ? el('div', { class: 'row wrap', style: 'margin-top:6px' }, ...actions) : null);
  };
  box.replaceChildren(summary, reviews.length ? el('div', { class: 'stack' }, ...reviews.map(card)) : null);
}

/** Write / edit my review. */
export function openReviewForm(ctx, place, existing, after) {
  let rating = existing?.rating || 0;
  const pick = el('div', { class: 'star-pick', role: 'radiogroup', 'aria-label': 'Star rating' });
  const paint = () => pick.replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', { type: 'button', class: n <= rating ? 'on' : '', role: 'radio', 'aria-checked': String(n === rating), 'aria-label': `${n} star${n === 1 ? '' : 's'}`, onclick: () => { rating = n; paint(); } }, '★')));
  paint();
  const body = el('textarea', { maxlength: '500', placeholder: 'What was it like? Keep it about the place, not people. (optional)' }, existing?.body || '');
  const count = el('div', { class: 'small muted', style: 'text-align:right' }, `${body.value.length}/500`);
  body.addEventListener('input', () => { count.textContent = `${body.value.length}/500`; });
  const submit = async () => {
    if (!rating) return toast('Pick a star rating first', 'error');
    try {
      await ctx.backend.writePlaceReview({ placeKey: place.key, placeName: place.name, lat: place.lat, lng: place.lng, rating, body: body.value });
      closeModal(); toast(existing ? 'Review updated' : 'Thanks — your review is live', 'success'); after?.();
    } catch (e) { toast(e.message, 'error'); }
  };
  openModal(existing ? 'Edit your review' : `Review ${place.name}`, [
    el('p', { class: 'muted small' }, 'One review per place; writing again replaces it. Up to 5 new reviews a day. Reviews do not earn points. Other members can report a review and three reports hide it until a moderator checks.'),
    pick,
    el('div', { class: 'field' }, body),
    count,
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: submit }, existing ? 'Save' : 'Post review'), el('button', { class: 'btn', onclick: closeModal }, 'Cancel')),
  ]);
}

function openReportReview(ctx, review, after) {
  const reason = el('select', {}, ...['Spam or advertising', 'Abusive or offensive', 'Not about this place', 'Personal information about someone', 'Other'].map((o) => el('option', { value: o }, o)));
  openModal('Report this review', [
    el('p', { class: 'muted small' }, 'Reports go to moderators. A review is hidden automatically once three different people report it.'),
    el('div', { class: 'field' }, el('label', {}, 'Why?'), reason),
    el('div', { class: 'row' }, el('button', { class: 'btn danger', onclick: async () => { try { await ctx.backend.reportReview(review.id, reason.value); closeModal(); toast('Thanks — reported to moderators'); after?.(); } catch (e) { toast(e.message, 'error'); } } }, 'Report'), el('button', { class: 'btn', onclick: closeModal }, 'Cancel')),
  ]);
}

/** Profile › My reviews. */
export async function openMyReviews(ctx) {
  if (!requireSignIn(ctx, 'see your reviews')) return;
  let mine = [];
  try { mine = await ctx.backend.myPlaceReviews?.() || []; } catch (e) { toast(e.message, 'error'); return; }
  openModal('My reviews', [
    el('p', { class: 'muted small' }, `${mine.length} review${mine.length === 1 ? '' : 's'}. Tap one to open the place.`),
    mine.length ? el('div', { class: 'stack' }, ...mine.map((r) => el('button', { class: 'item', style: 'text-align:left;border:0;width:100%', onclick: async () => {
      closeModal(); ctx.showTab?.('map');
      const p = await fetchPlace(r.placeKey, here(ctx)).catch(() => null);
      openPlace(ctx, p || { id: 'osm-' + r.placeKey.replace('/', '-'), key: r.placeKey, name: r.placeName || 'Place', sub: '', lat: r.lat, lng: r.lng, cat: null, source: 'osm', dist: null, tags: {} });
    } },
      el('div', { class: 'emoji' }, '📍'),
      el('div', { class: 'body' }, el('div', { class: 't' }, r.placeName || 'Place'), stars(r.rating), r.body ? el('div', { class: 's' }, r.body.slice(0, 120)) : null,
        el('div', { class: 'meta' }, el('span', { class: 'chip' }, fmtAgo(r.updatedAt)), r.hidden ? el('span', { class: 'chip pending' }, 'Hidden') : null)))))
      : el('div', { class: 'empty' }, el('div', { class: 'big' }, '✍️'), 'You have not reviewed anywhere yet. Open Explore on the map to find places.'),
  ]);
}

/** Moderation queue section: hidden reviews. Returns a DOM node for admin.js. */
export async function hiddenReviewsSection(ctx) {
  const list = await ctx.backend.adminHiddenReviews?.().catch(() => []) || [];
  const card = (r) => el('div', { class: 'card' },
    el('div', { class: 'row between' }, el('strong', {}, `${esc(r.alias)} on ${esc(r.placeName || r.placeKey)}`), el('span', { class: 'chip pending' }, r.hiddenReason?.startsWith('reports:') ? `${r.reportCount} reports` : 'Hidden by mod')),
    el('div', { class: 'row', style: 'margin:4px 0' }, stars(r.rating), el('span', { class: 'small muted' }, fmtAgo(r.createdAt))),
    r.body ? el('div', { class: 'small', style: 'margin-bottom:6px;white-space:pre-wrap' }, r.body) : null,
    r.reports?.length ? el('div', { class: 'small muted', style: 'margin-bottom:6px' }, 'Reports: ' + r.reports.map((x) => `${x.alias} — ${x.reason || 'no reason'}`).join(' · ')) : null,
    r.hiddenReason?.startsWith('moderator:') ? el('div', { class: 'small muted', style: 'margin-bottom:6px' }, `Reason: ${esc(r.hiddenReason.slice(10) || 'none given')}`) : null,
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn sm primary', onclick: async () => { try { await ctx.backend.adminSetReviewHidden(r.id, false, 'restored'); toast('Review restored', 'success'); ctx.reopenAdmin?.(); } catch (e) { toast(e.message, 'error'); } } }, 'Restore'),
      r.hiddenReason?.startsWith('reports:') ? el('button', { class: 'btn sm danger', onclick: async () => { const why = prompt('Reason (kept in the log):'); if (why === null) return; try { await ctx.backend.adminSetReviewHidden(r.id, true, why); toast('Kept hidden', 'success'); ctx.reopenAdmin?.(); } catch (e) { toast(e.message, 'error'); } } }, 'Keep hidden') : null,
      el('button', { class: 'btn sm ghost', onclick: async () => { closeModal(); ctx.showTab?.('map'); const p = await fetchPlace(r.placeKey, here(ctx)).catch(() => null); if (p) openPlace(ctx, p); else toast('Could not load that place', 'error'); } }, 'Open place')));
  return [
    el('h3', { style: 'font-size:15px;margin:16px 0 6px' }, `Hidden reviews (${list.length})`),
    el('p', { class: 'muted small' }, 'Reviews hidden after three reports, or by a moderator. Restoring clears the reports. Hiding never affects points — reviews have none.'),
    list.length ? el('div', { class: 'list' }, ...list.map(card)) : el('div', { class: 'empty' }, 'No hidden reviews.'),
  ];
}
