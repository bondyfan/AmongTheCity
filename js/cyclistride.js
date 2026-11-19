// ---- cyclistride.js: one rider, one frame --------------------------------------
// js/cyclists.js decides WHO is riding and gives them bodies. This is what a
// body does every frame between two sweeps: where it is, how the bike leans
// and the legs turn. What it slows and steers for is js/cyclistsense.js
// (senseStep, which leaves its answer in r.cap and r.shiftT); what happens
// when a car hits it is js/cyclistknock.js.
//
// NEVER AHEAD OF THE PLAN. The plan (js/cycleplan.js) says where the rider is
// at this shared second. A rider here may be BEHIND that (r.arc <= the plan's
// arc), because of something only this client can see, and closes the gap at a
// little over their own pace once the way is clear. That is js/traffic.js's
// lag, for its reason: a transient with a restoring force, so two clients
// cannot drift apart for good.
//
// Nothing here allocates per frame: a rider's records are made when the body
// is, and the scratch is the module's.

import { planAt, planPose } from './cycleplan.js';
import { BIKES } from './bikemodel.js';

const ACC_UP = 1.3, BRK_HARD = 3.4;   // m/s2 this client may add: a little more push than the plan, a real brake
const CATCH_A = 0.45, CATCH_K = 1.25; // closing a gap on the plan: gently, and at most a quarter over their pace
const LAG_MAX = 80;                   // m behind the plan past which this client's rider is its own (see rideStep)
export const SHIFT_V = 1.1;           // m/s sideways
const STAND_ROLL = 0.13;              // rad the bike leans onto the standing foot
const FAR_OUT = 62, FAR_IN = 55;      // the citizen's own distance line (js/citizen.js)
// metres the bike travels per radian of crank, per bicycle
const DEV = [0.80, 0.76, 1.05, 0.62];

const _N = { arc: 0, v: 0 }, _P = { x: 0, z: 0, dx: 0, dz: 0, curv: 0, leg: 0 };
const _B = { type: 0, x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, steer: 0, spin: 0, crank: 0,
  scale: 1, paint: 0, far: false, camD: 0, lit: true };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---- moving ------------------------------------------------------------------------

export function rideStep(sys, r, dt, wt, cx, cz) {
  const s = r.s, plan = s.plan;
  if (r.hitCd > 0) r.hitCd -= dt;
  planAt(plan, wt - r.late, r.hintT, _N);
  const arcN = _N.arc, vN = _N.v, lag = arcN - r.arc;
  let want = vN;
  if (lag > 0.02) {
    want = vN + Math.sqrt(2 * CATCH_A * lag);
    const top = s.v0 * CATCH_K;
    if (want > top) want = vN > top ? vN : top;
  }
  if (r.cap < want) want = r.cap;
  const braking = want < r.v - 0.05;
  if (r.v < want) r.v = Math.min(want, r.v + ACC_UP * dt);
  else r.v = Math.max(want, r.v - BRK_HARD * dt);
  let arc = r.arc + r.v * dt;
  if (arc >= arcN) { arc = arcN; if (r.v > vN) r.v = vN; }
  else if (arcN - arc > LAG_MAX) {
    // TOO FAR BEHIND TO BE THE SHARED RIDER ANY MORE. Hauling them forward to
    // the plan would ride them through whatever held them up (js/traffic.js
    // found the same about a queue behind the player's parked car). They stay
    // where they are and become this client's own: the plan is read late by
    // however long they have been stuck, the slot is left empty until its
    // generation rolls, and the body goes when nobody is looking.
    r.late += dt;
    if (!r.ghost) { r.ghost = true; r.ghostT = 0; if (s.body === r) { s.body = null; s.held = 1; } sys.stats.late++; }
  }
  const moved = arc - r.arc;
  r.arc = arc;

  // where that is, and a step aside for whoever is in the way
  planPose(plan, arc, r.hintS, _P);
  // (only while rolling: a bicycle standing at a kerb does not slide sideways)
  if (r.v > 0.3) {
    const ds = r.shiftT - r.shift, smax = SHIFT_V * dt;
    r.shift += ds > smax ? smax : ds < -smax ? -smax : ds;
  }
  const dx = _P.dx, dz = _P.dz;
  const x = _P.x - dz * r.shift, z = _P.z + dx * r.shift;
  r.x = x; r.z = z; r.dx = dx; r.dz = dz; r.curv = _P.curv; r.leg = _P.leg;
  r.heading = Math.atan2(-dx, -dz);

  // THE GROUND, ASKED ONCE PER HALF METRE AND ONLY UNDER THE FRONT WHEEL. The
  // walking surface is the dearest question in the game (js/pedestrians.js
  // measured it; here it was half of a rider's frame when both wheels asked
  // every hand's width). The back wheel rolls over what the front one rolled
  // over a wheelbase ago, so its height is read out of the last four answers.
  const B = BIKES[r.type], sc = r.scale;
  const wb = (B.frontF - B.rearF) * sc;
  const ga = r.ga, gy = r.gy;
  if ((arc - ga[r.gi] > 0.5 || arc < ga[r.gi]) && sys.ground) {
    const yf = sys.ground.heightAt(x + dx * B.frontF * sc, z + dz * B.frontF * sc);
    if (Number.isFinite(yf)) { r.gi = (r.gi + 1) & 3; ga[r.gi] = arc; gy[r.gi] = yf; }
  }
  // (the front wheel has rolled on since it last asked: carry the slope forward)
  const g1 = r.gi, g0 = (g1 - 1) & 3, run = ga[g1] - ga[g0];
  // (a slope, that is: a kerb is a step, and a step carried forward is a hop)
  const grade = run > 0.2 && run < 1.5 ? clamp((gy[g1] - gy[g0]) / run, -0.12, 0.12) : 0;
  r.yF = gy[g1] + grade * Math.min(0.6, arc - ga[g1]);
  // (newest first: the first answer at or before where the back wheel is now)
  const back = arc - wb;
  let yR = gy[(r.gi + 1) & 3];
  for (let k = 0; k < 3; k++) {
    const i = (r.gi - k) & 3, j = (r.gi - k - 1) & 3;
    if (ga[j] <= back) {
      const f = ga[i] > ga[j] ? (back - ga[j]) / (ga[i] - ga[j]) : 0;
      yR = gy[j] + (gy[i] - gy[j]) * (f < 1 ? f : 1);
      break;
    }
  }
  r.yR = yR;
  const yT = r.yR + (r.yF - r.yR) * (-B.rearF / (B.frontF - B.rearF));
  const e = Math.min(1, dt * 12);
  r.y += (yT - r.y) * e;
  r.pitch += (Math.atan2(r.yF - r.yR, wb) - r.pitch) * e;

  // standing still is a foot on the road, not a track stand
  r.stillT = r.v < 0.25 ? r.stillT + dt : 0;
  const stT = r.stillT > 0.12 ? 1 : 0;
  r.stand = clamp(r.stand + clamp(stT - r.stand, -4 * dt, 3.2 * dt), 0, 1);
  const st = r.stand, v = r.v;
  // into the bend, by as much as the speed and the radius ask
  const rollT = clamp(Math.atan(v * v * r.curv / 9.81), -0.5, 0.5) * (1 - st) - STAND_ROLL * st;
  r.roll += (rollT - r.roll) * Math.min(1, dt * 5);
  // the bars: the bend, a little weave at walking pace, turned aside at a stop
  const steerT = clamp(r.curv * wb * 1.15, -0.55, 0.55) * (1 - st)
    + Math.sin(r.arc * 1.9 + r.tick0) * 0.04 * Math.max(0, 1 - v / 3.5) * (1 - st) - 0.22 * st;
  r.steer += (steerT - r.steer) * Math.min(1, dt * 8);
  r.spin += moved / (B.wheelR * sc);
  // the legs push while the rider holds or gains speed and freewheel under braking
  const push = v > 0.5 && !braking ? 1 : 0;
  r.coast += (push - r.coast) * Math.min(1, dt * 6);
  r.crank += moved / (DEV[r.type] * r.gscale) * r.coast;

  const m = r.mesh;
  m.position.set(x, r.y, z);
  m.rotation.set(r.pitch, r.heading, 0 - r.roll);
  const cdx = x - cx, cdz = z - cz, d = Math.sqrt(cdx * cdx + cdz * cdz);
  r.camD = d;
  r.far = r.far ? d > FAR_IN : d > FAR_OUT;
  // the pose every frame up close, every third past the distance line, every
  // sixth beyond that: a skeleton is seventeen matrices
  const every = d < FAR_OUT ? 1 : d < 120 ? 3 : 6;
  if (++r.tick % every === 0) { r.ride(r.fit, r.steer, st); r.pedal(r.fit, r.crank, st, r.roll); }

  // what the traffic is told
  if (r.lane) {
    const o = r.block;
    o.x = x; o.z = z; o.y = r.y;       // (the height too: js/levelsep.js)
    sys.lane.push(o);
  }
  if (r.noteOn && sys.peds) {
    const o = r.note;
    o.x = x; o.z = z; o.y = r.y;
    sys.peds.crossers.push(o);
  }

  _B.type = r.type; _B.x = x; _B.y = r.y; _B.z = z; _B.heading = r.heading; _B.pitch = r.pitch; _B.roll = r.roll;
  _B.steer = r.steer; _B.spin = r.spin; _B.crank = r.crank; _B.scale = sc; _B.paint = r.paint;
  _B.far = r.far; _B.camD = d; _B.lit = true;
  sys.fleet.put(_B);
}
