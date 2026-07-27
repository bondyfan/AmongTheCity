// ---- Saab JAS 39 Gripen: the fourth way through the world ----
// Boots, car, helicopter — and now something that crosses the whole 110 km
// world in under four minutes. The airframe is the one the Czech Air Force
// actually flies (14 of them out of Čáslav): a single-engine delta-canard,
// 14.1 m long, 8.4 m span, Mach 2 in clean air. That is 2 470 km/h, which is
// what the brief asked for with room to spare.
//
// The flight model is deliberately NOT the helicopter's. A helicopter is a mass
// hanging under a thrust vector and it can sit still in the air; a fighter is a
// dart that has to keep moving or it falls out of the sky. So velocity here
// simply follows the NOSE, and everything interesting comes from three real
// relationships:
//
//   • Top speed is not a constant, it is where thrust meets drag — and drag
//     scales with air density. At sea level this jet tops out around 1 400 km/h;
//     it takes ~10 km of altitude to see 2 400. Climbing is therefore not
//     decoration, it is how you go fast, which is exactly how the real thing
//     behaves.
//   • A turn is a banked turn: ω = g·tan(φ)/V. Roll the aircraft and the
//     heading follows, and because V is in the denominator, the faster you go
//     the wider you turn. No separate "steering" input exists in the air.
//   • Control authority scales with airspeed. Parked on the apron the stick
//     does nothing; below rotation speed you cannot lift the nose.
//
// Convention (ARCHITECTURE.md), identical to helicopter.js: heading 0 faces −z
// (north); a mesh authored facing −z and yawed by `heading` travels along
// (−sin h, −cos h). +x rotation lifts the nose, +z rotation lifts the right
// flank, so nose-down is NEGATIVE pitch and a right bank is NEGATIVE roll.
//
// ctl = { pitch, roll, yaw, throttle, brake }, each −1..1 and all optional:
//   pitch +1 = stick back (nose UP — this is an aircraft, not a car)
//   roll  +1 = bank right, yaw +1 = rudder right (nosewheel on the ground)
//   throttle 0..1, past AB_GATE the afterburner lights
//   brake +1 = wheel brakes (ground) / airbrake (in flight)
//
// Allocation discipline matches the rest of the engine: geometry and materials
// are built once and shared by every airframe; update() touches only scalars.

import * as THREE from 'three';

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const TAU = Math.PI * 2;
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---- flight tunables ------------------------------------------------------
// Chosen so the numbers a pilot would recognise fall out of the physics rather
// than being clamped on top of it.
// Thrust is quoted the way a pilot feels it: in g. A light fighter at full
// reheat pulls a little over 1 g down the runway, which is what makes the
// take-off roll a few hundred metres rather than a catapult shot — the first
// cut of these numbers was 4.5 g and rotated after 77 m, which is a cartoon.
const THRUST_DRY = 5.5;        // m/s² (0.56 g) at full military power
const THRUST_AB = 11;          // m/s² (1.12 g) with the afterburner lit
const AB_GATE = 0.86;          // throttle past this opens the burner
const V_MAX = 690;             // m/s hard ceiling (2 484 km/h ≈ Mach 2.01)
const SCALE_H = 8500;          // m — density scale height, drag ∝ exp(−y/H)
// drag constant set from the sea-level top speed: at ρ₀ the jet balances
// THRUST_AB at ~389 m/s (1 400 km/h), which is about right for a clean Gripen
// down low. Everything above that has to be bought with altitude — at 11 km
// the same thrust balances 743 m/s, so the V_MAX cap is what you actually meet.
const DRAG_K = THRUST_AB / (389 * 389);
const V_ROTATE = 70;           // m/s (252 km/h) — nose comes up here
const V_STALL = 52;            // m/s (187 km/h) — below this the wing quits
const G = 9.81;
const PITCH_RATE = 1.15;       // rad/s at full authority (~66°/s)
const ROLL_RATE = 3.6;         // rad/s (~206°/s) — a Gripen is very quick in roll
const YAW_RATE_AIR = 0.35;     // rudder is for trim, not for turning
const GND_STEER = 0.9;         // nosewheel authority, scaled down with speed
const ROLL_FRICTION = 0.9;     // m/s² rolling resistance on the tarmac
const BRAKE_DECEL = 6.5;       // m/s² wheel brakes
const AIRBRAKE = 9;            // m/s² of extra drag with the boards out
const GEAR_H = 1.35;           // m from the ground to the fuselage centreline
const AOA_LIFT = 0.9;          // how hard the wing pulls the velocity to the nose
const SINK_RATE = 14;          // m/s of sag when the wing has nothing to bite

// ---- shared geometry ------------------------------------------------------
// One Gripen's worth of boxes and wedges, built once. A delta-canard reads at a
// glance from three things — the long chined nose, the big delta with its
// leading edge sweeping back to the tail, and the little canards up by the
// cockpit — so those get the vertices and the rest is suggestion.
let _geom = null;
function fighterGeom() {
  if (_geom) return _geom;

  // A wedge/trapezoid prism from a 2-D outline in the xz plane, given a
  // thickness in y. This is the whole modelling vocabulary of the airframe.
  const slab = (pts, thick, taper = 1) => {
    const pos = [], idx = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x, z] = pts[i];
      pos.push(x, thick / 2 * taper, z);        // top ring
    }
    for (let i = 0; i < n; i++) {
      const [x, z] = pts[i];
      pos.push(x, -thick / 2, z);               // bottom ring
    }
    for (let i = 1; i < n - 1; i++) {           // caps (fan)
      idx.push(0, i, i + 1);
      idx.push(n, n + i + 1, n + i);
    }
    for (let i = 0; i < n; i++) {               // side wall
      const j = (i + 1) % n;
      idx.push(i, n + i, j);
      idx.push(j, n + i, n + j);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  // Fuselage: 14.1 m nose to nozzle, nose at −z. Chined forward section, a
  // waisted middle where the intakes sit, squared off at the engine.
  const fuse = slab([
    [0, -7.05], [0.42, -5.6], [0.62, -3.2], [0.70, 0.6], [0.62, 4.4], [0.46, 6.3],
    [-0.46, 6.3], [-0.62, 4.4], [-0.70, 0.6], [-0.62, -3.2], [-0.42, -5.6],
  ], 1.25);

  // Delta wing, both sides in one slab: 8.4 m span, leading edge swept ~45°,
  // trailing edge square to the nozzle.
  const wing = slab([
    [0.55, -1.9], [4.2, 3.9], [4.2, 5.3], [0.6, 5.3],
    [-0.6, 5.3], [-4.2, 5.3], [-4.2, 3.9], [-0.55, -1.9],
  ], 0.34);

  // Canards: the giveaway of the type. Small, high, and well forward.
  const canard = slab([
    [0.5, -4.5], [2.35, -3.1], [2.35, -2.35], [0.5, -3.0],
  ], 0.20);

  // Fin: single, swept, with the rudder implied by the trailing kink.
  const finPts = [[-3.4, 0], [-5.9, 0], [-6.3, 1.5], [-4.3, 2.9], [-3.4, 2.9]];
  const finPos = [], finIdx = [];
  for (const [z, y] of finPts) finPos.push(0.11, y, -z);
  for (const [z, y] of finPts) finPos.push(-0.11, y, -z);
  const fn = finPts.length;
  for (let i = 1; i < fn - 1; i++) { finIdx.push(0, i, i + 1); finIdx.push(fn, fn + i + 1, fn + i); }
  for (let i = 0; i < fn; i++) {
    const j = (i + 1) % fn;
    finIdx.push(i, fn + i, j); finIdx.push(j, fn + i, fn + j);
  }
  const fin = new THREE.BufferGeometry();
  fin.setAttribute('position', new THREE.Float32BufferAttribute(finPos, 3));
  fin.setIndex(finIdx);
  fin.computeVertexNormals();

  _geom = {
    fuse, wing, canard, fin,
    nose: new THREE.ConeGeometry(0.42, 2.4, 8).rotateX(-Math.PI / 2).translate(0, 0, -8.1),
    canopy: new THREE.SphereGeometry(0.52, 10, 6, 0, TAU, 0, Math.PI / 2)
      .scale(1, 0.72, 2.5).translate(0, 0.62, -3.6),
    intake: new THREE.BoxGeometry(0.52, 0.78, 2.6),
    nozzle: new THREE.CylinderGeometry(0.52, 0.62, 1.0, 10).rotateX(Math.PI / 2).translate(0, 0, 6.6),
    flame: new THREE.ConeGeometry(0.44, 3.4, 8).rotateX(Math.PI / 2).translate(0, 0, 8.6),
    pylon: new THREE.BoxGeometry(0.18, 0.3, 1.6),
    missile: new THREE.CylinderGeometry(0.11, 0.11, 2.9, 6).rotateX(Math.PI / 2),
    strut: new THREE.CylinderGeometry(0.075, 0.075, GEAR_H, 6),
    wheel: new THREE.CylinderGeometry(0.34, 0.34, 0.22, 10).rotateZ(Math.PI / 2),
    roundel: new THREE.CircleGeometry(0.42, 12).rotateX(-Math.PI / 2),
  };
  return _geom;
}

// Czech Air Force grey, with the red of the roundel as the only warm note.
const skinMat = new THREE.MeshLambertMaterial({ color: 0x6e747a, flatShading: true });
const skinDark = new THREE.MeshLambertMaterial({ color: 0x5c6167, flatShading: true });
const glassMat = new THREE.MeshLambertMaterial({ color: 0x2b3a46, flatShading: true,
  transparent: true, opacity: 0.72 });
const metalMat = new THREE.MeshLambertMaterial({ color: 0x3d4045, flatShading: true });
const roundelMat = new THREE.MeshBasicMaterial({ color: 0xb03a3a, toneMapped: false });
const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true,
  opacity: 0.85, toneMapped: false, depthWrite: false });

export function makeFighterMesh() {
  const g = fighterGeom();
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const hull = new THREE.Mesh(g.fuse, skinMat);
  hull.castShadow = true;
  const wing = new THREE.Mesh(g.wing, skinMat);
  wing.castShadow = true;
  wing.position.y = -0.18;
  const canard = new THREE.Mesh(g.canard, skinDark);
  canard.position.y = 0.30;
  body.add(hull, wing, canard,
    new THREE.Mesh(g.nose, skinMat),
    new THREE.Mesh(g.canopy, glassMat),
    new THREE.Mesh(g.fin, skinMat),
    new THREE.Mesh(g.nozzle, metalMat));

  for (let i = -1; i <= 1; i += 2) {            // side intakes under the canards
    const k = new THREE.Mesh(g.intake, skinDark);
    k.position.set(i * 0.86, -0.16, -2.2);
    body.add(k);
    const p = new THREE.Mesh(g.pylon, skinDark); // wing pylon + a missile on it
    p.position.set(i * 2.6, -0.42, 3.4);
    const m = new THREE.Mesh(g.missile, metalMat);
    m.position.set(i * 2.6, -0.72, 3.0);
    body.add(p, m);
    const r = new THREE.Mesh(g.roundel, roundelMat);  // roundel on each wing
    r.position.set(i * 2.5, 0.02, 4.2);
    body.add(r);
  }

  // Landing gear: one nose leg, two mains. Retracted by hiding the group —
  // at 2 000 km/h nobody is counting the doors.
  const gear = new THREE.Group();
  for (const [gx, gz] of [[0, -4.2], [-1.5, 1.5], [1.5, 1.5]]) {
    const s = new THREE.Mesh(g.strut, metalMat);
    s.position.set(gx, -GEAR_H / 2, gz);
    const w = new THREE.Mesh(g.wheel, metalMat);
    w.position.set(gx, -GEAR_H, gz);
    gear.add(s, w);
  }
  body.add(gear);

  // Afterburner plume — invisible until the burner lights.
  const burner = new THREE.Mesh(g.flame, flameMat);
  burner.visible = false;
  body.add(burner);

  group.userData.kind = 'fighter';
  return { group, body, gear, burner };
}

// Where the pilot sits, in the airframe's local frame — under the canopy, on
// the centreline. Single-seat: the JAS-39C has one bang seat and index 1 simply
// gets the same place, because there is nowhere else to put a passenger.
// player.js dispatches to this the same way it does the helicopter's.
export function seatAnchor(jet, i = 0) {
  return { x: 0, y: 0.34, z: -3.5 };
}

export class Fighter {
  constructor(scene, x, z, heading = 0) {
    this.scene = scene;
    const m = makeFighterMesh();
    this.mesh = m.group;
    this._body = m.body;
    this._gear = m.gear;
    this._burner = m.burner;

    this.x = x; this.y = 0; this.z = z;
    this.heading = heading;
    this.pitch = 0; this.roll = 0;     // BODY angles, mesh sign convention
    this.speed = 0;                    // m/s along the nose — a jet does not
                                       // fly sideways, so a scalar is honest
    this.throttle = 0;
    this.airborne = false;
    this.vy = 0;                       // vertical rate, m/s
    // player.js walks to a door point offset by half the vehicle's width: the
    // fuselage, not the 8.4 m wingspan, or the pilot would board from out over
    // the wing. `len` is the real one — nothing depends on it but the HUD.
    this.wid = 2.4; this.len = 14.1;
    this.seats = [];                   // the boarding registry, like every vehicle

    this.mesh.position.set(x, GEAR_H, z);
    this.mesh.rotation.y = heading;
    scene.add(this.mesh);
  }

  /** Airspeed in km/h — what the HUD wants. */
  get kmh() { return this.speed * 3.6; }
  /** Is the burner lit? (audio + HUD) */
  get reheat() { return this.throttle > AB_GATE; }

  // update(dt, ctl, world) — `world` needs heightAt(x,z), like the helicopter,
  // which keeps this testable against a stub.
  update(dt, ctl, world) {
    dt = Math.min(dt, 1 / 20);         // a tab-return spike must not teleport us
    const pIn = clamp(ctl?.pitch ?? 0, -1, 1);
    const rIn = clamp(ctl?.roll ?? 0, -1, 1);
    const yIn = clamp(ctl?.yaw ?? 0, -1, 1);
    const brake = clamp(ctl?.brake ?? 0, 0, 1);
    // throttle is a lever, not a button: it takes about a second to swing
    const want = clamp(ctl?.throttle ?? 0, 0, 1);
    this.throttle += clamp(want - this.throttle, -dt * 1.6, dt * 1.6);

    const ground = (world?.heightAt?.(this.x, this.z) ?? 0) + GEAR_H;

    // ---- thrust and drag -------------------------------------------------
    // Top speed is where these two meet, and drag thins out with altitude —
    // so the climb IS the throttle. Everything about how this jet feels fast
    // comes from these three lines.
    const rho = Math.exp(-Math.max(0, this.y) / SCALE_H);
    const thrust = (this.reheat ? THRUST_AB : THRUST_DRY) * this.throttle;
    let accel = thrust - DRAG_K * rho * this.speed * this.speed;
    if (!this.airborne) accel -= ROLL_FRICTION + brake * BRAKE_DECEL;
    else accel -= brake * AIRBRAKE;
    this.speed = clamp(this.speed + accel * dt, 0, V_MAX);

    // ---- control authority ------------------------------------------------
    // Nothing works standing still; everything works at combat speed. Squared
    // ratio because control forces go with dynamic pressure, not with speed.
    const q = clamp(this.speed / 160, 0, 1);
    const auth = q * q * (0.35 + 0.65 * rho);

    if (this.airborne) {
      // pitch and roll are rate commands, damped back toward level when the
      // stick is centred (a real jet is trimmed, not a free gyroscope)
      this.pitch += pIn * PITCH_RATE * auth * dt;
      if (!pIn) this.pitch -= this.pitch * Math.min(1, dt * 0.6);
      this.pitch = clamp(this.pitch, -1.2, 1.2);
      this.roll += rIn * ROLL_RATE * auth * dt;
      if (!rIn) this.roll -= this.roll * Math.min(1, dt * 0.9);
      this.roll = clamp(this.roll, -Math.PI, Math.PI);
      this.roll = angWrap(this.roll);

      // THE turn equation: a banked wing pulls the nose round at g·tan(φ)/V.
      // Right bank is negative roll in this convention and must DECREASE
      // heading, matching a car's steer sign.
      const v = Math.max(this.speed, V_STALL);
      this.heading += Math.tan(clamp(-this.roll, -1.4, 1.4)) * (G / v) * dt
        + yIn * YAW_RATE_AIR * auth * dt;
      this.heading = angWrap(this.heading);

      // Vertical: the wing turns the velocity toward where the nose points,
      // but only while it has airflow. Below the stall it stops arguing with
      // gravity and the jet mushes down.
      const lift = clamp((this.speed - V_STALL) / 60, 0, 1);
      const wantVy = Math.sin(this.pitch) * this.speed;
      this.vy += ((wantVy * lift) - this.vy) * Math.min(1, dt * AOA_LIFT * (0.4 + lift));
      this.vy -= (1 - lift) * SINK_RATE * dt;
    } else {
      // ---- on the ground ---------------------------------------------------
      this.roll -= this.roll * Math.min(1, dt * 4);
      this.vy = 0;
      // nosewheel steering: plenty at taxi speed, almost none at rotation
      this.heading -= yIn * GND_STEER * dt * clamp(1 - this.speed / V_ROTATE, 0.08, 1);
      this.heading = angWrap(this.heading);
      // rotation: pull back past VR and the nose comes up; that is take-off
      if (pIn > 0.15 && this.speed > V_ROTATE) {
        this.pitch = Math.min(this.pitch + PITCH_RATE * 0.5 * dt, 0.28);
        if (this.pitch > 0.10) { this.airborne = true; this.vy = 1.5; }
      } else this.pitch -= this.pitch * Math.min(1, dt * 3);
    }

    // ---- integrate --------------------------------------------------------
    const cp = Math.cos(this.pitch);
    this.x += -Math.sin(this.heading) * cp * this.speed * dt;
    this.z += -Math.cos(this.heading) * cp * this.speed * dt;
    this.y += this.vy * dt;

    if (this.airborne) {
      if (this.y <= ground) {          // touchdown (or a very bad landing)
        this.y = ground;
        this.vy = 0;
        this.airborne = false;
        this.pitch = Math.max(this.pitch, 0) * 0.3;
        // arriving fast and steep scrubs speed off; a greaser keeps it
        this.speed *= this.speed > V_ROTATE * 1.6 ? 0.72 : 0.94;
      }
    } else {
      this.y = ground;
    }

    // ---- mesh sync ---------------------------------------------------------
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.heading;
    this._body.rotation.x = this.pitch;
    this._body.rotation.z = this.roll;
    this._gear.visible = !this.airborne || this.y - ground < 60;
    const ab = this.reheat;
    this._burner.visible = ab;
    if (ab) {
      const k = 0.7 + (this.throttle - AB_GATE) / (1 - AB_GATE) * 0.5;
      this._burner.scale.set(1, 1, k);
      this._burner.material.opacity = 0.55 + 0.3 * Math.sin(performance.now() * 0.05);
    }
  }

  /** Park it (main.js does this when the player walks away). */
  dispose() { this.scene.remove(this.mesh); }
}
