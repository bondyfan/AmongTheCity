// ---- The AI's hands and feet: a path-following driver for js/traffic.js ----
// "Když auta NPC zatáčí, otočí se okamžitě. Musí mít tuhé tělo, normální
// fyziku, jako moje." Until this module the traffic AI was a rail: a car's
// position WAS a point of its lane polyline, and its heading was eased towards
// the polyline's direction. At a junction the polyline turns 90 degrees on a
// single vertex, so the car pivoted on its own centre at up to 20 rad/s.
//
// Now a car is a BODY with a pose, a speed, a sideways velocity and a yaw rate,
// and the lane is only where its driver is trying to go:
//
//   - THE LANE is rounded first (js/ailane.js): every corner, and every
//     zigzag of short edges through a junction box, becomes one curve of a
//     radius the vehicle can drive.
//   - STEERING puts the front axle on that curve (a Stanley controller with
//     the curve's own curvature fed forward), so the car neither pivots at a
//     vertex nor cuts the inside of the corner.
//   - NEAR THE PLAYER the body is the player's own tyre model (vehicles.js
//     tyreStep: slip angles, Pacejka, load transfer, yaw inertia), so it rolls
//     and pitches like his, and a shove from his bumper is a real push and spin.
//   - FAR AWAY it is a kinematic bicycle on the same steering: curvature limited
//     by the steering lock and by the grip, and rate limited, so it still never
//     snaps, at a fraction of the cost.
//   - THE SPEED PLANNER (ailane curveCap) reads the radius of each rounded
//     corner ahead and brakes to the speed at which the turn stays inside a
//     comfortable share of the grip.
//
// The longitudinal intent (what speed the driver WANTS: limits, lights, the car
// in front, people) is still traffic.js's business; this module only turns that
// intent into pedals and a wheel, and reports back where along the lane the
// body has got to. Coordinates: +x east, -z north; heading h has forward
// (-sin h, -cos h) and right (cos h, -sin h); positive steer turns the nose to
// the right, which is heading DECREASING (the vehicles.js convention).
//
// Everything here is local to one client (the driving layer, see the header of
// js/traffic.js on schedule against driving layer): plain arithmetic, no
// allocation per call, no Math.random.

export const AI = {
  WHEELBASE: 0.6,     // x len, the same ratio vehicles.js uses
  A_LAT: 4.2,         // m/s2 a driver is willing to corner at (under a third of the grip)
  A_LAT_BIG: 2.8,     // ...and a bus or a lorry, with people standing or a load on
  KAPPA_RATE: 0.9,    // 1/m per s: how fast the far model may change its curvature
  LOCK: 0.62,         // rad of front wheel at a standstill (config CAR.steerMax)
  LOCK_K: 0.026,      // its falloff per km/h (config CAR.steerSpeedK)…
  LOCK_V: 9,          // …but only above this speed (m/s), see lockAt
  LOCK_CRAWL: 1.05,   // rad allowed at a walking pace, for corners tighter than the lock (see lockAt)
  CRAWL_LO: 1.6,      // m/s: full crawl lock at or below this…
  CRAWL_HI: 3,        // …back to LOCK by this
  STEER_RATE: 5,      // rad/s the AI winds the wheel (a calm driver, not a stab)
  YAW_K: 0.35,        // s: yaw rate feedback on top of the geometric steer
  STAN_K: 1.6,        // 1/s: Stanley gain on the front axle's sideways error…
  STAN_V: 1.5,        // …softened by this many m/s, so a crawl does not saw at the wheel
};

/**
 * The radius a vehicle's corners are rounded for: a fifth more than the
 * tightest its lock can drive (wheelbase / tan(lock)), and never under 5 m.
 * An Octavia rounds at 5 m, a twelve-metre bus at 12.
 */
export const cornerR = (len) => Math.max(5, 1.2 * len * 0.6 / Math.tan(0.62));


/**
 * The wheel angle that puts the FRONT AXLE on the lane (a Stanley controller
 * with the lane's own curvature fed forward): the curvature the lane has
 * there, plus the heading the car is off it by, plus the arc tangent of the
 * front axle's sideways error over the speed. Unlike pure pursuit this does
 * not cut the inside of a corner by the square of a look-ahead; the body
 * follows the rounded lane to a few tens of centimetres. `f` is laneFoot of
 * the front axle. + is to the right.
 */
export function stanley(b, f, v) {
  const L = b.len * AI.WHEELBASE;
  const fa = L * 0.45;
  const fx = b.x - Math.sin(b.heading) * fa, fz = b.z - Math.cos(b.heading) * fa;
  const e = (fx - f.x) * -f.dz + (fz - f.z) * f.dx;          // + : right of the lane
  let he = b.heading - Math.atan2(-f.dx, -f.dz);              // + : pointing left of it
  he = Math.atan2(Math.sin(he), Math.cos(he));
  const av = v < 0 ? -v : v;
  let d = Math.atan(L * f.k) + he - Math.atan(AI.STAN_K * e / (av + AI.STAN_V));
  // the tyres turn the car a little less than the geometry says, and this
  // takes the difference out of the yaw rate rather than out of the lane
  if (av > 3) d -= AI.YAW_K * (-v * f.k - (b.yaw ?? 0)) * L / Math.max(4, av);
  const lk = lockAt(v);
  return d > lk ? lk : d < -lk ? -lk : d;
}

/**
 * The front wheel's lock at a speed. The player's falloff (config steerSpeedK)
 * exists because a key is all or nothing; the AI's hands are not, so it keeps
 * the full geometric lock (an Octavia's 5 m turning radius) through town speed
 * and only gives it up past LOCK_V, where it is a stability margin.
 *
 * At a walking pace it gets MORE than the geometric lock. OSM draws some
 * service-road bends and junction corners tighter than any car can turn on
 * its wheels, and a body held to the real lock simply ran wide there, onto the
 * pavement and into whoever stood on it (about 3 % of all car samples, all at
 * such corners). A driver in that spot shuffles round in a few short moves; at
 * the crawl the planner slows such a corner to (ailane curveCap TIGHT_V) the
 * extra lock does the same job in one smooth arc, and nobody sees the wheels.
 */
export const lockAt = (v) => {
  const av = Math.abs(v);
  if (av < AI.CRAWL_HI) {
    const u = av <= AI.CRAWL_LO ? 1 : (AI.CRAWL_HI - av) / (AI.CRAWL_HI - AI.CRAWL_LO);
    return AI.LOCK + (AI.LOCK_CRAWL - AI.LOCK) * u;
  }
  const a = av - AI.LOCK_V;
  return a > 0 ? AI.LOCK / (1 + AI.LOCK_K * a * 3.6) : AI.LOCK;
};

/**
 * Pedal for a wanted acceleration on the tyre model's longitudinal law
 * (vehicles.js: accel (1 - v/vmax)^1.3 on throttle, brake on the pedal, engine
 * drag only while coasting). Returns { gas, hb } into `out`. Never reverses:
 * a negative pedal on a car at rest is reverse gear, so a stopped car that is
 * told to stop holds on the handbrake instead.
 */
export const pedal = { gas: 0, hb: false };
export function pedalFor(aWant, v, K, brakeMax, out = pedal) {
  out.hb = false;
  if (aWant >= 0) {
    const avail = K.accel * Math.pow(Math.max(0.02, 1 - v / K.vmax), 1.3);
    // a little throttle always: with the pedal off the model coasts against
    // engine drag, which at 50 km/h is five metres per second squared
    out.gas = Math.min(1, Math.max(0.012, aWant / avail));
  } else if (v > 0.4) {
    // (down to 1.3 of the pedal: the planner's BRAKE_HARD is 14 m/s2 against
    // the player's 11, an ABS emergency stop rather than a foot on the brake)
    out.gas = Math.max(-1.3, Math.min(-0.011, aWant / brakeMax));
  } else {
    out.gas = 0; out.hb = true;
  }
  return out;
}

/**
 * The cheap body: a kinematic bicycle at speed v on curvature `kappa`, the
 * curvature itself limited by the lock, by the grip (v^2 k <= aLat) and in
 * how fast it may change. Mutates b (x, z, heading, speed, yaw, kappa, steer).
 */
export function kinStep(b, kappaWant, v, dt, aLat) {
  const L = b.len * AI.WHEELBASE;
  const kLock = Math.tan(lockAt(v)) / L;
  const kGrip = v > 1 ? (aLat * 2.5) / (v * v) : Infinity;   // never past the tyres, with margin
  let kMax = kLock < kGrip ? kLock : kGrip;
  let k = kappaWant > kMax ? kMax : kappaWant < -kMax ? -kMax : kappaWant;
  const dk = AI.KAPPA_RATE * dt * (1 + Math.abs(v) * 0.05) + 0.02 * dt * 20;
  const k0 = b.kappa ?? 0;
  k = k > k0 + dk ? k0 + dk : k < k0 - dk ? k0 - dk : k;
  b.kappa = k;
  b.speed = v;
  b.yaw = -v * k;
  b._lat = 0;
  // integrate on the arc's midpoint heading: exact for a constant curvature
  const hm = b.heading + b.yaw * dt * 0.5;
  b.x += -Math.sin(hm) * v * dt;
  b.z += -Math.cos(hm) * v * dt;
  b.heading += b.yaw * dt;
  b.steer = Math.atan(L * k);
}

/**
 * A blow from another car, as an impulse on a rigid body with yaw inertia.
 * `b` is the struck body (x, z, heading, speed, _lat, yaw, len, wid), mB its
 * mass ratio; (ax, az, ah, alen) the striking car's pose and (avx, avz) its
 * velocity BEFORE the blow, mA its mass. The contact point is the pair of
 * closest points on the two cars' long axes; the normal runs from the striker
 * to the struck. Returns the closing speed (0 when they were not closing).
 */
export function ramImpulse(b, mB, ax, az, ah, alen, avx, avz, mA, e = 0.15) {
  const bfx = -Math.sin(b.heading), bfz = -Math.cos(b.heading);
  const brx = Math.cos(b.heading), brz = -Math.sin(b.heading);
  const afx = -Math.sin(ah), afz = -Math.cos(ah);
  const hb = b.len * 0.5 - b.wid * 0.5, ha = alen * 0.5 - 0.9;
  // closest points of the two axis segments (two short alternations suffice)
  let ta = 0, tb = 0;
  for (let it = 0; it < 3; it++) {
    const pbx = b.x + bfx * tb, pbz = b.z + bfz * tb;
    ta = (pbx - ax) * afx + (pbz - az) * afz;
    ta = ta > ha ? ha : ta < -ha ? -ha : ta;
    const pax = ax + afx * ta, paz = az + afz * ta;
    tb = (pax - b.x) * bfx + (paz - b.z) * bfz;
    tb = tb > hb ? hb : tb < -hb ? -hb : tb;
  }
  const pbx = b.x + bfx * tb, pbz = b.z + bfz * tb;
  const pax = ax + afx * ta, paz = az + afz * ta;
  let nx = pbx - pax, nz = pbz - paz;
  let nl = Math.sqrt(nx * nx + nz * nz);
  if (nl < 1e-3) { nx = b.x - ax; nz = b.z - az; nl = Math.sqrt(nx * nx + nz * nz) || 1; }
  nx /= nl; nz /= nl;
  // contact point: on the struck car's skin, half its width out along -n
  const cx = pbx - nx * b.wid * 0.5, cz = pbz - nz * b.wid * 0.5;
  const rx = cx - b.x, rz = cz - b.z;
  const vbx = bfx * b.speed + brx * (b._lat ?? 0), vbz = bfz * b.speed + brz * (b._lat ?? 0);
  const w = b.yaw ?? 0;
  // velocity of the contact point on B: v + w x r, w about +y
  const cvx = vbx + w * rz, cvz = vbz - w * rx;
  const closing = (avx - cvx) * nx + (avz - cvz) * nz;
  if (!(closing > 0)) return 0;
  const L = b.len * AI.WHEELBASE, kz2 = 1.15 * (0.45 * L) * (0.55 * L);
  const rn = rz * nx - rx * nz;
  const I = mB * kz2;
  const J = (1 + e) * closing / (1 / mA + 1 / mB + rn * rn / I);
  const dvx = J / mB * nx, dvz = J / mB * nz;
  b.speed += dvx * bfx + dvz * bfz;
  b._lat = (b._lat ?? 0) + dvx * brx + dvz * brz;
  b.yaw = w + J * rn / I;
  if (b.yaw > 3.4) b.yaw = 3.4; else if (b.yaw < -3.4) b.yaw = -3.4;
  return closing;
}
