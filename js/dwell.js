// ---- a walker's day, as a timetable -------------------------------------------
// A citizen used to be a triangle wave: out along the beat, back along the
// beat, for seven minutes, never once standing still. This module replaces the
// wave with a TIMELINE: the same out-and-back walk, with things done on the
// way. Sit on a bench. Wait at a bus stop. Look in a shop window. Stop at the
// kerb before stepping into the road, and stand there until the light says
// walk. Step off a bus, or onto one.
//
// THE CONTRACT IS UNCHANGED, and it is the only reason this is a module of its
// own: a timeline is built ONCE, at birth, from the walker's seed, the beat it
// was given and functions of the shared clock, and where the walker is at
// shared second t is then a lookup in it. No accumulator, no frame rate, no
// Math.random, nothing local. Two clients that agree on the beat agree on the
// timeline to the bit, and a late joiner who builds it a minute later builds
// the same one.
//
// SHAPE. Keyframes (t, arc), strictly increasing in t. Between two keyframes
// the walker either covers the arc between them at constant speed (WALK) or
// stands at one arc doing something (every other kind). `ref` says what: an
// index into the stops or the crossings the timeline was built from.
//
// Pure arithmetic: + - x / only on the shared path, so every engine agrees.

import { hash32, rnd01 } from './crowdsites.js';

export const DW = { WALK: 0, BENCH: 1, STOP: 2, WINDOW: 3, FOOD: 4, TALK: 5, KERB: 6, GONE: 7 };

const KERB_BACK = 0.55;      // m short of the asphalt a walker stops
const STOP_GAP = 4;          // m: two things to do closer than this are one thing
const MAX_KEYS = 600;        // a guard, not a budget: a 7 minute life has ~40

/**
 * Build a timeline.
 *
 *   o.t0, o.tEnd   shared seconds the walker exists between
 *   o.span         length of the beat, metres (o.lo, default 0, is where it
 *                  starts and turns at the near end)
 *   o.speed        walking speed, m/s
 *   o.seed         the walker's ROUTE seed (shared by a pair walking together)
 *   o.stops        [{ arc, kind, p, min, vr, sid }]: things beside the beat.
 *                  p is the chance per pass, min + vr x hash the seconds spent.
 *   o.cross        [{ a0, a1, kerb }]: stretches of the beat on a carriageway;
 *                  kerb says whether it is worth stopping to look first.
 *   o.waitAt       optional (crossIndex, t, dir) => seconds until the walk
 *                  phase, for a crossing under signals. Must be pure in t.
 *   o.board        optional { stop: index into stops, until: (t) => t' }: the
 *                  walker waits at that stop from arrival until t' and is gone.
 *   o.alight       optional { arc, t }: the walker does not exist before t and
 *                  then steps onto the beat at arc.
 *   o.talk         optional true: this walker is half of a pair, which stops
 *                  to talk once per leg.
 */
export function buildTimeline(o) {
  const T = [], A = [], D = [], K = [], R = [];
  const span = o.span, speed = o.speed, seed = o.seed | 0;
  const stops = o.stops ?? [], cross = o.cross ?? [];
  const lo = o.lo > 0 ? Math.min(o.lo, span) : 0;
  let t = o.t0, arc = lo, dir = 1, walked = 0, leg = 0;
  const key = (kind, ref) => { T.push(t); A.push(arc); D.push(walked); K.push(kind); R.push(ref); };
  const onRoad = (a) => {
    for (const c of cross) if (a > c.a0 - 0.8 && a < c.a1 + 0.8) return true;
    return false;
  };

  if (o.alight && o.alight.t > t) {
    arc = Math.max(lo, Math.min(span, o.alight.arc));
    key(DW.GONE, -1);
    t = o.alight.t;
    dir = (hash32(seed, 0xa11) & 1) ? 1 : -1;
    if (arc <= lo + 1) dir = 1; else if (arc >= span - 1) dir = -1;
  }

  const ev = [];
  while (t < o.tEnd && T.length < MAX_KEYS && span - lo > 0.5) {
    // ---- everything this leg will do, in walking order ----
    ev.length = 0;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const ahead = (s.arc - arc) * dir;
      if (ahead <= 0.5) continue;
      const boarding = o.board && o.board.stop === i;
      if (!boarding && !(rnd01(hash32(seed, 0xd3e1, leg, s.sid)) < s.p)) continue;
      ev.push({ pos: s.arc, kind: s.kind, ref: i, boarding });
    }
    for (let i = 0; i < cross.length; i++) {
      const c = cross[i];
      if (!c.kerb && !o.waitAt) continue;
      const pos = dir > 0 ? Math.max(0, c.a0 - KERB_BACK) : Math.min(span, c.a1 + KERB_BACK);
      if ((pos - arc) * dir <= 0.05) continue;
      ev.push({ pos, kind: DW.KERB, ref: i, boarding: false });
    }
    if (o.talk) {
      // one conversation per leg, somewhere along it that is not a carriageway
      const at = lo + (0.15 + 0.7 * rnd01(hash32(seed, 0x7a1c, leg))) * (span - lo);
      if ((at - arc) * dir > 3 && !onRoad(at) && rnd01(hash32(seed, 0x7a1d, leg)) < 0.6)
        ev.push({ pos: at, kind: DW.TALK, ref: -1, boarding: false });
    }
    ev.sort((p, q) => (p.pos - q.pos) * dir || (p.kind - q.kind));

    // ---- walk it ----
    let lastStop = -1e9, gone = false;
    key(DW.WALK, -1);
    for (const e of ev) {
      const isKerb = e.kind === DW.KERB;
      if (!isKerb && !e.boarding && Math.abs(e.pos - lastStop) < STOP_GAP) continue;
      let dur = 0;
      const tAt = t + Math.abs(e.pos - arc) / speed;
      if (isKerb) {
        const c = cross[e.ref];
        const look = c.kerb ? 0.6 + 1.8 * rnd01(hash32(seed, 0x4e2, leg, e.ref)) : 0;
        const w = o.waitAt ? o.waitAt(e.ref, tAt + look, dir) : 0;
        dur = look + (w > 0 && Number.isFinite(w) ? w : 0);
      } else if (e.boarding) {
        const until = o.board.until(tAt);
        if (!Number.isFinite(until) || until <= tAt) continue;   // no bus is coming
        dur = until - tAt;
      } else if (e.kind === DW.TALK) {
        dur = 10 + 16 * rnd01(hash32(seed, 0x7a1e, leg));
      } else {
        const s = stops[e.ref];
        dur = s.min + s.vr * rnd01(hash32(seed, 0xd3e2, leg, s.sid));
      }
      if (!(dur > 0.05)) continue;
      walked += Math.abs(e.pos - arc); arc = e.pos; t = tAt;
      key(e.kind, e.ref);
      t += dur;
      key(DW.WALK, -1);
      if (!isKerb) lastStop = e.pos;
      if (e.boarding) { gone = true; break; }
      if (t >= o.tEnd) break;
    }
    if (gone) {
      K[K.length - 1] = DW.GONE;
      t = Math.max(t, o.tEnd) + 1;
      key(DW.GONE, -1);
      break;
    }
    if (t >= o.tEnd) break;
    // ---- to the end of the leg, and turn ----
    const end = dir > 0 ? span : lo;
    const d = Math.abs(end - arc);
    walked += d; arc = end; t += d / speed;
    dir = -dir; leg++;
  }
  key(K.length ? K[K.length - 1] === DW.GONE ? DW.GONE : DW.WALK : DW.WALK, -1);
  return {
    n: T.length, t: Float64Array.from(T), a: Float64Array.from(A), d: Float64Array.from(D),
    k: Int8Array.from(K), r: Int16Array.from(R), i: 0,
  };
}

/**
 * Where the timeline has the walker at shared second t. Writes into `out`:
 *   arc, sign (+1 walking out, -1 back), walked (metres since birth, for the
 *   stride), kind (DW.*), ref, tIn / tOut (seconds into and left of a dwell),
 *   v (1 while walking, 0 while standing), i (the keyframe the answer was
 *   read from: one visit to a bench or a stop is one keyframe, and tl.t[i] is
 *   the shared second it began).
 * The cursor `tl.i` is a hint only: any t gives the same answer from any i.
 */
export function sampleTimeline(tl, t, out) {
  const T = tl.t, n = tl.n;
  let i = tl.i;
  if (i > n - 2) i = n - 2;
  if (i < 0) i = 0;
  while (i > 0 && t < T[i]) i--;
  while (i < n - 2 && t >= T[i + 1]) i++;
  tl.i = i;
  const t0 = T[i], t1 = T[i + 1], a0 = tl.a[i], a1 = tl.a[i + 1];
  let f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  if (f < 0) f = 0; else if (f > 1) f = 1;
  const kind = tl.k[i];
  out.kind = t >= T[n - 1] ? tl.k[n - 1] : kind;
  out.ref = tl.r[i];
  out.i = i;
  out.arc = a0 + (a1 - a0) * f;
  out.walked = tl.d[i] + (tl.d[i + 1] - tl.d[i]) * f;
  out.tIn = t - t0; out.tOut = t1 - t;
  if (a1 !== a0) { out.sign = a1 > a0 ? 1 : -1; out.v = 1; }
  else {
    // standing: face the way the walk continues (or, at the end, the way it came)
    let s = 0;
    for (let j = i + 1; j < n - 1 && !s; j++) if (tl.a[j + 1] !== tl.a[j]) s = tl.a[j + 1] > tl.a[j] ? 1 : -1;
    for (let j = i - 1; j >= 0 && !s; j--) if (tl.a[j + 1] !== tl.a[j]) s = tl.a[j + 1] > tl.a[j] ? 1 : -1;
    out.sign = s || 1; out.v = 0;
  }
  return out;
}

/** Seconds of the timeline spent standing, by kind (diagnostics and tests). */
export function dwellSeconds(tl) {
  const out = {};
  for (let i = 0; i < tl.n - 1; i++) {
    if (tl.k[i] === DW.WALK || tl.a[i + 1] !== tl.a[i]) continue;
    out[tl.k[i]] = (out[tl.k[i]] ?? 0) + (tl.t[i + 1] - tl.t[i]);
  }
  return out;
}
