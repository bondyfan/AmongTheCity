// ---- landmarks-passage.js: a way through a building ----
// WORKER SAFE. The chateau is entered twice: through the gate in the rampart
// and through the portal of the palace into its courtyard. Both passages climb
// (the ground rises two metres through each), and the palace one meets a front
// that stands eight degrees skew to it, so the straight level tunnel of the
// town gates (Frame.tunnel) fits neither. This is the same vault with a floor
// that follows the ground and mouths cut to the walls they open in, plus the
// stone surround of a Renaissance portal and the cut that opens a footprint's
// collision along such a passage.

import * as THREE from 'three';
import { K } from './landmarkskit.js';
import { roadGradeY } from './geo.js';
import { LAYER_Y } from './config.js';

const N = 5;

// meshes.js FOOT_CLASSES: the ways whose deck is laid at footway height
const FOOT = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track']);
const _bb = new WeakMap();       // a way's bounding box, per way object (both threads)

// the photo quad's vertex pitch (js/ortho.js orthoQuad: CHUNK / 30 segments),
// on a lattice anchored to the world, since every chunk starts on a multiple of it
const PITCH = 4;

// How far the photo ground is lifted over the terrain at a vertex of its
// lattice: meshes.js clampUnderRoadsGen, for the flared corridors of the ground
// (a way's half width + 4.5 m, then 5 m more). Inside one the photo is capped
// 5 cm under the way's deck top and raised to an embankment 45 cm under it,
// both falling away at 55 % past the half width; the floor never beats a cap.
function photoLift(ways, t, x, z) {
  const ground = t.heightAt(x, z);
  let cap = Infinity, floor = -Infinity;
  for (const r of ways) {
    if (r.br || !r.p || r.p.length < 2) continue;
    const hw = (r.w ?? 3) / 2 + 4.5, reach = hw + 5;
    let bb = _bb.get(r);
    if (!bb) {
      bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const q of r.p) { bb[0] = Math.min(bb[0], q[0]); bb[1] = Math.min(bb[1], q[1]); bb[2] = Math.max(bb[2], q[0]); bb[3] = Math.max(bb[3], q[1]); }
      _bb.set(r, bb);
    }
    if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
    const lay = FOOT.has(r.t) ? LAYER_Y.footway : LAYER_Y.road;
    let s = 0;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, L = Math.sqrt(L2);
      if (L2 > 1e-9) {
        let u = ((x - a[0]) * ex + (z - a[1]) * ez) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const d = Math.hypot(x - a[0] - ex * u, z - a[1] - ez * u);
        if (d < reach) {
          const gy = roadGradeY(r, s + L * u, t);
          if (gy !== null && gy !== undefined) {
            const over = d > hw ? (d - hw) * 0.55 : 0, top = gy + lay;
            if (top - 0.05 + over < cap) cap = top - 0.05 + over;
            if (top - 0.45 - over > floor) floor = top - 0.45 - over;
          }
        }
      }
      s += L;
    }
  }
  let y = ground > cap ? cap : ground;
  const f2 = floor < cap ? floor : cap;
  if (y < f2) y = f2;
  // (where it dives under a way it is lower than the terrain: paving there
  // keeps its plain lift, over the photo all the same)
  return y > ground ? y - ground : 0;
}

/**
 * How high paving must lie at (x, z), in the model's heights, to be SEEN. The
 * photo ground is not draped on the terrain alone: near a way meshes.js lifts
 * it toward the way's levelled deck (photoLift). In the chateau's courtyard the
 * footway's deck stands up to 0.6 m over the terrain, so paving laid a hand
 * over the terrain lay UNDER the photo and the roofs' shadow in it showed
 * through in dark patches. So the paving takes the photo's lift as the photo
 * itself carries it, on its own triangles (PlaneGeometry splits each lattice
 * cell along the diagonal from its south-west to its north-east corner), and
 * lies `lift` over that. Away from every way it is `lift` over the terrain.
 * (Feet stand on the tile's own level, which the lift does not move: by the
 * courtyard's footway they stand in the paving, as they stood in the photo.)
 */
export function floorAt(kit, x, z, lift) {
  const y = kit.rel(x, z) + lift;
  const ways = kit.ways, t = kit.terrain;
  if (!ways || !ways.length || !t) return y;
  const x0 = Math.floor(x / PITCH) * PITCH, z0 = Math.floor(z / PITCH) * PITCH;
  const fx = (x - x0) / PITCH, fz = (z - z0) / PITCH;
  const lb = photoLift(ways, t, x0, z0 + PITCH), ld = photoLift(ways, t, x0 + PITCH, z0);
  const up = fx + fz <= 1
    ? (() => { const la = photoLift(ways, t, x0, z0); return la + (ld - la) * fx + (lb - la) * fz; })()
    : (() => { const lc = photoLift(ways, t, x0 + PITCH, z0 + PITCH); return lc + (lb - lc) * (1 - fx) + (ld - lc) * (1 - fz); })();
  return y + up;
}

/**
 * Two walls and a round vault along v, all facing inward.
 * @param o { uc, w, h, vL0, vR0, vL1, vR1, y0, y1, deep }: centre and clear
 *   width, height of the crown over the floor, where the left (uc - w/2) and
 *   the right wall begin and end in v, the floor at the v0 and the v1 mouth,
 *   and how far the walls go on under the floor.
 */
export function vault(kit, F, o) {
  const rad = o.w / 2, rise = Math.min(rad, o.h * 0.5), yS = o.h - rise, deep = o.deep ?? 1.5;
  const uL = o.uc - rad, uR = o.uc + rad;
  const vA = (u) => o.vL0 + (o.vR0 - o.vL0) * (u - uL) / o.w;
  const vB = (u) => o.vL1 + (o.vR1 - o.vL1) * (u - uL) / o.w;
  const [lx, lz] = F.dir(1, 0);
  kit.quad(F.P(uL, o.vL0, o.y0 - deep), F.P(uL, o.vL1, o.y1 - deep), F.P(uL, o.vL1, o.y1 + yS), F.P(uL, o.vL0, o.y0 + yS), lx, 0, lz);
  kit.quad(F.P(uR, o.vR0, o.y0 - deep), F.P(uR, o.vR1, o.y1 - deep), F.P(uR, o.vR1, o.y1 + yS), F.P(uR, o.vR0, o.y0 + yS), -lx, 0, -lz);
  const pt = (t) => { const a = t * Math.PI / 2; return [Math.cos(a) * rad, yS + rise * Math.sin(a)]; };
  for (const side of [-1, 1]) for (let i = 0; i < N; i++) {
    const p = pt(i / N), q = pt((i + 1) / N), up = o.uc + side * p[0], uq = o.uc + side * q[0];
    const [ix, iz] = F.dir(-side, 0);
    kit.quad(F.P(up, vA(up), o.y0 + p[1]), F.P(up, vB(up), o.y1 + p[1]),
      F.P(uq, vB(uq), o.y1 + q[1]), F.P(uq, vA(uq), o.y0 + q[1]), ix * 0.5, -1, iz * 0.5);
  }
}

/**
 * Paving along v, laid a hand over the ground it is walked on. The ground mesh
 * is drawn in 4 m facets, so the strip is cut every 2 m (keep it narrow: it is
 * one quad across) and lifted 7 cm: over the photo ground and the green fills,
 * under any paved area or footway the tile lays (config.js LAYER_Y), and never
 * a step.
 */
export function paving(kit, F, u0, u1, v0, v1, lift = 0.07) {
  const n = Math.max(1, Math.ceil(Math.abs(v1 - v0) / 2));
  const y = (u, v) => { const [x, z] = F.xz(u, v); return floorAt(kit, x, z, lift); };
  for (let i = 0; i < n; i++) {
    const a = v0 + (v1 - v0) * i / n, b = v0 + (v1 - v0) * (i + 1) / n;
    kit.quad(F.P(u0, a, y(u0, a)), F.P(u1, a, y(u1, a)), F.P(u1, b, y(u1, b)), F.P(u0, b, y(u0, b)), 0, 1, 0);
  }
}

// one ring clipped to the half plane a * x + b * z <= c (Sutherland-Hodgman)
function clipHalf(ring, a, b, c) {
  const out = [], n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/**
 * Paving over a whole ring (world [x, z]), laid on the ground as paving()
 * lays a strip: cut into `cell`-metre squares so it can follow the ground the
 * terrain mesh draws, each square's piece triangulated on its own, lifted
 * `lift` over the ground. For a courtyard the tile only half paves (its plaza
 * stops short of the walls, and the photo ground under the rest is the shadow
 * of the roofs round it).
 */
export function paveRing(kit, ring, lift = 0.07, cell = 2) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  // the grid is anchored to the world, so the same ring paves the same way whichever chunk asks
  for (let gx = Math.floor(x0 / cell) * cell; gx < x1; gx += cell) {
    const col = clipHalf(clipHalf(ring, -1, 0, -gx), 1, 0, gx + cell);
    if (col.length < 3) continue;
    for (let gz = Math.floor(z0 / cell) * cell; gz < z1; gz += cell) {
      const piece = clipHalf(clipHalf(col, 0, -1, -gz), 0, 1, gz + cell);
      if (piece.length < 3) continue;
      const v2 = piece.map((p) => new THREE.Vector2(p[0], p[1]));
      if (THREE.ShapeUtils.isClockWise(v2)) v2.reverse();
      const P = (i) => [v2[i].x, floorAt(kit, v2[i].x, v2[i].y, lift), v2[i].y];
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(v2, [])) kit.tri(P(i), P(j), P(k), 0, 1, 0);
    }
  }
}

/**
 * The stone frame of a round-headed portal: two pilasters, the archivolt, an
 * entablature and, with `arms`, the panel a coat of arms is carved in.
 * S is a frame whose origin lies in the wall under the middle of the opening.
 */
export function portal(kit, S, y0, w, h, hex, arms = false) {
  const r = w / 2, yS = y0 + h - r, t = 0.55, out = 0.16;
  kit.set(hex, K.stone);
  S.slab([[-r - t, y0 - 0.4], [-r, y0 - 0.4], [-r, yS], [-r - t, yS]], 0, out);
  S.slab([[r, y0 - 0.4], [r + t, y0 - 0.4], [r + t, yS], [r, yS]], 0, out);
  // the archivolt, as wedges so no polygon has to bend round the opening
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 8, b = (i + 1) * Math.PI / 8;
    S.slab([[Math.cos(a) * r, yS + Math.sin(a) * r], [Math.cos(a) * (r + t), yS + Math.sin(a) * (r + t)],
      [Math.cos(b) * (r + t), yS + Math.sin(b) * (r + t)], [Math.cos(b) * r, yS + Math.sin(b) * r]], 0, out);
  }
  const yT = y0 + h + t;
  S.slab([[-r - t - 0.25, yT + 0.1], [r + t + 0.25, yT + 0.1], [r + t + 0.25, yT + 0.5], [-r - t - 0.25, yT + 0.5]], 0, out + 0.12);
  if (!arms) return;
  S.slab([[-1.0, yT + 0.75], [1.0, yT + 0.75], [1.0, yT + 2.55], [-1.0, yT + 2.55]], 0, out * 0.7);
  // the bison's head of the Pernštejns, carved: a shade darker than the panel,
  // never a hole (the first cut, in a sandstone this dark, read as one)
  kit.set(0x968b78, K.stone);
  S.slab([[-0.5, yT + 1.05], [0.5, yT + 1.05], [0.7, yT + 1.8], [0.35, yT + 2.3], [-0.35, yT + 2.3], [-0.7, yT + 1.8]], out * 0.7, out * 0.7 + 0.06);
}

// where the line u = c (frame F) crosses a ring between v = va and v = vb
function crossing(ring, F, c, va, vb) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = F.local(ring[i][0], ring[i][1]), q = F.local(ring[(i + 1) % n][0], ring[(i + 1) % n][1]);
    if ((p[0] - c) * (q[0] - c) > 0 || p[0] === q[0]) continue;
    const t = (c - p[0]) / (q[0] - p[0]), v = p[1] + (q[1] - p[1]) * t;
    if (v < Math.min(va, vb) || v > Math.max(va, vb)) continue;
    return { i, t, pt: F.xz(c, v) };
  }
  return null;
}
// the ring from crossing a round to crossing b, the LONG way (the short way is the mouth)
function longArc(ring, a, b) {
  const n = ring.length, fwd = (b.i - a.i + n) % n, out = [a.pt];
  // (both on one edge: the long way is forward only if a lies past b on it)
  if (fwd > n / 2 || (!fwd && a.t > b.t)) for (let k = 1; k <= (fwd || n); k++) out.push(ring[(a.i + k) % n]);
  else for (let k = 0; k < n - fwd; k++) out.push(ring[(a.i - k + n) % n]);
  out.push(b.pt);
  return out;
}

/**
 * A footprint's collision with a passage cut through it: the outer ring and
 * the courtyard the passage leads into, joined along the passage's two walls
 * into one ring. (A passage cannot be a hole: it has no end walls, and every
 * edge of a hole pushes back.) Null when the outline does not offer the two
 * mouths, so the caller keeps the building whole rather than half open.
 * @param F frame the passage runs along v in, between u = uL and u = uR
 * @param vOut, vIn roughly where the outer wall and the courtyard wall are crossed
 */
export function cutPassage(outer, court, F, uL, uR, vOut, vIn, slack = 3) {
  const oL = crossing(outer, F, uL, vOut - slack, vOut + slack), oR = crossing(outer, F, uR, vOut - slack, vOut + slack);
  const cL = crossing(court, F, uL, vIn - slack, vIn + slack), cR = crossing(court, F, uR, vIn - slack, vIn + slack);
  if (!oL || !oR || !cL || !cR) return null;
  // round the outside from the right jamb to the left one, down the left wall,
  // round the courtyard to the right jamb, and back up the right wall
  return longArc(outer, oR, oL).concat(longArc(court, cL, cR));
}
