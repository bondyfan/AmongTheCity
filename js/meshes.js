// ---- Chunk mesh factory: the city's look, one merged mesh at a time ----
// buildChunkMeshes() turns one 120 m cell of the Pardubice data into as few
// Meshes as possible: ONE vertex-colored "flat" mesh (ground quad, green/
// paved/water polygons, road ribbons, rails, lane dashes), ONE building mesh
// (extruded footprints + gabled ridge prisms) and two InstancedMeshes for the
// trees. Features live in every cell their bbox touches, but render only in
// their _home chunk — the chunk of their first vertex — so nothing is built
// twice; polygons happily overhang the cell edge, the neighbour that shares
// them streams in together with this one. Everything is emitted in world
// coordinates (the whole city sits ≤ ~2 km from the origin, well inside
// float32 comfort), so the returned Group stays at the origin and no per-
// chunk transform ever touches the merged geometry.
//
// Color discipline: renderer output is sRGB with three's color management on,
// so every palette hex goes through Color.setHex() (sRGB → linear working
// space) BEFORE it lands in a vertex-color attribute — raw hex bytes in the
// attribute would render washed out.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { CHUNK, LAYER_Y, COLORS, BUILDING_PALETTES, ROOF_DARKEN, WALL_AO } from './config.js';
import { bridgeElevation, polygonArea } from './geo.js';

// geometry dimensions (meters) — construction sizes, not art direction, so
// they live here rather than in config
const CAP_SEGS = 8;                                  // endpoint disc fan
const DASH_LEN = 1.8, DASH_GAP = 2.6, DASH_HW = 0.09; // lane center dashes
const GAUGE_H = 1.435 / 2;                           // standard gauge, rail centerlines
const RAIL_HW = 0.09;                                // steel ribbon half-width — reads at chase-cam range
const SLEEPER_STEP = 0.8, SLEEPER_HL = 1.25, SLEEPER_HW = 0.12;
const SKIRT_DROP = 1.6;                              // bridge girder wall below the deck edge
const DASH_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const FOOT_CLASSES = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track']);

// module-level scratch — buildChunkMeshes is build-time, not per-frame, but
// the instancing loop still shouldn't churn allocations for 200 trees
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

export function makeMaterials() {
  return {
    // flat + building share the "merged vertex-color" recipe; Lambert keeps
    // the Woods' matte low-poly response under the ported sun
    flat: new THREE.MeshLambertMaterial({ vertexColors: true }),
    building: new THREE.MeshLambertMaterial({ vertexColors: true }),
    trunk: new THREE.MeshLambertMaterial({ color: COLORS.treeTrunk }),
    // crown color arrives per-instance (setColorAt), so the base stays white;
    // flat shading keeps the icosphere crowns crisply faceted
    crown: new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
  };
}

// ---- triangle sink: hand-built geometry (ribbons, rails, roof prisms) ----
// Non-indexed triangles with face normals derived from winding, so the
// normal always agrees with the culled front face — no accidental invisible
// road because a quad was fed clockwise.
class TriSink {
  constructor() { this.pos = []; this.nrm = []; this.col = []; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(r, g, b, r, g, b, r, g, b);
  }
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, r, g, b);
  }
  // tri that must face OUTWARD: g* is a rough outside direction; the winding
  // flips whenever the cross-product normal disagrees with it (roof prisms
  // are assembled from an OBB whose axis sign is arbitrary)
  triFacing(ax, ay, az, bx, by, bz, cx, cy, cz, gx, gy, gz, r, g, b) {
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nx * gx + ny * gy + nz * gz < 0) this.tri(ax, ay, az, cx, cy, cz, bx, by, bz, r, g, b);
    else this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
  }
  geo() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    return g;
  }
}

// ---- shared small helpers ----

// uniform-color a stock geometry and strip what mergeGeometries would trip on
// (uv sets present on Plane/Shape/Extrude but absent from TriSink output)
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
// rotateX(−π/2) shape-space (x, y) lands on world (x, z) with the face (and
// any extrusion) pointing UP — the one mapping where both winding and normal
// come out right without post-fixes
function ringShape(outer, holes) {
  const s = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes ?? []) if (h.length >= 3)
    s.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
}

// Polyline frame for ribbon extrusion: deduped points, cumulative distance,
// and a per-point miter perpendicular pre-scaled by 1/cos(halfTurn) (clamped
// so hairpins don't shoot kilometer spikes). Offsetting every cross-section
// by per[i]*halfWidth keeps ribbon edges parallel through bends — the classic
// miter join, no gaps, no overlap fans.
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
    let p1x = b[0] - a[0], p1z = b[1] - a[1];  // incoming dir (endpoint: copies the other)
    let p2x = c[0] - b[0], p2z = c[1] - b[1];
    if (i === 0) { p1x = p2x; p1z = p2z; }
    if (i === n - 1) { p2x = p1x; p2z = p1z; }
    const l1 = Math.hypot(p1x, p1z) || 1, l2 = Math.hypot(p2x, p2z) || 1;
    p1x /= l1; p1z /= l1; p2x /= l2; p2z /= l2;
    let mx = p1x + p2x, mz = p1z + p2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = p2x; mz = p2z; } else { mx /= ml; mz /= ml; } // 180° U-turn fallback
    const s = 1 / Math.max(0.35, mx * p2x + mz * p2z);
    per.push([mz * s, -mx * s]); // (dz,−dx): the perp whose +side quads wind CCW seen from above
  }
  return { q, along, per, len: along[n - 1] };
}

// point + direction at distance d along a frame (linear scan — build-time
// only, and ways are a handful of segments)
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

// flat disc fan — road endpoint cap so open way ends and T-junctions read
// round instead of chopped
function capDisc(sink, x, y, z, r, cr, cg, cb) {
  for (let k = 0; k < CAP_SEGS; k++) {
    const a0 = (k / CAP_SEGS) * Math.PI * 2, a1 = ((k + 1) / CAP_SEGS) * Math.PI * 2;
    sink.tri(x, y, z,
      x + Math.cos(a1) * r, y, z + Math.sin(a1) * r,
      x + Math.cos(a0) * r, y, z + Math.sin(a0) * r, cr, cg, cb);
  }
}

// ---- roads: mitered ribbon + caps + bridge skirts + center dashes ----
function roadRibbon(sink, f) {
  const fr = ribbonFrame(f.p);
  if (!fr) return;
  const { q, per, along, len } = fr;
  const hw = Math.max(0.8, (f.w ?? 3) / 2);
  const baseY = FOOT_CLASSES.has(f.t) ? LAYER_Y.footway : LAYER_Y.road;
  const elev = (d) => (f.br ? bridgeElevation(d, len) : 0);
  _c.setHex(COLORS.road[f.t] ?? COLORS.road.residential);
  const cr = _c.r, cg = _c.g, cb = _c.b;
  for (let i = 0; i < q.length - 1; i++) {
    const y0 = baseY + elev(along[i]), y1 = baseY + elev(along[i + 1]);
    const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
    const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
    sink.quad(
      ax - pax * hw, y0, az - paz * hw, bx - pbx * hw, y1, bz - pbz * hw,
      bx + pbx * hw, y1, bz + pbz * hw, ax + pax * hw, y0, az + paz * hw, cr, cg, cb);
    // bridge girder skirts: a darker wall dropping from each deck edge, both
    // windings so the bridge has a face from the river bank AND from below
    if (f.br && (y0 > baseY + 0.05 || y1 > baseY + 0.05)) {
      const b0 = Math.max(0.02, y0 - SKIRT_DROP), b1 = Math.max(0.02, y1 - SKIRT_DROP);
      const sr = cr * 0.72, sg = cg * 0.72, sb = cb * 0.72;
      for (const e of [-1, 1]) {
        const x0 = ax + pax * hw * e, z0 = az + paz * hw * e;
        const x1 = bx + pbx * hw * e, z1 = bz + pbz * hw * e;
        sink.quad(x0, y0, z0, x1, y1, z1, x1, b1, z1, x0, b0, z0, sr, sg, sb);
        sink.quad(x0, b0, z0, x1, b1, z1, x1, y1, z1, x0, y0, z0, sr, sg, sb);
      }
    }
  }
  capDisc(sink, q[0][0], baseY + elev(0), q[0][1], hw, cr, cg, cb);
  capDisc(sink, q[q.length - 1][0], baseY + elev(len), q[q.length - 1][1], hw, cr, cg, cb);
  // center dashes on wide drivable through-roads (no crossings in v1)
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
  // trams lie flush IN the street, so their steel rides at marking height on
  // top of the road ribbon and gets no sleepers; proper rail sits on its own
  // layer, steel nudged above the sleepers so neither z-fights the other
  const steelY = tram ? LAYER_Y.marking : LAYER_Y.rail + 0.04;
  const elev = (d) => (f.br ? bridgeElevation(d, len) : 0);
  _c.setHex(COLORS.rail);
  const cr = _c.r, cg = _c.g, cb = _c.b;
  for (const side of [-1, 1]) {
    // both edge offsets share the miter perp, so the gauge stays exact
    // through curves instead of pinching
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
      const ux = _WA.dx * SLEEPER_HW, uz = _WA.dz * SLEEPER_HW;   // along the track
      const px = _WA.dz * SLEEPER_HL, pz = -_WA.dx * SLEEPER_HL;  // across it
      sink.quad(
        _WA.x - ux - px, y, _WA.z - uz - pz, _WA.x + ux - px, y, _WA.z + uz - pz,
        _WA.x + ux + px, y, _WA.z + uz + pz, _WA.x - ux + px, y, _WA.z - uz + pz, sr, sg, sb);
    }
  }
}

// ---- buildings: extruded footprint with painted vertices + gabled ridge ----
function buildingInto(f, geos, sink) {
  if (!f.o || f.o.length < 3) return;
  const y0 = f.y ?? 0;
  const depth = Math.max(1, Math.max(2.2, f.h ?? 6) - y0); // h is total height; skyways start at y0
  const g = new THREE.ExtrudeGeometry(ringShape(f.o, f.i), { depth, bevelEnabled: false, steps: 1 });
  g.rotateX(-Math.PI / 2);           // shape-space +z (the extrusion) → world +y
  if (y0) g.translate(0, y0, 0);
  g.deleteAttribute('uv');
  // wall color: explicit OSM colour wins, else palette by type; unnamed stock
  // gets a light per-building tint jitter (and a touch less saturation) so
  // rows of shared footprints don't read as copy-paste — NAMED landmarks keep
  // the pure palette hue so they pop
  const pal = BUILDING_PALETTES[f.t] ?? BUILDING_PALETTES.default;
  const hex = f.c ? parseInt(f.c.slice(1), 16) : pal[Math.floor(rnd(f._id, 0) * pal.length)];
  _c.setHex(hex);
  if (!f.n) _c.offsetHSL((rnd(f._id, 1) - 0.5) * 0.02, -0.06 * rnd(f._id, 2), (rnd(f._id, 3) - 0.5) * 0.07);
  const wr = _c.r, wg = _c.g, wb = _c.b;
  const rr = wr * ROOF_DARKEN, rg = wg * ROOF_DARKEN, rb = wb * ROOF_DARKEN;
  const pos = g.attributes.position, nrm = g.attributes.normal, n = pos.count;
  const aoH = Math.min(4, depth);    // fake AO fades out within the first floor-ish
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
  // small gabled houses get a ridge prism on the flat cap — enough "roofness"
  // for suburbia without per-footprint straight-skeleton gymnastics
  if (f.r === 'gabled' && Math.abs(polygonArea(f.o)) < 300)
    ridgePrism(sink, f.o, y0 + depth, rr, rg, rb);
}

// OBB of the footprint (dominant axis = its longest edge), ridge along the
// long axis: two slopes + two gable triangles. The prism may overhang a non-
// rectangular footprint slightly — at < 300 m² nobody can tell from a car.
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
  const Ax = cx - ux * hl - vx * hw, Az = cz - uz * hl - vz * hw; // (−u,−v)
  const Bx = cx + ux * hl - vx * hw, Bz = cz + uz * hl - vz * hw; // (+u,−v)
  const Cx = cx + ux * hl + vx * hw, Cz = cz + uz * hl + vz * hw; // (+u,+v)
  const Dx = cx - ux * hl + vx * hw, Dz = cz - uz * hl + vz * hw; // (−u,+v)
  const R0x = cx - ux * hl, R0z = cz - uz * hl;                   // ridge ends
  const R1x = cx + ux * hl, R1z = cz + uz * hl;
  sink.triFacing(Ax, topY, Az, Bx, topY, Bz, R1x, ry, R1z, -vx, 0, -vz, r, g, b);
  sink.triFacing(Ax, topY, Az, R1x, ry, R1z, R0x, ry, R0z, -vx, 0, -vz, r, g, b);
  sink.triFacing(Cx, topY, Cz, Dx, topY, Dz, R0x, ry, R0z, vx, 0, vz, r, g, b);
  sink.triFacing(Cx, topY, Cz, R0x, ry, R0z, R1x, ry, R1z, vx, 0, vz, r, g, b);
  sink.triFacing(Bx, topY, Bz, Cx, topY, Cz, R1x, ry, R1z, ux, 0, uz, r, g, b);  // gables
  sink.triFacing(Dx, topY, Dz, Ax, topY, Az, R0x, ry, R0z, -ux, 0, -uz, r, g, b);
}

// ---- trees: shared low-poly template, instanced per chunk ----
// Templates are built once but CLONED per chunk: CityWorld disposes chunk
// geometries on unload, and a shared template would lose its GPU buffers for
// every other chunk still on screen.
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

  // -- flat mesh: base quad + area polys + road/rail ribbons, one geometry --
  const flat = [colorize(
    new THREE.PlaneGeometry(CHUNK, CHUNK).rotateX(-Math.PI / 2)
      .translate((cx + 0.5) * CHUNK, 0, (cz + 0.5) * CHUNK),
    COLORS.groundBase)];
  const polyKinds = [
    [cell.green, LAYER_Y.green, (f) => COLORS.green[f.t] ?? COLORS.green.grass],
    [cell.paved, LAYER_Y.paved, (f) => COLORS.paved[f.t] ?? COLORS.paved.plaza],
    [cell.water, LAYER_Y.water, () => COLORS.water],
  ];
  for (const [list, y, pick] of polyKinds) for (const f of list) {
    if (f._home !== key || f.o.length < 3) continue;
    const g = new THREE.ShapeGeometry(ringShape(f.o, f.i)).toNonIndexed();
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    flat.push(colorize(g, pick(f)));
  }
  const sink = new TriSink();
  for (const f of cell.roads) if (f._home === key) roadRibbon(sink, f);
  for (const f of cell.rails) if (f._home === key) railWay(sink, f);
  const sg = sink.geo();
  if (sg) flat.push(sg);
  const flatMesh = new THREE.Mesh(mergeGeometries(flat, false), mats.flat);
  flatMesh.receiveShadow = true;                // ground catches, never casts
  group.add(flatMesh);

  // -- buildings: extrudes + roof prisms merged into one casting mesh --
  const bGeos = [], bSink = new TriSink();
  for (const f of cell.buildings) if (f._home === key) buildingInto(f, bGeos, bSink);
  const pg = bSink.geo();
  if (pg) bGeos.push(pg);
  if (bGeos.length) {
    const m = new THREE.Mesh(mergeGeometries(bGeos, false), mats.building);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  // -- trees: two InstancedMeshes (trunks / crowns) sharing transforms --
  const trees = cell.trees.filter((t) => t._home === key);
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
