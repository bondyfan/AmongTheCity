// ---- cyclistmint.js: making a rider ---------------------------------------------
// Split out of js/cyclists.js, which decides WHEN a rider is wanted. This is
// the two halves of making one:
//
//   mintRide    the schedule: who they are, which bicycle, what colour, where
//               the trip starts and the whole plan of it. Every number is
//               hash32(cell, slot, generation), so every co-op client mints
//               the same rider. No body yet: most schedules never come near
//               the player and never get one.
//   mountRider  the body: a citizen (js/citizen.js) on the machine the
//               schedule says, with the record js/cyclistride.js steps.

import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE } from './config.js';
import { hash32, rnd01 } from './crowdsites.js';
import { makeRidePose } from './poses.js';
import { makePedal } from './gait.js';
import { buildPlan, planAt, planPose } from './cycleplan.js';
import { BIKES, PAINTS, PAINTS_BRIGHT } from './bikemodel.js';

export const TRIP_T = 210;         // s a generation rides
export const GHOST_T = 70;         // s of line a plan carries past that, for a rider somebody is watching
export const V_MAX = 7.8;          // the fastest anybody cruises, m/s
const WORLD_SEED = 0x51c7e11;
const CHILD_K = 0.72;              // a child on a child's bike, against an adult

const _P = { x: 0, z: 0, dx: 0, dz: 0, curv: 0, leg: 0 };
const _N = { arc: 0, v: 0 };

// Who rides: the crowd's bodies, without the man with the stick.
const RIDERS = [['m30', 0.36], ['f30', 0.36], ['f60', 0.14], ['m60', 0.14]];

/** The schedule of slot k of square c for the generation at shared second wt, or null. */
export function mintRide(sys, sk, c, k, wt, ways) {
  const ss = hash32(WORLD_SEED, c.ci, c.cj, k);
  const ph = rnd01(hash32(ss, 7)) * TRIP_T;
  const gen = Math.floor((wt + ph) / TRIP_T);
  const seed = hash32(ss, gen, 0x2b1);
  // who, and on what
  let a = rnd01(hash32(seed, 0xa7c)), arch = RIDERS[0][0];
  for (const [key, wgt] of RIDERS) { if (a < wgt) { arch = key; break; } a -= wgt; }
  const young = arch === 'm30' || arch === 'f30', woman = arch[0] === 'f';
  const tr = rnd01(hash32(seed, 0x7b1));
  const type = young && tr < 0.09 ? 3 : young && tr < 0.09 + (woman ? 0.14 : 0.24) ? 2
    : rnd01(hash32(seed, 0x7b2)) < (woman ? 0.7 : 0.15) ? 1 : 0;
  const vr = rnd01(hash32(seed, 4));
  const v0 = type === 3 ? 2.9 + vr * 0.7 : type === 2 ? 6.3 + vr * (V_MAX - 6.3)
    : young ? 4.3 + vr * 1.1 : 3.5 + vr * 0.8;
  const pr = rnd01(hash32(seed, 0x9a1));
  const paint = type >= 2 ? PAINTS[PAINTS_BRIGHT[(pr * PAINTS_BRIGHT.length) | 0]] : PAINTS[(pr * PAINTS.length) | 0];
  const t0 = gen * TRIP_T - ph;
  const want = v0 * (TRIP_T + GHOST_T);
  // the trip: from a hashed vertex of a hashed cycleway of the square. A
  // start that leads nowhere is passed over for the next way in the list,
  // and of the few tried the longest ride wins.
  const i0 = (rnd01(hash32(seed, 1)) * ways.length) | 0;
  let plan = null;
  // every stretch of map this trip was chosen over, taken or not (see regraph)
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let n = 0; n < 4 && n < ways.length; n++) {
    const w = ways[(i0 + n) % ways.length];
    let d = (hash32(seed, 3, n) & 1) ? 1 : -1;
    let i = (rnd01(hash32(seed, 2, n)) * (w.n - 1)) | 0;
    if (d < 0) i += 1;
    grow(box, w, 0, w.n - 1);
    if (!sys.net.rideable(w, d) || !sys.net.leads(w, i, d)) { d = -d; i = d < 0 ? Math.min(w.n - 1, i + 1) : Math.max(0, i - 1); }
    if (!sys.net.rideable(w, d)) continue;
    const legs = sys.net.route(hash32(seed, 0x40, n), w, i, d, want);
    for (const l of legs) grow(box, l.w, l.i0, l.i1);
    const p = buildPlan(legs, { v0, t0, maxLen: want, drive: sys.drive, sites: sys.sites,
      signalWait: sys.traffic ? sys._signalWait : null });
    if (p && (!plan || p.len > plan.len)) plan = p;
    if (plan && plan.len >= v0 * TRIP_T * 0.8) break;
  }
  if (!plan || plan.len < 60) {
    // nowhere to ride from here this generation: remembered, so the sweep does
    // not find it out again four times a second
    if (sys._dud.size > 4096) sys._dud.clear();
    sys._dud.set(sk, t0 + TRIP_T);
    return null;
  }
  const s = {
    key: sk, ci: c.ci, cj: c.cj, k, cell: c, seed, gen, ph, t0, plan,
    arch, type, paint, v0, child: type === 3, box, regraph: 0,
    hint: { k: 0, s: 0 },
    skip: 0,                      // shared second before which the sweep need not ask where they are
    body: null,
    held: 0,                      // 1: its rider was knocked off; empty until the generation rolls
  };
  return s;
}


function grow(box, w, i0, i1) {
  const p = w.r.p, a = i0 < i1 ? i0 : i1, b = i0 < i1 ? i1 : i0;
  for (let i = a; i <= b; i++) {
    const x = p[i][0], z = p[i][1];
    if (x < box[0]) box[0] = x;
    if (z < box[1]) box[1] = z;
    if (x > box[2]) box[2] = x;
    if (z > box[3]) box[3] = z;
  }
}

// MORE MAP HAS ARRIVED. A trip minted before a tile streamed in was routed
// over a map that ended at its edge: it turned round there, or never took the
// turning that leads into it. A client that already had the tile minted the
// same slot with a different trip, and the two saw different riders until the
// generation rolled (measured on the test town with half of it arriving
// thirty seconds late: one rider in five, for up to three and a half
// minutes). So every schedule whose choice of trip came within sight of the
// new roads is flagged, and the sweep retires it like a generation that has
// rolled: the slot is minted again over the map as it now is, which is what
// everybody else has, and a body somebody is watching rides on as a ghost.
// "Within sight": a route decision looks at most FAR and then HOP metres
// beyond a junction (js/cyclenet.js), and a crossing is surveyed on the line
// itself.
const REGRAPH_R = 450;

/** Flag the schedules in `pool` that a batch of new road features may change. Returns how many. */
export function regraph(pool, roads) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of roads ?? []) {
    const p = r.p;
    if (!p) continue;
    for (let i = 0; i < p.length; i++) {
      const x = p[i][0], z = p[i][1];
      if (x < x0) x0 = x;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (z > z1) z1 = z;
    }
  }
  if (!(x1 >= x0)) return 0;
  x0 -= REGRAPH_R; z0 -= REGRAPH_R; x1 += REGRAPH_R; z1 += REGRAPH_R;
  let n = 0;
  for (const s of pool.values()) {
    const b = s.box;
    if (!b || b[0] > x1 || b[2] < x0 || b[1] > z1 || b[3] < z0) continue;
    s.regraph = 1; n++;
  }
  return n;
}

/** A body for schedule s: a citizen on its bicycle, where the plan has them now. */
export function mountRider(sys, s, wt) {
  // makeCitizen draws its wardrobe from Math.random; lend it a seeded one for
  // the length of the call, as js/pedestrians.js does, so the same rider
  // wears the same jacket on every screen
  const real = Math.random;
  let n = 0, c;
  try {
    Math.random = () => rnd01(hash32(s.seed, 0xc17, n++));
    // (a handbag is not carried on a bicycle: a rucksack, or nothing)
    c = makeCitizen({ archetype: s.arch, seed: s.seed, style: { bag: rnd01(hash32(s.seed, 0xba6)) < 0.35 ? 'backpack' : null } });
  } finally { Math.random = real; }
  const g = PLAYER_SCALE * (s.child ? CHILD_K : 1);
  c.group.scale.setScalar(g);
  // heading, then the slope, then the lean: the order a bicycle really has
  c.group.rotation.order = 'YXZ';
  sys.scene.add(c.group);
  planAt(s.plan, wt, s.hint, _N);
  const p = planPose(s.plan, _N.arc, s.hint, _P);
  const k = (0 - c.parts.kneeL.position.y) / 0.415;
  const gy = sys.ground ? sys.ground.heightAt(p.x, p.z) : 0;
  const r = {
    s, c, mesh: c.group, ride: makeRidePose(c.parts), pedal: makePedal(c.parts),
    type: s.type, fit: BIKES[s.type].fit, paint: s.paint, scale: g * k, gscale: g,
    ghost: false, ghostT: 0,
    // where the plan is, and where this client has them (never ahead of it)
    hintT: { k: s.hint.k, s: 0 }, hintS: { k: 0, s: s.hint.s },
    arc: _N.arc, v: _N.v, late: 0,
    x: p.x, z: p.z, dx: p.dx, dz: p.dz, y: gy, heading: Math.atan2(-p.dx, -p.dz),
    // the last four answers about the ground under the front wheel (arc, height)
    yF: gy, yR: gy, ga: new Float64Array([_N.arc - 3, _N.arc - 2, _N.arc - 1, _N.arc - 0.6]), gy: new Float64Array([gy, gy, gy, gy]), gi: 3,
    pitch: 0, roll: 0, steer: 0, curv: 0,
    spin: rnd01(hash32(s.seed, 5)) * 6.28, crank: rnd01(hash32(s.seed, 6)) * 6.28, coast: 0,
    stand: 0, stillT: 0, far: false, tick: (s.seed >>> 3) & 7, tick0: (s.seed & 255) / 40, camD: 0, leg: p.leg,
    // what the last look ahead found
    cap: Infinity, shift: 0, shiftT: 0, holdT: 0, ci: 0, lane: false, noteOn: false,
    // the two records the traffic reads: a hull in the lane, and somebody on a crossing
    block: { x: 0, z: 0, half: 1.0 },
    note: { cx: 0, cz: 0, rdx: 0, rdz: 0, hw: 0, must: false, x: 0, z: 0, body: false, stale: false },
    hitCd: 0,
  };
  c.group.position.set(r.x, r.y, r.z);
  c.group.rotation.set(0, r.heading, 0);
  r.ride(r.fit, 0, 0); r.pedal(r.fit, r.crank, 0, 0);
  return r;
}
