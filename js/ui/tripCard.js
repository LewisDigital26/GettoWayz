// Shareable trip card — a picture of a finished trip (distance, time, mode, points, streak) for socials.
// Drawn on a canvas on the device. It never includes the route line or a map, and the destination name is off by default.
import { el, fmtDistance, fmtDuration, MODES, cssVar } from '../util.js';
import { openModal } from './modal.js';
import { toast } from './sheet.js';

const W = 1080, H = 1350;

function draw(canvas, info, { showDest }) {
  const c = canvas.getContext('2d');
  const navy = '#202b47', lime = cssVar('--accent') || '#aaf129', teal = '#2bb190';
  c.fillStyle = navy; c.fillRect(0, 0, W, H);
  // diagonal "route" stripes for texture (decorative, not the real route)
  c.save(); c.globalAlpha = .08; c.strokeStyle = lime; c.lineWidth = 26;
  for (let i = -H; i < W + H; i += 140) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + H * .6, H); c.stroke(); }
  c.restore();
  c.fillStyle = lime; c.fillRect(0, 0, W, 14);
  const font = (w, px, fam = 'Syne') => `${w} ${px}px ${fam}, system-ui, sans-serif`;
  c.textBaseline = 'alphabetic';
  // brand
  c.font = font(800, 64); c.fillStyle = '#fff'; c.fillText('Getto', 80, 150);
  const gw = c.measureText('Getto').width; c.fillStyle = lime; c.fillText('Wayz', 80 + gw, 150);
  c.font = font(500, 34, 'DM Sans'); c.fillStyle = 'rgba(255,255,255,.65)';
  c.fillText(new Date(info.at || Date.now()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }), 80, 205);
  // mode
  const mode = MODES[info.mode] || MODES.walk;
  c.font = font(700, 54, 'DM Sans'); c.fillStyle = '#fff'; c.fillText(`${mode.emoji}  ${mode.label}`, 80, 360);
  // big distance
  const big = fmtDistance(info.distanceM || 0);
  let px = 210; c.font = font(800, px);
  while (px > 90 && c.measureText(big).width > W - 150) { px -= 10; c.font = font(800, px); }
  c.fillStyle = lime; c.fillText(big, 70, 590);
  c.font = font(600, 46, 'DM Sans'); c.fillStyle = '#fff'; c.fillText(info.durationS ? `in ${fmtDuration(info.durationS)}` : 'trip complete', 80, 670);
  // stat tiles
  const tiles = [
    info.points ? [`+${info.points}`, 'points'] : null,
    info.streak ? [`🔥 ${info.streak}`, `day streak`] : null,
    info.ascentM != null ? [`${info.ascentM} m`, 'climbed'] : null,
    info.level ? [info.level, 'level'] : null,
  ].filter(Boolean).slice(0, 3);
  tiles.forEach(([big, small], i) => {
    const x = 80 + i * 320, y = 760;
    c.fillStyle = 'rgba(255,255,255,.07)'; roundRect(c, x, y, 290, 190, 28); c.fill();
    c.font = font(800, 64); c.fillStyle = '#fff'; c.fillText(big, x + 28, y + 100, 240);
    c.font = font(500, 32, 'DM Sans'); c.fillStyle = 'rgba(255,255,255,.65)'; c.fillText(small, x + 28, y + 150, 240);
  });
  if (showDest && info.destName) {
    c.font = font(500, 36, 'DM Sans'); c.fillStyle = 'rgba(255,255,255,.65)'; c.fillText('to', 80, 1060);
    c.font = font(700, 52, 'DM Sans'); c.fillStyle = '#fff'; c.fillText(info.destName.slice(0, 34), 130, 1062, W - 210);
  }
  c.font = font(700, 40, 'DM Sans'); c.fillStyle = '#fff'; c.fillText(info.alias ? `@${info.alias}` : '', 80, H - 110);
  c.font = font(500, 30, 'DM Sans'); c.fillStyle = teal; c.fillText('Routes made by the community', 80, H - 64);
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

/** info: { mode, distanceM, durationS, points?, streak?, ascentM?, level?, destName?, alias?, at? } */
export async function openTripCard(info) {
  const canvas = el('canvas', { width: W, height: H, class: 'tripcard-canvas', role: 'img', 'aria-label': `Trip card: ${fmtDistance(info.distanceM || 0)} ${MODES[info.mode]?.label || ''}` });
  let showDest = false;
  try { await document.fonts?.load('800 64px Syne'); } catch { /* system font fallback */ }
  draw(canvas, info, { showDest });
  const destToggle = info.destName ? el('label', { class: 'row', style: 'gap:8px;margin:8px 0' },
    el('input', { type: 'checkbox', onchange: (e) => { showDest = e.target.checked; draw(canvas, info, { showDest }); } }),
    el('span', { class: 'small' }, 'Show where I went')) : null;
  const blob = () => new Promise((r) => canvas.toBlob(r, 'image/png'));
  const share = async () => {
    const b = await blob(); if (!b) return toast('Could not make the image', 'error');
    const file = new File([b], 'gettowayz-trip.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text: `${fmtDistance(info.distanceM || 0)} ${MODES[info.mode]?.label.toLowerCase() || 'trip'} on GettoWayz` }); } catch { /* cancelled */ }
    } else download(b);
  };
  const download = (b) => { const a = el('a', { href: URL.createObjectURL(b), download: 'gettowayz-trip.png' }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
  openModal('Share your trip', [
    canvas,
    destToggle,
    el('p', { class: 'small muted' }, 'The card never shows your route or a map. Only add where you went if you\'re happy for people to see it.'),
    el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { class: 'btn primary block', onclick: share }, '📤 Share'),
      el('button', { class: 'btn', onclick: async () => download(await blob()) }, '⬇️ Save')),
  ]);
}
