// The Prague náplavky: the LOWER QUAYS of the Vltava, a stone floor about two
// metres over the water at the foot of the embankment wall, where the boats
// tie up and the summer markets stand. DMR 5G at 20 m cannot hold a 5 m wall,
// so the survey smeared each quay into a slope from the street down to the
// water, 2 to 4 m too high at its outer edge, and the walls (OSM
// barrier=retaining_wall) had no ground to stand in.
//
// Each náplavka is a terrain stamp (js/terrainstamps.js makes them): its line
// is the retaining wall's own polyline, traced in the direction that leaves
// the water on the RIGHT (d > 0; OSM draws a retaining wall with its low side
// on the right, which these all keep), dug with a hard edge at the wall face
// down to its pool level (js/riverpools.js) plus the quay's height. The street
// side (d < 0) is not touched. WORKER SAFE: plain data.
//
// Vertices are the shipped tile barriers (tiles -21_-2, -20_-2, -21_-1,
// -20_-1), chained where two walls overlap, the riverward one kept (except
// where a ramp runs down between the two: there the line keeps to the outer
// wall and the ramp has the space behind it, see NAPLAVKA_BEFORE).

import { POOLS } from './riverpools.js';

// m: from the wall out past the waterline (the river carve takes over there),
// short of the nearest island, then 4 m back up to the survey
const QUAY_W = 30, QUAY_FADE = 4;
const prof = [[-0.001, 0, 0], [0, 0, 1], [QUAY_W, 0, 1], [QUAY_W + QUAY_FADE, 0, 0]];

export const NAPLAVKY = [
  // Novoměstská náplavka under Rašínovo nábřeží, Jiráskův most to Výtoň,
  // pool A (above Šítkovský jez); travelling south, the river to the west
  // (from the Šítkovská vodárna under Jiráskův most; the Dřevná ramp runs
  // down behind the outer wall from -4446 to -4336, so the line keeps to it)
  { name: 'Novoměstská náplavka', mode: 'dig', base: POOLS.A + 1.6, prof, capped: false, snap: true,
    pts: [[-96144.4, -5059.6], [-96154, -5002], [-96168, -4934.1], [-96182.2, -4865.3],
      [-96172.9, -4607.3], [-96170.7, -4579.3],
      [-96162, -4446.4], [-96150.8, -4335.5], [-96141.7, -4336.4], [-96133.7, -4273],
      [-96126.5, -4195.1], [-96108.3, -4066.1], [-96105.9, -4045.2], [-96071.8, -3788.5],
      [-96062, -3705.6]] },
  // Staroměstská náplavka under Dvořákovo nábřeží and Na Františku, pool C
  // (below Staroměstský jez); travelling west, the river to the north
  { name: 'Staroměstská náplavka', mode: 'dig', base: POOLS.C + 1.5, prof, capped: false, snap: true,
    pts: [[-95238.3, -6853.1], [-95379.9, -6849.6], [-95420.9, -6849.1], [-95478.1, -6844.3],
      [-95555.6, -6835], [-95651.3, -6818.4], [-95700.4, -6807.5], [-95756.9, -6794],
      [-95794.6, -6780.8], [-95842.3, -6760.4], [-95865.4, -6750.2], [-95885, -6740],
      [-95918.3, -6720.5], [-95952.7, -6701], [-95989, -6672.3], [-96025.7, -6639.3],
      [-96049.1, -6609], [-96082.3, -6563]] },
];

// ---- the ways down -------------------------------------------------------------
// A lower quay you cannot reach is a moat. The real ones are reached by a few
// ramps (the boats' suppliers drive down) and by stairs, most of them built
// against the inner face of the wall or cut into it. Each is a 'set' or a
// 'raise' stamp along the OSM way's own line (data/raw-region, read and baked
// here), hard edged at its sides, square at its ends (capped: false), its base
// running by arclength from the quay floor to the street at the top. The tops
// are the levelled street measured where the way arrives (roadGradeY over the
// survey and these stamps, survey7 scratch tops.mjs), so the ramp meets the
// pavement it comes up to. Widths are [left, right] of travel from the FLOOR
// end, measured to the walls either side.
//
// The ways themselves (pedestrian, steps) were already in the tiles; they are
// levelled onto whatever ground is under them, so shaping the ground is what
// makes them walkable (world.footing reads ground and ways) and the ramps
// drivable.

const FLOOR_A = POOLS.A + 1.6, FLOOR_C = POOLS.C + 1.5;

/** Bases by arclength from y0 at the first vertex to y1 at the last. */
function slope(pts, y0, y1) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = s[s.length - 1] || 1;
  return s.map((v) => y0 + (y1 - y0) * v / L);
}
/** Across the way: flat `l` m to the left of travel and `r` to the right, each
 *  side a hard edge (a wall stands there) or, given a fade, sloping back to
 *  the ground over that many metres (an open side: a hard edge with no wall
 *  in front of it is a row of spikes in the 4 m ground mesh). */
function band(l, r, fl = 0, fr = 0) {
  return [[-l - (fl || 0.001), 0, 0], [-l, 0, 1], [r, 0, 1], [r + (fr || 0.001), 0, 0]];
}

// `base` is one height per vertex, or [floor, top] spread by arclength.
// The line runs on past both ends at the end's own height (`e0` m at the
// floor, `e1` at the top), so the short ways that join a flight to the
// pavement or the quay stand on it too, and an end vertex is never the
// knife edge of the square cut. `fl`/`fr`: fades of an open side (band).
function way(name, mode, pts, base, l, r, { e0 = 1, e1 = 2, fl = 0, fr = 0 } = {}) {
  const ys = base.length === pts.length ? base : slope(pts, base[0], base[base.length - 1]);
  const ext = (p, q, e) => {
    const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
    return [p[0] + (p[0] - q[0]) * e / L, p[1] + (p[1] - q[1]) * e / L];
  };
  const n = pts.length;
  return { name, mode, prof: band(l, r, fl, fr), capped: false, snap: true,
    pts: [ext(pts[0], pts[1], e0), ...pts, ext(pts[n - 1], pts[n - 2], e1)],
    base: [ys[0], ...ys, ys[n - 1]] };
}
// A straight flight of steps, floor end first, carried 2.5 m on at the top to
// meet the pavement. `wall`: which side of travel the quay wall is on ('L' or
// 'R'): the band reaches 2.4 m back to it, and on the open side is 1.2 m flat
// and slopes away over 3.5 m. No wall: a flight cut into the wall, walled both
// sides, 1.4 m either way.
// 'set', not 'raise': several OSM flights run just on the street side of the
// stamped wall line (Vyšehradská, Výtoň north, Dvořákovo east), and a raise
// cannot lower the pavement there, so those flights stood at street level
// and never reached the quay. Set cuts them into the embankment on that side
// and builds them up on the quay side, the same flight either way.
function stair(name, a, b, y0, y1, wall = null) {
  const o = { e0: 1, e1: 2.5 };
  if (!wall) return way(name, 'set', [a, b], [y0, y1], 1.4, 1.4, o);
  // (against the wall the flights mostly come in pairs from one landing, and
  // one's run-on past its foot was the other's lowest steps: set to the floor
  // there, a 0.6 m riser at the bottom of the second flight)
  o.e0 = 0.1;
  return wall === 'L' ? way(name, 'set', [a, b], [y0, y1], 2.4, 1.2, { ...o, fr: 3.5 })
    : way(name, 'set', [a, b], [y0, y1], 1.2, 2.4, { ...o, fl: 3.5 });
}

// Set before the quay is dug: ramps that run down BEHIND a quay wall.
export const NAPLAVKA_BEFORE = [
  // Dřevná: from the Rašínovo nábřeží junction down between the street wall
  // and the outer (h 8) quay wall, out round its end onto the quay at -4335.
  // Travelling north from the floor: the street wall 2.6 m to the right, the
  // outer wall 5 to 6 m to the left (what spills over it is dug again).
  way('Dřevná ramp', 'set', [[-96145.3, -4334.5], [-96153.3, -4418.4], [-96150.9, -4436.8]],
    [FLOOR_A, 192.0, 192.4], 7, 2.6),
];

// Laid on the floor after the quay is dug.
export const NAPLAVKA_AFTER = [
  // ---- Novoměstská náplavka (pool A) ----
  // Výtoň: up from the quay between the street wall (left, travelling south)
  // and a low outer wall (right, 4.3 m), to the terrace at street level by the
  // railway bridge
  way('Výtoň ramp', 'raise', [[-96120.3, -4131.9], [-96110.8, -4065.7]], [FLOOR_A, 192.0], 4, 4.3),
  // the terrace beyond, between the outer wall and the street, falling to
  // the service ramp that comes back down to the quay at -3972
  way('Výtoň terrace', 'raise', [[-96110.8, -4065.7], [-96105.5, -4055.8], [-96108.4, -4046], [-96101.8, -3980.1]],
    [192.0, 192.0, 192.0, 190.4], 4, 3.6, { e1: 0.1 }),   // (the service ramp goes on from its end)
  way('Výtoň service ramp', 'raise', [[-96110, -3971.6], [-96101.8, -3980.1]], [FLOOR_A, 190.4], 2.4, 2.4, { fl: 3, fr: 3 }),
  // the south end: up along the quay wall to the service road at Výtoň
  way('Výtoň south ramp', 'raise', [[-96076, -3769.9], [-96071.7, -3742.2], [-96066.3, -3709.6],
    [-96064.1, -3702.8], [-96059.3, -3698.9]], [FLOOR_A, 192.7], 5.2, 6),
  // the north end: up from under Jiráskův most to Masarykovo nábřeží by the
  // Šítkovská vodárna (set: the survey there is above the line)
  way('Šítkovská ramp', 'set', [[-96155.1, -5015], [-96146.6, -5062.2], [-96143.3, -5068.3], [-96139.3, -5081.9]],
    [FLOOR_A, 193.3], 3, 2, { fl: 3, fr: 2 }),
  // stairs cut into the wall, floor end first (step counts 21, ?, ?, ?)
  stair('Trojická stairs', [-96141.8, -4326.8], [-96142.2, -4332.4], FLOOR_A, 192.2),
  stair('Na Výtoni stairs', [-96136, -4279], [-96135.1, -4272.9], FLOOR_A, 191.2),
  stair('Vyšehradská stairs', [-96124.8, -4189.2], [-96125.4, -4195.3], FLOOR_A, 192.1),
  stair('Výtoň north stairs', [-96118.3, -4142.1], [-96117.6, -4136.3], FLOOR_A, 191.2),
  // the pairs climbing the wall's face from one landing, both ways: either
  // side of Palackého most and by Jiráskův most (a storey and a half: the
  // street there is the bridgehead, terrainstamps.js RASINOVO)
  stair('Palackého stairs south', [-96177.1, -4671.9], [-96176.6, -4657.6], FLOOR_A, 194.8, 'L'),
  stair('Palackého stairs north', [-96177.1, -4671.9], [-96177.7, -4686.8], FLOOR_A, 194.8, 'R'),
  stair('Jiráskův stairs south', [-96180.3, -4769.7], [-96179.7, -4753], FLOOR_A, 194.6, 'L'),
  stair('Jiráskův stairs north', [-96180.3, -4769.7], [-96180.8, -4787.5], FLOOR_A, 194.3, 'R'),
  stair('Výtoň stairs south', [-96072.6, -3780.4], [-96073.5, -3787.3], FLOOR_A, 191.9, 'L'),
  stair('Výtoň stairs north', [-96072.6, -3780.4], [-96071.8, -3773.5], FLOOR_A, 192.3, 'R'),
  stair('terrace stairs', [-96097.1, -3970.2], [-96097.8, -3978.5], FLOOR_A, 190.5),
  stair('terrace stairs south', [-96114.6, -4055.7], [-96113.4, -4046.4], FLOOR_A, 192.0, 'L'),
  stair('terrace stairs north', [-96114.6, -4055.7], [-96115.7, -4064.2], FLOOR_A, 192.0, 'R'),

  // ---- Staroměstská náplavka (pool C) ----
  // Dvořákovo nábřeží: one ramp climbing east from the quay between the street
  // wall (right, south) and a lower wall (left, 3.2 m), level where a passage
  // goes up to the street at x -95486, and down again to the quay at -95378
  way('Dvořákovo ramp', 'set', [[-95594.1, -6841.3], [-95567.1, -6836.3], [-95495.4, -6839.1],
    [-95478, -6840.4], [-95404.5, -6847.6], [-95377.5, -6857.5]],
  [FLOOR_C, FLOOR_C + (189.3 - FLOOR_C) * 27.5 / 99.2, 189.3, 189.3, FLOOR_C + (189.3 - FLOOR_C) * 28.6 / 102.4, FLOOR_C],
  3.2, 4.4),
  // the west end, up along the wall to Alšovo nábřeží by Mánesův most
  way('Alšovo ramp', 'raise', [[-96031.2, -6639], [-96085.1, -6563.8], [-96085.9, -6555.6]], [FLOOR_C, 191.2], 4, 2.5, { fr: 3 }),
  // the long flights up to Na Františku (44 and 45 steps) either side of the
  // Čechův most abutment, standing two metres off the wall
  stair('Na Františku stairs', [-95868.6, -6750.3], [-95885.8, -6741.4], FLOOR_C, 192.8, 'L'),
  stair('Anežská stairs', [-95936.3, -6712.7], [-95919.3, -6722.5], FLOOR_C, 192.4, 'R'),
  // and the shorter ones to Dvořákovo nábřeží, against the wall's face
  stair('Dvořákovo stairs west', [-95747.2, -6797.6], [-95757.1, -6794.4], FLOOR_C, 190.0, 'L'),
  stair('Dvořákovo stairs', [-95661.5, -6816.5], [-95651.4, -6818], FLOOR_C, 188.5, 'R'),
  stair('Dvořákovo stairs east', [-95564.4, -6831.4], [-95558.2, -6832.2], FLOOR_C, 188.9, 'R'),
  // the pair from the quay up to the ramp's level middle
  stair('ramp stairs west', [-95487, -6845.2], [-95495.7, -6844.6], FLOOR_C, 189.3, 'L'),
  stair('ramp stairs east', [-95487, -6845.2], [-95478.2, -6845.8], FLOOR_C, 189.3, 'R'),
];
