// ---- Ejection: out through the windscreen, GTA IV style ----
// "A když se rychle vybourám, chci vyletět předním sklem, jako v GTA 4."
//
// Three questions, three small pieces, and none of them needs three.js:
//
//   shouldEject(car)   did THIS driveStep end in a hit hard enough, and square
//                      enough, to throw an unbelted driver forward? The car
//                      publishes its hardest hit of the step (vehicles.js
//                      noteImpact): the closing speed of the contact, how
//                      square it was to the nose, and the ground velocity the
//                      car had the instant before. The last one is the whole
//                      point: after the impulse the car is bouncing BACK off
//                      the wall, but the body inside it never felt that
//                      impulse and keeps going at the old speed.
//   launchBody(...)    where the body starts and how it leaves.
//   stepBody(st, …)    one step of the flight: tumble, a wall in the way,
//                      one honest bounce, the slide, lying there, getting up.
//
// The flight is the crowd's ragdoll (pedestrians.js _ragStep: gravity, a
// tumble, ONE bounce at 0.3, a slide at a fixed friction, settling flat) with
// two things that ragdoll never needed: walls, because a driver thrown at a
// building meets the building, and the car's own bonnet, because the first
// thing under a body leaving through the windscreen is the front of the car
// it left. The crowd's version cannot simply be called: it lives inside the
// Pedestrians class, writes the crowd's own bookkeeping (corpse budget, blood
// pool, panic, the shared schedule) and has no idea a wall exists.
//
// DAMAGE is billed by whoever owns the body (main.js, through vitals.damage),
// from the two curves below: one for going through the glass, one for each
// thing the body then hits. The numbers are set so that the transition from
// "stayed in the seat" to "went through the glass" is continuous: just under
// the threshold vitals.js bills the in-car impulse (about 30 HP at 59 km/h),
// just over it the glass and the landing together come to about the same.
// Measured on the curves: 100 km/h on an open road ≈ 45 HP, 100 km/h into a
// building ≈ 80 HP, 120 km/h into one or 150 km/h anywhere kills.
//
// Local state only: your body is yours (the co-op wire carries your position,
// not your ragdoll), so Math.random in the tumble breaks no determinism.

export const EJECT_V = 16.5;    // m/s of closing speed at the contact (≈ 59 km/h)
export const EJECT_COS = 0.8;   // nose within ~37° of square to the thing hit

/** Is this step's impact a windscreen? Needs the car's own impact record. */
export function shouldEject(car) {
  if (!car || !(car.impactV >= EJECT_V)) return false;
  if (!(car.impactCos >= EJECT_COS)) return false;      // a broadside, a reverse: no
  if (car.impactWith !== 'wall' && car.impactWith !== 'car') return false;
  // the body has to be going somewhere: a parked car shoved square on its
  // nose closes fast too, and nobody inside it is moving at all
  const vx = car.impactVx ?? 0, vz = car.impactVz ?? 0;
  return Math.sqrt(vx * vx + vz * vz) >= EJECT_V;
}

/** HP for going through the glass and over the bonnet at `v` m/s. */
export function launchDamage(v) {
  if (!(v > 10)) return 0;
  return 100 * Math.pow(Math.min(1.4, (v - 10) / 32), 1.6);
}

/** HP for the body arriving at the ground or a wall at `u` m/s. */
export function impactDamage(u) {
  if (!(u > 8)) return 0;
  const k = (u - 8) / 22;
  return Math.min(300, 100 * k * k);
}

// ---- the flight ----
const GRAV = 13;          // between real g and the crowd's 18: weight, but air time
const KEEP = 0.8;         // share of the car's speed the body leaves with (the belt
                          // that is not there, the dash and the glass take the rest)
const LIFT = 2.2;         // m/s up off the bonnet, plus…
const LIFT_K = 0.09;      // …this per m/s of speed: a faster car throws higher
const R_BODY = 0.3;       // m, the body as a ball against walls
const LIE = 0.16;         // m, centre above the ground when lying flat
const BOUNCE = 0.3;       // the crowd's restitution: one bounce, then slide
const WALL_E = 0.15;      // a body meeting masonry mostly stops
const SLIDE = 7;          // m/s² of road rash
const LIE_T = 1.6;        // s face down before trying to get up
const RISE_T = 0.75;      // s from flat to standing
const HIP = 0.9;          // m, feet to the middle of the body (scaled by the caller)
const MAX_STEP = 0.2;     // m of travel per substep: walls stay walls
const BONNET = 0.95;      // m above the car's ground a body comes to rest on it
const FLY_MAX = 8;        // s: whatever happened, stop flying after this

const HALF_PI = Math.PI / 2, TWO_PI = Math.PI * 2;
const wrap = (a) => a - TWO_PI * Math.round(a / TWO_PI);

/**
 * The body's starting state. `seat` is the seat point in the CAR's frame
 * ({x, y, z}: +x right, −z the nose, y above the car's ground), so the body
 * starts exactly where it sat. `hip` is the scaled feet-to-middle height.
 */
export function launchBody(car, seat, hip = HIP, rnd = Math.random) {
  const vx0 = car.impactVx ?? 0, vz0 = car.impactVz ?? 0;
  const v = Math.sqrt(vx0 * vx0 + vz0 * vz0);
  const h = car.heading, ch = Math.cos(h), sh = Math.sin(h);
  const sx = seat?.x ?? 0, sz = seat?.z ?? 0, sy = seat?.y ?? 0.5;
  return {
    phase: 'fly', t: 0, stay: false, car,
    // start at the chest of the seated body, a hand's width up
    x: car.x + sx * ch + sz * sh,
    z: car.z - sx * sh + sz * ch,
    y: (car.y ?? 0) + sy + 0.35,
    vx: vx0 * KEEP, vz: vz0 * KEEP, vy: LIFT + LIFT_K * v,
    yaw: Math.atan2(-vx0, -vz0),         // facing the way the car was going
    pitch: 0, roll: 0,
    // head over heels forward, faster the harder the hit, and a random twist
    ap: -(4 + 0.18 * v), ar: (rnd() - 0.5) * (2 + 0.1 * v),
    bounced: false, landed: false, walled: false,
    hip, gy: car.y ?? 0,
    v0: v,
  };
}

// One reusable probe for world.collide, and its options. NOT the walker's
// `interior` shape: for a walker a building with a live interior is solid only
// where its room boxes are, so a body thrown at a shopfront sailed through the
// glass and landed among the shelves. A thrown body meets the outer wall.
// `aboveY` still lets it fly over a roof that is below it.
const _p = { x: 0, z: 0 };
const _o = { aboveY: 0 };

/** The surface under a flying body: the world's, or the front of the car. */
function groundAt(st, world, x, z) {
  let gy = world.supportY ? world.supportY(x, z, st.y + 0.3)
    : world.heightAt ? world.heightAt(x, z) : 0;
  // Only once the body is coming DOWN: on the way out it starts below the
  // bonnet line (it was sitting in the car) and must not land on the car it
  // is leaving in its first frame.
  const c = st.car;
  if (c && c.len && st.vy < 0) {
    // inside the car's footprint (its own frame), the body lies on the metal
    const dx = x - c.x, dz = z - c.z;
    const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
    const lx = ch * dx - sh * dz, lz = sh * dx + ch * dz;
    if (Math.abs(lx) < c.wid / 2 && Math.abs(lz) < c.len / 2) {
      const top = (c.y ?? 0) + BONNET;
      if (top > gy && st.y > top - 0.3) gy = top;
    }
  }
  return gy;
}

/**
 * One step of the thrown body. `hit(u, what)` is called once for the first
 * time it reaches the ground and once for the first wall, with the speed it
 * arrived at; the caller turns those into HP. Returns true while the ragdoll
 * still owns the body, false on the step it is back on its feet.
 */
export function stepBody(st, dt, world, hit) {
  if (!(dt > 0)) return true;
  st.t += dt;
  if (st.phase === 'lie') {
    if (!st.stay && st.t >= LIE_T) { st.phase = 'rise'; st.t = 0; st.p0 = st.pitch; st.r0 = st.roll; }
    return true;
  }
  if (st.phase === 'rise') {
    const k = Math.min(1, st.t / RISE_T);
    const e = k * k * (3 - 2 * k);
    st.pitch = st.p0 * (1 - e);
    st.roll = st.r0 * (1 - e);
    st.y = st.gy + LIE + (st.hip - LIE) * e;
    return k < 1;
  }
  // ---- flying or sliding ----
  const vh = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
  const n = Math.min(40, Math.max(1, Math.ceil(Math.max(vh, Math.abs(st.vy)) * dt / MAX_STEP)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    st.x += st.vx * h; st.z += st.vz * h;
    if (world.collide) {
      _p.x = st.x; _p.z = st.z;
      _o.aboveY = st.y - 0.4;
      if (world.collide(_p, R_BODY, _o)) {
        let nx = _p.x - st.x, nz = _p.z - st.z;
        const l = Math.sqrt(nx * nx + nz * nz);
        st.x = _p.x; st.z = _p.z;
        if (l > 1e-6) {
          nx /= l; nz /= l;
          const vn = st.vx * nx + st.vz * nz;
          if (vn < 0) {
            if (!st.walled && -vn > 3) { st.walled = true; hit?.(-vn, 'wall'); }
            st.vx -= (1 + WALL_E) * vn * nx; st.vz -= (1 + WALL_E) * vn * nz;
            st.vx *= 0.6; st.vz *= 0.6;          // and it grinds down the face
            st.ap *= 0.4; st.ar *= 0.4;
          }
        }
      }
    }
    st.vy -= GRAV * h;
    st.y += st.vy * h;
    st.pitch += st.ap * h; st.roll += st.ar * h;
    const gy = groundAt(st, world, st.x, st.z);
    st.gy = gy;
    if (st.y - gy <= LIE) {
      st.y = gy + LIE;
      if (!st.landed) {
        st.landed = true;
        const hv = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
        // the fall and the first metres of tarmac, together
        hit?.(Math.sqrt(st.vy * st.vy + 0.25 * hv * hv), 'ground');
      }
      if (!st.bounced && st.vy < -2.5) {
        st.bounced = true;                       // one honest bounce
        st.vy = -st.vy * BOUNCE;
        st.vx *= 0.65; st.vz *= 0.65;
        st.ap *= 0.5; st.ar *= 0.5;
      } else {
        st.vy = 0;                               // sliding out
        st.phase = 'slide';
        const sp = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
        const ns = Math.max(0, sp - SLIDE * h);
        const fk = sp > 1e-4 ? ns / sp : 0;
        st.vx *= fk; st.vz *= fk;
        const damp = Math.min(1, h * 6);
        st.ap -= st.ap * damp; st.ar -= st.ar * damp;
        // settle flat: face down or face up, whichever is nearer
        const ease = Math.min(1, h * 5);
        const tp = Math.round((st.pitch - HALF_PI) / Math.PI) * Math.PI + HALF_PI;
        const tr = Math.round(st.roll / Math.PI) * Math.PI;
        st.pitch += (tp - st.pitch) * ease;
        st.roll += (tr - st.roll) * ease;
        if (ns < 0.3 && Math.abs(st.ap) < 0.5 && Math.abs(st.ar) < 0.5) {
          st.pitch = wrap(tp); st.roll = wrap(tr);   // and forget the somersaults
          st.vx = st.vz = st.ap = st.ar = 0;
          st.phase = 'lie'; st.t = 0;
          return true;
        }
      }
    }
  }
  if (st.t > FLY_MAX) {                          // never fly forever
    st.y = st.gy + LIE; st.vx = st.vz = st.vy = 0;
    st.pitch = HALF_PI; st.roll = 0; st.ap = st.ar = 0; st.phase = 'lie'; st.t = 0;
  }
  return true;
}

/**
 * Where the citizen group's ORIGIN (its feet) goes so that the middle of the
 * body is at the state's (x, y, z), for the YXZ rotation (yaw, pitch, roll).
 * The group pivots at the feet, so tumbling it in place would swing the whole
 * body round its shoes; this puts the pivot back in the middle. Writes `out`.
 */
export function feetFor(st, out) {
  const sa = Math.sin(st.pitch), ca = Math.cos(st.pitch);
  const sc = Math.sin(st.roll), cc = Math.cos(st.roll);
  const sb = Math.sin(st.yaw), cb = Math.cos(st.yaw);
  // the body's up axis: (0,1,0) rolled, then pitched, then yawed
  const ux0 = -sc, uy = cc * ca, uz0 = cc * sa;
  const ux = ux0 * cb + uz0 * sb, uz = -ux0 * sb + uz0 * cb;
  out.x = st.x - ux * st.hip;
  out.y = st.y - uy * st.hip;
  out.z = st.z - uz * st.hip;
  return out;
}
