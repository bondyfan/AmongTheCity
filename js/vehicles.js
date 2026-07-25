// ---- Vehicles: low-poly cars + arcade drive physics ----
// Cars are the city's second citizens: traffic.js marches a swarm of them
// along the road graph (setting x/z/heading/speed directly) and the player
// steals one and drives it through driveStep(). Geometry is built ONCE per
// kind and materials are cached per paint color, so traffic can churn cars
// at the despawn ring without allocating anything that matters.
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
// lamps overbright (×2.5) so the bloom pass has something to bite on at night
const headMat = new THREE.MeshLambertMaterial({ color: 0xfff3d0, emissive: 0xffedb8, emissiveIntensity: 2.5 });
const tailMat = new THREE.MeshLambertMaterial({ color: 0x7a1616, emissive: 0xff2418, emissiveIntensity: 2.5 });
const _bodyMats = new Map();
const bodyMatFor = (hex) => {
  let m = _bodyMats.get(hex);
  if (!m) _bodyMats.set(hex, m = new THREE.MeshLambertMaterial({ color: hex }));
  return m;
};

// ---- per-kind proportions ----
// cabW/cabL are fractions of body wid/len; cabZ shifts the cabin rearward
// (+z, cars face −z); taperF/R/X shrink the cabin's front/rear/sides toward
// the roof — the classic low-poly wedge (vans stay boxy, hatches keep a tall
// tail). Collision & physics read len/wid off the car, not off CAR, so the
// van really is a fatter target than the hatch.
const KIND = {
  sedan: { len: CAR.len, wid: CAR.wid, bodyY: 0.30, bodyH: 0.52, wheelR: 0.32,
    cabW: 0.86, cabH: 0.46, cabL: 0.42, cabZ: 0.24, taperF: 0.45, taperR: 0.72, taperX: 0.80 },
  hatch: { len: 3.7, wid: 1.7, bodyY: 0.30, bodyH: 0.50, wheelR: 0.31,
    cabW: 0.88, cabH: 0.50, cabL: 0.48, cabZ: 0.38, taperF: 0.50, taperR: 0.94, taperX: 0.82 },
  van: { len: 4.8, wid: 1.9, bodyY: 0.34, bodyH: 0.58, wheelR: 0.36,
    cabW: 0.94, cabH: 0.88, cabL: 0.78, cabZ: 0.14, taperF: 0.62, taperR: 0.98, taperX: 0.90 },
};

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
  // window band: the 28%..68% height slice of the cabin, grown 3.5%
  const band = taperBox(cw, K.cabH * 0.4, cl, K, K.cabH * 0.28, K.cabH, 1.035);
  band.translate(0, top + K.cabH * 0.48, K.cabZ);
  const wheel = new THREE.CylinderGeometry(K.wheelR, K.wheelR, 0.24, 10);
  wheel.rotateZ(Math.PI / 2);            // cylinder axis onto x → rolling = rotation.x
  const light = new THREE.BoxGeometry(0.28, 0.13, 0.08);
  _geo.set(kind, g = { body, cabin, band, wheel, light, K });
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
  for (let i = 0; i < 4; i++) {          // lamps: 2 head (−z), 2 tail (+z)
    const front = i < 2;
    const lamp = new THREE.Mesh(g.light, front ? headMat : tailMat);
    lamp.position.set((i & 1 ? 1 : -1) * (K.wid / 2 - 0.34),
      K.bodyY + K.bodyH * 0.62, front ? -K.len / 2 : K.len / 2);
    body.add(lamp);
  }
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(g.wheel, wheelMat);
    w.rotation.order = 'YXZ';
    w.position.set((i & 1 ? 1 : -1) * (K.wid / 2 - 0.07), K.wheelR,
      (i < 2 ? -1 : 1) * (K.len / 2 - K.wheelR - 0.35));
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

  // kind: 'sedan'|'hatch'|'van'. Fields beyond the contract shape (y and the
  // _underscored ones) are internal: y is the bridge-deck height, the rest is
  // suspension/drift state.
  add(kind, x, z, heading, color) {
    if (color === undefined) color = CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
    const K = KIND[kind] ?? KIND.sedan;
    const { group, wheels } = makeCarMesh(color, kind);
    const car = { mesh: group, wheels, x, z, heading, speed: 0, steer: 0,
      kind, color, len: K.len, wid: K.wid, ai: null,
      y: 0, _lat: 0, _pv: 0, _acc: 0, _roll: 0, _pitch: 0 };
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

// ---- driveStep(car, ctl, dt, world): the player's arcade physics ----
// ctl = { gas: −1..1, steer: −1..1, brake: 0|1 (handbrake) }.
const _pt = { x: 0, z: 0 };
export function driveStep(car, ctl, dt, world) {
  dt = Math.min(dt, 1 / 20);             // tab-return dt spikes must not teleport us

  // steering lock falls with speed (falloff runs on km/h — the config K was
  // tuned so full lock at 130 km/h is a sane sweep, not a spin): parking-lot
  // tight at walking pace, highway-stable flat out. car.steer chases the
  // target so the wheel visibly winds over instead of snapping.
  const lock = CAR.steerMax / (1 + CAR.steerSpeedK * Math.abs(car.speed) * 3.6);
  car.steer += (clamp(ctl.steer ?? 0, -1, 1) * lock - car.steer) * Math.min(1, 9 * dt);

  // longitudinal: gas>0 accelerates (or brakes out of reverse), gas<0 brakes
  // then backs up; with the pedals released, drag + rolling resistance bleed
  // the speed off on their own — that's the only place they apply, so vmax
  // really is vmax under full throttle.
  const gas = clamp(ctl.gas ?? 0, -1, 1);
  let s = car.speed;
  if (gas > 0.01) {
    s = s < -0.05 ? Math.min(0, s + CAR.brake * gas * dt)
      : Math.min(CAR.vmax, s + CAR.accel * gas * dt);
  } else if (gas < -0.01) {
    s = s > 0.05 ? Math.max(0, s + CAR.brake * gas * dt)      // gas is negative
      : Math.max(-CAR.vrev, s + CAR.accel * 0.7 * gas * dt);
  } else {
    const res = (CAR.drag * Math.abs(s) + CAR.roll) * dt;
    s = Math.abs(s) <= res ? 0 : s - Math.sign(s) * res;
  }
  let grip = CAR.grip;
  if (ctl.brake) {                       // handbrake: hard scrub + rear grip gone
    const b = CAR.brake * 1.3 * dt;
    s = Math.abs(s) <= b ? 0 : s - Math.sign(s) * b;
    grip *= 0.22;
  }
  car.speed = s;

  // yaw from a kinematic bicycle; the heading change sheds a slice of the
  // velocity into a lateral component (the nose turns, momentum lags), which
  // grip then damps away — mild drift in a fast bend, a proper slide on the
  // handbrake. Reversing flips s and with it the turn direction, for free.
  const dTh = -Math.tan(car.steer) * (s / (car.len * 0.6)) * dt;
  car.heading += dTh;
  car._lat = ((car._lat ?? 0) + s * dTh) * Math.exp(-grip * dt);

  const h = car.heading;
  const fx = -Math.sin(h), fz = -Math.cos(h);   // forward
  const rx = Math.cos(h), rz = -Math.sin(h);    // right
  car.x += (fx * s + rx * car._lat) * dt;
  car.z += (fz * s + rz * car._lat) * dt;

  // 4-corner sampling against buildings + water: any pushed corner drags the
  // whole car with it, the 2D torque of the push glances the nose off the
  // wall, and the impact scrubs 60% of the speed. Corners are pulled slightly
  // inboard so brushing a wall reads as paint contact, not a force field.
  const hl = car.len / 2 - 0.2, hw = car.wid / 2 - 0.1;
  let hit = false;
  for (let i = 0; i < 4; i++) {
    const of = i < 2 ? hl : -hl, os = i & 1 ? hw : -hw;
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
