/**
 * Bake a true-scale Hamilton→Oshawa land/water/ravine/island mask.
 * Sources:
 *  - Open Data Toronto / City GIS: Shoreline, River, Ravine (Open Government Licence – Toronto)
 *  - OpenStreetMap Overpass: Lake Ontario multipolygon (ODbL)
 *  - Natural Earth 10m lakes fallback for Lake Ontario outline (public domain)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const NODE = process.execPath;

const BBOX = {
  west: -79.95,
  east: -78.80,
  south: 43.25,
  north: 43.95,
};

const midLat = (BBOX.south + BBOX.north) / 2;
const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
const mPerDegLat = 110540;
const widthM = (BBOX.east - BBOX.west) * mPerDegLon;
const heightM = (BBOX.north - BBOX.south) * mPerDegLat;

const COLS = 96;
const ROWS = Math.max(8, Math.round((COLS * heightM) / widthM));

console.log('bbox', BBOX);
console.log(`widthM=${widthM.toFixed(0)} heightM=${heightM.toFixed(0)} aspect=${(widthM / heightM).toFixed(3)}`);
console.log(`grid ${COLS}x${ROWS} cell≈${(widthM / COLS).toFixed(0)}m`);

function lonToX(lon) {
  return ((lon - BBOX.west) / (BBOX.east - BBOX.west)) * COLS;
}
function latToY(lat) {
  /* y: 0 = north (inland), ROWS-1 = south (lake) — matches game */
  return ((BBOX.north - lat) / (BBOX.north - BBOX.south)) * ROWS;
}
function cellCenter(x, y) {
  const lon = BBOX.west + ((x + 0.5) / COLS) * (BBOX.east - BBOX.west);
  const lat = BBOX.north - ((y + 0.5) / ROWS) * (BBOX.north - BBOX.south);
  return [lon, lat];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon, lat, rings) {
  if (!rings || !rings.length) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lon, lat, rings[h])) return false; /* hole */
  }
  return true;
}

function collectPolygons(geom, out) {
  if (!geom) return;
  if (geom.type === 'Polygon') out.push(geom.coordinates);
  else if (geom.type === 'MultiPolygon') {
    for (const p of geom.coordinates) out.push(p);
  }
}

/* ---- Build Lake Ontario from OSM relation ---- */
function readJson(file) {
  let txt = fs.readFileSync(file, 'utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  return JSON.parse(txt);
}

function buildOsmLakeOntario() {
  const raw = readJson(path.join(DATA, 'osm-water.json'));
  const nodes = new Map();
  const ways = new Map();
  let lakeRel = null;
  for (const el of raw.elements) {
    if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
    else if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation' && el.tags && el.tags.name === 'Lake Ontario') lakeRel = el;
  }
  if (!lakeRel) {
    console.warn('Lake Ontario relation missing — trying Natural Earth');
    return buildNeLakeOntario();
  }
  const outers = [];
  const inners = [];
  for (const m of lakeRel.members || []) {
    if (m.type !== 'way') continue;
    const way = ways.get(m.ref);
    if (!way || !way.nodes) continue;
    const coords = way.nodes.map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 2) continue;
    if (m.role === 'inner') inners.push(coords);
    else outers.push(coords);
  }
  /* stitch outer rings that share endpoints */
  const rings = stitchRings(outers);
  const holeRings = stitchRings(inners);
  console.log(`OSM Lake Ontario: ${rings.length} outer rings, ${holeRings.length} holes`);
  /* Keep only rings that intersect our bbox */
  const polys = [];
  for (const outer of rings) {
    const clipped = outer; /* full ring; PIP still works for bbox cells */
    const poly = [clipped, ...holeRings.filter((h) => ringIntersectsRing(h, clipped))];
    polys.push(poly);
  }
  return polys.length ? polys : buildNeLakeOntario();
}

function ringIntersectsRing(a, b) {
  /* cheap bbox overlap */
  const bb = (r) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of r) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY };
  };
  const A = bb(a), B = bb(b);
  return !(A.maxX < B.minX || A.minX > B.maxX || A.maxY < B.minY || A.minY > B.maxY);
}

function stitchRings(segments) {
  if (!segments.length) return [];
  const unused = segments.map((s) => s.slice());
  const rings = [];
  while (unused.length) {
    let ring = unused.pop();
    let guard = 0;
    let extended = true;
    while (extended && guard++ < 5000) {
      extended = false;
      const start = ring[0];
      const end = ring[ring.length - 1];
      for (let i = 0; i < unused.length; i++) {
        const seg = unused[i];
        const s0 = seg[0];
        const s1 = seg[seg.length - 1];
        const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-5;
        if (near(end, s0)) {
          ring = ring.concat(seg.slice(1));
          unused.splice(i, 1);
          extended = true;
          break;
        }
        if (near(end, s1)) {
          ring = ring.concat(seg.slice(0, -1).reverse());
          unused.splice(i, 1);
          extended = true;
          break;
        }
        if (near(start, s1)) {
          ring = seg.slice(0, -1).concat(ring);
          unused.splice(i, 1);
          extended = true;
          break;
        }
        if (near(start, s0)) {
          ring = seg.slice(1).reverse().concat(ring);
          unused.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function buildNeLakeOntario() {
  const raw = readJson(path.join(DATA, 'ne_10m_lakes.geojson'));
  const polys = [];
  for (const f of raw.features) {
    const name = (f.properties && (f.properties.name || f.properties.NAME || f.properties.Name)) || '';
    if (!/ontario/i.test(name)) continue;
    collectPolygons(f.geometry, polys);
  }
  console.log(`NE Lake Ontario polygons: ${polys.length}`);
  return polys;
}

/* ---- Toronto shoreline islands (real only) ---- */
function loadTorontoIslands() {
  const raw = readJson(path.join(DATA, 'toronto-shoreline.geojson'));
  const islands = [];
  const ISLAND_RE = /island|muggs|forestry|olympic|algonquin|snake|south island/i;
  const MAIN_SHORE_RE = /shoreline|ontario pl/i;
  for (const f of raw.features) {
    const name = (f.properties && f.properties.LINEAR_NAME_FULL) || '';
    if (!ISLAND_RE.test(name) || MAIN_SHORE_RE.test(name)) continue;
    const g = f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      if (line.length < 4) continue;
      const closed =
        Math.hypot(line[0][0] - line[line.length - 1][0], line[0][1] - line[line.length - 1][1]) < 1e-4
          ? line
          : line.concat([line[0]]);
      /* Only keep rings in Toronto Islands harbour cluster */
      const lons = closed.map((c) => c[0]);
      const lats = closed.map((c) => c[1]);
      const clon = (Math.min(...lons) + Math.max(...lons)) / 2;
      const clat = (Math.min(...lats) + Math.max(...lats)) / 2;
      if (clon < -79.42 || clon > -79.34 || clat < 43.61 || clat > 43.64) continue;
      islands.push([closed]);
    }
  }
  console.log(`Toronto Islands rings: ${islands.length}`);
  return islands;
}

/* ---- Toronto rivers as ravine strokes ---- */
function loadRiverSegments() {
  const raw = readJson(path.join(DATA, 'toronto-rivers.geojson'));
  const segs = [];
  const KEEP = /don|humber|rouge|credit|duffin|highland|mimico|etobicoke creek|taylor|creek|river/i;
  for (const f of raw.features) {
    const name = (f.properties && f.properties.LINEAR_NAME_FULL) || '';
    if (name && !KEEP.test(name) && name.length > 2) {
      /* still include unnamed short segments? skip noise — keep major named only */
      if (!/don|humber|rouge|highland|mimico|etobicoke|taylor|duffin/i.test(name)) continue;
    }
    const g = f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      if (line.length >= 2) segs.push(line);
    }
  }
  console.log(`River segments: ${segs.length}`);
  return segs;
}

function loadRavinePolys() {
  const raw = readJson(path.join(DATA, 'toronto-ravines.geojson'));
  const polys = [];
  for (const f of raw.features) collectPolygons(f.geometry, polys);
  console.log(`Ravine polys: ${polys.length}`);
  return polys;
}

function distPointToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function nearRiver(lon, lat, segs, threshDeg) {
  for (const line of segs) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      if (distPointToSeg(lon, lat, a[0], a[1], b[0], b[1]) < threshDeg) return true;
    }
  }
  return false;
}

/* Known city anchors (lon, lat) for labels — real coords */
const CITIES = [
  { name: 'Hamilton', lon: -79.87, lat: 43.255 },
  { name: 'Burlington', lon: -79.80, lat: 43.325 },
  { name: 'Oakville', lon: -79.69, lat: 43.45 },
  { name: 'Mississauga', lon: -79.64, lat: 43.59 },
  { name: 'Etobicoke', lon: -79.54, lat: 43.62 },
  { name: 'Downtown Toronto', lon: -79.38, lat: 43.65 },
  { name: 'Toronto Islands', lon: -79.38, lat: 43.62 },
  { name: 'North York', lon: -79.41, lat: 43.76 },
  { name: 'Scarborough', lon: -79.23, lat: 43.73 },
  { name: 'Pickering', lon: -79.09, lat: 43.84 },
  { name: 'Ajax', lon: -79.02, lat: 43.85 },
  { name: 'Whitby', lon: -78.94, lat: 43.87 },
  { name: 'Oshawa', lon: -78.86, lat: 43.89 },
  { name: 'Lake Ontario', lon: -79.2, lat: 43.45 },
  { name: 'Highway 401', lon: -79.4, lat: 43.75 },
];

function main() {
  const lakePolys = buildOsmLakeOntario();
  const islandPolys = loadTorontoIslands();
  const riverSegs = loadRiverSegments();
  const ravinePolys = loadRavinePolys();

  /* cell types: 0 land, 1 water, 2 ravine, 3 island */
  const cells = new Uint8Array(COLS * ROWS);
  let waterN = 0, islandN = 0, ravN = 0;

  const riverThresh = (widthM / COLS) / mPerDegLon * 0.55; /* ~half cell in lon-deg */

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const [lon, lat] = cellCenter(x, y);
      let isWater = false;
      for (const poly of lakePolys) {
        if (pointInPolygon(lon, lat, poly)) {
          isWater = true;
          break;
        }
      }
      /* Real Toronto Islands: OSM stores them as lake holes (land). Tag island=true only there. */
      let isIsland = false;
      for (const poly of islandPolys) {
        if (pointInPolygon(lon, lat, poly)) {
          isIsland = true;
          break;
        }
      }
      const i = x * ROWS + y;
      if (isIsland) {
        cells[i] = 3;
        islandN++;
      } else if (isWater) {
        cells[i] = 1;
        waterN++;
      } else {
        /* ravine on land */
        let rav = false;
        for (const poly of ravinePolys) {
          if (pointInPolygon(lon, lat, poly)) {
            rav = true;
            break;
          }
        }
        if (!rav && nearRiver(lon, lat, riverSegs, riverThresh)) rav = true;
        if (rav) {
          cells[i] = 2;
          ravN++;
        } else cells[i] = 0;
      }
    }
  }

  /* Flood-fill land from the north edge — any unreachable "land" is open lake
     outside the OSM polygon coverage (SE bbox corner, etc.). Never invent islands. */
  const seen = new Uint8Array(COLS * ROWS);
  const q = [];
  for (let x = 0; x < COLS; x++) {
    const i = x * ROWS + 0;
    if (cells[i] !== 1) {
      seen[i] = 1;
      q.push(i);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = Math.floor(i / ROWS);
    const y = i % ROWS;
    const nbs = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of nbs) {
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const ni = nx * ROWS + ny;
      if (seen[ni]) continue;
      if (cells[ni] === 1) continue; /* water blocks */
      seen[ni] = 1;
      q.push(ni);
    }
  }
  let fixed = 0;
  waterN = 0;
  islandN = 0;
  ravN = 0;
  let landN = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 1 && cells[i] !== 3 && !seen[i]) {
      cells[i] = 1; /* open lake gap → water */
      fixed++;
    }
    if (cells[i] === 0) landN++;
    else if (cells[i] === 1) waterN++;
    else if (cells[i] === 2) ravN++;
    else if (cells[i] === 3) islandN++;
  }
  console.log(`open-lake gap fill: ${fixed} cells`);
  const b64 = Buffer.from(cells).toString('base64');
  const labels = CITIES.map((c) => {
    const x = Math.floor(lonToX(c.lon));
    const y = Math.floor(latToY(c.lat));
    return {
      name: c.name,
      x: Math.max(0, Math.min(COLS - 1, x)),
      y: Math.max(0, Math.min(ROWS - 1, y)),
      lon: c.lon,
      lat: c.lat,
    };
  });

  const out = {
    source: {
      toronto: [
        'https://open.toronto.ca/dataset/toronto-centreline-tcl/ (Shoreline + River via City GIS FeatureServer)',
        'https://open.toronto.ca/dataset/ravine-natural-feature-protection-area/',
        'GIS: cot_geospatial/FeatureServer/14 Shoreline, /18 River, cot_geospatial13/FeatureServer/70 Ravine',
      ],
      osm: 'OpenStreetMap Lake Ontario relation via Overpass (ODbL)',
      licence: 'Open Government Licence – Toronto; ODbL for OSM',
    },
    bbox: BBOX,
    cols: COLS,
    rows: ROWS,
    widthM: Math.round(widthM),
    heightM: Math.round(heightM),
    cellM: Math.round(widthM / COLS),
    stats: {
      land: landN,
      water: waterN,
      ravine: ravN,
      island: islandN,
    },
    labels,
    maskB64: b64,
  };

  fs.writeFileSync(path.join(DATA, 'gta-mask.json'), JSON.stringify(out));
  /* Also emit a JS snippet the game can drop in */
  const js = `/* Auto-baked true-scale GTA mask — do not edit by hand */
window.GTA_GEO=${JSON.stringify(out)};
`;
  fs.writeFileSync(path.join(ROOT, 'gta-geo.js'), js);
  console.log('stats', out.stats);
  console.log('wrote data/gta-mask.json and gta-geo.js');
  console.log('island cells', islandN, '(fake islands removed — only real Toronto Islands)');
}

main();
