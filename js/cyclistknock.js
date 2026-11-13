// ---- cyclistknock.js: a car and a bicycle in the same place --------------------
// Split out of js/cyclistride.js. What counts as a car hitting a rider, what
// happens to the rider (they become a body of the CROWD's, thrown through the
// one door every injury in the game goes through, js/pedestrians.js hurt()) and
// what happens to the bicycle (it falls where it is, slides, and lies there).
//
// All of it is this client's own, like every hit in the game: the slot the
// rider held stays empty until its generation rolls.

import { planPose } from './cycleplan.js';
import { PED_HP } from './pedestrians.js';

const FAR_OUT = 62;                   // the distance line (js/cyclistride.js, js/citizen.js)
const HIT_MIN = 1.6, KILL_SPEED = 7;  // m/s: js/pedestrians.js's two thresholds, for the same reasons
const C_CAR = 'sražení autem';        // Czech: it ends up stamped on a body

const _P = { x: 0, z: 0, dx: 0, dz: 0, curv: 0, leg: 0 }, _h = { k: 0, s: 0 };
const _B = { type: 0, x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, steer: 0, spin: 0, crank: 0,
  scale: 1, paint: 0, far: false, camD: 0, lit: false };
const _blow = { dmg: 0, launch: true, vx: 0, vy: 0, vz: 0, spin: 0, impact: 0, panic: 25, cause: C_CAR, by: null };

// `nose`: only the front of the car counts. That is the rule for the TRAFFIC's
// cars, and it is not leniency. A rider at the kerb edge and a car in its lane
// pass each other with a hand's width between them, by design (the traffic
// keeps half a metre off the kerb, and that half metre is the rider's): a test
// with any margin on a car's FLANK had every passing lorry knock somebody off
// (two riders in the first three minutes the game ran). A rail-following car
// cannot swerve into anybody; what it can do is drive into them, nose first.
// The player's car is free to side-swipe, and is tested all round.
function carHits(car, r, nose) {
  const dx = r.x - car.x, dz = r.z - car.z, len = car.len ?? 4.4;
  if (dx > len || dx < -len || dz > len || dz < -len) return false;
  const hx = -Math.sin(car.heading), hz = -Math.cos(car.heading);
  const sp = car.speed ?? 0, wid = car.wid ?? 1.8;
  if (nose) {
    // closing along the car's own line: one pacing a rider is not hitting them
    if (sp - r.v * (r.dx * hx + r.dz * hz) < HIT_MIN) return false;
    const f = dx * hx + dz * hz, l = dx * hz - dz * hx;
    return f > len / 2 - 0.9 && f < len / 2 + 0.35 && l < wid / 2 - 0.05 && l > -wid / 2 + 0.05;
  }
  const rvx = hx * sp - r.dx * r.v, rvz = hz * sp - r.dz * r.v;
  const rel = Math.max(Math.sqrt(rvx * rvx + rvz * rvz), (car.vGround ?? 0) - r.v);
  if (rel < HIT_MIN) return false;
  const hl = len / 2 + 0.28, hw = wid / 2 + 0.2;
  // the bicycle is two wheels long: a circle at each
  for (let k = -1; k <= 1; k += 2) {
    const px = dx + r.dx * 0.42 * k, pz = dz + r.dz * 0.42 * k;
    const f = px * hx + pz * hz, l = px * hz - pz * hx;
    if (f < hl && f > -hl && l < hw && l > -hw) return true;
  }
  return false;
}

/**
 * Has a car hit this rider? The player's is asked every frame, the traffic's
 * when `scan` says it is this rider's turn. Returns true if they were knocked
 * off (the caller takes them out of the list).
 */
export function hitStep(sys, r, pc, scan) {
  if (r.hitCd > 0) return false;
  if (pc && carHits(pc, r, false)) return knock(sys, r, pc);
  const cars = scan ? sys.traffic?.cars : null;
  if (cars) for (const car of cars) if (car !== pc && carHits(car, r, true)) return knock(sys, r, car);
  return false;
}

// Off the bike. The machine falls where it is and slides; the rider becomes a
// free body of the CROWD's, thrown through its one door for every injury
// (js/pedestrians.js hurt), so the scream, the panic, the ambulance and the
// charge against the player's licence are the ones a walker would have got.
function knock(sys, r, car) {
  const s = car.vGround ?? Math.abs(car.speed ?? 0);
  const dirS = (car.speed ?? 0) >= 0 ? 1 : -1;
  const fx = -Math.sin(car.heading) * dirS, fz = -Math.cos(car.heading) * dirS;
  const side = (r.x - car.x) * -fz + (r.z - car.z) * fx < 0 ? -1 : 1;
  if (sys.wrecks.length >= 8) sys.wrecks.shift();
  sys.wrecks.push({
    type: r.type, paint: r.paint, scale: r.scale, x: r.x, y: r.y, z: r.z, gy: r.y,
    heading: r.heading, pitch: 0, roll: r.roll, rollT: side * 1.43, steer: r.steer + side * 0.5,
    spin: r.spin, crank: r.crank,
    vx: fx * s * 0.6 + r.dx * r.v * 0.4, vz: fz * s * 0.6 + r.dz * r.v * 0.4, av: side * Math.min(4, 0.6 + s * 0.3),
    t: 0, life: 75, far: false,
  });
  const sch = r.s;
  if (sch.body === r) { sch.body = null; sch.held = 1; }
  sys.stats.knocked++;
  const c = r.c, m = r.mesh, peds = sys.peds;
  if (!peds) { c.dispose(); return true; }
  // back to the crowd's own conventions: its tumble turns the group about x and z
  m.rotation.order = 'XYZ';
  m.rotation.set(0, r.heading, 0);
  c.standPose();
  // the stretch of line they were on is where they walk, if they get up
  const plan = sch.plan, a0 = Math.max(0, r.arc - 30), a1 = Math.min(plan.len, r.arc + 30), pts = [];
  _h.k = 0; _h.s = 0;
  for (let i = 0; i <= 6; i++) { planPose(plan, a0 + (a1 - a0) * i / 6, _h, _P); pts.push([_P.x, _P.z]); }
  const p = {
    mesh: m, animate: c.walk, sitPose: c.sitPose, ragdollPose: c.ragdollPose, standPose: c.standPose, dispose: c.dispose,
    sch: null, free: 1, look: c.look, pid: sch.seed, hp: PED_HP, headTop: c.headTop,
    steps: [{ r: { p: pts }, off: 0, dir: 1, base: 0, len: a1 - a0 }], side: 0.5, cross: null, tight: null, bay: null,
    pose: 0, rArc: r.arc - a0, stepT: 0, sitDrop: 0, boardCar: null, boardT: 0, boardDone: false, checkT: 0, blendK: 0.8,
    lateS: null, lateT0: 0, gx: 1e9, gz: 1e9, gy: null,
    x: r.x, z: r.z, heading: r.heading, walkT: 0, speed: 1.3, rush: 0, rushT: 0, calm: 0, fleeSign: 1,
    fArc: r.arc - a0, fDir: 1, fSpan: a1 - a0, fLo: 0, ghostT: 0, fHold: 0,
    state: 'walk', dead: false, y: 0.55 * r.gscale, lieY: 0,
    vx: 0, vy: 0, vz: 0, avx: 0, avz: 0, bounced: false,
    hitCd: 0, hurtS: 0, downT: 0, deadT: 0, blend: 0, bx: 0, bz: 0, heldArc: 0, cause: null, by: null,
  };
  peds.peds.push(p);
  const kick = s * 0.9 + 2, b = _blow;
  b.dmg = s > KILL_SPEED ? PED_HP : 0;
  b.launch = true;
  b.vx = fx * kick - fz * side * 1.2 + r.dx * r.v * 0.5;
  b.vz = fz * kick + fx * side * 1.2 + r.dz * r.v * 0.5;
  b.vy = Math.min(6, 1.5 + s * 0.25);
  b.spin = Math.min(9, 2 + s * 0.6);
  b.impact = Math.max(s, r.v * 0.6);
  b.panic = 25;
  b.cause = C_CAR;
  // whose fault: a car that was standing still was ridden into, and its
  // driver is not charged with it
  b.by = s > HIT_MIN ? car : null;
  peds.hurt(p, b);
  return true;
}

// ---- a bicycle with nobody on it -------------------------------------------------------

export function wreckStep(sys, w, dt, cx, cz) {
  w.t += dt;
  const sp = Math.sqrt(w.vx * w.vx + w.vz * w.vz);
  if (sp > 0.05) {
    const k = Math.max(0, sp - 7 * dt) / sp;
    w.vx *= k; w.vz *= k;
    w.x += w.vx * dt; w.z += w.vz * dt;
    w.heading += w.av * dt;
    w.av -= w.av * Math.min(1, dt * 3);
    if (sys.ground) { const g = sys.ground.heightAt(w.x, w.z); if (Number.isFinite(g)) w.gy = g; }
  }
  w.roll += (w.rollT - w.roll) * Math.min(1, dt * 7);
  const lie = Math.abs(Math.sin(w.roll));
  // lying on its side it rests on a pedal and a bar end; at the end it sinks
  // away, as the crowd's dead do
  const sink = w.t > w.life ? (w.t - w.life) * 0.4 : 0;
  const dx = w.x - cx, dz = w.z - cz, d = Math.sqrt(dx * dx + dz * dz);
  _B.type = w.type; _B.x = w.x; _B.y = w.gy + lie * 0.12 * w.scale - sink; _B.z = w.z;
  _B.heading = w.heading; _B.pitch = 0; _B.roll = w.roll; _B.steer = w.steer; _B.spin = w.spin; _B.crank = w.crank;
  _B.scale = w.scale; _B.paint = w.paint; _B.far = d > FAR_OUT; _B.camD = d; _B.lit = false;
  sys.fleet.put(_B);
}
