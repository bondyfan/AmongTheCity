// ---- birdperches.js: the places in one chunk of the map where a bird could sit --
// js/birdsites.js decides WHETHER a flock lives at a candidate; this finds the
// candidates. One call per streaming cell (js/config.js CHUNK), from data the
// main thread already holds, and every candidate is placed by the feature it
// sits on (a lamp, a sign, a way, a wall), never by the order things loaded in:
//
//   lamp   the arm of a street column, the hat of a park lantern (js/poles.js
//          knows every standing mast; a felled one drops out by itself)
//   sign   the top edge of a road sign (meshes.signPerches: the mesher's own plan)
//   wire   the trolley wire, a few metres of it every so often
//   roof   the eave or the parapet of a building, along one of its walls
//   ground a patch of footway, square or quiet street, the pavement beside
//          a street; in open country a field
//
// Three-free and DOM-free; it reads the world through the small `env` it is
// handed, so a test can stand in a plain object for the city.

import { CHUNK } from './config.js';
import { chunkKey, pointInPolygon } from './geo.js';
import { groundFor } from './terrain.js';
import { landmarkSolids } from './landmarks.js';
import { classify } from './interiors.js';
import { typologyOf, roofOf, hasParapet, PARAPET_H } from './typology.js';
import { HEAD_OUT, HEAD_Y, PARK_Y } from './streetlamps.js';
import { KIND, hash32, rnd01, BIRD_SEED } from './birdsites.js';

const TW_H = 5.5, TW_GAP = 0.6;              // the trolley wire: meshes.js trolleyInto draws it there
const WALKED = new Set(['footway', 'pedestrian', 'path', 'living_street', 'track']);
const QUIET = new Set(['residential', 'service', 'unclassified']);
const GROUND_STEP = 34, ROAD_STEP = 70, WIRE_STEP = 26, ROOF_STEP = 30, KERB_STEP = 30;
// streets with a pavement a pigeon would stand on, and how far behind the kerb it stands
const STREET = new Set(['residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'living_street']);
const KERB_IN = 1.3;
const MAST_TOP = 6.1;                        // a trolley mast's top over its foot, where the mast cannot be asked

const q4 = (v) => Math.round(v * 4);

// metres from (x, z) to the nearest edge of ring `o`, or 0 inside it
function ringDist(o, x, z, cap) {
  if (pointInPolygon(x, z, o)) return 0;
  let best = cap;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const ax = o[j][0], az = o[j][1], ex = o[i][0] - ax, ez = o[i][1] - az;
    let t = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1e-9);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
    if (d < best) best = d;
  }
  return best;
}

// the box round a ring, worked out once and kept on it
function boxOf(f) {
  if (f._birdBox) return f._birdBox;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const q of f.o ?? []) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < z0) z0 = q[1]; if (q[1] > z1) z1 = q[1]; }
  return (f._birdBox = [x0, z0, x1, z1]);
}

/** Is open water within `r` metres of (x, z)? (the cell's own polygons; the Vltava lies in every cell it crosses) */
export function waterNear(cell, x, z, r = 70) {
  for (const w of cell?.water ?? []) {
    if (!w.o || w.o.length < 3) continue;
    const b = boxOf(w);
    if (x < b[0] - r || x > b[2] + r || z < b[1] - r || z > b[3] + r) continue;
    if (ringDist(w.o, x, z, r) < r) return true;
  }
  return false;
}

/**
 * The top of the building whose footprint holds (x, z), or 0 where the sky is
 * open. For a bird deciding which way is clear: world.roofY will not do, it
 * leaves out the near buildings whose rooms are built (they are the ones a
 * flock in front of the player is most likely to fly into).
 */
export function roofTopAt(city, terrain, x, z) {
  const cell = city?.chunkIndex?.get(chunkKey(x, z));
  let top = 0;
  for (const b of cell?.buildings ?? []) {
    if (!b.o || b.o.length < 3 || (b.y ?? 0) > 0.5) continue;
    const q = boxOf(b);
    if (x < q[0] || x > q[2] || z < q[1] || z > q[3] || !pointInPolygon(x, z, b.o)) continue;
    const t = (terrain ? groundFor(b, terrain) : 0) + Math.max(2.2, b.h ?? 6);
    if (t > top) top = t;
  }
  return top;
}

/** How built-up a cell is, 0 open country .. 1 a town centre. */
export const urbanOf = (cell) => Math.min(1, (cell?.buildings?.length ?? 0) / 18);

// every `step` metres of a way, counted from its first vertex, so each cell the
// way crosses finds the same points
function* alongWay(p, step, phase) {
  let run = 0, next = phase;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], ex = p[i + 1][0] - ax, ez = p[i + 1][1] - az, L = Math.hypot(ex, ez);
    if (L < 1e-6) continue;
    while (next <= run + L) {
      const t = (next - run) / L;
      yield [ax + ex * t, az + ez * t, ex / L, ez / L, i, t];
      next += step;
    }
    run += L;
  }
}

/**
 * Every candidate of chunk `key`.
 *   env { city, terrain, poles, signs(key) -> [[x, z, yTop, dx, dz]], sites (js/crowdsites.js SiteIndex or null),
 *         hidden: Set of wrecked building ids or null }
 * Returns { cands: [{ kind, x, z, y?, dx?, dz?, len?, water }], urban, poles: how many masts were seen }.
 */
export function chunkPerches(key, env) {
  const cell = env.city?.chunkIndex?.get(key), out = [];
  if (!cell) return { cands: out, urban: 0, poles: 0 };
  const urban = urbanOf(cell), terrain = env.terrain;
  const hasWater = (cell.water?.length ?? 0) > 0;
  const push = (c) => { c.water = hasWater && waterNear(cell, c.x, c.z); out.push(c); };
  const inside = (x, z) => chunkKey(x, z) === key;
  // (a box round each footprint first: a dense block is two hundred of them)
  const inBuilding = (x, z) => {
    for (const b of cell.buildings ?? []) {
      if (!b.o) continue;
      const q = boxOf(b);
      if (x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3] && pointInPolygon(x, z, b.o)) return true;
    }
    return false;
  };

  // on some OTHER carriageway of the cell? (a pavement spot beside one street can be the middle of the next)
  const onRoad = (x, z, self) => {
    for (const o of cell.roads ?? []) {
      if (o === self || !o.d || !o.p) continue;
      const half = (o.w ?? 3) / 2 + 0.4;
      for (let k = 0; k < o.p.length - 1; k++) {
        const ax = o.p[k][0], az = o.p[k][1], ex = o.p[k + 1][0] - ax, ez = o.p[k + 1][1] - az;
        let t = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1e-9);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - ax - ex * t, z - az - ez * t) < half) return true;
      }
    }
    return false;
  };

  // ---- lamps ----
  const [ci, cj] = key.split(',').map(Number);
  const cx = (ci + 0.5) * CHUNK, cz = (cj + 0.5) * CHUNK;
  let poles = 0;
  for (const p of env.poles?.near(cx, cz, CHUNK * 0.75) ?? []) {
    if (!inside(p.x, p.z)) continue;
    if (p.kind === 'street') {
      poles++;
      // the arm reaches toward the column's own -z: a row along it, short of the head
      const fx = -Math.sin(p.rot ?? 0), fz = -Math.cos(p.rot ?? 0), o = HEAD_OUT - 0.42;
      push({ kind: KIND.LAMP, x: p.x + fx * o, y: p.y + HEAD_Y + 0.145, z: p.z + fz * o, dx: fx, dz: fz, len: 0.62 });
    } else if (p.kind === 'park') {
      poles++;
      push({ kind: KIND.POST, x: p.x, y: p.y + PARK_Y + 0.215, z: p.z, dx: 1, dz: 0, len: 0 });
    } else if (p.kind === 'trolley') {
      // The top of a trolley mast. How tall it stands depends on the wire it
      // carries (meshes.trolleyMastInto), so the mast is asked: js/trolleymasts.js
      // hands js/poles.js the shape that falls over, built about its foot, and
      // the top of that is the top of the mast. Measured once and kept.
      poles++;
      if (p._birdTop === undefined) {
        const geo = p.look?.geo;
        geo?.computeBoundingBox?.();
        p._birdTop = geo?.boundingBox?.max?.y ?? MAST_TOP;
        geo?.dispose?.();
      }
      push({ kind: KIND.POST, x: p.x, y: p.y + p._birdTop + 0.005, z: p.z, dx: 1, dz: 0, len: 0 });
    }
  }

  // ---- road signs ----
  for (const s of env.signs?.(key) ?? []) {
    // along the plate, which stands across the travel it speaks to
    push({ kind: KIND.SIGN, x: s[0], y: s[2] + 0.005, z: s[1], dx: -s[4], dz: s[3], len: 0.34 });
  }

  for (const r of cell.roads ?? []) {
    if (!r.p || r.p.length < 2 || r.br || r.tu) continue;
    const rid = hash32(BIRD_SEED, q4(r.p[0][0]), q4(r.p[0][1]), q4(r.p[r.p.length - 1][0]), q4(r.p[r.p.length - 1][1]));
    // ---- the trolley wire ----
    if (r.tw && terrain) {
      const half = (r.w ?? 7) / 2, offs = half > 4.5 ? [-half * 0.5, half * 0.5] : [0];
      for (const [x, z, dx, dz, i, t] of alongWay(r.p, WIRE_STEP, rnd01(hash32(rid, 1)) * WIRE_STEP)) {
        const k = hash32(rid, q4(x), q4(z), 2);
        const c = offs[k % offs.length] + ((k >> 4) & 1 ? TW_GAP / 2 : -TW_GAP / 2);
        const wx = x - dz * c, wz = z + dx * c;
        if (!inside(wx, wz)) continue;
        // the wire is straight between the way's vertices, 5.5 m over the ground at each
        const a = r.p[i], b = r.p[i + 1];
        const y0 = terrain.heightAt(a[0] - dz * c, a[1] + dx * c), y1 = terrain.heightAt(b[0] - dz * c, b[1] + dx * c);
        push({ kind: KIND.WIRE, x: wx, y: y0 + (y1 - y0) * t + TW_H + 0.035, z: wz, dx, dz, len: 3.2 });
      }
    }
    // ---- the pavement beside a street: what somebody driving past sees ----
    // (both sides of a street; one side, further apart, of a service road)
    if (r.d && (STREET.has(r.t) || r.t === 'service')) {
      const street = STREET.has(r.t), off = (r.w ?? 6) / 2 + (street ? KERB_IN : 0.9), step = street ? KERB_STEP : KERB_STEP * 2;
      for (const [x, z, dx, dz] of alongWay(r.p, step, rnd01(hash32(rid, 5)) * step)) {
        const one = hash32(rid, q4(x), q4(z), 6) & 1 ? 1 : -1;
        for (const sd of street ? [1, -1] : [one]) {
          const gx = x - dz * off * sd, gz = z + dx * off * sd;
          if (!inside(gx, gz) || inBuilding(gx, gz) || onRoad(gx, gz, r)) continue;
          push({ kind: KIND.GROUND, x: gx, z: gz, kerb: true });
        }
      }
    }
    // ---- the ground: footways and squares, and the odd quiet street ----
    const walked = !r.d && WALKED.has(r.t), quiet = !!r.d && QUIET.has(r.t);
    if (!walked && !quiet) continue;
    const step = walked ? GROUND_STEP : ROAD_STEP, half = Math.max(0.4, (r.w ?? 2.4) / 2 - 0.5);
    for (const [x, z, dx, dz] of alongWay(r.p, step, rnd01(hash32(rid, 3)) * step)) {
      const side = (rnd01(hash32(rid, q4(x), q4(z), 4)) * 2 - 1) * Math.min(half, 1.6);
      const gx = x - dz * side, gz = z + dx * side;
      if (!inside(gx, gz) || inBuilding(gx, gz)) continue;
      push({ kind: KIND.GROUND, x: gx, z: gz, road: quiet });
    }
  }

  // ---- beside a bench, a stop, somewhere that sells food ----
  for (const s of env.sites?.near(cx, cz, CHUNK * 0.75) ?? []) {
    if (!inside(s.x, s.z) || s.kind > 4 || s.kind === 3) continue;        // (not shop windows, not zebras)
    const a = rnd01(hash32(BIRD_SEED, q4(s.x), q4(s.z), 5)) * 6.283, d = 1.7 + 1.4 * rnd01(hash32(BIRD_SEED, q4(s.x), q4(s.z), 6));
    const gx = s.x + Math.cos(a) * d, gz = s.z + Math.sin(a) * d;
    if (inside(gx, gz) && !inBuilding(gx, gz)) push({ kind: KIND.GROUND, x: gx, z: gz });
  }

  // ---- open country: a few places in the field itself ----
  if (urban < 0.2) {
    for (let k = 0; k < 4; k++) {
      const gx = (ci + rnd01(hash32(BIRD_SEED, ci, cj, k, 7))) * CHUNK, gz = (cj + rnd01(hash32(BIRD_SEED, ci, cj, k, 8))) * CHUNK;
      if (inBuilding(gx, gz) || (cell.water ?? []).some((w) => w.o && pointInPolygon(gx, gz, w.o))) continue;
      push({ kind: KIND.GROUND, x: gx, z: gz, field: true });
    }
  }

  // ---- roofs: the eave or the parapet, along a wall ----
  if (terrain) for (const b of cell.buildings ?? []) {
    const o = b.o;
    if (!o || o.length < 3 || (b.h ?? 6) < 4 || (b.y ?? 0) > 0.5 || landmarkSolids(b) || env.hidden?.has(b._id)) continue;
    const top = groundFor(b, terrain) + Math.max(2.2, b.h ?? 6);
    let par = null, run = 0;
    const bid = hash32(BIRD_SEED, q4(o[0][0]), q4(o[0][1]), o.length);
    let next = rnd01(hash32(bid, 1)) * ROOF_STEP;
    for (let i = 0; i < o.length; i++) {
      const a = o[i], c = o[(i + 1) % o.length];
      const ex = c[0] - a[0], ez = c[1] - a[1], L = Math.hypot(ex, ez);
      if (L < 1e-6) continue;
      if (next > run + L || L < 2.4) { if (next <= run + L) next = run + L + 1; run += L; continue; }
      const t = Math.max(1.2, Math.min(L - 1.2, next - run)), dx = ex / L, dz = ez / L;
      next += ROOF_STEP; run += L;
      let x = a[0] + dx * t, z = a[1] + dz * t;
      if (!inside(x, z)) continue;
      if (par === null) {
        // (worked out once per building, and only for one that gets a candidate)
        const typ = typologyOf(b, classify(b)), roof = roofOf(b, typ);
        let area = 0;
        for (let k = 0, j = o.length - 1; k < o.length; j = k++) area += o[j][0] * o[k][1] - o[k][0] * o[j][1];
        par = { flat: roof.shape === 'flat', up: hasParapet(typ, roof, Math.abs(area) / 2) ? PARAPET_H : 0 };
      }
      // a flat roof: a hand in from the wall, on the upstand where there is one;
      // a pitched one: on the gutter line itself
      const inset = par.flat ? 0.14 : 0.02;
      const sgn = pointInPolygon(x - dz * 0.3, z + dx * 0.3, o) ? 1 : -1;
      x += -dz * inset * sgn; z += dx * inset * sgn;
      push({ kind: KIND.ROOF, x, y: top + (par.flat ? par.up + 0.01 : 0.06), z, dx, dz, len: Math.min(L - 1.6, 3.6) });
    }
  }
  return { cands: out, urban, poles };
}
