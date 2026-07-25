// ---- Helicopter: Pardubice from above ----
// The heli is the third way through the city after boots and cars, and it
// deliberately does NOT feel like driveStep. A car is a point that steers; a
// helicopter is a mass hanging under a rotor disc. So the model here is
// thrust-based rather than speed-based: the disc makes an upward acceleration
// proportional to ω², gravity pulls at 9.81 m/s² every single frame, and every
// horizontal meter is bought by TILTING that thrust vector. That one decision
// gives all the behaviour the contract asks for almost for free — you cannot
// leap off the pad (a cold rotor makes no thrust and needs ~3 s to wind up),
// the machine wallows into a bank before it accelerates, it keeps drifting
// after you centre the stick, and it sinks if you bank too hard with a lazy
// collective.
//
// Convention (ARCHITECTURE.md): heading 0 faces −z (north); a mesh authored
// facing −z with mesh.rotation.y = heading travels along (−sin h, −cos h) and
// its right-hand side is (cos h, −sin h). Mesh tilt follows the same signs
// vehicles.js established: +x rotation LIFTS the nose and +z rotation LIFTS
// the right flank — so "nose down to accelerate" is a NEGATIVE pitch angle and
// a right bank is a NEGATIVE roll angle. Steering right decreases heading,
// exactly like ctl.steer on a car.
//
// ctl = { pitch, roll, yaw, lift }, each −1..1 and all optional:
//   pitch +1 = stick forward (nose down → accelerate along heading)
//   roll  +1 = bank right,  yaw +1 = pedal right (heading decreases)
//   lift  +1 = collective up (target +9 m/s climb), −1 = down
// main.js owns the key mapping and drives the chase camera from x/y/z/heading.
//
// Allocation discipline matches the rest of the engine: geometry and materials
// are built once and shared by every airframe, and update() touches only
// scalars plus one module-level scratch point for the collision query.

import * as THREE from 'three';
import { LAYER_Y } from './config.js';

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const TAU = Math.PI * 2;

// ---- flight tunables ----------------------------------------------------
// Arcade, but weighty: the numbers are chosen so the ROTOR is always the
// bottleneck, never an arbitrary speed cap.
const G = 9.81;
const ROTOR_MAX = 62;              // rad/s at full song (~590 rpm, R22 country)
const ROTOR_IDLE = 7;              // parked, engine ticking over
const SPIN_UP = ROTOR_MAX / 3;     // contract: ~3 s from a cold start to full
const SPIN_DOWN = ROTOR_MAX / 7;   // a disc that big coasts down far slower
const BLUR_W = 40;                 // rad/s where blades stop reading as blades
// Thrust ceiling at full rotor = 1.73 g. Hover therefore needs (9.81/17) =
// 0.577 of the ceiling, i.e. ω/ROTOR_MAX = √0.577 = 0.76 — which the spin-up
// rate reaches at t ≈ 2.3 s. THAT is what stops the pad-leap, not a timer.
const THRUST_MAX = 17;             // m/s² of lift the disc can make at ω = MAX
const CTRL_FRAC = 0.45;            // rotor fraction where cyclic/pedals bite
const CLIMB = 9;                   // m/s commanded by full collective
const VY_GAIN = 1.6;               // 1/s — collective lag (τ ≈ 0.6 s)
const BANK_MAX = 0.35;             // rad — contract's visible bank limit
const BANK_K = 2.6;                // 1/s — how fast it rolls into that bank
const ACC_TILT = 8.5;              // m/s² of horizontal push at full tilt
const VMAX = 62;                   // m/s the drag curve settles at, ~223 km/h
// Drag is linear + quadratic: the linear term is what actually bleeds a slow
// drift off (pure v² barely decelerates below 10 m/s and the machine would
// creep forever), the quadratic term is what makes VMAX an asymptote. DRAG_Q
// is SOLVED from the other two so ACC_TILT = drag(VMAX) exactly.
const DRAG_LIN = 0.09;                                     // 1/s
const DRAG_Q = (ACC_TILT - DRAG_LIN * VMAX) / (VMAX * VMAX); // 1/m
const SKID_MU = 6;                 // m/s² of skid scrub while sat on the ground
const YAW_MAX = 1.5;               // rad/s from full pedal
const COORD_YAW = 0.75;            // rad/s the bank itself contributes (turns
                                   // coordinate: roll and it comes round)
const YAW_K = 3.2;                 // 1/s — pedal/tail-rotor lag
const GND_YAW = 0.2;               // skids resist a pedal turn on the deck
const TOUCH_H = 0.4;               // m AGL that counts as "touching down"
const HARD_VS = 3;                 // m/s descent above which it's an arrival,
                                   // not a landing (clamp, stay airborne)
const SETTLE = 1.2;                // m/s the last few cm are eased down at
const BODY_R = 2.2;                // fuselage collision radius
const COLLIDE_Y = 40;              // above this we're over the rooftops

// ---- shared materials ---------------------------------------------------
// One set for the whole fleet. Kept module-level (not per-instance) for the
// same reason vehicles.js does it: a second helicopter must cost geometry
// uploads, not a new shader program.
const skinMat = new THREE.MeshLambertMaterial({ color: 0x3a4550 });
const trimMat = new THREE.MeshLambertMaterial({ color: 0xb9391f });   // tail flash
const glassMat = new THREE.MeshLambertMaterial({ color: 0x1b2126 });
const metalMat = new THREE.MeshLambertMaterial({ color: 0x6d7278 });
const rotorMat = new THREE.MeshLambertMaterial({ color: 0x2a2d31 });
// The spinning disc: NOT additive — a rotor darkens the sky behind it as much
// as it lightens it, and depthWrite:false keeps it from punching a hole in the
// city when the camera looks down through it.
const discMat = new THREE.MeshBasicMaterial({
  color: 0xb9c2cb, transparent: true, opacity: 0.16,
  depthWrite: false, side: THREE.DoubleSide,
});
// Anti-collision beacon. Same trick as the car lamps: overbright emissive with
// toneMapped:false, because the bloom pass thresholds at linear 1.0 and ACES
// would otherwise squash it back under that.
const beaconMat = new THREE.MeshLambertMaterial({
  color: 0x8c1c14, emissive: 0xff2a1c, emissiveIntensity: 3, toneMapped: false,
});
// Pad lights are exported the way vehicles.js exports lampMats: one assignment
// from main.js at dusk lights every helipad in the region at once.
export const padLightMat = new THREE.MeshLambertMaterial({
  color: 0xfff6dc, emissive: 0xffe6a8, emissiveIntensity: 3, toneMapped: false,
});

// ---- helipad ------------------------------------------------------------
const PAD_R = 9;                       // apron radius — an R22 needs ~7 m
// Stack the pad on top of the LAYER_Y ladder's paved plane. The steps here
// (5 cm apron, 4 cm paint) are the same order as the ladder's own gaps, which
// the Woods ground taught us is the smallest safe separation at this draw
// distance — anything tighter shimmers once the camera climbs.
const PAD_Y = LAYER_Y.paved + 0.05;
const PAINT_Y = PAD_Y + 0.04;

let _padGeo = null;
function padGeom() {
  if (_padGeo) return _padGeo;
  // CircleGeometry/PlaneGeometry/RingGeometry all face +z; −90° about x lays
  // them flat with the normal up.
  const apron = new THREE.CircleGeometry(PAD_R, 40);
  apron.rotateX(-Math.PI / 2);
  const ring = new THREE.RingGeometry(PAD_R * 0.84, PAD_R * 0.91, 56);
  ring.rotateX(-Math.PI / 2);
  const bar = new THREE.PlaneGeometry(1.0, 5.2);          // the H's uprights
  bar.rotateX(-Math.PI / 2);
  const cross = new THREE.PlaneGeometry(3.4, 1.0);        // …and its waist
  cross.rotateX(-Math.PI / 2);
  const lamp = new THREE.BoxGeometry(0.42, 0.3, 0.42);
  return (_padGeo = { apron, ring, bar, cross, lamp });
}

// makeHelipad(x, z) → a static THREE.Group parked at (x, 0, z). Nothing about
// it animates, so it is safe to add once and forget; group.userData carries
// the radius (main.js uses it for the "press F to board" proximity test) and
// the light material for a dusk sweep.
export function makeHelipad(x, z) {
  const g = padGeom();
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const apron = new THREE.Mesh(g.apron, new THREE.MeshLambertMaterial({ color: 0x35383c }));
  apron.position.y = PAD_Y;
  apron.receiveShadow = true;                 // the machine's own shadow lands here
  group.add(apron);

  const paint = new THREE.MeshLambertMaterial({ color: 0xe8e9e4 });
  const ring = new THREE.Mesh(g.ring, paint);
  ring.position.y = PAINT_Y;
  group.add(ring);
  for (let i = -1; i <= 1; i += 2) {           // two uprights, 3.4 m apart…
    const b = new THREE.Mesh(g.bar, paint);
    b.position.set(i * 1.7, PAINT_Y, 0);
    group.add(b);
  }
  const waist = new THREE.Mesh(g.cross, paint); // …joined by the crossbar
  waist.position.y = PAINT_Y;
  group.add(waist);

  // Four corner markers just outside the ring, on the diagonals — the only
  // part of the pad that survives visually once the sun is down.
  for (let i = 0; i < 4; i++) {
    const l = new THREE.Mesh(g.lamp, padLightMat);
    l.position.set((i & 1 ? 1 : -1) * PAD_R * 0.72, 0.15,
      (i & 2 ? 1 : -1) * PAD_R * 0.72);
    group.add(l);
  }
  group.userData.radius = PAD_R;
  group.userData.lightMat = padLightMat;
  return group;
}

// ---- airframe geometry --------------------------------------------------
// Robinson-ish proportions: 7.4 m nose to tail, 2.7 m to the rotor head, a
// 3.9 m blade. Built once, shared by every Helicopter ever constructed.
const R = 3.9;          // main rotor radius
const CAB_W = 1.62, CAB_H = 1.45, CAB_L = 2.4;
const FLOOR = 0.62;     // cabin floor above the skids
const BOOM_Y = FLOOR + CAB_H * 0.62;
const BOOM_Z = CAB_L * 0.5 + 1.95;   // boom centre, +z is behind us
const TAIL_Z = CAB_L * 0.5 + 3.9;    // fin / tail rotor station
const HEAD_Y = FLOOR + CAB_H + 0.6;  // rotor plane

// A box whose cross-section is pulled in toward the roof (t: 0 at the floor →
// 1 at the roof) and whose NOSE additionally slopes away — the cheapest way to
// get the bubble canopy silhouette out of a 12-triangle box. yBase/hTotal let
// the glass band be cut from the exact same profile so its faces follow the
// shell's slant, and `grow` pushes it a few mm proud so it never z-fights.
// Same shape trick, same reasons, as taperBox() in vehicles.js.
function shellBox(w, h, l, kTop, kNose, yBase = 0, hTotal = h, grow = 1) {
  const g = new THREE.BoxGeometry(w, h, l);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (yBase + p.getY(i) + h / 2) / hTotal;
    const s = 1 - (1 - kTop) * t * t;          // squared = round, not chamfered
    p.setX(i, p.getX(i) * s * grow);
    const z = p.getZ(i);
    p.setZ(i, z * (z < 0 ? 1 - (1 - kNose) * t : s) * grow);
  }
  g.computeVertexNormals();
  return g;
}

let _geo = null;
function heliGeom() {
  if (_geo) return _geo;
  const cabin = shellBox(CAB_W, CAB_H, CAB_L, 0.55, 0.42);
  cabin.translate(0, FLOOR + CAB_H / 2, -0.1);
  // glass: the 30%..86% height slice of the same shell, 2% proud of the paint,
  // which on this nose profile is exactly the wrap-around windscreen
  const glass = shellBox(CAB_W, CAB_H * 0.56, CAB_L, 0.55, 0.42, CAB_H * 0.30, CAB_H, 1.02);
  glass.translate(0, FLOOR + CAB_H * 0.58, -0.1);
  const boom = new THREE.CylinderGeometry(0.15, 0.27, 3.9, 8);
  boom.rotateX(Math.PI / 2);                   // cylinder axis y → z
  boom.translate(0, BOOM_Y, BOOM_Z);
  const fin = new THREE.BoxGeometry(0.07, 0.82, 0.62);
  fin.translate(0, BOOM_Y + 0.42, TAIL_Z);
  const stab = new THREE.BoxGeometry(1.6, 0.07, 0.42);
  stab.translate(0, BOOM_Y, TAIL_Z - 0.35);
  const skid = new THREE.CylinderGeometry(0.06, 0.06, 3.1, 6);
  skid.rotateX(Math.PI / 2);
  skid.translate(0, 0.06, 0);
  const strut = new THREE.BoxGeometry(0.07, 0.62, 0.11);
  const mast = new THREE.CylinderGeometry(0.09, 0.11, 0.62, 6);
  mast.translate(0, HEAD_Y - 0.42, 0);
  const hub = new THREE.CylinderGeometry(0.2, 0.24, 0.16, 8);
  // Blade geometry is authored on ONE side of the hub; the second blade is the
  // same geometry yawed by π, so a teetering two-blade head costs one upload.
  const blade = new THREE.BoxGeometry(0.26, 0.05, R);
  blade.translate(0, 0, R / 2);
  const disc = new THREE.CircleGeometry(R * 0.99, 28);
  disc.rotateX(-Math.PI / 2);
  const tblade = new THREE.BoxGeometry(0.045, 1.5, 0.13);  // sweeps about x
  const thub = new THREE.CylinderGeometry(0.1, 0.1, 0.14, 6);
  thub.rotateZ(Math.PI / 2);
  const beacon = new THREE.BoxGeometry(0.15, 0.13, 0.15);
  beacon.translate(0, BOOM_Y + 0.9, TAIL_Z);
  return (_geo = { cabin, glass, boom, fin, stab, skid, strut, mast, hub,
    blade, disc, tblade, thub, beacon });
}

// Build one airframe. Everything that TILTS lives in an inner `body` group so
// bank never fights the outer group's position — the same split makeCarMesh()
// uses for suspension roll, and the reason the rotor head stays on the mast
// while the machine leans into a turn.
function makeHeliMesh() {
  const g = heliGeom();
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const shell = new THREE.Mesh(g.cabin, skinMat);
  shell.castShadow = true;
  const boom = new THREE.Mesh(g.boom, skinMat);
  boom.castShadow = true;
  body.add(shell, new THREE.Mesh(g.glass, glassMat), boom,
    new THREE.Mesh(g.fin, trimMat), new THREE.Mesh(g.stab, skinMat),
    new THREE.Mesh(g.mast, metalMat), new THREE.Mesh(g.beacon, beaconMat));

  for (let i = -1; i <= 1; i += 2) {           // skid tubes + splayed struts
    const s = new THREE.Mesh(g.skid, metalMat);
    s.position.x = i * 0.76;
    body.add(s);
    for (let j = -1; j <= 1; j += 2) {
      const st = new THREE.Mesh(g.strut, metalMat);
      st.position.set(i * 0.58, 0.34, j * 0.72);
      st.rotation.z = -i * 0.33;               // splay outward to the skid
      body.add(st);
    }
  }

  // main rotor: hub + two collinear blades, spun by rotation.y
  const rotor = new THREE.Group();
  rotor.position.y = HEAD_Y;
  rotor.add(new THREE.Mesh(g.hub, metalMat));
  const blades = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(g.blade, rotorMat);
    b.rotation.y = i * Math.PI;
    blades.add(b);
  }
  const disc = new THREE.Mesh(g.disc, discMat);
  disc.visible = false;                        // swapped in past BLUR_W
  rotor.add(blades, disc);
  body.add(rotor);

  // tail rotor: two blades in the y–z plane on the left side, spun about x
  const tail = new THREE.Group();
  tail.position.set(-0.28, BOOM_Y + 0.4, TAIL_Z - 0.08);
  tail.add(new THREE.Mesh(g.thub, metalMat));
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(g.tblade, rotorMat);
    b.rotation.x = i * Math.PI;
    tail.add(b);
  }
  body.add(tail);

  return { group, body, rotor, blades, disc, tail };
}

// ---- Helicopter ---------------------------------------------------------
const _pt = { x: 0, z: 0 };            // scratch for world.collide, reused forever
const _col = { aboveY: 0 };            // …and its options object

export class Helicopter {
  constructor(scene, x, z, heading = 0) {
    this.scene = scene;
    const m = makeHeliMesh();
    this.mesh = m.group;
    this._body = m.body;
    this._rotor = m.rotor;
    this._blades = m.blades;
    this._disc = m.disc;
    this._tail = m.tail;

    this.x = x; this.y = 0; this.z = z;
    this.heading = heading;
    this.rotorSpeed = 0;               // cold — the pad-leap guard lives here
    this.airborne = false;
    // velocities are world-frame (the machine can fly sideways and backwards,
    // so a scalar "speed" like the cars carry would be a lie)
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.pitch = 0; this.roll = 0;     // BODY angles in mesh sign convention
    this.yawRate = 0;

    this.mesh.position.set(x, 0, z);
    this.mesh.rotation.y = heading;
    scene.add(this.mesh);
  }

  // update(dt, ctl, world) — one physics step plus the mesh sync.
  // `world` needs exactly two methods: heightAt(x,z) and collide({x,z}, r),
  // i.e. a CityWorld, which keeps this module testable against a stub.
  update(dt, ctl, world) {
    dt = Math.min(dt, 1 / 20);         // a tab-return dt spike must not teleport us
    const lift = clamp(ctl?.lift ?? 0, -1, 1);
    const pIn = clamp(ctl?.pitch ?? 0, -1, 1);
    const rIn = clamp(ctl?.roll ?? 0, -1, 1);
    const yIn = clamp(ctl?.yaw ?? 0, -1, 1);

    // ---- rotor -----------------------------------------------------------
    // It winds up while we're flying or asking for collective, and parks back
    // at idle once we're sat on the ground with the lever down. Spin-down is
    // much slower than spin-up because that is what a heavy disc does, and it
    // means a bounced landing doesn't cost a full 3 s restart.
    const want = (this.airborne || lift > 0.01) ? ROTOR_MAX : ROTOR_IDLE;
    const rate = want > this.rotorSpeed ? SPIN_UP : SPIN_DOWN;
    this.rotorSpeed += clamp(want - this.rotorSpeed, -rate * dt, rate * dt);
    const frac = this.rotorSpeed / ROTOR_MAX;
    const thrust = frac * frac;        // rotor thrust goes with ω², not ω
    // cyclic and pedals are hydraulically useless below a working rotor speed
    const auth = clamp((frac - CTRL_FRAC) / (1 - CTRL_FRAC), 0, 1);

    // ---- bank ------------------------------------------------------------
    // The stick sets a BANK ANGLE, not an acceleration; the acceleration is
    // then whatever that angle does to the thrust vector. Hence the lag: the
    // machine has to roll before it goes anywhere, which is the entire
    // difference in feel between this and a car.
    const kb = Math.min(1, BANK_K * dt);
    this.pitch += (-pIn * BANK_MAX * auth - this.pitch) * kb;
    this.roll += (-rIn * BANK_MAX * auth - this.roll) * kb;
    // normalized tilt: +1 forward / +1 right, clamped to the unit disc so a
    // full-diagonal input can't buy √2 of thrust
    let tf = -this.pitch / BANK_MAX, tr = -this.roll / BANK_MAX;
    const tm = Math.hypot(tf, tr);
    if (tm > 1) { tf /= tm; tr /= tm; }

    // ---- collective ------------------------------------------------------
    // Target a climb rate and let a P-controller ask for the acceleration that
    // would get there; the rotor then delivers as much of it as ω² allows.
    // Banking steals vertical thrust (cos of the tilt), so a hard turn on a
    // lazy collective quietly loses you height — exactly as it should.
    const tilt = Math.hypot(this.pitch, this.roll);
    const upCap = THRUST_MAX * thrust * Math.cos(tilt);
    const aUp = clamp((lift * CLIMB - this.vy) * VY_GAIN + G, 0, upCap) - G;
    this.vy += aUp * dt;

    // ---- horizontal ------------------------------------------------------
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading), rz = -Math.sin(this.heading);
    if (this.airborne) {
      const a = ACC_TILT * thrust;     // no disc, no push — autorotation is a glide
      this.vx += (fx * tf + rx * tr) * a * dt;
      this.vz += (fz * tf + rz * tr) * a * dt;
    }
    // drag pulls the machine back to a hover whenever the stick centres; on
    // the ground the skids add a hard scrub so a landed heli actually stops
    const sp = Math.hypot(this.vx, this.vz);
    if (sp > 1e-5) {
      let d = (DRAG_LIN + DRAG_Q * sp) * sp;
      if (!this.airborne) d += SKID_MU;
      const dv = Math.min(sp, d * dt); // never overshoot through zero
      this.vx -= (this.vx / sp) * dv;
      this.vz -= (this.vz / sp) * dv;
    }

    // ---- yaw -------------------------------------------------------------
    // Pedal plus a coordinated component from the bank: roll right and the
    // nose follows round, so a turn needs one hand, not two. Right = heading
    // DECREASES (the cars' steer sign). Skids resist a pedal turn on the deck.
    const yawT = -(yIn * YAW_MAX + tr * COORD_YAW) * auth
      * (this.airborne ? 1 : GND_YAW);
    this.yawRate += (yawT - this.yawRate) * Math.min(1, YAW_K * dt);
    this.heading += this.yawRate * dt;

    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;

    // ---- ground ----------------------------------------------------------
    // One query per step, after the move. "Ground" is not the street: it is
    // whatever is under the skids, which on a city flight is usually a ROOF.
    // roofY only returns a building top the machine is already above, so
    // descending onto a block of flats lands on it while flying past its
    // fifteenth floor still leaves the wall in the way (see the collide call
    // below, which now ignores anything shorter than we are).
    const gy = world.roofY ? world.roofY(this.x, this.z, this.y)
      : world.heightAt(this.x, this.z);
    if (this.y < gy) { this.y = gy; if (this.vy < 0) this.vy = 0; }
    const agl = this.y - gy;
    if (this.vy > 0.05 && agl > 0.02) {
      this.airborne = true;            // skids clear of the deck: we're flying
    } else if (agl <= TOUCH_H && this.vy <= 0) {
      if (-this.vy < HARD_VS) {
        // gentle arrival inside skid height: ease the last few cm down instead
        // of teleporting, then declare it landed (which parks the rotor)
        this.y = Math.max(gy, this.y - Math.min(agl, SETTLE * dt));
        this.vy = 0;
        this.airborne = false;
      } else {
        this.y = gy; this.vy = 0;      // that was an arrival, not a landing
      }
    }

    // ---- buildings -------------------------------------------------------
    // Only worth asking below the rooftops. world.collide pushes the point out
    // of footprints (and, at river level, out of open water — you can't set
    // down on the Labe either, which is the right answer anyway).
    if (this.y < COLLIDE_Y) {
      _pt.x = this.x; _pt.z = this.z;
      // aboveY: a rooftop we have already cleared is a landing pad, not a wall.
      // The tolerance has to be POSITIVE, or the moment the skids touch down
      // (y === roof height) the building becomes an obstacle again and shoves
      // its own landing pad out from under the machine — which is exactly what
      // "it throws me off the roofs" was.
      _col.aboveY = this.y + 0.3;
      if (world.collide(_pt, BODY_R, _col)) {
        const px = _pt.x - this.x, pz = _pt.z - this.z;
        this.x = _pt.x; this.z = _pt.z;
        const pl = Math.hypot(px, pz);
        if (pl > 1e-6) {
          // kill the velocity going INTO the wall, keep what slides along it,
          // with a little rebound so a hover-nudge feels like a bump
          const nx = px / pl, nz = pz / pl;
          const into = this.vx * nx + this.vz * nz;
          if (into < 0) { this.vx -= nx * into * 1.4; this.vz -= nz * into * 1.4; }
        }
      }
    }

    // ---- mesh ------------------------------------------------------------
    const m = this.mesh;
    m.position.set(this.x, this.y, this.z);
    m.rotation.y = this.heading;
    this._body.rotation.x = this.pitch;   // +x lifts the nose
    this._body.rotation.z = this.roll;    // +z lifts the right flank
    const spin = this.rotorSpeed * dt;
    // wrap so the angle never drifts into float-precision mush on a long flight
    this._rotor.rotation.y = (this._rotor.rotation.y + spin) % TAU;
    this._tail.rotation.x = (this._tail.rotation.x + spin * 1.7) % TAU;
    // past BLUR_W two blades at 60 fps just strobe — swap them for the disc
    const blur = this.rotorSpeed >= BLUR_W;
    this._blades.visible = !blur;
    this._disc.visible = blur;
  }
}
