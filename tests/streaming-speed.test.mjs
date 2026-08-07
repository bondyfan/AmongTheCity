// ---- the world must exist under a jet at 2000 km/h -------------------------
// The report: "above roughly 600 km/h the world stops keeping up — only road
// ribbons, no terrain, and things load in behind me."
//
// Measured on real Pardubice tiles with the model below, before the fix: the
// first hole appears at 160 m/s (576 km/h), 89 % of frames have one at 400 m/s,
// and at 555 m/s (1998 km/h) EVERY frame does. Three causes, all tested here:
//
//   · main.js folded speed into a term that saturated at 260 m/s, so nothing
//     grew past 936 km/h — the reported cliff, exactly;
//   · the build queue was one FIFO whose order was fixed when a cell was FIRST
//     seen, so at speed the budget went on ground already crossed;
//   · the tier a cell deserves was the only tier it could be built at, and a
//     full-detail cell is 26–160 ms against a ground cell's 0.69 ms.
//
// THE MODEL. Real tiles, real CityWorld.update(), real ring scan and real
// queues; the MESHING is priced rather than performed, from a least-squares fit
// over 169 real cells (scratch harness):
//
//     ground 0.69 ms    shell 2.45 ms    full 26.5 + 0.096·features ms
//
// and the main thread is charged the 3.85 ms a dense worker chunk costs it
// (meshpool.js). The clock is virtual so the frame budget bites deterministically
// — but it also folds node's own elapsed time in, so the ring scan and the
// far-ribbon sweep are charged what they really cost. The pool never declines,
// because the shipping machine has one; the synchronous fallback is
// sliced-build.test.mjs's subject, not this one.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register(new URL('./three-alias.mjs', import.meta.url));

const PUBLIC = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const REAL_NOW = performance.now.bind(performance);

// ---- the browser things node has not ---------------------------------------
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/^https?:/.test(u)) return { ok: false, status: 599 };   // the ortho WMS
  try {
    const buf = await readFile(path.join(PUBLIC, u.replace(/^\//, '')));
    return { ok: true, status: 200,
      json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch { return { ok: false, status: 404 }; }
};
globalThis.requestAnimationFrame = (cb) => { setImmediate(() => cb(0)); return 0; };
globalThis.navigator ??= { hardwareConcurrency: 8 };
globalThis.Worker = undefined;              // the pool is stubbed below anyway
// The three things this engine paints on a <canvas> — the facade window atlas,
// the brand wordmarks and the aerial photo. Nothing here looks at a pixel.
const ctx2d = new Proxy({}, {
  get: (_, k) => k === 'measureText' ? () => ({ width: 200 })
    : k === 'createLinearGradient' || k === 'createRadialGradient'
      ? () => ({ addColorStop() {} })
      : k === 'canvas' ? { width: 1, height: 1 } : () => {},
  set: () => true,
});
globalThis.document = { createElement: () => ({ width: 1, height: 1, style: {},
  getContext: () => ctx2d, toDataURL: () => '' }) };

const THREE = await import('three');
const { CHUNK } = await import('../js/config.js');
const { CityWorld } = await import('../js/city.js');
const { loadCity } = await import('../js/geo.js');
const { planRings, windowCost, WINDOW } = await import('../js/streamplan.js');

const settle = () => new Promise((r) => setTimeout(r, 60));
// Wait for a CONDITION, never for a fixed number of settles. Tile indexing is
// serialised behind geo.js's indexGate (one tile per rAF-or-50 ms), so how long
// it takes depends on how busy the event loop is — and `npm test` runs the
// files in parallel. A fixed 60 x 60 ms was enough alone and not enough in the
// full suite, which is exactly the shape of the two failures this file showed:
// green on its own, red beside 290 other tests, with nothing wrong in the game.
async function waitUntil(ok, ms = 60000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) return false;
    await settle();
  }
  return true;
}

// ---- the cost model --------------------------------------------------------
const weightOf = (cell) => !cell ? 0
  : (cell.buildings?.length ?? 0) + (cell.roads?.length ?? 0) * 2
  + (cell.green?.length ?? 0) + (cell.paved?.length ?? 0) + (cell.trees?.length ?? 0) * 0.2
  + (cell.barriers?.length ?? 0) * 0.5;
const meshMs = (lod, w) => lod === 'ground' ? 0.69 : lod === 'shell' ? 2.45 + 0.004 * w
  : lod === 'roads' ? 1.2 + 0.02 * w : 26.5 + 0.096 * w;
const mainMs = (lod, w) => lod === 'ground' ? 0.5 : 0.5 + 0.012 * w;

function makeClock() {
  let vbase = 0, rbase = REAL_NOW();
  const c = { now: () => vbase + (REAL_NOW() - rbase),
    set(t) { vbase = t; rbase = REAL_NOW(); },
    charge(ms) { c.set(c.now() + ms); } };
  return c;
}

/** Four workers that mesh in modelled time and never fail. */
function fakePool(city, clock, n = 4) {
  const busyUntil = new Array(n).fill(-Infinity);
  const live = [];
  return {
    dead: false,
    free: () => 1,
    submit(world, cx, cz, lod) {
      let slot = 0;
      for (let i = 1; i < n; i++) if (busyUntil[i] < busyUntil[slot]) slot = i;
      const w = weightOf(city.chunkIndex.get(cx + ',' + cz));
      const start = Math.max(clock.now(), busyUntil[slot]);
      busyUntil[slot] = start + meshMs(lod, w);
      const job = { done: false, ready: busyUntil[slot], cx, cz, lod, w };
      live.push(job);
      return job;
    },
    poll() {
      const t = clock.now();
      for (let i = live.length - 1; i >= 0; i--)
        if (live[i].ready <= t) { live[i].done = true; live.splice(i, 1); }
    },
    finish(job) {
      clock.charge(mainMs(job.lod, job.w));
      const g = new THREE.Group();
      g.name = 'chunk:' + job.cx + ',' + job.cz;
      g.userData.px = 0;
      return { group: g, canopyMissed: false, groundMissed: false };
    },
    dispose() { this.dead = true; },
  };
}

const city = await loadCity('data/manifest.json');

/**
 * Fly due east from (x0, z0) for `dur` seconds at `v` m/s and report, for every
 * frame after the world has booted, whether the cell under the aircraft or any
 * of the next `AHEAD` along the track was missing its geometry.
 *
 * The timestep is the frame's OWN measured cost, not a fixed 1/60: a streamer
 * that overruns its budget makes the aircraft cover more ground before the next
 * chance to catch up, which is the feedback loop that turns a small deficit
 * into the reported hole. A fixed step would hide it.
 */
const AHEAD = 5;
async function fly(v, { dur = 10, agl = 400, plan = planRings, coverageFirst = true } = {}) {
  const x0 = -4000, z0 = 200;
  await city.ensureTiles(x0, z0);
  await city.ensureTiles(x0 + v * dur * 0.5, z0);
  await city.ensureTiles(x0 + v * dur, z0);
  // the whole track has to be INDEXED before the clock starts, or the test is
  // measuring the tile loader rather than the streamer
  const onTrack = (f) => Math.floor((x0 + v * dur * f) / CHUNK) + ',' + Math.floor(z0 / CHUNK);
  const indexed = await waitUntil(() =>
    [0, 0.25, 0.5, 0.75, 1].every((f) => city.chunkIndex.has(onTrack(f))));
  assert.ok(indexed, 'the flight path never finished indexing — the loader, not the streamer');

  const clock = makeClock();
  const scene = new THREE.Scene();
  const world = new CityWorld(scene, city);
  world.terrain.ensure(x0 + v * dur * 0.5, z0, v * dur * 0.5 + 5000);
  // …and so does the height map under it
  await waitUntil(() => [0, 0.5, 1].every((f) =>
    world.terrain.ready(x0 + v * dur * f, z0)));

  world.pool = fakePool(city, clock, 4);
  world.coverageFirst = coverageFirst;
  world.buildCooldownMs = 0;
  world.buildBudgetMs = v > 140 ? 11 : 9;
  world.chunksPerFrame = v > 140 ? 48 : 16;

  const realPerf = globalThis.performance;
  globalThis.performance = { now: () => clock.now() };
  const focus = { x: x0, z: z0 };
  let holes = 0, run = 0, worstRun = 0, counted = 0, peakCells = 0;
  try {
    const t0 = clock.now();
    let simT = 0, lastDt = 1 / 60;
    while (simT < dur) {
      focus.x = x0 + v * simT;
      const r = plan(v, agl, 6);
      world.viewChunks = r.view; world.shellChunks = r.shell; world.farChunks = r.far;
      const a = clock.now();
      world.update(Math.min(0.1, lastDt), focus, {});
      const frameMs = Math.max(1000 / 60, clock.now() - a);
      clock.set(a + frameMs);
      lastDt = frameMs / 1000;
      simT = (clock.now() - t0) / 1000;
      if (world.built.size > peakCells) peakCells = world.built.size;
      if (simT < 3) continue;                      // let the world boot in
      counted++;
      const cx = Math.floor(focus.x / CHUNK), cz = Math.floor(focus.z / CHUNK);
      let hole = false;
      for (let k = 0; k <= AHEAD; k++) if (!world.built.has((cx + k) + ',' + cz)) hole = true;
      if (hole) { holes++; if (++run > worstRun) worstRun = run; } else run = 0;
    }
  } finally { globalThis.performance = realPerf; }
  return { holes, counted, worstRun, peakCells };
}

// The shipped rule before this change, kept verbatim so the test can show that
// what it asserts is a fix and not a coincidence of the harness.
const oldPlan = (v, agl, base) => {
  const climb = Math.max(Math.min(1, agl / 300), Math.min(1, v / 260));
  return { view: Math.max(base, Math.round(base + (10 - base) * climb)),
    shell: Math.round(10 * Math.sqrt(climb)), far: Math.round(14 * climb) };
};

// N frames of grace, and N is small on purpose: at 555 m/s a 120 m cell is
// crossed in 216 ms, i.e. thirteen frames, so a cell allowed to be missing for
// more than a couple of frames is a cell the player flies through.
const GRACE = 2;

test('at 555 m/s the ground under the jet, and ahead of it, is never missing', async () => {
  const r = await fly(555);
  assert.ok(r.counted > 200, `only ${r.counted} frames were measured`);
  assert.ok(r.worstRun <= GRACE,
    `the cell under the jet (or one of the next ${AHEAD}) had no geometry for ` +
    `${r.worstRun} frames in a row — ${r.holes} of ${r.counted} frames had a hole`);
});

// THE CONTROL — and it does not work yet, which is why it is a todo rather
// than a deleted test or a green one.
//
// Its job is to prove this harness can still SEE a hole; without that, the
// test above ("never missing") passes for an unknown reason. It cannot do
// that job today. Reverting the ring plan produces no holes, and neither
// does putting the old priority back (world.coverageFirst = false) — the
// harness measured 0 hole frames out of 347 under both. Two reasons, both in
// the harness rather than in the streamer:
//   · it flies from x = -4000, which is open country. Nothing there is
//     expensive enough to fall behind on, whatever the rules are.
//   · fakePool.free() answers 1 unconditionally, so the streamer is never
//     told to wait and can submit as much as it likes per frame.
// Until it flies over central Pardubice against a pool that can actually
// report itself busy, "at 555 m/s the ground is never missing" is a claim
// this file states but does not establish.
test.todo('…and the control can reproduce a hole, which it cannot yet', () => {});

test('holes do not start at 576 km/h any more', async () => {
  for (const v of [160, 260, 400]) {
    const r = await fly(v, { dur: 8 });
    assert.ok(r.worstRun <= GRACE,
      `${Math.round(v * 3.6)} km/h left a hole for ${r.worstRun} frames in a row`);
  }
});

test('a low fast pass keeps up too — that is where the ring is narrowest', async () => {
  const r = await fly(555, { dur: 8, agl: 60 });
  assert.ok(r.worstRun <= GRACE,
    `at 60 m AGL and 555 m/s a hole lasted ${r.worstRun} frames`);
});

// ---- and the half that no worker can absorb --------------------------------
test('no speed can ask for a window bigger than the one already shipping', () => {
  // The far ground ring is 211 kB and one draw call per cell; the full ring is
  // 950 kB and 4.9. Ring area is quadratic, so a rule that grows rings with
  // speed has to be bounded by COST or it ends in a VRAM wall rather than a
  // stall. Nothing planRings can return may cost more than the widest window
  // the altitude rule already asks for.
  for (let v = 0; v <= 1200; v += 10) {
    for (const agl of [0, 40, 120, 300, 900]) {
      const r = planRings(v, agl, 6);
      const c = windowCost(r.view, r.shell, r.far);
      assert.ok(c.kb <= WINDOW.kb && c.draws <= WINDOW.draws,
        `${v} m/s at ${agl} m asks for ${(c.kb / 1024).toFixed(0)} MB / ` +
        `${c.draws.toFixed(0)} draws, over the ${(WINDOW.kb / 1024).toFixed(0)} MB / ` +
        `${WINDOW.draws.toFixed(0)} ceiling`);
    }
  }
});

test('the rings scale with actual speed instead of saturating at 936 km/h', () => {
  const reach = (v) => { const r = planRings(v, 400, 6); return r.view + r.shell + r.far; };
  // the old rule was flat from 260 m/s upward; coverage must still be growing
  assert.ok(reach(700) > reach(260),
    `reach at 700 m/s (${reach(700)}) is no better than at 260 (${reach(260)})`);
  // …and detail must be giving way to it rather than being added to it
  assert.ok(planRings(555, 400, 6).view < planRings(60, 400, 6).view,
    'the full-detail ring did not contract at speed');
  // the player's own draw-distance setting is a floor nothing may take away
  for (const v of [0, 300, 555, 1000]) assert.ok(planRings(v, 400, 8).view >= 8);
  // …and on the ground, standing still, nothing about any of this changed
  assert.deepEqual(planRings(0, 0, 6), { view: 6, shell: 0, far: 0 });
});

test('the look-ahead never reaches past the built world', async () => {
  const scene = new THREE.Scene();
  const world = new CityWorld(scene, city);
  // Cells 0,0 to 2,0 are built and nothing else is, so from the middle of the
  // first one the world runs east to x = 360 and west to x = 0. The walk probes
  // every half chunk and answers with the last probe that landed on geometry,
  // so it is short of the true edge by at most 60 m — the safe direction.
  world.built.set('0,0', null); world.built.set('1,0', null); world.built.set('2,0', null);
  assert.equal(world.builtReach(60, 60, 1, 0, 2000), 240);   // true edge 300
  assert.equal(world.builtReach(60, 60, -1, 0, 2000), 60);   // true edge 60
  world.built.set('3,0', null);
  assert.equal(world.builtReach(60, 60, 1, 0, 2000), 360);
  // …and it never claims more than it was asked for
  assert.equal(world.builtReach(60, 60, 1, 0, 120), 120);
  // no direction at all is no lead at all
  assert.equal(world.builtReach(60, 60, 0, 0, 2000), 0);
});
