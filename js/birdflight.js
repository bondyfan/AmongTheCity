// ---- birdflight.js: how one bird gets from a seat into the air and back -------
// Pure arithmetic on a plain record, no three.js: js/birds.js owns the records
// and the instanced mesh, this owns the motion, and a headless test can fly a
// bird from a lamp to a roof without a renderer.
//
// A bird is a point with a velocity that STEERS: every frame it wants to be
// going at its cruising speed toward the next waypoint, and may change its
// velocity only so fast. That one rule gives the things that make a take-off
// read as a bird rather than as a thrown stone: it leaves in the direction it
// was scared, comes round in an arc, and a flock whose members differ a little
// in pace and in where they aim strings out and closes up by itself.
//
//   SEAT   sitting. Costs nothing once the wings have closed.
//   WAIT   scared, not gone yet: each bird has its own nerve (a few tenths of
//          a second), which is what makes a flock go up as a ripple
//   FLY    steering along the flock's waypoints
//   LAND   the last metres: slower and slower onto the seat, wings beating hard
//   GONE   left the neighbourhood; the owner hides it

export const MODE = Object.freeze({ SEAT: 0, WAIT: 1, FLY: 2, LAND: 3, GONE: 4 });

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** A bird at rest on a seat { x, y, z, yaw }. `seed` 0..1 is its own. */
export function makeBird(seat, seed = 0) {
  return {
    mode: MODE.SEAT, x: seat.x, y: seat.y, z: seat.z, yaw: seat.yaw, pitch: 0, bank: 0,
    vx: 0, vy: 0, vz: 0, phase: seed * TAU, spread: 0, amp: 0, seed,
    seat, t: 0, age: 0, wp: 0, ox: 0, oy: 0, oz: 0, pace: 1, still: true,
  };
}

/**
 * Scare a seated bird: after `delay` seconds it jumps off along (ax, az), a
 * unit vector pointing AWAY from whatever came, and then follows `route`.
 *   route  { pts: [[x, y, z], ...], seat: {x, y, z, yaw} | null }: the waypoints
 *          the whole flock shares, and where THIS bird lands at the end (null:
 *          it leaves, and is GONE at the last waypoint)
 *   r      three numbers 0..1 of this bird's own (spread in the flock, pace)
 */
export function launch(b, ax, az, route, delay, r = [0.5, 0.5, 0.5]) {
  b.mode = MODE.WAIT; b.t = delay; b.age = 0; b.wp = 0; b.still = false;
  b.route = route;
  b.ax = ax; b.az = az;
  // where it flies relative to the flock's line, and how fast against the rest
  b.ox = (r[0] - 0.5) * 3.2; b.oy = (r[1] - 0.5) * 1.6; b.oz = (r[2] - 0.5) * 3.2;
  b.pace = 0.88 + 0.26 * r[1];
  return b;
}

/**
 * Advance one bird by dt. `sp` is its species (js/birdsites.js SPECIES).
 * Returns true while the bird still needs drawing afresh each frame.
 */
export function stepBird(b, dt, sp) {
  if (b.mode === MODE.SEAT) {
    if (b.still) return false;
    b.spread = Math.max(0, b.spread - dt * 5);
    b.pitch += (0 - b.pitch) * Math.min(1, dt * 10);
    b.bank = 0;
    if (b.spread === 0 && Math.abs(b.pitch) < 0.01) { b.pitch = 0; b.still = true; }
    return true;
  }
  if (b.mode === MODE.GONE) return false;
  if (b.mode === MODE.WAIT) {
    b.t -= dt;
    // the crouch before the jump: wings half out, body tipping forward
    b.spread = Math.min(0.5, b.spread + dt * 4);
    b.amp = sp.amp * 0.5; b.phase += dt * sp.hz * TAU;
    if (b.t > 0) return true;
    b.mode = MODE.FLY;
    const kick = 2.6 + 1.6 * b.pace;
    b.vx = b.ax * kick; b.vz = b.az * kick; b.vy = 3.4 + 1.4 * b.pace;
  }
  b.age += dt;
  const route = b.route, pts = route.pts, last = b.wp >= pts.length - 1;
  const w = pts[Math.min(b.wp, pts.length - 1)];
  const seat = route.seat;
  let tx, ty, tz;
  if (b.mode === MODE.LAND) { tx = seat.x; ty = seat.y; tz = seat.z; }
  else if (last && seat) { tx = seat.x; ty = seat.y + 1.1; tz = seat.z; }     // come in from over it
  else { tx = w[0] + b.ox; ty = w[1] + b.oy; tz = w[2] + b.oz; }
  const ex = tx - b.x, ey = ty - b.y, ez = tz - b.z;
  const d = Math.hypot(ex, ey, ez) || 1e-6;

  if (b.mode === MODE.LAND) {
    // straight onto the seat, braking all the way in
    const v = Math.max(0.7, Math.min(sp.cruise * 0.6, d * 2.4));
    const g = Math.min(1, dt * 7);
    b.vx += (ex / d * v - b.vx) * g; b.vy += (ey / d * v - b.vy) * g; b.vz += (ez / d * v - b.vz) * g;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    b.spread = 1; b.amp = sp.amp * 1.15; b.phase += dt * sp.hz * 1.25 * TAU;
    b.pitch += (0.55 - b.pitch) * Math.min(1, dt * 6);          // the flare
    b.bank *= 1 - Math.min(1, dt * 6);
    faceVel(b, dt, 8);
    if (d < 0.14 || b.age > 40) {
      b.mode = MODE.SEAT; b.seat = seat; b.x = seat.x; b.y = seat.y; b.z = seat.z; b.yaw = seat.yaw;
      b.vx = b.vy = b.vz = 0; b.still = false; b.route = null;
    }
    return true;
  }

  // ---- FLY ----
  if (last) {
    if (seat && d < 2.2) { b.mode = MODE.LAND; return true; }
    if (!seat && d < 6) { b.mode = MODE.GONE; return false; }
  } else if (d < 5) b.wp++;
  const cruise = sp.cruise * b.pace * (last && seat ? clamp(d / 9, 0.45, 1) : 1);
  let axx = (ex / d * cruise - b.vx) * 2.4, ayy = (ey / d * cruise - b.vy) * 2.4, azz = (ez / d * cruise - b.vz) * 2.4;
  const a = Math.hypot(axx, ayy, azz), lim = sp.accel;
  if (a > lim) { const k = lim / a; axx *= k; ayy *= k; azz *= k; }
  // the first half second is all legs and wings: straight up and away
  const burst = b.age < 0.55 ? 1 - b.age / 0.55 : 0;
  b.vx += axx * dt * (1 - 0.6 * burst); b.vz += azz * dt * (1 - 0.6 * burst);
  b.vy += (ayy * (1 - burst) + 7 * burst) * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;

  // ---- how it looks doing it ----
  const hv = Math.hypot(b.vx, b.vz), climb = b.vy;
  const work = clamp(0.5 + climb * 0.22 + burst * 0.9 + (cruise - hv) * 0.08, 0.2, 1.6);
  // a long-winged bird coming down sets its wings; a sparrow shuts them between bursts
  const gliding = sp.glide > 0 && climb < -0.3 && burst === 0 && Math.sin(b.age * 0.9 + b.seed * 9) < sp.glide * 2 - 1;
  let open = 1;
  if (sp.bound && burst === 0) open = Math.sin(b.age * 7.5 + b.seed * 20) > -0.35 ? 1 : 0.14;
  b.spread += (open - b.spread) * Math.min(1, dt * 14);
  b.amp += ((gliding ? 0.08 : sp.amp * (0.72 + 0.3 * work)) - b.amp) * Math.min(1, dt * 8);
  b.phase += dt * sp.hz * (0.8 + 0.42 * work) * TAU;
  const yaw0 = b.yaw;
  faceVel(b, dt, 6);
  let dy = b.yaw - yaw0;
  if (dy > Math.PI) dy -= TAU; else if (dy < -Math.PI) dy += TAU;
  b.bank += (clamp(dy / (dt || 1e-3) * 0.35, -0.9, 0.9) - b.bank) * Math.min(1, dt * 5);
  b.pitch += (clamp(Math.atan2(climb, hv + 0.5), -0.7, 0.9) - b.pitch) * Math.min(1, dt * 6);
  return true;
}

// turn the body toward where it is going (facing is (-sin yaw, -cos yaw))
function faceVel(b, dt, rate) {
  if (b.vx * b.vx + b.vz * b.vz < 0.04) return;
  const want = Math.atan2(-b.vx, -b.vz);
  let d = want - b.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  b.yaw += d * Math.min(1, dt * rate);
}

/**
 * The waypoints of a flock going from (x, y, z) to (tx, ty, tz), flushed away
 * from a threat along the unit vector (ax, az): out and up first, round in an
 * arc, then over the place it lands. `top` is how high the highest thing on
 * the way stands (the owner samples the roofs); `loop` 0..1 swings the arc
 * wider, which is the wheel a pigeon flock makes over a square.
 */
export function routeTo(x, y, z, tx, ty, tz, ax, az, top = 0, loop = 0.4) {
  const d = Math.hypot(tx - x, tz - z);
  const high = Math.max(y, ty, top) + 2.5 + Math.min(9, d * 0.12);
  // away from the threat first, climbing
  const out = 7 + 5 * loop;
  const p1 = [x + ax * out, Math.min(high, y + 4.5), z + az * out];
  // half way, pushed sideways off the straight line by the loop
  const mx = (x + tx) / 2, mz = (z + tz) / 2, L = d || 1;
  const sx = -(tz - z) / L, sz = (tx - x) / L;
  const side = (sx * ax + sz * az) >= 0 ? 1 : -1;
  const p2 = [mx + sx * side * d * 0.35 * loop + ax * 4, high, mz + sz * side * d * 0.35 * loop + az * 4];
  return [p1, p2, [tx, Math.max(ty + 1.6, Math.min(high, ty + 5)), tz]];
}

/**
 * The waypoints of a flock that leaves: up and away along (ax, az), bending
 * off to one side. `top` is how high the roofs stand on the way out (the owner
 * samples them): the flock clears them before it goes anywhere.
 */
export function routeAway(x, y, z, ax, az, turn = 0.5, far = 190, top = 0) {
  const c = Math.cos(turn), s = Math.sin(turn);
  const bx = ax * c - az * s, bz = ax * s + az * c, over = Math.max(y + 16, top + 4);
  return [[x + ax * 7, Math.max(y + 5, Math.min(over, y + 12)), z + az * 7], [x + ax * 34 + bx * 16, over, z + az * 34 + bz * 16],
    [x + bx * far, over + 18, z + bz * far]];
}

/** A short hop: the flock lifts and settles a few metres off, low over the pavement. */
export function routeHop(x, y, z, tx, ty, tz) {
  return [[(x + tx) / 2, Math.max(y, ty) + 1.3, (z + tz) / 2], [tx, ty + 0.9, tz]];
}
