// ---- mwdress.js: the D11's barriers, drawn into a chunk ----
// The mesher's half of js/mwplan.js: meshes.js buildChunkMeshesGen calls
// motorwayDressInto once per 'full' chunk and this writes the plan's runs into
// the chunk's casting sink (the same TriSink as kerbs and fences), at their
// absolute heights. Worker safe: no three, no DOM (the colours are converted
// to linear here by hand, as THREE.Color.setHex would).
//
// Budget (the round 8 brief: about +4k vertices a 120 m chunk of dual
// carriageway): a station piece is 4 m; a median half is 6 quads (four
// profile faces, the centre face, the median surface), a steel rail 5 (two
// W-beam faces, its back, a post's face and side). 30 pieces a side a chunk:
// 2 x 30 x 6 x 6 + 2 x 30 x 5 x 6 = 3 960 vertices.

import { SURF } from './surfaces.js';
import { COLORS } from './config.js';
import { barrierPlan, K_MEDIAN, K_RAIL, MEDIAN_H, RAIL_H, STRIDE, DELIN_STEP } from './mwplan.js';

const lin = (hex) => {
  const f = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
};
// weathered precast concrete; galvanised steel, its posts a shade darker
const CONCRETE = lin(0xb3afa5), CONCRETE_SH = lin(0x9d998f);
const STEEL = lin(0xa9aeb3), STEEL_SH = lin(0x8a8f94), POST = lin(0x7f8489);
let ASPHALT = null;

// The New Jersey half profile, [offset toward the road from the barrier's
// centre, height over the deck]: a foot buried 8 cm, the 7.5 cm kerb step,
// the steep lower slope that lifts a wheel, the upper face, the 15 cm top.
const NJ = [[0.31, -0.08], [0.30, 0.075], [0.20, 0.33], [0.075, MEDIAN_H], [0, MEDIAN_H]];
// W-beam: [offset toward the road from the rail line, height], two faces
// folded outward at mid height so the light breaks across the beam
const WB = [[0, RAIL_H - 0.31], [0.06, RAIL_H - 0.155], [0, RAIL_H]];
const POST_W = 0.1, POST_BACK = 0.12;     // a C post 10 cm wide, behind the beam

// quad a b c d (a loop) with its face turned toward (fx, fy, fz)
function quadToward(sink, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, fx, fy, fz, col) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * fx + ny * fy + nz * fz >= 0) sink.quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, col[0], col[1], col[2]);
  else sink.quad(dx, dy, dz, cx, cy, cz, bx, by, bz, ax, ay, az, col[0], col[1], col[2]);
}

function medianPiece(sink, v, a, b, startCap, endCap) {
  const ax = v[a], az = v[a + 1], ay = v[a + 2], anx = v[a + 3], anz = v[a + 4], aw = v[a + 5];
  const bx = v[b], bz = v[b + 1], by = v[b + 2], bnx = v[b + 3], bnz = v[b + 4], bw = v[b + 5];
  const tx = bx - ax, tz = bz - az;
  sink.at(SURF.concrete);
  for (let k = 0; k < NJ.length - 1; k++) {
    const [o0, h0] = NJ[k], [o1, h1] = NJ[k + 1];
    // outward: toward the road and up (the face's own slope decides the mix)
    const fy = (o0 - o1) / (Math.abs(h1 - h0) + Math.abs(o0 - o1) + 1e-6);
    quadToward(sink,
      ax + anx * o0, ay + h0, az + anz * o0, bx + bnx * o0, by + h0, bz + bnz * o0,
      bx + bnx * o1, by + h1, bz + bnz * o1, ax + anx * o1, ay + h1, az + anz * o1,
      (anx + bnx) / 2, fy, (anz + bnz) / 2, k === NJ.length - 2 ? CONCRETE : k === 0 ? CONCRETE_SH : CONCRETE);
  }
  // the centre face, toward the other carriageway: where the two decks are
  // not level the higher half's top shows a concrete step, never daylight
  quadToward(sink, ax, ay + MEDIAN_H, az, bx, by + MEDIAN_H, bz, bx, by + 0.25, bz, ax, ay + 0.25, az,
    -anx, 0, -anz, CONCRETE_SH);
  // a gap in the barrier (a median crossing, the carriageways parting): the
  // block's end face
  for (const [cap, X, Y, Z, nx, nz, sgn] of [[startCap, ax, ay, az, anx, anz, -1], [endCap, bx, by, bz, bnx, bnz, 1]]) {
    if (!cap) continue;
    quadToward(sink, X, Y - 0.08, Z, X + nx * 0.31, Y - 0.08, Z + nz * 0.31,
      X + nx * 0.075, Y + MEDIAN_H, Z + nz * 0.075, X, Y + MEDIAN_H, Z, tx * sgn, 0, tz * sgn, CONCRETE_SH);
  }
  // the median surface from the barrier's foot to the inner edge line, a
  // hair over both ribbons (on half the D11 they overlap here and fight)
  if (aw > 0.4 && bw > 0.4) {
    sink.at(SURF.asphalt);
    const y0 = ay + 0.006, y1 = by + 0.006;
    quadToward(sink, ax + anx * 0.29, y0, az + anz * 0.29, bx + bnx * 0.29, y1, bz + bnz * 0.29,
      bx + bnx * bw, y1, bz + bnz * bw, ax + anx * aw, y0, az + anz * aw, 0, 1, 0, ASPHALT);
  }
}

function railPiece(sink, v, a, b, ramp0, ramp1, terrain) {
  const ax = v[a], az = v[a + 1], ay = v[a + 2], anx = v[a + 3], anz = v[a + 4];
  const bx = v[b], bz = v[b + 1], by = v[b + 2], bnx = v[b + 3], bnz = v[b + 4];
  sink.at(SURF.concrete);
  // a run's first and last piece bend the beam down into the ground (the
  // turned-down terminal every Czech rail run starts and ends with)
  const da = ramp0 ? -RAIL_H + 0.05 : 0, db = ramp1 ? -RAIL_H + 0.05 : 0;
  for (let k = 0; k < WB.length - 1; k++) {
    const [o0, h0] = WB[k], [o1, h1] = WB[k + 1];
    quadToward(sink,
      ax + anx * o0, ay + h0 + da, az + anz * o0, bx + bnx * o0, by + h0 + db, bz + bnz * o0,
      bx + bnx * o1, by + h1 + db, bz + bnz * o1, ax + anx * o1, ay + h1 + da, az + anz * o1,
      (anx + bnx) / 2, k ? 0.5 : -0.5, (anz + bnz) / 2, k ? STEEL : STEEL_SH);
  }
  // the back of the beam (seen from the field, and from the far carriageway)
  quadToward(sink, ax - anx * 0.03, ay + WB[0][1] + da, az - anz * 0.03, bx - bnx * 0.03, by + WB[0][1] + db, bz - bnz * 0.03,
    bx - bnx * 0.03, by + RAIL_H + db, bz - bnz * 0.03, ax - anx * 0.03, ay + RAIL_H + da, az - anz * 0.03,
    -anx, 0, -anz, STEEL_SH);
  // the post at the piece's start, standing on whatever is lower: the deck's
  // level or the embankment the rail stands over
  if (!ramp0) {
    const px = ax - anx * POST_BACK, pz = az - anz * POST_BACK;
    // (on a deck the post is bolted to the kerb: never down to the valley floor)
    const g = v[a + 5] ? ay - 0.02 : Math.min(terrain.heightAt(px, pz), ay) - 0.15, top = ay + RAIL_H - 0.04;
    const tx = bx - ax, tz = bz - az, tl = Math.hypot(tx, tz) || 1, ux = tx / tl * POST_W / 2, uz = tz / tl * POST_W / 2;
    quadToward(sink, px - ux, g, pz - uz, px + ux, g, pz + uz, px + ux, top, pz + uz, px - ux, top, pz - uz,
      anx, 0, anz, POST);
    quadToward(sink, px + ux, g, pz + uz, px + ux - anx * POST_W, g, pz + uz - anz * POST_W,
      px + ux - anx * POST_W, top, pz + uz - anz * POST_W, px + ux, top, pz + uz, ux, 0, uz, POST);
  }
}

// ---- delineators (směrové sloupky) ----
// Every DELIN_STEP m of the way: on a guard rail the white delineator head
// clipped to the post, its black band and the reflector facing the driver
// who comes up to it (amber on the right, Z 11a; white on the left, Z 11b);
// on the median barrier a reflector plate standing on its top.
const WHITE = lin(0xe9e7e1), BLACK = lin(0x1b1c1e), AMBER = lin(0xf08a12), REFL_W = lin(0xf4f4f0);
function delineator(sink, v, a, sd, kind) {
  const x = v[a], z = v[a + 1], y = v[a + 2], nx = v[a + 3], nz = v[a + 4];
  // the direction of travel this barrier serves: n is toward the road
  const tx = sd > 0 ? -nz : nz, tz = sd > 0 ? nx : -nx;
  sink.at(SURF.paint);
  if (kind === K_RAIL) {
    // on the post, which stands POST_BACK behind the beam
    const px = x - nx * POST_BACK, pz = z - nz * POST_BACK;
    const y0 = y + RAIL_H - 0.05, y1 = y + RAIL_H + 0.3, hw = 0.06, hd = 0.07;
    const A = [px - tx * hd - nx * hw, pz - tz * hd - nz * hw], B = [px - tx * hd + nx * hw, pz - tz * hd + nz * hw];
    const C = [px + tx * hd + nx * hw, pz + tz * hd + nz * hw];
    // the face the driver sees, the side toward the road, the black band
    quadToward(sink, A[0], y0, A[1], B[0], y0, B[1], B[0], y1, B[1], A[0], y1, A[1], -tx, 0, -tz, WHITE);
    quadToward(sink, B[0], y0, B[1], C[0], y0, C[1], C[0], y1, C[1], B[0], y1, B[1], nx, 0, nz, WHITE);
    const o = -0.004, e0x = A[0] - tx * -o, e0z = A[1] - tz * -o, e1x = B[0] - tx * -o, e1z = B[1] - tz * -o;
    quadToward(sink, e0x, y1 - 0.12, e0z, e1x, y1 - 0.12, e1z, e1x, y1 - 0.02, e1z, e0x, y1 - 0.02, e0z, -tx, 0, -tz, BLACK);
    const r0 = 0.025, rc = sd > 0 ? AMBER : REFL_W;
    const m0x = e0x + (e1x - e0x) * 0.25, m0z = e0z + (e1z - e0z) * 0.25, m1x = e0x + (e1x - e0x) * 0.75, m1z = e0z + (e1z - e0z) * 0.75;
    quadToward(sink, m0x - tx * 0.002, y1 - 0.1 + r0 * 0.4, m0z - tz * 0.002, m1x - tx * 0.002, y1 - 0.1 + r0 * 0.4, m1z - tz * 0.002,
      m1x - tx * 0.002, y1 - 0.04, m1z - tz * 0.002, m0x - tx * 0.002, y1 - 0.04, m0z - tz * 0.002, -tx, 0, -tz, rc);
  } else {
    // a plate on the barrier's top, on our half
    const px = x + nx * 0.04, pz = z + nz * 0.04, y0 = y + MEDIAN_H, y1 = y0 + 0.22, hw = 0.05;
    quadToward(sink, px - nx * hw, y0, pz - nz * hw, px + nx * hw, y0, pz + nz * hw,
      px + nx * hw, y1, pz + nz * hw, px - nx * hw, y1, pz - nz * hw, -tx, 0, -tz, BLACK);
    const q0 = 0.03;
    quadToward(sink, px - nx * q0 - tx * 0.003, y1 - 0.09, pz - nz * q0 - tz * 0.003, px + nx * q0 - tx * 0.003, y1 - 0.09, pz + nz * q0 - tz * 0.003,
      px + nx * q0 - tx * 0.003, y1 - 0.03, pz + nz * q0 - tz * 0.003, px - nx * q0 - tx * 0.003, y1 - 0.03, pz - nz * q0 - tz * 0.003, -tx, 0, -tz, REFL_W);
  }
}

/**
 * Draw the D11's median barriers and guard rails that this chunk owns.
 * Returns the vertices written (for the budget checks in the tests).
 */
export function motorwayDressInto(sink, cell, key, terrain) {
  if (!terrain || !cell?.roads) return 0;
  const plan = barrierPlan(cell, key, terrain, 0);
  if (!plan.length) return 0;
  ASPHALT ??= lin(COLORS.road.motorway ?? 0x55585c);
  const v0 = sink.pos.length;
  const mark = sink.mark();
  for (const run of plan) {
    const v = run.v, n = v.length / STRIDE;
    for (let i = 0; i < n - 1; i++) {
      const a = i * STRIDE, b = a + STRIDE;
      const first = i === 0 && (run.ends & 1), last = i === n - 2 && (run.ends & 2);
      if (run.k === K_MEDIAN) medianPiece(sink, v, a, b, first, last);
      else if (run.k === K_RAIL) railPiece(sink, v, a, b, first, last, terrain);
      if (!first && Math.round(v[a + 6]) % DELIN_STEP === 0) delineator(sink, v, a, run.sd, run.k);
    }
  }
  sink.fixFrom(mark);
  return (sink.pos.length - v0) / 3;
}
