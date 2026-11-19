// ---- cyclistsense.js: what a rider slows and steers for -----------------------
// Split out of js/cyclistride.js, which moves a rider every frame. This is the
// look ahead: eight times a second, riders in turn, and all it leaves behind
// is a cap on the speed (r.cap), a sideways position to drift to (r.shiftT)
// and what the traffic is to be told (r.lane, r.noteOn). All of it is this
// client's own: a rider held up here falls behind the shared plan and catches
// up afterwards (js/cyclistride.js).
//
// WHAT A RIDER LOOKS FOR (senseStep, eight times a second, riders in turn):
//   a road to cross   stop at the kerb while something is coming (the
//                     traffic's own question, js/traffic.js threatens), for
//                     at most HOLD_MAX seconds; drivers are told who is on a
//                     crossing through the crowd's list (traffic.walkers)
//   a car ahead       in the way on the street, across a junction, parked on
//                     the path: follow it or stop behind it
//   a walker ahead    slow down, and pass with room where the path has room;
//                     where it has none, ride at their pace behind them
//   a slower rider    pull out to the left and pass
//   a rider coming    the other way: not pulled out into, and given what
//                     room the path has (never stopped for)
//
// Nothing here allocates: the scratch is the module's.

import { inZone } from './cycleplan.js';
import { CLS } from './cyclenet.js';
import { SHIFT_V } from './cyclistride.js';
import { sameLevel } from './levelsep.js';

const BRK_EASY = 1.6;                 // what a rider plans a stop with
const CLEAR = 0.9;                    // m of room a walker is given
const PASS_MIN = 0.6;                 // m: less room than this is no way past
const HOLD_MAX = 14;                  // s at a kerb before going anyway
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Is the player's car about to drive over crossing c? (js/pedestrians.js asks
// the same of the same car: the traffic's own cars are js/traffic.js threatens.)
function bears(car, c, need) {
  if (!car) return false;
  const v = car.vGround ?? Math.abs(car.speed);
  if (!(v > 1.6)) return false;
  const rx = c.cx - car.x, rz = c.cz - car.z;
  if (rx * rx + rz * rz > 55 * 55) return false;
  const sg = car.speed < 0 ? -1 : 1;
  const hx = -Math.sin(car.heading) * sg, hz = -Math.cos(car.heading) * sg;
  const along = rx * hx + rz * hz;
  if (along < -1 || Math.abs(rx * hz - rz * hx) > c.hw + 1.8) return false;
  if (!c.give) return v * v / (2 * Math.max(0.5, along - 5)) > 5.5;
  return (along - 2.5) / v < need;
}

// the scratch one look ahead shares
let _cap = 0, _shiftT = 0, _minS = 0, _maxS = 0;

// something as wide as a car, at (cx, cz) heading h with speed sp along it
function carAhead(r, cx, cz, h, sp, len, wid, look, cy) {
  const rx = cx - r.x, rz = cz - r.z;
  if (rx > 34 || rx < -34 || rz > 34 || rz < -34) return;
  if (!sameLevel(r.y, cy, 20)) return;          // the car is on another level (js/levelsep.js)
  const fwd = rx * r.dx + rz * r.dz;
  if (fwd < 0 || fwd > look + len) return;
  const lat = rz * r.dx - rx * r.dz;
  const hx = -Math.sin(h), hz = -Math.cos(h);
  const dot = hx * r.dx + hz * r.dz, cosd = dot < 0 ? -dot : dot;
  const sind = Math.sqrt(1 - (cosd > 1 ? 1 : cosd * cosd));
  const halfF = cosd * len / 2 + sind * wid / 2, halfL = cosd * wid / 2 + sind * len / 2;
  if (lat > halfL + 0.45 || lat < -halfL - 0.45) return;
  const gap = fwd - halfF - 1.0;
  if (gap < -1.5) return;                       // alongside: it is passing, or being passed
  const along = sp * dot;
  const c = (along > 0 ? along : 0) + Math.sqrt(2 * 2.0 * Math.max(0, gap - 0.5));
  if (c < _cap) _cap = c;
}

// ---- people and slower riders: one decision about all of them ----------------------
// Whoever is on the path ahead goes into a short list, and ONE sideways
// position is chosen against the whole list: the one that leaves the most
// room to the nearest of them, staying put if that is already enough. Judging
// each walker alone sent a rider round the left of one straight into the
// companion walking beside them. If no position leaves a body's width, there
// is no way past, and the rider follows the nearest of them at their pace.
const OB_MAX = 16;
const _of = new Float64Array(OB_MAX), _ol = new Float64Array(OB_MAX), _oa = new Float64Array(OB_MAX), _ow = new Uint8Array(OB_MAX);
const _oc = new Uint8Array(OB_MAX);       // 1: coming the other way (see senseStep)
let _on = 0;

// somebody at (px, pz) moving at `along` m/s down the rider's own line.
// `back`: how far behind the rider they still count (a walker being passed
// does not; a rider alongside does, see senseStep)
function note(r, px, pz, along, onFoot, back = -0.4, far = 10, coming = false) {
  const rx = px - r.x, rz = pz - r.z, box = far + 10;
  if (rx > box || rx < -box || rz > box || rz < -box) return;
  const fwd = rx * r.dx + rz * r.dz;
  if (fwd < 0 - back || fwd > far) return;
  const lat = rz * r.dx - rx * r.dz;
  // (either side of where the rider IS, and of the line they will go back to:
  // somebody who has pulled out round a car must still see the car on it)
  const home = 0 - r.shift;
  if (lat > (home > 0 ? home : 0) + 2.6 || lat < (home < 0 ? home : 0) - 2.6) return;
  let k = _on;
  if (k >= OB_MAX) {                       // full: keep the nearest
    k = 0;
    for (let i = 1; i < OB_MAX; i++) if (_of[i] > _of[k]) k = i;
    if (_of[k] <= fwd) return;
  } else _on++;
  _of[k] = fwd; _ol[k] = lat; _oa[k] = along; _ow[k] = onFoot ? 1 : 0; _oc[k] = coming ? 1 : 0;
}

// the least room a sideways move of `m` metres (from where the rider is now) leaves
// (somebody coming the other way is passed on the right, as on any road: on
// the far side of them there is no room at all)
function room(m) {
  let least = 9;
  for (let i = 0; i < _on; i++) {
    let c = _oc[i] ? m - _ol[i] : _ol[i] - m;
    if (c < 0) c = _oc[i] ? 0 : -c;
    if (c < least) least = c;
  }
  return least;
}

function decide(r) {
  if (!_on) return;
  // where the rider's own line is, and how much room it leaves
  const home = 0 - r.shift;
  let best = home, got = room(home);
  if (got < CLEAR) {
    // …then where they were already heading, if that still works: a rider who
    // has started round the left of something does not change their mind
    // half way because the right now measures a hand's width better
    const prev = clamp(r.shiftT, _minS, _maxS) - r.shift, gp = room(prev);
    let score = got;
    if (gp >= PASS_MIN && gp + 0.35 > score) { best = prev; got = gp; score = gp + 0.35; }
    // …then each side of each of them, as far as the path allows; ties go to the left, and to the smaller move
    for (let i = 0; i < _on; i++) {
      for (let side = _oc[i] ? 1 : -1; side <= 1; side += 2) {
        const m = clamp(r.shift + _ol[i] + side * CLEAR, _minS, _maxS) - r.shift;
        const c = room(m);
        if (c > score + 0.05) { got = c; score = c; best = m; }
      }
    }
  }
  _shiftT = r.shift + best;
  if (best > 0.15 || best < -0.15) {
    // a move aside takes time: no faster than gets it done before they are there
    let f = 99;
    for (let i = 0; i < _on; i++) if (!_oc[i] && _ol[i] < CLEAR && _ol[i] > -CLEAR && _of[i] > 0 && _of[i] < f) f = _of[i];
    if (f < 99) {
      const c = Math.max(0.6, (f - 1.2) * SHIFT_V / (best < 0 ? -best : best));
      if (c < _cap) _cap = c;
    }
  }
  if (got < PASS_MIN) {
    // no way past: behind the nearest one in the way, at their pace
    let f = 99, a = 0;
    // (not somebody coming the other way: two riders who each stopped for
    // the other on a narrow path would stand there nose to nose for good)
    // (nor a walker they are already level with: that is passing, not following)
    for (let i = 0; i < _on; i++) if (!_oc[i] && !(_ow[i] && _of[i] < 0.4) && Math.abs(_ol[i] - best) < PASS_MIN + 0.1 && _of[i] < f) { f = _of[i]; a = _oa[i]; }
    // (somebody level with the rider is not ahead: with those two the junior
    // drops back, at nine tenths of the other's pace, until there is a gap)
    const c = f < 0.4 ? a * 0.9 : (a > 0 ? a : 0) + Math.sqrt(2 * BRK_EASY * Math.max(0, f - 1.9));
    if (c < _cap) _cap = c;
  } else {
    // past people on foot: not at full tilt (another bicycle is passed at speed)
    let f = 99;
    for (let i = 0; i < _on; i++) if (_ow[i] && _of[i] < f && Math.abs(_ol[i] - best) < 1.7) f = _of[i];
    const c = f < 5 ? 3.0 : f < 99 ? 3.8 : Infinity;
    if (c < _cap) _cap = c;
  }
}

export function senseStep(sys, r, pc, foot) {
  const s = r.s, plan = s.plan, arc = r.arc, v = r.v;
  const leg = plan.legs[r.leg] ?? plan.legs[0], w = leg.w, hw = (w.r.w ?? 2) / 2;
  const street = w.cls === CLS.STREET;
  _cap = Infinity; _shiftT = 0;
  // how far aside the way lets a rider go: to within a foot of either edge
  _maxS = Math.max(0, hw - 0.3 - leg.off);
  _minS = Math.max(-1.7, Math.min(0, -(hw - 0.3) - leg.off));
  r.noteOn = false;

  // ---- a road to cross ----
  const X = plan.cross;
  let ci = r.ci;
  while (ci < X.length && X[ci].a1 < arc - 0.5) ci++;
  r.ci = ci;
  if (ci < X.length) {
    const c = X[ci], de = c.a0 - arc, o = r.note;
    if (de <= 0.3) {
      // on the asphalt: a driver brakes as hard as it takes
      r.noteOn = true; r.holdT = 0;
      o.cx = c.cx; o.cz = c.cz; o.rdx = c.rdx; o.rdz = c.rdz; o.hw = c.hw; o.must = true;
    } else if (de < v * v / (2 * BRK_EASY) + 4) {
      const need = Math.min(8, (c.a1 - c.a0) / Math.max(2.2, s.v0 * 0.7) + 1.2);
      const unsafe = r.holdT < HOLD_MAX
        && (bears(pc, c, need) || (sys.traffic ? sys.traffic.threatens(c.cx, c.cz, c.hw, need, !c.give, r.y) : false));
      if (unsafe) {
        const k = Math.sqrt(2 * BRK_EASY * Math.max(0, de - 0.9));
        if (k < _cap) _cap = k;
        if (v < 0.3) r.holdT += 0.125;
        if (!c.give && de < 2.5) {
          // waiting at a zebra or at lights: a driver who can stop, does
          r.noteOn = true;
          o.cx = c.cx; o.cz = c.cz; o.rdx = c.rdx; o.rdz = c.rdz; o.hw = c.hw; o.must = false;
        }
      } else if (de < 4.5 && v > 0.5) {
        r.noteOn = true;
        o.cx = c.cx; o.cz = c.cz; o.rdx = c.rdx; o.rdz = c.rdz; o.hw = c.hw; o.must = true;
      }
    }
  }

  // ---- cars ----
  const look = v * v / (2 * 2.2) + 6;
  const cars = sys.traffic?.cars;
  if (cars) for (const car of cars) carAhead(r, car.x, car.z, car.heading, car.speed ?? 0, car.len ?? 4.4, car.wid ?? 1.8, look, car.y);
  if (pc && !(cars && cars.has?.(pc))) carAhead(r, pc.x, pc.z, pc.heading, pc.speed ?? 0, pc.len ?? 4.4, pc.wid ?? 1.8, look, pc.y);

  // ---- people, riders slower than this one, and cars somebody left standing ----
  _on = 0;
  // A PARKED car is not waited for: nobody is coming back to move it. One
  // left across a cycle path (the player's, usually) is gone round, over the
  // verge if that is what it takes: its length goes into the same list as the
  // walkers, a point a metre, so no gap in it reads as a way through, and the
  // rider may leave the path by a car's width to find a way past its end.
  const parked = sys.parked;
  if (parked) for (let i = 0; i < parked.length; i++) {
    const car = parked[i];
    if (car === pc) continue;
    const rx = car.x - r.x, rz = car.z - r.z;
    if (rx > 22 || rx < -22 || rz > 22 || rz < -22) continue;
    const hx = -Math.sin(car.heading), hz = -Math.cos(car.heading), half = (car.len ?? 4.4) / 2 - 0.3;
    const n0 = _on;
    // (seen from further off than a walker is: there is more of it to get round)
    for (let k = -2; k <= 2; k++) note(r, car.x + hx * half * k / 2, car.z + hz * half * k / 2, 0, false, -0.4, 18);
    // (only one that is IN the way widens the search: a car park beside the path is not a reason to leave it)
    for (let k = n0; k < _on; k++) if (_ol[k] < 0.95 && _ol[k] > -0.95) { _minS = Math.min(_minS, -2.4 - leg.off); _maxS = Math.max(_maxS, 2.4); break; }
  }
  // At riding pace a walker stops counting once they are level with the
  // rider: the swing back in takes longer than the bike takes to clear them.
  // From a standing start (having waited behind them for somebody coming the
  // other way) it is the other way about, and the back wheel went through
  // their legs: there they count until it is clear of them.
  const backW = v > 2.2 ? -0.4 : Math.min(1.0, 1.4 - 0.82 * v);
  const P = sys.peds?.peds;
  if (P) for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (p.state === 'rag' || p.state === 'board') continue;
    note(r, p.x, p.z, p.state === 'walk' ? p.speed * (-Math.sin(p.heading) * r.dx - Math.cos(p.heading) * r.dz) : 0, true, backW);
  }
  if (foot) note(r, foot.x, foot.z, 0, true, backW);
  // A rider well AHEAD counts if they are slower (go round, or follow). A
  // rider LEVEL with this one counts whatever their speed: if they are beside
  // (one pulled out round the other and both stopped at the same red light),
  // each keeps the room there is between them, so neither closes in on the
  // other when the lights change; if they are on the very same line, the
  // junior of the two by slot name moves over or drops back and the senior
  // rides on.
  //
  // A rider COMING THE OTHER WAY is seen from as far off as the two of them
  // close in three and a half seconds, which is what getting round a walker
  // takes. Measured before this was here, ten minutes of the real Palackého:
  // four times a rider pulled out round a walker straight into one coming the
  // other way, and the two passed through each other. Now the oncoming one is
  // in the list the sideways position is chosen against (room() counts only
  // the room on the right of them), so the rider holds back behind the walker
  // until they have gone by. (Round a bend "to the side of where I am
  // heading" says little about somebody forty metres off: there they count
  // only from close to.)
  const R = sys.riders;
  for (let i = 0; i < R.length; i++) {
    const q = R[i];
    if (q === r) continue;
    const dot = q.dx * r.dx + q.dz * r.dz;
    if (dot < -0.4) { note(r, q.x, q.z, q.v * dot, false, -0.4, dot < -0.97 ? 8 + (v + q.v) * 3.5 : 10, true); continue; }
    if (dot < 0.4) continue;
    const rx = q.x - r.x, rz = q.z - r.z;
    if (rx > 12 || rx < -12 || rz > 12 || rz < -12) continue;
    const f = rx * r.dx + rz * r.dz, slower = q.v <= v - 0.2;
    if (f > 2.2) { if (slower) note(r, q.x, q.z, q.v, false); continue; }
    if (f < -2.2) continue;
    const lat = rz * r.dx - rx * r.dz;
    if (lat > 0.4 || lat < -0.4 || r.s.key > q.s.key || (f > 0.4 && slower)) note(r, q.x, q.z, q.v, false, 2.2);
  }
  decide(r);

  r.cap = _cap;
  r.shiftT = _shiftT;
  // In the lane, not at its edge: through a junction, across a turn, or out
  // round somebody. The traffic is told (main.js: cyclists.blockInto).
  // (…or standing: a stopped bicycle is a hull, wherever on the street it is)
  r.lane = street && (inZone(plan, arc) || r.shift < -0.5 || v < 0.6);
}
