// ---- corridors: which ways share ONE height profile (plan only) --------------
// Round 10 ("herbolaté, kostrbaté"). Every OSM way used to be levelled alone
// (geo.levelWayBase), so the two carriageways of a dual road and the tracks of
// one railway bundle each followed their own strip of a 20 m survey and sat
// metres apart on one embankment or terrace. A CORRIDOR is the set of ways that
// must read one line instead:
//   - a chain of ways joined end to end where the road runs straight on
//     (mutual best continuation, same family),
//   - the two carriageways of a dual road (both oneway, opposite travel,
//     parallel within PAIR_ROAD over a real length, same layer, same bridge flag),
//   - the parallel tracks of one heavy-rail bundle (within PAIR_RAIL).
// Everything here is a pure function of the ways' tags, geometry and ids, never
// of a height: membership must be known before any profile exists (survey 13,
// critic: streetOf reads the final profile and cannot gate this). No three, no
// DOM: it runs wherever geo.js runs.

/** Class rank: the higher one is hard where two corridors meet. Rail wins. */
export const RANK = {
  rail: 100, motorway: 90, trunk: 80, primary: 70,
  motorway_link: 60, trunk_link: 55, primary_link: 50,
};
const LINKS = new Set(['motorway_link', 'trunk_link', 'primary_link']);

/** Is this way levelled as part of a corridor? Heavy rail and the main road classes, bridges included. */
export function inScope(w) {
  if (!w?.p || w.p.length < 2) return false;
  if (w.t === 'rail') return true;
  return !!w.d && RANK[w.t] !== undefined;
}
export const isRail = (w) => w.t === 'rail';
/** Ways of one family may continue into each other along a chain. */
export function family(w) {
  if (w.t === 'rail') return 'rail';
  return LINKS.has(w.t) ? 'link' : 'main';
}
/** Does `a` outrank `b` where they meet? Class, then signed speed, then the lower id. Total and pure. */
export function outranks(a, b) {
  const ra = RANK[a.t] ?? 0, rb = RANK[b.t] ?? 0;
  if (ra !== rb) return ra > rb;
  const va = a.v ?? 0, vb = b.v ?? 0;
  if (va !== vb) return va > vb;
  return (a._id ?? 0) < (b._id ?? 0);
}

export const J_KEY = (x, z) => Math.round(x * 50) + ',' + Math.round(z * 50);

// ---- per-way plan geometry, cached (the polyline never changes) --------------
const _geo = new WeakMap();
/** {L, cum, bb} of a way: cumulative arclength per vertex and its bounding box. */
export function geomOf(w) {
  let g = _geo.get(w);
  if (g && g.p === w.p && g.cum.length === w.p.length) return g;
  const p = w.p, cum = new Float64Array(p.length);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i++) {
    if (i) cum[i] = cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (p[i][0] < x0) x0 = p[i][0]; if (p[i][0] > x1) x1 = p[i][0];
    if (p[i][1] < z0) z0 = p[i][1]; if (p[i][1] > z1) z1 = p[i][1];
  }
  g = { p, L: cum[p.length - 1], cum, bb: [x0, z0, x1, z1] };
  _geo.set(w, g);
  return g;
}
/** Point and unit tangent at arclength s along a way. */
export function pointOn(w, s) {
  const g = geomOf(w), p = w.p, n = p.length;
  if (s <= 0) s = 0; else if (s >= g.L) s = g.L;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g.cum[m] <= s) lo = m; else hi = m; }
  const L = g.cum[hi] - g.cum[lo] || 1e-9, t = (s - g.cum[lo]) / L;
  const ex = (p[hi][0] - p[lo][0]) / L, ez = (p[hi][1] - p[lo][1]) / L;
  return { x: p[lo][0] + (p[hi][0] - p[lo][0]) * t, z: p[lo][1] + (p[hi][1] - p[lo][1]) * t, tx: ex, tz: ez };
}
/** Nearest point of a way to (x, z): distance, arclength, unit tangent there. */
export function nearestOnWay(w, x, z) {
  const p = w.p, g = geomOf(w);
  let best = Infinity, bs = 0, btx = 1, btz = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], ex = p[i + 1][0] - ax, ez = p[i + 1][1] - az;
    const L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - ax - ex * t, dz = z - az - ez * t, d = dx * dx + dz * dz;
    if (d < best) { best = d; const L = Math.sqrt(L2); bs = g.cum[i] + L * t; btx = ex / L; btz = ez / L; }
  }
  return { d: Math.sqrt(best), s: bs, tx: btx, tz: btz };
}
const bbNear = (a, b, m) => a[0] - m <= b[2] && b[0] - m <= a[2] && a[1] - m <= b[3] && b[1] - m <= a[3];

// ---- series: straight-through joins ------------------------------------------
const SERIES_COS = Math.cos(35 * Math.PI / 180);
const DIR_PROBE = 10;        // m along a way its direction at an end is read over
/** Unit direction pointing INTO the way from its end `e` (0 = first vertex, 1 = last). */
function outDir(w, e) {
  const g = geomOf(w), s = Math.min(DIR_PROBE, g.L / 2);
  const a = pointOn(w, e ? g.L : 0), b = pointOn(w, e ? g.L - s : s);
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1e-9;
  return [dx / L, dz / L];
}
/** End-point index of a set of ways: key -> [{w, e}]. */
export function endIndex(ways) {
  const m = new Map();
  for (const w of ways) {
    for (const e of [0, 1]) {
      const q = w.p[e ? w.p.length - 1 : 0], k = J_KEY(q[0], q[1]);
      let a = m.get(k);
      if (!a) m.set(k, a = []);
      a.push({ w, e });
    }
  }
  return m;
}
function bestStraight(ends, w, e) {
  const q = w.p[e ? w.p.length - 1 : 0], here = ends.get(J_KEY(q[0], q[1]));
  if (!here || here.length < 2) return null;
  const [ax, az] = outDir(w, e), fam = family(w);
  let best = null, bc = SERIES_COS;
  for (const o of here) {
    if (o.w === w || family(o.w) !== fam) continue;
    // a oneway runs on only out of its exit into the next one's entry
    if (w.ow && o.w.ow && e === o.e) continue;
    const [bx, bz] = outDir(o.w, o.e), c = -(ax * bx + az * bz);
    if (c > bc + 1e-9 || (best && Math.abs(c - bc) <= 1e-9 && o.w._id < best.w._id)) { bc = c; best = o; }
  }
  return best;
}
/** The way this one runs straight on into at end `e`, if both agree (mutual best). */
export function seriesNext(ends, w, e) {
  const o = bestStraight(ends, w, e);
  if (!o) return null;
  const back = bestStraight(ends, o.w, o.e);
  return back && back.w === w && back.e === e ? o : null;
}

// ---- parallels: the other carriageway, the next track ------------------------
const PAIR_ROAD = 26;        // m centreline to centreline: the two halves of a dual road
const PAIR_RAIL = 9;         // m: the next track of a bundle (rails.md: tracks 4.5 m apart)
const PAIR_COS = Math.cos(20 * Math.PI / 180);
const PAIR_STEP = 10;        // m between the stations the test walks
const _pair = new WeakMap();
/** Are two in-scope ways parallel members of one corridor? Pure, symmetric, cached. */
export function parallel(a, b) {
  if (a === b) return false;
  const lo = a._id < b._id ? a : b, hi = lo === a ? b : a;
  let m = _pair.get(lo);
  if (m) { const v = m.get(hi._id); if (v !== undefined && v.p === hi.p) return v.ok; }
  const ok = parallelTest(lo, hi);
  if (!m) _pair.set(lo, m = new Map());
  m.set(hi._id, { p: hi.p, ok });
  return ok;
}
function parallelTest(a, b) {
  const rail = isRail(a);
  if (rail !== isRail(b)) return false;
  if (!!a.br !== !!b.br) return false;
  if ((a.l ?? 0) !== (b.l ?? 0)) return false;
  const D = rail ? PAIR_RAIL : PAIR_ROAD;
  if (!rail) {
    // (two slip roads side by side are two ramps, often on two levels: a
    // link only ever runs on in series)
    if (family(a) !== 'main' || family(b) !== 'main') return false;
    if (!a.ow || !b.ow) return false;          // a dual road is two oneways
  }
  const ga = geomOf(a), gb = geomOf(b);
  if (!bbNear(ga.bb, gb.bb, D)) return false;
  const [s, o] = ga.L <= gb.L ? [a, b] : [b, a];
  const gs = geomOf(s);
  const n = Math.max(2, Math.ceil(gs.L / PAIR_STEP) + 1);
  let hit = 0, travel = 0;
  for (let k = 0; k < n; k++) {
    const P = pointOn(s, (k / (n - 1)) * gs.L);
    const q = nearestOnWay(o, P.x, P.z);
    if (q.d > D) continue;
    const c = P.tx * q.tx + P.tz * q.tz;
    if (Math.abs(c) < PAIR_COS) continue;
    hit++; travel += c;
  }
  const len = (hit / n) * gs.L;
  if (len < Math.min(rail ? 40 : 60, (rail ? 0.5 : 0.6) * gs.L)) return false;
  // the two halves of a dual road are driven in opposite directions
  if (!rail && travel > -0.7 * hit) return false;
  return true;
}

// ---- the axis: one chainage for the corridor ---------------------------------
/**
 * The series chain through `w` within `reach` metres past its two ends, as one
 * polyline with every way's place on it. Pure in `w` and the ends index.
 *
 * Where the chain stops short of the reach (a track that ends in a turnout, a
 * carriageway split at a junction) and `cands` are given, the axis carries on
 * along the nearest way running the same way past its end (EXT_D, EXT_COS):
 * every member of a bundle then sees the whole bundle over the same length,
 * or a short track's line was its own few hundred metres with free ends and
 * stood centimetres to a metre off its neighbours'. The axis is trimmed to
 * `reach` past w either side.
 */
const EXT_COS = 0.95;
export function buildAxis(ends, w, reach, cands = null, extD = 0) {
  const parts = [{ w, rev: false }];
  const used = new Set([w]);
  const run = [0, 0];
  // forward from w's last vertex, then backward from its first
  for (const dir of [1, 0]) {
    let cur = w, e = dir;
    while (run[dir] < reach) {
      const nx = seriesNext(ends, cur, e);
      if (!nx || used.has(nx.w)) break;
      used.add(nx.w);
      // entering at nx.e; running away from it
      const rev = nx.e === 1;
      if (dir === 1) parts.push({ w: nx.w, rev }); else parts.unshift({ w: nx.w, rev: !rev });
      run[dir] += geomOf(nx.w).L;
      cur = nx.w; e = nx.e ? 0 : 1;
    }
  }
  // the chain as points, oriented
  const pts = [];
  let selfAt = 0;
  for (const pt of parts) {
    const p = pt.w.p;
    if (pt.w === w) selfAt = pts.length / 2 - (pts.length ? 1 : 0);
    for (let i = 0; i < p.length; i++) {
      const q = p[pt.rev ? p.length - 1 - i : i];
      if (pts.length && i === 0) continue;   // the shared joint
      pts.push(q[0], q[1]);
    }
  }
  let head = [];                             // points to put in front, in axis order
  if (cands && extD > 0) {
    for (const dir of [1, 0]) {
      let left = reach - run[dir];
      const P = dir ? pts.slice(-4) : pts.slice(0, 4);
      // end point and the direction the axis leaves it in
      let ex = dir ? P[2] : P[0], ez = dir ? P[3] : P[1];
      let dx = dir ? P[2] - P[0] : P[0] - P[2], dz = dir ? P[3] - P[1] : P[1] - P[3];
      let dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const out = [];
      for (let guard = 0; left > 0 && guard < 24; guard++) {
        let best = null;
        for (const c of cands) {
          if (used.has(c) || isRail(c) !== isRail(w)) continue;
          if (!bbNear(geomOf(c).bb, [ex, ez, ex, ez], extD)) continue;
          const q = nearestOnWay(c, ex, ez);
          if (q.d > extD) continue;
          const cs = q.tx * dx + q.tz * dz;
          if (Math.abs(cs) < EXT_COS) continue;
          const sg = cs > 0 ? 1 : -1, L = geomOf(c).L, rem = sg > 0 ? L - q.s : q.s;
          if (rem < 20) continue;
          if (!best || q.d < best.d - 1e-6 || (Math.abs(q.d - best.d) <= 1e-6 && c._id < best.c._id)) best = { c, d: q.d, s: q.s, sg, rem };
        }
        if (!best) break;
        used.add(best.c);
        const p = best.c.p, g = geomOf(best.c);
        const idx = [];
        if (best.sg > 0) { for (let i = 0; i < p.length; i++) if (g.cum[i] > best.s + 2) idx.push(i); }
        else { for (let i = p.length - 1; i >= 0; i--) if (g.cum[i] < best.s - 2) idx.push(i); }
        if (!idx.length) break;
        for (const i of idx) out.push(p[i][0], p[i][1]);
        left -= best.rem;
        const a = idx.length > 1 ? p[idx[idx.length - 2]] : [ex, ez], b = p[idx[idx.length - 1]];
        ex = b[0]; ez = b[1];
        dx = b[0] - a[0]; dz = b[1] - a[1]; dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      }
      if (dir) for (let i = 0; i < out.length; i++) pts.push(out[i]);
      else { for (let i = out.length - 2; i >= 0; i -= 2) head.push(out[i], out[i + 1]); }
    }
  }
  const all = head.length ? head.concat(pts) : pts;
  selfAt += head.length / 2;
  let n = all.length / 2, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(all[2 * i] - all[2 * i - 2], all[2 * i + 1] - all[2 * i - 1]);
  // trimmed to the reach either side of w
  const s0 = cum[selfAt], s1 = s0 + geomOf(w).L;
  let a = 0, b = n - 1;
  while (a < selfAt && cum[a + 1] <= s0 - reach) a++;
  while (b > 0 && cum[b - 1] >= s1 + reach) b--;
  const tp = all.slice(2 * a, 2 * b + 2);
  n = tp.length / 2;
  const tc = new Float64Array(n);
  for (let i = 1; i < n; i++) tc[i] = tc[i - 1] + Math.hypot(tp[2 * i] - tp[2 * i - 2], tp[2 * i + 1] - tp[2 * i - 1]);
  const self = { w, off: s0 - cum[a], rev: false };
  return { pts: tp, cum: tc, L: tc[n - 1], self };
}
/** Chainage and signed lateral offset of (x, z) on an axis (+ = left of travel). `hint`: a segment to start near. */
export function projectAxis(ax, x, z, hint = -1) {
  const P = ax.pts, n = P.length / 2;
  let best = Infinity, bs = 0, bd = 0, bi = 0;
  const lo = hint >= 0 ? Math.max(0, hint - 6) : 0, hi = hint >= 0 ? Math.min(n - 1, hint + 7) : n - 1;
  const scan = (a, b) => {
    for (let i = a; i < b; i++) {
      const axx = P[2 * i], azz = P[2 * i + 1], ex = P[2 * i + 2] - axx, ez = P[2 * i + 3] - azz;
      const L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - axx) * ex + (z - azz) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - axx - ex * t, dz = z - azz - ez * t, d = dx * dx + dz * dz;
      if (d < best) {
        best = d; bi = i; bs = ax.cum[i] + Math.sqrt(L2) * t;
        bd = (ex * dz - ez * dx) < 0 ? Math.sqrt(d) : -Math.sqrt(d);
      }
    }
  };
  scan(lo, hi);
  // a minimum on the window's edge walks on that way until it is inside (the
  // members of a corridor run alongside, so this is a few segments, never all)
  let a = lo, b = hi;
  for (let guard = 0; hint >= 0 && guard < n; guard++) {
    if (bi === a && a > 0) { const a0 = Math.max(0, a - 8); scan(a0, a); a = a0; }
    else if (bi === b - 1 && b < n - 1) { const b0 = Math.min(n - 1, b + 8); scan(b, b0); b = b0; }
    else break;
  }
  return { s: bs, d: bd, i: bi };
}
/** Point and unit tangent of the axis at chainage s. */
export function axisPoint(ax, s) {
  const P = ax.pts, n = P.length / 2;
  if (s <= 0) s = 0; else if (s >= ax.L) s = ax.L;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ax.cum[m] <= s) lo = m; else hi = m; }
  const L = ax.cum[hi] - ax.cum[lo] || 1e-9, t = (s - ax.cum[lo]) / L;
  const ex = (P[2 * hi] - P[2 * lo]) / L, ez = (P[2 * hi + 1] - P[2 * lo + 1]) / L;
  return { x: P[2 * lo] + (P[2 * hi] - P[2 * lo]) * t, z: P[2 * lo + 1] + (P[2 * hi + 1] - P[2 * lo + 1]) * t, tx: ex, tz: ez };
}

/**
 * The corridor of `w` among `cands` (in-scope ways near it, any order): the
 * component reached from w by series and parallel links whose plan comes
 * within `latMax` of the axis. Sorted by id, so the answer is one set
 * whatever order the candidates arrived in.
 */
export function membersOf(w, cands, ends, ax, latMax) {
  const fam = isRail(w) ? 'rail' : 'road';
  const pool = cands.filter((c) => (isRail(c) ? 'rail' : 'road') === fam).sort((a, b) => a._id - b._id);
  const axBB = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < ax.pts.length; i += 2) {
    if (ax.pts[i] < axBB[0]) axBB[0] = ax.pts[i]; if (ax.pts[i] > axBB[2]) axBB[2] = ax.pts[i];
    if (ax.pts[i + 1] < axBB[1]) axBB[1] = ax.pts[i + 1]; if (ax.pts[i + 1] > axBB[3]) axBB[3] = ax.pts[i + 1];
  }
  const near = (c) => {
    if (!bbNear(geomOf(c).bb, axBB, latMax)) return false;
    // at least one vertex or the midpoint within latMax of the axis, inside its run
    const g = geomOf(c);
    for (const s of [0, g.L * 0.25, g.L * 0.5, g.L * 0.75, g.L]) {
      const P = pointOn(c, s), q = projectAxis(ax, P.x, P.z);
      if (Math.abs(q.d) <= latMax && q.s > 0 && q.s < ax.L) return true;
    }
    return false;
  };
  const out = new Set([w]);
  const stack = [w];
  while (stack.length) {
    const a = stack.pop();
    // series neighbours
    for (const e of [0, 1]) {
      const nx = seriesNext(ends, a, e);
      if (nx && !out.has(nx.w) && near(nx.w)) { out.add(nx.w); stack.push(nx.w); }
    }
    // parallel neighbours
    const ga = geomOf(a);
    for (const c of pool) {
      if (out.has(c) || !bbNear(ga.bb, geomOf(c).bb, PAIR_ROAD)) continue;
      if (!parallel(a, c) || !near(c)) continue;
      out.add(c); stack.push(c);
    }
  }
  return [...out].sort((a, b) => a._id - b._id);
}
