// Basemap — vector tiles (OpenFreeMap, no key) rendered by MapLibre GL inside Leaflet, recoloured to the Ghetto Wayz palette.
// Falls back to raster OSM tiles (with the CSS dark filter) if WebGL/MapLibre is unavailable.
/* global L, maplibregl */
import { config } from './config.js';

// Palettes per colourway. 'day' keeps the vendor style's own (light) colours untouched.
const PALETTES = {
  default: {
    bg: '#161a26', land: '#1b2030', park: '#1f3a33', wood: '#1d3330', water: '#0f2340', building: '#222a3d', buildingLine: '#2c3650',
    roadMinor: '#2d3650', roadMinorCase: '#161a26', roadMajor: '#3b4766', roadMajorCase: '#161a26', motorway: '#4a5a84', motorwayCase: '#161a26',
    path: '#aaf129', cycle: '#2bb190', rail: '#3a4260', text: '#c9d1e8', textMuted: '#8e98b8', halo: '#161a26', boundary: '#3d4b78',
  },
  navy: {
    bg: '#141c33', land: '#182240', park: '#1b3a3e', wood: '#193538', water: '#0d1d3f', building: '#202b47', buildingLine: '#2b3860',
    roadMinor: '#2b3860', roadMinorCase: '#141c33', roadMajor: '#3a4b78', roadMajorCase: '#141c33', motorway: '#4a5f96', motorwayCase: '#141c33',
    path: '#aaf129', cycle: '#2bb190', rail: '#3d4b78', text: '#d6ddf2', textMuted: '#93a0c6', halo: '#141c33', boundary: '#3d4b78',
  },
  day: null, // leave the Liberty style as-is, just tint paths/cycleways
};

const DAY_PATH = { path: '#1f9a7c', cycle: '#202b47' };

export function vectorAvailable() {
  try {
    if (!window.maplibregl || !L.maplibreGL) return false;
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

export class VectorBasemap {
  constructor(map) {
    this.map = map;
    this.layer = L.maplibreGL({ style: config.VECTOR_STYLE_URL, attributionControl: false, pane: 'tilePane' }).addTo(map);
    this.gl = this.layer.getMaplibreMap();
    this.ready = false;
    this.gl.once('style.load', () => { this.ready = true; this.applyColourway(); });
    map.getContainer().classList.add('vector');
  }

  colourwayKey() { return document.documentElement.getAttribute('data-colourway') || 'default'; }

  /** Recolour the vendor style's layers to the active colourway. Safe to call repeatedly. */
  applyColourway() {
    if (!this.ready) return;
    const key = this.colourwayKey();
    const p = PALETTES[key] ?? PALETTES.default;
    const gl = this.gl;
    const has = (id) => !!gl.getLayer(id);
    const paint = (id, prop, val) => { if (has(id)) try { gl.setPaintProperty(id, prop, val); } catch { /* vendor style changed; ignore */ } };
    const ids = gl.getStyle().layers.map((l) => l.id);
    const each = (re, fn) => ids.filter((id) => re.test(id)).forEach(fn);

    // Paths / pedestrian / cycle get the brand colours in every colourway — they are the whole point of the app.
    const pathCol = p ? p.path : DAY_PATH.path;
    each(/^(road|bridge|tunnel)_path_pedestrian$/, (id) => { paint(id, 'line-color', pathCol); paint(id, 'line-opacity', .9); paint(id, 'line-dasharray', [1, 1.5]); });

    if (!p) { // day colourway: vendor colours, slightly calmer
      paint('background', 'background-color', '#eef1f6');
      return;
    }

    paint('background', 'background-color', p.bg);
    if (has('natural_earth')) paint('natural_earth', 'raster-opacity', 0);
    each(/^landuse_/, (id) => { paint(id, 'fill-color', p.land); paint(id, 'fill-opacity', .6); });
    each(/^landcover_(grass|wetland|sand|ice)$/, (id) => { paint(id, 'fill-color', p.park); paint(id, 'fill-opacity', .4); });
    paint('landcover_wood', 'fill-color', p.wood); paint('landcover_wood', 'fill-opacity', .55);
    paint('park', 'fill-color', p.park); paint('park', 'fill-opacity', .55);
    paint('park_outline', 'line-color', p.wood);
    paint('water', 'fill-color', p.water);
    each(/^waterway_(river|other|tunnel)$/, (id) => paint(id, 'line-color', p.water));
    paint('aeroway_fill', 'fill-color', p.land);
    each(/^aeroway_(runway|taxiway)$/, (id) => paint(id, 'line-color', p.roadMinor));
    paint('building', 'fill-color', p.building); paint('building', 'fill-outline-color', p.buildingLine); paint('building', 'fill-opacity', .9);
    if (has('building-3d')) paint('building-3d', 'fill-extrusion-color', p.building);

    // Roads: casings = background, fills graded by importance
    each(/^(road|bridge|tunnel)_.*_casing$/, (id) => paint(id, 'line-color', /motorway/.test(id) ? p.motorwayCase : /trunk|primary|secondary|tertiary/.test(id) ? p.roadMajorCase : p.roadMinorCase));
    each(/^(road|bridge|tunnel)_(minor|street|service_track|link|motorway_link)$/, (id) => paint(id, 'line-color', p.roadMinor));
    each(/^(road|bridge|tunnel)_(secondary_tertiary|trunk_primary)$/, (id) => paint(id, 'line-color', p.roadMajor));
    each(/^(road|bridge|tunnel)_motorway$/, (id) => paint(id, 'line-color', p.motorway));
    each(/^(road|bridge|tunnel)_(major|transit)_rail(_hatching)?$/, (id) => paint(id, 'line-color', p.rail));
    paint('road_area_pattern', 'fill-opacity', 0);
    each(/^road_one_way_arrow/, (id) => paint(id, 'icon-opacity', .5));

    // Boundaries + labels
    each(/^boundary_/, (id) => paint(id, 'line-color', p.boundary));
    each(/^(label_|highway-name|water_name|waterway_line_label|airport|poi_)/, (id) => {
      paint(id, 'text-color', /^(label_city|label_town|highway-name-major)/.test(id) ? p.text : p.textMuted);
      paint(id, 'text-halo-color', p.halo); paint(id, 'text-halo-width', 1.2);
    });
    each(/^poi_/, (id) => paint(id, 'icon-opacity', .55));
    each(/^(highway-shield|road_shield)/, (id) => paint(id, 'icon-opacity', .6));
  }

  invalidate() { try { this.gl.resize(); } catch { /* ignore */ } }
}
