// ---- a small cycling town, for the cyclist tests ----------------------------
// Not a test. Ways that cross repeat the EXACT coordinate, as OSM does, which
// is what welds them into one graph (js/cyclenet.js). The town:
//
//   cycleways   a grid every 120 m, each block its own way (OSM splits a path
//               at every junction), with a kink so a way has a middle vertex
//   a street    a residential street down x = 60, crossing every east-west
//               cycleway at a shared vertex
//   a main road a secondary road along z = 60: never ridden, only crossed
//               (it shares no vertex with a cycleway: the crossings are found
//               on the ground, by js/crowdsites.js RoadIndex)

export const HALF = 720, STEP = 120;

export function town() {
  const roads = [];
  const n = HALF / STEP;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j < n; j++) {
      const a = i * STEP, b = j * STEP;
      // north-south block
      roads.push({ t: 'cycleway', d: 0, w: 2.2, s: 'asphalt', p: [[a, b], [a + 2, b + STEP / 2], [a, b + STEP]] });
      // east-west block, cut where the street and nothing else crosses it
      if (b < 60 && b + STEP > 60) {
        roads.push({ t: 'cycleway', d: 0, w: 2.2, s: 'asphalt', p: [[b, a], [60, a]] });
        roads.push({ t: 'cycleway', d: 0, w: 2.2, s: 'asphalt', p: [[60, a], [b + STEP, a]] });
      } else roads.push({ t: 'cycleway', d: 0, w: 2.2, s: 'asphalt', p: [[b, a], [b + STEP / 2, a - 2], [b + STEP, a]] });
    }
  }
  const street = [];
  for (let j = -n; j <= n; j++) street.push([60, j * STEP]);
  roads.push({ t: 'residential', d: 1, w: 6, v: 30, p: street });
  // the main road: its vertices are the cycleway crossings, as mapped
  const main = [];
  for (let i = -n; i <= n; i++) main.push([i * STEP, 60]);
  main.splice(n + 1, 0, [60, 60]);
  roads.push({ t: 'secondary', d: 1, w: 8, v: 50, p: main });
  let id = 0;
  for (const r of roads) { r._id = ++id; r._len = len(r); }
  return roads;
}

function len(r) {
  let L = 0;
  for (let i = 1; i < r.p.length; i++) L += Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
  return L;
}

/** A way by hand, stamped like the town's. */
let _id = 100000;
export function way(t, p, extra = {}) {
  const r = { t, p, d: 0, w: 2.2, ...extra, _id: ++_id };
  r._len = len(r);
  return r;
}

export const stubScene = { add() {}, remove() {} };

// half past noon of a working day on the shared clock (tests/flow-harness.mjs T_NOON)
export const T0 = 17_899_320;

/** The camera the way main.js hands it over (headless shape). */
export function viewAt(x, z, hx, hz) {
  return { x: x - hx * 12, z: z - hz * 12, dirX: hx, dirZ: hz, fovRad: 55 * Math.PI / 180, aspect: 16 / 9, fogFar: 634 };
}
