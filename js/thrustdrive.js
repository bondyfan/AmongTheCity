// ---- what an electric car with thrusters is doing ----------------------------
// The twin of js/drivetrain.js for the kinds in enginekinds.js THRUST_KINDS.
// A piston car needs revs, gears and a limiter; this one has a single
// reduction, so the motor simply turns with the road, and what the voice needs
// instead is:
//
//   rpm     the motor's, straight off the wheel speed
//   load    signed. +1 is the pedal floored; below zero the motors are being
//           turned by the wheels and are charging the battery (regen), which
//           whines on its own account
//   thrust  0..1, how hard the cold gas thrusters are blowing. They open only
//           for a hard push, follow how hard the car is actually being shoved,
//           and run off a tank: a few seconds of full thrust empties it and a
//           compressor brings it back while the valves are shut
//
// Like drivetrain.js it makes no sound and reads no globals, so it runs the
// same in the game, in the offline renders and under node --test.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };

export const THRUST_DEFAULTS = {
  rpmPerMs: 215,        // motor rpm per m/s of road speed: 23 900 at 400 km/h
  rpmMax: 24000,
  open: [0.55, 0.92],   // pedal at which the valves crack open .. are wide open
  accRef: 14,           // m/s^2 of shove that counts as the thrusters' full cry
  launchV: 20,          // m/s under which a floored pedal is a launch whatever the car does
  idleShove: 0.3,       // share of the thrust left when the car is no longer gaining
  empty: 4.5,           // s of wide open valves in a full tank
  fill: 7,              // s for the compressor to refill it, valves shut
  plateau: 0.45,        // tank level above which the pressure does not sag yet
  regenV: [2, 12],      // m/s over which regen comes in
};

export function makeThrustDrive(spec = {}) {
  const B = { ...THRUST_DEFAULTS, ...spec };
  return { B, rpm: 0, load: 0, thrust: 0, valve: 0, tank: 1, th: 0, acc: 0, vPrev: 0, fresh: 1 };
}

/**
 * Advance one frame.
 *   v         road speed along the nose, m/s (>= 0)
 *   throttle  0..1 (main.js engineLoad, or throttleFromMotion for traffic)
 *   slip      0..1, tyres spinning: the motors turn faster than the road
 * Leaves rpm, load (signed), thrust and tank on d.
 */
export function thrustStep(d, v, throttle, dt, slip = 0) {
  const B = d.B;
  if (!(dt > 0)) return d;
  if (dt > 0.1) dt = 0.1;
  const th = clamp(throttle || 0, 0, 1);
  const road = v > 0 ? v : 0;
  if (d.fresh) { d.fresh = 0; d.th = th; d.vPrev = road; d.acc = 0; }
  // an electric pedal is all but instant; 25 ms keeps a tapped key from clicking
  d.th += (th - d.th) * (1 - Math.exp(-dt / 0.025));
  d.acc += (clamp((road - d.vPrev) / dt, -40, 40) - d.acc) * (1 - Math.exp(-dt / 0.09));
  d.vPrev = road;

  // ---- the motors: one gear, so the revs are the road
  const spin = clamp(slip || 0, 0, 1) * d.th;
  const vw = road * (1 + 0.35 * spin) + 5 * spin;
  d.rpm = Math.min(B.rpmMax, vw * B.rpmPerMs);
  if (d.th > 0.02) d.load = d.th;
  else {
    // foot off: the wheels drive the motors. Stronger the faster the car goes
    // and the harder it is being slowed.
    const reg = smooth(B.regenV[0], B.regenV[1], road);
    d.load = -reg * (0.55 + 0.45 * clamp(-d.acc / 8, 0, 1));
  }

  // ---- the thrusters
  d.valve = smooth(B.open[0], B.open[1], d.th);
  // how hard is the car really being pushed? Off the line the speed has not
  // had time to say, so a launch counts in full.
  const shove = Math.max(clamp(d.acc / B.accRef, 0, 1), clamp(1 - road / B.launchV, 0, 1));
  const push = B.idleShove + (1 - B.idleShove) * shove;
  // the tank: drained by how far the valves are open, whatever comes of it
  if (d.valve > 0.03) d.tank = Math.max(0, d.tank - d.valve * dt / B.empty);
  else d.tank = Math.min(1, d.tank + dt / B.fill);
  const press = Math.pow(clamp(d.tank / B.plateau, 0, 1), 0.8);
  d.thrust = d.valve * push * press;
  return d;
}
