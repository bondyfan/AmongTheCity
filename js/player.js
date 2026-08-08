// ---- Player: on-foot movement, and the boarding/riding state machine ----
// GTA-style third-person walking: WASD is CAMERA-relative (W always runs away
// from the camera), the body eases its heading toward wherever you push, and
// the world's collide() keeps you out of buildings and the Labe.
//
// v6 replaces the old "mesh.visible = false" teleport-into-the-driver-seat
// trick with a visible little state machine:
//
//   walking ──boardVehicle()──▶ boarding:'walk'  (jog to the door point,
//                                │                recomputed every frame off
//                                │                the vehicle's live pose)
//                                ▼
//                               boarding:'slide' (~0.55 s: interpolate door →
//                                │                seat IN THE VEHICLE'S LOCAL
//                                │                FRAME while sitPose() folds
//                                │                the limbs; door sfx cues
//                                │                fire through callbacks)
//                                ▼
//                               seated           (inCar set, mesh PARENTED to
//                                │                the vehicle's body group and
//                                │                riding its transform — still
//                                │                visible, sitting on the seat
//                                │                anchor; control handover —
//                                │                game.car/game.heli — happens
//                                │                only now, via onSeated)
//                                ▼
//               beginExit() ──▶ exiting          (~0.35 s step-out onto the
//                                                 pavement, then standPose and
//                                                 the walker owns itself again)
//
// Any of it can be interrupted: the vehicle despawning, a claimed seat, or a
// remotely-flown machine leaving the ground all cancel back to plain walking.
// Seat OCCUPANCY lives on the vehicle itself (veh.seats = [driver, passenger,
// …], created lazily) so the multiplayer layer can claim seats for remote
// players with the very same registry — see main.js's E-handler comment.
//
// ---- the two combat hooks, and why they are shaped like this -------------
//
// js/combat.js needs exactly two things from the body and is given nothing
// else: a place to hang an arms-only pose, and a switch that makes the walk
// aim. Neither one is a state, neither one imports anything.
//
//   player.combatPose = fn|null   called with (dt) at the very END of
//     update(), AFTER _animate() has written the skeleton. That ordering IS
//     the hook. citizen.js's punch/kick/aim/hands poses are ADDITIVE and
//     arms-only — they overwrite their own joints and leave the rest of the
//     rig to walk(). Call one BEFORE _animate (which is what a hook in
//     main.js's frame loop would amount to, since stepGame runs several times
//     per rendered frame and player.update() is the last writer inside it) and
//     walk() rewrites the arms a microsecond later: the punch is never drawn,
//     nothing throws, nothing logs, the arms simply swing. The boarding
//     machine already applies _sit(k) after writing the transform for the
//     identical reason; this is the same rule at the other end of update().
//
//   player.aimLock = boolean      while true the body faces the CAMERA rather
//     than the direction it is travelling, the stick therefore strafes, and
//     the top speed drops to AIM_SPEED.
//
// aimLock is a MODIFIER on the walk branch, not a fifth state. The obvious
// alternative — 'aiming' alongside walking/boarding/riding/exiting — was
// rejected outright: it would need its own copy of the substepped collide, the
// supportY climb/fall and the animate call (forty lines, duplicated and free
// to drift apart), and every one of the four existing transitions would grow
// an edge into and out of it. As three reads inside the walk branch it
// composes with everything for free, and the early returns at the top of
// update() already make it inert while boarding, seated or stepping out —
// which is most of what "boarding a car cancels it" means. boardVehicle() and
// setInCar() drop the flag as well, so it cannot survive the ride.
//
// The heading SNAPS to camYaw rather than easing toward it, and that is a fix
// rather than laziness. main.js's chase camera eases camYaw toward
// player.heading whenever you are moving and the mouse has been idle a moment
// (main.js:441/458). Two controllers each chasing the other's output is a
// feedback loop; with an eased heading it shows as the camera being dragged
// back a tenth of the way toward wherever the body happened to be pointing,
// every time you swing the mouse. Snapping makes (wantYaw − camYaw)
// identically zero, so the auto-follow term multiplies out to nothing and the
// loop cannot engage at all. What is left is one frame of lag — the camYaw we
// are handed was computed before this frame's mouse delta, so auto-follow can
// still claw back dt·1.6 ≈ 2.7 % of a movement at 60 Hz — which is under the
// mouse smoothing and below the threshold of anybody noticing.
//
// Directions follow the ARCHITECTURE.md convention throughout:
//   dir(h) = (−sin h, −cos h), mesh.rotation.y = heading, h = atan2(−dx, −dz).

import { WALK, PLAYER_SCALE, INTERIOR } from './config.js';

/** 0 while walking, 1 at a full sprint — how much RUN is in the gait. */
const runBlend = (v) => {
  const k = (v - WALK.runFrom) / (WALK.sprint - WALK.runFrom);
  return k < 0 ? 0 : k > 1 ? 1 : k;
};
import { makeCitizen } from './citizen.js';
import { localUid, baseUid, lookForUid } from './identity.js';
import { seatAnchor as carSeatAnchor } from './vehicles.js';
import { seatAnchor as heliSeatAnchor } from './helicopter.js';
import { seatAnchor as jetSeatAnchor } from './aircraft.js';

const TWO_PI = Math.PI * 2;
// v5: the player now has a y. Buildings have floors, so "the ground" stopped
// being a function of (x,z) alone — it is whatever surface is under your feet
// at or just above your current level, and the walk controller finds it every
// frame. That single change is all a staircase needs: eighteen boxes each
// 175 mm above the last, and STEP_UP quietly carries you up them.
const GRAVITY = 21;          // m/s² — game gravity, snappier than the real thing
const TERMINAL = 42;         // m/s cap so a fall off a tower block can't tunnel
// The protagonist has NO fixed outfit any more. It used to be a hard-coded blue
// jacket "so you always find yourself" — but every other client dressed you
// from identity's palette instead, so the person you saw in blue was nobody the
// others could see. The hero now goes through exactly the same lookForUid() as
// every peer: what you see in the mirror is what the room sees. (The old blue,
// 0x3a63a8, survives as PLAYER_JACKETS[8] — some uid still wears it.)

// ---- boarding tuning -----------------------------------------------------
const BOARD_T = 0.55;        // s — the door-to-seat slide
const EXIT_T = 0.35;         // s — the seat-to-pavement step-out
const DOOR_R = 0.32;         // m — "at the door" arrival radius
const DOOR_OUT = 0.5;        // m — door point past the flank; exit lands wider
// seat anchors give the CUSHION TOP; the citizen group's origin (its feet)
// goes this far below it so the folded hips (pivot 0.86·scale) rest on it
const SIT_DROP = 0.78 * PLAYER_SCALE;
const smooth = (k) => k * k * (3 - 2 * k);

// ---- the gun walk --------------------------------------------------------
// WALK.jog is 5.6 m/s and WALK.sprint is 14.0, and neither is a speed you move
// at with the sights up. 3.1 is a fast march — roughly twice a real walking
// pace, a little over half the jog — and the number is picked against
// WALK.runFrom (6.5) rather than by feel: runBlend() only starts mixing the RUN
// gait in above that, so at 3.1 the blend is flat zero and the legs cannot slip
// into a sprint cycle underneath a raised pistol, which is the one thing that
// would look wrong from every camera angle at once. Cadence lands at 3.1/5.6 =
// 0.55 of the jog, a stride that reads as deliberate rather than hurried.
//
// Raising the gun at a full sprint does not snap you to it: this is a target
// fed to the same WALK.accel ramp as everything else, so 14.0 → 3.1 is 0.78 s
// of ordinary braking, and dropping the gun accelerates back out the same way.
const AIM_SPEED = 3.1;

const isHeli = (v) => v.rotorSpeed !== undefined;   // ducks, quacks, hovers
const isJet = (v) => v.throttle !== undefined && v.reheat !== undefined;

// seat anchor in the vehicle's LOCAL frame, whichever module owns the shape
export function localSeatAnchor(veh, i = 0) {
  return isJet(veh) ? jetSeatAnchor(veh, i)
    : isHeli(veh) ? heliSeatAnchor(veh, i) : carSeatAnchor(veh, i);
}

// …and in WORLD space, off the vehicle's live pose. Exported for main.js,
// which hangs it on window.__atc.seatAnchor so the net layer can place
// REMOTE riders on the seats it claims in veh.seats. Rotation convention:
// local +x maps to (cos h, −sin h), local −z to dir(h) — see ARCHITECTURE.md.
export function worldSeatAnchor(veh, i = 0) {
  const a = localSeatAnchor(veh, i);
  const h = veh.heading ?? 0, c = Math.cos(h), s = Math.sin(h);
  return {
    x: veh.x + a.x * c + a.z * s,
    y: (veh.y ?? veh.mesh?.position.y ?? 0) + a.y,
    z: veh.z - a.x * s + a.z * c,
  };
}

export class Player {
  // uid defaults to this tab's identity, so main.js needs to pass nothing; a
  // caller that already knows the uid (a replay, a test, a second local body)
  // may hand it in. jacketIdx lets an authority override just the jacket later.
  constructor(scene, x, z, heading, uid = localUid(), jacketIdx = null) {
    this.uid = uid;                        // 'base:tab' — what goes on the wire
    this.baseUid = baseUid(uid);           // the person: look and name come from here
    this.look = lookForUid(this.baseUid, jacketIdx);
    const c = makeCitizen(this.look);
    this._cit = c;
    this.mesh = c.group;
    this._animate = c.walk;
    this._sit = c.sitPose;
    this._stand = c.standPose;
    this._scene = scene;     // remembered so exiting can re-parent us to the world
    this.pos = { x, z };
    this.y = 0;              // feet height — floors, stairs, rooftops, falling
    this.vy = 0;
    this.grounded = true;
    this.heading = heading;
    this.speed = 0;          // m/s along _dir
    this.walkT = 0;          // stride phase, advanced by distance
    // ---- the two hooks js/combat.js owns; see the header ----
    // Both are plain public fields on purpose: combat.js writes them and this
    // file only ever reads them, so there is no setter to keep in sync and no
    // way for the two modules to disagree about who holds the truth.
    this.aimLock = false;    // heading follows camYaw, the stick strafes
    this.combatPose = null;  // fn(dt), applied AFTER the walk every frame
    this.inCar = null;       // vehicle object (car or heli) or null — SEATED
    this.seat = 0;           // which veh.seats slot we occupy while inCar
    this.boarding = null;    // { veh, seat, phase:'walk'|'slide', t, … } or null
    this.exiting = null;     // { veh, t, from…, to… } or null
    this._dirX = 0; this._dirZ = -1;  // last move direction — decel glides along it
    this._world = null;      // remembered from update() so beginExit() can collide
    this.mesh.scale.setScalar(PLAYER_SCALE);
    this.mesh.position.set(x, 0, z);
    this.mesh.rotation.y = heading;
    scene.add(this.mesh);
  }

  update(dt, { input, camYaw, world }) {
    this._world = world;
    if (this.exiting) { this._exitStep(dt); return; }
    if (this.boarding) { this._boardStep(dt, world); return; }
    if (this.inCar) {
      // seated: the MESH rides the vehicle (parented), but pos/heading mirror
      // it so the streamer, minimap and the exit math keep one source of truth
      this.pos.x = this.inCar.x; this.pos.z = this.inCar.z;
      this.heading = this.inCar.heading;
      // A HELICOPTER HAS NO `.speed`. helicopter.js says so out loud ("a scalar
      // speed like the cars carry would be a lie" — it flies sideways and
      // backwards, so it carries vx/vy/vz instead). Copying it blind therefore
      // left this.speed === undefined for the whole flight, and netcity.js's
      // `s: +p.speed.toFixed(2)` turned the first state packet after take-off
      // into a TypeError — thrown from inside stepGame, i.e. BEFORE the frame
      // was rendered, so co-op froze on the last drawn frame under a red banner
      // and stayed frozen, every frame, for as long as you were in the air.
      // Ground speed is the honest scalar for both machine and HUD.
      this.speed = Number.isFinite(this.inCar.speed) ? this.inCar.speed
        : Math.hypot(this.inCar.vx ?? 0, this.inCar.vz ?? 0);
      this.y = this.inCar.y ?? this.inCar.mesh?.position.y ?? 0;
      this.vy = 0;
      return;
    }

    // --- stick → world direction, relative to the camera yaw ---
    // camera forward f = dir(camYaw); screen-right r = dir(camYaw − π/2) =
    // (cos, −sin) — verified against f × up. moveZ is −1 for W (Woods input).
    const mx = input.moveX, mz = input.moveZ;
    const fX = -Math.sin(camYaw), fZ = -Math.cos(camYaw);
    const rX = Math.cos(camYaw), rZ = -Math.sin(camYaw);
    let wx = fX * -mz + rX * mx, wz = fZ * -mz + rZ * mx;
    const wl = Math.hypot(wx, wz);
    const moving = wl > 1e-3;
    if (moving) { wx /= wl; wz /= wl; this._dirX = wx; this._dirZ = wz; }

    // --- speed: snap accel toward jog/sprint, same rate braking to a stop ---
    // With the sights up there is no sprint at all and the jog is replaced by
    // AIM_SPEED. The Shift key is suppressed at the source rather than the
    // result being clamped afterwards, so there is still exactly ONE target
    // speed feeding the accel ramp below and entering or leaving aim is a
    // deceleration through the normal path, never a discontinuity.
    const sprint = !this.aimLock
      && (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight'));
    const top = this.aimLock ? AIM_SPEED : sprint ? WALK.sprint : WALK.jog;
    const target = moving ? top : 0;
    const dv = WALK.accel * dt;
    this.speed = this.speed < target
      ? Math.min(target, this.speed + dv)
      : Math.max(target, this.speed - dv);

    // --- heading: the camera's bearing while aiming, else eased toward the
    //     move direction, shortest way around ---
    if (this.aimLock) {
      // SNAPPED, not eased — the header argues this at length: an eased
      // heading and main.js's auto-follow are two controllers chasing each
      // other's output, and equality here makes the auto-follow term exactly
      // zero instead. Normalised because camYaw is a raw mouse accumulator
      // that grows without bound, and heading is read by the net layer, the
      // minimap and the exit math, all of which expect −π..π.
      //
      // Nothing else has to change for the stick to strafe: (wx, wz) above is
      // ALREADY camera-relative, so once the body sits on the camera's bearing
      // the same vector is sideways and backwards motion relative to the face
      // for free — no second frame conversion, and _dirX/_dirZ keep meaning
      // the true travel direction that the deceleration glide reads.
      this.heading = Math.atan2(Math.sin(camYaw), Math.cos(camYaw));
    } else if (moving) {
      const want = Math.atan2(-wx, -wz);
      let d = want - this.heading;
      d = ((d + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
      const step = WALK.turn * dt;
      this.heading += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }

    // --- move + collide; substep so a dt spike can't tunnel a thin wall ---
    // The collider is now a CAPSULE in spirit: only what overlaps the band
    // between "high enough that I'd have to step over it" and head height can
    // stop you. That is what lets you walk over a doorstep and a fallen slab
    // while a wall panel and a wardrobe still block.
    const cOpts = this._c ??= { interior: true, yLo: 0, yHi: 0, aboveY: 0 };
    const dist = this.speed * dt;
    if (dist > 0) {
      const steps = Math.max(1, Math.ceil(dist / (WALK.radius * 0.8)));
      const sx = this._dirX * dist / steps, sz = this._dirZ * dist / steps;
      for (let i = 0; i < steps; i++) {
        this.pos.x += sx; this.pos.z += sz;
        cOpts.yLo = this.y + INTERIOR.stepUp - 0.06;
        cOpts.yHi = this.y + INTERIOR.headroom;
        cOpts.aboveY = this.y + 0.3;   // roofs below the feet aren't obstacles
        world.collide(this.pos, WALK.radius, cOpts);
      }
      this.walkT += dist * 1.6; // stride phase rides on distance, not time
    }

    // --- vertical: stand, climb or fall ---
    // supportY answers "highest surface at or below where I could step", so
    // the three cases fall out of one query: it is above me but within a step
    // (climb), it is right under me (stand), or it is further down (fall).
    const support = world.supportY(this.pos.x, this.pos.z, this.y + INTERIOR.stepUp);
    if (support > this.y + 0.002 && support <= this.y + INTERIOR.stepUp) {
      this.y = support; this.vy = 0; this.grounded = true;
    } else if (this.y <= support + 0.04) {
      this.y = support; this.vy = 0; this.grounded = true;
    } else {
      this.vy = Math.max(-TERMINAL, this.vy - GRAVITY * dt);
      this.y += this.vy * dt;
      if (this.y <= support) { this.y = support; this.vy = 0; this.grounded = true; }
      else this.grounded = false;
    }

    // --- place + animate ---
    this.mesh.position.set(this.pos.x, this.y, this.pos.z);
    this.mesh.rotation.y = this.heading;
    // Cadence saturates (a faster run is longer strides, not blurred legs) and
    // the RUN blend takes over above WALK.runFrom, so the figure walks at a
    // walk, runs flat out at a sprint, and visibly changes gait between.
    this._animate(this.walkT, Math.min(1.25, this.speed / WALK.jog), runBlend(this.speed));
    // LAST, and after _animate deliberately: the combat poses are ADDITIVE and
    // arms-only, so walk() has to have written the whole skeleton before one of
    // them overwrites its own joints. The other way round the pose is erased
    // before it is ever drawn, silently. Only the on-foot path reaches this
    // line — boarding, riding and exiting all returned at the top of update(),
    // where the limbs belong to _sit() and a punch would be nonsense anyway.
    this.combatPose?.(dt);
  }

  // ---- boarding ----------------------------------------------------------
  // Start walking to `seat` of `veh` (a vehicles.js car or a Helicopter).
  // Claims the seat in the veh.seats occupancy registry IMMEDIATELY (created
  // lazily here), so two claimants can never both slide in; the claim is
  // released again on any cancel. cbs: { onDoor() — the door is reached,
  // play the door_open; onSeated(seat) — the handover moment, set game.car /
  // game.heli here; onCancel() — vehicle vanished / flew off mid-walk }.
  // Returns false when already busy or the seat is taken.
  boardVehicle(veh, seat = 0, cbs = null) {
    if (this.inCar || this.boarding || this.exiting) return false;
    veh.seats ??= [];                    // the occupancy registry, born here
    if (veh.seats[seat]) return false;   // somebody (maybe remote) got it first
    veh.seats[seat] = this;
    // You need both hands for a door handle. Dropped HERE rather than in
    // _finishBoard because the jog to the door is walking too, and a body that
    // strafed sideways to its own car at 3.1 m/s facing the camera would be
    // the most obviously broken thing in the game.
    this.aimLock = false;
    this.boarding = { veh, seat, phase: 'walk', t: 0,
      sx: 0, sy: 0, sz: 0, fromH: this.heading, ...(cbs ?? {}) };
    return true;
  }

  // abort mid-board (second E, or the vehicle stopped existing): release the
  // seat claim, unfold, and hand the body back to the walk controller
  cancelBoarding() {
    const b = this.boarding;
    if (!b) return;
    if (b.veh.seats?.[b.seat] === this) b.veh.seats[b.seat] = null;
    this.boarding = null;
    this.speed = 0;
    this._stand();
    b.onCancel?.();
  }

  _boardStep(dt, world) {
    const b = this.boarding, veh = b.veh;
    // interruption safety: despawned/destroyed vehicle, a seat claimed over
    // us, or a remotely-piloted machine leaving the deck → back to walking
    if (!veh.mesh?.parent || veh.seats?.[b.seat] !== this
        || (veh.airborne && b.phase === 'walk')) { this.cancelBoarding(); return; }
    const a = localSeatAnchor(veh, b.seat);
    const vy = veh.y ?? veh.mesh.position.y ?? 0;
    const h = veh.heading, ch = Math.cos(h), sh = Math.sin(h);
    // local → world, ARCHITECTURE.md rotation: +x → (cos h, −sin h), −z → dir(h)
    const wX = (lx, lz) => veh.x + lx * ch + lz * sh;
    const wZ = (lx, lz) => veh.z - lx * sh + lz * ch;
    b.t += dt;

    if (b.phase === 'walk') {
      // the door point is the seat anchor pushed out past its own flank,
      // recomputed EVERY frame so a car still creeping to a stop (or shoved
      // by traffic) keeps its door honest under our feet
      const side = Math.sign(a.x || -1) * ((veh.wid ?? 1.62) / 2 + DOOR_OUT);
      const dx = wX(side, a.z) - this.pos.x, dz = wZ(side, a.z) - this.pos.z;
      const dist = Math.hypot(dx, dz);
      // give up when it drove off, we ran out of patience (wedged on a wall),
      // or the door floats a storey away (bridge deck, remote takeoff)
      if (dist > 13 || b.t > 6 || Math.abs(vy - this.y) > 2.5) {
        this.cancelBoarding(); return;
      }
      if (dist >= DOOR_R) {
        // ease the heading toward the door and jog there like the walker does
        const want = Math.atan2(-dx, -dz);
        let dh = want - this.heading;
        dh = ((dh + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
        const stepH = WALK.turn * dt;
        this.heading += Math.abs(dh) <= stepH ? dh : Math.sign(dh) * stepH;
        const spd = Math.min(WALK.jog, 1.2 + dist * 2.0);  // slow into the door
        const mv = Math.min(dist, spd * dt);
        this.pos.x += (dx / dist) * mv; this.pos.z += (dz / dist) * mv;
        const cOpts = this._c ??= { interior: true, yLo: 0, yHi: 0, aboveY: 0 };
        cOpts.yLo = this.y + INTERIOR.stepUp - 0.06;
        cOpts.yHi = this.y + INTERIOR.headroom;
        cOpts.aboveY = this.y + 0.3;
        world.collide(this.pos, WALK.radius, cOpts);
        const sup = world.supportY(this.pos.x, this.pos.z, this.y + INTERIOR.stepUp);
        if (Math.abs(sup - this.y) <= INTERIOR.stepUp) this.y = sup;
        this.walkT += mv * 1.6;
        this.speed = mv / Math.max(dt, 1e-4);
        this.mesh.position.set(this.pos.x, this.y, this.pos.z);
        this.mesh.rotation.y = this.heading;
        // Cadence saturates (a faster run is longer strides, not blurred legs) and
    // the RUN blend takes over above WALK.runFrom, so the figure walks at a
    // walk, runs flat out at a sprint, and visibly changes gait between.
    this._animate(this.walkT, Math.min(1.25, this.speed / WALK.jog), runBlend(this.speed));
        return;
      }
      // at the door: remember where we stand IN THE VEHICLE'S FRAME so the
      // slide stays glued to the car even while it keeps creeping under us
      b.phase = 'slide'; b.t = 0;
      const rx = this.pos.x - veh.x, rz = this.pos.z - veh.z;
      b.sx = rx * ch - rz * sh;          // inverse of the wX/wZ rotation
      b.sz = rx * sh + rz * ch;
      b.sy = this.y - vy;
      b.fromH = this.heading;
      this.speed = 0;
      b.onDoor?.();                      // sfx('door_open') lives out there
    }

    // phase 'slide': door → seat, eased, in the vehicle's own frame; a small
    // sin() hop sells the climb over the sill while sitPose folds the limbs
    const k = smooth(Math.min(1, b.t / BOARD_T));
    const lx = b.sx + (a.x - b.sx) * k;
    const ly = b.sy + (a.y - SIT_DROP - b.sy) * k + Math.sin(k * Math.PI) * 0.14;
    const lz = b.sz + (a.z - b.sz) * k;
    let dh = h - b.fromH;
    dh = ((dh + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    this.heading = b.fromH + dh * k;     // turn to face the nose on the way in
    this.pos.x = wX(lx, lz); this.pos.z = wZ(lx, lz);
    this.y = vy + ly;
    this.mesh.position.set(this.pos.x, this.y, this.pos.z);
    this.mesh.rotation.y = this.heading;
    this._sit(k);
    if (b.t >= BOARD_T) this._finishBoard(b, veh, a);
  }

  // Seat reached: hand the mesh to the vehicle. PARENTED, not re-posed per
  // frame — traffic.js and driveStep() write car x/z/heading directly and
  // vehicles.update() syncs the meshes AFTER us in the frame, so copying the
  // transform here would always trail by a frame and would miss the
  // suspension roll/pitch and the offroad judder entirely. The inner body
  // group (userData.body on cars, _body on the heli) carries those tilts,
  // so a parented rider leans into corners for free.
  _finishBoard(b, veh, a) {
    this.boarding = null;
    this.inCar = veh;
    this.seat = b.seat;
    const carrier = veh.mesh?.userData?.body ?? veh._body ?? veh.mesh;
    carrier.add(this.mesh);              // three.js detaches from the scene itself
    this.mesh.position.set(a.x, a.y - SIT_DROP, a.z);
    this.mesh.rotation.y = 0;            // face the nose (local −z)
    this._sit(1);
    this.pos.x = veh.x; this.pos.z = veh.z;
    this.heading = veh.heading;
    this.speed = 0; this.vy = 0;
    b.onSeated?.(b.seat);                // ONLY now may game.car/heli be set
  }

  // ---- exiting -----------------------------------------------------------
  // A quick step-out instead of a teleport. The caller drops game.car/heli
  // BEFORE calling (control returns to the street immediately — the camera
  // flips to walk mode and this ~0.35 s just moves the body). Landing point
  // is the seat pushed 0.9 m past its own flank, shoved out of walls by
  // collide() and dropped onto the nearest deck by supportY() — stepping out
  // of a helicopter parked on a roof must NOT fall to the street.
  // cbs: { onOut() — feet on the ground, play the door_close }.
  beginExit(cbs = null) {
    const veh = this.inCar;
    if (!veh || this.exiting) return false;
    if (veh.seats?.[this.seat] === this) veh.seats[this.seat] = null;
    this.inCar = null;
    const a = localSeatAnchor(veh, this.seat);
    const h = veh.heading, ch = Math.cos(h), sh = Math.sin(h);
    const vy = veh.y ?? veh.mesh?.position.y ?? 0;
    const ox = Math.sign(a.x || -1) * ((veh.wid ?? 1.62) / 2 + 0.9);
    const t = { x: veh.x + ox * ch + a.z * sh, z: veh.z - ox * sh + a.z * ch };
    const world = this._world;
    let ty = vy;
    if (world) {
      // a couple of passes settle corner cases (door opens into a wall AND
      // the river bank, say); collide() returns false once we sit clean
      for (let i = 0; i < 3 && world.collide(t, WALK.radius); i++);
      ty = world.supportY(t.x, t.z, vy + INTERIOR.stepUp);
    }
    this._scene.add(this.mesh);          // back into world space, still folded
    this.exiting = { veh, t: 0,
      fx: veh.x + a.x * ch + a.z * sh, fy: vy + a.y - SIT_DROP,
      fz: veh.z - a.x * sh + a.z * ch,
      tx: t.x, ty, tz: t.z, ...(cbs ?? {}) };
    this.heading = h;
    this.speed = 0;
    this._dirX = -Math.sin(h); this._dirZ = -Math.cos(h);
    this.pos.x = this.exiting.fx; this.pos.z = this.exiting.fz;
    this.mesh.position.set(this.exiting.fx, this.exiting.fy, this.exiting.fz);
    this.mesh.rotation.y = h;
    return true;
  }

  _exitStep(dt) {
    const x = this.exiting;
    x.t += dt;
    const k = smooth(Math.min(1, x.t / EXIT_T));
    const px = x.fx + (x.tx - x.fx) * k;
    const pz = x.fz + (x.tz - x.fz) * k;
    const py = x.fy + (x.ty - x.fy) * k + Math.sin(k * Math.PI) * 0.12;
    this.pos.x = px; this.pos.z = pz; this.y = py;
    this.mesh.position.set(px, py, pz);
    this._sit(1 - k);                    // unfold on the way down
    if (x.t >= EXIT_T) {
      this.exiting = null;
      this.y = x.ty; this.vy = 0; this.grounded = true;
      this.mesh.position.y = x.ty;
      this._stand();                     // limbs relaxed the instant we land
      x.onOut?.();
    }
  }

  // ---- instant path (legacy) ---------------------------------------------
  // The old teleport enter/exit, kept for tools, tests and interruption
  // fallbacks — same seat registry, same parenting, zero animation. The
  // game's E key goes through boardVehicle()/beginExit() instead.
  setInCar(car) {
    if (car) {
      this.aimLock = false;              // same reason as boardVehicle()
      car.seats ??= [];
      if (!car.seats[0]) car.seats[0] = this;
      this.inCar = car;
      this.seat = 0;
      const a = localSeatAnchor(car, 0);
      const carrier = car.mesh?.userData?.body ?? car._body ?? car.mesh;
      if (carrier) {
        carrier.add(this.mesh);
        this.mesh.position.set(a.x, a.y - SIT_DROP, a.z);
        this.mesh.rotation.y = 0;
      }
      this._sit(1);
      return;
    }
    const c = this.inCar;
    this.inCar = null;
    if (c) {
      if (c.seats?.[this.seat] === this) c.seats[this.seat] = null;
      this._scene.add(this.mesh);        // world space again
      // step out 1.4 m to the vehicle's RIGHT — right of dir(h) is
      // dir(h − π/2) = (cos h, −sin h) — then let the world push us clear
      this.pos.x = c.x + Math.cos(c.heading) * 1.4;
      this.pos.z = c.z - Math.sin(c.heading) * 1.4;
      this.heading = c.heading;
      this.speed = 0;
      this._dirX = -Math.sin(c.heading); this._dirZ = -Math.cos(c.heading);
      const world = this._world;
      let y = c.y ?? c.mesh?.position.y ?? 0;
      if (world) {
        for (let i = 0; i < 3 && world.collide(this.pos, WALK.radius); i++);
        // a helicopter parked on a roof: take the surface nearest ITS level
        y = world.supportY(this.pos.x, this.pos.z, y + INTERIOR.stepUp);
      }
      this.y = y; this.vy = 0; this.grounded = true;
      this.mesh.position.set(this.pos.x, y, this.pos.z);
      this.mesh.rotation.y = this.heading;
      this._stand();
      this._animate(this.walkT, 0);      // limbs relaxed the instant we appear
    }
    this.mesh.visible = true;
  }

  // Scene teardown (mode switch, hot reload). Releases the seat first so the
  // vehicle's occupancy registry does not keep a dead body parked in it, then
  // hands the avatar back to citizen.js — which unhooks it from whatever it is
  // parented to, the scene or a car's body group.
  dispose() {
    const veh = this.inCar ?? this.boarding?.veh ?? null;
    const seat = this.inCar ? this.seat : this.boarding?.seat;
    if (veh?.seats && seat != null && veh.seats[seat] === this) veh.seats[seat] = null;
    this.inCar = null; this.boarding = null; this.exiting = null;
    this._cit.dispose();
  }
}
