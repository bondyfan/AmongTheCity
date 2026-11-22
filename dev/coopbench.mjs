// ---- coopbench: two clients over the real Pardubice graph, compared --------
// A dev tool (node, no browser):   node dev/coopbench.mjs [scenario ...]
//
// Two independent Traffic instances are fed the same four region tiles and the
// same shared clock, each with its own player, its own camera and both players
// as obstacles (what main.js updateActors does in a session). Every few
// seconds the cars each one DRAWS near the players are compared with
// js/coopdiff.js: the share both draw in the same place, and for the rest the
// reason one screen has a car the other has not.
//
// This is the number behind "every player must see what the other one sees"
// (Frank, 21 Nov 2026): run it before and after a change to the traffic.

import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('../tests/three-alias.mjs', import.meta.url));

const { Traffic } = await import('../js/traffic.js');
const { withRoadPatches } = await import('../js/roadpatches.js');
const { diffCars } = await import('../js/coopdiff.js');

// geo.js pave(): what a way's w becomes in the game
const PAVE = { motorway: 1.5, trunk: 1.5, primary: 1.5, secondary: 1.5, tertiary: 1.5,
  motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1,
  unclassified: 2.5, residential: 2.5, living_street: 1.5, service: 1.2, track: 0.5 };
const TILES = [[-1, -1], [0, -1], [-1, 0], [0, 0]];

let _raw = null;
function region() {
  if (_raw) return _raw;
  const tiles = [], built = new Map();
  for (const [tx, tz] of TILES) {
    const j = JSON.parse(readFileSync(new URL(`../public/data/tiles/${tx}_${tz}.json`, import.meta.url), 'utf8'));
    for (const b of j.buildings ?? []) {
      const o = b.o?.[0]; if (!o) continue;
      const k = Math.floor(o[0] / 120) + ',' + Math.floor(o[1] / 120);
      built.set(k, (built.get(k) ?? 0) + 1);
    }
    tiles.push({ tx, tz, roads: j.roads, signals: j.signals ?? [] });
  }
  return (_raw = { tiles, built });
}
// fresh way objects per client: traffic.js stamps the ways it takes in
function tilesFor() {
  const { tiles } = region();
  return tiles.map((t) => {
    const roads = withRoadPatches(t.roads.map((r) => ({ ...r, p: r.p.map((q) => [q[0], q[1]]) })), t.tx, t.tz, 1 << 20);
    const out = [];
    for (const r of roads) {
      if (r.d !== 1) continue;
      if (r.w > 0 && PAVE[r.t]) r.w = +(r.w + PAVE[r.t]).toFixed(2);
      out.push(r);
    }
    return { roads: out, signals: t.signals.map((s) => [s[0], s[1]]) };
  });
}
// main.js traffic.urbanAt over the tiles' buildings
function urbanAt(x, z) {
  const { built } = region();
  let b = 0;
  const cx = Math.floor(x / 120), cz = Math.floor(z / 120);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) b += built.get((cx + dx) + ',' + (cz + dz)) ?? 0;
  return Math.min(1, 0.15 + b / 45);
}

const DIMS = { bus: [11, 2.5], semi: [16.5, 2.55], truck: [7.6, 2.3], van: [4.8, 1.9] };
function stubVehicles() {
  return {
    scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading, color) {
      const [len, wid] = DIMS[kind] ?? [4.6, 1.8];
      const car = { mesh: { position: { set() {} }, rotation: { y: 0 }, userData: {} },
        wheels: [], x, z, heading, speed: 0, steer: 0, kind, color, len, wid, ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car);
      return car;
    },
    remove(car) { this.cars.delete(car); },
  };
}

export const T0 = 17_899_320;
export function makeClient(clock, { maxCars = 96, order = null, setup = null } = {}) {
  const log = console.log; console.log = () => {};
  let tiles = tilesFor();
  if (order) tiles = order.map((i) => tiles[i]);
  const t = new Traffic({ roads: tiles[0].roads, signals: tiles[0].signals, onTileLoaded() {} }, stubVehicles());
  t.urbanAt = urbanAt;
  for (let i = 1; i < tiles.length; i++) t.addTile(tiles[i]);
  console.log = log;
  t.clock = clock;
  t.maxCars = maxCars;
  setup?.(t);
  return t;
}

const drawn = (t, x, z, R) => {
  const out = [];
  for (const c of t.cars) {
    if ((c.x - x) ** 2 + (c.z - z) ** 2 > R * R) continue;
    const p = c.ai;
    out.push({ key: p?.key ?? null, kind: c.kind, color: c.color, x: c.x, z: c.z, h: c.heading, ghost: p?.ghost ? 1 : 0, p });
  }
  return out;
};

/**
 * Run two clients side by side.  a, b: { pos(s), look(s), hz, join }  (`join`:
 * the second this client's page loaded; before it the client does not exist).
 * Returns the mean agreement and where the rest went.
 */
export function compare({ a, b, secs = 420, warm = 90, every = 5, R = 250, tol = 2, maxCars = 96, setup = null, order = null, quiet = false, room = true }) {
  let now = T0;
  const clock = () => now;
  const cl = [a, b].map((c, i) => ({ ...c, t: null, i }));
  const BASE = 120;                      // ticks per second; hz must divide it
  const acc = { n: 0, fleet: 0, gh: 0, ot: 0, cars: 0, agree: 0, same: 0, sameLook: 0, moved: 0, only: 0,
    ghost: 0, unbodied: 0, absent: 0, movedSum: 0, worst: 1, pairD: 0, pairN: 0 };
  for (let k = 1; k <= secs * BASE; k++) {
    const s = k / BASE;
    now = T0 + s;
    const pos = cl.map((c) => c.pos(s));
    for (const c of cl) {
      if (s < (c.join ?? 0)) continue;
      const step = BASE / (c.hz ?? 30);
      if (k % step) continue;
      if (!c.t) c.t = makeClient(clock, { maxCars, setup, order: c.i ? order : null });
      const me = pos[c.i], peer = pos[1 - c.i];
      const actors = [{ x: me.x, z: me.z, half: me.half ?? 2.3, y: NaN }];
      if (cl[1 - c.i].t) actors.push({ x: peer.x, z: peer.z, half: peer.half ?? 2.3, y: NaN });
      c.t.actors = actors;
      // the peers near us (main.js: js/roomview.js peersNear); `room: false` is the game before 21 Nov 2026
      c.t.watchers = room && cl[1 - c.i].t ? [{ x: peer.x, z: peer.z, id: 'peer' }] : null;
      if (c.look) c.t.setViewer({ ...c.look(s), fovRad: 1.19, aspect: 16 / 9, fogFar: 634 });
      c.t.update(1 / (c.hz ?? 30), me, null);
    }
    if (s < warm || k % (every * BASE) || !cl[0].t || !cl[1].t) continue;
    const mx = (pos[0].x + pos[1].x) / 2, mz = (pos[0].z + pos[1].z) / 2;
    const A = drawn(cl[0].t, mx, mz, R), B = drawn(cl[1].t, mx, mz, R);
    const d = diffCars(A, B, tol);
    for (const c of cl) for (const g of c.t._ghosts) { acc.gh += 0.5; if (g.ot) acc.ot += 0.5; }
    acc.n++; acc.fleet += (cl[0].t.cars.size + cl[1].t.cars.size) / 2; acc.cars += (A.length + B.length) / 2; acc.agree += d.agree; acc.same += d.same;
    acc.sameLook += d.sameLook; acc.moved += d.moved; acc.only += d.onlyA.length + d.onlyB.length;
    for (const m of d.movedBy) acc.movedSum += m;
    for (const q of d.pairs) { acc.pairD += q.d; acc.pairN++; }
    if (d.agree < acc.worst) acc.worst = d.agree;
    const why = (list, other) => {
      for (const c of list) {
        if (c.ghost) acc.ghost++;
        else if (other._pool.has(c.key)) acc.unbodied++;   // the peer holds the schedule, without a mesh
        else acc.absent++;                                  // the peer does not hold the schedule at all
      }
    };
    why(d.onlyA, cl[1].t); why(d.onlyB, cl[0].t);
  }
  const n = acc.n || 1, r = (v) => Math.round(v * 100) / 100;
  const out = { samples: acc.n, fleet: r(acc.fleet / n), ghosts: r(acc.gh / n), overtime: r(acc.ot / n), cars: r(acc.cars / n), agree: r(acc.agree / n), worst: r(acc.worst),
    same: r(acc.same / n), sameLook: r(acc.sameLook / n), moved: r(acc.moved / n), only: r(acc.only / n),
    ghost: r(acc.ghost / n), unbodied: r(acc.unbodied / n), absent: r(acc.absent / n),
    movedMean: acc.moved ? r(acc.movedSum / acc.moved) : 0, pairD: acc.pairN ? r(acc.pairD / acc.pairN) : 0 };
  if (!quiet) console.log(out);
  return out;
}

// ---- the places and the looks ------------------------------------------------
// Palackého třída by the station: a signalled main street with side streets.
// ROAD is in the carriageway at a junction, KERB on the pavement 5 m off it.
export const ROAD = { x: -66, y: 0, z: -182 };
export const KERB = { x: -116, y: 0, z: -166 };
export const HERE = KERB;
const still = (p) => () => p;
const look = (p, dx, dz) => () => ({ x: p.x, z: p.z, dirX: dx, dirZ: dz });
const beside = (p, d = 3) => ({ ...p, x: p.x + d });
// driving together east along the street and back, v m/s
const along = (p, v, off = 0) => (s) => {
  const L = 600, u = ((s * v) % (2 * L));
  return { x: p.x + off + (u < L ? u : 2 * L - u) - L / 2, y: 0, z: p.z };
};
const lookAlong = (pos, v) => (s) => {
  const q = pos(s), L = 600, u = ((s * v) % (2 * L));
  return { x: q.x, z: q.z, dirX: u < L ? 1 : -1, dirZ: 0 };
};

export const SCENARIOS = {
  // side by side on the pavement, looking the same way
  together: () => ({ a: { pos: still(KERB), look: look(KERB, 1, 0) },
    b: { pos: still(beside(KERB)), look: look(beside(KERB), 1, 0) } }),
  // side by side, looking opposite ways
  backToBack: () => ({ a: { pos: still(KERB), look: look(KERB, 1, 0) },
    b: { pos: still(beside(KERB)), look: look(beside(KERB), -1, 0) } }),
  // 150 m apart along the street, facing each other
  apart: () => ({ a: { pos: still(KERB), look: look(KERB, 1, 0) },
    b: { pos: still(beside(KERB, 150)), look: look(beside(KERB, 150), -1, 0) } }),
  // one stands in the carriageway at a junction (queues form), the other watches from the kerb
  blocking: () => {
    const lane = { ...ROAD, half: 3.9 }, by = { ...ROAD, x: ROAD.x + 8, z: ROAD.z + 16 };
    return { a: { pos: still(lane), look: look(lane, 1, 0) }, b: { pos: still(by), look: look(by, -0.4, -0.9) } };
  },
  // 30 fps against 60 fps
  framerate: () => ({ a: { pos: still(KERB), look: look(KERB, 1, 0), hz: 30 },
    b: { pos: still(beside(KERB)), look: look(beside(KERB), -1, 0), hz: 60 } }),
  // the second player's page loads four minutes after the first
  lateJoin: () => ({ secs: 600, warm: 300, a: { pos: still(KERB), look: look(KERB, 1, 0) },
    b: { pos: still(beside(KERB)), look: look(beside(KERB), -1, 0), join: 240 } }),
  // the second player drives up from 1.4 km away and stops beside the first (there from second 130)
  approach: () => {
    const from = { ...KERB, x: KERB.x + 1400 }, to = beside(KERB);
    const pb = (s) => { const u = Math.min(1, s / 130); return { x: from.x + (to.x - from.x) * u, y: 0, z: KERB.z, half: u < 1 ? 3.9 : 2.3 }; };
    return { secs: 430, warm: 135, a: { pos: still(KERB), look: look(KERB, 1, 0) },
      b: { pos: pb, look: (s) => ({ x: pb(s).x, z: pb(s).z, dirX: -1, dirZ: 0 }) } };
  },
  // driving one behind the other at 40 km/h
  convoy: () => {
    const pa = along(ROAD, 11), pb = along(ROAD, 11, -18);
    return { a: { pos: (s) => ({ ...pa(s), half: 3.9 }), look: lookAlong(pa, 11) },
      b: { pos: (s) => ({ ...pb(s), half: 3.9 }), look: lookAlong(pb, 11) } };
  },
  // the tiles arrive in another order on the second client
  tileOrder: () => ({ order: [3, 1, 2, 0], a: { pos: still(KERB), look: look(KERB, 1, 0) },
    b: { pos: still(beside(KERB)), look: look(beside(KERB), -1, 0) } }),
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const maxCars = +(process.argv.find((a) => a.startsWith('--cars='))?.slice(7) ?? 96);
  const secs = +(process.argv.find((a) => a.startsWith('--secs='))?.slice(7) ?? 0);
  const room = !process.argv.includes('--solo');   // --solo: each client decides by its own camera, as before
  for (const name of want.length ? want : Object.keys(SCENARIOS)) {
    const sc = SCENARIOS[name]();
    console.log('---', name, `(maxCars ${maxCars})`);
    const o = compare({ maxCars, room, ...sc, ...(secs ? { secs } : {}), quiet: true });
    console.log(JSON.stringify(o));
  }
}
