// ---- the mesher pool: chunks built somewhere that is not the frame ----------
// js/meshworker.js does the work; this is the main-thread half. Its whole job
// is to keep the frame's share of a chunk down to three small things —
// gathering the spec, posting it, and decoding the bytes that come back —
// and to hand the streamer a synchronous fallback the moment any of that
// stops being possible.
//
// MEASURED, ten densest chunks of central Pardubice, facades on:
//   sync build   79.5 ms of main thread a chunk (179 ms on the worst one)
//   worker path   3.85 ms — 1.7 ms gathering the spec, 1.8 ms postMessage,
//                 0.15 ms decoding. 20.6× less, and none of it is a slice
//                 that has to be resumed on the next frame.
//
// WHY THE FALLBACK IS NOT OPTIONAL. This project runs two ways: under vite,
// which resolves the bare `three` specifier for the worker as it does for the
// page, and straight off the filesystem, where the page's <script
// type="importmap"> covers itself and NOT its workers — a module worker does
// not inherit an import map. There the worker fails to load, onerror fires,
// the pool retires itself and every chunk is built the old way. Same road out
// for a browser with no Worker at all, a postMessage that throws, or a build
// that comes back as an error.

import { chunkSpec } from './chunkspec.js';
import { pinStores } from './stores/landmark.js';
import { decode } from './geomcodec.js';
import { facadeMaterial, brandMarkMat } from './meshes.js';
import { mergeMarks } from './wordmarkatlas.js';
import { BATCH } from './batchflags.js';
import { regionId, DEFAULT_REGION } from './regions.js';

/** Hard ceiling on workers. Past four the queue is never the bottleneck. */
const MAX_WORKERS = 4;
// A build that has not answered in this long is treated as lost and rebuilt
// synchronously. Nothing should ever hit it — it exists so a worker that dies
// silently costs one chunk instead of leaving a hole in the world forever.
const WATCHDOG_MS = 8000;
// A worker that has not finished LOADING is a different animal from one that
// has stopped answering: its module graph is fetched file by file under the
// dev server, behind the boot's own tile fetches. It is given no work until it
// says 'ready' (see the end of js/meshworker.js) and it is only written off
// after this much longer wait.
const LOAD_MS = 60000;
// The watchdog counts time the main thread could actually have HEARD an
// answer in. poll() runs once a frame; after a long stall (tile indexing at
// boot, a tab coming back from the background) the frame callback can run
// before the message events that queued up behind it, and a plain wall-clock
// test then retired healthy workers whose answers were already in the queue.
// So one poll never adds more than this to a wait.
const STALL_CAP_MS = 250;
// ...AND ONLY TIME THE LINE WAS PROVEN OPEN. A worker's reply is a task on
// this thread's queue, and it is delivered when the tasks in front of it have
// run, not when it was posted. Measured in wave 3, in the automation pane
// every engineer of this project verifies in: the frame pump that pane needs
// had filled the queue with whole frames of work, a worker's reply reached
// this thread 3.2 to 4.4 s after it was posted and a worker that does nothing
// but answer took 6.6 s to start. Frames kept coming at full rate the whole
// time. A chunk's round trip was then longer than a wall-clock watchdog, three
// healthy workers were retired one after another, and the session (in the
// build before this work as well) meshed everything on the main thread. A
// player's browser has no such pump, but a thread whose queue is backed up for
// any reason has the same shape, and silence is only evidence against a worker
// while the line is known to be carrying messages. So every worker is pinged a
// few times a second (it answers between chunks), ANY message from ANY worker
// is proof the line delivers, and the clocks below only advance on a poll that
// has such proof. One worker stuck in a loop is still caught in 8 s, because
// the other three keep answering. Total silence gets this much grace before
// the clocks run on their own again, which is what catches a pool of one that
// has died.
const PING_MS = 120;
// A ping that takes this long to come back means a chunk sent to a worker is
// seconds away however fast the worker is. The streamer stops queueing behind
// the workers then and starts cells on its own thread again, as it used to.
const SLOW_MS = 1500;
const SILENT_MS = 20000;

export function poolSize(max = MAX_WORKERS) {
  // …minus one, because the main thread is still rendering. `-1` on a 2-core
  // machine leaves one, which is the floor.
  const hw = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(max, hw - 1));
}

/**
 * @param {object} opts
 *   `spawn()` builds one Worker — overridable so a test can drive the pool
 *   without a DOM Worker (and so a spawn that throws is a normal, tested path).
 */
export function makeMeshPool(opts = {}) {
  // (the worker reads its region from its own URL, js/regions.js: the trees
  // and anything else that differs by region must grow the same on both sides)
  const workerUrl = () => {
    const u = new URL('./meshworker.js', import.meta.url);
    if (regionId() !== DEFAULT_REGION) u.searchParams.set('region', regionId());
    return u;
  };
  const spawn = opts.spawn ?? (() => new Worker(workerUrl(), { type: 'module' }));
  const now = opts.now ?? (() => performance.now());
  const workers = [];
  let nextId = 1;

  const pool = {
    /** Retired: every chunk goes down the synchronous path from here on. */
    dead: false,
    get size() { return workers.length; },
    /** How many chunks could be started right now. */
    free() {
      return pool.dead ? 0 : workers.reduce((n, h) => n + (h.ready && !h.flight ? 1 : 0), 0);
    },
    /** Workers that have loaded and said so. Zero for the first moments of a boot. */
    get ready() { return workers.reduce((n, h) => n + (h.ready ? 1 : 0), 0); },
    /** Chunks the workers have answered since the pool was made (for diagnostics). */
    answered: 0,
    /** The last ping's round trip, ms: the worker's wait behind a chunk plus the line. */
    rtt: 0,
    /** The line is too slow to be worth waiting on (see workersFirst in js/city.js). */
    get slow() { return pool.rtt > SLOW_MS; },
    submit, finish, poll, dispose,
  };
  let lastPoll = now();
  let heard = false;            // a message arrived since the last poll
  let lastHeard = now();        // when the line last proved itself

  for (let i = 0; i < poolSize(opts.max ?? MAX_WORKERS); i++) {
    try {
      const h = { w: spawn(), flight: null, ready: false, waited: 0, pingAt: -1e9, pingOut: false,
        // What this worker's raster mirror holds. The ledger and the worker's
        // own Map are written from the SAME put/drop list in the same message,
        // which is the only reason the two can be trusted to agree.
        have: { terrain: new Map(), canopy: new Map() } };
      h.w.onmessage = (e) => onReply(h, e.data);
      h.w.onerror = (e) => { e.preventDefault?.(); retire(h, 'worker failed to load'); };
      h.w.onmessageerror = () => retire(h, 'message could not be deserialised');
      workers.push(h);
    } catch (err) {
      // No Worker in this browser, or the script is unreachable. One is enough
      // to know; the streamer keeps its synchronous path either way.
      console.warn('meshpool: no mesher workers —', err?.message ?? err);
      break;
    }
  }
  if (!workers.length) pool.dead = true;

  function retire(h, why) {
    const i = workers.indexOf(h);
    if (i >= 0) workers.splice(i, 1);
    if (h.flight) { h.flight.error = why; h.flight.done = true; h.flight = null; }
    try { h.w.terminate(); } catch { /* already gone */ }
    if (!workers.length) {
      pool.dead = true;
      console.warn('meshpool: retired the last mesher worker —', why);
    }
  }

  function onReply(h, msg) {
    heard = true;
    if (msg?.t === 'ready') { h.ready = true; h.waited = 0; return; }
    if (msg?.t === 'pong') {
      // the ping's own send time comes back with it: a ping re-sent while an
      // older one was still on its way must not make the line look quick
      h.pingOut = false;
      if (typeof msg.at === 'number') pool.rtt = now() - msg.at;
      return;
    }
    const f = h.flight;
    if (!f || msg?.id !== f.id) return;          // a reply to a lost build
    h.flight = null;
    if (msg.t === 'fail') f.error = msg.error;
    else { f.reply = msg; pool.answered++; }
    f.done = true;
  }

  /**
   * Start one chunk. Returns the flight (poll `.done`, then call finish) or
   * null when this build cannot go to a worker at all — no idle one, no city
   * data for the cell, or a spec that could not be gathered. Null always means
   * "build it the old way", never "it is under way somewhere".
   */
  function submit(world, cx, cz, lod) {
    if (pool.dead) return null;
    // only a worker that has finished loading: one that has not would sit on
    // the chunk for as long as its imports take, with the cell stuck in flight
    const h = workers.find((x) => x.ready && !x.flight);
    if (!h) return null;
    let got;
    try {
      // a store's front wall and drive-through are decided here, before the copy
      pinStores(world.city.chunkIndex.get(cx + ',' + cz));
      got = chunkSpec(world, cx, cz, lod, h.have);
    } catch (err) {
      // A cache that is not plain data. Loud, once — the chunk still gets built.
      console.warn('meshpool: spec refused, building on the main thread —', err?.message ?? err);
      return null;
    }
    if (!got) return null;                       // outside the mapped city
    const f = { id: nextId++, cx, cz, lod, ortho: got.ortho, at: now(), waited: 0,
      done: false, reply: null, error: null };
    try {
      h.w.postMessage({ t: 'build', id: f.id, spec: got.spec }, got.transfer);
    } catch (err) {
      // The ledger now claims this worker holds rasters it never received, so
      // the worker goes rather than the ledger being unpicked.
      retire(h, `postMessage: ${err?.message ?? err}`);
      return null;
    }
    h.flight = f;
    return f;
  }

  /**
   * Turn a finished flight into a Group. Throws if the build failed, so the
   * caller can fall back on the one path that always works.
   * @returns {{group: THREE.Group|null, canopyMissed: boolean, groundMissed: boolean}}
   */
  function finish(f, mats) {
    if (f.error) throw new Error(f.error);
    const r = f.reply;
    if (r.empty) return { group: null, canopyMissed: false, groundMissed: false };
    resolveMaterials(r, f.ortho, mats);
    const group = decode(r.payload, mats);
    // the worker sent one quad stream per chain; here, where the labels are
    // slots of one page, they become one mesh (js/wordmarkatlas.js), exactly
    // as js/meshes.js buildBuildingsMesh does after a synchronous build
    if (BATCH.marks && Object.keys(r.brands ?? {}).length) mergeMarks(group);
    return { group, canopyMissed: !!r.canopyMissed, groundMissed: !!r.groundMissed };
  }

  /** Fail anything the workers have stopped answering for. Called once a frame. */
  function poll() {
    const t = now();
    let step = 0;
    if (heard) {
      // the line delivered since the last poll: credit the time since it last
      // did, never more than one stall's worth
      step = Math.min(STALL_CAP_MS, Math.max(0, t - lastHeard));
      lastHeard = t; heard = false;
    } else if (t - lastHeard > SILENT_MS) {
      // nothing from anyone for a long time: the workers themselves are gone
      step = Math.min(STALL_CAP_MS, Math.max(0, t - lastPoll));
    }
    lastPoll = t;
    // backwards and by index: retire() splices, and a copy of the list here
    // would be an array made every frame
    for (let i = workers.length - 1; i >= 0; i--) {
      const h = workers[i];
      // keep the line talking. One ping out per worker at a time (a lost one
      // is re-sent after a second), and none to a worker that has not loaded.
      if (h.ready && t - h.pingAt > (h.pingOut ? 1000 : PING_MS)) {
        h.pingAt = t; h.pingOut = true;
        try { h.w.postMessage({ t: 'ping', at: t }); } catch { /* retired below, in time */ }
      }
      if (!h.ready) {
        if ((h.waited += step) > LOAD_MS) retire(h, 'worker never finished loading');
      } else if (h.flight && !h.flight.done
        && (h.flight.waited += step) > WATCHDOG_MS) {
        retire(h, `no answer for chunk ${h.flight.cx},${h.flight.cz}`);
      }
    }
  }

  function dispose() {
    // Fail whatever is still out first. Terminating a worker means its build
    // never answers, and a flight that never answers is a cell stuck in the
    // streamer's books forever — i.e. a hole in the world that nothing retries.
    for (const h of workers.splice(0)) {
      if (h.flight) { h.flight.error = 'the mesher pool was disposed'; h.flight.done = true; }
      try { h.w.terminate(); } catch { /* gone */ }
    }
    pool.dead = true;
  }

  return pool;
}

// ---- a pool that is already awake when the world asks for one ---------------
// The first thing a boot does is fetch megabytes of tiles, and a worker's
// module graph is dozens of small requests queued behind them on the same six
// connections: measured, the four workers said 'ready' 4.7 s after the world
// was made, by which time the boot had meshed nearly all of its 81 cells on
// the main thread. Spawned while the MENU is up, with the network idle, they
// are ready before Hrat is clicked and the boot meshes four cells at a time.
let warm = null;

/** Start the workers now. Safe to call anywhere: a no-op where there is no Worker. */
export function prewarmMeshPool() {
  if (warm || typeof Worker === 'undefined' || typeof window === 'undefined') return;
  warm = makeMeshPool();
}

/** The prewarmed pool, once; after that (a second world) every caller makes its own. */
export function takeMeshPool() {
  const p = warm && !warm.dead ? warm : null;
  warm = null;
  return p ?? makeMeshPool();
}

/**
 * Everything the decode needs that the worker could not make: the window atlas,
 * the chain wordmarks and the aerial photo are all painted on a <canvas>, and a
 * worker has none. The geometry arrived naming each of them; this is where the
 * names become the main thread's own singletons.
 */
function resolveMaterials(reply, ortho, mats) {
  mats.codecMats ??= {};
  if (ortho) mats.codecMats.ortho = ortho.mat;
  for (const k of Object.keys(reply.brands ?? {})) {
    const m = (mats.codecMats[k] ??= brandMarkMat(reply.brands[k]));
    // a chunk is about to wear it: the wordmark sweep (CityWorld._sweepMarks)
    // only sees BUILT chunks, and this one lands a few frames from now
    if (m.userData) m.userData.idle = 0;
  }
  // Building the atlas is a 2048×1024 paint, so it waits for a chunk that
  // actually has facades in it — the same moment the synchronous path builds it.
  if (reply.payload.meta.nodes.some((n) => n.mat === 'facade')) facadeMaterial(mats);
}
