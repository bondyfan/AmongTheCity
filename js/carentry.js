// ---- carentry.js: getting into a car through its door, and out again ---------
//
// js/player.js owns the boarding state machine (walk to the vehicle, sit, ride,
// step out). For a helicopter or a jet that is still a slide from the flank to
// the seat. For a car with a door (js/cardoor.js doorSpec) it is this:
//
//   in    walk to where you stand to open it ─▶ reach   a hand to the handle
//                                                 │
//                              locked ◀───────────┴───────────▶ open
//                     tug   two pulls, it does                  the door swings
//                           not give, walk away                 out in the hand
//                                                                 │
//                                                               enter  round the
//                                                                 │    door, duck,
//                                                                 ▼    sit
//                                                         seated (player.js)
//                                                         + the arm goes out and
//                                                           pulls the door shut
//
//   out   open  the door goes out from the seat ─▶ out  round it onto the road
//                                                  └─▶ the door swings shut
//                                                      behind you as you go
//
// The body is kept in the CAR's frame the whole way (a car being boarded may
// still be creeping), and the door itself is js/cardoor.js setDoor(car, seat,
// 0..1). Player methods call in here with `p`, the Player.

import { SIT_DROP } from './seating.js';
import { setDoor, doorSpec } from './cardoor.js';
import { reachPose, tugPose, swingPose, duckPose, pullDoorPose, haulPose } from './bodymoves.js';

const T_REACH = 0.24, T_TUG = 0.95, T_OPEN = 0.42, T_ENTER = 0.74, T_SHUT = 0.40, T_JACK = 0.62;
const T_XOPEN = 0.28, T_XOUT = 0.52, T_XSHUT = 0.34;
const TWO_PI = Math.PI * 2;
const smooth = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const wrap = (a) => ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;

/** The door this boarding goes through, or null (no door: the old slide). */
export function entryDoor(veh, seat) {
  if (!veh || typeof veh.kind !== 'string' || seat > 1) return null;
  try { return doorSpec(veh.kind, seat); } catch { return null; }
}

// a heading (game convention) for a direction given in the car's frame
function headingOf(veh, lx, lz) {
  const ch = Math.cos(veh.heading), sh = Math.sin(veh.heading);
  return Math.atan2(-(lx * ch + lz * sh), -(-lx * sh + lz * ch));
}

function place(p, veh, lx, ly, lz, heading) {
  const ch = Math.cos(veh.heading), sh = Math.sin(veh.heading);
  p.pos.x = veh.x + lx * ch + lz * sh;
  p.pos.z = veh.z - lx * sh + lz * ch;
  p.y = (veh.y ?? veh.mesh?.position.y ?? 0) + ly;
  p.heading = heading;
  p.mesh.position.set(p.pos.x, p.y, p.pos.z);
  p.mesh.rotation.y = heading;
}

/**
 * One step of a boarding that has reached the door (b.phase is past 'walk').
 * b: the player's boarding record, with door (the spec), sx/sy/sz (where the
 * feet stand, car frame), fromH. `a` is the seat the body will sit on.
 */
export function entryStep(p, b, dt, a) {
  const veh = b.veh, d = b.door, parts = p._cit.parts;
  const right = d.side < 0;                  // the hand that is nearer the handle
  const faceH = headingOf(veh, d.handle.x - b.sx, d.handle.z - b.sz);
  b.t += dt;

  if (b.phase === 'reach') {
    const k = Math.min(1, b.t / T_REACH);
    place(p, veh, b.sx, b.sy, b.sz, b.fromH + wrap(faceH - b.fromH) * smooth(k));
    p._stand();
    reachPose(parts, k, right);
    if (k < 1) return;
    b.phase = b.locked ? 'tug' : 'open'; b.t = 0;
    if (b.locked) b.onLocked?.(); else b.onDoor?.();
    return;
  }
  if (b.phase === 'tug') {
    const k = Math.min(1, b.t / T_TUG);
    place(p, veh, b.sx, b.sy, b.sz, faceH);
    p._stand();
    tugPose(parts, k, right);
    if (k >= 1) { b.refused = true; p.cancelBoarding(); }
    return;
  }
  if (b.phase === 'open') {
    const k = Math.min(1, b.t / T_OPEN);
    setDoor(veh, b.seat, smooth(k));
    place(p, veh, b.sx, b.sy, b.sz, faceH);
    p._stand();
    swingPose(parts, k, right);
    if (k >= 1) { b.phase = b.jack ? 'jack' : 'enter'; b.t = 0; }
    return;
  }
  if (b.phase === 'jack') {
    // somebody is sitting there: both hands in, a heave, and b.onJack() has
    // them out on the road (js/carjack.js) before we take the seat
    const k = Math.min(1, b.t / T_JACK);
    setDoor(veh, b.seat, 1);
    place(p, veh, b.sx, b.sy, b.sz, faceH);
    p._stand();
    haulPose(parts, k, right);
    if (k >= 0.42 && !b.jacked) { b.jacked = true; b.onJack?.(); }
    if (k >= 1) { b.phase = 'enter'; b.t = 0; }
    return;
  }
  // 'enter': round the open door, over the sill, into the seat
  const k = Math.min(1, b.t / T_ENTER), e = smooth(k);
  setDoor(veh, b.seat, 1);
  const sillX = d.side * ((veh.wid ?? 1.8) / 2 + 0.10), sillZ = a.z + 0.06;
  const u = 1 - e;
  const lx = u * u * b.sx + 2 * u * e * sillX + e * e * a.x;
  const lz = u * u * b.sz + 2 * u * e * sillZ + e * e * a.z;
  const ty = a.y - SIT_DROP;
  const ly = b.sy + (ty - b.sy) * smooth((k - 0.3) / 0.7) + Math.sin(e * Math.PI) * 0.05;
  place(p, veh, lx, ly, lz, faceH + wrap(veh.heading - faceH) * smooth(k / 0.8));
  p._sit(smooth((k - 0.30) / 0.70));
  duckPose(parts, k, right);
  if (k >= 1) {
    // seated: the arm goes out and the door comes shut behind the handover
    // (set first: onSeated, inside _finishBoard, can see that a door is coming)
    p.doorAnim = { veh, seat: b.seat, t: 0, T: T_SHUT, pull: true, left: d.side < 0, onShut: b.onShut ?? null };
    p._finishBoard(b, veh, a);
  }
}

/** A boarding given up with the door already moving: let it fall shut. */
export function entryCancel(p, b) {
  if (b.door && (b.phase === 'open' || b.phase === 'enter' || b.phase === 'jack')) {
    p.doorAnim = { veh: b.veh, seat: b.seat, t: 0, T: T_XSHUT, pull: false, left: false, onShut: b.onShut ?? null };
  }
}

/**
 * One step of the door swinging shut on its own record (player.doorAnim),
 * whatever the body is doing meanwhile. Returns false when it is done.
 */
export function doorStep(p, dt) {
  const d = p.doorAnim, veh = d.veh;
  if (!veh.mesh?.parent) { p.doorAnim = null; return false; }
  d.t += dt;
  const k = Math.min(1, d.t / d.T);
  // slow off the stop, fast into the latch: a door that is pulled, not lowered
  setDoor(veh, d.seat, 1 - k * k);
  if (d.pull && p.inCar === veh) {
    p._sit(1);
    pullDoorPose(p._cit.parts, k, d.left);
  }
  if (k < 1) return true;
  setDoor(veh, d.seat, 0);
  p.doorAnim = null;
  if (d.pull && p.inCar === veh) p._sit(1);
  d.onShut?.();
  return false;
}

/**
 * One step of stepping out through the door. x is player.exiting, with door
 * (the spec), seat, the seat point f*, the landing point t* (world).
 * Returns true on the step the feet are down.
 */
export function exitStep(p, x, dt) {
  const veh = x.veh, d = x.door, parts = p._cit.parts;
  x.t += dt;
  if (x.phase === 'open') {
    const k = Math.min(1, x.t / T_XOPEN);
    setDoor(veh, x.seat, smooth(k));
    p.mesh.position.set(x.fx, x.fy, x.fz);
    p._sit(1);
    pullDoorPose(parts, 1 - k, d.side < 0);
    if (k >= 1) { x.phase = 'out'; x.t = 0; }
    return false;
  }
  const k = Math.min(1, x.t / T_XOUT), e = smooth(k), u = 1 - e;
  // by way of the sill, as on the way in
  const ch = Math.cos(veh.heading), sh = Math.sin(veh.heading);
  const sl = d.side * ((veh.wid ?? 1.8) / 2 + 0.10);
  const mx = x.fx + (sl - x.ax) * ch, mz = x.fz - (sl - x.ax) * sh;
  const px = u * u * x.fx + 2 * u * e * mx + e * e * x.tx;
  const pz = u * u * x.fz + 2 * u * e * mz + e * e * x.tz;
  const py = x.fy + (x.ty - x.fy) * smooth(k / 0.75) + Math.sin(e * Math.PI) * 0.05;
  p.pos.x = px; p.pos.z = pz; p.y = py;
  p.mesh.position.set(px, py, pz);
  // turn to face along the car's flank, away from the door's edge
  p.heading = veh.heading + wrap(x.toH - veh.heading) * e;
  p.mesh.rotation.y = p.heading;
  p._sit(1 - smooth(k / 0.7));
  duckPose(parts, 1 - k, d.side < 0);
  if (k < 1) return false;
  p.doorAnim = { veh, seat: x.seat, t: 0, T: T_XSHUT, pull: false, left: false, onShut: x.onShut ?? null };
  return true;
}
