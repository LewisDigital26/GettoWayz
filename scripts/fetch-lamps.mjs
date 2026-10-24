// Downloads every streetlight OpenStreetMap knows about in and around Coventry and saves it as
// data/coventry-lamps.json, so the app never has to ask the (often overloaded) Overpass servers live.
// Run by .github/workflows/lamps.yml every week; can also be run by hand: `node scripts/fetch-lamps.mjs`
// (Node 18+). Tries several Overpass servers with long, patient timeouts — this runs on GitHub's
// machines, not on people's phones, so slowness here costs nothing.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'data', 'coventry-lamps.json');

// Coventry plus a margin (Kenilworth, Bedworth edge, Binley Woods, Balsall Common side).
const BBOX = { south: 52.34, west: -1.66, north: 52.50, east: -1.38 };

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const QUERY = `[out:json][timeout:180];node["highway"="street_lamp"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});out;`;

async function download() {
  let lastErr;
  for (let round = 1; round <= 3; round++) {
    for (const url of SERVERS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 200_000);
      try {
        console.log(`round ${round}: ${url}`);
        const res = await fetch(url, {
          method: 'POST', signal: ctl.signal,
          body: 'data=' + encodeURIComponent(QUERY),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GettoWayz lamp snapshot (github.com/LewisDigital26/GettoWayz)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error('no elements in reply');
        if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
        return json.elements;
      } catch (e) {
        lastErr = e; console.warn(`  failed: ${e.message}`);
      } finally { clearTimeout(timer); }
    }
    await new Promise((r) => setTimeout(r, 30_000 * round));
  }
  throw lastErr || new Error('all Overpass servers failed');
}

const elements = await download();
// Compact rows: [lat, lng, osmId, ref|null] with 6 decimals (~10 cm) to keep the file small.
const lamps = elements
  .filter((n) => n.type === 'node' && typeof n.lat === 'number')
  .map((n) => [+n.lat.toFixed(6), +n.lon.toFixed(6), n.id, n.tags?.ref || null])
  .sort((a, b) => a[2] - b[2]);

// Safety net: a sudden big drop almost always means a partial/broken download, not lamps vanishing.
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.lamps?.length && lamps.length < prev.lamps.length * 0.7) {
      console.error(`Refusing to overwrite: ${lamps.length} lamps vs ${prev.lamps.length} last time.`);
      process.exit(1);
    }
  } catch { /* unreadable old file: just replace it */ }
}
if (!lamps.length) { console.error('Download returned no lamps — keeping the old file.'); process.exit(1); }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  source: 'OpenStreetMap contributors (ODbL), node["highway"="street_lamp"]',
  updated: new Date().toISOString(),
  bbox: BBOX,
  fields: ['lat', 'lng', 'osmId', 'ref'],
  lamps,
}));
console.log(`Saved ${lamps.length} lamps to data/coventry-lamps.json`);
