// Downloads every Coventry road/path that OpenStreetMap tags as lit=yes or lit=no and saves it as
// data/coventry-lit.json for the "lit streets" overlay. Also prints coverage stats (how much of the
// walkable/rideable network carries a lit tag). Run weekly by .github/workflows/lamps.yml.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'data', 'coventry-lit.json');
const BBOX = { south: 52.34, west: -1.66, north: 52.50, east: -1.38 };
const B = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;

// Roads and paths people walk, cycle or scoot on (motorways left out).
const HW = 'trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|footway|path|cycleway|bridleway|steps|track';

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(q) {
  let lastErr;
  for (let round = 1; round <= 3; round++) {
    for (const url of SERVERS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 240_000);
      try {
        console.log(`round ${round}: ${url}`);
        const res = await fetch(url, {
          method: 'POST', signal: ctl.signal, body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GettoWayz lit snapshot (github.com/LewisDigital26/GettoWayz)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.remark && /error|timed out|runtime/i.test(json.remark)) throw new Error(json.remark);
        return json.elements || [];
      } catch (e) { lastErr = e; console.warn(`  failed: ${e.message}`); }
      finally { clearTimeout(timer); }
    }
    await new Promise((r) => setTimeout(r, 30_000 * round));
  }
  throw lastErr;
}

const R = 6371000, rad = (d) => d * Math.PI / 180;
const dist = (a, b) => { const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const lengthOf = (g) => { let m = 0; for (let i = 1; i < g.length; i++) m += dist(g[i - 1], g[i]); return m; };

// 1) every walkable way WITH geometry (needed for coverage %), 2) we keep only the tagged ones in the file.
const ways = await overpass(`[out:json][timeout:220];way["highway"~"^(${HW})$"](${B});out tags geom;`);

let totalM = 0, yesM = 0, noM = 0;
const rows = [];
for (const w of ways) {
  if (!w.geometry?.length) continue;
  const g = w.geometry.map((p) => [p.lat, p.lon]);
  const m = lengthOf(g);
  totalM += m;
  const lit = w.tags?.lit;
  const val = lit === 'no' || lit === 'disused' ? 0 : lit && lit !== 'unknown' ? 1 : null;   // yes/24/7/automatic/limited/sunset-sunrise → lit
  if (val === null) continue;
  if (val) yesM += m; else noM += m;
  // compact row: [lit 1/0, osmWayId, flat coords at 5 dp (~1 m)]
  rows.push([val, w.id, g.flatMap(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)])]);
}
const km = (m) => (m / 1000).toFixed(0);
const stats = {
  waysTotal: ways.length, waysTagged: rows.length,
  kmTotal: +km(totalM), kmLit: +km(yesM), kmUnlit: +km(noM),
  pctTagged: totalM ? Math.round(((yesM + noM) / totalM) * 100) : 0,
};
console.log(`Network: ${stats.kmTotal} km in ${stats.waysTotal} ways`);
console.log(`Tagged: ${stats.waysTagged} ways — lit ${stats.kmLit} km, unlit ${stats.kmUnlit} km (${stats.pctTagged}% of the network by length)`);

if (!rows.length) { console.error('No tagged ways — keeping the old file.'); process.exit(1); }
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.ways?.length && rows.length < prev.ways.length * 0.7) { console.error(`Refusing to overwrite: ${rows.length} ways vs ${prev.ways.length}.`); process.exit(1); }
  } catch { /* replace unreadable file */ }
}
rows.sort((a, b) => a[1] - b[1]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  source: 'OpenStreetMap contributors (ODbL), highway ways with a lit=* tag',
  updated: new Date().toISOString(), bbox: BBOX, stats,
  fields: ['lit(1=yes,0=no)', 'osmWayId', 'coords[lat,lng,lat,lng…]'],
  ways: rows,
}));
console.log(`Saved ${rows.length} ways to data/coventry-lit.json`);
