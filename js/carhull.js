// ---- carhull.js: where a vehicle is solid, seen from above ----------------------
// Pure: no three, no DOM, no state beyond scratch buffers.
//
// WHY. Everything on foot used to ask world.collide() about a car as TWO DISCS
// down its axis (radius 0.55 x width, centred a disc radius in from each
// bumper). For a 4.7 x 1.81 m car and a 0.38 m walker the two discs do not
// meet: between them, right where the front seats are, there was a slot a
// person walked straight through, and on an 11 m bus the slot was seven metres
// long. The discs were also 9 cm fatter than the body at their centres and
// rounder than any bumper at the ends.
//
// So a hull here is what the body is in plan: a ROUNDED ORIENTED RECTANGLE,
// length x width with a corner radius, one per rigid body (the articulated
// lorry is two: the tractor and the trailer at its own angle). Three questions
// are answered from that one shape, so they cannot disagree:
//
//   push out    a circle (somebody's feet) leaves the hull by the nearest way
//   round       the way on foot from one side of the car to a point on the
//               other, round the nearer end, never through the body
//   skirt       how far sideways somebody walking a fixed line (the crowd,
//               which is on a shared timetable) steps to pass a standing car
//
// Frame, as everywhere in the game: a car at (x, z) with `heading` h has its
// nose along (-sin h, -cos h) and its right along (cos h, -sin h). In the
// car's own frame +x is the right and -z the nose, so
//   local -> world   x = cx + lx cos h + lz sin h,  z = cz - lx sin h + lz cos h
//   world -> local   lx = dx cos h - dz sin h,      lz = dx sin h + dz cos h

// the articulated lorry (js/semitrailer.js, whose constants these are: that
// module needs three, this one must not; tests/carhull.test.mjs holds them equal)
const SEMI_LEN = 16.5, TRACTOR_LEN = 6.2, TRACTOR_WID = 2.5, TRAILER_WID = 2.55;
const TR_OFF = -(SEMI_LEN - TRACTOR_LEN) / 2;     // tractor centre, car frame
const KINGPIN = TR_OFF + 1.4;                      // fifth wheel, car frame
const T_FRONT = -1.2, T_LEN = 13.6;                // trailer body, from the kingpin

/** How round the corners of a body are in plan, metres. */
export function cornerRadius(car) {
  const hw = car.wid / 2;
  if (car.tram) return 0.1;                // a tram section: its neighbours abut it
  if (car.len > 6) return Math.min(0.22, hw * 0.4);   // lorry, bus: nearly square
  return Math.min(0.4, hw * 0.4);          // a car's bumper corners
}

const mkPart = () => ({ x: 0, z: 0, ch: 1, sh: 0, hl: 0, hw: 0, rc: 0 });
const _parts = [mkPart(), mkPart()];

/**
 * The rigid bodies of a vehicle record ({ x, z, heading, len, wid }, plus
 * `_tr` on an articulated lorry and `tram` on a tram section). Fills `out`
 * (an array of part records, reused) and returns how many there are.
 */
export function hullParts(car, out = _parts) {
  const h = car.heading || 0, ch = Math.cos(h), sh = Math.sin(h);
  const a = out[0] ?? (out[0] = mkPart());
  if (car._tr && car.len > 12) {
    // tractor: the front 6.2 m of the 16.5
    a.x = car.x + TR_OFF * sh; a.z = car.z + TR_OFF * ch;
    a.ch = ch; a.sh = sh; a.hl = TRACTOR_LEN / 2; a.hw = TRACTOR_WID / 2; a.rc = 0.22;
    // trailer: hangs on the kingpin at its own heading
    const b = out[1] ?? (out[1] = mkPart());
    const psi = car._tr.init === false ? h : (car._tr.psi ?? h);
    const pc = Math.cos(psi), ps = Math.sin(psi);
    const kx = car.x + KINGPIN * sh, kz = car.z + KINGPIN * ch;
    const mid = T_FRONT + T_LEN / 2;
    b.x = kx + mid * ps; b.z = kz + mid * pc;
    b.ch = pc; b.sh = ps; b.hl = T_LEN / 2; b.hw = TRAILER_WID / 2; b.rc = 0.15;
    return 2;
  }
  a.x = car.x; a.z = car.z; a.ch = ch; a.sh = sh;
  a.hl = car.len / 2; a.hw = car.wid / 2; a.rc = cornerRadius(car);
  return 1;
}

/**
 * Push a circle of `radius` at pos ({ x, z }, mutated) out of ONE part.
 * Outside the core the exit is along the line from the nearest core point
 * (so a corner is round); with the centre inside the core it is through the
 * nearest face. Returns true if pos moved.
 */
export function pushOutPart(pos, radius, p) {
  const dx = pos.x - p.x, dz = pos.z - p.z;
  let lx = dx * p.ch - dz * p.sh, lz = dx * p.sh + dz * p.ch;
  const cx = p.hw - p.rc, cz = p.hl - p.rc, R = p.rc + radius;
  const qx = lx < -cx ? -cx : lx > cx ? cx : lx;
  const qz = lz < -cz ? -cz : lz > cz ? cz : lz;
  const ex = lx - qx, ez = lz - qz, d2 = ex * ex + ez * ez;
  if (d2 >= R * R) return false;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    lx = qx + ex / d * R; lz = qz + ez / d * R;
  } else if (p.hw - Math.abs(lx) <= p.hl - Math.abs(lz)) {
    lx = (lx < 0 ? -1 : 1) * (p.hw + radius);
  } else {
    lz = (lz < 0 ? -1 : 1) * (p.hl + radius);
  }
  pos.x = p.x + lx * p.ch + lz * p.sh;
  pos.z = p.z - lx * p.sh + lz * p.ch;
  return true;
}

/** Push a circle out of every part of a vehicle. Returns true if pos moved. */
export function hullPushOut(pos, radius, car) {
  const n = hullParts(car, _parts);
  let moved = false;
  for (let i = 0; i < n; i++) moved = pushOutPart(pos, radius, _parts[i]) || moved;
  return moved;
}

/** Is a circle of `radius` at (x, z) touching the vehicle's hull? */
export function hullContains(car, x, z, radius = 0) {
  const n = hullParts(car, _parts);
  for (let i = 0; i < n; i++) {
    const p = _parts[i];
    const dx = x - p.x, dz = z - p.z;
    const lx = Math.abs(dx * p.ch - dz * p.sh), lz = Math.abs(dx * p.sh + dz * p.ch);
    const ex = Math.max(0, lx - (p.hw - p.rc)), ez = Math.max(0, lz - (p.hl - p.rc));
    const R = p.rc + radius - 1e-6;
    if (ex * ex + ez * ez < R * R) return true;
  }
  return false;
}

/** How far out from (x, z) any part of this vehicle can reach: a cheap gate. */
export const hullReach = (car) => car.len / 2 + (car._tr ? 3 : 0.5);

// ---- round: the way on foot from one side to the other -------------------------
// All in the CAR's frame (the caller transforms; a car being walked up to may
// still be creeping, so the plan is asked again every frame). The body is the
// box hw x hl; nobody plans closer to it than `clear`. Corners of the box
// grown by `clear` are the only places a way round ever turns, so the plan is
// the shortest path over six points: start, four corners, goal.
//   corner 0 front right, 1 front left, 2 rear left, 3 rear right
const EDGE_EPS = 0.1;      // m: how much a leg may shave the grown box's corner
const _nx = new Float64Array(6), _nz = new Float64Array(6);
const _dist = new Float64Array(6), _prev = new Int8Array(6), _done = new Uint8Array(6);

// does the segment a-b pass through the OPEN box |x| < ex, |z| < ez?
function segHitsBox(ax, az, bx, bz, ex, ez) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  if (Math.abs(dx) < 1e-12) { if (Math.abs(ax) >= ex) return false; }
  else {
    let u = (-ex - ax) / dx, v = (ex - ax) / dx;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
  }
  if (Math.abs(dz) < 1e-12) { if (Math.abs(az) >= ez) return false; }
  else {
    let u = (-ez - az) / dz, v = (ez - az) / dz;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
  }
  return t1 - t0 > 1e-9;
}

// a point inside the box ex x ez moved to its nearest face; node k receives it
function ontoBox(k, x, z, ex, ez) {
  if (Math.abs(x) < ex && Math.abs(z) < ez) {
    if (ex - Math.abs(x) <= ez - Math.abs(z)) x = (x < 0 ? -1 : 1) * ex;
    else z = (z < 0 ? -1 : 1) * ez;
  }
  _nx[k] = x; _nz[k] = z;
}

/** A fresh record for planRound to fill. */
export const makeRoute = () => ({ n: 0, x: new Float64Array(8), z: new Float64Array(8), len: 0, direct: true, corner: -1 });

/**
 * The way from (sx, sz) to (gx, gz) round a body hw x hl (half sizes), all in
 * the car's frame. Fills `out`: n waypoints x[i], z[i] to walk to in order
 * (the last is the goal), `len` the metres of the whole way, `direct` when
 * nothing is in the way, `corner` the first corner turned at (-1 if none).
 * `ban`: a bit mask of corners not to use (a way found blocked by something
 * else: bit k for corner k), so the plan goes round the other end.
 */
export function planRound(hw, hl, clear, sx, sz, gx, gz, out, ban = 0) {
  out.n = 0; out.len = 0; out.direct = true; out.corner = -1;
  const add = (x, z) => { out.x[out.n] = x; out.z[out.n] = z; out.n++; };
  // Straight there? Tested against the body grown by as much room as both
  // ends themselves have (somebody leaning on the flank may walk along it).
  const sE = Math.max(Math.abs(sx) - hw, Math.abs(sz) - hl), gE = Math.max(Math.abs(gx) - hw, Math.abs(gz) - hl);
  const e = Math.max(0, Math.min(clear - EDGE_EPS, sE - 0.01, gE - 0.01));
  if (!segHitsBox(sx, sz, gx, gz, hw + e, hl + e)) {
    add(gx, gz);
    out.len = Math.hypot(gx - sx, gz - sz);
    return out;
  }
  out.direct = false;
  // Legs are tested against a box a little smaller than the one the corners
  // stand on, so a leg may lie along its edge and shave its corner. An end
  // that is inside THAT box (leaning on the car) first steps straight out of
  // it. (Out of the smaller box, not the corners' own: somebody rounding a
  // corner is between the two, and sending them back out to the bigger one
  // every frame held them on its edge, creeping.)
  const ex = hw + clear, ez = hl + clear;
  const tx = ex - EDGE_EPS, tz = ez - EDGE_EPS;
  ontoBox(0, sx, sz, tx, tz);
  _nx[1] = ex; _nz[1] = -ez; _nx[2] = -ex; _nz[2] = -ez; _nx[3] = -ex; _nz[3] = ez; _nx[4] = ex; _nz[4] = ez;
  ontoBox(5, gx, gz, tx, tz);
  for (let i = 0; i < 6; i++) { _dist[i] = Infinity; _prev[i] = -1; _done[i] = 0; }
  _dist[0] = 0;
  for (let it = 0; it < 6; it++) {
    let u = -1;
    for (let i = 0; i < 6; i++) if (!_done[i] && (u < 0 || _dist[i] < _dist[u])) u = i;
    if (u < 0 || _dist[u] === Infinity) break;
    _done[u] = 1;
    if (u === 5) break;
    for (let v = 1; v < 6; v++) {
      if (_done[v] || (v < 5 && (ban >> (v - 1)) & 1)) continue;
      if (segHitsBox(_nx[u], _nz[u], _nx[v], _nz[v], tx, tz)) continue;
      const d = _dist[u] + Math.hypot(_nx[v] - _nx[u], _nz[v] - _nz[u]);
      if (d < _dist[v]) { _dist[v] = d; _prev[v] = u; }
    }
  }
  if (_dist[5] === Infinity) {
    // every way is banned: go straight, as before there was a plan at all
    add(gx, gz);
    out.len = Math.hypot(gx - sx, gz - sz);
    return out;
  }
  // unwind 5 -> 0, then write it forwards
  let m = 0, k = 5;
  const chain = _chain;
  while (k > 0) { chain[m++] = k; k = _prev[k]; }
  let px = sx, pz = sz;
  const step = (x, z) => {
    const d = Math.hypot(x - px, z - pz);
    if (d < 1e-4) return;
    add(x, z); out.len += d; px = x; pz = z;
  };
  step(_nx[0], _nz[0]);
  for (let i = m - 1; i >= 0; i--) {
    const c = chain[i];
    if (c < 5 && out.corner < 0) out.corner = c - 1;
    step(_nx[c], _nz[c]);
  }
  step(gx, gz);
  if (!out.n) add(gx, gz);
  return out;
}
const _chain = new Int8Array(6);

// ---- skirt: stepping aside for a standing car ------------------------------------
// For somebody whose line is not theirs to change (the crowd walks a shared
// timetable: a walker's place is a function of the clock, on every screen).
// The body is carried SIDEWAYS off that line by just enough to pass the car,
// on the side that needs the smaller step, easing out over `look` metres on
// the way up to it and back in behind it.
/**
 * Signed sideways step, in metres along the walker's left (dz, -dx), for a
 * walker at (x, z) heading along the unit vector (dx, dz) with body radius r.
 * 0 when the car is not on the line or too far along it.
 */
export function skirtOffset(car, x, z, dx, dz, r, look = 2.6) {
  const n = hullParts(car, _parts);
  let best = 0;
  for (let i = 0; i < n; i++) {
    const p = _parts[i];
    const rx = p.x - x, rz = p.z - z;
    const tC = rx * dx + rz * dz, nC = rx * dz - rz * dx;
    // the part's axes: forward (-sh, -ch), right (ch, -sh)
    const fT = Math.abs(p.sh * dx + p.ch * dz), fN = Math.abs(p.sh * dz - p.ch * dx);
    const eT = fT * p.hl + fN * p.hw, eN = fN * p.hl + fT * p.hw;
    const lo = nC - eN - r, hi = nC + eN + r;
    if (lo >= 0 || hi <= 0) continue;              // the line passes it clear
    const tA = tC - eT - r, tB = tC + eT + r;      // where the line is abreast of it
    let w = 1;
    if (tA > 0) w = 1 - tA / look;
    else if (tB < 0) w = 1 + tB / (look * 0.7);
    if (w <= 0) continue;
    w = w * w * (3 - 2 * w);
    const s = (hi < -lo ? hi : lo) * w;
    if (Math.abs(s) > Math.abs(best)) best = s;
  }
  return best;
}

// ---- discs for the car-against-car pass -----------------------------------------
// vehicles.js carCarPass keeps discs (it needs a contact normal and a lever
// per pair, and a disc pair gives both for nothing). Two of them cover a car;
// they do not cover a bus. This says where the discs of a body go so that no
// other vehicle's disc can pass between two of them: radius 0.62 x width as
// there, the end ones a radius in from the bumpers as there, and as many more
// between as it takes for the gap to be closed to the narrowest car there is.
// A body up to 5 m long gets exactly the two it always had.
const DISC_K = 0.62;
const SLIM_R = 1.74 * DISC_K;      // the Fabia's disc: the slimmest intruder
const DISC_SINK = 0.25;            // m a nose may sink into a flank between discs
/**
 * Offsets along the axis (metres, negative toward the nose... the body is
 * symmetric, so the sign is yours) of the discs of a len x wid body. Fills
 * `out` and returns how many.
 */
export function discOffsets(len, wid, out) {
  const rA = wid * DISC_K, dA = Math.max(0, len / 2 - rA);
  const lat = wid / 2 - DISC_SINK + SLIM_R, rr = rA + SLIM_R;
  const sMax = 2 * Math.sqrt(Math.max(0.01, rr * rr - lat * lat));
  const seg = Math.max(1, Math.ceil(2 * dA / sMax - 1e-9));
  for (let i = 0; i <= seg; i++) out[i] = -dA + 2 * dA * i / seg;
  return seg + 1;
}
