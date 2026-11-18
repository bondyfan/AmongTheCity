// ---- dogwalk.js: what a dog on a lead does, as arithmetic ----------------------
// No three.js: js/dogs.js draws, this decides where the dog is. A dog is a
// point that trots toward a target beside its owner, and what makes it a dog
// is what it does to that target:
//
//   heel    a step ahead of the owner's knee, on the side of the hand that
//           holds the lead
//   pull    out in front at the end of the lead, which goes taut
//   sniff   it has found something: it stops dead with its nose down while the
//           owner walks on, until the lead comes tight, and then trots to
//           catch up
//   sit     the owner has stopped (a kerb, a bus stop, a bench): after a
//           moment the dog sits by them, and now and then gets up to sniff
//   stay    the owner is on the ground or has their hands up: the dog sits
//           beside them and waits
//
// THIS IS LOCAL. Who has a dog, which dog and what colour is shared (it comes
// off the citizen's seed, js/pedprops.js); where the dog has its nose this
// second is each client's own, like the swing of a walker's arm.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function rnd(d) {
  // a small generator of the dog's own (mulberry32)
  d.rs = (d.rs + 0x6d2b79f5) >>> 0;
  let t = d.rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A dog standing at its owner's heel. `breed` is a row of js/pedprops.js DOG_BREEDS. */
export function makeDog(seed, breed, o) {
  const d = {
    rs: seed >>> 0, breed, x: 0, z: 0, h: o.h, v: 0, mode: 'heel', t: 0, still: 0,
    tx: 0, tz: 0, phase: 0, reach: 0, head: 0, wag: 0.3, sit: 0, taut: 0,
  };
  d.t = 2 + rnd(d) * 5;
  const fx = -Math.sin(o.h), fz = -Math.cos(o.h), rx = Math.cos(o.h), rz = -Math.sin(o.h);
  d.x = o.x + fx * 0.5 + rx * o.side * 0.5;
  d.z = o.z + fz * 0.5 + rz * o.side * 0.5;
  return d;
}

/**
 * One step. `o` is the owner this frame:
 *   { x, z, h, speed (m/s), side (+1 lead in the right hand, -1 left),
 *     hx, hz (the hand), mode: 'walk' | 'down' }
 * Mutates and returns d.
 */
export function stepDog(d, o, dt) {
  const fx = -Math.sin(o.h), fz = -Math.cos(o.h), rx = Math.cos(o.h), rz = -Math.sin(o.h);
  const lead = d.breed.lead, size = d.breed.size;
  const moving = o.speed > 0.2 && o.mode === 'walk';
  d.still = moving ? 0 : d.still + dt;
  d.t -= dt;

  // ---- what it wants ----
  if (o.mode !== 'walk') d.mode = 'stay';
  else if (!moving) {
    if (d.mode !== 'sit' && d.mode !== 'nose') { d.mode = 'sit'; d.t = 5 + rnd(d) * 8; }
    else if (d.t <= 0) {
      // up for a sniff round the owner's feet, then back to sitting
      if (d.mode === 'sit') {
        d.mode = 'nose'; d.t = 2.5 + rnd(d) * 2.5;
        const a = rnd(d) * TAU, r = 0.5 + rnd(d) * 0.5;
        d.tx = o.x + Math.cos(a) * r; d.tz = o.z + Math.sin(a) * r;
      } else { d.mode = 'sit'; d.t = 6 + rnd(d) * 9; }
    }
  } else if (d.mode === 'sit' || d.mode === 'nose' || d.mode === 'stay') { d.mode = 'heel'; d.t = 2 + rnd(d) * 4; }
  else if (d.mode === 'sniff') {
    const out = Math.hypot(d.x - o.hx, d.z - o.hz);
    if (out > lead * 0.96 || d.t <= 0) { d.mode = 'heel'; d.t = 3 + rnd(d) * 6; }
  } else if (d.t <= 0) {
    const r = rnd(d);
    if (d.mode === 'heel' && r < 0.45) { d.mode = 'pull'; d.t = 2.5 + rnd(d) * 4.5; }
    else if (r < 0.8) {
      // something by the wall: stop there, a little to the lead's own side
      d.mode = 'sniff'; d.t = 2.6 + rnd(d) * 1.6;
      d.tx = d.x + fx * 0.25 + rx * o.side * (0.15 + rnd(d) * 0.4); d.tz = d.z + fz * 0.25 + rz * o.side * (0.15 + rnd(d) * 0.4);
    } else { d.mode = 'heel'; d.t = 3 + rnd(d) * 6; }
  }

  let tx, tz;
  if (d.mode === 'pull') { tx = o.x + fx * lead * 0.95 + rx * o.side * 0.22; tz = o.z + fz * lead * 0.95 + rz * o.side * 0.22; }
  else if (d.mode === 'sniff' || d.mode === 'nose') { tx = d.tx; tz = d.tz; }
  else if (d.mode === 'stay') { tx = o.x + rx * 0.75; tz = o.z + rz * 0.75; }
  else if (d.mode === 'sit') { tx = o.x + fx * 0.12 + rx * o.side * 0.48; tz = o.z + fz * 0.12 + rz * o.side * 0.48; }
  else { tx = o.x + fx * 0.58 + rx * o.side * 0.5; tz = o.z + fz * 0.58 + rz * o.side * 0.5; }

  // ---- getting there ----
  const ex = tx - d.x, ez = tz - d.z, dist = Math.hypot(ex, ez);
  const vmax = Math.max(1.6, o.speed * 2.1 + 1.0);
  let want = dist < 0.06 ? 0 : clamp(dist * 3.4, 0.25, vmax);
  if (d.mode === 'heel' || d.mode === 'pull') want = Math.max(want, moving ? o.speed * 0.85 : 0) * (dist < 0.06 ? 0 : 1);
  d.v += clamp(want - d.v, -9 * dt, 7 * dt);
  const step = Math.min(dist, d.v * dt);
  let moved = 0;
  if (dist > 1e-4 && step > 0) { d.x += ex / dist * step; d.z += ez / dist * step; moved = step; }

  // ---- the lead is a length, not a suggestion ----
  const lx = d.x - o.hx, lz = d.z - o.hz, out = Math.hypot(lx, lz);
  if (out > lead) {
    const k = lead / out;
    const nx = o.hx + lx * k, nz = o.hz + lz * k;
    moved += Math.hypot(nx - d.x, nz - d.z);
    d.x = nx; d.z = nz;
  }
  d.taut += ((out > lead * 0.9 ? 1 : 0) - d.taut) * Math.min(1, dt * 8);

  // ---- how it looks ----
  const sp = moved / (dt || 1e-3);
  let face = d.h;
  if (sp > 0.3 && dist > 0.15) face = Math.atan2(-ex, -ez);
  else if (d.mode === 'sit' || d.mode === 'stay' || d.mode === 'heel') face = o.h;
  let dh = face - d.h;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  d.h += dh * Math.min(1, dt * (sp > 0.3 ? 9 : 3));
  d.phase = (d.phase + moved * 7.2 / (size * d.breed.leg)) % TAU;
  d.reach += (clamp(sp * 0.36, 0, 0.72) - d.reach) * Math.min(1, dt * 10);
  const sitting = (d.mode === 'sit' || d.mode === 'stay') && dist < 0.3 && d.still > 1.1;
  d.sit += ((sitting ? 1 : 0) - d.sit) * Math.min(1, dt * 5);
  const nose = d.mode === 'sniff' || d.mode === 'nose' ? (dist < 0.35 ? -0.95 : -0.5) : d.mode === 'pull' ? -0.12 : d.sit > 0.5 ? 0.22 : 0.04;
  d.head += (nose - d.head) * Math.min(1, dt * 6);
  d.wag += ((d.mode === 'heel' || sitting ? 0.42 : d.mode === 'pull' ? 0.12 : 0.3) - d.wag) * Math.min(1, dt * 3);
  return d;
}
