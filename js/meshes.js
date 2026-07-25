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
// Color discipline: renderer output is sRGB with three's color management on,
// so every palette hex goes through Color.setHex() (sRGB → linear working
// space) BEFORE it lands in a vertex-color attribute.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { CHUNK, LAYER_Y, COLORS, BUILDING_PALETTES, ROOF_DARKEN, WALL_AO,
  WATER_Y, BANK_DEPTH } from './config.js';
import { bridgeElevation, polygonArea, pointInPolygon, chunkKey } from './geo.js';

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
// The 1024² atlas is an 8×4 grid of 128×256 cells; each cell holds a BAND of
// 4 window bays, because an atlas cell cannot wrap-repeat — walls subdivide
// into ≤4-bay pieces instead, each sampling a sub-range of one cell.
const WIN_W = 2.7, STOREY_H = 3.1, BAYS = 4;
const ATLAS_N = 8, ATLAS_M = 4;
const cellRect = (ci, ri) => [ci / ATLAS_N, 1 - (ri + 1) / ATLAS_M, (ci + 1) / ATLAS_N, 1 - ri / ATLAS_M];
const PIN_U = 0.5 / ATLAS_N, PIN_V = 1 - 0.5 / ATLAS_M; // plain-plaster cell centre — roofs pin here
const STORE_CELL = cellRect(1, 0), PANEL_CELL = cellRect(2, 0);
const GENERIC = [];                                  // every cell except the three reserved ones
for (let ri = 0; ri < ATLAS_M; ri++) for (let ci = 0; ci < ATLAS_N; ci++)
  if (!(ri === 0 && ci < 3)) GENERIC.push(cellRect(ci, ri));
const STORE_TYPES = new Set(['retail', 'commercial', 'supermarket', 'kiosk', 'hotel']);

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
    crown: new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
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
    const sx = ax + (bx - ax) * c.t0, sz = az + (bz - az) * c.t0;
    const ex = ax + (bx - ax) * c.t1, ez = az + (bz - az) * c.t1;
    if (inWater((sx + ex) / 2, (sz + ez) / 2, cell.water)) { flush(false); continue; }
    // cut ends use the plain segment perp — both neighbours derive it from the
    // same segment, so the trench edge matches exactly across the border
    const L = Math.hypot(bx - ax, bz - az) || 1, spx = (bz - az) / L, spz = -(bx - ax) / L;
    if (!run || c.t0 > 0) {
      flush(false);
      run = [{ x: sx, z: sz, px: c.t0 === 0 ? per[i][0] : spx, pz: c.t0 === 0 ? per[i][1] : spz }];
      run.cap0 = i === 0 && c.t0 === 0;
    }
    run.push({ x: ex, z: ez, px: c.t1 === 1 ? per[i + 1][0] : spx, pz: c.t1 === 1 ? per[i + 1][1] : spz });
    if (c.t1 < 1) flush(false);
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
  }
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

// ---- facades: one shared 1024² window atlas, built lazily on first use ----
// Drawn LIGHT (near-white plaster, dark glass) so per-building vertex tints
// multiply through legibly. Every cell keeps plaster at its borders, so
// mipmap bleed between cells blends plaster with plaster and stays invisible.
// Cell (0,0) is PLAIN plaster — roofs, prisms and any accidental uv land
// there and read as flat color. (1,0) is a storefront ground module, (2,0) a
// concrete panel module with seams; the rest are window-band variants.
let _atlas = null;
function facadeAtlas() {
  if (_atlas) return _atlas;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1024;
  const g = cv.getContext('2d');
  const CW = 1024 / ATLAS_N, CH = 1024 / ATLAS_M, BAY = CW / BAYS;
  g.fillStyle = '#edebe4';
  g.fillRect(0, 0, 1024, 1024);
  for (let ci = 0; ci < ATLAS_N; ci++) for (let ri = 0; ri < ATLAS_M; ri++) {
    const X = ci * CW, Y = ri * CH, R = (n) => rnd(1 + ci + ri * ATLAS_N, n);
    // faint per-cell plaster shift — variants differ even before tinting
    g.fillStyle = `rgba(${205 + R(0) * 30 | 0},${200 + R(1) * 28 | 0},${188 + R(2) * 26 | 0},0.5)`;
    g.fillRect(X, Y, CW, CH);
    if (ci === 0 && ri === 0) continue;               // plain plaster stays plain
    if (ci === 1 && ri === 0) {                       // storefront: fascia + glazing run
      g.fillStyle = '#4a4640'; g.fillRect(X + 6, Y + 30, CW - 12, 34);
      g.fillStyle = '#2c3138'; g.fillRect(X + 6, Y + 72, CW - 12, CH - 96);
      g.fillStyle = '#8a857c';
      for (let b = 1; b < BAYS; b++) g.fillRect(X + b * BAY - 1, Y + 72, 2, CH - 96);
      continue;
    }
    if (ci === 2 && ri === 0) {                       // panel joints, then normal windows
      g.fillStyle = '#b3b3ac';
      g.fillRect(X, Y, 3, CH); g.fillRect(X + CW - 3, Y, 3, CH); g.fillRect(X, Y, CW, 3);
    }
    // a band of BAYS windows; texel density is anisotropic (12 px/m across,
    // 88 px/m up) but the quad mapping stretches it back to true aspect
    const ww = 10 + R(3) * 8, wh = 90 + R(4) * 70, wy = Y + 60 + R(5) * 50;
    for (let b = 0; b < BAYS; b++) {
      const wx = X + b * BAY + (BAY - ww) / 2, s = R(10 + b);
      g.fillStyle = s < 0.14 ? '#b9a878' : s < 0.28 ? '#7d838c'
        : `rgb(${46 + R(20 + b) * 16 | 0},${52 + R(21 + b) * 16 | 0},${62 + R(22 + b) * 16 | 0})`;
      g.fillRect(wx, wy, ww, wh);                     // glass: lit / hazy / dark variation
      if (s >= 0.28 && s < 0.45) {                    // curtain: lighter upper half
        g.fillStyle = 'rgba(214,209,199,0.55)';
        g.fillRect(wx, wy, ww, wh * 0.45);
      }
      g.fillStyle = '#c8c3b8';
      g.fillRect(wx - 2, wy + wh, ww + 4, 5);         // sill
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
    for (let s = 0; s < P.storeys; s++) {
      const yB = P.y0 + s * P.sH, yT = P.y0 + (s + 1) * P.sH;
      const kB = WALL_AO + (1 - WALL_AO) * Math.min(1, (yB - P.y0) / aoH);
      const kT = WALL_AO + (1 - WALL_AO) * Math.min(1, (yT - P.y0) / aoH);
      const cell = s === 0 && P.storeC ? P.storeC : P.cellA;
      for (let b0 = 0; b0 < cols; b0 += BAYS) {
        const b1 = Math.min(cols, b0 + BAYS), t0 = b0 * bayW / L, t1 = b1 * bayW / L;
        sink.wallUV(ax + ex * t0, az + ez * t0, ax + ex * t1, az + ez * t1, yB, yT, fx, fz,
          cell[0], cell[1], cell[0] + (b1 - b0) / BAYS / ATLAS_N, cell[3],
          P.wr * kB, P.wg * kB, P.wb * kB, P.wr * kT, P.wg * kT, P.wb * kT);
      }
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
    const a = all[ia], b = all[ib], c = all[ic];
    const cross = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (up === cross > 0) sink.tri(a.x, y, a.y, c.x, y, c.y, b.x, y, b.y, r, g, b);
    else sink.tri(a.x, y, a.y, b.x, y, b.y, c.x, y, c.y, r, g, b);
  }
}

function buildingInto(f, geos, sink, facades) {
  if (!f.o || f.o.length < 3) return;
  const y0 = f.y ?? 0;
  const depth = Math.max(1, Math.max(2.2, f.h ?? 6) - y0); // h is total height; skyways start at y0
  // wall color: explicit OSM colour wins, else palette by type; unnamed stock
  // gets a light tint jitter so shared footprints don't read as copy-paste —
  // NAMED landmarks keep the pure palette hue so they pop
  const pal = BUILDING_PALETTES[f.t] ?? BUILDING_PALETTES.default;
  const hex = f.c ? parseInt(f.c.slice(1), 16) : pal[Math.floor(rnd(f._id, 0) * pal.length)];
  _c.setHex(hex);
  if (!f.n) _c.offsetHSL((rnd(f._id, 1) - 0.5) * 0.02, -0.06 * rnd(f._id, 2), (rnd(f._id, 3) - 0.5) * 0.07);
  const wr = _c.r, wg = _c.g, wb = _c.b;
  const rr = wr * ROOF_DARKEN, rg = wg * ROOF_DARKEN, rb = wb * ROOF_DARKEN;

  if (facades) {
    // storey count prefers the RÚIAN level tag; the variant cell hashes the
    // building type (neighbourhoods stay coherent) with a pinch of _id so
    // twin rows don't read as photocopies
    const storeys = Math.max(1, Math.min(60, Math.round(f.lv ?? depth / STOREY_H)));
    const P = {
      y0, top: y0 + depth, sH: depth / storeys, storeys, wr, wg, wb,
      cellA: f.t === 'panel' ? PANEL_CELL : GENERIC[(hashStr(f.t ?? '') + f._id % 5) % GENERIC.length],
      storeC: STORE_TYPES.has(f.t) ? STORE_CELL : null,
    };
    ringFacade(sink, f.o, false, P);
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
  // small gabled houses get a ridge prism — in facade mode its tris pin to
  // the plain plaster cell, so it reads as flat color either way
  if (f.r === 'gabled' && Math.abs(polygonArea(f.o)) < 300)
    ridgePrism(sink, f.o, y0 + depth, rr, rg, rb);
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

// ---- trees: shared low-poly template, CLONED per chunk (chunk unload
// disposes geometries; a shared template would lose its GPU buffers) ----
let _tTrunk = null, _tCrown = null;
function treeTemplates() {
  if (!_tTrunk) {
    _tTrunk = new THREE.CylinderGeometry(0.09, 0.15, 1.9, 5, 1).translate(0, 0.95, 0);
    _tCrown = new THREE.IcosahedronGeometry(1.4, 0).scale(1, 0.95, 1).translate(0, 2.6, 0);
  }
  return [_tTrunk.clone(), _tCrown.clone()];
}

// ---- the chunk builder ----
export function buildChunkMeshes(city, cx, cz, mats) {
  const key = cx + ',' + cz;
  const cell = city.chunkIndex.get(key);
  if (!cell) return null;                       // outside the mapped city
  const group = new THREE.Group();
  group.name = 'chunk:' + key;
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const flat = [], sink = new TriSink();

  // -- water first: it decides the holes the ground must be carved with --
  const holes = [];
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
      if (holes.length) carveOrtho(orthoGround, x0, z0, x1, z1, holes);
      orthoGround.receiveShadow = true;
      group.add(orthoGround);
    } else {
      const g = shapePoly([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes, 0, COLORS.groundBase);
      if (g) flat.push(g);
    }
  }

  // -- green/paved fills: only on the flat ground — the photo already shows
  // every lawn and parking lot, painting solid color on top would undo it --
  if (!orthoGround) {
    const polyKinds = [
      [cell.green, LAYER_Y.green, (f) => COLORS.green[f.t] ?? COLORS.green.grass],
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
  const facades = !!mats.facades;
  const bGeos = [], bSink = new TriSink(facades);
  for (const f of cell.buildings) if (f._home === key) buildingInto(f, bGeos, bSink, facades);
  const pg = bSink.geo();
  if (pg) bGeos.push(pg);
  if (bGeos.length) {
    const mat = facades
      ? (mats._facadeMat ??= new THREE.MeshLambertMaterial({ vertexColors: true, map: facadeAtlas() }))
      : mats.building;
    const m = new THREE.Mesh(mergeGeometries(bGeos, false), mat);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  // -- trees: two InstancedMeshes (trunks / crowns) sharing transforms --
  // (settings can switch street trees off entirely — mats.trees === false)
  const trees = mats.trees === false ? [] : cell.trees.filter((t) => t._home === key);
  if (trees.length) {
    const [tg, cg] = treeTemplates();
    const trunk = new THREE.InstancedMesh(tg, mats.trunk, trees.length);
    const crown = new THREE.InstancedMesh(cg, mats.crown, trees.length);
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i], [x, z] = t.p[0];
      const s = 0.75 + rnd(t._id, 4) * 0.6;     // 3–5.5 m street trees
      _v.set(x, 0, z);
      _q.setFromAxisAngle(_up, rnd(t._id, 5) * Math.PI * 2);
      _s.set(s, s * (0.85 + rnd(t._id, 6) * 0.4), s);
      _m4.compose(_v, _q, _s);
      trunk.setMatrixAt(i, _m4);
      crown.setMatrixAt(i, _m4);
      _c.setHex(COLORS.treeCrown[t._id % COLORS.treeCrown.length]);
      _c.offsetHSL(0, 0, (rnd(t._id, 7) - 0.5) * 0.08);
      crown.setColorAt(i, _c);
    }
    // instance matrices live in world space — recompute bounds or the whole
    // batch frustum-culls against the template's origin-sized sphere
    trunk.computeBoundingSphere(); crown.computeBoundingSphere();
    trunk.castShadow = trunk.receiveShadow = true;
    crown.castShadow = crown.receiveShadow = true;
    group.add(trunk, crown);
  }
  return group;
}
