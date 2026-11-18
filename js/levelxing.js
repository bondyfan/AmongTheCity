// ---- level crossings: the railway wins --------------------------------------
// A road crossing a heavy-rail track at grade had nothing tying the two
// levels: each was levelled alone, and the survey's measure of the crossing
// was up to 1.4 m apart in Prague (survey 13, rails.md "Level crossings";
// one secondary 6.4 m). The railway is the stiffer earthwork (2.5 per mille
// of grade, kilometres of radius), so the road comes to it: every crossing
// becomes a pin on the road whose height is the rail's level less the
// difference between the two surfaces (geo.junctionY reads `_xing`), and the
// road's existing pin taper, or its corridor's (js/corridorlevel.js), bends
// it there. Index time, one tile's ways (geo.indexPayloadSteps). The rail is
// an arm of the node too, so a release of either way lets the pin go
// (js/underpassrelease.js reads node.arms).
import { CHUNK, LAYER_Y } from './config.js';

const LIFT = LAYER_Y.rail - LAYER_Y.road;     // rail top level against the asphalt's

function cross(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

/** Pin every drivable road of this tile where it crosses a heavy-rail track of this tile at grade. */
export function indexLevelCrossings(roads, rails) {
  const it = indexCrossingsSteps(roads, rails);
  let step;
  do { step = it.next(); } while (!step.done);
  return step.value;
}

function* indexCrossingsSteps(roads, rails) {
  const grid = new Map();
  let count = 0;
  let any = false;
  for (const r of rails ?? []) {
    if (r.t !== 'rail' || r.br || (r.l ?? 0) !== 0 || !(r.p?.length > 1)) continue;
    let run = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const seg = { r, ax, az, bx, bz, run, L };
      for (let cx = Math.floor(Math.min(ax, bx) / CHUNK); cx <= Math.floor(Math.max(ax, bx) / CHUNK); cx++)
        for (let cz = Math.floor(Math.min(az, bz) / CHUNK); cz <= Math.floor(Math.max(az, bz) / CHUNK); cz++) {
          const k = cx + ',' + cz;
          let a = grid.get(k);
          if (!a) grid.set(k, a = []);
          a.push(seg);
          any = true;
        }
      run += L;
    }
  }
  if (!any) return 0;
  let made = 0;
  for (const w of roads) {
    if ((++count & 127) === 0) yield;
    if (!w.d || w.br || (w.l ?? 0) !== 0 || !(w.p?.length > 1)) continue;
    let run = 0;
    const got = (w._pins ?? []).filter((p) => p.node._xing).map((p) => ({ r: p.node._xing, s: p.s }));
    for (let i = 0; i < w.p.length - 1; i++) {
      const [ax, az] = w.p[i], [bx, bz] = w.p[i + 1];
      const seen = new Set();
      const L = Math.hypot(bx - ax, bz - az);
      for (let cx = Math.floor(Math.min(ax, bx) / CHUNK); cx <= Math.floor(Math.max(ax, bx) / CHUNK); cx++)
        for (let cz = Math.floor(Math.min(az, bz) / CHUNK); cz <= Math.floor(Math.max(az, bz) / CHUNK); cz++) {
          for (const g of grid.get(cx + ',' + cz) ?? []) {
            if (seen.has(g)) continue;
            const hit = cross(ax, az, bx, bz, g.ax, g.az, g.bx, g.bz);
            if (!hit) continue;
            seen.add(g);
            const s = run + L * hit[0], rs = g.run + g.L * hit[1];
            if (got.some((o) => o.r === g.r && Math.abs(o.s - s) < 1)) continue;
            got.push({ r: g.r, s });
            const node = { x: ax + (bx - ax) * hit[0], z: az + (bz - az) * hit[0], _xing: g.r, _xingS: rs, _xingLift: LIFT,
              arms: [{ r: w, i: -1, end: false, s }, { r: g.r, i: -1, end: false, s: rs }] };
            (w._pins ??= []).push({ s, node });
            w._prof = undefined;
            made++;
          }
        }
      run += L;
    }
  }
  return made;
}

// A long way is stored whole in its owner tile. New track may run through
// a road that landed earlier, just as often as the reverse. Visit only the
// cells containing both kinds and distinguish the two arrival directions.
export function* indexTileCrossings(city, roads, rails, keys) {
  const incomingRoads = new Set(roads), incomingRails = new Set(rails);
  const nearbyRails = new Set(), oldRoads = new Set();
  let count = 0;
  for (const key of keys) {
    if ((++count & 255) === 0) yield;
    const c = city.chunkIndex.get(key);
    if (!c?.rails.length || !c.roads.length) continue;
    if (c.roads.some((r) => incomingRoads.has(r))) {
      for (const rail of c.rails) nearbyRails.add(rail);
    }
    if (c.rails.some((r) => incomingRails.has(r))) {
      for (const road of c.roads) if (!incomingRoads.has(road)) oldRoads.add(road);
    }
  }
  yield* indexCrossingsSteps(roads, nearbyRails);
  yield* indexCrossingsSteps(oldRoads, rails);
}
