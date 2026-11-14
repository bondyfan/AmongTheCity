// ---- how the AI cars move, headless ---------------------------------------
// Not a test: the bench tests/aidriver.test.mjs and a human share. It runs the
// real town (tests/flow-harness.mjs makeTown) and samples every RENDERED car
// within R of the viewer at 20 Hz, the way the screen sees it:
//
//   node tests/aidrive-harness.mjs [seconds] [place]
//
// prints yaw rate and lateral acceleration (p50, p99, max over cars), the
// speed cars hold through real corners, how far a car's centre strays from the
// lane it is meant to be in, and the flow numbers flow-harness prints. ROOT=<dir>
// runs another checkout's js/ against this one's data (before against after).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTown, PLACES } from './flow-harness.mjs';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0);

/** Distance of (x, z) from an edge's centreline, signed + to the right of travel. */
function sideOf(e, x, z) {
  const P = e.pts;
  let best = 1e9, side = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const ax = P[i][0], az = P[i][1], ex = P[i + 1][0] - ax, ez = P[i + 1][1] - az;
    const L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - ax - ex * t, dz = z - az - ez * t, d = Math.hypot(dx, dz);
    if (d < best) { best = d; const L = Math.sqrt(L2); side = (dx * -ez + dz * ex) / L >= 0 ? 1 : -1; }
  }
  return best * side;
}

/** Is (x, z) on asphalt: a carriageway any edge of the graph draws, or a junction pad. */
function onAsphalt(T, x, z, tol) {
  let hit = false;
  T._egrid.near(x, z, (e) => {
    if (hit) return;
    const half = (e.road?.w || 6) * 0.5 + tol, P = e.pts;
    for (let i = 0; i < P.length - 1 && !hit; i++) {
      const ax = P[i][0], az = P[i][1], ex = P[i + 1][0] - ax, ez = P[i + 1][1] - az;
      const L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - ax - ex * t, z - az - ez * t) < half) hit = true;
    }
  });
  return hit || T._onPad(x, z);
}

export async function drive(at, secs = 300, opts = {}) {
  const w = await makeTown(at, opts);
  const R = opts.r ?? 250, dt = 1 / 20;
  const prev = new Map();
  const yaw = [], alat = [], dev = [], corner = [];
  let samples = 0, cars = 0, stopped = 0, vsum = 0, stuck = 0, offLane = 0, offRoad = 0, phys = 0, nAsph = 0, offC = 0, offK = 0;
  const stood = new Map(), worst = new Map();
  for (let i = 1; i <= secs * 20; i++) {
    w.step(dt);
    const sampleFlow = i % 20 === 0;
    if (sampleFlow) samples++;
    for (const c of w.traffic.cars) {
      const p = c.ai;
      if (!p || Math.hypot(c.x - w.pos.x, c.z - w.pos.z) > R) { prev.delete(c); continue; }
      const q = prev.get(c);
      if (q) {
        const r = wrap(c.heading - q.h) / dt;
        const vx = (c.x - q.x) / dt, vz = (c.z - q.z) / dt;
        const v = Math.hypot(vx, vz);
        if (q.vx !== undefined && v < 60) {
          // lateral acceleration of the rendered pose: the change of ground
          // velocity, perpendicular to it
          const ax = (vx - q.vx) / dt, az = (vz - q.vz) / dt;
          const al = v > 0.5 ? Math.abs(ax * -vz + az * vx) / v : 0;
          if (!(c._rammedT > 0) && !p.wreck) {
            yaw.push(Math.abs(r)); alat.push(al);
            const wk = worst.get(c) ?? { r: 0, a: 0 };
            if (Math.abs(r) > wk.r) wk.r = Math.abs(r);
            if (al > wk.a) wk.a = al;
            worst.set(c, wk);
          }
          if (Math.abs(r) > 0.25 && v > 1) corner.push(v);
        }
        q.x = c.x; q.z = c.z; q.h = c.heading; q.vx = vx; q.vz = vz;
      } else prev.set(c, { x: c.x, z: c.z, h: c.heading });
      if (p.body && p.body.phys) phys++;
      // on the asphalt: the centre, and every corner of the body within 0.4 m
      if (!(c._rammedT > 0) && !p.wreck && i % 5 === 0) {
        nAsph++;
        if (!onAsphalt(w.traffic, c.x, c.z, 0)) offC++;
        const fx = -Math.sin(c.heading), fz = -Math.cos(c.heading), hl = (c.len ?? 4.6) / 2, hw = (c.wid ?? 1.8) / 2;
        let out = false;
        for (const [a, b2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
          if (!out && !onAsphalt(w.traffic, c.x + fx * hl * a - fz * hw * b2, c.z + fz * hl * a + fx * hw * b2, 0.4)) out = true;
        if (out) offK++;
      }
      // lane keeping: the centre's offset from the lane it should hold, away
      // from the nodes (inside a junction box there is no lane to hold)
      const e = p.edge;
      if (e && !(c._rammedT > 0) && !p.wreck && p.s > 8 && e.len - p.s > 8) {
        const d = sideOf(e, c.x, c.z) - (p.laneOff ?? 0);
        dev.push(Math.abs(d));
        if (Math.abs(d) > 1.2) offLane++;
        if (Math.abs(sideOf(e, c.x, c.z)) + (c.wid ?? 1.8) / 2 > e.road.w / 2 + 0.4) offRoad++;
      }
      if (sampleFlow && !(p.fixed && p.atStop >= 0)) {
        cars++; vsum += Math.abs(c.speed);
        if (Math.abs(c.speed) < 0.5) {
          stopped++;
          const n = (stood.get(c) ?? 0) + 1; stood.set(c, n);
          if (n === 60) stuck++;
        } else stood.delete(c);
      }
    }
  }
  const s = (a) => a.sort((x, y) => x - y);
  s(yaw); s(alat); s(dev); s(corner);
  const wr = s([...worst.values()].map((k) => k.r)), wa = s([...worst.values()].map((k) => k.a));
  return {
    cars: cars / samples, stoppedShare: stopped / Math.max(1, cars), meanV: vsum / Math.max(1, cars), stuck,
    yaw50: pct(yaw, 0.5), yaw99: pct(yaw, 0.99), yawMaxCarP50: pct(wr, 0.5), yawMaxCarP90: pct(wr, 0.9), yawMax: wr[wr.length - 1] ?? 0,
    alat99: pct(alat, 0.99), alatMaxCarP50: pct(wa, 0.5), alatMaxCarP90: pct(wa, 0.9),
    dev50: pct(dev, 0.5), dev99: pct(dev, 0.99), offLane: offLane / Math.max(1, dev.length), offRoad: offRoad / Math.max(1, dev.length),
    offCentre: offC / Math.max(1, nAsph), offCorner: offK / Math.max(1, nAsph),
    cornerV50: pct(corner, 0.5), cornerV90: pct(corner, 0.9),
    phys: phys / Math.max(1, secs * 20), killed: w.stats.killed * 3600 / secs, hit: w.stats.hit * 3600 / secs,
    ghosts: w.traffic._ghosts.size,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secs = +(process.argv[2] ?? 300);
  const name = process.argv[3] ?? 'palackeho';
  const t0 = Date.now();
  const m = await drive(PLACES[name], secs);
  const f = (v, d = 2) => v.toFixed(d);
  console.log(`${name}  cars ${f(m.cars, 0)}  stopped ${f(m.stoppedShare * 100, 1)} %  mean ${f(m.meanV * 3.6, 1)} km/h  stuck>=60s ${m.stuck}  killed/h ${f(m.killed, 1)}  hit/h ${f(m.hit, 1)}`);
  console.log(`  yaw rad/s  p50 ${f(m.yaw50)}  p99 ${f(m.yaw99)}  per-car max p50 ${f(m.yawMaxCarP50)} p90 ${f(m.yawMaxCarP90)} worst ${f(m.yawMax)}`);
  console.log(`  lat m/s2   p99 ${f(m.alat99)}  per-car max p50 ${f(m.alatMaxCarP50)} p90 ${f(m.alatMaxCarP90)}`);
  console.log(`  lane dev m p50 ${f(m.dev50)}  p99 ${f(m.dev99)}  off-lane ${f(m.offLane * 100, 2)} %  off-road ${f(m.offRoad * 100, 2)} %`);
  console.log(`  asphalt    centre off ${f(m.offCentre * 100, 2)} %  a corner over the kerb ${f(m.offCorner * 100, 2)} %`);
  console.log(`  corner v   p50 ${f(m.cornerV50 * 3.6, 1)} km/h  p90 ${f(m.cornerV90 * 3.6, 1)} km/h   physics cars/frame ${f(m.phys, 1)}  ghosts ${m.ghosts}  (${f((Date.now() - t0) / 1000, 0)} s)`);
  process.exit(0);
}
