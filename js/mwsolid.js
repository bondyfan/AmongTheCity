// ---- mwsolid.js: the D11's barriers are solid ----
// city.collide asks this once per probe. The lines are the very plan the
// mesher draws (js/mwplan.js barrierPlan), memoised per chunk cell, so a car
// scrapes along the rail it sees and never along an invisible one.
//
// HEIGHT. A barrier only stops a probe at its own level: a car on an overpass
// crosses over the D11's rails, a car on the road under a viaduct passes
// beneath the viaduct's median. So a probe must say where it is: `opts.y`
// (vehicles.js wallPass passes the car's height) or `opts.yLo` (a walker's
// feet). A caller that gives neither (spawn placement, parking nudges) is not
// stopped by barriers at all, rather than by a guess.
//
// THIN WALLS AT 130 km/h. A car moves 0.6 m a frame at 60 fps and a 0.2 m
// rail is thinner than that, so the wall is treated as THICK BEHIND its face:
// every barrier knows which side its carriageway is on (the plan's normal),
// and a probe up to BACK metres past the face is still pushed back to the
// road side. A walker in the field behind a rail is pushed to the field side
// once past the middle of that thick band, so nobody is pulled through.

import { barrierPlan, hasInterchangeSlip, K_MEDIAN, MEDIAN_H, RAIL_H, STRIDE } from './mwplan.js';
import { d11Locate } from './d11.js';

const GROW = 12;                 // m: a cell's plan reaches this far past its rect
const BACK = 1.0;                // m: how far behind its face a barrier still holds (a 30 fps frame at 130)
const MEMO_MAX = 48;
const memo = new Map();          // chunk key -> { cell, n, loads, plan }
const _loc = { road: '', cw: '', km: 0, off: 0, dx: 0, dz: 0 };

function planFor(city, terrain, key) {
  const cell = city.chunkIndex.get(key);
  if (!cell) return null;
  const n = cell.roads?.length ?? 0, loads = terrain._loads ?? 0;
  let m = memo.get(key);
  // a tile arriving changes the cell's road list, a height map its profiles
  if (m && m.cell === cell && m.n === n && m.loads === loads) return m.plan;
  m = { cell, n, loads, plan: barrierPlan(cell, key, terrain, GROW, city) };
  memo.delete(key);
  memo.set(key, m);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return m.plan;
}

/** Forget every memoised plan (tests; a world rebuild). */
export function resetBarrierMemo() { memo.clear(); }

/**
 * Push the probe {x, z} out of every D11 barrier it touches at its level.
 * Returns true when it moved. `world` is the CityWorld (city, terrain).
 */
export function barrierCollide(world, pos, radius, opts) {
  // a person climbs over a 0.8 m rail or a step barrier: only vehicles (and
  // whatever else asks without the walker's interior flag) are held by it
  if (opts?.interior) return false;
  const y = opts?.y ?? opts?.yLo;
  if (y === undefined || y === null || !world?.terrain) return false;
  const key = Math.floor(pos.x / 120) + ',' + Math.floor(pos.z / 120);
  if (!d11Locate(pos.x, pos.z, _loc) && !hasInterchangeSlip(world.city?.chunkIndex?.get(key))) return false;
  const plan = planFor(world.city, world.terrain, key);
  if (!plan?.length) return false;
  let pushed = false;
  for (const run of plan) {
    const v = run.v, n = v.length / STRIDE;
    const half = run.k === K_MEDIAN ? 0.25 : 0.08, H = run.k === K_MEDIAN ? MEDIAN_H : RAIL_H;
    const reach = radius + half + BACK + 4;
    for (let i = 0; i < n - 1; i++) {
      const a = i * STRIDE, b = a + STRIDE;
      const ax = v[a], az = v[a + 1];
      if (Math.abs(pos.x - ax) > reach || Math.abs(pos.z - az) > reach) continue;
      const bx = v[b], bz = v[b + 1], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((pos.x - ax) * ex + (pos.z - az) * ez) / L2;
      if (t < 0 || t > 1) continue;                 // the next piece answers (no rounded ends to snag)
      const deck = v[a + 2] + (v[b + 2] - v[a + 2]) * t;
      if (y > deck + H + 0.2 || y < deck - 2.5) continue;
      const nx = v[a + 3], nz = v[a + 4];
      const px = ax + ex * t, pz = az + ez * t;
      const sd = (pos.x - px) * nx + (pos.z - pz) * nz;   // + on the road side
      const front = half + radius, back = -(half + BACK + radius);
      if (sd >= front || sd <= back) continue;
      // nearer the face than the back of the thick band: back to the road
      const to = sd > (front + back) / 2 ? front : back;
      pos.x += nx * (to - sd); pos.z += nz * (to - sd);
      pushed = true;
    }
  }
  return pushed;
}
