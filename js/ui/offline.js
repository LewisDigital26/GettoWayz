// Offline maps screen — save the current view, the area around you or the whole city; list and delete saved areas.
import { el, esc, fmtAgo } from '../util.js';
import { state } from '../state.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './sheet.js';
import { listPacks, downloadPack, deletePack, tilesFor, estimateBytes, bboxAround, offlineSupported, storageUse, MAX_TILES } from '../offline.js';

const mb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const COVENTRY = { south: 52.36, west: -1.62, north: 52.47, east: -1.42 };

export async function openOfflineMaps(ctx) {
  if (!offlineSupported()) {
    return openModal('Offline maps', [el('p', {}, 'Offline maps need the vector map (OpenFreeMap) and a browser that supports offline storage. This device or setting doesn\'t, so the map needs a connection.')]);
  }
  const b = ctx.map.map.getBounds();
  const view = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  const here = state.position ? [state.position.lat, state.position.lng] : ctx.map.center();
  const options = [
    { key: 'view', label: 'This map view', bbox: view, name: 'Map area' },
    { key: 'near', label: 'About 3 km around ' + (state.position ? 'me' : 'the map centre'), bbox: bboxAround(here, 3), name: state.position ? 'Around me' : 'Around map centre' },
    { key: 'city', label: 'All of Coventry', bbox: COVENTRY, name: 'Coventry' },
  ].map((o) => ({ ...o, tiles: tilesFor(o.bbox).length }));
  let pick = options.find((o) => o.tiles <= MAX_TILES) || options[0];

  const packs = listPacks();
  const use = await storageUse();
  const opts = el('div', { class: 'list' }, ...options.map((o) => {
    const too = o.tiles > MAX_TILES;
    const r = el('input', { type: 'radio', name: 'gw-offline-area', checked: o === pick, disabled: too, onchange: () => { pick = o; } });
    return el('label', { class: 'item', style: `cursor:${too ? 'not-allowed' : 'pointer'};opacity:${too ? .5 : 1}` }, r,
      el('div', { class: 'body' }, el('div', { class: 't' }, o.label),
        el('div', { class: 's' }, too ? `Too big (${o.tiles} tiles, max ${MAX_TILES}) — zoom in first` : `About ${mb(estimateBytes(o.tiles))} · ${o.tiles} map tiles`)));
  }));
  const bar = el('div', { class: 'levelbar', hidden: true, role: 'progressbar', 'aria-label': 'Download progress' }, el('i', { style: 'width:0%' }));
  const status = el('p', { class: 'small muted', style: 'margin:6px 0 0' });
  const go = el('button', { class: 'btn primary block', style: 'margin-top:10px' }, '📥 Save for offline');
  const cancel = el('button', { class: 'btn block ghost', style: 'margin-top:8px', hidden: true }, 'Cancel');
  let ctl = null;
  cancel.onclick = () => ctl?.abort();
  go.onclick = async () => {
    if (!navigator.onLine) { toast('You need a connection to download a map area', 'error'); return; }
    ctl = new AbortController();
    go.disabled = true; bar.hidden = false; cancel.hidden = false; status.textContent = 'Getting the map style…';
    try {
      const pack = await downloadPack({ name: pick.name, bbox: pick.bbox }, {
        signal: ctl.signal,
        onProgress: ({ done, total, bytes }) => { bar.firstChild.style.width = `${Math.round((done / total) * 100)}%`; bar.setAttribute('aria-valuenow', String(Math.round((done / total) * 100))); status.textContent = `${done} / ${total} tiles · ${mb(bytes)}`; },
      });
      toast(`Saved "${pack.name}" for offline (${mb(pack.bytes)})${pack.failed ? ` — ${pack.failed} tiles failed, try again later to fill gaps` : ''}`, 'success');
      openOfflineMaps(ctx); // refresh the list in place
    } catch (e) {
      toast(e.name === 'AbortError' ? 'Download cancelled' : `Couldn't save the area: ${e.message}`, e.name === 'AbortError' ? '' : 'error');
      go.disabled = false; cancel.hidden = true; bar.hidden = true; status.textContent = '';
    }
  };

  openModal('📥 Offline maps', [
    el('p', { class: 'muted small' }, 'Save an area so the map still shows with no signal. Your community paths and alerts are kept too (as of the last time you were online). Routing and search still need a connection.'),
    el('div', { class: 'quick-label' }, 'Save a new area'),
    opts, go, bar, status, cancel,
    el('div', { class: 'quick-label', style: 'margin-top:14px' }, `Saved areas (${packs.length})`),
    packs.length ? el('div', { class: 'list' }, ...packs.map((p) => el('div', { class: 'item' },
      el('div', { class: 'emoji' }, '🗺️'),
      el('div', { class: 'body' }, el('div', { class: 't' }, esc(p.name)), el('div', { class: 's' }, `${mb(p.bytes)} · saved ${fmtAgo(p.at)}`)),
      el('button', { class: 'btn sm', onclick: () => { closeModal(); ctx.map.map.fitBounds([[p.bbox.south, p.bbox.west], [p.bbox.north, p.bbox.east]]); } }, 'Show'),
      el('button', { class: 'btn sm ghost', onclick: async () => { await deletePack(p.id); toast('Saved area deleted'); openOfflineMaps(ctx); } }, 'Delete'))))
      : el('p', { class: 'small muted' }, 'None yet.'),
    use ? el('p', { class: 'small', style: 'color:var(--text-3);margin-top:10px' }, `GettoWayz is using ${mb(use.used)} of storage on this device. Saved areas refresh themselves while you\'re online and viewing them.`) : null,
    el('p', { class: 'small', style: 'color:var(--text-3)' }, 'Map data © OpenStreetMap contributors, tiles by OpenFreeMap.'),
  ]);
}
