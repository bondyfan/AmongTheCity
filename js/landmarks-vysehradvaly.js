// ---- landmarks-vysehradvaly.js: the ramparts of Vyšehrad ----
// WORKER SAFE (a footprint-less landmark, js/landmarks.js EXTRAS: built on
// both threads, each piece by the chunk that holds it).
//
// The Baroque citadel of 1650 to 1720: a ring of brick bastion walls round
// the top of the Vyšehrad rock, battered, with a stone cordon and a parapet
// the walk on top looks out over, its points jutting at every bastion. The
// tile has the ring as ONE citywall barrier (1914 m, 82 vertices), which the
// generic ribbon drew as a 4.5 m grey fence standing on the ground; here it is
// what the eye knows from the river and from Podskalí: a retaining wall whose
// height is the drop of the rock outside it.
//
// THE EARTH IS THE TERRAIN'S. Behind the wall the walk lies on the bank (the
// height field's own crest, taken 6 m inside); in front of it the wall goes
// down to the ground below, leaning out over the slope where the survey's
// 20 m cells have rounded the cliff off (section), and stands at least
// 3.5 m over the ground where they flatten it. Nothing here collides (no
// barrier does, js/city.js).

import { K } from './landmarkskit.js';

/** The ring as the tile has it (tile -20_-1, its one 82-vertex citywall, closed: the last vertex is the first). */
export const VALY_V = [[-95955.3, -3786.6], [-95954.6, -3749.6], [-95964.7, -3748], [-95956.5, -3692.2], [-95965.3, -3690.6], [-95948.6, -3644.1],
  [-95956, -3636.1], [-95948.3, -3620.5], [-95953.5, -3609.9], [-95959.7, -3610.6], [-95959.5, -3608.6], [-95970.2, -3589.1], [-95968.4, -3581.9],
  [-95971.9, -3582.6], [-95972, -3582], [-95968.4, -3581.1], [-95973.5, -3563.6], [-95980.9, -3563.2], [-95983.8, -3558.7], [-95990.9, -3536.3],
  [-95978.3, -3531], [-95978.6, -3530.2], [-95977.3, -3529.6], [-95976.8, -3530.5], [-95972, -3528.3], [-95972.3, -3527.4], [-95971, -3526.9],
  [-95970.5, -3527.7], [-95965.6, -3525.6], [-95966, -3524.8], [-95964.6, -3524.1], [-95964.2, -3525], [-95959.6, -3522.9], [-95959.9, -3522.1],
  [-95958.4, -3521.4], [-95958, -3522.2], [-95944, -3481.8], [-95944.5, -3481.1], [-95942.7, -3476.9], [-95945.2, -3476.3], [-95937.1, -3456.2],
  [-95847.3, -3467.5], [-95838.2, -3503.3], [-95706.5, -3469.2], [-95715.4, -3433.3], [-95634, -3379.7], [-95609.7, -3445.7], [-95631.2, -3463.6],
  [-95614.3, -3483.7], [-95609.4, -3492], [-95599.6, -3503.5], [-95590.3, -3511.6], [-95575.1, -3529.7], [-95554.4, -3512], [-95499.6, -3547],
  [-95554.9, -3598.4], [-95574.9, -3589.4], [-95609.8, -3670.4], [-95589, -3680.1], [-95599.9, -3748.7], [-95592.5, -3749.8], [-95592.8, -3751.3],
  [-95599.9, -3750.2], [-95599.9, -3750.9], [-95647.2, -3752.9], [-95676.6, -3752.8], [-95688.1, -3716.4], [-95778, -3742.7], [-95779.9, -3741.7],
  [-95781.4, -3742.1], [-95794.5, -3745.9], [-95794.9, -3747.4], [-95877.9, -3769.9], [-95866.5, -3804.6], [-95955.8, -3850.7], [-95958.3, -3834.4],
  [-95951.7, -3832.5], [-95953.1, -3828.1], [-95957.3, -3825.3], [-95956.1, -3824.1], [-95951.4, -3788], [-95955.3, -3786.6]];
// the paths and the stair that go through the ring (the tile's footways
// cross it here): an opening 2.6 m wide in the wall, nothing drawn across it
const GAPS = [[-95967.4, -3526.4], [-95951.4, -3651.9], [-95953.3, -3832.9], [-95959.2, -3691.7]];
const GAP_HALF = 1.3;
/** The box the ring lies in, for js/landmarks.js EXTRAS (a chunk meeting it asks the builder). */
export const VALY_BOX = [-95995, -3855, -95495, -3375];

const BRICK = 0x8b5a46, CORDON = 0xb4a993, COPING = 0x9d9483;
const STEP = 8, IN = 6, OUT = 3, MIN_H = 3.5, LEAN = 1.0, PARAPET = 1.1, PAR_T = 0.6, WALK = 2.6;

const same = (p, q) => Math.abs(p[0] - q[0]) < 0.3 && Math.abs(p[1] - q[1]) < 0.3;

/** Is this barrier the citadel's ring (the model replaces the generic ribbon)? WORKER SAFE. */
export function isVysehradWall(f) {
  return f.k === 'citywall' && f.p?.length === VALY_V.length && same(f.p[0], VALY_V[0]);
}

// the ring's outward normals per edge and the mitred one per vertex, once
const N = VALY_V.length - 1;
const EDGE_N = [], VERT_N = [];
{
  let a = 0;
  for (let i = 0; i < N; i++) { const p = VALY_V[i], q = VALY_V[i + 1]; a += p[0] * q[1] - q[0] * p[1]; }
  const S = a > 0 ? 1 : -1;       // the tile's ring runs so that this side is out (the rock falls there)
  for (let i = 0; i < N; i++) {
    const p = VALY_V[i], q = VALY_V[i + 1], L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    EDGE_N.push([S * (q[1] - p[1]) / L, -S * (q[0] - p[0]) / L]);
  }
  for (let i = 0; i < N; i++) {
    const a0 = EDGE_N[(i + N - 1) % N], a1 = EDGE_N[i];
    let mx = a0[0] + a1[0], mz = a0[1] + a1[1];
    const m = Math.hypot(mx, mz);
    if (m < 0.2) { VERT_N.push(a1); continue; }          // a hairpin: no mitre
    mx /= m; mz /= m;
    const k = Math.min(2.5, 1 / Math.max(0.4, mx * a1[0] + mz * a1[1]));
    VERT_N.push([mx * k, mz * k]);
  }
}

/**
 * One section of the wall at a point of the ring: where it stands, which way
 * is out, the walk's height and the foot's (absolute), from the terrain.
 */
function section(T, x, z, n) {
  const l = Math.hypot(n[0], n[1]) || 1, ux = n[0] / l, uz = n[1] / l;
  const crest = Math.max(T.heightAt(x, z), T.heightAt(x - ux * IN, z - uz * IN));
  const inner = T.heightAt(x - ux * (WALK + 1.5), z - uz * (WALK + 1.5));
  // Where the rock falls away the face leans out over the slope to reach
  // it: as far out (up to 10 m) as it can while staying at least as steep
  // as 45 degrees, so the 20 m cells' rounded-off cliff gets its brick
  // revetment instead of a 1 m kerb along the top. Where it does not fall,
  // an upright wall MIN_H over the ground outside.
  let out = 0, foot = Math.min(T.heightAt(x, z), T.heightAt(x + ux * OUT, z + uz * OUT)) - 0.6;
  let top = crest + 0.3;
  for (let d = 2; d <= 10; d += 2) {
    const g = T.heightAt(x + ux * d, z + uz * d) - 0.4;
    if (top - g >= LEAN * d && top - g >= MIN_H) { out = d; foot = g; }
  }
  if (!out) top = Math.max(top, foot + MIN_H);
  return { x, z, nx: n[0], nz: n[1], top, foot, out, inner, batter: out ? 0 : Math.min(1.4, (top - foot) * 0.09) };
}

/** The pieces of the ring the chunk ctx.key owns (each edge by the chunk holding its middle). */
export function buildVysehradValy(kit, ctx) {
  const T = ctx.terrain;
  if (!T) return;
  kit.floodFn = (x, y) => 0.35;
  for (let i = 0; i < N; i++) {
    const a = VALY_V[i], b = VALY_V[i + 1];
    if (ctx.chunkOf((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) !== ctx.key) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.05) continue;
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    // the stations along the edge: every STEP metres, the ends mitred, a
    // footway's opening cut out with a face on each side
    const cuts = [];
    for (const g of GAPS) {
      const t = (g[0] - a[0]) * dx + (g[1] - a[1]) * dz, o = Math.abs((g[0] - a[0]) * dz - (g[1] - a[1]) * dx);
      if (o < 1.5 && t > -GAP_HALF && t < L + GAP_HALF) cuts.push([Math.max(0, t - GAP_HALF), Math.min(L, t + GAP_HALF)]);
    }
    const runs = [];
    let t0 = 0;
    for (const [c0, c1] of cuts.sort((p, q) => p[0] - q[0])) { if (c0 > t0 + 0.05) runs.push([t0, c0, t0 === 0, false]); t0 = c1; }
    if (L > t0 + 0.05) runs.push([t0, L, t0 === 0, true]);
    const ne = EDGE_N[i], na = VERT_N[i], nb = VERT_N[(i + 1) % N];
    for (const [r0, r1, fromA, toB] of runs) {
      const n = Math.max(1, Math.ceil((r1 - r0) / STEP));
      const st = [];
      for (let k = 0; k <= n; k++) {
        const t = r0 + (r1 - r0) * k / n;
        const nn = k === 0 && fromA ? na : k === n && toB ? nb : ne;
        st.push(section(T, a[0] + dx * t, a[1] + dz * t, nn));
      }
      for (let k = 0; k < n; k++) span(kit, st[k], st[k + 1], ne);
      if (!fromA) cap(kit, st[0], -dx, -dz);
      if (!toB) cap(kit, st[n], dx, dz);
    }
  }
}

/** A point of a section `o` metres in from the outer face's foot line, at height y (absolute). */
const at = (s, o, y) => [s.x - s.nx * o, y, s.z - s.nz * o];

/** The wall between two sections: battered face, cordon, parapet, coping, the walk and its inner face. */
function span(kit, A, B, ne) {
  const [nx, nz] = ne;
  kit.set(BRICK, K.brick);
  // the battered face: from the foot on the ring line to the top, set back by the batter
  kit.quad(at(A, -A.out, A.foot), at(B, -B.out, B.foot), at(B, B.batter, B.top - 0.35), at(A, A.batter, A.top - 0.35), nx, 0.15, nz);
  // the parapet, upright over the cordon
  kit.quad(at(A, A.batter, A.top), at(B, B.batter, B.top), at(B, B.batter, B.top + PARAPET), at(A, A.batter, A.top + PARAPET), nx, 0, nz);
  kit.quad(at(A, A.batter + PAR_T, A.top), at(B, B.batter + PAR_T, B.top), at(B, B.batter + PAR_T, B.top + PARAPET), at(A, A.batter + PAR_T, A.top + PARAPET), -nx, 0, -nz);
  // the cordon: a stone roll proud of the face where the batter ends
  kit.set(CORDON, K.stone);
  kit.quad(at(A, A.batter - 0.22, A.top - 0.35), at(B, B.batter - 0.22, B.top - 0.35), at(B, B.batter - 0.22, B.top), at(A, A.batter - 0.22, A.top), nx, 0, nz);
  kit.quad(at(A, A.batter - 0.22, A.top), at(B, B.batter - 0.22, B.top), at(B, B.batter, B.top), at(A, A.batter, A.top), 0, 1, 0);
  kit.quad(at(A, A.batter, A.top - 0.35), at(B, B.batter, B.top - 0.35), at(B, B.batter - 0.22, B.top - 0.35), at(A, A.batter - 0.22, A.top - 0.35), 0, -1, 0);
  // the coping on the parapet
  kit.set(COPING, K.stone);
  kit.quad(at(A, A.batter - 0.05, A.top + PARAPET), at(B, B.batter - 0.05, B.top + PARAPET), at(B, B.batter + PAR_T + 0.05, B.top + PARAPET), at(A, A.batter + PAR_T + 0.05, A.top + PARAPET), 0, 1, 0);
  // the walk behind the parapet, and where it stands above the bank, its inner face
  const wA = A.top - 0.02, wB = B.top - 0.02;
  if (A.top > A.inner + 0.25 || B.top > B.inner + 0.25) {
    kit.set(0x8d8475, K.stone);
    kit.quad(at(A, A.batter + PAR_T, wA), at(B, B.batter + PAR_T, wB), at(B, B.batter + PAR_T + WALK, wB), at(A, A.batter + PAR_T + WALK, wA), 0, 1, 0);
    kit.set(BRICK, K.brick);
    kit.quad(at(A, A.batter + PAR_T + WALK, Math.min(A.inner, wA) - 0.4), at(B, B.batter + PAR_T + WALK, Math.min(B.inner, wB) - 0.4),
      at(B, B.batter + PAR_T + WALK, wB), at(A, A.batter + PAR_T + WALK, wA), -nx, 0, -nz);
  }
}

/** The end of a run at a footway's opening: the wall's section, facing along the ring (dx, dz). */
function cap(kit, s, dx, dz) {
  kit.set(BRICK, K.brick);
  const back = s.batter + PAR_T + WALK;
  kit.quad(at(s, -s.out, s.foot), at(s, back, Math.min(s.inner, s.top) - 0.4), at(s, back, s.top + PARAPET), at(s, 0, s.top + PARAPET), dx, 0, dz);
}

/** The entry for js/landmarks.js EXTRAS (through js/landmarks-hrad.js EXTRAS_WIDE). */
export const VALY_EXTRA = { id: 'vysehrad-valy', region: 'praha', box: VALY_BOX, build: buildVysehradValy };
