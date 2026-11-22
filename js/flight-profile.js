// ---- flight-profile.js: how a narrowbody leaves a runway and arrives on one ----
// Pure arithmetic, no three.js, so the numbers can be pinned by a test the way
// tests/aircraft.test.mjs pins the Gripen's. The airliner is not flown by the
// player (he is in seat 14A), so this is an autopilot with a crew's habits:
//
//   take-off  the engines spool for four seconds, the roll accelerates at
//             about 2 m/s², the nose comes up at VR 72 m/s (140 kt) at 2.6
//             degrees a second, the wheels leave at 77 m/s with the pitch past
//             8 degrees: 1.4 to 1.8 km of runway, which is what an A320 out of
//             a 2.5 km runway uses. Gear up a few seconds after lift-off,
//             flaps up at 350 m, a 25 degree banked turn onto the outbound
//             track once 400 m above the field.
//   approach  the 3 degree glide path to an aiming point 300 m past the
//             threshold, 68 m/s on final with full flap, the flare from 10 m,
//             touchdown at under a metre a second, the nose lowered, reverse
//             and autobrake at 2.3 m/s² down to taxi speed.
//
// A runway frame is { x, z } (the threshold the wheels cross first), heading
// (the direction of travel, ARCHITECTURE.md convention: travel along
// (−sin h, −cos h)) and y (the runway's height). Everything works in "s"
// (metres past the threshold along the runway) and "e" (metres to its right).

const G = 9.81, D2R = Math.PI / 180;
export const FLY = {
  thrust: 2.35, // m/s² at full take-off power on the roll
  drag: 0.000105, // the v² term of the roll's resistance
  rolling: 0.15, // m/s² of tyre and bearing friction
  vr: 72, vlof: 77, // rotation and lift-off, m/s
  rotRate: 2.6 * D2R, // the pitch rate the crew rotates at
  climbGamma: 7.5 * D2R, // the climb's flight-path angle
  climbSpeed: 88, cleanSpeed: 115, // m/s below and above 350 m
  vapp: 68, // final approach speed, m/s
  glide: 3 * D2R, aim: 300, // the glide path and where it meets the runway
  flareAt: 10, // m above the runway where the flare starts
  decel: 2.3, decelLow: 1.6, // rollout braking: reverse + autobrake, then the brakes alone
  bank: 25 * D2R, // the turn's bank, the standard airliner one
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** A fresh state for an airliner standing at (x, y, z) facing `heading`. */
export function airlinerState(x, y, z, heading) {
  return { x, y, z, heading, pitch: 0, roll: 0, speed: 0, vy: 0, onGround: true, gear: 1, flaps: 0.35, n1: 0.2,
    reverse: 0, brakes: 0, phase: 'stand', t: 0 };
}

/** Where (x, z) is in a runway frame: s along it past the threshold, e to its right. */
export function runwayLocal(rw, x, z) {
  const dx = -Math.sin(rw.heading), dz = -Math.cos(rw.heading);
  const ox = x - rw.x, oz = z - rw.z;
  return { s: ox * dx + oz * dz, e: ox * -dz + oz * dx };
}
/** The world point at (s, e) of a runway frame. */
export function runwayWorld(rw, s, e = 0) {
  const dx = -Math.sin(rw.heading), dz = -Math.cos(rw.heading);
  return { x: rw.x + dx * s - dz * e, z: rw.z + dz * s + dx * e };
}

function advance(m, dt) {
  const cg = Math.cos(Math.asin(clamp(m.vy / Math.max(1, m.speed), -0.9, 0.9)));
  m.x += -Math.sin(m.heading) * m.speed * cg * dt;
  m.z += -Math.cos(m.heading) * m.speed * cg * dt;
  m.y += m.vy * dt;
}
// roll toward a wanted heading, and let the bank turn the aircraft (ω = g·tan φ / V)
function steer(m, want, dt, bankMax = FLY.bank) {
  const err = wrap(want - m.heading);
  // ARCHITECTURE.md: turning right DEcreases heading and a right bank is a
  // negative roll, so a left turn (err > 0) wants a positive roll, and a
  // positive roll turns the heading up
  const wantRoll = clamp(err * 1.6, -bankMax, bankMax);
  m.roll += clamp(wantRoll - m.roll, -0.36 * dt, 0.36 * dt);
  m.heading = wrap(m.heading + (G * Math.tan(m.roll)) / Math.max(40, m.speed) * dt);
}

/**
 * One step of the take-off and the climb out. `rw` is the departure runway
 * frame, `outbound` the heading to turn onto, `ground` the field's height.
 * Sets m.phase to 'roll', 'rotate', 'climb' as it goes.
 */
export function takeoffStep(m, rw, outbound, dt) {
  m.t += dt;
  m.n1 = Math.min(0.95, m.n1 + dt * 0.19);
  const agl = m.y - rw.y;
  if (m.onGround) {
    m.phase = m.speed >= FLY.vr ? 'rotate' : 'roll';
    const a = FLY.thrust * (m.n1 / 0.95) - FLY.drag * m.speed * m.speed - FLY.rolling;
    m.speed = Math.max(0, m.speed + a * dt);
    m.heading = rw.heading;
    if (m.speed >= FLY.vr) m.pitch = Math.min(15 * D2R, m.pitch + FLY.rotRate * dt);
    // the main gear is the pivot: the origin stays on the runway until lift-off
    if (m.speed >= FLY.vlof && m.pitch >= 8 * D2R) { m.onGround = false; m.vy = 0.5; }
    m.vy = m.onGround ? 0 : m.vy;
    advance(m, dt);
    if (m.onGround) m.y = rw.y;
    return m;
  }
  m.phase = 'climb';
  const wantV = agl > 350 ? FLY.cleanSpeed : FLY.climbSpeed;
  m.speed += clamp(wantV - m.speed, -0.6 * dt, 0.9 * dt);
  const wantVy = m.speed * Math.sin(FLY.climbGamma) * clamp(agl / 15 + 0.35, 0, 1);
  m.vy += clamp(wantVy - m.vy, -2 * dt, 2 * dt);
  // body pitch = flight path + angle of attack, the attack shrinking as it speeds up
  const gamma = Math.asin(clamp(m.vy / m.speed, -0.5, 0.5));
  const aoa = 5.5 * D2R * (78 / m.speed) ** 2;
  m.pitch += clamp(gamma + aoa - m.pitch, -0.05 * dt * 4, 0.05 * dt * 4);
  if (agl > 8) m.gear = Math.max(0, m.gear - dt / 9);
  if (agl > 350) m.flaps = Math.max(0, m.flaps - dt / 25);
  if (agl > 400) steer(m, outbound, dt);
  else m.roll += -m.roll * Math.min(1, dt * 2);
  advance(m, dt);
  return m;
}

/**
 * One step of the approach, the landing and the rollout down to `taxiSpeed`.
 * `rw` is the landing runway frame (threshold first). m.phase runs 'final',
 * 'flare', 'rollout', and 'vacate' once it is slow enough to turn off.
 */
export function landingStep(m, rw, dt, taxiSpeed = 10) {
  m.t += dt;
  const { s, e } = runwayLocal(rw, m.x, m.z);
  const h = m.y - rw.y;
  if (!m.onGround) {
    m.gear = Math.min(1, m.gear + dt / 9);
    m.flaps = Math.min(1, m.flaps + dt / 20);
    m.speed += clamp(FLY.vapp - m.speed, -0.45 * dt, 0.3 * dt);
    // laterally: aim at the centreline, the intercept angle shrinking as it closes
    const cut = clamp(-e * 0.004, -0.3, 0.3);
    steer(m, rw.heading - cut, dt, 12 * D2R);
    const path = Math.max(0, (FLY.aim - s) * Math.tan(FLY.glide));
    let wantVy;
    if (h > FLY.flareAt) {
      m.phase = 'final';
      wantVy = -m.speed * Math.tan(FLY.glide) + clamp((path - h) * 0.12, -4, 4);
      m.n1 += clamp(0.55 - m.n1, -dt * 0.3, dt * 0.3);
    } else {
      m.phase = 'flare';
      // the sink rate eases off with the height that is left: a greaser, not a thud
      wantVy = -0.55 - 2.9 * (h / FLY.flareAt);
      m.n1 += clamp(0.28 - m.n1, -dt * 0.4, dt * 0.4);
    }
    m.vy += clamp(wantVy - m.vy, -2.5 * dt, 2.5 * dt);
    const gamma = Math.asin(clamp(m.vy / m.speed, -0.5, 0.5));
    const wantPitch = gamma + (m.phase === 'flare' ? 6.0 : 4.5) * D2R;
    m.pitch += clamp(wantPitch - m.pitch, -0.04 * dt * 4, 0.04 * dt * 4);
    advance(m, dt);
    if (m.y <= rw.y) {
      m.y = rw.y;
      m.touchdown = { s: runwayLocal(rw, m.x, m.z).s, vy: m.vy, speed: m.speed };
      m.vy = 0;
      m.onGround = true;
      m.roll = 0;
    }
    return m;
  }
  // the rollout: the nose comes down, reverse and autobrake, then the brakes alone
  m.pitch = Math.max(0, m.pitch - dt * 2 * D2R);
  m.roll = 0;
  m.y = rw.y;
  m.heading += wrap(rw.heading - m.heading) * Math.min(1, dt * 0.8);
  const fast = m.speed > 26;
  m.phase = m.speed > taxiSpeed + 0.2 ? 'rollout' : 'vacate';
  m.reverse = fast && m.pitch < 1 * D2R ? Math.min(1, m.reverse + dt * 0.8) : Math.max(0, m.reverse - dt * 0.6);
  m.n1 += clamp((m.reverse > 0.3 ? 0.7 : 0.22) - m.n1, -dt * 0.4, dt * 0.4);
  m.flaps = m.speed < 40 ? Math.max(0, m.flaps - dt / 20) : m.flaps;
  if (m.speed > taxiSpeed) m.speed = Math.max(taxiSpeed, m.speed - (fast ? FLY.decel : FLY.decelLow) * dt);
  // drift back onto the centreline while it rolls
  const cut = clamp(-e * 0.02, -0.05, 0.05);
  m.heading = wrap(m.heading - cut * dt);
  advance(m, dt);
  m.y = rw.y;
  return m;
}

/** The state of an airliner on final, `dist` metres before the threshold, on the glide path at `vapp`. */
export function onFinal(rw, dist = 9000) {
  const p = runwayWorld(rw, -dist, 0);
  const m = airlinerState(p.x, rw.y + (dist + FLY.aim) * Math.tan(FLY.glide), p.z, rw.heading);
  Object.assign(m, { onGround: false, speed: FLY.vapp + 4, vy: -(FLY.vapp + 4) * Math.tan(FLY.glide), gear: 1, flaps: 1,
    n1: 0.55, pitch: 1.5 * D2R, phase: 'final' });
  return m;
}
