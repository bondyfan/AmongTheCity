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
import { decode } from './geomcodec.js';
import { facadeMaterial, brandMarkMat } from './meshes.js';

/** Hard ceiling on workers. Past four the queue is never the bottleneck. */
const MAX_WORKERS = 4;
// A build that has not answered in this long is treated as lost and rebuilt
// synchronously. Nothing should ever hit it — it exists so a worker that dies
// silently costs one chunk instead of leaving a hole in the world forever.
const WATCHDOG_MS = 8000;

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
  const spawn = opts.spawn ?? (() => new Worker(
    new URL('./meshworker.js', import.meta.url), { type: 'module' }));
  const now = opts.now ?? (() => performance.now());
  const workers = [];
  let nextId = 1;

  const pool = {
    /** Retired: every chunk goes down the synchronous path from here on. */
    dead: false,
    get size() { return workers.length; },
    /** How many chunks could be started right now. */
    free() { return pool.dead ? 0 : workers.reduce((n, h) => n + (h.flight ? 0 : 1), 0); },
    submit, finish, poll, dispose,
  };

  for (let i = 0; i < poolSize(opts.max ?? MAX_WORKERS); i++) {
    try {
      const h = { w: spawn(), flight: null,
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
    const f = h.flight;
    if (!f || msg?.id !== f.id) return;          // a reply to a lost build
    h.flight = null;
    if (msg.t === 'fail') f.error = msg.error;
    else f.reply = msg;
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
    const h = workers.find((x) => !x.flight);
    if (!h) return null;
    let got;
    try {
      got = chunkSpec(world, cx, cz, lod, h.have);
    } catch (err) {
      // A cache that is not plain data. Loud, once — the chunk still gets built.
      console.warn('meshpool: spec refused, building on the main thread —', err?.message ?? err);
      return null;
    }
    if (!got) return null;                       // outside the mapped city
    const f = { id: nextId++, cx, cz, lod, ortho: got.ortho, at: now(),
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
    return { group: decode(r.payload, mats),
      canopyMissed: !!r.canopyMissed, groundMissed: !!r.groundMissed };
  }

  /** Fail anything the workers have stopped answering for. Called once a frame. */
  function poll() {
    const t = now();
    for (const h of workers) {
      if (h.flight && !h.flight.done && t - h.flight.at > WATCHDOG_MS)
        retire(h, `no answer for chunk ${h.flight.cx},${h.flight.cz}`);
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

/**
 * Everything the decode needs that the worker could not make: the window atlas,
 * the chain wordmarks and the aerial photo are all painted on a <canvas>, and a
 * worker has none. The geometry arrived naming each of them; this is where the
 * names become the main thread's own singletons.
 */
function resolveMaterials(reply, ortho, mats) {
  mats.codecMats ??= {};
  if (ortho) mats.codecMats.ortho = ortho.mat;
  for (const k of Object.keys(reply.brands ?? {}))
    mats.codecMats[k] ??= brandMarkMat(reply.brands[k]);
  // Building the atlas is a 2048×1024 paint, so it waits for a chunk that
  // actually has facades in it — the same moment the synchronous path builds it.
  if (reply.payload.meta.nodes.some((n) => n.mat === 'facade')) facadeMaterial(mats);
}
