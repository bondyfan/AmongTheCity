// ---- Chunk mesh factory: the city's look, one merged mesh at a time ----
// buildChunkMeshes() turns one 120 m cell of the Pardubice data into as few
// Meshes as possible: ONE vertex-colored "flat" mesh (ground, water surface +
// bank skirts, road ribbons + bridge fascia/railings, rails, lane dashes),
// ONE building mesh and two InstancedMeshes for the trees. Most features live
// in every cell their bbox touches but render only in their _home chunk; the
// two exceptions are WATER and WATERWAYS, which are clipped to the cell rect
// instead — the river is kilometers long, and home-chunk rendering would pop
// the whole Labe in and out with one distant cell. Everything is emitted in
// world coordinates (the city sits ≤ ~2 km from origin, float32 is plenty),
// so the returned Group stays at the origin.
//
// v2 realism pass: water surfaces sink to WATER_Y with earthy bank walls cut
// through the ground plane (the ground is a rect-with-holes wherever water
// crosses it — an opaque quad at y=0 would simply hide a sunken river);
// bridges run flat at BRIDGE_Y behind geo.bridgeElevation and grow parapets;
// mats.ortho swaps the ground quad for a ČÚZK aerial photo; mats.facades
// swaps flat building walls for a shared procedural window atlas.
//
// v4: woods are no longer green paint — every wood/forest polygon (and every
// park big enough to have a canopy) scatters real trees into the chunk's tree
// InstancedMeshes, and its fill darkens to a forest floor so the gaps between
// the trunks read as shade instead of meadow.
//
// Color discipline: renderer output is sRGB with three's color management on,
// so every palette hex goes through Color.setHex() (sRGB → linear working
// space) BEFORE it lands in a vertex-color attribute.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { CHUNK, LAYER_Y, COLORS, BUILDING_PALETTES, ROOF_DARKEN, WALL_AO,
  WATER_Y, BANK_DEPTH } from './config.js';
import { bridgeElevation, polygonArea, pointInPolygon, chunkKey } from './geo.js';
import { entranceOf, brandOf } from './interiors.js';
import { INTERIOR } from './config.js';

// geometry dimensions (meters) — construction sizes, not art direction
const CAP_SEGS = 8;                                  // endpoint disc fan
const DASH_LEN = 1.8, DASH_GAP = 2.6, DASH_HW = 0.09; // lane center dashes
const GAUGE_H = 1.435 / 2;                           // standard gauge, rail centerlines
const RAIL_HW = 0.09;                                // steel ribbon half-width
const SLEEPER_STEP = 0.8, SLEEPER_HL = 1.25, SLEEPER_HW = 0.12;
const FASCIA = 0.55;                                 // girder face below a bridge deck edge
const RAILING_H = 0.9, RAILING_COL = 0x2b2d31;       // bridge parapet strips
const BANK_TOP = 0.05, BANK_COL = 0x6b5f4c;          // river bank walls: curb lip → just under water
const SKIRT_MAX = 30;                                // bank wall piece length — keeps chunk ownership local
const DASH_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const FOOT_CLASSES = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track']);

// facade rhythm: one window bay per 2.7 m of wall, one atlas row per storey.
// The 2048×1024 atlas is an 8×4 grid of 256×256 cells; each cell holds a BAND
// of 4 window bays, because an atlas cell cannot wrap-repeat — walls subdivide
// into ≤4-bay pieces instead, each sampling a sub-range of one cell.
const WIN_W = 2.7, STOREY_H = 3.1, BAYS = 4;
// Where the window sits inside one atlas cell, as a fraction of the cell's
// height, and how much of a bay's width it takes. SHARED with pieces.js (via
// facadeCells) so the box shell can cut its opening in the same place the paint
// draws one — see the note in facadeAtlas().
const WIN_BAND = [0.29, 0.74], WIN_FRAC = 0.54;
const ATLAS_W = 2048, ATLAS_H = 1024;                // v3 doubled u-resolution: sills/mullions survive
const ATLAS_N = 8, ATLAS_M = 4;
const cellRect = (ci, ri) => [ci / ATLAS_N, 1 - (ri + 1) / ATLAS_M, (ci + 1) / ATLAS_N, 1 - ri / ATLAS_M];
const PIN_U = 0.5 / ATLAS_N, PIN_V = 1 - 0.5 / ATLAS_M; // plain-plaster cell centre — roofs pin here
const STORE_CELL = cellRect(1, 0), PANEL_CELL = cellRect(2, 0);
const GENERIC = [];                                  // every cell except the three reserved ones
for (let ri = 0; ri < ATLAS_M; ri++) for (let ci = 0; ci < ATLAS_N; ci++)
  if (!(ri === 0 && ci < 3)) GENERIC.push(cellRect(ci, ri));
const STORE_TYPES = new Set(['retail', 'commercial', 'supermarket', 'kiosk', 'hotel']);
// Four GENERIC cells the painter dresses in brick courses. They stay generic
// (any building may roll one — brick apartments exist), but industrial types
// are STEERED onto them so factory halls stop wearing plaster windows.
const BRICK_CELLS = [[7, 2], [5, 3], [6, 3], [7, 3]];
const BRICK_UV = BRICK_CELLS.map(([ci, ri]) => cellRect(ci, ri));
const BRICK_TYPES = new Set(['industrial', 'warehouse']);

// module-level scratch — build-time only, but the loops shouldn't churn
const _c = new THREE.Color();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _WA = { x: 0, z: 0, dx: 0, dz: 0 }, _WB = { x: 0, z: 0, dx: 0, dz: 0 };

// deterministic per-feature jitter — the same building keeps the same tint
// across chunk rebuilds and across machines (no Math.random in geometry)
function rnd(id, salt) {
  let t = (id * 374761393 + salt * 668265263) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}
function hashStr(s) {
  let h = 9;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 387420489);
  return h >>> 0;
}

export function makeMaterials() {
  // callers may attach mats.ortho (manager from ortho.js) and mats.facades
  // (bool) after the fact — buildChunkMeshes reads both, and lazily caches a
  // textured wall material as mats._facadeMat so the atlas is built once
  return {
    flat: new THREE.MeshLambertMaterial({ vertexColors: true }),
    building: new THREE.MeshLambertMaterial({ vertexColors: true }),
    trunk: new THREE.MeshLambertMaterial({ color: COLORS.treeTrunk }),
    // far tier fallback when a chunk has no aerial tile yet: plain terrain
    // colour, no vertex colours (the far quad carries none)
    flatFar: new THREE.MeshLambertMaterial({ color: 0x8a9182 }),
    lampPost: new THREE.MeshLambertMaterial({ color: 0x4a4d52 }),
    // emissiveIntensity is driven from main at dusk (0 by day, ~2.6 at night)
    lampHead: new THREE.MeshLambertMaterial({ color: 0x2e3033, emissive: 0xffdc96, emissiveIntensity: 0, toneMapped: false }),
    crown: new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    // door dressing: matte surround/canopy, and a sign board that is always a
    // touch overbright so the bloom pass finds every entrance in the city
    doorTrim: new THREE.MeshLambertMaterial({ vertexColors: true }),
    // Illuminated signage: FULL BRIGHT, never shaded, never tone-mapped — which
    // is exactly how a backlit retail fascia behaves, and lets the vertex colour
    // carry each chain's own red/blue/yellow straight past the lighting.
    doorSign: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  };
}

// ---- triangle sink: hand-built geometry with winding-derived normals ----
// Optional uv mode (facade walls): plain tris pin to the neutral plaster cell
// so ridge prisms and roof caps sample "nothing", wallUV maps real sub-rects.
class TriSink {
  constructor(uv = false) { this.pos = []; this.nrm = []; this.col = []; this.uv = uv ? [] : null; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(r, g, b, r, g, b, r, g, b);
    if (this.uv) this.uv.push(PIN_U, PIN_V, PIN_U, PIN_V, PIN_U, PIN_V);
  }
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, r, g, b);
  }
  // tri that must face a rough outside direction g* (roof prisms come from an
  // OBB whose axis sign is arbitrary — flip winding when the normal disagrees)
  triFacing(ax, ay, az, bx, by, bz, cx, cy, cz, gx, gy, gz, r, g, b) {
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nx * gx + ny * gy + nz * gz < 0) this.tri(ax, ay, az, cx, cy, cz, bx, by, bz, r, g, b);
    else this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
  }
  // textured vertical wall a→b: winding chosen so the derived normal points
  // toward (fx,fz); per-corner colors let the fake-AO gradient ride the storey
  // grid; uvs map one atlas sub-rect (u along the run, v bottom→top).
  // Derivation: quad(aT,bT,bB,aB) has normal ∝ (dz, −dx) of the a→b direction.
  wallUV(ax, az, bx, bz, yB, yT, fx, fz, u0, v0, u1, v1, rB, gB, bB, rT, gT, bT) {
    const dx = bx - ax, dz = bz - az;
    let Ax = ax, Az = az, Bx = bx, Bz = bz, ua = u0, ub = u1, nx = dz, nz = -dx;
    if (nx * fx + nz * fz < 0) { Ax = bx; Az = bz; Bx = ax; Bz = az; ua = u1; ub = u0; nx = -nx; nz = -nz; }
    const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
    this.pos.push(Ax, yT, Az, Bx, yT, Bz, Bx, yB, Bz, Ax, yT, Az, Bx, yB, Bz, Ax, yB, Az);
    for (let k = 0; k < 6; k++) this.nrm.push(nx, 0, nz);
    this.col.push(rT, gT, bT, rT, gT, bT, rB, gB, bB, rT, gT, bT, rB, gB, bB, rB, gB, bB);
    this.uv.push(ua, v1, ub, v1, ub, v0, ua, v1, ub, v0, ua, v0);
  }
  geo() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    return g;
  }
}

// ---- shared small helpers ----

// uniform-color a stock geometry and strip what mergeGeometries would trip on
function colorize(gIn, hex) {
  const g = gIn.index ? gIn.toNonIndexed() : gIn;
  g.deleteAttribute('uv');
  _c.setHex(hex);
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// (x,z) rings → THREE.Shape in the XY plane with y = −z, so that after
// rotateX(−π/2) shape-space lands on world (x, z) facing UP with the winding
// intact — the one mapping needing no post-fixes
function ringShape(outer, holes) {
  const s = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes ?? []) if (h.length >= 3)
    s.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
}

// flat colored polygon at height y, or null when triangulation degenerates
function shapePoly(ring, holes, y, hex) {
  if (!ring || ring.length < 3) return null;
  const g = new THREE.ShapeGeometry(ringShape(ring, holes)).rotateX(-Math.PI / 2);
  if (!g.attributes.position.count) return null;
  if (y) g.translate(0, y, 0);
  return colorize(g, hex);
}

// Polyline frame for ribbon extrusion: deduped points, cumulative distance,
// per-point miter perpendicular pre-scaled by 1/cos(halfTurn) (clamped so
// hairpins don't shoot kilometer spikes) — parallel edges through bends.
function ribbonFrame(pts) {
  const q = [];
  for (const pt of pts) {
    const l = q[q.length - 1];
    if (!l || Math.hypot(pt[0] - l[0], pt[1] - l[1]) > 0.01) q.push(pt);
  }
  const n = q.length;
  if (n < 2) return null;
  const along = [0], per = [];
  for (let i = 1; i < n; i++)
    along.push(along[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
  for (let i = 0; i < n; i++) {
    const a = q[Math.max(0, i - 1)], b = q[i], c = q[Math.min(n - 1, i + 1)];
    let p1x = b[0] - a[0], p1z = b[1] - a[1];
    let p2x = c[0] - b[0], p2z = c[1] - b[1];
    if (i === 0) { p1x = p2x; p1z = p2z; }
    if (i === n - 1) { p2x = p1x; p2z = p1z; }
    const l1 = Math.hypot(p1x, p1z) || 1, l2 = Math.hypot(p2x, p2z) || 1;
    p1x /= l1; p1z /= l1; p2x /= l2; p2z /= l2;
    let mx = p1x + p2x, mz = p1z + p2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = p2x; mz = p2z; } else { mx /= ml; mz /= ml; } // 180° U-turn fallback
    const s = 1 / Math.max(0.35, mx * p2x + mz * p2z);
    per.push([mz * s, -mx * s]); // (dz,−dx): the perp whose +side quads wind CCW from above
  }
  return { q, along, per, len: along[n - 1] };
}

// point + direction at distance d along a frame (build-time linear scan)
function walkAt(fr, d, out) {
  const { q, along } = fr;
  let i = 0;
  while (i < q.length - 2 && along[i + 1] < d) i++;
  const t = Math.min(1, Math.max(0, (d - along[i]) / ((along[i + 1] - along[i]) || 1)));
  out.x = q[i][0] + (q[i + 1][0] - q[i][0]) * t;
  out.z = q[i][1] + (q[i + 1][1] - q[i][1]) * t;
  const dx = q[i + 1][0] - q[i][0], dz = q[i + 1][1] - q[i][1];
  const l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l; out.dz = dz / l;
}

// flat disc fan — road endpoints read round instead of chopped
function capDisc(sink, x, y, z, r, cr, cg, cb) {
  for (let k = 0; k < CAP_SEGS; k++) {
    const a0 = (k / CAP_SEGS) * Math.PI * 2, a1 = ((k + 1) / CAP_SEGS) * Math.PI * 2;
    sink.tri(x, y, z,
      x + Math.cos(a1) * r, y, z + Math.sin(a1) * r,
      x + Math.cos(a0) * r, y, z + Math.sin(a0) * r, cr, cg, cb);
  }
}

// vertical wall a→b whose face points toward (fx,fz) — quad(aT,bT,bB,aB)
// faces (dz,−dx) of the run, so flip the run when that disagrees
function wallQuad(sink, ax, az, bx, bz, yT, yB, fx, fz, r, g, b) {
  const dx = bx - ax, dz = bz - az;
  if (dz * fx - dx * fz >= 0) sink.quad(ax, yT, az, bx, yT, bz, bx, yB, bz, ax, yB, az, r, g, b);
  else sink.quad(bx, yT, bz, ax, yT, az, ax, yB, az, bx, yB, bz, r, g, b);
}

// Sutherland–Hodgman ring ∩ axis-aligned rect. Earcut (behind ShapeGeometry /
// triangulateShape) is robust to the touching-hole degeneracies this can emit
// where adjacent riverbank polygons share an edge, so results feed it as-is.
function clipRingToRect(ring, x0, z0, x1, z1) {
  let out = ring;
  for (const [axis, lim, sgn] of [[0, x0, 1], [0, x1, -1], [1, z0, 1], [1, z1, -1]]) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      const da = (a[axis] - lim) * sgn, db = (b[axis] - lim) * sgn; // ≥0 = inside this half-plane
      if (da >= 0) out.push(a);
      if ((da < 0) !== (db < 0)) {
        const t = da / (da - db);
        out.push(axis === 0 ? [lim, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, lim]);
      }
    }
    if (out.length < 3) return null;
  }
  return out;
}

// Liang–Barsky segment ∩ rect → param window {t0,t1} or null
function clipSeg(ax, az, bx, bz, x0, z0, x1, z1) {
  const P = [ax - bx, bx - ax, az - bz, bz - az], Q = [ax - x0, x1 - ax, az - z0, z1 - az];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) { if (Q[i] < 0) return null; }
    else {
      const r = Q[i] / P[i];
      if (P[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return { t0, t1 };
}

// ---- water: sunken surface + earthy bank walls cut through the ground ----

// Vertical bank wall along a water outline ring, from the 5 cm curb lip down
// to just under the water. Emitted piece by piece into whichever chunk owns
// the piece midpoint — global dedupe with no second index. `inward` walls the
// ring interior (river outer ring); false faces away (island: into the water).
// Interior of a positive-area ring lies on (−dz,dx) — see wallQuad's note.
function skirtRing(sink, ring, key, inward, r, g, b) {
  const sgn = (polygonArea(ring) > 0 ? 1 : -1) * (inward ? 1 : -1);
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const n = Math.ceil(L / SKIRT_MAX), fx = -sgn * (bz - az), fz = sgn * (bx - ax);
    for (let k = 0; k < n; k++) {
      const p0x = ax + (bx - ax) * k / n, p0z = az + (bz - az) * k / n;
      const p1x = ax + (bx - ax) * (k + 1) / n, p1z = az + (bz - az) * (k + 1) / n;
      if (chunkKey((p0x + p1x) / 2, (p0z + p1z) / 2) !== key) continue;
      wallQuad(sink, p0x, p0z, p1x, p1z, BANK_TOP, BANK_DEPTH, fx, fz, r, g, b);
    }
  }
}

function inWater(x, z, waters) {
  for (const w of waters)
    if (pointInPolygon(x, z, w.o) && !(w.i ?? []).some((h) => pointInPolygon(x, z, h))) return true;
  return false;
}

// waterway polylines aren't in geo's chunk index — bucket them once, lazily,
// by bbox inflated by their half-width, and cache the map on the city object
function wwBuckets(city) {
  let m = city._wwChunks;
  if (m) return m;
  m = city._wwChunks = new Map();
  for (const f of city.waterways ?? []) {
    if (!f.p || f.p.length < 2) continue;
    const r = (f.w ?? 2) / 2 + 1;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const [x, z] of f.p) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    for (let cx = Math.floor((minX - r) / CHUNK); cx <= Math.floor((maxX + r) / CHUNK); cx++)
      for (let cz = Math.floor((minZ - r) / CHUNK); cz <= Math.floor((maxZ + r) / CHUNK); cz++) {
        const key = cx + ',' + cz;
        (m.get(key) ?? m.set(key, []).get(key)).push(f);
      }
  }
  return m;
}

// One continuous in-chunk piece of a waterway trench: hole ring for the
// ground carve, sunken surface, and bank walls facing the centreline. End
// caps only where the stream truly begins/ends — chunk-border cuts stay open
// so the neighbour's piece continues seamlessly.
function emitTrench(sink, flat, holes, run, hw, x0, z0, x1, z1, kr, kg, kb, cap1) {
  const n = run.length, ring = [];
  for (let i = 0; i < n; i++) ring.push([run[i].x + run[i].px * hw, run[i].z + run[i].pz * hw]);
  for (let i = n - 1; i >= 0; i--) ring.push([run[i].x - run[i].px * hw, run[i].z - run[i].pz * hw]);
  // miter offsets can poke past the rect at border cuts; a hole partly outside
  // the ground outline upsets earcut, so clip the ring like the water polys
  const clip = clipRingToRect(ring, x0, z0, x1, z1);
  if (clip && Math.abs(polygonArea(clip)) > 0.5) {
    holes.push(clip);
    const g = shapePoly(clip, null, WATER_Y, COLORS.water);
    if (g) flat.push(g);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = run[i], b = run[i + 1], fx = -(a.px + b.px), fz = -(a.pz + b.pz);
    wallQuad(sink, a.x + a.px * hw, a.z + a.pz * hw, b.x + b.px * hw, b.z + b.pz * hw,
      BANK_TOP, BANK_DEPTH, fx, fz, kr, kg, kb);
    wallQuad(sink, a.x - a.px * hw, a.z - a.pz * hw, b.x - b.px * hw, b.z - b.pz * hw,
      BANK_TOP, BANK_DEPTH, -fx, -fz, kr, kg, kb);
  }
  if (run.cap0) {
    const a = run[0], b = run[1];
    wallQuad(sink, a.x + a.px * hw, a.z + a.pz * hw, a.x - a.px * hw, a.z - a.pz * hw,
      BANK_TOP, BANK_DEPTH, b.x - a.x, b.z - a.z, kr, kg, kb);
  }
  if (cap1) {
    const a = run[n - 1], b = run[n - 2];
    wallQuad(sink, a.x + a.px * hw, a.z + a.pz * hw, a.x - a.px * hw, a.z - a.pz * hw,
      BANK_TOP, BANK_DEPTH, b.x - a.x, b.z - a.z, kr, kg, kb);
  }
}

// Walk one waterway through this chunk: clip every segment to the cell rect
// (NOT home-chunk dedupe — trench pieces must tile exactly across borders),
// drop legs already inside a mapped water polygon (double-carved overlapping
// holes are the one thing earcut genuinely hates, and mid-river trench walls
// would look absurd), and stitch surviving stretches into runs.
function trenchInto(sink, flat, holes, f, cell, x0, z0, x1, z1, kr, kg, kb) {
  const fr = (f._fr ??= ribbonFrame(f.p));
  if (!fr) return;
  const { q, per } = fr;
  const hw = Math.max(0.5, (f.w ?? 2) / 2);
  let run = null;
  const flush = (cap1) => {
    if (run && run.length > 1) emitTrench(sink, flat, holes, run, hw, x0, z0, x1, z1, kr, kg, kb, cap1);
    run = null;
  };
  for (let i = 0; i < q.length - 1; i++) {
    const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
    const c = clipSeg(ax, az, bx, bz, x0, z0, x1, z1);
    if (!c) { flush(false); continue; }
    if (run && c.t0 > 0) flush(false); // the previous segment's end isn't shared — gap
    // cut ends use the plain segment perp — both neighbours derive it from the
    // same segment, so the trench edge matches exactly across the border; miter
    // perps only apply at true polyline joints (ta 0 / tb 1)
    const L = Math.hypot(bx - ax, bz - az) || 1, spx = (bz - az) / L, spz = -(bx - ax) / L;
    // walk the in-rect window in ≤6 m pieces so a stream MOUTH only pokes a
    // couple of meters into the river's own carve hole before the in-water
    // test drops it — overlapping holes confuse earcut, and trench walls
    // across the junction would dam the confluence
    const steps = Math.max(1, Math.ceil(L * (c.t1 - c.t0) / 6));
    for (let k = 0; k < steps; k++) {
      const ta = k === 0 ? c.t0 : c.t0 + (c.t1 - c.t0) * k / steps;
      const tb = k + 1 === steps ? c.t1 : c.t0 + (c.t1 - c.t0) * (k + 1) / steps;
      const sx = ax + (bx - ax) * ta, sz = az + (bz - az) * ta;
      const ex = ax + (bx - ax) * tb, ez = az + (bz - az) * tb;
      if (inWater((sx + ex) / 2, (sz + ez) / 2, cell.water)) { flush(false); continue; }
      if (!run) {
        run = [{ x: sx, z: sz, px: ta === 0 ? per[i][0] : spx, pz: ta === 0 ? per[i][1] : spz }];
        run.cap0 = i === 0 && ta === 0;
      }
      run.push({ x: ex, z: ez, px: tb === 1 ? per[i + 1][0] : spx, pz: tb === 1 ? per[i + 1][1] : spz });
    }
    if (c.t1 < 1) flush(false); // cut at the cell border — neighbour continues it
  }
  flush(true); // a run still open here reached the polyline's true end uncut
}

// ---- roads: mitered ribbon + caps + bridge fascia/parapets + dashes ----
function roadRibbon(sink, f) {
  const fr = ribbonFrame(f.p);
  if (!fr) return;
  const { q, per, along, len } = fr;
  const hw = Math.max(0.8, (f.w ?? 3) / 2);
  const baseY = FOOT_CLASSES.has(f.t) ? LAYER_Y.footway : LAYER_Y.road;
  const elev = (d) => (f.br ? bridgeElevation(d, len) : 0);
  _c.setHex(COLORS.road[f.t] ?? COLORS.road.residential);
  const cr = _c.r, cg = _c.g, cb = _c.b;
  _c.setHex(RAILING_COL);
  const lr = _c.r, lg = _c.g, lb = _c.b;
  for (let i = 0; i < q.length - 1; i++) {
    const y0 = baseY + elev(along[i]), y1 = baseY + elev(along[i + 1]);
    const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
    const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
    sink.quad(
      ax - pax * hw, y0, az - paz * hw, bx - pbx * hw, y1, bz - pbz * hw,
      bx + pbx * hw, y1, bz + pbz * hw, ax + pax * hw, y0, az + paz * hw, cr, cg, cb);
    // Bridge edges: decks run FLAT at BRIDGE_Y now — what sells the bridge is
    // the river sunk below it, so v1's deep girder curtains are gone. A short
    // fascia below the deck edge and a 0.9 m parapet above, both double-sided
    // (seen from the bank AND from the deck), along the entire bridge way.
    if (f.br) {
      const b0 = Math.max(0.02, y0 - FASCIA), b1 = Math.max(0.02, y1 - FASCIA);
      const t0 = y0 + RAILING_H, t1 = y1 + RAILING_H;
      const sr = cr * 0.72, sg = cg * 0.72, sb = cb * 0.72;
      for (const e of [-1, 1]) {
        const X0 = ax + pax * hw * e, Z0 = az + paz * hw * e;
        const X1 = bx + pbx * hw * e, Z1 = bz + pbz * hw * e;
        sink.quad(X0, y0, Z0, X1, y1, Z1, X1, b1, Z1, X0, b0, Z0, sr, sg, sb);
        sink.quad(X0, b0, Z0, X1, b1, Z1, X1, y1, Z1, X0, y0, Z0, sr, sg, sb);
        sink.quad(X0, t0, Z0, X1, t1, Z1, X1, y1, Z1, X0, y0, Z0, lr, lg, lb);
        sink.quad(X0, y0, Z0, X1, y1, Z1, X1, t1, Z1, X0, t0, Z0, lr, lg, lb);
      }
    }
  }
  capDisc(sink, q[0][0], baseY + elev(0), q[0][1], hw, cr, cg, cb);
  capDisc(sink, q[q.length - 1][0], baseY + elev(len), q[q.length - 1][1], hw, cr, cg, cb);
  if (f.d && (f.w ?? 0) >= 6 && DASH_CLASSES.has(f.t)) {
    _c.setHex(COLORS.marking);
    const mr = _c.r, mg = _c.g, mb = _c.b;
    for (let s = 1.2; s + DASH_LEN < len - 1.2; s += DASH_LEN + DASH_GAP) {
      walkAt(fr, s, _WA); walkAt(fr, s + DASH_LEN, _WB);
      const ya = LAYER_Y.marking + elev(s), yb = LAYER_Y.marking + elev(s + DASH_LEN);
      const px = _WA.dz * DASH_HW, pz = -_WA.dx * DASH_HW;
      sink.quad(_WA.x - px, ya, _WA.z - pz, _WB.x - px, yb, _WB.z - pz,
        _WB.x + px, yb, _WB.z + pz, _WA.x + px, ya, _WA.z + pz, mr, mg, mb);
    }
  } else if (f.t === 'runway') runwayPaint(sink, fr, hw);
  else if (f.t === 'taxiway' || f.t === 'taxilane') taxiPaint(sink, fr);
}

// ---- runway paint ---------------------------------------------------------
// A runway is not a wide road, and the difference is entirely paint. Three
// marks carry it, in descending order of how much they matter from the air:
// the long dashed centreline that tells you where the middle is, the threshold
// "piano keys" that shout where the concrete starts, and the two edge stripes
// that give the strip its hard rectangular edge against the grass. Real ICAO
// dimensions: 30 m stripe / 20 m gap on the centreline, 0.9 m wide; threshold
// bars 30 m long and 1.8 m wide; edge stripes 0.9 m, set 3 m in from the lip.
const RW_DASH = 30, RW_GAP = 20, RW_HW = 0.45;
const RW_KEY_LEN = 30, RW_KEY_HW = 0.9, RW_KEY_GAP = 4.8, RW_KEY_START = 12;
const RW_EDGE_HW = 0.45, RW_EDGE_IN = 3;

// one flat stripe along the ribbon between arc lengths s0..s1, offset `off`
// metres to the right of the centreline and `hwid` half-width
function stripe(sink, fr, s0, s1, off, hwid, r, g, b) {
  walkAt(fr, s0, _WA); walkAt(fr, s1, _WB);
  const y = LAYER_Y.marking;
  const ax = _WA.x + _WA.dz * off, az = _WA.z - _WA.dx * off;
  const bx = _WB.x + _WB.dz * off, bz = _WB.z - _WB.dx * off;
  const p0x = _WA.dz * hwid, p0z = -_WA.dx * hwid;
  const p1x = _WB.dz * hwid, p1z = -_WB.dx * hwid;
  sink.quad(ax - p0x, y, az - p0z, bx - p1x, y, bz - p1z,
    bx + p1x, y, bz + p1z, ax + p0x, y, az + p0z, r, g, b);
}

function runwayPaint(sink, fr, hw) {
  const len = fr.len;
  if (len < 120) return;                       // a stub, not a strip
  _c.setHex(COLORS.runwayPaint);
  const r = _c.r, g = _c.g, b = _c.b;
  // centreline
  for (let s = RW_KEY_START + RW_KEY_LEN + 12; s + RW_DASH < len - (RW_KEY_START + RW_KEY_LEN + 12);
    s += RW_DASH + RW_GAP) stripe(sink, fr, s, s + RW_DASH, 0, RW_HW, r, g, b);
  // threshold keys at both ends, symmetric about the centreline. The count is
  // the real rule of thumb — a 45 m runway wears eight, a 60 m twelve.
  const keys = Math.max(4, Math.min(12, Math.round(hw * 2 / 7.5)) & ~1);
  for (const end of [0, 1]) {
    const s0 = end ? len - RW_KEY_START - RW_KEY_LEN : RW_KEY_START;
    for (let i = 0; i < keys; i++) {
      // lay them out in pairs either side of the middle, skipping the centre
      const k = i - (keys - 1) / 2;
      const off = k * (RW_KEY_HW * 2 + RW_KEY_GAP) + Math.sign(k) * RW_KEY_GAP * 0.5;
      if (Math.abs(off) + RW_KEY_HW > hw - 1) continue;
      stripe(sink, fr, s0, s0 + RW_KEY_LEN, off, RW_KEY_HW, r, g, b);
    }
  }
  // edge stripes down both lips
  for (const side of [-1, 1])
    stripe(sink, fr, 2, len - 2, side * (hw - RW_EDGE_IN), RW_EDGE_HW, r, g, b);
}

// Taxiways get the one mark that matters: a continuous yellow centreline. It
// is the thread that visibly ties the apron to the runway threshold.
function taxiPaint(sink, fr) {
  if (fr.len < 20) return;
  _c.setHex(COLORS.taxiPaint);
  stripe(sink, fr, 1, fr.len - 1, 0, 0.3, _c.r, _c.g, _c.b);
}

// ---- rails: two steel ribbons on the shared frame + sleeper quads ----
function railWay(sink, f) {
  const fr = ribbonFrame(f.p);
  if (!fr) return;
  const { q, per, along, len } = fr;
  const tram = f.t === 'tram';
  // trams lie flush IN the street (marking height, no sleepers); proper rail
  // sits on its own layer, steel nudged above the sleepers against z-fights
  const steelY = tram ? LAYER_Y.marking : LAYER_Y.rail + 0.04;
  const elev = (d) => (f.br ? bridgeElevation(d, len) : 0);
  _c.setHex(COLORS.rail);
  const cr = _c.r, cg = _c.g, cb = _c.b;
  for (const side of [-1, 1]) {
    const o1 = side * GAUGE_H - RAIL_HW, o2 = side * GAUGE_H + RAIL_HW;
    for (let i = 0; i < q.length - 1; i++) {
      const y0 = steelY + elev(along[i]), y1 = steelY + elev(along[i + 1]);
      const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
      const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
      sink.quad(
        ax + pax * o1, y0, az + paz * o1, bx + pbx * o1, y1, bz + pbz * o1,
        bx + pbx * o2, y1, bz + pbz * o2, ax + pax * o2, y0, az + paz * o2, cr, cg, cb);
    }
  }
  if (!tram) {
    _c.setHex(COLORS.sleeper);
    const sr = _c.r, sg = _c.g, sb = _c.b;
    for (let s = SLEEPER_STEP / 2; s < len; s += SLEEPER_STEP) {
      walkAt(fr, s, _WA);
      const y = LAYER_Y.rail + elev(s);
      const ux = _WA.dx * SLEEPER_HW, uz = _WA.dz * SLEEPER_HW;
      const px = _WA.dz * SLEEPER_HL, pz = -_WA.dx * SLEEPER_HL;
      sink.quad(
        _WA.x - ux - px, y, _WA.z - uz - pz, _WA.x + ux - px, y, _WA.z + uz - pz,
        _WA.x + ux + px, y, _WA.z + uz + pz, _WA.x - ux + px, y, _WA.z - uz + pz, sr, sg, sb);
    }
  }
}

// ---- facades: one shared 2048×1024 window atlas, built lazily on first use ----
// Drawn LIGHT (near-white plaster, dark glass) so per-building vertex tints
// multiply through legibly. Every cell keeps plaster near its borders, so
// mipmap bleed between cells blends plaster with plaster and stays invisible.
// Cell (0,0) is PLAIN plaster — roofs, prisms and any accidental uv land
// there and read as flat color. (1,0) is a glass storefront ground module,
// (2,0) a prefab-panel module with a concrete joint grid; the remaining 29
// cells are generic storey variants — seeded window rhythm, sills + lintels,
// sky-gradient glass, curtains, the odd warm lit room, French-balcony rails,
// and the four BRICK_CELLS in industrial brick courses. All randomness is
// rnd(cellSeed, salt): the identical canvas on every rebuild, every machine.
let _atlas = null;
function facadeAtlas() {
  if (_atlas) return _atlas;
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const g = cv.getContext('2d');
  const CW = ATLAS_W / ATLAS_N, CH = ATLAS_H / ATLAS_M, BAY = CW / BAYS;
  g.fillStyle = '#edebe4';
  g.fillRect(0, 0, ATLAS_W, ATLAS_H);
  for (let ci = 0; ci < ATLAS_N; ci++) for (let ri = 0; ri < ATLAS_M; ri++) {
    const X = ci * CW, Y = ri * CH, R = (n) => rnd(1 + ci + ri * ATLAS_N, n);
    // faint per-cell plaster shift — variants differ even before tinting
    g.fillStyle = `rgba(${205 + R(0) * 30 | 0},${200 + R(1) * 28 | 0},${188 + R(2) * 26 | 0},0.5)`;
    g.fillRect(X, Y, CW, CH);
    if (ci === 0 && ri === 0) continue;               // the PIN cell stays untouched plaster

    // aged plaster: faint vertical weather streaks under everything else.
    // Rain runs DOWN, so all grime here is vertical; alpha stays whisper-low
    // because the vertex-tint multiply would double a bold stain into soot.
    const nStreak = 8 + (R(50) * 10 | 0);
    for (let k = 0; k < nStreak; k++) {
      const w = 3 + R(300 + k) * 10;
      g.fillStyle = `rgba(98,92,80,${(0.02 + R(340 + k) * 0.035).toFixed(3)})`;
      g.fillRect(X + 5 + R(320 + k) * (CW - 12 - w), Y + 3, w, CH - 6);
    }

    if (ci === 1 && ri === 0) {
      // storefront: a dark fascia strip up top (where the shop sign hangs),
      // then a full-width glazing run down to near the pavement. The glass
      // carries a real vertical sky gradient — bright horizon light up high,
      // street-shadow murk at knee height — with a heavy mullion post at
      // every bay seam and a lighter meeting stile mid-bay. One bay becomes
      // the door: darker inset glass and a brass push bar.
      const gz0 = Y + 78, gz1 = Y + CH - 26;          // glazing run; plaster kept at cell borders
      g.fillStyle = `rgb(${64 + R(4) * 26 | 0},${58 + R(5) * 22 | 0},${52 + R(6) * 18 | 0})`;
      g.fillRect(X + 10, Y + 36, CW - 20, 34);
      const sky = g.createLinearGradient(0, gz0, 0, gz1);
      sky.addColorStop(0, '#8298ab'); sky.addColorStop(0.5, '#4c5663'); sky.addColorStop(1, '#2c323b');
      g.fillStyle = sky;
      g.fillRect(X + 10, gz0, CW - 20, gz1 - gz0);
      const db = Math.min(BAYS - 1, R(7) * BAYS | 0);
      g.fillStyle = 'rgba(24,27,32,0.8)';
      g.fillRect(X + db * BAY + 10, gz0 + 24, BAY - 20, gz1 - gz0 - 24);
      g.fillStyle = '#b09a6a';
      g.fillRect(X + db * BAY + 14, gz0 + (gz1 - gz0) * 0.55 | 0, BAY - 28, 4);
      g.fillStyle = '#8a857c';
      for (let b = 1; b < BAYS; b++) g.fillRect(X + b * BAY - 2, gz0, 4, gz1 - gz0);
      g.fillStyle = 'rgba(138,133,124,0.55)';
      for (let b = 0; b < BAYS; b++) g.fillRect(X + b * BAY + BAY / 2 - 1, gz0, 2, gz1 - gz0);
      continue;
    }

    const brick = BRICK_CELLS.some(([a, b]) => a === ci && b === ri);
    if (brick) {
      // brick courses for the industrial cells. Painted WASHED-OUT light
      // terracotta on purpose: the grayish industrial palette multiplies on
      // top and lands on believable sooty brick — true brick red here would
      // double-darken into mud. Joints are drawn LIGHT (mortar over brick).
      g.fillStyle = `rgb(${198 + R(60) * 18 | 0},${152 + R(61) * 16 | 0},${130 + R(62) * 14 | 0})`;
      g.fillRect(X + 5, Y + 4, CW - 10, CH - 8);
      const course = 6;                               // ~75 mm at ~82 px/m — real CZ brick format
      g.fillStyle = 'rgba(228,221,208,0.5)';
      for (let y = Y + 4 + course; y < Y + CH - 4; y += course)
        g.fillRect(X + 5, y, CW - 10, 1);             // bed joints
      g.fillStyle = 'rgba(228,221,208,0.3)';
      let row = 0;
      for (let y = Y + 4; y < Y + CH - 4 - course; y += course, row++)
        for (let x = X + 5 + (row % 2) * 3; x < X + CW - 5; x += 7)
          g.fillRect(x, y, 1, course);                // head joints, stretcher-bond staggered
    }
    if (ci === 2 && ri === 0) {
      // prefab panel joints: a concrete seam at every bay edge plus along the
      // storey top and bottom — wallUV tiles this cell per storey, so the
      // edge seams chain into the continuous joint grid of a real panelák
      g.fillStyle = '#b3b3ac';
      for (let b = 0; b <= BAYS; b++) g.fillRect(X + Math.min(b * BAY, CW - 3), Y, 3, CH);
      g.fillRect(X, Y, CW, 3);
      g.fillRect(X, Y + CH - 3, CW, 3);
    }

    // a band of BAYS windows; texel density is anisotropic (~24 px/m across,
    // ~82 px/m up) but the wall quads stretch it back to true aspect. wh is
    // clamped so window + sill + streaks never cross into the cell below.
    // FIXED window band and bay width. They used to jitter per cell, which was
    // prettier — but the destructible shell has to cut a REAL opening exactly
    // where the paint puts one (that is how you see into a building through its
    // windows), and it can only do that if every cell agrees on where the
    // window is. WIN_BAND / WIN_FRAC below are that agreement.
    const ww = (BAY * WIN_FRAC) | 0;
    const wy = (Y + CH * WIN_BAND[0]) | 0;
    const wh = (CH * (WIN_BAND[1] - WIN_BAND[0])) | 0;
    const lintel = R(7) < 0.72, mull = R(8) < 0.55;
    const balc = ri > 0 && !brick && R(9) < 0.22;     // rails only on some plaster variants
    for (let b = 0; b < BAYS; b++) {
      const sb = 100 + b * 10;                        // per-bay salt block — no collisions
      const wx = (X + b * BAY + (BAY - ww) / 2) | 0, s = R(sb);
      if (lintel) {                                   // concrete lintel shadow over the opening
        g.fillStyle = 'rgba(118,110,98,0.35)';
        g.fillRect(wx - 4, wy - 9, ww + 8, 6);
      }
      g.fillStyle = '#dad5c8';                        // painted frame proud of the reveal
      g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
      if (s < 0.11) {                                 // warm lit interior — the evening rooms
        const gl = g.createLinearGradient(0, wy, 0, wy + wh);
        gl.addColorStop(0, '#e6c88f'); gl.addColorStop(1, '#b28c50');
        g.fillStyle = gl;
      } else if (s < 0.24) {                          // net-curtained pale window
        g.fillStyle = `rgb(${196 + R(sb + 1) * 18 | 0},${190 + R(sb + 2) * 16 | 0},${178 + R(sb + 3) * 16 | 0})`;
      } else {                                        // glass mirrors the sky: bright up, murky down
        const t = R(sb + 4) * 20 | 0;
        const gl = g.createLinearGradient(0, wy, 0, wy + wh);
        gl.addColorStop(0, `rgb(${116 + t},${134 + t},${150 + t})`);
        gl.addColorStop(0.55, `rgb(${70 + t},${80 + t},${92 + t})`);
        gl.addColorStop(1, `rgb(${42 + t},${48 + t},${58 + t})`);
        g.fillStyle = gl;
      }
      g.fillRect(wx, wy, ww, wh);
      if (s >= 0.24 && s < 0.36) {                    // half-drawn curtain over sky glass
        g.fillStyle = 'rgba(214,209,199,0.5)';
        g.fillRect(wx, wy, ww, wh * 0.45 | 0);
      }
      if (mull) {                                     // T-profile: meeting stile + transom bar
        g.fillStyle = 'rgba(224,220,210,0.9)';
        g.fillRect(wx + (ww / 2 | 0) - 1, wy, 2, wh);
        g.fillRect(wx, wy + (wh * 0.3 | 0), ww, 2);
      }
      g.fillStyle = '#cfcabf';                        // sill…
      g.fillRect(wx - 4, wy + wh + 3, ww + 8, 5);
      g.fillStyle = 'rgba(105,98,86,0.8)';
      g.fillRect(wx - 4, wy + wh + 8, ww + 8, 1);     // …and its cast shadow line
      const sy = wy + wh + 9, sl = Math.min(28, Y + CH - 4 - sy);
      if (sl > 4) {                                   // rain-wash streaks off the sill ends
        g.fillStyle = 'rgba(105,98,86,0.14)';
        g.fillRect(wx - 3, sy, 2, sl);
        g.fillRect(wx + ww + 1, sy, 2, sl);
      }
      if (balc) {                                     // French balcony: rail bars over lower glass
        g.fillStyle = 'rgba(56,56,54,0.55)';
        const by = wy + (wh * 0.52 | 0);
        for (let rx = wx - 4; rx <= wx + ww + 2; rx += 6) g.fillRect(rx, by, 2, wy + wh - by + 6);
        g.fillRect(wx - 6, by, ww + 12, 2);
      }
    }
  }
  _atlas = new THREE.CanvasTexture(cv);
  _atlas.colorSpace = THREE.SRGBColorSpace;
  _atlas.anisotropy = 4;
  return _atlas;
}

// ---- buildings ----

// Facade walls are hand-built per ring edge instead of ExtrudeGeometry: an
// atlas cell cannot wrap-repeat, so each wall splits into ≤4-bay pieces per
// storey row, every piece sampling a sub-range of its variant cell. u maps
// one window per ~2.7 m (cols rounded, so windows stretch a touch to fit the
// run), v maps one cell height per storey. This is also why no UVGenerator
// post-pass on extrude uvs would do — no shader-free way to fold u back into
// a cell across a 30 m wall.
function ringFacade(sink, ring, isHole, P) {
  // outer walls face away from the ring interior, courtyard walls into it;
  // positive-area rings keep their interior on (−dz,dx) (see wallQuad)
  const S = (polygonArea(ring) > 0 ? 1 : -1) * (isHole ? -1 : 1);
  const aoH = Math.min(4, P.top - P.y0);
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez);
    if (L < 0.02) continue;
    const fx = S * ez, fz = -S * ex;
    const cols = Math.max(1, Math.round(L / WIN_W)), bayW = L / cols;
    // v5: the street door. Its span is skipped on the ground storey and a
    // header emitted over it, so the facade grows a REAL opening at exactly
    // the place interiors.js told pieces.js to leave a gap in the lining.
    const door = (!isHole && P.door && P.door.i === i) ? P.door : null;

    // Emit [t0,t1] of the edge, chunked into ≤BAYS bays so each piece samples a
    // sub-range of one atlas cell (a cell cannot wrap-repeat). v0/v1 pick how
    // much of the cell's height this band covers — a header takes the top slice.
    const run = (t0, t1, yB, yT, cell, v0, v1, kB, kT) => {
      const bayT = bayW / L;
      let s = t0;
      while (s < t1 - 1e-6) {
        const e = Math.min(t1, s + bayT * BAYS);
        sink.wallUV(ax + ex * s, az + ez * s, ax + ex * e, az + ez * e, yB, yT, fx, fz,
          cell[0], v0, cell[0] + ((e - s) / bayT) / BAYS / ATLAS_N, v1,
          P.wr * kB, P.wg * kB, P.wb * kB, P.wr * kT, P.wg * kT, P.wb * kT);
        s = e;
      }
    };

    for (let s = 0; s < P.storeys; s++) {
      const yB = P.y0 + s * P.sH, yT = P.y0 + (s + 1) * P.sH;
      const kB = WALL_AO + (1 - WALL_AO) * Math.min(1, (yB - P.y0) / aoH);
      const kT = WALL_AO + (1 - WALL_AO) * Math.min(1, (yT - P.y0) / aoH);
      const cell = s === 0 && P.storeC ? P.storeC : P.cellA;
      const cutDoor = door && s === 0 && P.sH > INTERIOR.entryH + 0.35;
      if (!cutDoor) { run(0, 1, yB, yT, cell, cell[1], cell[3], kB, kT); continue; }
      const hw = door.w / 2 / L, c = door.t;
      const d0 = Math.max(0, c - hw), d1 = Math.min(1, c + hw);
      if (d0 > 1e-4) run(0, d0, yB, yT, cell, cell[1], cell[3], kB, kT);
      if (d1 < 1 - 1e-4) run(d1, 1, yB, yT, cell, cell[1], cell[3], kB, kT);
      const hy = yB + INTERIOR.entryH;
      const vMid = cell[1] + (cell[3] - cell[1]) * (INTERIOR.entryH / P.sH);
      const kH = WALL_AO + (1 - WALL_AO) * Math.min(1, (hy - P.y0) / aoH);
      run(d0, d1, hy, yT, cell, vMid, cell[3], kH, kT);
    }
  }
}

// The doorway behind the hole. Three things, all cheap, and the third is the
// one that matters: jambs and a soffit turn the opening into a REVEAL (a flat
// hole in a flat wall reads as a texture error), and a dark leaf set back at
// the interior's own wall depth stops you seeing clean through the building
// when its interior has not been streamed in yet. The leaf faces outward only,
// so from inside it is back-face culled and the doorway is simply open — and
// once a missile promotes the building to boxes, the whole chunk mesh stops
// drawing it and the opening becomes a real hole in real geometry.
const DOOR_DEPTH = INTERIOR.extT + INTERIOR.linT;   // = the interior wall face
// A doorway you cannot find is a doorway that does not exist, and the first
// version's was a dark rectangle in a dark reveal — technically there, visually
// absent from ten metres. So the opening now gets the three things that make a
// real Czech street door readable at a glance: a light SURROUND standing proud
// of the plaster, a CANOPY over the pavement, and a lit SIGN board on its face.
// The surround and canopy go into the facade mesh; the sign board goes into its
// own emissive batch, so it glows at dusk exactly like the street lamps.
const CANOPY_D = 1.15, CANOPY_T = 0.2, SURROUND = 0.26;
function doorInto(sink, trim, sign, ring, P) {
  const d = P.door;
  const [ax, az] = ring[d.i], [bx, bz] = ring[(d.i + 1) % ring.length];
  const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez);
  if (L < 0.05) return;
  const ux = ex / L, uz = ez / L;
  const inx = -d.nx, inz = -d.nz;                    // into the building
  const c = L * d.t, hw = Math.min(d.w, L * 0.9) / 2;
  const yB = P.y0 + 0.02, yT = P.y0 + Math.min(INTERIOR.entryH, P.sH - 0.3);
  const jr = P.wr * 0.42, jg = P.wg * 0.42, jb = P.wb * 0.42;   // shaded reveal
  const at = (s, o) => [ax + ux * s + d.nx * (o ?? 0), az + uz * s + d.nz * (o ?? 0)];

  for (const sgn of [-1, 1]) {
    const px = ax + ux * (c + sgn * hw), pz = az + uz * (c + sgn * hw);
    // the jamb faces the middle of the opening
    wallQuad(sink, px, pz, px + inx * DOOR_DEPTH, pz + inz * DOOR_DEPTH,
      yT, yB, -sgn * ux, -sgn * uz, jr, jg, jb);
  }
  const A = at(c - hw), B = at(c + hw);
  sink.triFacing(A[0], yT, A[1], B[0], yT, B[1],
    B[0] + inx * DOOR_DEPTH, yT, B[1] + inz * DOOR_DEPTH, 0, -1, 0, jr, jg, jb);
  sink.triFacing(A[0], yT, A[1], B[0] + inx * DOOR_DEPTH, yT, B[1] + inz * DOOR_DEPTH,
    A[0] + inx * DOOR_DEPTH, yT, A[1] + inz * DOOR_DEPTH, 0, -1, 0, jr, jg, jb);
  // the leaf: dark, single-sided, standing where the interior wall's inner
  // face is, so stepping through it is stepping through the wall plane
  wallQuad(sink, A[0] + inx * DOOR_DEPTH, A[1] + inz * DOOR_DEPTH,
    B[0] + inx * DOOR_DEPTH, B[1] + inz * DOOR_DEPTH, yT, yB, d.nx, d.nz,
    P.wr * 0.16, P.wg * 0.15, P.wb * 0.14);

  if (!trim) return;
  // ---- the surround: a pale frame 6 cm proud of the wall ----
  const fr = 0.93, fg = 0.92, fb = 0.88;
  const O = 0.06;                                  // how far it stands out
  const box = (s0, s1, y0, y1) => {
    const p0 = at(s0), p1 = at(s1), q0 = at(s0, O), q1 = at(s1, O);
    // face, two returns and a top/bottom — a slab, cheaply
    trim.quad(q0[0], y1, q0[1], q1[0], y1, q1[1], q1[0], y0, q1[1], q0[0], y0, q0[1], fr, fg, fb);
    trim.quad(p0[0], y1, p0[1], q0[0], y1, q0[1], q0[0], y0, q0[1], p0[0], y0, p0[1], fr, fg, fb);
    trim.quad(q1[0], y1, q1[1], p1[0], y1, p1[1], p1[0], y0, p1[1], q1[0], y0, q1[1], fr, fg, fb);
  };
  box(c - hw - SURROUND, c - hw, yB, yT + SURROUND);
  box(c + hw, c + hw + SURROUND, yB, yT + SURROUND);
  box(c - hw - SURROUND, c + hw + SURROUND, yT, yT + SURROUND);

  // ---- the canopy: a slab over the pavement, and its underside ----
  const cy = yT + SURROUND + 0.16;
  if (cy + CANOPY_T < P.y0 + P.sH - 0.15) {
    const w0 = c - hw - SURROUND - 0.2, w1 = c + hw + SURROUND + 0.2;
    const p0 = at(w0), p1 = at(w1);
    const o0 = at(w0, CANOPY_D), o1 = at(w1, CANOPY_D);
    const cr = fr * 0.8, cg = fg * 0.8, cb = fb * 0.8;
    // top, front edge, and the underside (which is what you see from below)
    trim.triFacing(p0[0], cy + CANOPY_T, p0[1], p1[0], cy + CANOPY_T, p1[1],
      o1[0], cy + CANOPY_T, o1[1], 0, 1, 0, cr, cg, cb);
    trim.triFacing(p0[0], cy + CANOPY_T, p0[1], o1[0], cy + CANOPY_T, o1[1],
      o0[0], cy + CANOPY_T, o0[1], 0, 1, 0, cr, cg, cb);
    trim.triFacing(p0[0], cy, p0[1], p1[0], cy, p1[1], o1[0], cy, o1[1],
      0, -1, 0, cr * 0.7, cg * 0.7, cb * 0.7);
    trim.triFacing(p0[0], cy, p0[1], o1[0], cy, o1[1], o0[0], cy, o0[1],
      0, -1, 0, cr * 0.7, cg * 0.7, cb * 0.7);
    trim.quad(o0[0], cy + CANOPY_T, o0[1], o1[0], cy + CANOPY_T, o1[1],
      o1[0], cy, o1[1], o0[0], cy, o0[1], cr, cg, cb);
    // ---- the sign board, on the canopy's front edge, lit ----
    if (sign) {
      const s0 = at(w0 + 0.15, CANOPY_D + 0.03), s1 = at(w1 - 0.15, CANOPY_D + 0.03);
      const [sr, sg, sb] = P.signRGB ?? [1, 0.86, 0.62];
      sign.quad(s0[0], cy + CANOPY_T - 0.03, s0[1], s1[0], cy + CANOPY_T - 0.03, s1[1],
        s1[0], cy + 0.03, s1[1], s0[0], cy + 0.03, s0[1], sr, sg, sb);
    }
  }
}

// flat cap via earcut straight into the sink — keeps every facade-mode
// triangle in one uv-bearing stream and supplies the down-facing skyway
// underside ExtrudeGeometry used to give us. sink.tri()'s ny = −cross2D, so
// order per triangle to match the requested face direction.
function capInto(sink, outer, holes, y, up, r, g, b) {
  const pts = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const hpts = (holes ?? []).filter((h) => h.length >= 3)
    .map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(pts, hpts); } catch { return; }
  const all = pts.concat(...hpts);
  for (const [ia, ib, ic] of tris) {
    const pa = all[ia], pb = all[ib], pc = all[ic]; // p-prefixed: r/g/b already name the color
    const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    if (up === cross > 0) sink.tri(pa.x, y, pa.y, pc.x, y, pc.y, pb.x, y, pb.y, r, g, b);
    else sink.tri(pa.x, y, pa.y, pb.x, y, pb.y, pc.x, y, pc.y, r, g, b);
  }
}

// The one true wall colour of a building — explicit OSM colour if it has one,
// else the palette for its type; unnamed stock gets a light tint jitter so
// shared footprints don't read as copy-paste, while NAMED landmarks keep the
// pure palette hue so they pop.
//
// EXPORTED and cached on the feature because pieces.js needs the same answer.
// When a rocket promotes a building from this facade mesh to its own box model,
// the boxes must come out the colour the facade already was — otherwise the
// building visibly changes identity at the instant you hit it, which reads as a
// bug rather than as damage.
export function buildingWallHex(f) {
  if (f._wallHex !== undefined) return f._wallHex;
  // a chain paints its own boxes: a Kaufland is not "commercial beige"
  const brand = brandOf(f);
  if (brand?.wall !== undefined) return (f._wallHex = brand.wall);
  const pal = BUILDING_PALETTES[f.t] ?? BUILDING_PALETTES.default;
  const hex = f.c ? parseInt(f.c.slice(1), 16) : pal[Math.floor(rnd(f._id, 0) * pal.length)];
  _c.setHex(hex);
  if (!f.n) _c.offsetHSL((rnd(f._id, 1) - 0.5) * 0.02, -0.06 * rnd(f._id, 2), (rnd(f._id, 3) - 0.5) * 0.07);
  return (f._wallHex = _c.getHex());
}

// Which atlas cells this building's facade is painted from, and the bay pitch.
// EXPORTED because the destructible shell has to sample the SAME cells: that is
// the only way a building can stop being a textured quad and start being a pile
// of boxes without visibly changing. See pieces.js emitPerimeter('ext').
export function facadeCells(f) {
  return {
    cellA: f.t === 'panel' ? PANEL_CELL
      : BRICK_TYPES.has(f.t) ? BRICK_UV[f._id % BRICK_UV.length]
      : GENERIC[(hashStr(f.t ?? '') + f._id % 5) % GENERIC.length],
    storeC: STORE_TYPES.has(f.t) ? STORE_CELL : null,
    bayW: WIN_W, bays: BAYS, atlasN: ATLAS_N,
    band: WIN_BAND, frac: WIN_FRAC,
    pin: [PIN_U, PIN_V],
    atlas: facadeAtlas(),
  };
}

// ---- brand signage, far tier ---------------------------------------------
// The chunk-mesh twin of pieces.js brandSigns(). The near LOD builds a chain's
// fascia and totem out of boxes on the destructible shell; this is the SAME
// geometry for the merged far mesh, and the numbers are copied digit for digit
// — fascia H = 0.22·height clamped 0.7–1.6 m, hung 0.4 m below the parapet on
// the two LONGEST edges (a supermarket signs its front and its flank, never
// its bin store), run inset 6 % from each corner, front face 0.24 m proud
// (the near box: centre +0.12, half-depth 0.12); totem 5.5 m out from the
// entrance, 4.6 × 2.6 m panel centred at max(y0+5.4, top+1.5) on a 0.44 m
// steel pole. pieces.js is a pure-data module the headless tests import, so
// the agreement is a contract like WIN_BAND, not a shared function: change
// one side and every Kaufland morphs the instant its near-LOD boxes take over.
//
// On top of the flat colour the far tier adds the one thing boxes cannot do:
// WORDMARK quads (brandMarkMat below) centred on each fascia run and on the
// totem face, so the chain is legible from 300 m, long before the facade
// atlas resolves. They vanish into plain brand colour at the LOD swap — by
// which point you are standing at the door and the building says its name
// on the canopy sign anyway.

// One 1024×256 CanvasTexture + full-bright material per chain, module-cached
// (chunk unload disposes geometries only, so these live for the session and
// every chunk shares them — a cell with three brands costs three draw calls).
const _brandMats = new Map();
function brandMarkMat(brand) {
  const label = brand.label ?? 'Obchod';
  let m = _brandMats.get(label);
  if (m) return m;
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 256;
  const g = cv.getContext('2d');
  const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
  g.fillStyle = css(brand.sign);
  g.fillRect(0, 0, 1024, 256);
  // Ink: the chain's trim colour when it defines one (McDonald's writes red on
  // its yellow, KFC near-white on its red), else white — except on a LIGHT
  // fascia, where white would vanish: Billa is dark type on yellow, exactly
  // like the real shopfront. Perceived luminance off the sRGB bytes is enough
  // to make that call deterministically.
  const lum = 0.299 * (brand.sign >> 16 & 255) + 0.587 * (brand.sign >> 8 & 255)
    + 0.114 * (brand.sign & 255);
  g.fillStyle = css(brand.trim ?? (lum > 150 ? 0x23201a : 0xffffff));
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 168;
  g.font = `bold ${size}px Arial, sans-serif`;
  const w = g.measureText(label).width;
  if (w > 920) {                       // "Penny Market" must fit the same panel
    size = Math.floor(size * 920 / w);
    g.font = `bold ${size}px Arial, sans-serif`;
  }
  g.fillText(label, 512, 132);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;                  // fascias are read at grazing angles
  m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  _brandMats.set(label, m);
  return m;
}

// per-chunk wordmark quad stream, one per brand so the chunk batches per label
function markStream(marks, brand) {
  const label = brand.label ?? 'Obchod';
  let mk = marks.get(label);
  if (!mk) marks.set(label, mk = { brand, pos: [], uv: [] });
  return mk;
}

// A textured vertical quad a→b facing (fx,fz), full 0..1 uv window. Mind the
// u DIRECTION: for the winding whose derived normal is (dz,−dx), the viewer's
// screen-right is up × n = −(a→b), so u must DESCEND along the run or every
// wordmark comes out mirrored (the window atlas gets away with this in
// wallUV because windows are symmetric; text is not).
function markWall(mk, ax, az, bx, bz, yB, yT, fx, fz) {
  const dx = bx - ax, dz = bz - az;
  let Ax = ax, Az = az, Bx = bx, Bz = bz;
  if (dz * fx - dx * fz < 0) { Ax = bx; Az = bz; Bx = ax; Bz = az; }
  mk.pos.push(Ax, yT, Az, Bx, yT, Bz, Bx, yB, Bz, Ax, yT, Az, Bx, yB, Bz, Ax, yB, Az);
  mk.uv.push(1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
}

// OBB centre by interiors.frameOf's own rule (axis = longest edge) — the totem
// skip test below must agree with the near model's `fr.cx/cz` or the two LODs
// could disagree about whether a degenerate totem exists at all.
const _ct = { x: 0, z: 0 };
function obbCentre(ring, out) {
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    if (L2 > best) { best = L2; const L = Math.sqrt(L2); ux = dx / L; uz = dz / L; }
  }
  const vx = uz, vz = -ux;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, z] of ring) {
    const pu = x * ux + z * uz, pv = x * vx + z * vz;
    if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
    if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
  }
  out.x = ux * (u0 + u1) / 2 + vx * (v0 + v1) / 2;
  out.z = uz * (u0 + u1) / 2 + vz * (v0 + v1) / 2;
}

function brandSignage(f, y0, top, brand, cell, trim, sign, marks) {
  const ring = f.o;
  _c.setHex(brand.sign);
  const sr = _c.r, sg = _c.g, sb = _c.b;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  const mk = markStream(marks, brand);

  // ---- fascia band: the ENTRANCE edge first, then the longest flank ----
  // The sign belongs over the doors, facing the car park — two-longest alone
  // put both bands on the service side of a deep box. Same rule as the near
  // LOD in pieces.js brandSigns; change one, change both.
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    edges.push({ i, L: Math.hypot(bx - ax, bz - az) });
  }
  edges.sort((a, b) => b.L - a.L);
  const entI = f._ent?.i;
  if (entI !== undefined) {
    const k = edges.findIndex((e) => e.i === entI);
    if (k > 0 && edges[k].L >= 8) edges.unshift(edges.splice(k, 1)[0]);
  }
  const H = Math.min(1.6, Math.max(0.7, (top - y0) * 0.22));
  const yT = top - 0.4, yB = yT - H;
  for (const e of edges.slice(0, 2)) {
    if (e.L < 8) continue;
    const [ax, az] = ring[e.i], [bx, bz] = ring[(e.i + 1) % ring.length];
    const ux = (bx - ax) / e.L, uz = (bz - az) / e.L;
    const nx = sgn * uz, nz = -sgn * ux;   // outward, entranceOf's convention
    const at = (s, o) => [ax + ux * s + nx * o, az + uz * s + nz * o];
    const F0 = at(e.L * 0.06, 0.24), F1 = at(e.L * 0.94, 0.24);
    const K0 = at(e.L * 0.06, 0.02), K1 = at(e.L * 0.94, 0.02);
    wallQuad(sign, F0[0], F0[1], F1[0], F1[1], yT, yB, nx, nz, sr, sg, sb);
    wallQuad(sign, K0[0], K0[1], K1[0], K1[1], yT, yB, -nx, -nz, sr * 0.5, sg * 0.5, sb * 0.5);
    // a lid, so the band reads as the near model's solid box from a helicopter
    sign.triFacing(K0[0], yT, K0[1], K1[0], yT, K1[1], F1[0], yT, F1[1], 0, 1, 0, sr, sg, sb);
    sign.triFacing(K0[0], yT, K0[1], F1[0], yT, F1[1], F0[0], yT, F0[1], 0, 1, 0, sr, sg, sb);
    // the wordmark, ONCE, centred: a Czech retail shed signs its frontage with
    // one logo, not a repeating banner. Aspect-true (canvas is 4:1), a whisker
    // inside the band and 1 cm proud of its face.
    const hm = H * 0.94, wm = hm * 4;
    if (e.L * 0.88 > wm + 1) {
      const W0 = at(e.L / 2 - wm / 2, 0.25), W1 = at(e.L / 2 + wm / 2, 0.25);
      const mid = (yB + yT) / 2;
      markWall(mk, W0[0], W0[1], W1[0], W1[1], mid - hm / 2, mid + hm / 2, nx, nz);
    }
  }

  // ---- the totem by the entrance ----
  const ent = entranceOf(f, cell?.roads, cell?.buildings);
  if (!ent) return;
  const px = ent.x + ent.nx * 5.5, pz = ent.z + ent.nz * 5.5;
  obbCentre(ring, _ct);
  if (Math.hypot(px - _ct.x, pz - _ct.z) < 2) return;   // stands inside the shed
  const yaw = Math.atan2(ent.nz, -ent.nx) + Math.PI / 2; // face the street
  const aX = Math.cos(yaw), aZ = -Math.sin(yaw);         // panel's long axis
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);        // panel's face normal
  const P4 = (da, df) => [px + aX * da + fx * df, pz + aZ * da + fz * df];
  const PW = 2.3, PH = 2.6;
  const panelY = Math.max(y0 + 5.4, top + 1.5);
  const pT = panelY + PH / 2, pB = panelY - PH / 2;
  // the pole wears the near model's own dark steel, and it is LIT (the near
  // piece is kind 'ext'), so it goes into the trim batch, not the sign one
  _c.setHex(0x4a4d52);
  const pr = _c.r, pg = _c.g, pbl = _c.b;
  const c00 = P4(-0.22, -0.22), c10 = P4(0.22, -0.22);
  const c11 = P4(0.22, 0.22), c01 = P4(-0.22, 0.22);
  wallQuad(trim, c01[0], c01[1], c11[0], c11[1], pB, y0, fx, fz, pr, pg, pbl);
  wallQuad(trim, c00[0], c00[1], c10[0], c10[1], pB, y0, -fx, -fz, pr, pg, pbl);
  wallQuad(trim, c10[0], c10[1], c11[0], c11[1], pB, y0, aX, aZ, pr, pg, pbl);
  wallQuad(trim, c00[0], c00[1], c01[0], c01[1], pB, y0, -aX, -aZ, pr, pg, pbl);
  // the panel: brand colour on every face, backlit-bright like the fascia
  const e0 = P4(-PW, -0.16), e1 = P4(PW, -0.16), e2 = P4(PW, 0.16), e3 = P4(-PW, 0.16);
  wallQuad(sign, e3[0], e3[1], e2[0], e2[1], pT, pB, fx, fz, sr, sg, sb);
  wallQuad(sign, e0[0], e0[1], e1[0], e1[1], pT, pB, -fx, -fz, sr, sg, sb);
  wallQuad(sign, e1[0], e1[1], e2[0], e2[1], pT, pB, aX, aZ, sr, sg, sb);
  wallQuad(sign, e0[0], e0[1], e3[0], e3[1], pT, pB, -aX, -aZ, sr, sg, sb);
  sign.triFacing(e0[0], pT, e0[1], e1[0], pT, e1[1], e2[0], pT, e2[1], 0, 1, 0, sr, sg, sb);
  sign.triFacing(e0[0], pT, e0[1], e2[0], pT, e2[1], e3[0], pT, e3[1], 0, 1, 0, sr, sg, sb);
  // the wordmark strip across the face — one-sided at +0.18, matching the near
  // model's glyphs, which stand only on the street side of the panel
  const hm = 4.3 / 4;                                    // aspect-true on 4.3 m
  const W0 = P4(-2.15, 0.18), W1 = P4(2.15, 0.18);
  markWall(mk, W0[0], W0[1], W1[0], W1[1], panelY - hm / 2, panelY + hm / 2, fx, fz);
}

function buildingInto(f, geos, sink, facades, cell, trim, sign, marks) {
  if (!f.o || f.o.length < 3) return;
  const y0 = f.y ?? 0;
  const depth = Math.max(1, Math.max(2.2, f.h ?? 6) - y0); // h is total height; skyways start at y0
  // read the brand fresh at build time: stampFranchises() renames its hosts at
  // tile load, before chunks build, so a McDonald's is branded on the very
  // first mesh — and the chunk is re-meshed on interiors activation anyway
  const brand = brandOf(f);
  _c.setHex(buildingWallHex(f));
  const wr = _c.r, wg = _c.g, wb = _c.b;
  const rr = wr * ROOF_DARKEN, rg = wg * ROOF_DARKEN, rb = wb * ROOF_DARKEN;

  if (facades) {
    // storey count prefers the RÚIAN level tag; the variant cell hashes the
    // building type (neighbourhoods stay coherent) with a pinch of _id so
    // twin rows don't read as photocopies. Paneláky and industrial types skip
    // the hash and go straight to their purpose-painted cells.
    const storeys = Math.max(1, Math.min(60, Math.round(f.lv ?? depth / STOREY_H)));
    const P = {
      y0, top: y0 + depth, sH: depth / storeys, storeys, wr, wg, wb,
      cellA: f.t === 'panel' ? PANEL_CELL
        : BRICK_TYPES.has(f.t) ? BRICK_UV[f._id % BRICK_UV.length]
        : GENERIC[(hashStr(f.t ?? '') + f._id % 5) % GENERIC.length],
      storeC: STORE_TYPES.has(f.t) ? STORE_CELL : null,
      // v5: every building that has an inside gets a front door in its facade.
      // entranceOf caches its answer on the feature, so the hole never moves
      // between rebuilds and always matches the gap pieces.js leaves in the
      // interior lining.
      door: y0 < 0.5 && Math.abs(polygonArea(f.o)) >= 14
        ? entranceOf(f, cell?.roads, cell?.buildings) : null,
    };
    // a chain's fascia colour rides on the plan, so the canopy sign comes out
    // Kaufland red / Lidl blue rather than generic amber
    if (brand?.sign !== undefined) {
      _c.setHex(brand.sign);
      P.signRGB = [_c.r, _c.g, _c.b];
    }
    ringFacade(sink, f.o, false, P);
    if (P.door && P.sH > INTERIOR.entryH + 0.35) doorInto(sink, trim, sign, f.o, P);
    for (const h of f.i ?? []) if (h.length >= 3) ringFacade(sink, h, true, P);
    capInto(sink, f.o, f.i, y0 + depth, true, rr, rg, rb);
    if (y0 > 0.5) capInto(sink, f.o, f.i, y0, false, rr, rg, rb); // skyway underside
  } else {
    // v1 flat-color path: one extrude, painted vertices, no uv anywhere
    const g = new THREE.ExtrudeGeometry(ringShape(f.o, f.i), { depth, bevelEnabled: false, steps: 1 });
    g.rotateX(-Math.PI / 2);
    if (y0) g.translate(0, y0, 0);
    g.deleteAttribute('uv');
    const pos = g.attributes.position, nrm = g.attributes.normal, n = pos.count;
    const aoH = Math.min(4, depth);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      if (Math.abs(nrm.getY(i)) > 0.6) {          // roof (and unseen floor) cap
        col[i * 3] = rr; col[i * 3 + 1] = rg; col[i * 3 + 2] = rb;
      } else {                                    // wall, darkened toward the ground edge
        const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / aoH));
        const k = WALL_AO + (1 - WALL_AO) * t;
        col[i * 3] = wr * k; col[i * 3 + 1] = wg * k; col[i * 3 + 2] = wb * k;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  }
  // chain signage in BOTH wall modes — a Lidl is a Lidl with facades toggled
  // off, and the fascia/totem must match pieces.js regardless of the atlas
  if (brand?.sign !== undefined && sign && trim && marks)
    brandSignage(f, y0, y0 + depth, brand, cell, trim, sign, marks);
  // Roofs. In facade mode their tris pin to the plain plaster cell, so they
  // read as flat colour either way.
  //
  // A village house is one ridge over one rectangle, and an OBB prism is
  // exactly right for it. Prague is not that: its blocks are 400–2000 m² and
  // L- or U-shaped around a courtyard, and one giant ridge across such a
  // footprint would sail straight over the yard. Those get a CAP instead — the
  // real outline offset inward and lifted — which is what a hipped or mansard
  // roof actually is, and it follows every wing of the plan.
  if (f.r && f.r !== 'flat') {
    const a = Math.abs(polygonArea(f.o));
    const topY = y0 + depth;
    if (f.r === 'gabled' && a < 300) ridgePrism(sink, f.o, topY, rr, rg, rb);
    else if (a >= 300 && PITCHED.has(f.r)) roofCap(sink, f.o, topY, a, rr, rg, rb);
  }
}

// Roof shapes worth building a cap for. Everything else in the OSM/IPR domain
// (dome, onion, sawtooth…) stays flat: 108 domes in Prague are not worth a
// geometry path that could go wrong on the other 78 000.
const PITCHED = new Set(['gabled', 'hipped', 'half-hipped', 'mansard', 'gambrel',
  'pyramidal', 'hip-and-gable', 'round']);

const ROOF_MAX_N = 200;                   // bounds the O(n²) simplicity test
const ROOF_STEPS = [1, 0.5, 0.25, 0.125]; // depth fractions tried, deepest first

// Offset one ring inward by d along each vertex's angle bisector. Returns null
// for geometry that cannot be offset at all (a repeated vertex, a 180° spike);
// the CALLER decides whether the result is usable.
function insetRing(ring, d, sgn) {
  const n = ring.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const [px, pz] = ring[(i - 1 + n) % n], [cx, cz] = ring[i], [nx2, nz2] = ring[(i + 1) % n];
    let ax = cx - px, az = cz - pz, bx = nx2 - cx, bz = nz2 - cz;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) return null;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    // inward normals of the two edges meeting here, and their bisector
    const n1x = -az * sgn, n1z = ax * sgn, n2x = -bz * sgn, n2z = bx * sgn;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) return null;
    mx /= ml; mz /= ml;
    // the bisector travels 1/cos(half-angle) so both eaves stay parallel at
    // distance d; the clamp stops a sharp corner shooting off to infinity
    const k = Math.min(4, 1 / Math.max(0.25, (mx * n1x + mz * n1z)));
    out[i] = [cx + mx * d * k, cz + mz * d * k];
  }
  return out;
}

// Does a closed ring cross itself? The area and winding guards do not catch a
// ring that folded through a thin wing — over the real Prague footprints they
// pass 7 603 rings that are knots — so the simplicity test has to be explicit.
function ringSelfIntersects(ring) {
  const n = ring.length;
  const side = (ox, oz, ax, az, bx, bz) => (ax - ox) * (bz - oz) - (az - oz) * (bx - ox);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;     // shares the closing vertex
      const c = ring[j], dd = ring[(j + 1) % n];
      const d1 = side(c[0], c[1], dd[0], dd[1], a[0], a[1]);
      const d2 = side(c[0], c[1], dd[0], dd[1], b[0], b[1]);
      const d3 = side(a[0], a[1], b[0], b[1], c[0], c[1]);
      const d4 = side(a[0], a[1], b[0], b[1], dd[0], dd[1]);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
  }
  return false;
}

// A roof by inward offset: every eave vertex slides along its own angle
// bisector toward the interior by `d`, and the band between the original ring
// and the shrunken one becomes the slope. On a rectangle that is a hipped roof;
// on an L it is a hipped roof that turns the corner; on a courtyard block it is
// a mansard that follows all four wings — which is Prague's roofscape.
//
// Concave corners are where naive offsetting self-intersects, so the result is
// CHECKED rather than trusted: a ridge that folded through itself shows up as a
// collapsed or sign-flipped area, and the building simply keeps its flat top.
// Better a flat roof than a knot of triangles over Vinohrady.
export function roofCap(sink, ring, topY, area, r, g, b) {
  const n = ring.length;
  if (n < 3 || n > ROOF_MAX_N) return;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;   // which side of an edge is inside
  // Slope depth scales with the footprint, capped so a 2 000 m² block does not
  // grow a cathedral. But a block with a 6 m wing cannot give up 3.5 m from
  // both sides of it, and the naive offset answers that by folding through
  // itself — measured over the real data, at full depth that is 55 % of
  // Prague's big pitched blocks. So the depth STEPS DOWN until the ring comes
  // back simple, which rescues nine in ten of them; the rest stay flat.
  const d0 = Math.min(3.5, Math.max(1.2, Math.sqrt(area) / 7));
  let inner = null, d = 0;
  for (const f of ROOF_STEPS) {
    d = d0 * f;
    const cand = insetRing(ring, d, sgn);
    if (!cand) continue;
    const ia = polygonArea(cand);
    if (!(ia * sgn > 0) || Math.abs(ia) < area * 0.06 || Math.abs(ia) > area) continue;
    if (ringSelfIntersects(cand)) continue;
    inner = cand;
    break;
  }
  if (!inner) return;
  // rise follows the depth that actually survived — a 0.4 m lip with a 4 m
  // rise would be a spike, not a roof
  const rise = Math.min(4.2, Math.max(0.8, d * 1.15));
  const ry = topY + rise;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n];
    const [cx2, cz2] = inner[(i + 1) % n], [dx2, dz2] = inner[i];
    // outward-and-up normal of the slope, from the eave edge and the rise
    let ex = bx - ax, ez = bz - az;
    const el = Math.hypot(ex, ez);
    if (el < 1e-6) continue;
    const ox = ez / el * sgn, oz = -ex / el * sgn;   // outward horizontal
    const ny = d / Math.hypot(d, rise), nh = rise / Math.hypot(d, rise);
    const nx3 = ox * ny, nz3 = oz * ny;
    sink.triFacing(ax, topY, az, bx, topY, bz, cx2, ry, cz2, nx3, nh, nz3, r, g, b);
    sink.triFacing(ax, topY, az, cx2, ry, cz2, dx2, ry, dz2, nx3, nh, nz3, r, g, b);
  }
  // the flat top of the mansard, fanned from the first inner vertex — convex
  // enough after the area guard, and it is only ever seen from the air. The
  // facing hint is straight up whatever the ring's winding: triFacing flips the
  // triangle to match it, and a roof that faces down renders black.
  for (let i = 1; i < n - 1; i++)
    sink.triFacing(inner[0][0], ry, inner[0][1], inner[i][0], ry, inner[i][1],
      inner[i + 1][0], ry, inner[i + 1][1], 0, 1, 0, r, g, b);
}

// OBB of the footprint (dominant axis = its longest edge), ridge along the
// long axis: two slopes + two gable triangles; slight overhang is invisible
// from a car at < 300 m²
function ridgePrism(sink, ring, topY, r, g, b) {
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    if (L2 > best) { best = L2; const L = Math.sqrt(L2); ux = dx / L; uz = dz / L; }
  }
  const vx = uz, vz = -ux;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, z] of ring) {
    const pu = x * ux + z * uz, pv = x * vx + z * vz;
    if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
    if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
  }
  const hl = (u1 - u0) / 2, hw = (v1 - v0) / 2;
  if (hl < 0.5 || hw < 0.5) return;
  const cx = ux * (u0 + u1) / 2 + vx * (v0 + v1) / 2;
  const cz = uz * (u0 + u1) / 2 + vz * (v0 + v1) / 2;
  const ry = topY + Math.min(3.0, Math.max(1.2, hw * 0.75));
  const Ax = cx - ux * hl - vx * hw, Az = cz - uz * hl - vz * hw;
  const Bx = cx + ux * hl - vx * hw, Bz = cz + uz * hl - vz * hw;
  const Cx = cx + ux * hl + vx * hw, Cz = cz + uz * hl + vz * hw;
  const Dx = cx - ux * hl + vx * hw, Dz = cz - uz * hl + vz * hw;
  const R0x = cx - ux * hl, R0z = cz - uz * hl;
  const R1x = cx + ux * hl, R1z = cz + uz * hl;
  sink.triFacing(Ax, topY, Az, Bx, topY, Bz, R1x, ry, R1z, -vx, 0, -vz, r, g, b);
  sink.triFacing(Ax, topY, Az, R1x, ry, R1z, R0x, ry, R0z, -vx, 0, -vz, r, g, b);
  sink.triFacing(Cx, topY, Cz, Dx, topY, Dz, R0x, ry, R0z, vx, 0, vz, r, g, b);
  sink.triFacing(Cx, topY, Cz, R0x, ry, R0z, R1x, ry, R1z, vx, 0, vz, r, g, b);
  sink.triFacing(Bx, topY, Bz, Cx, topY, Cz, R1x, ry, R1z, ux, 0, uz, r, g, b);
  sink.triFacing(Dx, topY, Dz, Ax, topY, Az, R0x, ry, R0z, -ux, 0, -uz, r, g, b);
}

// ---- ortho ground: carve the aerial photo quad around sunken water ----
// The photo mesh arrives as an opaque quad; wherever water crosses the cell
// it must grow the same holes as the flat ground or it would roof the river.
// The original quad's planar uv mapping is recovered as an affine (x,z)→(u,v)
// fit from its first three vertices (in world space, in case ortho.js baked
// its placement into mesh.position), then re-applied to the carved outline.
function carveOrtho(mesh, x0, z0, x1, z1, holes) {
  const p = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
  if (!p || !uv || p.count < 3) return;
  mesh.updateMatrix();
  const V = [];
  for (let i = 0; i < 3; i++) {
    _v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrix);
    V.push([_v.x, _v.z, uv.getX(i), uv.getY(i)]);
  }
  const d1x = V[1][0] - V[0][0], d1z = V[1][1] - V[0][1];
  const d2x = V[2][0] - V[0][0], d2z = V[2][1] - V[0][1];
  const det = d1x * d2z - d2x * d1z;
  if (Math.abs(det) < 1e-9) return;
  const du1 = V[1][2] - V[0][2], du2 = V[2][2] - V[0][2];
  const dv1 = V[1][3] - V[0][3], dv2 = V[2][3] - V[0][3];
  const au = (du1 * d2z - du2 * d1z) / det, bu = (d1x * du2 - d2x * du1) / det;
  const av = (dv1 * d2z - dv2 * d1z) / det, bv = (d1x * dv2 - d2x * dv1) / det;
  const rect = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const ng = new THREE.ShapeGeometry(ringShape(rect, holes)).rotateX(-Math.PI / 2);
  const np = ng.attributes.position, nuv = ng.attributes.uv;
  for (let i = 0; i < np.count; i++) {
    const dx = np.getX(i) - V[0][0], dz = np.getZ(i) - V[0][1];
    nuv.setXY(i, V[0][2] + au * dx + bu * dz, V[0][3] + av * dx + bv * dz);
  }
  mesh.geometry = ng; // the quad geometry may be an ortho.js cache — leave it undisposed
  mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();
}

// ---- one chunk's buildings, as a single mesh ----
// Split out of buildChunkMeshes so ONE building can leave the batch without
// paying for a whole chunk rebuild: when a missile promotes a building to its
// own box model (destructible.js), city.js adds the id to `mats.hidden` and
// re-runs just this function for that cell. Roads are handed through so the
// front door can be aimed at the street (entranceOf caches the answer, so the
// scan happens once per building for the life of the session).
// mesh.name = 'buildings' is how city.js finds the old one to swap out.
export function buildBuildingsMesh(city, cx, cz, mats) {
  const key = cx + ',' + cz;
  const cell = city.chunkIndex.get(key);
  if (!cell) return null;
  const facades = !!mats.facades;
  const hidden = mats.hidden;
  const bGeos = [], bSink = new TriSink(facades);
  // door dressing lives in its own two batches: the surround/canopy carry no
  // atlas uv, and the sign board needs an emissive material main.js can turn up
  // at dusk. Two extra draw calls per chunk buys a city where you can see which
  // buildings you can walk into. Brand WORDMARKS batch per chain on top —
  // a cell holding a Lidl and two Kauflands adds two meshes, not six.
  const trim = new TriSink(), sign = new TriSink();
  const marks = new Map();
  for (const f of cell.buildings) {
    if (f._home !== key) continue;
    if (hidden && hidden.has(f._id)) continue;   // now made of boxes instead
    buildingInto(f, bGeos, bSink, facades, cell, trim, sign, marks);
  }
  const pg = bSink.geo();
  if (pg) bGeos.push(pg);
  if (!bGeos.length) return null;
  const mat = facades
    ? (mats._facadeMat ??= new THREE.MeshLambertMaterial({ vertexColors: true, map: facadeAtlas() }))
    : mats.building;
  const group = new THREE.Group();
  group.name = 'buildings';
  const m = new THREE.Mesh(mergeGeometries(bGeos, false), mat);
  m.castShadow = m.receiveShadow = true;
  group.add(m);
  const tg = trim.geo();
  if (tg) {
    const t = new THREE.Mesh(tg, mats.doorTrim);
    t.castShadow = t.receiveShadow = true;
    group.add(t);
  }
  const sg2 = sign.geo();
  if (sg2) group.add(new THREE.Mesh(sg2, mats.doorSign));
  // the wordmark quads, one Mesh per chain present in the cell. No normals —
  // brandMarkMat is a MeshBasicMaterial and never shades. Geometry is owned by
  // the group (disposed on rebuild/unload); the material and its texture are
  // module-cached and shared city-wide.
  for (const mk of marks.values()) {
    if (!mk.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mk.pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mk.uv), 2));
    group.add(new THREE.Mesh(g, brandMarkMat(mk.brand)));
  }
  return group;
}

// ---- street lamps: the detail that makes a road read as a street ----
// A plain post with a short arm and a lamp head, placed along the drivable
// carriageway every LAMP_STEP meters and alternating sides. Two instanced
// meshes per chunk (post + head); the head material is emissive so dusk turns
// the whole city on for free — no lights, no shadow cost.
const LAMP_STEP = 34, LAMP_MIN_W = 5.4, LAMP_H = 7.2;
let _lPost = null, _lHead = null;
function lampTemplates() {
  if (!_lPost) {
    // post + arm merged: one upright cylinder, one short horizontal box
    const post = new THREE.CylinderGeometry(0.075, 0.11, LAMP_H, 6, 1).translate(0, LAMP_H / 2, 0);
    const arm = new THREE.BoxGeometry(1.05, 0.11, 0.11).translate(0.5, LAMP_H - 0.16, 0);
    _lPost = mergeGeometries([post, arm], false);
    _lHead = new THREE.BoxGeometry(0.66, 0.17, 0.3).translate(1.0, LAMP_H - 0.3, 0);
  }
  return [_lPost.clone(), _lHead.clone()];
}

// ---- trees: shared low-poly template, CLONED per chunk (chunk unload
// disposes geometries; a shared template would lose its GPU buffers) ----
let _tTrunk = null, _tCrown = null;
function treeTemplates() {
  if (!_tTrunk) {
    // A mature tree is a BUILDING-sized object: a Czech boulevard lime runs
    // 10–15 m, a spruce in the floodplain 20–30 m. The first template topped
    // out at 3.9 m before jitter, which put a full-grown tree barely above
    // head height — the single loudest scale error in the city.
    _tTrunk = new THREE.CylinderGeometry(0.16, 0.27, 5.0, 6, 1).translate(0, 2.5, 0);
    _tCrown = new THREE.IcosahedronGeometry(3.2, 0).scale(1, 1.05, 1).translate(0, 7.4, 0);
  }
  return [_tTrunk.clone(), _tCrown.clone()];
}

// ---- forests: real trees where the data only says "green" ----
// A wood drawn as a flat polygon reads as PAINT the moment you drive past it.
// Kunětická hora and the Labe floodplain are supposed to feel like the woods
// of AmongTheWoods, so every wood/forest polygon — and every park big enough
// to be canopy rather than lawn — grows actual trees into the chunk's tree
// InstancedMeshes.
//
// The scatter is a jittered grid ANCHORED TO THE WORLD, not to the polygon
// bbox and not to the chunk: grid cell (gi,gj) always produces the same point
// for the same polygon, so a tree belongs to exactly ONE chunk (half-open rect
// test) and no rebuild — of this cell or of a lone neighbour — can duplicate,
// drop or shift it. Every draw hashes the polygon _id, never Math.random, so
// two machines streaming the same tile grow the identical forest.
const FOREST_STEP = Math.sqrt(55);        // ≈7.42 m grid → one candidate per 55 m²
const FOREST_INSET = 0.08;                // jitter window inset — trees in adjacent
const FOREST_JIT = 1 - 2 * FOREST_INSET;  // cells keep ≥0.16·step ≈ 1.2 m apart
const FOREST_CAP = 400;                   // per polygon per chunk: a 900 ha wood must
                                          // not outspend the cell it happens to cross
const PARK_WOODED = 4000;                 // m² — below this a "park" is lawn, and its
                                          // mapped natural=tree points are the trees
const WOOD_TYPES = new Set(['wood', 'forest']);
const FOREST_FLOOR = 0x3a4a30;            // shade + litter under a canopy, not meadow

// (polygon _id, grid cell) → seed for rnd(). Deliberately folded down to ~2^20:
// rnd() multiplies its id by 374761393 in DOUBLE precision, so a full 32-bit
// seed would lose the low bits of that product and neighbouring cells would
// draw correlated jitter (visible as trees marching in rows).
function forestSeed(id, gi, gj) {
  let h = Math.imul(id ^ 0x9e3779b1, 2654435761);
  h = Math.imul(h ^ Math.imul(gi, 0x27d4eb2d), 2246822519);
  h = Math.imul(h ^ Math.imul(gj, 0x165667b1), 3266489917);
  h ^= h >>> 15;
  return (h >>> 0) % 1000003;
}

// which green polygons deserve a canopy. Parks are area-gated because the OSM
// "park" bucket holds everything from Tyršovy sady down to a 200 m² traffic
// island — filling those with 7 m trees would bury the streets they decorate.
function woodedGreen(f) {
  if (!f.o || f.o.length < 3) return false;
  if (WOOD_TYPES.has(f.t)) return true;
  if (f.t !== 'park') return false;
  return (f._area ??= Math.abs(polygonArea(f.o))) >= PARK_WOODED;
}

// Scatter one wooded polygon's share of THIS chunk into `out` (the spots the
// tree instancer consumes). Candidates come from the world grid over the part
// of the polygon that reaches into the cell, then survive three rejects:
// inside the outline, outside every hole, and — because floodplain woods are
// mapped straight across the Labe — not standing in open water, which renders
// 2 m below them.
//
// The rings are CLIPPED to the cell once up front rather than point-tested
// against the full outline: a Labe wood carries thousands of nodes, and
// ~290 candidates × 3000 edges per chunk was a 50 ms build spike measured on
// the real tiles. Sutherland–Hodgman leaves the inside/outside answer exact
// for points within the rect (all of ours are, by the half-open test below)
// and hands back a ring that is usually a handful of vertices.
function scatterForest(f, x0, z0, x1, z1, waters, out) {
  if (!woodedGreen(f)) return;
  const ring = clipRingToRect(f.o, x0, z0, x1, z1);
  if (!ring) return;                          // polygon only grazes this cell
  const holes = [];
  for (const h of f.i ?? []) {
    if (h.length < 3) continue;
    const ch = clipRingToRect(h, x0, z0, x1, z1);
    if (ch) holes.push(ch);
  }
  let ax = 1e9, bx = -1e9, az = 1e9, bz = -1e9;
  for (const [x, z] of ring) {
    if (x < ax) ax = x; if (x > bx) bx = x;
    if (z < az) az = z; if (z > bz) bz = z;
  }
  let n = 0;
  const gi0 = Math.floor(ax / FOREST_STEP), gj0 = Math.floor(az / FOREST_STEP);
  for (let gi = gi0; gi * FOREST_STEP < bx; gi++) {
    for (let gj = gj0; gj * FOREST_STEP < bz; gj++) {
      if (n >= FOREST_CAP) return;        // capped, silently — a thin patch in a
      const seed = forestSeed(f._id, gi, gj); // distant wood beats a frame spike
      const x = (gi + FOREST_INSET + FOREST_JIT * rnd(seed, 1)) * FOREST_STEP;
      const z = (gj + FOREST_INSET + FOREST_JIT * rnd(seed, 2)) * FOREST_STEP;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue; // half-open: one owner
      if (!pointInPolygon(x, z, ring)) continue;
      let ok = true;
      for (const h of holes) if (pointInPolygon(x, z, h)) { ok = false; break; }
      if (ok && waters.length && inWater(x, z, waters)) ok = false;
      if (!ok) continue;
      out.push({ x, z, seed, forest: true });
      n++;
    }
  }
}

// ---- the chunk builder ----
// groundOnly builds the FAR tier: nothing but the aerial photo on a quad.
// From a helicopter the ortho already shows the roads, roofs and fields, so a
// ring of these carries the view out to kilometres for one draw call each —
// the alternative was watching the fully-detailed world simply stop.
// ---- float32 and a 110 km world ------------------------------------------
// Every builder below writes WORLD coordinates into geometry, which was fine
// while the world was a 30 km box: float32 resolves 0.5 mm at 4.8 km. Prague is
// 95 km west of the origin, where the spacing is 7.8 mm — and worse, the vertex
// shader computes modelViewMatrix × position with both terms near ±95 000, so
// the subtraction that should leave a metre of view space instead leaves
// catastrophic cancellation, and the whole city swims as the camera moves.
//
// The fix every large-world renderer uses (Cesium calls it RTC): keep the
// offset OUT of the vertex data and put it in the object's transform, because
// three.js computes matrixWorld and modelViewMatrix on the CPU in float64 and
// only the small, already-cancelled result reaches the GPU. So a finished chunk
// is shifted to be local to its own centre and the Group carries the rest.
//
// The shift itself runs on the already-float32 arrays, which leaves the vertices
// snapped to that 7.8 mm grid at Prague — invisible on a low-poly city with 3 m
// windows, and it is the JITTER, not the snap, that the eye catches.
export function rebase(obj, bx, bz) {
  obj.traverse((o) => {
    if (o.isInstancedMesh) {
      // column-major Matrix4: elements 12,13,14 are the translation
      const a = o.instanceMatrix.array;
      for (let i = 12; i + 2 < a.length; i += 16) { a[i] -= bx; a[i + 2] -= bz; }
      o.instanceMatrix.needsUpdate = true;
      o.computeBoundingSphere();
    } else if (o.userData.localGeom) {
      // a unit quad that already carries its offset in .position (the ortho
      // photo tile, the far-ring ground plane) — its geometry is local already
      o.position.x -= bx; o.position.z -= bz;
      // …and the ortho quad bakes its matrix ONCE (matrixAutoUpdate = false,
      // because it never moves again). Moving .position on such an object is
      // a no-op unless the matrix is rebuilt — which is why every aerial photo
      // silently rendered a chunk-centre away from its own chunk.
      if (!o.matrixAutoUpdate) o.updateMatrix();
    } else if (o.geometry) {
      o.geometry.translate(-bx, 0, -bz);
    }
  });
}
export const chunkBase = (cx, cz) => [cx * CHUNK + CHUNK / 2, cz * CHUNK + CHUNK / 2];

export function buildChunkMeshes(city, cx, cz, mats, groundOnly = false) {
  const key = cx + ',' + cz;
  const cell = city.chunkIndex.get(key);
  // A GROUND-ONLY cell needs nothing from the city — it is an aerial photo and
  // nothing else. Requiring an indexed cell first meant that whenever the
  // region tiles lagged behind (which is exactly what happens at 700 m/s) the
  // far ring returned null and the world simply had a HOLE in it: no photo, no
  // quad, just the fog-coloured apron showing through. So the photo goes down
  // as soon as the WMS can serve it, and the data fills in behind it.
  if (!cell && !groundOnly) return null;        // outside the mapped city
  const group = new THREE.Group();
  group.name = 'chunk:' + key;
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const [bx, bz] = chunkBase(cx, cz);
  const done = () => { rebase(group, bx, bz); group.position.set(bx, 0, bz); return group; };
  if (groundOnly) {
    const g = mats.ortho?.orthoGroundMesh?.(cx, cz);
    if (g) { g.userData.localGeom = true; group.add(g); return done(); }
    // No photo AND no data means we are off the edge of the world (ortho.js
    // clamps its requests to the region) — the apron is the right answer there,
    // and paving open country with grey quads would only cost draw calls.
    if (!cell) return null;
    const q = new THREE.Mesh(new THREE.PlaneGeometry(CHUNK, CHUNK), mats.flatFar ?? mats.flat);
    q.rotation.x = -Math.PI / 2;
    q.position.set(x0 + CHUNK / 2, 0, z0 + CHUNK / 2);
    q.userData.localGeom = true;
    group.add(q);
    return done();
  }
  const flat = [], sink = new TriSink();

  // -- water first: it decides the holes the ground must be carved with --
  const holes = [];
  // the cell's water rings, already clipped to it: the forest scatter borrows
  // them so it never plants a tree in the river (floodplain woods are mapped
  // straight over the Labe), and it can only afford that test because these
  // rings are cut down to this one cell instead of running the whole river
  const wet = [];
  let flooded = false;                          // some ring swallowed the whole cell
  _c.setHex(BANK_COL);
  const kr = _c.r, kg = _c.g, kb = _c.b;
  for (const f of cell.water) {
    if (!f.o || f.o.length < 3) continue;
    // clip-per-chunk instead of _home dedupe: the Labe is one polygon spanning
    // dozens of cells, and home-only rendering would pop it with one far cell
    const clip = clipRingToRect(f.o, x0, z0, x1, z1);
    if (clip && Math.abs(polygonArea(clip)) > 0.5) {
      if (Math.abs(polygonArea(clip)) >= CHUNK * CHUNK * 0.999) flooded = true;
      else holes.push(clip);
      const iClip = (f.i ?? []).map((h) => clipRingToRect(h, x0, z0, x1, z1)).filter(Boolean);
      wet.push({ o: clip, i: iClip });
      const surf = shapePoly(clip, iClip, WATER_Y, COLORS.water);
      if (surf) flat.push(surf);
      // islands are land: give them a lid just under the green-fill layer,
      // their outline already grows a skirt facing out into the water below
      for (const h of iClip) {
        const plate = shapePoly(h, null, 0.02, COLORS.groundBase);
        if (plate) flat.push(plate);
      }
    }
    // skirts ride the ORIGINAL rings — the clipped ones grew artificial edges
    // along the cell border that would dam the river with earth walls
    skirtRing(sink, f.o, key, true, kr, kg, kb);
    for (const h of f.i ?? []) if (h.length >= 3) skirtRing(sink, h, key, false, kr, kg, kb);
  }
  const ww = wwBuckets(city).get(key);
  if (ww) for (const f of ww) trenchInto(sink, flat, holes, f, cell, x0, z0, x1, z1, kr, kg, kb);

  // -- ground: aerial photo when the ortho manager has the tile, flat quad
  // otherwise — both carved with the water holes; a fully flooded cell needs
  // no ground at all (the river surface and its banks are the geometry) --
  let orthoGround = null;
  if (!flooded) {
    orthoGround = mats.ortho?.orthoGroundMesh?.(cx, cz) ?? null;
    if (orthoGround) {
      // carving replaces the unit quad with a world-space ShapeGeometry and
      // zeroes .position, so only the UNcarved tile is still local
      if (holes.length) carveOrtho(orthoGround, x0, z0, x1, z1, holes);
      else orthoGround.userData.localGeom = true;
      orthoGround.receiveShadow = true;
      group.add(orthoGround);
    } else {
      const g = shapePoly([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes, 0, COLORS.groundBase);
      if (g) flat.push(g);
    }
  }

  // -- green/paved fills: only on the flat ground — the photo already shows
  // every lawn and parking lot, painting solid color on top would undo it --
  const scatter = mats.trees !== false;
  if (!orthoGround) {
    // A wood keeps its fill (the trees don't close ranks, and a bare base plane
    // between the trunks would be worse) but it goes to forest-floor tone —
    // meadow green glowing through a canopy is exactly what made these read as
    // paint. With trees switched off the honest wood green comes back.
    const greenOf = (f) => (scatter && WOOD_TYPES.has(f.t) ? FOREST_FLOOR
      : COLORS.green[f.t] ?? (WOOD_TYPES.has(f.t) ? COLORS.green.wood : COLORS.green.grass));
    const polyKinds = [
      [cell.green, LAYER_Y.green, greenOf],
      [cell.paved, LAYER_Y.paved, (f) => COLORS.paved[f.t] ?? COLORS.paved.plaza],
    ];
    for (const [list, y, pick] of polyKinds) for (const f of list) {
      if (f._home !== key || f.o.length < 3) continue;
      const g = shapePoly(f.o, f.i, y, pick(f));
      if (g) flat.push(g);
    }
  }

  // -- roads + rails ribbons into the same sink, merged with everything --
  for (const f of cell.roads) if (f._home === key) roadRibbon(sink, f);
  for (const f of cell.rails) if (f._home === key) railWay(sink, f);
  const sg = sink.geo();
  if (sg) flat.push(sg);
  if (flat.length) {
    const flatMesh = new THREE.Mesh(mergeGeometries(flat, false), mats.flat);
    flatMesh.receiveShadow = true;              // ground catches, never casts
    group.add(flatMesh);
  }

  // -- buildings: facade walls or v1 extrudes, one casting mesh either way --
  const bm = buildBuildingsMesh(city, cx, cz, mats);
  if (bm) group.add(bm);

  // -- street lamps along the wider drivable roads --
  if (mats.lamps !== false) {
    const spots = [];
    for (const r of cell.roads) {
      if (!r.d || r.w < LAMP_MIN_W || r._home !== key) continue;
      const half = r.w / 2 + 0.7;              // just off the kerb
      let carry = (r._id % 17) * 2;            // stagger so junctions aren't twinned
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        let dx = bx - ax, dz = bz - az;
        const L = Math.hypot(dx, dz);
        if (L < 0.01) continue;
        dx /= L; dz /= L;
        for (let d = LAMP_STEP - carry; d < L; d += LAMP_STEP) {
          const px = ax + dx * d, pz = az + dz * d;
          if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue; // this cell only
          const side = ((spots.length + (r._id % 2)) & 1) ? 1 : -1; // alternate kerbs
          // arm points at the road: post sits on the kerb, head reaches in
          const nx = -dz * side, nz = dx * side;
          spots.push([px + nx * half, pz + nz * half, Math.atan2(-nx, -nz) + Math.PI]);
        }
        carry = (carry + L) % LAMP_STEP;
      }
    }
    if (spots.length) {
      const [pg, hg] = lampTemplates();
      const posts = new THREE.InstancedMesh(pg, mats.lampPost, spots.length);
      const heads = new THREE.InstancedMesh(hg, mats.lampHead, spots.length);
      posts.castShadow = true;
      for (let i = 0; i < spots.length; i++) {
        const [px, pz, rot] = spots[i];
        _q.setFromAxisAngle(_up, rot);
        _v.set(px, 0, pz); _s.set(1, 1, 1);
        _m4.compose(_v, _q, _s);
        posts.setMatrixAt(i, _m4);
        heads.setMatrixAt(i, _m4);
      }
      posts.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
      group.add(posts, heads);
    }
  }

  // -- trees: two InstancedMeshes (trunks / crowns) sharing transforms --
  // Mapped street trees (natural=tree points, rendered from their home cell)
  // and FOREST trees (scattered through every wooded polygon that reaches into
  // this cell) share one batch — the draw-call budget is per chunk, not per
  // source, and a floodplain cell would otherwise pay twice for the same pair
  // of meshes. Settings can switch the whole lot off (mats.trees === false).
  const trees = [];
  if (scatter) {
    for (const t of cell.trees) if (t._home === key)
      trees.push({ x: t.p[0][0], z: t.p[0][1], seed: t._id, forest: false });
    for (const f of cell.green) scatterForest(f, x0, z0, x1, z1, wet, trees);
  }
  if (trees.length) {
    const [tg, cg] = treeTemplates();
    const trunk = new THREE.InstancedMesh(tg, mats.trunk, trees.length);
    const crown = new THREE.InstancedMesh(cg, mats.crown, trees.length);
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i], id = t.seed;
      // forest stock grows taller and leaner than the pruned boulevard rows
      // (≈11–25 m against 7–12 m) and its crowns go deeper, darker green —
      // a canopy that shades itself, not a line of park lollipops
      const s = t.forest ? 1.05 + rnd(id, 4) * 0.70 : 0.70 + rnd(id, 4) * 0.42;
      const yk = t.forest ? 1.0 + rnd(id, 6) * 0.45 : 0.88 + rnd(id, 6) * 0.30;
      _v.set(t.x, 0, t.z);
      _q.setFromAxisAngle(_up, rnd(id, 5) * Math.PI * 2);
      _s.set(s, s * yk, s);
      _m4.compose(_v, _q, _s);
      trunk.setMatrixAt(i, _m4);
      crown.setMatrixAt(i, _m4);
      _c.setHex(COLORS.treeCrown[id % COLORS.treeCrown.length]);
      if (t.forest) _c.offsetHSL(0.012, 0.05, -0.085 + (rnd(id, 7) - 0.5) * 0.06);
      else _c.offsetHSL(0, 0, (rnd(id, 7) - 0.5) * 0.08);
      crown.setColorAt(i, _c);
    }
    // instance matrices live in world space — recompute bounds or the whole
    // batch frustum-culls against the template's origin-sized sphere
    trunk.computeBoundingSphere(); crown.computeBoundingSphere();
    trunk.castShadow = trunk.receiveShadow = true;
    crown.castShadow = crown.receiveShadow = true;
    group.add(trunk, crown);
  }
  return done();
}
