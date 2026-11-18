// ---- what the engine is doing, from what the car is doing -------------------
// The physics (vehicles.js driveStep) knows a speed and a pedal. An engine
// voice needs revs, load and the moments in between: the clutch slipping as
// the car pulls away, the revs falling through an upshift, the blip on the way
// down, the limiter. This file is that translation and nothing else. It makes
// no sound and reads no globals, so it runs the same in the game, in the
// offline renders and under node --test.
//
// The old voice mapped each speed band straight onto idle..redline, so the
// revs were a function of speed alone: the engine could not hold a gear under
// a light foot, could not kick down, and every car shifted at the same road
// speeds whatever the driver was asking of it. Here the gearbox has real
// ratios (km/h per 1000 rpm, per gear) and decides the way a driver does: by
// revs and by how hard the pedal is down.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Gearbox manners every kind shares unless it says otherwise. */
export const BOX_DEFAULTS = {
  idle: 800, redline: 6500,
  kph: [8.6, 14.2, 21.5, 29.5, 38.5, 47.5, 57],   // km/h per 1000 rpm, per gear
  up: [1750, 6200],        // upshift revs: feathering the pedal .. floored
  down: [1150, 3600],      // downshift revs: coasting .. floored (the kickdown)
  shift: 0.24,             // s with the drive broken
  fall: 5200, rise: 9000,  // rpm/s the free engine loses and gains
  launch: 2300,            // revs the slipping clutch holds, pedal floored
  idleLoad: 0.14,          // throttle it takes to idle
};

export function makeDrivetrain(box = {}) {
  const B = { ...BOX_DEFAULTS, ...box };
  return {
    B, ratio: B.kph.map((k) => 3600 / k),      // rpm per m/s, per gear
    rpm: B.idle, load: B.idleLoad, cut: 0, gear: 0,
    shiftT: 0, shiftDir: 0, sinceShift: 9, limT: 0, th: 0, fresh: 1, vPrev: 0, dec: 0, lift: 9,
  };
}

/** The gear a driver would be in at this wheel speed and pedal. */
function wantGear(d, vw, th, g, braking = false) {
  const B = d.B, R = d.ratio, top = R.length - 1;
  const upAt = B.up[0] + (B.up[1] - B.up[0]) * th * th;
  // under braking the box comes down early and keeps the engine pulling back
  const downAt = B.down[0] + (B.down[1] - B.down[0]) * th + (braking ? 0.3 * (B.up[0] - B.down[0]) : 0);
  if (vw * R[g] > upAt && g < top && !braking) return g + 1;
  // down, and further down while the lower gear would still not be screaming:
  // flooring it at 60 in sixth drops three gears, not one
  let n = g;
  while (n > 0 && vw * R[n] < downAt && vw * R[n - 1] < upAt * 0.9) n--;
  return n;
}

/**
 * Advance one frame.
 *   v         road speed along the nose, m/s (>= 0)
 *   throttle  0..1, the load the engine is asked for (main.js engineLoad)
 *   slip      0..1, tyres spinning or sliding (car.slip01): driven wheels
 *             turning faster than the road is what lets a slide hit the limiter
 * Leaves rpm, load (what the voice should burn), cut (limiter) and gear on d.
 */
export function drivetrainStep(d, v, throttle, dt, slip = 0) {
  const B = d.B, R = d.ratio;
  if (!(dt > 0)) return d;
  if (dt > 0.1) dt = 0.1;
  const th = clamp(throttle || 0, 0, 1);
  // the pedal itself is not instant: a foot takes a moment, and so does a turbo
  d.th += (th - d.th) * (1 - Math.exp(-dt / 0.06));
  const road = v > 0 ? v : 0;
  // driven wheels that have let go turn faster than the road goes by
  const spin = clamp(slip || 0, 0, 1) * th;
  const vw = road * (1 + 0.5 * spin) + 7 * spin;
  d.sinceShift += dt;
  // is the car being braked? Only the speed can say: 2 m/s^2 is more than
  // lifting off loses at any speed a car does in town
  d.dec += ((road - d.vPrev) / dt - d.dec) * Math.min(1, dt * 8);
  d.vPrev = road;
  const braking = !d.fresh && d.dec < -2 && th < 0.05;
  // and how long has the foot been off? A box does not change up the instant
  // the pedal is released: the driver may be about to brake, or to floor it.
  d.lift = th < 0.05 ? d.lift + dt : 0;
  const settling = th < 0.05 && d.lift < 0.6;
  // a voice that starts on a car already at speed is already in gear: no
  // run up through the box from first
  if (d.fresh) {
    d.fresh = 0; d.th = th; d.dec = 0; d.lift = 9;
    for (let i = 0, g = -1; i < R.length && g !== d.gear; i++) { g = d.gear; d.gear = wantGear(d, road, th, g); }
    d.rpm = Math.max(B.idle, Math.min(B.redline, vw * R[d.gear]));
  }

  // ---- the gearbox decides
  if (d.shiftT <= 0 && d.sinceShift > 0.38) {
    let g = vw < 1.2 ? 0 : wantGear(d, vw, d.th, d.gear, braking);
    // nobody changes up in the middle of a slide: the gear is held and the
    // engine is left to find the limiter
    if ((spin > 0.3 || settling) && g > d.gear) g = d.gear;
    if (g !== d.gear) {
      d.shiftDir = g > d.gear ? 1 : -1;
      d.gear = g; d.shiftT = B.shift; d.sinceShift = 0;
    }
  }

  // ---- the revs the wheels are asking for in this gear
  let target = vw * R[d.gear];
  // pulling away: the clutch (or the converter) slips and holds the engine up
  // where it makes torque until the wheels catch up with it
  if (d.gear === 0) {
    const hold = B.idle + (B.launch - B.idle) * d.th;
    if (target < hold) target = hold;
  }
  if (target < B.idle) target = B.idle;

  let load, cut = 0;
  if (d.shiftT > 0) {
    // drive broken: the engine is on its own and swings to meet the new gear.
    // Up, it just falls. Down, the throttle is blipped to bring it up.
    // It gets there by the time the drive comes back, however short the shift:
    // a twin clutch pulls the revs down far faster than they would fall.
    const natural = (d.shiftDir > 0 ? B.fall : B.rise) * dt;
    const needed = Math.abs(target - d.rpm) * dt / Math.max(d.shiftT, dt);
    const rate = Math.max(natural, needed);
    d.shiftT -= dt;
    d.rpm += clamp(target - d.rpm, -rate, rate);
    load = d.shiftDir > 0 ? 0 : 0.4;
  } else {
    // drive taken up: stiff, not rigid. The driveline winds up a little.
    d.rpm += (target - d.rpm) * (1 - Math.exp(-dt / 0.055));
    if (d.th > 0.03) load = B.idleLoad + (1 - B.idleLoad) * d.th;
    else {
      // foot off: fuel is cut while the wheels turn the engine, and comes back
      // as the revs come down to idle so that it does not stall
      const k = clamp((B.idle + 450 - d.rpm) / 450, 0, 1);
      load = B.idleLoad * k * k * (3 - 2 * k);
    }
  }

  // ---- the limiter: fuel cut in bursts, the engine bouncing under the line
  if (d.rpm >= B.redline) {
    d.rpm = B.redline;
    if (d.limT <= 0) d.limT = 0.115;               // one cut-and-recover period
  }
  if (d.limT > 0) {
    d.limT -= dt;
    if (d.limT > 0.05) { cut = 1; d.rpm -= 2600 * dt; }   // 65 ms dead, 50 ms alive
  }
  d.load = clamp(load, 0, 1);
  d.cut = cut;
  return d;
}

/**
 * Traffic has no pedal to read, only a speed. This guesses the pedal from what
 * the car is doing: holding a speed takes a little (more the faster it goes),
 * gaining speed takes a lot, losing it takes none.
 *   accel  m/s^2 along the nose, smoothed by the caller
 */
export function throttleFromMotion(v, accel, vmax = 40, accelMax = 5) {
  const cruise = 0.1 + 0.35 * clamp(v / vmax, 0, 1) ** 2;
  if (accel < -0.6) return 0;                      // braking or lifted
  return clamp(cruise + accel / accelMax, 0, 1);
}
