// ==========================================================================
// Policeram: a unit OFF its rail, close to you. Following, ramming, the PIT,
// pulling up beside a stopped car and blocking the road ahead.
//
// WHY A UNIT LEAVES THE RAIL. On the rail (police.js) a unit drives the lane,
// which is right for the chase and wrong for the last thirty metres: a lane
// never touches your car, so nothing could ever hit you. Inside FREE_IN, with
// you in sight, the unit is driven as a free body instead: a heading that
// turns at a rate a car can turn at (YAW_MAX, and less at walking pace), a
// speed with real acceleration and braking, and nothing else. It is NOT moved
// into you: it drives at you, and the CONTACT is vehicles.js driveStep's
// car-to-car solver, the same one that resolves you hitting a parked car. So
// a ram costs you exactly the speed and the spin the physics says it does,
// and a ram the physics says missed, missed.
//
// THE PIT. From three stars a unit beside your rear wheel turns in by PIT_TURN
// (about 34 degrees). The solver's own off-centre torque turns you; on the
// contact this file adds PIT_YAW of yaw rate to your car on top, because the
// solver's two-disc hull under-reads a rear-quarter hit (the torque arm of a
// disc contact at the rear axle is half the real one), and a PIT that only
// ever nudged you would not read as one. That one number is the only thing
// here that is not the solver, and it is stated rather than hidden.
//
// FAIRNESS. Every ram is TELEGRAPHED: a unit has to sit FOLLOW_GAP behind
// you, lined up, for TELL_T, and then it sounds its horn before it commits.
// After any contact it backs off for the tier's ramCd. A ram that has not
// connected within RAM_T gives up. You can always see it coming in the mirror
// and you can always brake, swerve or turn off.
//
// BACK TO THE RAIL. Past FREE_OUT, or blind for BLIND_T, or nosed into a wall,
// the unit finds the nearest lane going its way (rejoin) and carries the
// difference as a blend offset that decays over a second, so it does not pop.
// ==========================================================================

import { distPointToSegment } from './geo.js';
import { horn } from './audio.js';

export const FREE_IN = 30;      // m: closer than this, in sight, a unit leaves the rail
export const FREE_OUT = 62;     // m: further than this it goes back
const BLIND_T = 2.5;            // s without sight before it goes back
const YAW_MAX = 1.9;            // rad/s at speed
const R_MIN = 5.5;              // m: the tightest radius it may turn, so no pirouettes
const ACC = 6.5, ACC_RAM = 8.5, BRAKE = 10;
const FOLLOW_GAP = 9;           // m behind you while it lines up
const TELL_T = 1.1;             // s lined up before a ram
const RAM_T = 3.2;              // s a committed ram lasts
const PIT_SIDE = 2.4;           // m beside your centre line while it lines up
const PIT_TURN = 0.6;           // rad it turns in by
const PIT_YAW = 1.1;            // rad/s added to your yaw on a PIT contact (see header)
const PIT_T = 1.6;              // s a committed PIT lasts
const ALIGN_T = 5;              // s it may spend lining up before it gives up
const STOP_GAP = 7;             // m it pulls up short of a stopped player
const BLOCK_AHEAD = 16;         // m in front of you a blocking unit stops
const WALL_T = 1.2;             // s nosed into a building before it gives up
const CONTACT_GAP = 0.4;        // s without contact that makes the next one NEW
const REJOIN_R = 20;            // m: how far it will look for a lane
const BLEND_K = 2.5;            // 1/s decay of the rejoin offset

const _s = { x: 0, z: 0, t: 0 };
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Should a railed unit leave the rail this step? `P` is police.js's per-step
 * player record, `u` the unit. Only a chasing unit that can see you, and only
 * when there is something on the ground to drive at (a car, or you on foot).
 */
export function wantsFree(u, P, d) {
  if (u.release || !u.sees || d > FREE_IN) return false;
  return !!P.car || P.onFoot;
}

/** Enter free mode, picking the opening manoeuvre. */
export function enterFree(u, P, t, tier) {
  u.mode = 'free';
  u.freeAt = t;
  u.blindAt = t;
  u.wallT = 0;
  const relA = (u.x - P.x) * P.fx + (u.z - P.z) * P.fz;
  if (P.slow) setSub(u, 'stop', t);
  else if (tier && tier.box && u.role >= 2 && relA > 4) setSub(u, 'block', t);
  else setSub(u, 'follow', t);
}

function setSub(u, s, t) { u.sub = s; u.subAt = t; }

/**
 * One step of a free unit. Returns false when the unit should go back to the
 * rail (police.js then calls rejoin). `pol` is the Police (for the city, the
 * stats and the clock), `P` the player record, `tier` the star tier.
 */
export function freeStep(pol, u, dt, P, tier) {
  const car = u.car;
  const t = pol._t;
  // What the collision solver did to us since the last step is the truth.
  u.x = car.x; u.z = car.z; u.heading = car.heading;
  u.speed = Number.isFinite(car.speed) ? car.speed : 0;

  // ---- contact bookkeeping: driveStep stamps _rammedT = 2.5 on a touch ----
  const rt = car._rammedT ?? 0;
  let contact = false;
  if (rt >= 2.45) {
    if (t - u.contactAt > CONTACT_GAP) contact = true;
    u.contactAt = t;
  }
  if (rt > 0) car._rammedT = Math.max(0, rt - dt);
  if (contact) onContact(pol, u, P, t, tier);

  const dx = P.x - u.x, dz = P.z - u.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (u.sees) u.blindAt = t;
  if (d > FREE_OUT || t - u.blindAt > BLIND_T) return false;

  const relA = (u.x - P.x) * P.fx + (u.z - P.z) * P.fz;
  const relL = (u.x - P.x) * P.rx + (u.z - P.z) * P.rz;
  const vmax = tier ? tier.vmax : 42;

  // ---- transitions ---------------------------------------------------
  if (P.slow && u.sub !== 'stop') setSub(u, 'stop', t);
  else if (!P.slow && u.sub === 'stop' && P.speed > 5) setSub(u, 'follow', t);
  if (u.sub === 'block' && relA < -5) setSub(u, 'follow', t);
  if (u.sub === 'follow' && tier && tier.ram && !P.onFoot && t >= u.ramCdAt
    && t >= pol._ramGateAt && t - u.subAt > TELL_T && relA < -4 && relA > -FOLLOW_GAP - 8 && Math.abs(relL) < 2.5) {
    if (tier.pit && P.speed > 9 && pol.rnd() < 0.55) {
      u.pitSide = pol.rnd() < 0.5 ? -1 : 1;
      setSub(u, 'pitAlign', t);
    } else {
      setSub(u, 'ram', t);
      pol.stats.ramTries++;
      horn(u.x, u.z);                         // THE TELEGRAPH
    }
  }
  if (u.sub === 'ram' && t - u.subAt > RAM_T) setSub(u, 'follow', t);
  if (u.sub === 'pitAlign') {
    if (t - u.subAt > ALIGN_T) setSub(u, 'follow', t);
    else if (relA > -2.6 && relA < 0.4 && Math.abs(relL) > 1.5 && Math.abs(relL) < 3.6
      && Math.sign(relL) === u.pitSide) {
      setSub(u, 'pit', t);
      pol.stats.pitTries++;
      horn(u.x, u.z);
    }
  }
  if (u.sub === 'pit' && t - u.subAt > PIT_T) setSub(u, 'follow', t);

  // ---- where, and how fast -------------------------------------------
  let ax = P.x, az = P.z, vt = 0, hd = NaN, acc = ACC;
  switch (u.sub) {
    case 'stop': {
      // each unit pulls up on its own bearing round you, so two cars do not
      // aim for the same spot and end up inside each other
      const k = d > 0.5 ? STOP_GAP / d : 0;
      const rot = u.role === 0 ? 0 : (u.role & 1 ? 0.8 : -0.8) * Math.ceil(u.role / 2);
      const c = Math.cos(rot), sn = Math.sin(rot);
      const ox = -dx * k, oz = -dz * k;
      ax = P.x + ox * c - oz * sn; az = P.z + ox * sn + oz * c;
      vt = clamp((d - STOP_GAP) * 0.9, 0, 14);
      // a man on foot: brake hard where you are and let the crew go after him
      if (P.onFoot && d < 16) vt = 0;
      break;
    }
    case 'block': {
      ax = P.x + P.fx * BLOCK_AHEAD; az = P.z + P.fz * BLOCK_AHEAD;
      const db = Math.hypot(ax - u.x, az - u.z);
      vt = clamp(db * 0.7, 0, 16);
      if (db < 3) hd = Math.atan2(-dx, -dz);    // stopped, nose at you
      break;
    }
    case 'ram':
      ax = P.x + P.fx * 1.2; az = P.z + P.fz * 1.2;
      vt = P.speed + (tier ? tier.ramClose : 5);
      acc = ACC_RAM;
      break;
    case 'pitAlign':
      ax = P.x - P.fx * 1.0 + P.rx * PIT_SIDE * u.pitSide;
      az = P.z - P.fz * 1.0 + P.rz * PIT_SIDE * u.pitSide;
      vt = P.speed + clamp((-1.0 - relA) * 0.9, -4, 4);
      break;
    case 'pit':
      hd = P.heading + u.pitSide * PIT_TURN;
      vt = P.speed + 3;
      acc = ACC_RAM;
      break;
    default: {                                  // follow
      ax = P.x - P.fx * FOLLOW_GAP; az = P.z - P.fz * FOLLOW_GAP;
      const gap = -relA - FOLLOW_GAP;            // + = too far back
      vt = P.speed + clamp(gap * 0.8, -6, 8);
      if (d < 5) vt = Math.min(vt, P.speed - 2);
    }
  }
  if (!Number.isFinite(hd)) {
    const hx = ax - u.x, hz = az - u.z;
    hd = Math.hypot(hx, hz) > 1.5 ? Math.atan2(-hx, -hz) : u.heading;
  }
  if (vt > vmax) vt = vmax;
  // another unit (parked, or free) dead ahead: do not drive through it
  {
    const hf = -Math.sin(u.heading), hz = -Math.cos(u.heading);
    const pool = pol._pool;
    for (let i = 0; i < pool.length; i++) {
      const o = pool[i];
      if (o === u || o.free || !o.car) continue;
      const rx = o.x - u.x, rz = o.z - u.z;
      const fwd = rx * hf + rz * hz;
      if (fwd <= 0 || fwd > 9) continue;
      if (Math.abs(hf * rz - hz * rx) > 2.4) continue;
      const cap = Math.max(0, (fwd - 5) * 1.6);
      if (cap < vt) vt = cap;
    }
  }
  if (vt < 0) vt = 0;

  // ---- steer like a car ----------------------------------------------
  const err = angWrap(hd - u.heading);
  const yawMax = Math.min(YAW_MAX, 0.25 + Math.abs(u.speed) / R_MIN);
  u.heading = angWrap(u.heading + clamp(err, -yawMax * dt, yawMax * dt));
  // a hard turn is taken slowly, as anyone would
  const turnCap = Math.max(4, 26 * (1 - Math.abs(err) / 1.6));
  if (vt > turnCap) vt = turnCap;
  if (u.speed < vt) u.speed = Math.min(vt, u.speed + acc * dt);
  else u.speed = Math.max(vt, u.speed - BRAKE * dt);

  // ---- architecture: never drive into a house ------------------------
  const fx = -Math.sin(u.heading), fz = -Math.cos(u.heading);
  const look = (car.len ?? 4.4) / 2 + 0.8 + Math.max(0, u.speed) * 0.25;
  if (pol._blocked(u.x + fx * look, u.z + fz * look)) {
    u.speed = Math.min(u.speed, 1.5);
    u.wallT += dt;
    if (u.wallT > WALL_T) return false;
  } else u.wallT = 0;

  u.x += fx * u.speed * dt;
  u.z += fz * u.speed * dt;
  u.y = pol._freeY(u, P);
  car.x = u.x; car.z = u.z; car.y = u.y;
  car.steer = clamp(err * 0.8, -0.6, 0.6);
  car.heading = u.heading;
  car.speed = u.speed;
  car._lat = 0;
  const m = car.mesh;
  if (m) { m.position.set(u.x, u.y, u.z); m.rotation.y = u.heading; }
  return true;
}

function onContact(pol, u, P, t, tier) {
  const st = pol.stats;
  st.contacts++;
  // One shunt at a time for the whole force: three cars taking turns inside
  // two seconds is not a pursuit, it is a car crusher.
  if (u.sub === 'ram' || u.sub === 'pit') pol._ramGateAt = t + (tier ? tier.ramCd : 4) * 0.7;
  if (u.sub === 'ram') {
    st.rams++;
    u.ramCdAt = t + (tier ? tier.ramCd : 4);
    setSub(u, 'follow', t);
    pol._crimeOnContact?.();
  } else if (u.sub === 'pit') {
    st.pits++;
    // see the header: the solver under-reads a rear-quarter torque arm
    const pc = P.car;
    if (pc) pc.yaw = clamp((pc.yaw ?? 0) - u.pitSide * PIT_YAW, -3.6, 3.6);
    u.ramCdAt = t + (tier ? tier.ramCd : 4);
    setSub(u, 'follow', t);
  }
}

/**
 * Put a free unit back on the nearest lane that goes its way. Returns false
 * if there is none within REJOIN_R (the unit then stays free and the stuck
 * valve in police.js decides). Carries the position difference as a blend
 * offset (u.bx, u.bz) that police.js's _place decays.
 */
export function rejoin(pol, u) {
  const edges = pol.traffic?.edges;
  if (!edges || !edges.length) return false;
  const fx = -Math.sin(u.heading), fz = -Math.cos(u.heading);
  let best = null, bd = Infinity, bs = 0, bseg = 0;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const pts = e.pts;
    if (!pts || pts.length < 2 || !e.cum) continue;
    const mx = e.mx ?? (pts[0][0] + pts[pts.length - 1][0]) / 2;
    const mz = e.mz ?? (pts[0][1] + pts[pts.length - 1][1]) / 2;
    const reach = e.len / 2 + REJOIN_R;
    const ddx = u.x - mx, ddz = u.z - mz;
    if (ddx * ddx + ddz * ddz > reach * reach) continue;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      let dd = distPointToSegment(u.x, u.z, a[0], a[1], b[0], b[1], _s);
      if (dd > REJOIN_R) continue;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const dot = ((b[0] - a[0]) * fx + (b[1] - a[1]) * fz) / L;
      if (dot < 0) dd += 12;                    // the other carriageway, at a price
      if (dd < bd) { bd = dd; best = e; bseg = k; bs = e.cum[k] + _s.t * (e.cum[k + 1] - e.cum[k]); }
    }
  }
  if (!best) return false;
  u.edge = best; u.s = Math.max(0, Math.min(best.len, bs)); u.seg = bseg;
  u.mode = 'rail'; u.sub = '';
  u.blendNew = true;                            // _place measures the offset on its next call
  return true;
}

export const BLEND = BLEND_K;
