/**
 * Bake a land-first Hamilton→Oshawa GTA mask at SimCity lot scale.
 * Sources:
 *  - Open Data Toronto / City GIS: Shoreline, River, Ravine (OGL–Toronto)
 *  - OpenStreetMap: Lake Ontario + Highway 401 (ODbL)
 *  - Natural Earth 10m lakes fallback
 *
 * Framing: thin southern water band, expanded north (York Region), true aspect.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

/* Land-first bbox: Hamilton harbour lip → York Region; deep lake cropped to band */
const BBOX = {
  west: -79.95,
  east: -78.80,
  south: 43.26,
  north: 44.10,
};

/* ~96 m lots — SimCity parcels (was ~966 m); house ≈ one lot, not a district */
const TARGET_CELL_M = 96;
const RASTER_CELL_M = 288;
/* Keep only this much open lake south of local shoreline */
const WATER_BAND_M = 2400;

const midLat = (BBOX.south + BBOX.north) / 2;
const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
const mPerDegLat = 110540;
const widthM = (BBOX.east - BBOX.west) * mPerDegLon;
const heightM = (BBOX.north - BBOX.south) * mPerDegLat;

const COLS = Math.max(64, Math.round(widthM / TARGET_CELL_M));
const ROWS = Math.max(48, Math.round((COLS * heightM) / widthM));
const cellM = widthM / COLS;
const waterBandCells = Math.max(2, Math.round(WATER_BAND_M / cellM));
const R_COLS = Math.max(32, Math.round(widthM / RASTER_CELL_M));
const R_ROWS = Math.max(24, Math.round((R_COLS * heightM) / widthM));
const upsample = Math.max(1, Math.round(COLS / R_COLS));

console.log('bbox', BBOX);
console.log(`widthM=${widthM.toFixed(0)} heightM=${heightM.toFixed(0)} aspect=${(widthM / heightM).toFixed(3)}`);
console.log(`grid ${COLS}x${ROWS} cell≈${cellM.toFixed(1)}m (raster ${R_COLS}x${R_ROWS}, ×${upsample}) waterBand=${waterBandCells}`);

function lonToX(lon) {
  return ((lon - BBOX.west) / (BBOX.east - BBOX.west)) * COLS;
}
function latToY(lat) {
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

function ringBBox(ring) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = ring[i][0], y = ring[i][1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

function pointInPolygon(lon, lat, rings, bb) {
  if (!rings || !rings.length) return false;
  if (bb && (lon < bb.minX || lon > bb.maxX || lat < bb.minY || lat > bb.maxY)) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lon, lat, rings[h])) return false;
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

function readJson(file) {
  let txt = fs.readFileSync(file, 'utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  return JSON.parse(txt);
}

function httpsGet(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: body ? 'POST' : 'GET',
        headers: body
          ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          else resolve(buf.toString('utf8'));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function stitchRings(segments) {
  if (!segments.length) return [];
  const unused = segments.map((s) => s.slice());
  const rings = [];
  while (unused.length) {
    let ring = unused.pop();
    let guard = 0;
    let extended = true;
    while (extended && guard++ < 8000) {
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

function ringIntersectsRing(a, b) {
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
  const rings = stitchRings(outers);
  const holeRings = stitchRings(inners);
  console.log(`OSM Lake Ontario: ${rings.length} outer rings, ${holeRings.length} holes`);
  const polys = [];
  for (const outer of rings) {
    polys.push([outer, ...holeRings.filter((h) => ringIntersectsRing(h, outer))]);
  }
  return polys.length ? polys : buildNeLakeOntario();
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

function loadRiverSegments() {
  const raw = readJson(path.join(DATA, 'toronto-rivers.geojson'));
  const segs = [];
  const KEEP = /don|humber|rouge|credit|duffin|highland|mimico|etobicoke creek|taylor|creek|river/i;
  for (const f of raw.features) {
    const name = (f.properties && f.properties.LINEAR_NAME_FULL) || '';
    if (name && !KEEP.test(name) && name.length > 2) {
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

/* Municipalities / towns — real WGS84 anchors */
const CITIES = [
  { name: 'Hamilton', lon: -79.87, lat: 43.255 },
  { name: 'Stoney Creek', lon: -79.72, lat: 43.22 },
  { name: 'Burlington', lon: -79.80, lat: 43.325 },
  { name: 'Oakville', lon: -79.69, lat: 43.45 },
  { name: 'Milton', lon: -79.88, lat: 43.51 },
  { name: 'Mississauga', lon: -79.64, lat: 43.59 },
  { name: 'Brampton', lon: -79.76, lat: 43.68 },
  { name: 'Etobicoke', lon: -79.54, lat: 43.62 },
  { name: 'Downtown Toronto', lon: -79.38, lat: 43.65 },
  { name: 'Toronto Islands', lon: -79.38, lat: 43.62 },
  { name: 'North York', lon: -79.41, lat: 43.76 },
  { name: 'Scarborough', lon: -79.23, lat: 43.73 },
  { name: 'York', lon: -79.48, lat: 43.69 },
  { name: 'East York', lon: -79.33, lat: 43.69 },
  { name: 'Vaughan', lon: -79.51, lat: 43.84 },
  { name: 'Richmond Hill', lon: -79.44, lat: 43.88 },
  { name: 'Markham', lon: -79.34, lat: 43.86 },
  { name: 'Aurora', lon: -79.45, lat: 44.00 },
  { name: 'Newmarket', lon: -79.46, lat: 44.05 },
  { name: 'Pickering', lon: -79.09, lat: 43.84 },
  { name: 'Ajax', lon: -79.02, lat: 43.85 },
  { name: 'Whitby', lon: -78.94, lat: 43.87 },
  { name: 'Oshawa', lon: -78.86, lat: 43.89 },
  { name: 'Clarington', lon: -78.70, lat: 43.90 },
  { name: 'Lake Ontario', lon: -79.25, lat: 43.58 },
  { name: 'Highway 401', lon: -79.40, lat: 43.75 },
];

function paintPolyline(cells, coords, rows, cols, setFn) {
  if (!coords || coords.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = coords[i - 1];
    const [lon1, lat1] = coords[i];
    const x0 = lonToX(lon0), y0 = latToY(lat0);
    const x1 = lonToX(lon1), y1 = latToY(lat1);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.floor(x0 + (x1 - x0) * t);
      const y = Math.floor(y0 + (y1 - y0) * t);
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      if (setFn(cells, x, y, rows)) n++;
    }
  }
  return n;
}

async function fetchHighway401() {
  const cachePath = path.join(DATA, 'osm-401.json');
  if (fs.existsSync(cachePath)) {
    try {
      const cached = readJson(cachePath);
      if (cached && cached.elements && cached.elements.length) {
        console.log(`401 cache hit: ${cached.elements.length} elements`);
        return cached;
      }
    } catch (_) {}
  }
  const query = `
[out:json][timeout:120];
(
  way["highway"="motorway"]["ref"~"^(401)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["highway"="motorway"]["name"~"Highway 401|Hwy 401"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out geom;
`;
  console.log('Fetching Highway 401 from Overpass…');
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const txt = await httpsGet('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`);
    const json = JSON.parse(txt);
    fs.writeFileSync(cachePath, JSON.stringify(json));
    console.log(`401 fetched: ${(json.elements || []).length} ways`);
    return json;
  } catch (err) {
    console.warn('401 Overpass failed:', err.message);
    return null;
  }
}

function extract401Coords(osm) {
  const lines = [];
  if (!osm || !osm.elements) return lines;
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const ref = (el.tags && el.tags.ref) || '';
    const name = (el.tags && el.tags.name) || '';
    if (!/\b401\b/.test(ref) && !/401/.test(name)) continue;
    lines.push(el.geometry.map((g) => [g.lon, g.lat]));
  }
  return lines;
}

function fallback401Corridor() {
  /* Approximate 401 spine west→east at real latitudes */
  return [[
    [-79.95, 43.62],
    [-79.80, 43.655],
    [-79.70, 43.68],
    [-79.55, 43.72],
    [-79.45, 43.745],
    [-79.35, 43.76],
    [-79.25, 43.775],
    [-79.15, 43.79],
    [-79.05, 43.82],
    [-78.95, 43.855],
    [-78.85, 43.88],
    [-78.80, 43.89],
  ]];
}

function inLake(lon, lat, lakePolys, lakeBBs) {
  for (let i = 0; i < lakePolys.length; i++) {
    if (pointInPolygon(lon, lat, lakePolys[i], lakeBBs[i])) return true;
  }
  return false;
}

async function main() {
  const lakePolys = buildOsmLakeOntario();
  const lakeBBs = lakePolys.map((p) => ringBBox(p[0]));
  const islandPolys = loadTorontoIslands();
  const islandBBs = islandPolys.map((p) => ringBBox(p[0]));
  const riverSegs = loadRiverSegments();
  /* Thin river strokes only — do NOT paint full RNFP polygons as unbuildable */
  const riverThresh = Math.max(0.00012, (cellM * 0.45) / mPerDegLon);

  const coarse = new Uint8Array(R_COLS * R_ROWS);
  console.log('Rasterizing coarse terrain…');
  const t0 = Date.now();
  for (let y = 0; y < R_ROWS; y++) {
    if (y % 40 === 0) console.log(`  row ${y}/${R_ROWS}`);
    for (let x = 0; x < R_COLS; x++) {
      const lon = BBOX.west + ((x + 0.5) / R_COLS) * (BBOX.east - BBOX.west);
      const lat = BBOX.north - ((y + 0.5) / R_ROWS) * (BBOX.north - BBOX.south);
      let isIsland = false;
      for (let pi = 0; pi < islandPolys.length; pi++) {
        if (pointInPolygon(lon, lat, islandPolys[pi], islandBBs[pi])) {
          isIsland = true;
          break;
        }
      }
      const i = x * R_ROWS + y;
      if (isIsland) coarse[i] = 3;
      else if (inLake(lon, lat, lakePolys, lakeBBs)) coarse[i] = 1;
      else if (nearRiver(lon, lat, riverSegs, riverThresh)) coarse[i] = 2;
      else coarse[i] = 0;
    }
  }
  console.log(`coarse raster ${(Date.now() - t0) / 1000}s`);

  /* Upsample nearest-neighbour to lot grid */
  const cells = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) {
    const ry = Math.min(R_ROWS - 1, Math.floor((y / ROWS) * R_ROWS));
    for (let x = 0; x < COLS; x++) {
      const rx = Math.min(R_COLS - 1, Math.floor((x / COLS) * R_COLS));
      cells[x * ROWS + y] = coarse[rx * R_ROWS + ry];
    }
  }
  /* Re-stamp real Toronto Islands at fine resolution */
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const [lon, lat] = cellCenter(x, y);
      if (lon < -79.42 || lon > -79.34 || lat < 43.61 || lat > 43.64) continue;
      for (let pi = 0; pi < islandPolys.length; pi++) {
        if (pointInPolygon(lon, lat, islandPolys[pi], islandBBs[pi])) {
          cells[x * ROWS + y] = 3;
          break;
        }
      }
    }
  }
  let waterN = 0, islandN = 0, ravN = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === 1) waterN++;
    else if (c === 2) ravN++;
    else if (c === 3) islandN++;
  }

  /* Flood-fill from north: unreachable non-island → open lake gaps */
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
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const ni = nx * ROWS + ny;
      if (seen[ni] || cells[ni] === 1) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  let fixed = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 1 && cells[i] !== 3 && !seen[i]) {
      cells[i] = 1;
      fixed++;
    }
  }
  console.log(`open-lake gap fill: ${fixed}`);

  /* Coastal band: deep lake beyond WATER_BAND_M from land → void (4), then crop */
  const landDist = new Int16Array(COLS * ROWS);
  landDist.fill(32767);
  const lq = [];
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      const i = x * ROWS + y;
      const c = cells[i];
      if (c === 0 || c === 2 || c === 3) {
        landDist[i] = 0;
        lq.push(i);
      }
    }
  }
  for (let qi = 0; qi < lq.length; qi++) {
    const i = lq[qi];
    const x = Math.floor(i / ROWS);
    const y = i % ROWS;
    const d = landDist[i];
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const ni = nx * ROWS + ny;
      if (landDist[ni] <= d + 1) continue;
      landDist[ni] = d + 1;
      lq.push(ni);
    }
  }
  let voided = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 1 && landDist[i] > waterBandCells) {
      cells[i] = 4; /* void — deep lake cropped */
      voided++;
    }
  }
  console.log(`deep-lake voided: ${voided} (band ${waterBandCells} cells)`);

  /* Crop southern rows that are entirely deep-void — keep coastal water band only */
  let maxY = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = cells[x * ROWS + y];
      if (c === 4) continue; /* deep lake does not extend the playable frame */
      if (y > maxY) maxY = y;
    }
  }
  const cropRows = Math.min(ROWS, maxY + 1);
  const cropped = new Uint8Array(COLS * cropRows);
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < cropRows; y++) {
      /* Keep code 4 as off-map void — never revive as water (that drowned the SE map) */
      cropped[x * cropRows + y] = cells[x * ROWS + y];
    }
  }
  const FINAL_ROWS = cropRows;
  const southEffective = BBOX.north - (FINAL_ROWS / ROWS) * (BBOX.north - BBOX.south);
  console.log(`cropped rows ${ROWS} → ${FINAL_ROWS}; southEffective=${southEffective.toFixed(3)}`);

  function latToYFinal(lat) {
    return ((BBOX.north - lat) / (BBOX.north - southEffective)) * FINAL_ROWS;
  }
  function lonToXFinal(lon) {
    return ((lon - BBOX.west) / (BBOX.east - BBOX.west)) * COLS;
  }

  /* Recount */
  waterN = 0;
  islandN = 0;
  ravN = 0;
  let landN = 0;
  let voidN = 0;
  for (let i = 0; i < cropped.length; i++) {
    const c = cropped[i];
    if (c === 0) landN++;
    else if (c === 1) waterN++;
    else if (c === 2) ravN++;
    else if (c === 3) islandN++;
    else voidN++;
  }

  /* Highway 401 spine */
  const osm401 = await fetchHighway401();
  let lines401 = extract401Coords(osm401);
  if (!lines401.length) {
    console.warn('Using fallback 401 corridor polyline');
    lines401 = fallback401Corridor();
  }
  const hwySet = new Set();
  const setHwy = (arr, x, y, rows) => {
    const i = x * rows + y;
    if (arr[i] === 3) return false;
    hwySet.add(i);
    return true;
  };
  let hwyPaint = 0;
  /* Remap paint to use effective south for 401 geom already in lon/lat */
  const paint401 = (coords) => {
    if (!coords || coords.length < 2) return 0;
    let n = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lon0, lat0] = coords[i - 1];
      const [lon1, lat1] = coords[i];
      const x0 = lonToXFinal(lon0), y0 = latToYFinal(lat0);
      const x1 = lonToXFinal(lon1), y1 = latToYFinal(lat1);
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = Math.floor(x0 + (x1 - x0) * t);
        const y = Math.floor(y0 + (y1 - y0) * t);
        if (x < 0 || y < 0 || x >= COLS || y >= FINAL_ROWS) continue;
        if (setHwy(cropped, x, y, FINAL_ROWS)) n++;
      }
    }
    return n;
  };
  for (const line of lines401) hwyPaint += paint401(line);
  /* Widen 401 to 2-cell highway spine for visibility at lot scale */
  const hwyExtra = [];
  for (const i of hwySet) {
    const x = Math.floor(i / FINAL_ROWS);
    const y = i % FINAL_ROWS;
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= FINAL_ROWS) continue;
      const ni = nx * FINAL_ROWS + ny;
      if (cropped[ni] === 3) continue;
      hwyExtra.push(ni);
    }
  }
  for (const ni of hwyExtra) hwySet.add(ni);
  const hwy401 = [...hwySet].sort((a, b) => a - b);
  console.log(`401 cells: ${hwy401.length} (painted segs ${hwyPaint})`);

  const labels = CITIES.map((c) => {
    const x = Math.floor(lonToXFinal(c.lon));
    const y = Math.floor(latToYFinal(c.lat));
    return {
      name: c.name,
      x: Math.max(0, Math.min(COLS - 1, x)),
      y: Math.max(0, Math.min(FINAL_ROWS - 1, y)),
      lon: c.lon,
      lat: c.lat,
    };
  }).filter((l) => l.lat >= southEffective - 0.08 && l.lat <= BBOX.north + 0.02);

  const outBbox = { west: BBOX.west, east: BBOX.east, south: southEffective, north: BBOX.north };

  const landRatio = landN / Math.max(1, landN + waterN + ravN + islandN);
  const out = {
    source: {
      toronto: [
        'https://open.toronto.ca/dataset/toronto-centreline-tcl/',
        'https://open.toronto.ca/dataset/ravine-natural-feature-protection-area/',
        'GIS shoreline/rivers used for coast + thin ravine strokes (RNFP not used as unbuildable flood)',
      ],
      osm: 'OpenStreetMap Lake Ontario + Highway 401 motorway (ODbL)',
      licence: 'Open Government Licence – Toronto; ODbL for OSM',
    },
    bbox: outBbox,
    cols: COLS,
    rows: FINAL_ROWS,
    widthM: Math.round(widthM),
    heightM: Math.round((FINAL_ROWS / ROWS) * heightM),
    cellM: Math.round(cellM),
    waterBandM: WATER_BAND_M,
    stats: {
      land: landN,
      water: waterN,
      ravine: ravN,
      island: islandN,
      void: voidN,
      landRatio: Math.round(landRatio * 1000) / 1000,
      hwy401: hwy401.length,
    },
    labels,
    hwy401,
    maskB64: Buffer.from(cropped).toString('base64'),
  };

  fs.writeFileSync(path.join(DATA, 'gta-mask.json'), JSON.stringify(out));
  /* Write mask separately if huge — keep gta-geo.js loadable */
  const js = `/* Auto-baked land-first GTA mask — do not edit by hand */
window.GTA_GEO=${JSON.stringify(out)};
`;
  fs.writeFileSync(path.join(ROOT, 'gta-geo.js'), js);
  console.log('stats', out.stats);
  console.log(`land ${(landRatio * 100).toFixed(1)}% water ${((waterN / Math.max(1, landN + waterN + ravN + islandN)) * 100).toFixed(1)}% void ${voidN}`);
  console.log('wrote data/gta-mask.json and gta-geo.js');
  console.log('municipalities', labels.map((l) => l.name).join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
