// ---- leap.js: Space on foot. A jump, or a vault over what is in the way -------
//
// One key, two moves, and the world decides which:
//
//   VAULT  something low stands right in front of you and there is ground to
//          land on behind it: a car's bonnet, a low wall, a counter, a crash
//          barrier. One hand goes down on it, both legs go over to the side,
//          and you come down running on the far side. The whole move is a
//          path fixed at take-off (it was checked clear), so nothing can snag
//          half way over.
//   JUMP   otherwise. The legs push off, the body flies on the speed it had
//          (a running jump carries; a standing one goes straight up), and the
//          knees take the landing. The flight is the walk controller's own
//          gravity: js/player.js already falls, this only gives it an upward
//          start, so a jump can land on a ledge exactly as a fall can.
//
// "Low" is found with the collider the walker already uses, asked twice: does
// something stop a probe at shin-to-hip height, and does it NOT stop one at
// head height. A car's hull has no height in that collider, so cars are asked
// directly: the bonnet is vaultable, the cabin is not.
//
// Called by js/player.js; `p` is the Player. No three.

import { WALK, INTERIOR, PLAYER_SCALE } from './config.js';
import { jumpPose, landPose, vaultPose } from './bodymoves.js';

export const JUMP_V = 5.5;         // m/s up: with the game's gravity, 0.72 m and half a second
const PROBE = 0.75;                // m ahead: "right in front of you"
const REACH_MIN = 1.3, REACH_MAX = 3.6;   // m: how far the far side may be
const BONNET_Y = 0.95;             // m: a bonnet, above the car's own ground

const _q = { x: 0, z: 0 };
const _o = { interior: true, yLo: 0, yHi: 0, aboveY: 0 };

// how far the world pushes a probe of radius r standing at (x, z), asked for
// the band y0..y1 of the body
function pushed(world, x, z, r, y0, y1) {
  _q.x = x; _q.z = z;
  _o.yLo = y0; _o.yHi = y1; _o.aboveY = y0;
  world.collide(_q, r, _o);
  return Math.hypot(_q.x - x, _q.z - z);
}

// the car whose hull the point is in, if any, with the point in its frame
function carAt(world, x, z, out) {
  const hulls = world.carHulls?.();
  if (!hulls) return null;
  for (const c of hulls) {
    const dx = x - c.x, dz = z - c.z;
    const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
    const lx = dx * ch - dz * sh, lz = dx * sh + dz * ch;
    if (Math.abs(lx) < c.wid / 2 + 0.25 && Math.abs(lz) < c.len / 2 + 0.25) { out.lx = lx; out.lz = lz; return c; }
  }
  return null;
}
const _car = { lx: 0, lz: 0 };

/**
 * Is there something to vault, straight ahead? Returns the move
 * { tx, tz, ty, top, dist } (where the feet come down, the height of the
 * thing, how far it is across) or null.
 */
export function findVault(p, world) {
  const fx = -Math.sin(p.heading), fz = -Math.cos(p.heading), y = p.y;
  const nx = p.pos.x + fx * PROBE, nz = p.pos.z + fz * PROBE;
  if (pushed(world, nx, nz, 0.2, y + 0.30, y + 0.95) < 0.04) return null;   // nothing there
  let top = y + 0.9;
  const car = carAt(world, nx, nz, _car);
  if (car) {
    // over the bonnet only: forward of the windscreen (about a sixth of the
    // length ahead of the middle on every kind here), and not a van's flat nose
    if (!(_car.lz < -car.len * 0.16) || car.kind === 'van' || car.kind === 'truck' || car.kind === 'bus') return null;
    top = (car.y ?? y) + BONNET_Y;
  } else {
    if (pushed(world, nx, nz, 0.2, y + 1.40, y + 1.90) >= 0.04) return null;   // a wall, not a thing
    const t = world.supportY(nx, nz, y + 1.4);
    if (t > y + 0.25) top = t;
  }
  for (let d = REACH_MIN; d <= REACH_MAX; d += 0.25) {
    const x = p.pos.x + fx * d, z = p.pos.z + fz * d;
    if (pushed(world, x, z, WALK.radius * 0.9, y + INTERIOR.stepUp - 0.06, y + INTERIOR.headroom) > 0.03) continue;
    const sup = world.supportY(x, z, y + INTERIOR.stepUp + 0.3);
    if (sup > y + 0.6 || sup < y - 2.2) continue;
    return { tx: x, tz: z, ty: sup, top, dist: d };
  }
  return null;
}

/** Space, with both feet on the ground. Starts a vault or a jump. */
export function leap(p, world) {
  const v = findVault(p, world);
  if (v) {
    p.vault = { t: 0, T: 0.52 + v.dist * 0.13, fx: p.pos.x, fz: p.pos.z, fy: p.y, left: (p._vaultN = (p._vaultN | 0) + 1) % 2 === 0, ...v };
    p.onLeap?.('vault');
    return 'vault';
  }
  p.vy = JUMP_V;
  p.y += 0.02;
  p.grounded = false;
  p.airT = 0; p.jumped = true;
  p.jumpRun = p.speed > 2.6 ? 1 : 0;
  p.onLeap?.('jump');
  return 'jump';
}

/** One step of a vault. Returns false on the step the feet are down. */
export function vaultStep(p, dt) {
  const v = p.vault;
  v.t += dt;
  const k = Math.min(1, v.t / v.T);
  // a touch of ease at both ends, most of the way at a steady pace
  const e = k * 0.6 + k * k * (3 - 2 * k) * 0.4;
  p.pos.x = v.fx + (v.tx - v.fx) * e;
  p.pos.z = v.fz + (v.tz - v.fz) * e;
  // the feet's reference rides well below the top: the legs are tucked to the
  // side at hip height, and the planted hand has to reach the thing
  const base = v.fy + (v.ty - v.fy) * e;
  const lift = Math.max(0.15, v.top - 0.55 * PLAYER_SCALE - Math.min(v.fy, v.ty));
  p.y = base + lift * Math.pow(Math.sin(Math.PI * k), 1.4);
  p.vy = 0; p.grounded = true;
  p.mesh.position.set(p.pos.x, p.y, p.pos.z);
  p.mesh.rotation.y = p.heading;
  p._stand();
  vaultPose(p._cit.parts, k, v.left);
  if (k < 1) return true;
  p.vault = null;
  p.y = v.ty;
  p.speed = Math.min(WALK.jog, Math.max(p.speed, WALK.walk));
  p.landT = 0.1; p.landHard = 0.3;
  p.onLeap?.('land');
  return false;
}

/**
 * The air and the landing, laid over the walk js/player.js has just written.
 * wasGrounded: last step's footing; fell: the speed the feet arrived at, when
 * this is the step they came down.
 */
export function airStep(p, dt, wasGrounded, fell) {
  const parts = p._cit.parts;
  if (!p.grounded) {
    p.airT = (wasGrounded && !p.jumped ? 0 : p.airT) + dt;
    // a kerb or a stair is a step, not a fall: the pose comes in only once the
    // feet have been off the ground a moment (at once, for a jump)
    if (p.jumped || p.airT > 0.2) jumpPose(parts, p.jumped ? p.airT : 1, p.vy, p.jumped ? p.jumpRun : 0);
    return;
  }
  if (!wasGrounded) {
    if (p.jumped || p.airT > 0.22) {
      p.landT = 0; p.landHard = Math.min(1, Math.max(0.25, (fell - 3) / 7));
      p.onLeap?.('land');
    }
    p.jumped = false; p.airT = 0;
  }
  if (p.landT >= 0) {
    p.landT += dt;
    const T = 0.22 + 0.16 * p.landHard;
    if (p.landT >= T) p.landT = -1;
    else landPose(parts, p.landT / T, p.landHard);
  }
}
