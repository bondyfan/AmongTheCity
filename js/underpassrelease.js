// ---- underpassrelease.js: a far tile's stitching taken off again ------------
// MAIN THREAD, used by geo.js (deepSteps). Split out of js/underpass.js, which
// writes the links this undoes (stitchStructures, linkEnd) and owns the deck
// cache and the abutment ledger it reads.

import { invalidateBridgeFit } from './corridorlevel.js';
import { forgetPortal } from './railportal.js';
import { polylineLength } from './geo.js';
import { deckCache, abutLedger, linkEnd, chainAcross, deckNodes } from './underpass.js';

// ---- a far tile lets go ------------------------------------------------------
// geo.js RELEASE_DATA: a deep-evicted tile gives back its ways themselves, not
// only what the graphs built from them. stitchStructures wrote links between
// this tile's ways and its neighbours' (an approach, an abutment, a two-arm
// junction node, a viaduct chain, an underpass crossing), and every one of
// them on a RESIDENT way would keep the released ways alive (an arm reaches a
// way, the way its pins, the pins every junction of the tile) and stand in
// for the new objects when the tile comes back. So each is taken off again,
// leaving the resident ways as stitching left them with that tile absent:
// when it returns, stitchStructures links its new ways exactly as it would on
// a first visit after them. `gone` holds the released ways (roads and rails),
// `keys` the cells to look in (the tile's footprint and a ring round it: every
// way stitching can have touched lies in a cell a released way lies in).
// Main thread, after geo.js has emptied the tile's cells. A generator: geo.js
// runs it a few milliseconds per frame (queueJob), and nothing indexes a tile
// between its steps.
export function* releaseStructures(city, gone, keys) {
  const near = new Set(), rails = new Set();
  let n = 0;
  for (const k of keys) {
    if ((++n & 511) === 0) yield;
    const c = city.chunkIndex.get(k);
    if (!c) continue;
    deckCache.delete(c);                      // a cell's deck list is checked by length only
    for (const w of c.roads) if (!gone.has(w)) near.add(w);
    for (const w of c.rails) if (!gone.has(w)) { near.add(w); rails.add(w); }
  }
  // the abutments the released decks pushed onto resident ways
  for (const b of gone) {
    if (b.br && b.t === 'rail') { forgetPortal(b, 0); forgetPortal(b, b.p.length - 1); }
    const by = abutLedger.get(b);
    if (!by) continue;
    for (let i = 0; i < by.length; i += 2) {
      const w = by[i];
      if (gone.has(w) || !w._abut) continue;
      const j = w._abut.indexOf(by[i + 1]);
      if (j >= 0) w._abut.splice(j, 1);
      if (!w._abut.length) delete w._abut;
      w._prof = undefined; w._raw = undefined;
      near.add(w);
    }
  }
  const chains = new Set(), renode = [], relink = [];
  let changed = 0;
  const forget = (node) => { node._nyT = null; node._hard = false; for (const a of node.arms) if (!gone.has(a.r)) a.r._prof = undefined; };
  yield;
  for (const w of near) {
    if ((++n & 1023) === 0) yield;
    let hit = false;
    // (a resident deck that landed on a released way: that abutment left with the way)
    const by = abutLedger.get(w);
    if (by && by.some((o, i) => !(i & 1) && gone.has(o))) {
      const keep = [];
      for (let i = 0; i < by.length; i += 2) if (!gone.has(by[i])) keep.push(by[i], by[i + 1]);
      if (keep.length) abutLedger.set(w, keep); else abutLedger.delete(w);
    }
    for (const slot of ['_ap0', '_ap1']) {
      const l = w[slot];
      if (l && typeof l === 'object' && gone.has(l.road)) {
        if (w.t === 'rail') forgetPortal(w, slot === '_ap0' ? 0 : w.p.length - 1);
        delete w[slot]; hit = true;
        relink.push(w, slot === '_ap0' ? 0 : w.p.length - 1);
        w._bridgeProfile = null;
        if (w._chain) w._chain.profile = null;
      }
    }
    if ((w._apN0 ?? []).some((l) => gone.has(l.road)) || (w._apN1 ?? []).some((l) => gone.has(l.road))) {
      invalidateBridgeFit(w);
      delete w._apN0; delete w._apN1; renode.push(w); hit = true;
    }
    if (w._pins?.some((p) => p.node.arms.some((a) => gone.has(a.r)))) {
      for (const p of w._pins) if (p.node.arms.some((a) => gone.has(a.r))) p.node._gone = 1;
      w._pins = w._pins.filter((p) => !p.node._gone);
      if (!w._pins.length) delete w._pins;
      for (const p of w._pins ?? []) forget(p.node);
      w._prof = undefined; hit = true;
    }
    if (w._jsNear) { w._jsNear = undefined; }   // meshes.js re-gathers it from the buckets
    if (w._chain?.members.some((m) => gone.has(m))) { chains.add(w._chain); hit = true; }
    if (w._dipX?.some((d) => gone.has(d.b) || gone.has(d.w))) {
      w._dipX = w._dipX.filter((d) => !gone.has(d.b) && !gone.has(d.w));
      if (!w._dipX.length) { delete w._dipX; city._dipWays?.delete(w); }
      w._prof = undefined; w._raw = undefined; hit = true;
    }
    if (hit) changed++;
  }
  if (city._dipWays) for (const w of gone) city._dipWays.delete(w);
  // A viaduct chained across the seam: what is left of it is chained again as
  // stitching chains it, and a lone span with crossings reads its own grade
  // (geo.indexBridgeCrossings' rule for a chain of one).
  const rest = [];
  for (const ch of chains) for (const m of ch.members) {
    if (gone.has(m) || m._chain !== ch) continue;
    m._chain = undefined; m._chainOff = undefined; m._chainRev = undefined;
    m._bridgeProfile = null;
    for (const p of m._pins ?? []) forget(p.node);
    rest.push(m);
  }
  for (const m of rest) if (!m._chain && (m.d || m.t === 'rail' || m.t === 'tram') && m.p?.length > 1) chainAcross(city, m);
  for (const m of rest) {
    if (m._chain || !m._cross) continue;
    const L = m._len ?? polylineLength(m.p);
    m._chain = { total: L, members: [m], headWay: m, headEnd: 0, tailWay: m, tailEnd: m.p.length - 1 };
    m._chainOff = 0; m._chainRev = false;
  }
  // A deck whose end landed on a released way lands where it would have with
  // that tile absent: on a resident way there (the first one a cell lists
  // wins, and the released tile's came first), or, for a railway deck in two
  // pieces, on the level of its other end (stitchStructures' rule).
  for (let i = 0; i < relink.length; i += 2) linkEnd(city, relink[i], relink[i + 1], rails.has(relink[i]));
  for (const w of renode) deckNodes(city, w);
  yield;
  // The dip chains that ran through the tile are dissolved, not rebuilt: a
  // whole rebuild (dipchain.rebuildChains) is 30 ms and more of one frame in
  // Prague, and the next tile to arrive runs one anyway (stitchStructures).
  // Until then their resident ways level without the dip, which nobody is
  // near enough to see; the rebuild then makes the chains new, so every
  // member levels again.
  if (city._dipChains) {
    for (const [key, ch] of city._dipChains) {
      // (a chain of resident ways under a released bridge holds that bridge in its dips)
      if (!ch.members.some((m) => gone.has(m.r)) && !ch.dips.some((d) => gone.has(d.b))) continue;
      city._dipChains.delete(key);
      for (const m of ch.members) {
        if (m.r._dipChain === ch) { m.r._dipChain = undefined; m.r._dipM = undefined; }
        if (gone.has(m.r)) continue;
        m.r._prof = undefined;
        for (const p of m.r._pins ?? []) if (p.node._dipChain === ch) {
          p.node._dipChain = undefined;
          for (const a of p.node.arms) a.r._prof = undefined;
        }
      }
    }
  }
  return changed;
}
