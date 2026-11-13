// ---- treepits.js: the square of earth a street tree grows out of -------------
// A trunk that goes straight into paving looks pasted on, because no tree
// grows that way: a street tree stands in a pit, a square of soil let into the
// pavement with a kerbstone frame round it. This emits one under EVERY tree
// that stands on something paved: the pavement band of a kerbed street
// (js/streets.js says where that is and how high), a square, platform or car
// park polygon, or one of the sealed plates the chunk lays where nothing is
// mapped. Mapped or scattered makes no difference: round the station
// a quarter of the trees nobody mapped stand in paving, the planes on the
// forecourt among them. A tree in grass or leaf litter gets none, nor does a
// shrub.
//
// In the worker import graph: plain numbers into the chunk's flat sink.

import * as THREE from 'three';
import { LAYER_Y } from './config.js';
import { roadGradeY, streetOf, pointInPolygon } from './geo.js';
import { vergeAt, vergeLift, inZone, bayAt } from './streets.js';
import { SURF } from './surfaces.js';

const HALF = 0.78;          // half the side of a pit under a young tree, m
const HALF_MAX = 1.5;       // ...and under the biggest plane
const ROOT = 1.7;           // the near model's root flare, in trunk radii (treemodels.js)
const FRAME = 0.09;         // width of the kerbstone frame
const REACH = 30;           // m: a road further off than this decides nothing here
// Over the paving it is let into. Not a free offset: the soil sits 3 cm over the
// pavement and the frame 2 cm over that, so the three resolve at any range a
// pit a metre and a half across can be seen from.
const SOIL_UP = 0.03, FRAME_UP = 0.05;

// What a cell.paved polygon is actually surfaced with, as js/meshes.js
// surfOfPaved draws it: a surveyed surface tag wins, and an untagged `yard`
// (landuse railway or industrial) is loose gravel. A pit is a hole let into
// SEALED ground, so the loose ones get none.
const LOOSE = { gravel: 1, dirt: 1, grass: 1 };
const SEALED = { asphalt: 1, concrete: 1, paving: 1, cobble: 1 };
const loose = (f) => LOOSE[f.s] || (f.t === 'yard' && !SEALED[f.s]);
/** Is (x, z) on the polygon: inside its outline and in none of its holes. */
function onPoly(f, x, z) {
  if (!f.o || f.o.length < 3 || !pointInPolygon(x, z, f.o)) return false;
  for (const h of f.i ?? []) if (h.length >= 3 && pointInPolygon(x, z, h)) return false;
  return true;
}

const _c = new THREE.Color();
const _at = { y: 0, ax: 1, az: 0, half: HALF, lift: -1 };
// A road's bounding box, kept per road object: a wood chunk asks about several
// hundred trees, and walking every segment of every road for each is the whole
// cost. A WeakMap, not a field: the road records are also what the worker spec
// serialises.
const _box = new WeakMap();
function boxOf(r) {
  let b = _box.get(r);
  if (b) return b;
  b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of r.p) {
    if (q[0] < b[0]) b[0] = q[0]; if (q[1] < b[1]) b[1] = q[1];
    if (q[0] > b[2]) b[2] = q[0]; if (q[1] > b[3]) b[3] = q[1];
  }
  _box.set(r, b);
  return b;
}

/**
 * Is (x, z) on paving, and how high is it? Fills and returns the scratch
 * { y, ax, az, half, lift }: the paving's height, the direction the nearest
 * street runs (a pit is laid square to its street), the half-side of the
 * biggest pit there is room for (Infinity on a square), and how far over the
 * terrain the paving lies where it is draped on it (-1 on a pavement band,
 * which has a grade of its own). `plates` are the chunk's sealed rectangles
 * ({ x0, z0, x1, z1 }), if it laid any. Null on grass, on a carriageway, or
 * with no room.
 */
export function pavingUnder(cell, x, z, terrain, plates) {
  let y = -Infinity, half = Infinity, near = REACH, ax = 1, az = 0, onRoad = false, lift = -1;
  for (const r of cell.roads ?? []) {
    if (r.br || !r.d || !r.p || r.p.length < 2) continue;
    const hw = (r.w ?? 3) / 2, bb = boxOf(r);
    // (every test below needs the road within REACH: 12 m of verge past half a
    // carriageway and a bay is well inside it)
    if (x < bb[0] - REACH || x > bb[2] + REACH || z < bb[1] - REACH || z > bb[3] + REACH) continue;
    let run = 0, bd = Infinity, bs = 0, be = 1, dx = 1, dz = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const px = r.p[i][0], pz = r.p[i][1], ex = r.p[i + 1][0] - px, ez = r.p[i + 1][1] - pz;
      const L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
      let t = ((x - px) * ex + (z - pz) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (px + ex * t), z - (pz + ez * t));
      if (d < bd) { bd = d; bs = run + L * t; be = (x - px) * ez - (z - pz) * ex >= 0 ? 1 : -1; dx = ex / L; dz = ez / L; }
      run += L;
    }
    if (bd < near) { near = bd; ax = dx; az = dz; }
    const xo = bd - hw - bayAt(r, bs, be);
    if (xo < 0.25) { onRoad = true; continue; }
    if (!streetOf(r) || xo > 12 || inZone(r, bs)) continue;
    const v = vergeAt(r, bs, be > 0 ? 1 : 0);
    if (!v.u || v.t !== 1 || xo > v.w) continue;
    const gy = roadGradeY(r, bs, terrain);
    if (gy === null || gy === undefined) continue;
    const top = gy + LAYER_Y.road + vergeLift(v.w, v.drop, xo);
    if (top > y) { y = top; half = Math.min(xo - 0.2, v.w - xo - 0.08); }
  }
  if (onRoad) return null;
  if (y === -Infinity) {
    for (const f of cell.paved ?? []) {
      // Not a rail yard or a factory site: those are gravel (or nothing at all
      // under the aerial photo), and a kerbstone frame round every self-seeded
      // birch between the sidings is a street detail on waste ground. Skipped,
      // not final: a platform or a square lying inside the yard still counts.
      if (loose(f) || !onPoly(f, x, z)) continue;
      lift = LAYER_Y.paved; y = terrain.heightAt(x, z) + lift;
      break;
    }
  }
  if (y === -Infinity && plates) {
    for (const r of plates) {
      if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      // a mapped lawn or wood lies OVER the sealed layer: the tree is in grass
      let green = false;
      for (const f of cell.green ?? []) if (f.o && f.o.length >= 3 && pointInPolygon(x, z, f.o)) { green = true; break; }
      // ...and so does the gravel of a yard, seven centimetres over the plate.
      // A pit left on the plate there is not safely buried: the fill is draped
      // on its own triangles, and on the real ground a third of such pits came
      // up through the gravel. The map spoke, so the tree is in gravel.
      if (!green) for (const f of cell.paved ?? []) if (loose(f) && onPoly(f, x, z)) { green = true; break; }
      if (!green) { lift = LAYER_Y.inferred; y = terrain.heightAt(x, z) + lift; }
      break;
    }
  }
  if (y === -Infinity || half < 0.32) return null;
  _at.y = y; _at.ax = ax; _at.az = az; _at.half = half; _at.lift = lift;
  return _at;
}

/**
 * A pit under every tree of `trees` that stands on paving, into the flat sink.
 * `trees` is the chunk's own scatter list ({ x, z, bush, ... }) and `specOf(t)`
 * its js/treeshapes.js spec: the pit is cut to the trunk, so the root flare of
 * an old plane does not cover a pit sized for a sapling. Absolute heights.
 */
export function treePitsInto(sink, cell, trees, specOf, terrain, plates) {
  if (!terrain || !trees.length) return;
  const mark = sink.mark();
  for (const t of trees) {
    if (t.bush) continue;
    const x = t.x, z = t.z, at = pavingUnder(cell, x, z, terrain, plates);
    if (!at) continue;
    const { y, ax, az, lift } = at, bx = -az, bz = ax;
    const half = Math.min(at.half, Math.max(HALF, Math.min(HALF_MAX, specOf(t).rt * ROOT + 0.4)));
    // Draped paving follows the ground, so each corner asks the ground too: a
    // three metre pit laid level on a square that falls 3 % would be buried
    // along its uphill side.
    const P = (u, v) => {
      const px = x + ax * u + bx * v, pz = z + az * u + bz * v;
      return [px, pz, lift < 0 ? y : terrain.heightAt(px, pz) + lift];
    };
    const up = (a, b, c, d, o, r, g, bl) => {
      sink.triFacing(a[0], a[2] + o, a[1], b[0], b[2] + o, b[1], c[0], c[2] + o, c[1], 0, 1, 0, r, g, bl);
      sink.triFacing(a[0], a[2] + o, a[1], c[0], c[2] + o, c[1], d[0], d[2] + o, d[1], 0, 1, 0, r, g, bl);
    };
    const i = half - FRAME;
    sink.at(SURF.dirt);
    _c.setHex(0x5a4838);
    up(P(-i, -i), P(i, -i), P(i, i), P(-i, i), SOIL_UP, _c.r, _c.g, _c.b);
    sink.at(SURF.concrete);
    _c.setHex(0xa39f95);
    const r = _c.r, g = _c.g, b = _c.b, yf = FRAME_UP;
    up(P(-half, -half), P(half, -half), P(i, -i), P(-i, -i), yf, r, g, b);
    up(P(half, -half), P(half, half), P(i, i), P(i, -i), yf, r, g, b);
    up(P(half, half), P(-half, half), P(-i, i), P(i, i), yf, r, g, b);
    up(P(-half, half), P(-half, -half), P(-i, -i), P(-i, i), yf, r, g, b);
  }
  sink.fixFrom(mark);
}
