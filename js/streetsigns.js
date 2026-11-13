// ---- streetsigns.js: the signs a street has that nobody surveyed -------------
// OSM in this region carries the give-way and stop signs as nodes (77 in the
// Pardubice tile) and nothing else, so a street had two kinds of sign and long
// stretches with none. Everything else a Czech street is signed with FOLLOWS
// from data the tiles already hold, and that is what this derives:
//
//   one way / no entry   from a way's oneway flag: IP 4a where you turn in,
//                        B 2 facing whoever would turn in at the wrong end
//   speed                from maxspeed where it is not the built-up 50
//   give way / stop      where js/streets.js worked out that an approach
//                        yields (it paints the triangles) and no sign node
//                        stands there already
//   main road            on the approaches those give way TO
//   roundabout           give way over C 1 on every arm that enters a ring
//
// Pure data: a list of posts, each [x, z, dx, dz, face, face?]. (x, z) is the
// post, already on the right-hand kerb of the travel direction (dx, dz) it
// speaks to; the plate faces against that travel. The mesher (meshes.signInto)
// stands it on the pavement and draws it. Deterministic in the tiles alone.
// Worker-safe.

const SIGN_OUT = 0.75;        // post, this far outside the carriageway edge
const QUIET = new Set(['residential', 'unclassified', 'living_street']);
const SPEED_T = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
const SPEED_FACE = { 30: 'speed30', 70: 'speed70', 90: 'speed90' };
const MAIN_RANK = new Set(['primary', 'secondary', 'tertiary']);

const _a = { x: 0, z: 0, dx: 1, dz: 0 };
/** Point and unit direction at arclength s of a way's polyline (a shared object). */
function alongAt(p, s) {
  let run = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const ex = p[i + 1][0] - p[i][0], ez = p[i + 1][1] - p[i][1], L = Math.hypot(ex, ez);
    if (L < 1e-6) continue;
    if (run + L >= s || i === p.length - 2) {
      const t = Math.max(0, Math.min(1, (s - run) / L));
      _a.x = p[i][0] + ex * t; _a.z = p[i][1] + ez * t; _a.dx = ex / L; _a.dz = ez / L;
      return _a;
    }
    run += L;
  }
  _a.x = p[0][0]; _a.z = p[0][1]; _a.dx = 1; _a.dz = 0;
  return _a;
}

/**
 * @param cell     the chunk's cell (roads, signs)
 * @param key      its key. A sign along a way belongs to the cell its POST
 *                 stands in (every cell the way passes through walks it the
 *                 same way, so they agree), because only that cell knows the
 *                 other carriageways and the pavement around the post.
 * @param nodes    geo.junctionsIn(key): this chunk's junction nodes
 * @param blocked  (x, z, way) => true when that spot is on some OTHER carriageway
 * @param chunkOf  (x, z) => chunk key
 */
export function plannedSigns(cell, key, nodes, blocked, chunkOf) {
  const out = [];
  let mine = false;         // junction signs are the node's cell's, wherever the post lands
  // right of travel (dx, dz) is (-dz, dx): the kerb a Czech sign stands on
  const put = (x, z, dx, dz, hw, r, a, b) => {
    const px = x - dz * (hw + SIGN_OUT), pz = z + dx * (hw + SIGN_OUT);
    if (!mine && chunkOf(px, pz) !== key) return;
    if (blocked(px, pz, r)) return;
    out.push(b ? [px, pz, dx, dz, a, b] : [px, pz, dx, dz, a]);
  };
  for (const r of cell.roads ?? []) {
    if (!r.d || r.rb || r.br || !r.p || r.p.length < 2) continue;
    const len = r._len ?? 0, hw = (r.w ?? 5) / 2;
    if (r.ow && QUIET.has(r.t) && len >= 40 && hw >= 2) {
      let q = alongAt(r.p, 5);
      put(q.x, q.z, q.dx, q.dz, hw, r, 'one_way');
      q = alongAt(r.p, len - 4);
      put(q.x, q.z, -q.dx, -q.dz, hw, r, 'no_entry');
    }
    const face = r.t === 'residential' && r.v === 30 ? 'zone30' : SPEED_FACE[r.v];
    // (one in two residential ways says its zone: OSM cuts a street at every
    // corner, and a plate on every piece is a forest of them)
    if (face && SPEED_T.has(r.t) && len >= 110 && (face !== 'zone30' || r._id % 2 === 0)) {
      let q = alongAt(r.p, 12);
      put(q.x, q.z, q.dx, q.dz, hw, r, face);
      if (!r.ow) { q = alongAt(r.p, len - 12); put(q.x, q.z, -q.dx, -q.dz, hw, r, face); }
    }
  }
  mine = true;
  const signed = (x, z) => {
    for (const sg of cell.signs ?? []) {
      if ((sg.p[0][0] - x) ** 2 + (sg.p[0][1] - z) ** 2 < 15 * 15) return true;
    }
    return false;
  };
  for (const j of nodes ?? []) {
    if (j._cluster) continue;
    if (j._ring && !j.members) {
      // an arm that ENTERS a roundabout: give way, and the ring sign under it
      for (const a of j.arms ?? []) {
        const r = a.r;
        if (!r?.d || r.rb || !a.end || !r.p || r.p.length < 2 || (r.w ?? 0) < 4) continue;
        if (r.ow && a.i === 0) continue;                 // it leaves the ring here
        const n = r.p.length, q0 = r.p[a.i], q1 = r.p[a.i === 0 ? 1 : n - 2];
        const L = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
        if (L < 1) continue;
        const ux = (q1[0] - q0[0]) / L, uz = (q1[1] - q0[1]) / L;
        const back = Math.min(6, (r._len ?? 12) * 0.4);
        put(j.x + ux * back, j.z + uz * back, -ux, -uz, (r.w ?? 5) / 2, r, 'give_way', 'roundabout');
      }
      continue;
    }
    const legs = j._legs;
    if (!legs || j.members) continue;
    let yields = false;
    for (const lg of legs) if (lg.ctl === 'give' || lg.ctl === 'stop') yields = true;
    if (!yields) continue;
    for (const lg of legs) {
      const r = lg.r;
      if (!r?.d || (r.ow && lg.dir > 0)) continue;       // nobody arrives along this leg
      const m = lg.m ?? lg.pad ?? 4;
      if (lg.ctl === 'give' || lg.ctl === 'stop') {
        const x = lg.nx + lg.ux * (m + 1.4), z = lg.nz + lg.uz * (m + 1.4);
        if (!signed(x, z)) put(x, z, -lg.ux, -lg.uz, lg.hw, r, lg.ctl === 'stop' ? 'stop' : 'give_way');
      } else if (!lg.ctl && MAIN_RANK.has(r.t) && (lg.avail ?? 40) > m + 24) {
        // WALKED ALONG THE WAY, not projected along the leg's tangent at the
        // node: ten metres past the mouth a curving approach has left that
        // straight line, and the kerb offset from it landed the post in the
        // lane of its own road (4 m inside a tertiary at 1750.6,-3767.2), where
        // blocked() cannot see it because it skips the sign's own way.
        const q = alongAt(r.p, lg.s + lg.dir * (m + 10));
        put(q.x, q.z, -q.dx * lg.dir, -q.dz * lg.dir, lg.hw, r, 'main_road');
      }
    }
  }
  return out;
}

/**
 * The two IP 6 plates of one zebra: one before it on each approach's right
 * kerb. (x, z) is the crossing, (ux, uz) the road's direction there.
 */
export function crossingSigns(x, z, ux, uz, road, blocked, out) {
  const hw = (road.w ?? 6) / 2;
  for (const s of road.ow ? [1] : [1, -1]) {
    const dx = ux * s, dz = uz * s;
    const cx = x - dx * 2.6, cz = z - dz * 2.6;          // short of the bars
    const px = cx - dz * (hw + SIGN_OUT), pz = cz + dx * (hw + SIGN_OUT);
    if (blocked(px, pz, road)) continue;
    out.push([px, pz, dx, dz, 'crossing']);
  }
}
