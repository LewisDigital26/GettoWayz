// Shared Overpass API client (OpenStreetMap data, no key, fair-use).
// Fast mirrors first, a short per-mirror timeout, and a 10-minute cache keyed by the caller.
// Two kinds of request: a user tap (cancels the previous tap) and a background prefetch (never cancels anything).

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const PER_REQUEST_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();          // key -> { at, value }
let userController = null;        // the in-flight user-initiated request

export function cached(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : undefined;
}

/**
 * Run an Overpass QL query. Returns the raw `elements` array.
 * @param {string} ql              query without the [out:json] header
 * @param {object} o               { key, background, timeoutS }
 */
export async function overpass(ql, { key = null, background = false, timeoutS = 8 } = {}) {
  if (key != null) { const v = cached(key); if (v !== undefined) return v; }
  let outer;
  if (background) outer = new AbortController().signal;
  else { userController?.abort(); userController = new AbortController(); outer = userController.signal; }
  const q = `[out:json][timeout:${timeoutS}];${ql}`;
  let lastErr;
  for (const url of ENDPOINTS) {
    if (outer.aborted) throw new DOMException('aborted', 'AbortError');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PER_REQUEST_MS);
    const onOuter = () => ctl.abort();
    outer.addEventListener('abort', onOuter, { once: true });
    try {
      const res = await fetch(url, { method: 'POST', body: `data=${encodeURIComponent(q)}`, signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      const elements = json.elements || [];
      if (key != null) cache.set(key, { at: Date.now(), value: elements });
      return elements;
    } catch (e) {
      if (outer.aborted) throw new DOMException('aborted', 'AbortError');
      lastErr = e;
    } finally {
      clearTimeout(timer);
      outer.removeEventListener('abort', onOuter);
    }
  }
  throw lastErr || new Error('OpenStreetMap search failed');
}
