// Device preferences (this browser only): in-app notices and accessibility. Never sent to the server.
const KEY = 'gw:prefs';
const DEFAULTS = { notifyShares: true, notifyRequests: true, largeText: false, reduceMotion: false };

let cache = null;
export function prefs() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { cache = { ...DEFAULTS }; }
  return cache;
}
export function setPref(key, value) {
  cache = { ...prefs(), [key]: value };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode: keep for this session */ }
  applyPrefs();
}
/** Large text and reduced motion are applied as classes on <html> (also done early in index.html to avoid a flash). */
export function applyPrefs() {
  const p = prefs(), root = document.documentElement;
  root.classList.toggle('large-text', !!p.largeText);
  root.classList.toggle('reduce-motion', !!p.reduceMotion);
}
export const motionOk = () => !prefs().reduceMotion && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
