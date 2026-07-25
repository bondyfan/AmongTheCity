// ---- Vehicles: low-poly cars + arcade drive physics (v3: region fleet) ----
// Cars are the city's second citizens: traffic.js marches a swarm of them
// along the road graph (setting x/z/heading/speed directly) and the player
// steals one and drives it through driveStep(). Geometry is built ONCE per
// kind and materials are cached per paint color, so traffic can churn cars
// at the despawn ring without allocating anything that matters.
//
// v3 additions: per-kind engine specs with a (1 − v/vmax)^1.3 power curve
// (top speed approached asymptotically, sedan 0–100 in ~9 s), four new
// silhouettes (kombi/suv/truck/bus), progressive drift (grip falls as you
// ask the tyres for more steer×speed at once), and car-car collision via a
// two-circle body model against the `others` iterable — rammed AI cars get
// `_rammedT = 2.5` so traffic.js knows to go limp and re-snap later.
//
// Convention (ARCHITECTURE.md): heading 0 faces −z (north); a mesh authored
// facing −z with mesh.rotation.y = heading moves along
// (dirX, dirZ) = (−sin h, −cos h); the right-hand side is (cos h, −sin h).
// ctl.steer > 0 means steer RIGHT, which in this frame DECREASES heading.

import * as THREE from 'three';
import { CAR, CAR_COLORS } from './config.js';

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ---- shared materials (glass/rubber/lamps never vary; body paint is cached) --
const glassMat = new THREE.MeshLambertMaterial({ color: 0x1b2126 });
const wheelMat = new THREE.MeshLambertMaterial({ color: 0x24262a });
// truck cargo boxes are always that faded fleet-white, never body-color
const cargoMat = new THREE.MeshLambertMaterial({ color: 0xbcbfba });
// lamps overbright (×2.5) so the bloom pass has something to bite on at night
const headMat = new THREE.MeshLambertMaterial({ color: 0xfff3d0, emissive: 0xffedb8, emissiveIntensity: 2.5, toneMapped: false });
const tailMat = new THREE.MeshLambertMaterial({ color: 0x7a1616, emissive: 0xff2418, emissiveIntensity: 2.5, toneMapped: false });
// main drives these at dusk: one assignment lights every car in the city
export const lampMats = { head: headMat, tail: tailMat };
const _bodyMats = new Map();
const bodyMatFor = (hex) => {
  let m = _bodyMats.get(hex);
  if (!m) _bodyMats.set(hex, m = new THREE.MeshLambertMaterial({ color: hex }));
  return m;
};

// ---- per-kind silhouette + engine specs ----
// Silhouette: cabW/cabL are fractions of body wid/len; cabZ shifts the cabin
// (meters, +z = rearward, cars face −z); taperF/R/X shrink the cabin's
// front/rear/sides toward the roof — the classic low-poly wedge (vans stay
// boxy, hatches keep a tall tail, the kombi stretches the sedan roof to a
// near-vertical tailgate, the suv rides tall and square, the bus is one long
// volume whose window band runs the whole flank). axle overrides the default
// wheel placement (long vehicles tuck their axles inside the overhangs);
// cargo grows the truck its separate box body. Collision & physics read
// len/wid off the car, not off CAR, so a bus really is a wall on wheels.
//
// Engine: vmax in m/s (contract km/h ÷ 3.6); accel is the PEAK m/s² fed into
// the a = accel·(1 − v/vmax)^1.3 curve, which integrates to
// t(v1) = vmax·((1 − v1/vmax)^−0.3 − 1) / (0.3·accel) — the tunes below give
// sedan ~9.0 s to 100 km/h, hatch ~10, kombi ~9.9, suv ~10.5, van ~14.5,
// truck ~20 s to 80, bus ~17 s to 80. grip is the lateral damping the drift
// model starts from (tall/heavy kinds slide sooner); mass is tonnes-ish and
// only its RATIOS matter (collision impulse + separation splits).
const KIND = {
  sedan: { len: CAR.len, wid: CAR.wid, bodyY: 0.30, bodyH: 0.52, wheelR: 0.32,
    cabW: 0.86, cabH: 0.46, cabL: 0.42, cabZ: 0.24, taperF: 0.45, taperR: 0.72, taperX: 0.80,
    accel: 5.2, vmax: 175 / 3.6, grip: 7.5, mass: 1.4 },
  hatch: { len: 3.7, wid: 1.7, bodyY: 0.30, bodyH: 0.50, wheelR: 0.31,
    cabW: 0.88, cabH: 0.50, cabL: 0.48, cabZ: 0.38, taperF: 0.50, taperR: 0.94, taperX: 0.82,
    accel: 5.4, vmax: 150 / 3.6, grip: 8.0, mass: 1.15 },
  kombi: { len: 4.55, wid: 1.8, bodyY: 0.30, bodyH: 0.52, wheelR: 0.32,
    cabW: 0.86, cabH: 0.46, cabL: 0.58, cabZ: 0.50, taperF: 0.45, taperR: 0.95, taperX: 0.80,
    accel: 5.0, vmax: 165 / 3.6, grip: 7.2, mass: 1.55 },
  suv: { len: 4.5, wid: 1.9, bodyY: 0.40, bodyH: 0.62, wheelR: 0.38,
    cabW: 0.90, cabH: 0.60, cabL: 0.55, cabZ: 0.25, taperF: 0.55, taperR: 0.88, taperX: 0.88,
    accel: 4.8, vmax: 160 / 3.6, grip: 6.6, mass: 2.0 },
  van: { len: 4.8, wid: 1.9, bodyY: 0.34, bodyH: 0.58, wheelR: 0.36,
    cabW: 0.94, cabH: 0.88, cabL: 0.78, cabZ: 0.14, taperF: 0.62, taperR: 0.98, taperX: 0.90,
    accel: 4.6, vmax: 130 / 3.6, grip: 6.2, mass: 2.6 },
  truck: { len: 7.6, wid: 2.3, bodyY: 0.35, bodyH: 0.55, wheelR: 0.42, wheelW: 0.36,
    cabW: 0.96, cabH: 1.15, cabL: 0.23, cabZ: -2.7, taperF: 0.75, taperR: 1.0, taperX: 0.94,
    axle: 2.9, cargo: { w: 2.24, h: 2.05, l: 4.9, y: 0.90, z: 1.20 },
    accel: 3.2, vmax: 95 / 3.6, grip: 5.6, mass: 10 },
  bus: { len: 11.0, wid: 2.5, bodyY: 0.30, bodyH: 0.85, wheelR: 0.45, wheelW: 0.36,
    cabW: 0.99, cabH: 1.35, cabL: 0.97, cabZ: 0, taperF: 0.85, taperR: 0.90, taperX: 0.95,
    axle: 3.4,
    accel: 3.0, vmax: 105 / 3.6, grip: 5.2, mass: 13 },
};
// spawn code rolls from this — declared order = KIND order, common cars first
export const CAR_KINDS = ['sedan', 'hatch', 'kombi', 'suv', 'van', 'truck', 'bus'];

// ---- drift + collision tunables (module-local: config.js owns the shared CAR
// numbers, these are v3 vehicle-only feel constants) ----
const DRIFT_FREE = 2.5;   // steer(rad)×speed(m/s) the tyres absorb before slipping
const DRIFT_K = 0.35;     // how fast grip collapses past that (progressive slide)
const HB_GRIP = 0.18;     // handbrake grip multiplier — rear axle basically gone
const HB_YAW = 1.7;       // handbrake yaw gain: the flick that swings the tail
const HIT_SCRUB = 0.55;   // fraction of closing speed a car-car impact eats (40–70% band)
const HIT_RANGE2 = 144;   // 12 m center-distance gate — covers even bus vs bus nose-to-nose

// A box whose cross-section tapers LINEARLY with height (t: 0 at the cabin
// base → 1 at the roof). yBase/hTotal let the window band cut a slice out of
// the same taper profile, so its faces follow the cabin slant exactly and the
// `grow` margin pokes them a few cm through the paint — instant windows, no
// second geometry pass. Normals recomputed because the slant bends the sides.
function taperBox(w, h, l, K, yBase = 0, hTotal = h, grow = 1) {
  const g = new THREE.BoxGeometry(w, h, l);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (yBase + p.getY(i) + h / 2) / hTotal;
    p.setX(i, p.getX(i) * (1 + (K.taperX - 1) * t) * grow);
    const z = p.getZ(i);
    p.setZ(i, z * (1 + ((z < 0 ? K.taperF : K.taperR) - 1) * t) * grow);
  }
  g.computeVertexNormals();
  return g;
}

// one geometry set per kind, built lazily and shared by every car forever
const _geo = new Map();
function geomFor(kind) {
  let g = _geo.get(kind);
  if (g) return g;
  const K = KIND[kind] ?? KIND.sedan;
  const body = new THREE.BoxGeometry(K.wid, K.bodyH, K.len);
  body.translate(0, K.bodyY + K.bodyH / 2, 0);
  const cw = K.wid * K.cabW, cl = K.len * K.cabL, top = K.bodyY + K.bodyH;
  const cabin = taperBox(cw, K.cabH, cl, K);
  cabin.translate(0, top + K.cabH / 2, K.cabZ);
  // window band: the 28%..68% height slice of the cabin, grown 3.5%. On the
  // bus the cabin spans nearly the whole length, so this same slice becomes
  // the full-flank window band; on the truck it's just the cab glazing.
  const band = taperBox(cw, K.cabH * 0.4, cl, K, K.cabH * 0.28, K.cabH, 1.035);
  band.translate(0, top + K.cabH * 0.48, K.cabZ);
  const wheel = new THREE.CylinderGeometry(K.wheelR, K.wheelR, K.wheelW ?? 0.24, 10);
  wheel.rotateZ(Math.PI / 2);            // cylinder axis onto x → rolling = rotation.x
  const light = new THREE.BoxGeometry(0.28, 0.13, 0.08);
  let cargo = null;
  if (K.cargo) {                         // truck: separate box body riding the chassis,
    const c = K.cargo;                   // taller than the cab like the real thing
    cargo = new THREE.BoxGeometry(c.w, c.h, c.l);
    cargo.translate(0, c.y + c.h / 2, c.z);
  }
  _geo.set(kind, g = { body, cabin, band, wheel, light, cargo, K });
  return g;
}

// ---- makeCarMesh(colorHex[, kind]) → { group, wheels } ----
// group origin sits at ground level under the car's center. Body, cabin, band
// and lamps live in an inner "body" group so suspension roll/pitch tilts the
// shell while the wheels stay planted. wheels = [FL, FR, RL, RR] (front = −z);
// front wheels use YXZ euler order so steering yaw and rolling spin compose.
export function makeCarMesh(colorHex, kind = 'sedan') {
  const g = geomFor(kind), K = g.K;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paint = bodyMatFor(colorHex);
  const shell = new THREE.Mesh(g.body, paint);
  const cabin = new THREE.Mesh(g.cabin, paint);
  const band = new THREE.Mesh(g.band, glassMat);
  shell.castShadow = cabin.castShadow = true;
  body.add(shell, cabin, band);
  if (g.cargo) {
    const box = new THREE.Mesh(g.cargo, cargoMat);
    box.castShadow = true;
    body.add(box);
  }
  for (let i = 0; i < 4; i++) {          // lamps: 2 head (−z), 2 tail (+z)
    const front = i < 2;
    const lamp = new THREE.Mesh(g.light, front ? headMat : tailMat);
    lamp.position.set((i & 1 ? 1 : -1) * (K.wid / 2 - 0.34),
      K.bodyY + K.bodyH * 0.62, front ? -K.len / 2 : K.len / 2);
    body.add(lamp);
  }
  // long kinds tuck the axles inside the overhangs (a bus pivots mid-body,
  // not at the bumpers) — K.axle overrides the wheels-at-the-corners default
  const ax = K.axle ?? (K.len / 2 - K.wheelR - 0.35);
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(g.wheel, wheelMat);
    w.rotation.order = 'YXZ';
    w.position.set((i & 1 ? 1 : -1) * (K.wid / 2 - 0.07), K.wheelR, (i < 2 ? -1 : 1) * ax);
    group.add(w);
    wheels.push(w);
  }
  group.userData.body = body;
  group.userData.wheelR = K.wheelR;
  return { group, wheels };
}

// ---- Vehicles: owns every car mesh in the scene, animates the dressing ----
export class Vehicles {
  constructor(scene) {
    this.scene = scene;
    this.cars = new Set();
  }

  // kind: any of CAR_KINDS. Fields beyond the contract shape (y and the
  // _underscored ones) are internal: y is the bridge-deck height, _rammedT
  // is the "just got hit" timer traffic.js watches, the rest is
  // suspension/drift state.
  add(kind, x, z, heading, color) {
    if (color === undefined) color = CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
    const K = KIND[kind] ?? KIND.sedan;
    const { group, wheels } = makeCarMesh(color, kind);
    const car = { mesh: group, wheels, x, z, heading, speed: 0, steer: 0,
      kind, color, len: K.len, wid: K.wid, ai: null,
      y: 0, _lat: 0, _pv: 0, _acc: 0, _roll: 0, _pitch: 0, _rammedT: 0 };
    group.position.set(x, 0, z);
    group.rotation.y = heading;
    this.scene.add(group);
    this.cars.add(car);
    return car;
  }

  remove(car) {
    this.cars.delete(car);
    this.scene.remove(car.mesh);         // geometry + materials are shared: keep them
  }

  // Sync meshes from car state, spin wheels, settle the suspension tilt.
  // Works the same for AI cars (traffic writes x/z/heading/speed) and the
  // player's (driveStep writes them) — pitch is derived from the measured
  // speed delta, so braking AI cars dip their nose too.
  update(dt) {
    if (dt <= 0) return;
    const k = Math.min(1, 8 * dt);
    for (const car of this.cars) {
      const m = car.mesh;
      m.position.set(car.x, car.y, car.z);
      m.rotation.y = car.heading;
      const spin = car.speed * dt / m.userData.wheelR;
      for (let i = 0; i < 4; i++) {
        const w = car.wheels[i];
        // forward (−z) travel spins the axle negative; wrap so the angle
        // never drifts into float-precision territory on long drives
        w.rotation.x = (w.rotation.x - spin) % (Math.PI * 2);
        if (i < 2) w.rotation.y = -car.steer;   // steer right → yaw right (−y)
      }
      // suspension: lean OUT of turns, squat on throttle, dive on the brakes
      const acc = (car.speed - car._pv) / Math.max(dt, 1e-4);
      car._pv = car.speed;
      car._acc += (acc - car._acc) * Math.min(1, 6 * dt);   // smooth the jitter
      car._roll += (clamp(car.steer * car.speed * 0.004, -0.05, 0.05) - car._roll) * k;
      car._pitch += (clamp(car._acc * 0.008, -0.05, 0.05) - car._pitch) * k;
      const b = m.userData.body;
      b.rotation.z = car._roll;          // +z roll lifts the right flank = lean left
      b.rotation.x = car._pitch;         // +x pitch lifts the nose
    }
  }
}

// ---- driveStep(car, ctl, dt, world, others): the player's arcade physics ----
// ctl = { gas: −1..1, steer: −1..1, brake: 0|1 (handbrake) }; others is an
// iterable of other cars for car-car collision (may contain `car` — skipped;
// omit it and the step degrades gracefully to walls-only, v2 behavior).
const _pt = { x: 0, z: 0 };
export function driveStep(car, ctl, dt, world, others) {
  dt = Math.min(dt, 1 / 20);             // tab-return dt spikes must not teleport us
  const K = KIND[car.kind] ?? KIND.sedan;

  // steering lock falls with speed (falloff runs on km/h — the config K was
  // tuned so full lock at 130 km/h is a sane sweep, not a spin): parking-lot
  // tight at walking pace, highway-stable flat out. car.steer chases the
  // target so the wheel visibly winds over instead of snapping.
  const lock = CAR.steerMax / (1 + CAR.steerSpeedK * Math.abs(car.speed) * 3.6);
  car.steer += (clamp(ctl.steer ?? 0, -1, 1) * lock - car.steer) * Math.min(1, 9 * dt);

  // longitudinal: gas>0 accelerates (or brakes out of reverse), gas<0 brakes
  // then backs up. Engine force follows a = accel·(1 − v/vmax)^1.3 — strong
  // off the line, wheezing near the top, vmax approached asymptotically (a
  // sedan does 0–100 in ~9 s and then crawls toward 175). With the pedals
  // released, drag + rolling resistance bleed the speed off on their own —
  // that's the only place they apply, so vmax really is vmax at full throttle.
  const gas = clamp(ctl.gas ?? 0, -1, 1);
  let s = car.speed;
  if (gas > 0.01) {
    if (s < -0.05) s = Math.min(0, s + CAR.brake * gas * dt);
    else {
      // max(0,…): a collision impulse can leave s a hair over vmax, and a
      // negative base under ^1.3 is NaN — clamp the headroom, not the speed
      const a = K.accel * Math.pow(Math.max(0, 1 - s / K.vmax), 1.3);
      s = Math.min(K.vmax, s + a * gas * dt);
    }
  } else if (gas < -0.01) {
    s = s > 0.05 ? Math.max(0, s + CAR.brake * gas * dt)      // gas is negative
      : Math.max(-CAR.vrev, s + K.accel * 0.7 * gas * dt);
  } else {
    const res = (CAR.drag * Math.abs(s) + CAR.roll) * dt;
    s = Math.abs(s) <= res ? 0 : s - Math.sign(s) * res;
  }
  // PROGRESSIVE DRIFT: tyres hold up to DRIFT_FREE of steer×speed for free,
  // then grip collapses the harder you push — a gentle bend tracks clean, the
  // same wheel angle at twice the speed breaks the rear loose and the slide
  // grows until you unwind the wheel (countersteer works because grip
  // recovers the instant steer×speed drops).
  const slip = Math.abs(car.steer * s);
  let grip = K.grip / (1 + DRIFT_K * Math.max(0, slip - DRIFT_FREE));
  let yawGain = 1;
  if (ctl.brake) {                       // handbrake: hard scrub + rear grip gone
    const b = CAR.brake * 1.3 * dt;
    s = Math.abs(s) <= b ? 0 : s - Math.sign(s) * b;
    grip *= HB_GRIP;
    // with the rear locked the car rotates around the FRONT axle — boost yaw
    // so a flick of steer swings the tail out (proper smyk), but only at
    // speed: stationary handbrake donuts are not a thing
    if (Math.abs(s) > 4) yawGain = HB_YAW;
  }
  car.speed = s;

  // yaw from a kinematic bicycle; the heading change sheds a slice of the
  // velocity into a lateral component (the nose turns, momentum lags), which
  // grip then damps away — mild drift in a fast bend, a proper slide on the
  // handbrake. Reversing flips s and with it the turn direction, for free.
  // Long wheelbases (truck/bus) yaw slower through the same len·0.6 term.
  const dTh = -Math.tan(car.steer) * (s / (car.len * 0.6)) * yawGain * dt;
  car.heading += dTh;
  car._lat = ((car._lat ?? 0) + s * dTh) * Math.exp(-grip * dt);

  const h = car.heading;
  const fx = -Math.sin(h), fz = -Math.cos(h);   // forward
  const rx = Math.cos(h), rz = -Math.sin(h);    // right
  car.x += (fx * s + rx * car._lat) * dt;
  car.z += (fz * s + rz * car._lat) * dt;

  // ---- CAR-CAR: two-circle bodies, mass-weighted shove ----
  // Each car ≈ two discs riding its long axis (front/rear, r ≈ wid·0.62) —
  // the cheapest shape that lets glancing hits slide off and T-bones connect
  // at the door instead of a phantom bbox corner. Runs BEFORE the wall pass
  // so a shoved player still ends the frame outside the architecture.
  if (others) {
    const rA = car.wid * 0.62, dA = Math.max(0, car.len / 2 - rA);
    for (const o of others) {
      if (o === car) continue;           // the iterable may contain ourselves
      const cdx = car.x - o.x, cdz = car.z - o.z;
      if (cdx * cdx + cdz * cdz > HIT_RANGE2) continue;   // 12 m gate
      const ofx = -Math.sin(o.heading), ofz = -Math.cos(o.heading);
      const rB = o.wid * 0.62, dB = Math.max(0, o.len / 2 - rB);
      const mA = (KIND[car.kind] ?? KIND.sedan).mass;
      const mB = (KIND[o.kind] ?? KIND.sedan).mass;
      const wA = mB / (mA + mB), wB = mA / (mA + mB);     // light party moves more
      for (let ci = -1; ci <= 1; ci += 2) for (let cj = -1; cj <= 1; cj += 2) {
        const aox = fx * dA * ci, aoz = fz * dA * ci;     // our disc, their disc
        const box = ofx * dB * cj, boz = ofz * dB * cj;
        let nx = (car.x + aox) - (o.x + box), nz = (car.z + aoz) - (o.z + boz);
        const d2 = nx * nx + nz * nz, rr = rA + rB;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-6;
        nx /= d; nz /= d;                // contact normal, other → us
        const pen = rr - d;
        car.x += nx * pen * wA; car.z += nz * pen * wA;   // separate both bodies
        o.x -= nx * pen * wB; o.z -= nz * pen * wB;
        // impulse: scrub HIT_SCRUB of the closing speed along the normal and
        // hand it out by mass ratio — a truck barely feels a hatch, a hatch
        // very much feels a truck
        const vRx = (fx * s + rx * car._lat) - ofx * o.speed;
        const vRz = (fz * s + rz * car._lat) - ofz * o.speed;
        const closing = -(vRx * nx + vRz * nz);           // >0 when approaching
        if (closing > 0) {
          const imp = closing * HIT_SCRUB;
          // our delta-v decomposed back into the scalar speed + lateral slide
          car.speed += (nx * fx + nz * fz) * imp * wA;
          car._lat += (nx * rx + nz * rz) * imp * wA;
          // the other car only carries a scalar speed — project its shove onto
          // its own forward, clamp against absurd launches
          o.speed = clamp(o.speed - (nx * ofx + nz * ofz) * imp * wB, -55, 55);
          // off-center hits twist both cars (same torque form as the wall hit)
          car.heading += clamp((aoz * nx - aox * nz) * imp * 0.02, -0.05, 0.05);
          o.heading += clamp((boz * -nx - box * -nz) * imp * 0.02, -0.04, 0.04);
        }
        o._rammedT = 2.5;                // tell the traffic AI it just got hit
      }
    }
  }

  // 4-corner sampling against buildings + water (6 points on truck/bus — a
  // long flank must not thread itself through a building corner): any pushed
  // point drags the whole car with it, the 2D torque of the push glances the
  // nose off the wall, and the impact scrubs 60% of the speed. Points are
  // pulled slightly inboard so brushing a wall reads as paint contact, not a
  // force field.
  const hl = car.len / 2 - 0.2, hw = car.wid / 2 - 0.1;
  const nPts = car.len > 5.5 ? 6 : 4;
  let hit = false;
  for (let i = 0; i < nPts; i++) {
    const of = i < 2 ? hl : i < 4 ? -hl : 0, os = i & 1 ? hw : -hw;
    const wox = fx * of + rx * os, woz = fz * of + rz * os;
    _pt.x = car.x + wox; _pt.z = car.z + woz;
    const ox = _pt.x, oz = _pt.z;
    if (world.collide(_pt, 0.5)) {
      const px = _pt.x - ox, pz = _pt.z - oz;
      car.x += px; car.z += pz;
      car.heading += clamp((woz * px - wox * pz) * 0.03, -0.05, 0.05);
      hit = true;
    }
  }
  if (hit) { car.speed *= 0.4; car._lat *= 0.3; }

  car.y = world.heightAt(car.x, car.z);  // bridge decks lift the car
}
