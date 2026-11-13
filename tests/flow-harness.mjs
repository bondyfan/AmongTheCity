// ---- an hour of the real town, headless ------------------------------------
// Not a test: the bench the traffic and crowd tests share. It loads the real
// Pardubice tiles the way the game does (geo.loadCity over a file-backed
// fetch), builds the same Traffic, Pedestrians and city-life wiring main.js
// builds, stands a viewer on a pavement and runs the shared clock.
//
//   node tests/flow-harness.mjs [seconds] [place ...]
//
// prints, per place: share of cars standing, mean speed, trips that stood a
// minute or more, people killed and hit, and the local ghost count. ROOT=<dir>
// runs another checkout's js/ against this one's data, which is how a change is
// measured against the commit it started from.
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(HERE, '..');
const PUBLIC = path.resolve(HERE, '../public');
const js = (f) => pathToFileURL(path.join(ROOT, 'js', f)).href;

export const PLACES = {
  spawn: [25, -122], palackeho: [-66, -182], oldtown: [1690, -780],
};
export const T_NOON = 17_899_320;   // half past noon on the shared clock (a weekday)

let _boot = null;
/** The real city, once per process. */
export function bootCity() {
  return _boot ??= (async () => {
    register(pathToFileURL(path.join(HERE, 'three-alias.mjs')));
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (/^https?:/.test(u)) return { ok: false, status: 599 };
      try {
        const buf = await readFile(path.join(PUBLIC, u.replace(/^\//, '')));
        return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      } catch { return { ok: false, status: 404 }; }
    };
    globalThis.requestAnimationFrame = (cb) => { setImmediate(() => cb(0)); return 0; };
    globalThis.navigator ??= { hardwareConcurrency: 8 };
    const ctx2d = new Proxy({}, { get: (_, k) => k === 'measureText' ? () => ({ width: 200 })
      : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} })
        : k === 'canvas' ? { width: 1, height: 1 } : () => {}, set: () => true });
    globalThis.document ??= { createElement: () => ({ width: 1, height: 1, style: {}, getContext: () => ctx2d, toDataURL: () => '' }) };
    const log = console.log; console.log = () => {};          // the loaders are chatty
    const { loadCity } = await import(js('geo.js'));
    const city = await loadCity('data/manifest.json');
    console.log = log;
    return city;
  })();
}

export async function loadAround(city, x, z, ms = 60000) {
  const { CHUNK } = await import(js('config.js'));
  await city.ensureTiles(x, z);
  const t0 = Date.now();
  while (!city.chunkIndex.has(Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK))) {
    if (Date.now() - t0 > ms) throw new Error('tiles round ' + x + ',' + z + ' never indexed');
    await new Promise((r) => setTimeout(r, 40));
  }
}

const mesh = () => ({ position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
  rotation: { x: 0, y: 0, z: 0, set() {} }, userData: {}, add() {}, remove() {}, visible: true, traverse() {} });
export function stubVehicles() {
  return { scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading) {
      const big = kind === 'bus' ? [11, 2.5] : kind === 'truck' ? [8, 2.4] : kind === 'van' ? [5.4, 2] : [4.6, 1.8];
      const car = { mesh: mesh(), wheels: [], x, z, heading, speed: 0, steer: 0, kind,
        len: big[0], wid: big[1], ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car); return car;
    },
    remove(car) { this.cars.delete(car); } };
}

/** A spot near (x, z) that is on no carriageway: where the viewer stands. */
export function offRoad(city, x, z) {
  const clear = (px, pz) => {
    for (const r of city.roads) {
      if (r.d !== 1 || !r.p) continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        const ax = r.p[i][0], az = r.p[i][1], ex = r.p[i + 1][0] - ax, ez = r.p[i + 1][1] - az;
        const L2 = ex * ex + ez * ez || 1e-9;
        let q = ((px - ax) * ex + (pz - az) * ez) / L2; q = q < 0 ? 0 : q > 1 ? 1 : q;
        if (Math.hypot(px - ax - ex * q, pz - az - ez * q) < (r.w ?? 6) / 2 + 3) return false;
      }
    }
    return true;
  };
  for (let R = 0; R < 60; R += 4) for (let a = 0; a < 8; a++) {
    const px = x + Math.cos(a * Math.PI / 4) * R, pz = z + Math.sin(a * Math.PI / 4) * R;
    if (clear(px, pz)) return { x: px, z: pz };
  }
  return { x, z };
}

/**
 * Build the living town round `at` and return it with a step function.
 * opts: { t0, maxCars, peds, look: [dx, dz], spin }
 */
export async function makeTown(at, opts = {}) {
  const city = await bootCity();
  await loadAround(city, at[0], at[1]);
  const { Traffic } = await import(js('traffic.js'));
  const { Pedestrians } = await import(js('pedestrians.js'));
  const { wireCityLife } = await import(js('citylife.js'));
  const log = console.log; console.log = () => {};
  const vehicles = stubVehicles();
  const traffic = new Traffic(city, vehicles);
  const peds = new Pedestrians({ add() {}, remove() {} }, city);
  const life = wireCityLife({ city, traffic, peds });
  // the bus and trolleybus route files the game fetches as it streams
  // (js/realtransit.js): a run that steps the clock without ever yielding
  // would never see one arrive, so they are read in before the clock starts
  if (life.buses?.real) {
    for (const u of city.routeFilesNear(at[0], at[1], 4800)) {
      const r = await fetch(u);
      if (r.ok) life.buses.real.addFile(u, await r.json());
    }
  }
  console.log = log;
  let now = opts.t0 ?? T_NOON;
  traffic.clock = () => now; peds.clock = () => now;
  if (life.buses) life.buses.clock = () => now;
  traffic.maxCars = opts.maxCars ?? 240;     // the product's default slider
  peds.max = opts.peds ?? 34;
  const pos = offRoad(city, at[0], at[1]);
  const look = [...(opts.look ?? [1, 0])];
  const stats = { killed: 0, hit: 0, kills: [] };
  const cars = [];
  // what the walker was doing and what the driver knew, taken BEFORE the blow
  // lands (a hit cuts the body loose from its schedule), for whoever is debugging
  const hurt = peds.hurt.bind(peds);
  peds.hurt = (p, blow) => {
    const was = p.dead;
    const sc = p.sch, cross = sc?.cross ?? p.cross, arc = sc ? p.rArc : p.fArc;
    let onX = false, nearX = 1e9;
    for (const x of cross ?? []) {
      if (arc > x.g0 - 0.3 && arc < x.g1 + 0.3) onX = true;
      nearX = Math.min(nearX, Math.abs(arc - x.g0), Math.abs(arc - x.g1));
    }
    let told = false;
    for (const q of traffic.walkers ?? []) if (Math.hypot(q.x - p.x, q.z - p.z) < 1.5) told = true;
    const c = blow.by, a = c?.ai;
    // how far the walker and the car's centre are from the centreline the car drives
    let pd = -1, cd = -1;
    if (a?.edge) {
      const q = a.edge.pts; pd = cd = 1e9;
      for (let i = 0; i < q.length - 1; i++) {
        const ex = q[i + 1][0] - q[i][0], ez = q[i + 1][1] - q[i][1], L2 = ex * ex + ez * ez || 1e-9;
        for (const [o, set] of [[p, (v) => { if (v < pd) pd = v; }], [c, (v) => { if (v < cd) cd = v; }]]) {
          let t = ((o.x - q[i][0]) * ex + (o.z - q[i][1]) * ez) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          set(Math.hypot(o.x - q[i][0] - ex * t, o.z - q[i][1] - ez * t));
        }
      }
    }
    const rec = { pd, cd, lat: sc?.lat ?? p.side ?? 0, pair: sc?.pair ?? 0, kindAt: sc ? peds._arcAt(sc, now).kind : -1, t: now, x: p.x, z: p.z, v: c ? Math.abs(c.speed) : -1, ghost: !!a?.ghost, kind: c?.kind ?? '?',
      road: a?.edge?.road?.t ?? '', free: !!p.free, state: p.state, calm: p.calm > 0, onX, nearX, told, rush: p.rush ?? 0,
      pose: p.pose, lag: a && !a.ghost ? traffic._nomArc(a, now) - a.sR : 0,
      yield: a?.yieldT ?? 0, out: !!a?.yieldOut, blk: !!a?.blk, lane: a?.laneOff ?? 0, hw: (a?.edge?.road?.w ?? 0) / 2 };
    hurt(p, blow);
    if (p.dead && !was) stats.kills.push(rec);
  };
  peds.onPedKilled = () => { stats.killed++; };
  peds.onPedHit = () => { stats.hit++; };
  // Somebody standing in a street looks about: the camera turns once every
  // `spin` seconds (0: it stares one way for the whole run, which is the worst
  // case for cars that are only kept because they are being watched).
  const spin = opts.spin ?? 120, t00 = now;
  const step = (dt = 1 / 20) => {
    now += dt;
    if (spin) { const a = (now - t00) / spin * Math.PI * 2; look[0] = Math.cos(a); look[1] = Math.sin(a); }
    const view = { x: pos.x, z: pos.z, dirX: look[0], dirZ: look[1] };
    traffic.setViewer(view); peds.setViewer(view);
    traffic.update(dt, pos, null);
    life.update(dt, pos, ((now / 1440) % 1 + 1) % 1);
    // every car, ghosts too: that is what main.js passes in a solo game
    cars.length = 0;
    for (const c of traffic.cars) cars.push(c);
    peds.cars = cars;
    peds.playerCar = null;
    peds.update(dt, pos);
  };
  return { city, traffic, peds, life, vehicles, pos, stats, step, now: () => now, at: (t) => { now = t; } };
}

/** Run `secs` of town at `at` and measure how the traffic flowed. Once per process (see the CLI). */
export async function measure(at, secs = 3600, opts = {}) {
  const w = await makeTown(at, opts);
  const stood = new Map();
  let samples = 0, cars = 0, stopped = 0, vsum = 0, ghosts = 0, stuck = 0, bodies = 0;
  const R = opts.r ?? 300;
  for (let i = 1; i <= secs * 20; i++) {
    w.step(1 / 20);
    if (i % 20) continue;
    samples++;
    ghosts += w.traffic._ghosts.size;
    bodies += w.peds.peds.length;
    for (const c of w.traffic.cars) {
      const p = c.ai;
      if (Math.hypot(c.x - w.pos.x, c.z - w.pos.z) > R) continue;
      if (p && p.fixed && p.atStop >= 0) continue;          // a bus with its doors open is not a jam
      cars++; vsum += Math.abs(c.speed);
      if (Math.abs(c.speed) < 0.5) {
        stopped++;
        const n = (stood.get(c) ?? 0) + 1;
        stood.set(c, n);
        if (n === 60) stuck++;
      } else stood.delete(c);
    }
  }
  return { cars: cars / samples, stoppedShare: stopped / Math.max(1, cars), meanV: vsum / Math.max(1, cars),
    stuck, killed: w.stats.killed * 3600 / secs, hit: w.stats.hit * 3600 / secs,
    ghosts: ghosts / samples, bodies: bodies / samples };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secs = +(process.argv[2] ?? 3600);
  const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(PLACES);
  // one process per place: a road is ingested by the first Traffic that sees
  // it (r._tg), so a second town in the same process has no streets
  if (names.length > 1) {
    const { spawnSync } = await import('node:child_process');
    for (const n of names) spawnSync(process.execPath, [process.argv[1], String(secs), n], { stdio: 'inherit' });
    process.exit(0);
  }
  for (const n of names) {
    const t0 = Date.now();
    const m = await measure(PLACES[n], secs);
    console.log(`${n.padEnd(10)} cars ${m.cars.toFixed(0).padStart(3)}  stopped ${(m.stoppedShare * 100).toFixed(1).padStart(5)} %  mean ${(m.meanV * 3.6).toFixed(1).padStart(5)} km/h  stuck>=60s ${String(m.stuck).padStart(3)}  killed/h ${m.killed.toFixed(1)}  hit/h ${m.hit.toFixed(1)}  ghosts ${m.ghosts.toFixed(1)}  bodies ${m.bodies.toFixed(0)}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  process.exit(0);
}
