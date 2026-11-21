// ---- do two clients see the same cars? ------------------------------------
// The measuring stick behind "every player must see what the other one sees"
// (Frank, 21 Nov 2026). Pure: two lists of what each client DRAWS around the
// same point at the same shared instant go in, the agreement comes out as
// numbers. dev/coopprobe.js takes the lists in a running tab; the tests feed
// it two headless Traffic instances over one map.
//
// A car is { key, kind, color, x, z, h, ghost }. `key` is the identity the
// shared world gives it (a traffic slot and its generation, a parking stall);
// a car with none is matched by place alone.

/** Smallest absolute difference of two headings, radians. */
export function headingGap(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

const d2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);

/**
 * Pair the cars of client A with the cars of client B.
 *   same     a car both draw, same identity (or none on either side), within `tol` m
 *   moved    the same identity on both, but further apart than `tol`
 *   onlyA/B  drawn by one client and by nobody else within `tol`
 * `sameLook` of the `same` pairs also agree on kind and colour.
 * A car counts once: identity first, then nearest free neighbour.
 */
export function diffCars(A, B, tol = 2) {
  const tol2 = tol * tol;
  const freeB = new Set(B);
  const byKey = new Map();
  for (const b of B) if (b.key != null) byKey.set(b.key, b);
  const out = { a: A.length, b: B.length, same: 0, sameLook: 0, moved: 0, onlyA: [], onlyB: [],
    movedBy: [], pairs: [] };
  const left = [];
  for (const a of A) {
    const b = a.key != null ? byKey.get(a.key) : null;
    if (!b || !freeB.has(b)) { left.push(a); continue; }
    freeB.delete(b);
    const d = Math.sqrt(d2(a, b));
    if (d <= tol) { out.same++; if (a.kind === b.kind && a.color === b.color) out.sameLook++; }
    else { out.moved++; out.movedBy.push(Math.round(d * 10) / 10); }
    out.pairs.push({ key: a.key, d, dh: headingGap(a.h ?? 0, b.h ?? 0) });
  }
  // what identity could not pair: the nearest free car within the tolerance,
  // closest pairs first so one stray cannot steal another's partner
  const cand = [];
  for (const a of left) for (const b of freeB) {
    const q = d2(a, b);
    if (q <= tol2) cand.push([q, a, b]);
  }
  cand.sort((p, q) => p[0] - q[0]);
  const usedA = new Set();
  for (const [q, a, b] of cand) {
    if (usedA.has(a) || !freeB.has(b)) continue;
    usedA.add(a); freeB.delete(b);
    out.same++;
    if (a.kind === b.kind && a.color === b.color) out.sameLook++;
    out.pairs.push({ key: a.key ?? b.key ?? null, d: Math.sqrt(q), dh: headingGap(a.h ?? 0, b.h ?? 0) });
  }
  for (const a of left) if (!usedA.has(a)) out.onlyA.push(a);
  for (const b of freeB) out.onlyB.push(b);
  const all = out.same + out.moved + out.onlyA.length + out.onlyB.length;
  // the one number: of every car either client draws, the share both draw in the same place
  out.agree = all ? out.same / all : 1;
  return out;
}

/** Why a car is on one screen only, as counts: { ghost, shared, local }. */
export function whyAlone(list) {
  const why = { ghost: 0, shared: 0, local: 0 };
  for (const c of list) {
    if (c.ghost) why.ghost++;
    else if (c.key != null) why.shared++;
    else why.local++;
  }
  return why;
}
