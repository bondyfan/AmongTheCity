// ---- mastlamps.js: the tall masts of a lit D11 / D35 interchange ----------
// The open motorway is dark (js/mwplan.js motorwayLit); its interchanges and
// rest areas are lit, and on a Czech motorway that light does not come from
// town street columns on the kerb. It comes from 12 m galvanised masts that
// stand well back, behind the guard rail, with an arm over the carriageway
// and a second one back over the verge or the slip road (round 9; the town
// column every 34 m stood on the rail itself, 6.95 m out, with its head at
// 7.4 m over the hard shoulder).
//
//   MAST    (two arms) along the motorway carriageway, its OUTER side only,
//           MAST_OFF m beyond the drawn asphalt, every MAST_STEP m, and only
//           where the guard rail in front of it stands (not in a gore, where
//           the rail is broken for the slip and nothing would hold a car).
//   MAST1   (one arm) along a slip road that reaches into the lit zone, on
//           its right, falling back to its left, further from the asphalt
//           than a kerb column because no rail guards a slip.
//
// THE WALK is the lampSpots one (js/meshes.js): every way is walked from its
// own first vertex in MAST_STEP strides, so a mast's place is a property of
// the way and every cell that walks it agrees; a cell keeps the masts that
// stand inside it. The guards are the street lamps' own (another carriageway,
// a junction pad, a house, a surveyed lamp), handed in by meshes.js, plus
// the motorway's signs: no mast in a gantry's legs or through a verge board
// (js/mwsigns.js plans them from the constant lines, so this is a pure
// function of the way and the tile too). Main thread AND mesh worker: no
// three, no DOM.

import { cwOf, motorwayLit, LIT_R, BRIDGE_KERB, deckY } from './mwplan.js';
import { exitNear } from './d11.js';
import { laneLayout } from './lanes.js';
import { plannedMotorwaySigns } from './mwsigns.js';

export const MAST_STEP = 40;        // m between masts: about three times their height
// m beyond the drawn asphalt edge: the rail stands 0.6 out, its working width
// takes a metre more, and the noise walls (js/mwtall.js) stand 2.1 out
export const MAST_OFF = 2.75;
export const MAST1_OFF = 6.0;       // m beyond a slip road's asphalt
export const SLIP_CLEAR = 5.0, MOTORWAY_CLEAR = 10; // unguarded verge beside a slip / main line
const MAST_CLEAR = 1.5;             // m a mast keeps from any carriageway's edge
const RAIL_OUT = 0.6;               // js/mwplan.js: the rail line beyond the asphalt
const RAIL_GAP = 1.2;               // js/mwplan.js barrierPlan: the rail breaks this near another road
const SIGN_ALONG = 12, SIGN_ACROSS = 30;   // m: a sign's keep-out box

// kept off the way itself: js/chunkspec.js ships every own field of a way to
// the worker, and a memo there would travel in every chunk spec
const KIND = new WeakMap();
/** 'mast', 'mast1' or null: what this way is lit with, if it is a mast way at all. */
export function mastKind(r) {
  if (!r?.p || r.p.length < 2 || !r.d || (r.t !== 'motorway' && r.t !== 'motorway_link')) return null;
  let k = KIND.get(r);
  if (k !== undefined) return k;
  k = null;
  if (r.t === 'motorway') k = cwOf(r) ? 'mast' : null;
  // a slip is a mast way when any of it reaches into a lit interchange (decided
  // per way, so its masts do not change kind halfway along it)
  else for (const q of r.p) if (motorwayLit(q[0], q[1])) { k = 'mast1'; break; }
  KIND.set(r, k);
  return k;
}

// is (x, z) inside the keep-out box of a planned motorway sign near key `k`?
function nearSign(x, z) {
  const cx = Math.floor(x / 120), cz = Math.floor(z / 120);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const it of plannedMotorwaySigns((cx + dx) + ',' + (cz + dz))) {
      const ex = x - it.cx, ez = z - it.cz;
      const along = ex * it.dx + ez * it.dz, across = -ex * it.dz + ez * it.dx;
      if (Math.abs(along) < SIGN_ALONG && Math.abs(across) < SIGN_ACROSS) return true;
    }
  }
  return false;
}

/**
 * Plant the masts of way `r` that stand in the cell (x0, z0)-(x1, z1) into
 * g.mast / g.mast1 as [x, z, rot] (rot faces the carriageway: the first arm
 * reaches over it, as a street column's does). `g` carries the guards:
 *   near        every carriageway round the cell (meshes.js lampGround)
 *   inRoad(roads, self, x, z, grow)   meshes.js lampInRoad
 *   onPad(x, z), inHouse(x, z), nearMapped(x, z)
 * Returns true when the way is a mast way (the caller then plants nothing else on it).
 */
export function mastsAlong(r, kind, x0, z0, x1, z1, g) {
  if (!kind) return false;
  const lay = laneLayout(r);
  const rh = lay ? lay.ribbonHalf : (r.w ?? 6) / 2;
  const mw = kind === 'mast';
  // On a bridge the socket is cast into the outer parapet; the support
  // height must travel with the spot through the near and far renderers.
  const off = r.br ? rh - 0.12 : rh + (mw ? MAST_OFF : MAST1_OFF);
  const near = r.br ? g.near.filter(o => !!o.br) : g.near;
  const mainLines = mw ? [] : near.filter(o => o.t === 'motorway');
  // for the rail test: every carriageway but this one's own pieces (at a joint
  // the next piece's width reaches the rail line and is no gap)
  let others = near;
  if (mw) {
    const cw = cwOf(r);
    others = near.filter((o) => !(o.t === 'motorway' && cwOf(o) === cw));
  }
  const sides = mw ? [1] : [1, -1];
  let carry = (r._id % 13) * 3, run = 0;
  for (let i = 0; i < r.p.length - 1; i++) {
    const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
    let dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.01) continue;
    dx /= L; dz /= L;
    for (let d = MAST_STEP - carry; d < L; d += MAST_STEP) {
      const px = ax + dx * d, pz = az + dz * d;
      // the cell the STATION is in plants it, whichever cell its foot lands
      // in (the guards read the 3x3 cells round it, as a street lamp's do)
      if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue;
      if (mw && !motorwayLit(px, pz)) continue;
      // the guard rail in front of a motorway mast: broken here (a gore, a
      // slip road's asphalt), and there is nothing to hold a car off it
      if (mw && !r.br && g.inRoad(others, null, px - dz * (rh + RAIL_OUT), pz + dx * (rh + RAIL_OUT), RAIL_GAP)) continue;
      for (const side of sides) {
        const nx = -dz * side, nz = dx * side;            // side 1: right of travel
        const lx = px + nx * off, lz = pz + nz * off;
        if ((!mw && !r.br && g.inRoad(mainLines, null, lx, lz, MOTORWAY_CLEAR))
          || g.inRoad(near, r.br ? r : null, lx, lz, mw || r.br ? MAST_CLEAR : SLIP_CLEAR)
          || (!r.br && (g.onPad(lx, lz) || g.inHouse(lx, lz)))
          || g.nearMapped(lx, lz) || nearSign(lx, lz)) continue;
        const spot = [lx, lz, Math.atan2(-nx, -nz) + Math.PI];
        if (r.br && g.terrain) spot.push(deckY(r, run + d, px, pz, g.terrain) + (mw ? BRIDGE_KERB : 0));
        (mw ? g.mast : g.mast1).push(spot);
        break;
      }
    }
    carry = (carry + L) % MAST_STEP;
    run += L;
  }
  return true;
}

// ---- light: what the masts of one interchange burn --------------------------
// One interchange is one installation, so its masts share a lamp: high
// pressure sodium or a neutral white LED (the warm LED of the town streets is
// a residential choice), decided by the exit's number, never by a district
// grid that would cut a junction into two colours. A rest area (no exit near)
// by its kilometre square. Linear RGB, the units js/lightpools.js tints with.
export const MAST_SODIUM = Object.freeze([1.0, 0.56, 0.21]);
export const MAST_LED = Object.freeze([0.96, 0.9, 0.8]);
export function mastTint(x, z) {
  const e = exitNear(x, z, LIT_R + 150);
  let h = e ? Math.imul(e.n | 0, 2654435761) : Math.imul(Math.floor(x / 1000), 374761393) ^ Math.imul(Math.floor(z / 1000), 668265263);
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return (h & 1) ? MAST_LED : MAST_SODIUM;
}
