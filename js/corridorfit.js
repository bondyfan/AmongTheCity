// ---- one smooth height profile along a corridor's chainage (numbers only) ----
// The line every member of a corridor reads (js/corridorgeom.js says who they
// are, js/corridorlevel.js gathers the ground). Pure 1-D arithmetic on Float64
// arrays: no three, no DOM, no world.
//
// The old levelling (geo.levelWayBase) held each way within 0.14 m below and
// 1.6 m above the survey under its own centreline, and the 20 m survey rounds
// an embankment's flat top down at its edges: so the line WAS the survey, and
// every undulation of the grid came out as a bump. Here:
//   1. the target is a statistic across the corridor's whole width (crest of
//      an embankment, middle of a terrace on a cross slope), not one line;
//   2. a long low-pass with the class's cut and fill bounds re-imposed
//      between passes (the bound applied once leaves a corner, geo.js),
//   3. a SYMMETRIC grade limit: the mean of the lowest grade-limited line over
//      it and the highest under it, which lowers crests as much as it fills
//      dips and is grade-limited itself (a mean of two G-Lipschitz lines is),
//   4. a last blur for the vertical radius,
//   5. hard floors (a deck's headroom, the ground under a span) and ceilings
//      (a bridge crossing over) laid on with C1 blends.

/** One Gaussian-like pass: three box blurs of radius r samples, mirrored ends. O(n). */
function boxPass(src, dst, r) {
  const n = src.length;
  if (r < 1 || n < 3) { dst.set(src); return; }
  const w = 2 * r + 1;
  const at = (j) => { while (j < 0 || j >= n) { if (j < 0) j = -j; if (j >= n) j = 2 * n - 2 - j; } return src[j]; };
  let acc = 0;
  for (let k = -r; k <= r; k++) acc += at(k);
  for (let i = 0; i < n; i++) {
    dst[i] = acc / w;
    acc += at(i + r + 1) - at(i - r);
  }
}
const _t1 = { a: null };
/** Gaussian blur of standard deviation `sigma` samples (three boxes). In place. */
export function gaussBlur(y, sigma) {
  if (!(sigma > 0.3)) return y;
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  if (!_t1.a || _t1.a.length < y.length) _t1.a = new Float64Array(Math.max(y.length, 1024));
  const t = _t1.a.subarray(0, y.length);
  boxPass(y, t, r); boxPass(t, y, r); boxPass(y, t, r); y.set(t);
  return y;
}

/** The symmetric grade limit: mean of the upper and lower `g`-limited envelopes (g per sample, metres). */
export function gradeLimit(y, g) {
  const n = y.length, L = Float64Array.from(y), U = Float64Array.from(y);
  for (let i = 1; i < n; i++) {
    const s = g[i] > g[i - 1] ? g[i] : g[i - 1];
    if (L[i] < L[i - 1] - s) L[i] = L[i - 1] - s;
    if (U[i] > U[i - 1] + s) U[i] = U[i - 1] + s;
  }
  for (let i = n - 2; i >= 0; i--) {
    const s = g[i] > g[i + 1] ? g[i] : g[i + 1];
    if (L[i] < L[i + 1] - s) L[i] = L[i + 1] - s;
    if (U[i] > U[i + 1] + s) U[i] = U[i + 1] + s;
  }
  for (let i = 0; i < n; i++) y[i] = (L[i] + U[i]) / 2;
  return y;
}

/** A quantile of a short list (sorted in place). */
export function quantile(a, q) {
  if (!a.length) return NaN;
  a.sort((p, r) => p - r);
  const u = q * (a.length - 1), i = Math.floor(u), f = u - i;
  return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * f : a[i];
}

/**
 * Fill the free bins (NaN) of a target from their neighbours: linear between
 * two known ones, constant past the ends. Returns false when nothing is known.
 */
export function fillGaps(T) {
  const n = T.length;
  let first = -1;
  for (let i = 0; i < n; i++) if (!Number.isNaN(T[i])) { first = i; break; }
  if (first < 0) return false;
  for (let i = 0; i < first; i++) T[i] = T[first];
  let last = first;
  for (let i = first + 1; i < n; i++) {
    if (Number.isNaN(T[i])) continue;
    for (let k = last + 1; k < i; k++) T[k] = T[last] + (T[i] - T[last]) * ((k - last) / (i - last));
    last = i;
  }
  for (let i = last + 1; i < n; i++) T[i] = T[last];
  return true;
}

/**
 * The fit. `T` target per bin (free bins already filled), `free` 1 where no
 * ground bounds the line (a span), `cut`/`fill`/`grade` per bin (metres, metres,
 * rise per metre), `ds` the bin length. `o.sigma`/`o.passes` the bounded
 * low-pass, `o.final` the last blur (metres).
 */
export function fitProfile(T, free, cut, fill, grade, ds, o) {
  const n = T.length, y = Float64Array.from(T);
  const sig = o.sigma / ds;
  const clamp = () => {
    for (let i = 0; i < n; i++) {
      if (free[i]) continue;
      const lo = T[i] - cut[i], hi = T[i] + fill[i];
      if (y[i] < lo) y[i] = lo; else if (y[i] > hi) y[i] = hi;
    }
  };
  for (let k = 0; k < o.passes; k++) { gaussBlur(y, sig); clamp(); }
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = grade[i] * ds;
  // the grade limit and the bounds, a few rounds: where both cannot hold, the
  // bounds win (the ground is what it is) and the final blur rounds the rest
  for (let k = 0; k < 3; k++) { gradeLimit(y, g); clamp(); }
  gradeLimit(y, g);
  gaussBlur(y, o.final / ds);
  return y;
}

/** The higher of two levels with the corner rounded over `k` (polynomial smooth max, as geo.smax). */
export function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a > b ? a : b) + h * h * k / 4;
}
export function smin(a, b, k) { return -smax(-a, -b, k); }
/** How far a crest of radius R falling at grade g has fallen x metres out (geo.crestFall). */
export function crestFall(x, g, R) {
  const xt = g * R;
  return x <= xt ? x * x / (2 * R) : g * (x - xt / 2);
}

/**
 * Hard floors: each {s, y, g, R} pushes the line up to y at s, falling away at
 * grade g through a crest of radius R either side. Ceilings likewise push it
 * down (rising away). C1 everywhere (smax / smin over `k`).
 */
export function applyFloors(y, ds, floors, ceilings, k = 1) {
  for (const [constraints, sign] of [[floors, 1], [ceilings, -1]]) {
    if (!constraints.length) continue;
    // Short lists (a typical crossing) are cheaper to evaluate directly.
    if (constraints.length <= 8) {
      for (let i = 0; i < y.length; i++) {
        let level = -Infinity;
        for (const c of constraints) level = Math.max(level, sign * c.y - crestFall(Math.abs(i * ds - c.s), c.g, c.R));
        if (level > sign * y[i] - k) y[i] = sign * smax(sign * y[i], level, k);
      }
      continue;
    }
    // Beyond its circular crest each constraint is a straight line. For each
    // grade/radius pair all left tails and all right tails are parallel, so
    // only their highest intercept matters. Visit just the nearby crests.
    const groups = new Map();
    for (const c of constraints) {
      const key = c.g + ',' + c.R;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const envelope = new Float64Array(y.length).fill(-Infinity);
    for (const group of groups.values()) {
      group.sort((a, b) => a.s - b.s);
      const { g, R } = group[0], reach = g * R, offset = reach * g / 2;
      const suffix = new Float64Array(group.length + 1).fill(-Infinity);
      for (let j = group.length - 1; j >= 0; j--) suffix[j] = Math.max(suffix[j + 1], sign * group[j].y - g * group[j].s);
      let lo = 0, hi = 0, left = -Infinity;
      for (let i = 0; i < y.length; i++) {
        const s = i * ds;
        while (lo < group.length && group[lo].s < s - reach) {
          left = Math.max(left, sign * group[lo].y + g * group[lo].s);
          lo++;
        }
        while (hi < group.length && group[hi].s <= s + reach) hi++;
        let level = Math.max(left - s * g, suffix[hi] + s * g) + offset;
        for (let j = lo; j < hi; j++) {
          const d = s - group[j].s;
          level = Math.max(level, sign * group[j].y - d * d / (2 * R));
        }
        envelope[i] = Math.max(envelope[i], level);
      }
    }
    for (let i = 0; i < y.length; i++)
      if (envelope[i] > sign * y[i] - k) y[i] = sign * smax(sign * y[i], envelope[i], k);
  }
  return y;
}

/**
 * Pins from a higher corridor: each {s, d} asks the line to move by d at s.
 * Between two pins less than 2 reach apart the offset is blended (smoothstep),
 * outside it dies away over `reach(d)` on a raised cosine, so every pin lands
 * exactly and nothing between them is kinked. Pins closer than `merge` are one.
 */
export function applyPins(y, ds, pins, reachOf, merge = 4) {
  if (!pins.length) return y;
  const n = y.length;
  const P = [...pins].sort((a, b) => a.s - b.s);
  const M = [];
  for (const p of P) {
    const q = M[M.length - 1];
    if (q && p.s - q.s < merge) { q.d = (q.d * q.k + p.d) / (q.k + 1); q.s = (q.s * q.k + p.s) / (q.k + 1); q.k++; }
    else M.push({ s: p.s, d: p.d, k: 1 });
  }
  let a = -1;
  const ss = (t) => t * t * (3 - 2 * t);
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    // the pins either side of this sample
    while (a + 1 < M.length && M[a + 1].s <= s) a++;
    const A = a >= 0 ? M[a] : null, B = a + 1 < M.length ? M[a + 1] : null;
    if (A && B && B.s - A.s <= reachOf(A.d) + reachOf(B.d)) {
      y[i] += A.d + (B.d - A.d) * ss((s - A.s) / (B.s - A.s || 1));
      continue;
    }
    let v = 0;
    if (A) { const r = reachOf(A.d), x = s - A.s; if (x < r) v += A.d * (0.5 + 0.5 * Math.cos(Math.PI * x / r)); }
    if (B) { const r = reachOf(B.d), x = B.s - s; if (x < r) v += B.d * (0.5 + 0.5 * Math.cos(Math.PI * x / r)); }
    y[i] += v;
  }
  return y;
}

// Between two real attachment points a slip follows a continuous vertical
// alignment. Fair the surveyed profile over a 50 m neighbourhood while
// keeping the junction samples and no more than 1.2 m of additional cut/fill.
export function fairLink(profile, way) {
  if (!profile || way.br || way._dipChain || !way.t.endsWith('_link')) return profile;
  const n = profile.n, ds = profile.ds, last = n - 1, raw = profile.y;
  const anchors = new Set([0, last]);
  for (const { s, node } of way._pins ?? []) {
    if (node._ovl) continue;
    const i = Math.max(0, Math.min(last, Math.floor(s / ds)));
    anchors.add(i); anchors.add(Math.min(last, i + 1));
  }
  const sorted = [...anchors].sort((a, b) => a - b);
  const y = Float32Array.from(raw), sums = new Float64Array(n + 1);
  const radius = Math.max(1, Math.round(25 / ds));
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + y[i];
    for (let j = 1; j < sorted.length; j++) {
      const a = sorted[j - 1], b = sorted[j];
      for (let i = a + 1; i < b; i++) {
        const r = Math.min(radius, i - a, b - i);
        const mean = (sums[i + r + 1] - sums[i - r]) / (2 * r + 1);
        y[i] = Math.max(raw[i] - 1.2, Math.min(raw[i] + 1.2, mean));
      }
    }
  }
  return { ...profile, y };
}
