// ---- lanes.js: where the lanes of a motorway are, for the paint and the cars alike ----
// Pure, no imports, and laneLayout allocates nothing per query (shared
// records): worker safe (the mesher reads it in js/meshes.js on both threads)
// and node importable (js/traffic.js and the tests read it). The road markings and the
// AI traffic both take their lane positions from HERE, so a car drives in the
// lane that is painted, and neither may hard-code its own numbers.
//
// THE CONTRACT
//   laneLayout(road) -> null for every class but 'motorway' and
//     'motorway_link' (nothing else changes), else a shared frozen record
//     { n, width, widths, centers, dividers, edgeL, edgeR, shoulder, ribbonHalf }
//     in metres ACROSS the way from its OSM centreline, + to the RIGHT of the
//     direction of travel (x right = (-dz, dx) for a unit heading (dx, dz)):
//       centers   lane centres, left to right (lane 0 is the overtaking lane)
//       widths    each lane's width between line centres; width = widths[0]
//       dividers  the line centres between neighbouring lanes (n - 1 of them)
//       edgeL/R   the centre of the solid edge line on each side (V 4, 0.25 m)
//       shoulder  { from, to } the paved hard shoulder on the right, edge line
//                 included, or null (no room: 2-lane links, 3-lane pieces,
//                 under 1 m of asphalt left)
//       ribbonHalf  half the DRAWN asphalt (road.w after geo.js pave())
//   auxRight(road, endsAt) -> null, or the auxiliary lane of a 3-lane piece
//     (acceleration / deceleration lane beside a slip road); auxShare(aux, s)
//     says how much of that lane exists s metres along the way (0..1, the
//     taper). endsIndex(roads) builds the endsAt lookup from a road list.
//
// MEASURED ON THE TILES (public/data/tiles, both D11 carriageways chained by
// their shared end points from the D0 at Horní Počernice to the world's edge
// past Plotiště, 105.2 km eastbound, 104.1 km westbound, sampled every 25 m):
//   · the opposite carriageway is ALWAYS on the left (8317 of 8317 samples);
//     its centreline is p05 11.84 / p25 12.21 / p50 12.44 / p75 12.79 m away;
//     outside the Prague end 95 % of samples lie within 11.8 to 13.4 m; the
//     Prague 6-lane end (km 0 to 8) and the Hradec end past km 100 run at
//     17 to 20 m. On bridges p50 12.5 m. So the median's middle is about
//     6.2 m left of each centreline (MEDIAN_HALF).
//   · w is 11 on every piece (geo.js pave() draws 12.5 m: ribbonHalf 6.25);
//     ln 2 on 93.8 km E / 95.2 km W, ln 3 on 10.7 / 9.0 km, ln 4 0.26 km,
//     ln 1 0.41 km (both in the D0 knot and at the Plotiště fork).
//   · ln 3 comes in RUNS of one to three ways. 69 runs; every one but two is
//     next to a slip road: 33 start where a link (or the service road out of
//     a rest area) ENDS (an acceleration lane, 139 to 449 m, median 283 m),
//     31 end where one STARTS (a deceleration lane, 106 to 382 m, median
//     208 m), three have both (weaving lanes between two ramps, 142 to
//     418 m). The exceptions: the real third lane out of Prague (E km 6.1 to
//     8.8, 2738 m, which drops into exit 8 Jirny) and one 174 m piece at the
//     Sedlice junction with nothing at either end.
//   · the OSM line of a 3-lane piece does NOT move sideways: it continues the
//     2-lane line it joins. So the through lanes keep their place and the
//     third lane is added on the right, in the hard shoulder's band.
//
// THE CHOICE: the Czech D 27.5 cross section mapped onto that geometry.
// The OSM line is the middle of the two running lanes (that is what the
// 12.44 m spacing says: 2 x (3.75 + 2.25) plus a barrier, against 14.5 m had
// it been the middle of lanes plus shoulder). Then, from the left:
//   median barrier at about -6.22 (the midpoint, drawn by the look package
//   from the partner's real distance), an inner strip of 2.22 m, the inner
//   edge line -4.0..-3.75 (centre -3.875), two 3.75 m lanes -3.75..0..3.75
//   with the lane line on the centreline, the right edge line 3.75..4.0
//   (centre 3.875), and the hard shoulder 3.75..6.25 (2.5 m with its line),
//   which ends exactly at the drawn ribbon's edge. All of it inside the
//   ribbon; nothing reads f.w differently.
// A 3-lane piece keeps lanes 0 and 1 where they are, the old right edge line
// becomes the divider (3.875) and the third lane fills the shoulder band to
// a new edge line at 6.125. That lane is 2.25 m between line centres, 1 m
// narrower than a real acceleration lane: the real one is wider than the
// carriageway the tiles draw, and widening the asphalt is a change of f.w
// (or an extra strip the look package draws), not a change of lanes.
// Real Czech dimensions from ČSN 73 6101 as the round 8 brief gives them
// (lane 3.75, shoulder 2.5, edge line 0.25); TAPER is not confirmed by a
// standard (the search found no text of ČSN 73 6102): 60 m, flagged.

export const LANE_W = 3.75;        // m, a motorway running lane (D 27.5)
export const LINE_W = 0.25;        // m, a motorway edge or lane line
export const SHOULDER_W = 2.5;     // m, hard shoulder, its edge line included
export const MEDIAN_HALF = 6.22;   // m, measured p50 half spacing of the D11 carriageways
export const LINK_LANE_W = 3.5;    // m, a single-lane slip road's lane
// ACC_LEN / DEC_LEN are for a caller that knows a merge or a diverge but no
// 3-lane run (a slip road joining a 2-lane piece): the D11's own medians.
export const ACC_LEN = 283;        // m, measured median acceleration run (lane + taper)
export const DEC_LEN = 208;        // m, measured median deceleration run (taper + lane)
export const TAPER = 60;           // m, where an auxiliary lane narrows to nothing (UNVERIFIED)
export const AUX_MAX = 500;        // m, a longer 3-lane run is a real third lane, not an aux lane
export const AUX_MIN_W = 2;        // m, a narrower band beside the through lanes holds no lane

// geo.js PAVED_EXTRA for these two classes (not imported: geo.js is heavy).
// A road that has been through pave() carries _paved; a raw tile record not.
const PAVED = { motorway: 1.5, motorway_link: 1.0 };
const H = LANE_W / 2, HL = LINE_W / 2;

/**
 * The lane layout of a motorway carriageway or slip road, or null for any
 * other class. Pure function of road.t, road.w, road.ln, road.ow, road._paved.
 * The record is shared and frozen: read it, never write into it.
 */
export function laneLayout(road) {
  const t = road?.t;
  if (t !== 'motorway' && t !== 'motorway_link') return null;
  const w = (road.w > 0 ? road.w : t === 'motorway' ? 11 : 5.5) + (road._paved ? 0 : PAVED[t]);
  const ln = road.ln > 0 ? Math.min(15, Math.round(road.ln)) : t === 'motorway' ? 2 : 1;
  // a handful of distinct layouts exist world-wide: one shared frozen record
  // each, so the per-car and per-chunk callers allocate nothing
  const key = ((((t === 'motorway' ? 1 : 2) * 16 + ln) * 2 + (road.ow ? 1 : 0)) * 4096) + Math.round(w * 20);
  let l = _memo.get(key);
  if (!l) _memo.set(key, l = deepFreeze(build(t, w / 2, ln, !!road.ow)));
  return l;
}
const _memo = new Map();
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') Object.freeze(v);
  return Object.freeze(o);
}

function build(t, half, ln, ow) {
  if (!ow) return twoWay(t, ln, half);
  if (t === 'motorway_link') {
    if (ln >= 2) {
      // two lanes fill the ribbon: 3.0 m each, edge lines on its rim
      const lw = Math.min(LANE_W, half - LINE_W);
      return mk(2, [lw, lw], [-lw / 2, lw / 2], [0], -(lw + HL), lw + HL, null, half);
    }
    const e = LINK_LANE_W / 2;
    return mk(1, [LINK_LANE_W], [0], [], -(e + HL), e + HL,
      half > e + LINE_W ? { from: e, to: half } : null, half);
  }
  // A carriageway narrower than the D 27.5 (the D35's Labe viaducts by
  // Opatovice are w 8, a few far ones w 6) keeps its lanes on the line but
  // narrows them so the edge lines stay on the asphalt.
  if (ln === 1) {
    // (the D0 knot only) one lane on the line, the rest is shoulder
    const e = Math.min(H, half - LINE_W);
    return mk(1, [2 * e], [0], [], -(e + HL), e + HL, shoulderOf(e, half), half);
  }
  const lw = Math.min(LANE_W, half - LINE_W);
  const d2 = lw + HL, eR = half - HL, w3 = eR - d2;
  // 3 lanes or more (ln 4 is 262 m at the Plotiště fork): the two through
  // lanes stay put, one more lane takes the shoulder band. A 4th has no room,
  // and neither has a third where the band is narrower than AUX_MIN_W (the
  // w 8 piece on the D35 Labe viaduct would get a 0.75 m lane): that piece
  // is drawn and driven as two lanes, and auxRight agrees (null).
  if (ln >= 3 && w3 >= AUX_MIN_W) {
    return mk(3, [lw, lw, w3], [-lw / 2, lw / 2, d2 + w3 / 2], [0, d2], -(lw + HL), eR, null, half);
  }
  return mk(2, [lw, lw], [-lw / 2, lw / 2], [0], -(lw + HL), lw + HL, shoulderOf(lw, half), half);
}
// the hard shoulder right of the last lane, or null where less than a metre
// of asphalt is left (no car stops on a strip narrower than that)
const shoulderOf = (from, half) => (half - from >= 1 ? { from, to: half } : null);

// A motorway mapped as ONE two-way way (a handful in the Prague box): the
// centres are the FORWARD direction's lanes, right of the line; the reverse
// direction mirrors them (negate). No shoulder.
function twoWay(t, ln, half) {
  const n = Math.max(1, Math.round(ln / 2));
  const lw = Math.min(t === 'motorway' ? LANE_W : LINK_LANE_W, (half - LINE_W) / n);
  const centers = [], widths = [], dividers = [];
  for (let k = 0; k < n; k++) { centers.push(lw * (k + 0.5)); widths.push(lw); if (k) dividers.push(lw * k); }
  return mk(n, widths, centers, dividers, -(n * lw + HL), n * lw + HL, null, half);
}

function mk(n, widths, centers, dividers, edgeL, edgeR, shoulder, ribbonHalf) {
  return { n, width: widths[0], widths, centers, dividers, edgeL, edgeR, shoulder, ribbonHalf };
}

// ---- auxiliary lanes ------------------------------------------------------------
const KEY = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);   // the decimetre every graph welds at
const lenOf = (r) => {
  if (r._len > 0) return r._len;
  let s = 0;
  for (let i = 1; i < r.p.length; i++) s += Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
  return s;
};
// (laneLayout decides: a 3-lane way too narrow for its third lane has none)
const wide = (r) => r && r.t === 'motorway' && r.ow && r.ln >= 3 && r.p?.length > 1 && laneLayout(r).n >= 3;
const first = (r) => r.p[0], last = (r) => r.p[r.p.length - 1];
const at = (q, k) => KEY(q[0], q[1]) === k;
// a slip road (or a rest area's service road) arriving at / leaving from node k
const arm = (r) => r.t !== 'motorway' && r.d !== 0 && r.p?.length > 1;
const merges = (list, k) => list.some((r) => arm(r) && (at(last(r), k) || !r.ow));
const diverges = (list, k) => list.some((r) => arm(r) && (at(first(r), k) || !r.ow));

/**
 * endsAt for auxRight: every road of `roads` with a first or last vertex at
 * (x, z), to the decimetre. Order of `roads` does not matter.
 */
export function endsIndex(roads) {
  const m = new Map();
  const put = (q, r) => { const k = KEY(q[0], q[1]); const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); };
  for (const r of roads) if (r?.p?.length > 1) { put(first(r), r); put(last(r), r); }
  return (x, z) => m.get(KEY(x, z)) ?? [];
}

// the one 3-lane motorway continuing the run through node k: arriving there
// (dir -1) or leaving it (dir +1). Several (never seen on the D11) resolve by
// geometry, so the answer does not depend on the order endsAt lists them.
function step(list, k, self, dir) {
  let best = null;
  for (const r of list) {
    if (r === self || !wide(r) || !at(dir > 0 ? first(r) : last(r), k)) continue;
    if (!best || KEY(...(dir > 0 ? last(r) : first(r))) < KEY(...(dir > 0 ? last(best) : first(best)))) best = r;
  }
  return best;
}

/**
 * Is the rightmost lane of this 3-lane motorway way an AUXILIARY lane, and
 * how does it run? `endsAt(x, z)` lists the roads with an end at a node
 * (endsIndex builds one; the traffic graph has its own). Walks the run of
 * contiguous ln >= 3 pieces through endsAt, then looks at its two end nodes:
 *   'acc'    a slip road ENDS at the run's first node: full lane from there,
 *            TAPER m of taper at the run's end (a merge);
 *   'dec'    one STARTS at the run's last node: TAPER m of taper at the
 *            run's start, full lane to the diverge;
 *   'weave'  both: full lane all along;
 *   'aux'    neither is known (the slip road's tile may not be loaded yet,
 *            or a rest area): taper at both ends. A FALLBACK, it becomes
 *            'acc'/'dec' once the other road is in endsAt.
 * null: not a 3-lane motorway, or a run longer than AUX_MAX (a real lane).
 * Returns { kind, run (m), at (m of the run before this way), len (this
 * way's m), taper (m) }. A pure function of the roads endsAt knows; for
 * co-op determinism a caller must ask it with the same roads loaded.
 */
export function auxRight(road, endsAt) {
  if (!wide(road)) return null;
  let before = 0, head = road, n = 0;
  for (let r = road; n < 32; n++) {
    const k = KEY(...first(r));
    const p = step(endsAt(first(r)[0], first(r)[1]), k, r, -1);
    if (!p || p === road) break;
    before += lenOf(p); head = p; r = p;
    if (before > AUX_MAX) return null;
  }
  let after = 0, tail = road;
  for (let r = road, m = 0; m < 32; m++) {
    const k = KEY(...last(r));
    const q = step(endsAt(last(r)[0], last(r)[1]), k, r, +1);
    if (!q || q === road) break;
    after += lenOf(q); tail = q; r = q;
    if (before + after > AUX_MAX) return null;
  }
  const len = lenOf(road), run = before + len + after;
  if (run > AUX_MAX) return null;
  const k0 = KEY(...first(head)), k1 = KEY(...last(tail));
  const mer = merges(endsAt(first(head)[0], first(head)[1]), k0);
  const div = diverges(endsAt(last(tail)[0], last(tail)[1]), k1);
  const kind = mer && div ? 'weave' : mer ? 'acc' : div ? 'dec' : 'aux';
  return { kind, run, at: before, len, taper: Math.min(TAPER, run / 3) };
}

/** How much of the auxiliary lane exists s m along the way: 1 full, 0 none. */
export function auxShare(aux, s) {
  if (!aux) return 0;
  const u = aux.at + Math.max(0, Math.min(aux.len, s)), T = aux.taper;
  const tin = aux.kind === 'dec' || aux.kind === 'aux' ? Math.min(1, u / T) : 1;
  const tout = aux.kind === 'acc' || aux.kind === 'aux' ? Math.min(1, (aux.run - u) / T) : 1;
  return Math.max(0, Math.min(tin, tout));
}
