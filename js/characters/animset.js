// ---- animset.js: which recorded clip a body plays, and how fast ------------
//
// Pure rules, no three and no clock of its own. The clips themselves are baked
// by js/characters/clipbank.js; this file only decides WHICH of them a person
// is in and where in it they are:
//
//   * A walk is a blend of the two recorded gaits either side of the person's
//     speed (slow walk, walk, brisk walk, jog, run, sprint). Each gait knows
//     the ground it covers in one cycle, so the cycle advances with DISTANCE
//     and a planted foot stays where it was planted.
//   * Standing still is one calm loop, broken now and then by a fidget
//     (a look round, a scratch, a shifted leg), drawn per person so a bus
//     stop is not a row of people scratching their heads together.
//
// A clip set is the manifest's `roles` table: role name to a clip name, to a
// list of names, or to { m, f } of either.

const c01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** The gait roles in order of speed. */
export const GAIT_ROLES = ['walkSlow', 'walk', 'walkFast', 'jog', 'run', 'sprint'];

/** Every clip name a role resolves to for this sex (always an array). */
export function clipsFor(roles, role, sex = 'm') {
  let r = roles?.[role];
  if (r && !Array.isArray(r) && typeof r === 'object') r = r[sex] ?? r.m ?? r.f;
  if (r == null) return [];
  return Array.isArray(r) ? r : [r];
}

/**
 * The recorded gaits a body has, slowest first. `have(name)` returns the baked
 * clip or null; each gait is { clip, speed, stride } where stride is the
 * ground covered by one full cycle (two steps), in the clip's own metres.
 */
export function gaitTable(roles, sex, have) {
  const out = [];
  for (const role of GAIT_ROLES) {
    for (const name of clipsFor(roles, role, sex)) {
      const clip = have(name);
      if (!clip || !(clip.travel > 0.2)) continue;
      out.push({ role, clip, speed: clip.travel / clip.dur, stride: clip.travel });
      break;
    }
  }
  out.sort((a, b) => a.speed - b.speed);
  return out;
}

/**
 * Which two gaits a speed falls between. Returns { a, b, w, stride } with w
 * the share of b, written into `out`. `scale` is the body's leg length against
 * the clip's (a short person takes shorter steps at the same pose).
 */
export function pickGait(gaits, v, scale = 1, out = {}) {
  const n = gaits.length;
  if (!n) { out.a = out.b = null; out.w = 0; out.stride = 1.4; return out; }
  const lo = gaits[0], hi = gaits[n - 1];
  if (v <= lo.speed * scale) {
    // slower than the slowest recording: the same steps, a little shorter and
    // a good deal slower (half of the shortfall each way)
    const r = c01(v / (lo.speed * scale));
    out.a = out.b = lo; out.w = 0; out.stride = lo.stride * scale * (0.5 + 0.5 * r);
    return out;
  }
  if (v >= hi.speed * scale) {
    // faster than the fastest: longer strides AND a quicker cadence
    out.a = out.b = hi; out.w = 0; out.stride = hi.stride * scale * (1 + 0.4 * (v / (hi.speed * scale) - 1));
    return out;
  }
  for (let i = 1; i < n; i++) {
    const g1 = gaits[i];
    if (v > g1.speed * scale) continue;
    const g0 = gaits[i - 1];
    const w = (v - g0.speed * scale) / ((g1.speed - g0.speed) * scale || 1);
    out.a = g0; out.b = g1; out.w = w; out.stride = (g0.stride + (g1.stride - g0.stride) * w) * scale;
    return out;
  }
  out.a = out.b = hi; out.w = 0; out.stride = hi.stride * scale;
  return out;
}

// a small integer hash: the same person fidgets the same way on every frame
function mix(a, b) {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return h >>> 0;
}

/**
 * What somebody standing still is doing at time `t` (seconds, any clock).
 *   idles    calm loops (one is the person's own)
 *   fidgets  one-off clips with a `dur`
 * Returns { clip, t, fidget }: the clip and the time into it. Time is cut
 * into windows of `period` seconds; a window either holds one fidget, started
 * a few seconds in, or none.
 */
export function idleAt(seed, t, idles, fidgets, { period = 14, chance = 0.45 } = {}, out = {}) {
  const own = idles.length ? idles[mix(seed, 1) % idles.length] : null;
  out.clip = own; out.t = t + (mix(seed, 2) % 1000) / 100; out.fidget = false;
  if (!fidgets.length || !own) return out;
  const win = Math.floor(t / period), h = mix(seed, 100 + win);
  if ((h % 1000) / 1000 >= chance) return out;
  const f = fidgets[(h >>> 10) % fidgets.length];
  const start = win * period + 1.5 + ((h >>> 20) % 100) / 100 * Math.max(0, period - 3 - f.dur);
  const u = t - start;
  if (u < 0 || u >= f.dur) return out;
  out.clip = f; out.t = u; out.fidget = true;
  return out;
}

/** 0..1 ease in and out of a one-off clip of length `dur`, `fade` seconds each end. */
export function fadeInOut(u, dur, fade = 0.3) {
  const f = Math.min(fade, dur / 2);
  return c01(Math.min(u / f, (dur - u) / f));
}

/**
 * Where a clip that starts on any foot should start so that all gaits agree:
 * the frame at which the LEFT foot is furthest ahead of the right. `footZ(f)`
 * returns left minus right foot z at frame f (negative = left ahead).
 */
export function strikeFrame(frames, footZ) {
  let at = 0, best = Infinity;
  for (let f = 0; f < frames; f++) { const z = footZ(f); if (z < best) { best = z; at = f; } }
  return at;
}
