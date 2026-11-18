// ---- underpass.js: where a street goes UNDER, and where a deck meets a tile edge ----
// MAIN THREAD (geo.js indexes with it; the mesher worker only ever reads the
// profiles it produces, which travel as `_prof`).
//
// Two things the per-tile indexing in geo.js could not see, because each needs
// ways of two tiles at once:
//
// 1. A BRIDGE END ON A TILE EDGE. OSM ways are filed whole in one tile, so a
//    deck in one and the road it lands on in the next never met at a junction:
//    the deck found no approach (it ramped down to the survey under its own end,
//    2.6 m below the road that really continues, by the ring road at x -589),
//    and the road was never banked up to it. stitch() finds the way that shares
//    the end vertex in the chunk index, whatever tile it came from, and joins
//    the two exactly as indexJunctions would have: the approach link the deck
//    reads, and a two-arm junction node so the bank is pinned onto it.
//    Rail bridges get the same link: their deck used to sit on the survey at
//    its two ends rather than on the railway's own bed.
//
// 2. AN UNDERPASS. geo.bridgeClearance makes a bridge RISE until what it
//    crosses fits under it. That is right for a road flying over a railway and
//    wrong for the commonest crossing in a Czech town, a street dipping under
//    the railway in a cutting: Třída 17. listopadu and Jana Palacha under the
//    tracks east of the station (x 1020, z -30 to 30) humped the railway and
//    Hlaváčova into the air instead. So a crossing is an underpass when what
//    passes over is a RAILWAY (a railway does not climb for a street), or when
//    the way underneath is mapped below ground level (layer < 0), or leads into
//    one within UNDER_NEAR metres. Then the bridge keeps its level and the
//    street goes down: one grade line along its whole run of ways (a "dip
//    chain", built here), flat under the structure and rising out of it at
//    dipchain.DIP_GRADE through sag and crest curves of the street's own design radius.
//    geo.levelWay lays it over the levelled way; the earthworks then dig the
//    ground to the street, as they do for any road.

import { CHUNK } from './config.js';
import { polylineLength, roadGradeY } from './geo.js';
import { indexPortalApproach } from './railportal.js';
import { rebuildChains } from './dipchain.js';

const KEY = (x, z) => Math.round(x * 50) + ',' + Math.round(z * 50);
const UNDER_NEAR = 45;      // m from a crossing to a way mapped underground that makes it an underpass
const CLEAR_ROAD = 4.5, CLEAR_FOOT = 2.6;   // geo.js's headroom, the same numbers
const DECK_DEPTH = { rail: 1.3, road: 1.0 };   // structure under the running surface
const FOOT = new Set(['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'track']);
const SLIP = /_link$/;      // motorway_link, secondary_link...: a slip road

function cellsOf(f, pad, out = new Set()) {
  for (let i = 0; i < f.p.length - 1; i++) {
    const [ax, az] = f.p[i], [bx, bz] = f.p[i + 1];
    for (let cx = Math.floor((Math.min(ax, bx) - pad) / CHUNK); cx <= Math.floor((Math.max(ax, bx) + pad) / CHUNK); cx++)
      for (let cz = Math.floor((Math.min(az, bz) - pad) / CHUNK); cz <= Math.floor((Math.max(az, bz) + pad) / CHUNK); cz++)
        out.add(cx + ',' + cz);
  }
  return out;
}
const _cells = new Set();
// The decks among a cell's ways, remembered until its lists grow (a town
// cell holds hundreds of ways and a deck or two; every way of an arriving
// tile asks about the cells its ends lie in). Kept beside the cell, not on
// it: chunkspec reads every field of a cell as a feature list.
const _decks = new WeakMap();
function decksIn(c) {
  const n = c.roads.length * 4096 + c.rails.length;
  const hit = _decks.get(c);
  if (hit && hit.n === n) return hit;
  const d = { n, roads: [], rails: [] };
  for (const b of c.roads) if (b.br && b.p?.length > 1) d.roads.push(b);
  for (const b of c.rails) if (b.br && b.p?.length > 1) d.rails.push(b);
  _decks.set(c, d);
  return d;
}
// deck -> [way, at, ...]: the abutments linkEnd pushed onto another way's
// `_abut`. That list is plain numbers (it travels to the mesh workers), so
// where each came from is remembered here, beside it.
const _abutBy = new WeakMap();
const cellAt = (city, x, z) => city.chunkIndex.get(Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK));
const lenOf = (r) => r._len ?? (r._len = polylineLength(r.p));

/** Arclength of vertex k along a way. */
function arcTo(r, k) {
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.hypot(r.p[i + 1][0] - r.p[i][0], r.p[i + 1][1] - r.p[i][1]);
  return s;
}

function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return { t, u, sin: Math.abs(den) / (Math.hypot(rx, rz) * Math.hypot(sx, sz)) };
}

/**
 * Where decks meet decks and no road (a Y of three spans on Generála
 * Svobody, the mid-river joints of Jiráskův and Hlávkův most), the end of each
 * holds ONE level, the same for every member meeting there: the road
 * approaches of the whole structure, each weighted by how far along the decks
 * it lies (inverse distance, so on a run between two banks the joints fall
 * on the straight grade from one to the other). Null where there is no such
 * node. The far links are found once, at indexing (deckNodes), and kept on
 * the deck as plain data, so the mesher worker answers the same.
 *
 * (It used to be the HIGHEST approach reachable without crossing the member
 * itself. On a run of short members that is the approaches behind each end,
 * different at its two ends: every member of Hlávkův most's north arm ramped
 * the whole 3.4 m from Štvanice to Holešovice on its own 15 to 55 m, and the
 * deck was a saw, 21 steps over 12 %.)
 */
export function deckNodeLevel(w, end, terrain) {
  const links = end === 0 ? w._apN0 : w._apN1;
  if (!links) return null;
  let near = null, sw = 0, sy = 0;
  for (const l of links) {
    const y = roadGradeY(l.road, l.at, terrain);
    if (y === null || y === undefined) continue;
    const d = l.d ?? 0;
    // an approach AT the node (on another member's end) is the level
    if (d < 1) { if (near === null || y > near) near = y; continue; }
    sw += 1 / d; sy += y / d;
  }
  return near !== null ? near : sw > 0 ? sy / sw : null;
}
function deckNodes(city, w) {
  // (from scratch every time: a structure that grew since is measured whole;
  // a lone deck's own chain, made when its profile was first asked for, is
  // made again from what is known now)
  delete w._apN0; delete w._apN1;
  if (w._chain && w._chain.members.length === 1 && w._chain.members[0] === w) {
    delete w._chain; delete w._chainOff; delete w._chainRev;
  }
  for (const end of [0, 1]) {
    if (end === 0 ? w._ap0 : w._ap1) continue;
    const [x, z] = w.p[end === 0 ? 0 : w.p.length - 1];
    const c = cellAt(city, x, z);
    if (!c) continue;
    const k0 = KEY(x, z);
    let n = 0, main = false;
    for (const o of c.roads) {
      // (a drivable deck counts and holds drivable decks only, as it always
      // did; a footway deck counts every deck it meets)
      if (!o.br || (w.d && !o.d) || !o.p || o.p.length < 2) continue;
      const last = o.p.length - 1;
      if (KEY(o.p[0][0], o.p[0][1]) === k0 || KEY(o.p[last][0], o.p[last][1]) === k0) {
        n++;
        if (!SLIP.test(o.t)) main = true;
      }
    }
    if (n < 2) continue;
    // A MID-RIVER JOINT: the branched complexes (Jiráskův and Hlávkův most)
    // are pieced from members joined out over the water, and the members next
    // to a joint often reach no road themselves. Falling back to the ground
    // at the end read the riverbed and the deck dipped under the Vltava. So
    // walk the whole structure from this node and weigh every approach it has
    // by its distance along the decks.
    // Where a main carriageway meets the joint, the slip roads' landings do
    // not count: a slip ramp follows the bridge down to the embankment
    // (Hlávkův most's to nábřeží Kapitána Jaroše lands 6 m below the deck),
    // the bridge does not follow it. The node is the same for every member
    // meeting there, so the slip deck's end agrees with the main ones.
    let links = complexLinks(city, w, k0, x, z);
    if (main) {
      const kept = links.filter((l) => !SLIP.test(l.road.t));
      if (kept.length) links = kept;
    }
    if (links.length) w[end === 0 ? '_apN0' : '_apN1'] = links;
  }
  w._bridgeProfile = null;
  if (w._chain) w._chain.profile = null;
}

// The road approaches of every bridge member reachable from node (x, z) by
// walking members that share end nodes, each with its distance along the
// decks from the node (shortest path). A drivable deck walks drivable members
// and counts approaches that are roads you can drive (the stairs down to an
// island are not where the carriageway goes); a footway deck walks every deck.
// Bounded: a complex is a few dozen members at most.
function complexLinks(city, w, k0, x, z) {
  const drive = !!w.d;
  const dist = new Map([[k0, 0]]), at = new Map([[k0, [x, z]]]), done = new Set();
  const best = new Map();                 // link -> shortest distance to it
  const take = (l, d) => {
    if (!l || typeof l !== 'object' || (drive && !l.road?.d)) return;
    const o = best.get(l);
    if (o === undefined || d < o) best.set(l, d);
  };
  let members = 0;
  while (members < 64) {
    // the nearest node not yet expanded (a complex is small: a scan will do)
    let k = null, dk = Infinity;
    for (const [kk, dd] of dist) if (!done.has(kk) && (dd < dk || (dd === dk && kk < k))) { k = kk; dk = dd; }
    if (k === null) break;
    done.add(k);
    const [nx, nz] = at.get(k);
    const c = cellAt(city, nx, nz);
    if (!c) continue;
    for (const o of c.roads) {
      if (!o.br || !o.p || o.p.length < 2 || (drive && !o.d)) continue;
      const last = o.p.length - 1;
      const at0 = KEY(o.p[0][0], o.p[0][1]) === k, at1 = !at0 && KEY(o.p[last][0], o.p[last][1]) === k;
      if (!at0 && !at1) continue;
      members++;
      const L = lenOf(o);
      take(at0 ? o._ap0 : o._ap1, dk);                    // its end here
      take(at0 ? o._ap1 : o._ap0, dk + L);                // and its far end
      const fe = at0 ? o.p[last] : o.p[0], fk = KEY(fe[0], fe[1]);
      if (!done.has(fk) && !(dist.get(fk) <= dk + L)) { dist.set(fk, dk + L); at.set(fk, fe); }
    }
  }
  // A FOOTBRIDGE holds its highest approach at every joint, as before: its
  // members are level decks on stairs (geo.bridgeDeckHeight), and a joint on
  // a weighted grade below them put a flight of stairs into the middle of
  // Štvanická lávka. (d 0: every approach counts as at the node.)
  const out = [];
  for (const [l, d] of best) out.push({ road: l.road, at: l.at, d: drive ? d : 0 });
  return out;
}

// Every deck joined end to end with `b` (any cell, any tile loaded so far).
function complexOf(city, b, into) {
  const stack = [b];
  into.add(b);
  while (stack.length && into.size < 256) {
    const w = stack.pop();
    for (const e of [w.p[0], w.p[w.p.length - 1]]) {
      const c = cellAt(city, e[0], e[1]);
      if (!c) continue;
      const k = KEY(e[0], e[1]);
      for (const o of c.roads) {
        if (!o.br || into.has(o) || !o.p || o.p.length < 2) continue;
        const last = o.p.length - 1;
        if (KEY(o.p[0][0], o.p[0][1]) !== k && KEY(o.p[last][0], o.p[last][1]) !== k) continue;
        into.add(o); stack.push(o);
      }
    }
  }
  return into;
}

/** Run after a tile's roads and rails are bucketed (geo.indexPayload). */
export function stitchStructures(city, roads, rails) {
  const it = stitchStructuresSteps(city, roads, rails);
  while (!it.next().done);
}
// …in steps, for geo.js indexPayloadSteps when it indexes a tile a few
// milliseconds a frame (round 8: up to 90 ms of one frame on a town tile).
// Only the tile in hand is being indexed meanwhile, and it is far ahead of
// the player, so nothing reads these ways between two steps.
export function* stitchStructuresSteps(city, roads, rails) {
  const isRail = new Set(rails);
  // every bridge this tile can complete: its own, and the old ones its ways land on
  const bridges = new Set();
  for (const r of roads) if (r.br && r.p?.length > 1) bridges.add(r);
  for (const r of rails) if (r.br && r.p?.length > 1) bridges.add(r);
  for (const list of [roads, rails]) for (const r of list) {
    if (r.br || !r.p?.length) continue;
    for (const e of [r.p[0], r.p[r.p.length - 1]]) {
      const c = cellAt(city, e[0], e[1]);
      if (!c) continue;
      const d = decksIn(c);
      for (const b of d.roads) bridges.add(b);
      for (const b of d.rails) { bridges.add(b); isRail.add(b); }
    }
  }
  yield;
  for (const b of bridges) {
    for (const end of [0, b.p.length - 1]) linkEnd(city, b, end, isRail.has(b));
  }
  yield;
  // A viaduct split across a tile edge is still ONE structure (geo.js chains
  // the pieces of one tile): its pieces would each grade themselves and meet
  // at a step (0.8 m mid-span on Generála Svobody).
  for (const b of bridges) if (b.d || isRail.has(b)) chainAcross(city, b);
  // Every member of a structure this tile touched is measured again, whole:
  // a complex split over a tile edge has to come out the same whichever of
  // its tiles arrived first (co-op clients load them in any order).
  const decks = new Set();
  for (const b of bridges) if (!isRail.has(b) && !decks.has(b)) complexOf(city, b, decks);
  yield;
  for (const b of decks) if (!isRail.has(b)) deckNodes(city, b);
  yield;
  // ---- underpasses: every crossing of a bridge over a way, either tile ----
  // (only ways that pass through a cell holding a deck: the city keeps those
  // cells, so the eight thousand ways of a town tile cost a set lookup each)
  const bc = city._bridgeCells ??= new Set();
  for (const b of bridges) for (const k of cellsOf(b, 0)) bc.add(k);
  const ways = new Set();
  let step = 0;
  for (const r of roads) {
    if ((++step & 511) === 0) yield;
    if (r.br || !(r.p?.length > 1)) continue;
    for (const k of cellsOf(r, 0, _cells)) if (bc.has(k)) { ways.add(r); break; }
    _cells.clear();
  }
  for (const b of bridges) {
    for (const k of cellsOf(b, 0)) {
      const c = city.chunkIndex.get(k);
      if (c) for (const w of c.roads) if (!w.br && w.p?.length > 1) ways.add(w);
    }
  }
  yield;
  for (const w of ways) {
    if ((++step & 63) === 0) yield;
    const over = new Set();
    for (const k of cellsOf(w, 0)) {
      const c = city.chunkIndex.get(k);
      if (!c) continue;
      const d = decksIn(c);
      for (const b of d.roads) over.add(b);
      for (const b of d.rails) { over.add(b); isRail.add(b); }
    }
    for (const b of over) crossing(city, w, b, isRail.has(b));
  }
  yield;
  rebuildChains(city);
}

function chainAcross(city, b0) {
  const rail = b0.t === 'rail' || b0.t === 'tram';
  const arms = (x, z) => {
    const c = cellAt(city, x, z), k0 = KEY(x, z), out = [];
    if (!c) return out;
    for (const o of rail ? c.rails : c.roads) {
      if (!o.br || !o.p || o.p.length < 2 || (rail ? o.t !== b0.t : !o.d)) continue;
      const n = o.p.length - 1;
      if (KEY(o.p[0][0], o.p[0][1]) === k0) out.push({ b: o, e: 0 });
      else if (KEY(o.p[n][0], o.p[n][1]) === k0) out.push({ b: o, e: n });
    }
    return out;
  };
  // the component, and whether it is a simple line
  const comp = [b0], seen = new Set([b0]);
  let branched = false;
  for (let q = 0; q < comp.length && comp.length < 256; q++) {
    const w = comp[q];
    for (const e of [0, w.p.length - 1]) {
      const a = arms(w.p[e][0], w.p[e][1]);
      if (a.length > 2) branched = true;
      for (const o of a) if (!seen.has(o.b)) { seen.add(o.b); comp.push(o.b); }
    }
  }
  if (branched) {
    // branched: leave it to its own law (deckNodes). A chain one of its tiles
    // made of the part it held alone (a plain line until the branch came in
    // with the next tile) is dissolved, or the structure would come out
    // differently depending on which tile arrived first.
    for (const w of comp) {
      if (rail) {
        const last = w.p.length - 1;
        w._chain = { total: lenOf(w), members: [w], headWay: w, headEnd: 0, tailWay: w, tailEnd: last,
          headJoint: arms(...w.p[0]).length > 1, tailJoint: arms(...w.p[last]).length > 1 };
        w._chainOff = 0; w._chainRev = false;
        continue;
      }
      if (!w._chain || w._chain.members.length < 2) continue;
      delete w._chain; delete w._chainOff; delete w._chainRev;
      w._bridgeProfile = null;
    }
    return;
  }
  if (!rail && comp.length < 2) return;
  const ch0 = comp[0]._chain;
  if (ch0 && ch0.members.length === comp.length && comp.every((w) => w._chain === ch0)) return;
  const deg = (w, e) => arms(w.p[e][0], w.p[e][1]).length;
  let head = comp.find((w) => deg(w, 0) === 1 || deg(w, w.p.length - 1) === 1);
  if (!head) return;                                  // a loop
  let enter = deg(head, 0) === 1 ? 0 : head.p.length - 1;
  const chain = { total: 0, members: [] };
  const used = new Set();
  while (head && !used.has(head)) {
    used.add(head);
    const rev = enter !== 0;
    head._chain = chain; head._chainOff = chain.total; head._chainRev = rev;
    head._bridgeProfile = null;
    chain.members.push(head);
    chain.total += lenOf(head);
    const exit = rev ? 0 : head.p.length - 1;
    const nx = arms(head.p[exit][0], head.p[exit][1]).find((a) => !used.has(a.b));
    if (!nx) { chain.tailWay = head; chain.tailEnd = exit; break; }
    head = nx.b; enter = nx.e;
  }
  chain.headWay = chain.members[0];
  chain.headEnd = chain.members[0]._chainRev ? chain.members[0].p.length - 1 : 0;
  // the abutments re-measure what they owe the new structure
  for (const m of chain.members) for (const p of m._pins ?? []) {
    p.node._nyT = null; p.node._hard = false;
    for (const a of p.node.arms) a.r._prof = undefined;
  }
}

// The deck at `end` of bridge `b` lands on the way sharing that vertex.
function linkEnd(city, b, end, rail) {
  const slot = end === 0 ? '_ap0' : '_ap1';
  if (b[slot]) {
    if (rail) indexPortalApproach(city, b, end, b[slot].road, b[slot].at);
    return;
  }
  const [x, z] = b.p[end];
  const c = cellAt(city, x, z);
  if (!c) return;
  const k0 = KEY(x, z);
  for (const w of rail ? c.rails : c.roads) {
    if (w === b || w.br || !w.p || w.p.length < 2) continue;
    if (rail ? w.t !== b.t : !w.d && b.d) continue;
    for (let i = 0; i < w.p.length; i++) {
      if (KEY(w.p[i][0], w.p[i][1]) !== k0) continue;
      const at = arcTo(w, i);
      b[slot] = { road: w, at };
      if (rail) indexPortalApproach(city, b, end, w, at);
      if (!rail) {
        (w._abut ??= []).push(at); w._prof = undefined; w._raw = undefined;
        // (who put it there: a released deck takes its abutment back, releaseStructures)
        let by = _abutBy.get(b);
        if (!by) _abutBy.set(b, by = []);
        by.push(w, at);
      }
      b._bridgeProfile = null;
      if (b._chain) b._chain.profile = null;
      // a drivable deck and its road also become one junction, so the road is
      // banked onto the deck (geo.junctionY), unless indexJunctions already
      // made them one, which it did when both came in the same tile
      if (!rail && b.d && w.d && !(b._pins ?? []).some((p) => p.node.arms.some((a) => a.r === w))) {
        const sB = end === 0 ? 0 : lenOf(b);
        const node = { x, z, arms: [
          { r: b, i: end, end: true, s: sB },
          { r: w, i, end: i === 0 || i === w.p.length - 1, s: at }] };
        (b._pins ??= []).push({ s: sB, node });
        (w._pins ??= []).push({ s: at, node });
        w._prof = undefined;
      }
      return;
    }
  }
}

// a feature's box, kept on it: the crossing test meets the same ways again and again
function boxOf(f) {
  let b = f._bbU;
  if (b && b.n === f.p.length) return b;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of f.p) { if (x < x0) x0 = x; if (z < z0) z0 = z; if (x > x1) x1 = x; if (z > z1) z1 = z; }
  return (f._bbU = { x0, z0, x1, z1, n: f.p.length });
}

// Way `w` and bridge `b` cross without sharing a node: is it an underpass?
function crossing(city, w, b, rail) {
  const A = boxOf(w), B = boxOf(b);
  if (A.x1 < B.x0 || B.x1 < A.x0 || A.z1 < B.z0 || B.z1 < A.z0) return;
  if ((w._dipX ?? []).some((d) => d.b === b)) return;   // (each tile asks again)
  for (const p of w.p) for (const q of b.p) if (p[0] === q[0] && p[1] === q[1]) return;   // they meet: a junction
  let hit = null, along = 0;
  for (let i = 0; i < w.p.length - 1 && !hit; i++) {
    const [ax, az] = w.p[i], [bx, bz] = w.p[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    let sb = 0;
    for (let j = 0; j < b.p.length - 1; j++) {
      const [cx, cz] = b.p[j], [dx, dz] = b.p[j + 1];
      const Lb = Math.hypot(dx - cx, dz - cz);
      const q = segCross(ax, az, bx, bz, cx, cz, dx, dz);
      if (q) { hit = { x: ax + (bx - ax) * q.t, z: az + (bz - az) * q.t, s: along + L * q.t, sb: sb + Lb * q.u, sin: q.sin }; break; }
      sb += Lb;
    }
    along += L;
  }
  if (!hit) return;
  const below = (w.l ?? 0) < 0 || leadsUnder(city, w, hit);
  if (!rail && !below) return;                 // a road over a road: it rises (geo.bridgeClearance)
  if ((b.l ?? 1) <= (w.l ?? 0)) return;        // mapped as passing above it: not ours to sink
  const foot = FOOT.has(w.t);
  const d = { w, b, x: hit.x, z: hit.z, s: hit.s, sb: hit.sb, rail,
    clear: (foot ? CLEAR_FOOT : CLEAR_ROAD) + DECK_DEPTH[rail ? 'rail' : 'road'],
    // how much of the street lies under the structure, measured along it
    hw: Math.min(30, ((b.w ?? (rail ? 4 : 6)) / 2) / Math.max(0.35, hit.sin)) + 2 };
  (w._dipX ??= []).push(d);
  // The bridge keeps its level: this crossing no longer asks it to climb.
  if (b._cross) {
    b._cross = b._cross.filter((c) => Math.hypot(c.x - hit.x, c.z - hit.z) > 1.5);
    if (!b._cross.length) delete b._cross;
    b._bridgeProfile = null;
    if (b._chain) b._chain.profile = null;
    for (const p of b._pins ?? []) {
      p.node._nyT = null; p.node._hard = false;
      for (const a of p.node.arms) a.r._prof = undefined;
    }
  }
  (city._dipWays ??= new Set()).add(w);
}

// Is the way, near this crossing, the ramp of something mapped underground?
// (walked end to end, any ways, as far as UNDER_NEAR from the crossing)
function leadsUnder(city, w, hit) {
  const seen = new Set([w]);
  const stack = [[w, 0, hit.s], [w, w.p.length - 1, lenOf(w) - hit.s]];
  while (stack.length) {
    const [r, end, dist] = stack.pop();
    if (dist > UNDER_NEAR) continue;
    const [x, z] = r.p[end];
    const c = cellAt(city, x, z);
    if (!c) continue;
    const k0 = KEY(x, z);
    for (const o of c.roads) {
      if (seen.has(o) || o.br || !o.p || o.p.length < 2) continue;
      const n = o.p.length - 1;
      const e0 = KEY(o.p[0][0], o.p[0][1]) === k0, e1 = KEY(o.p[n][0], o.p[n][1]) === k0;
      if (!e0 && !e1) continue;
      if ((o.l ?? 0) < 0) return true;
      seen.add(o);
      stack.push([o, e0 ? n : 0, dist + lenOf(o)]);
    }
  }
  return false;
}

// what js/underpassrelease.js takes off again when a far tile lets go (main
// thread; the deck cache and the abutment ledger stay owned here)
export { _decks as deckCache, _abutBy as abutLedger, linkEnd, chainAcross, deckNodes };
