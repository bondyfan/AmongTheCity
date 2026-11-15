// ---- tilework.js: the main thread's tile work, a few milliseconds a frame ----
// MAIN THREAD, used by geo.js (no DOM here: the frame break is the gate geo.js
// hands in, its indexGate). Split out of geo.js, which owns what the steps do.
//
// Giving a far tile back used to be one graph per frame, whole: measured on
// four central Prague tiles (14 Nov 2026, CPU time, a loaded machine) the
// cells and arrays took 170 to 205 ms in the frame ensureTiles ran in, the
// traffic graph 140 to 220 ms, the walkers 130 to 650, the cycle net 80 to
// 280 and the route planner 65 to 130 in a frame each. Every one of them is
// now a sequence of small steps (a generator: a release listener may return
// one), run up to SLICE_MS at a time, one slice per frame. The steps of one
// release run as ONE job that nothing else of the kind enters: a tile
// indexed between two slices would grow a graph that is half let go of.
// Indexing waits for its turn the same way (workTurn), so a tile that comes
// straight back is indexed after its own release, and a release never starts
// in the middle of an indexing.

const SLICE_MS = 6;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// what the slices cost, for whoever wants to look (geo.js city.releaseStats):
// slices run, the longest one in ms, how many took over 8 ms, jobs finished
export const RELEASE_STATS = { slices: 0, maxMs: 0, jobs: 0, lastMs: 0, over8: 0 };

let _tail = Promise.resolve();

/**
 * Wait for every job queued before this one, then a frame break (`gate()`).
 * Resolves to the function that ends this turn: call it when the work is done.
 */
export function workTurn(gate) {
  const start = _tail;
  let finish;
  _tail = new Promise((r) => { finish = r; });
  return start.then(() => gate()).then(() => finish);
}

/** Run `steps` (an iterator) up to SLICE_MS a frame, holding the queue until it is through. */
export function queueJob(gate, steps, onEnd) {
  workTurn(gate).then(async (finish) => {
    try {
      for (;;) {
        const t0 = now();
        let more = false, step = 0;
        // (stops BEFORE a step that would carry the slice past SLICE_MS, by
        // the longest step seen in it so far)
        for (;;) {
          const s0 = now();
          if (steps.next().done) break;
          const s1 = now();
          if (s1 - s0 > step) step = s1 - s0;
          if (s1 - t0 + step > SLICE_MS) { more = true; break; }
        }
        const ms = now() - t0;
        RELEASE_STATS.slices++; RELEASE_STATS.lastMs = ms;
        if (ms > 8) RELEASE_STATS.over8++;
        if (ms > RELEASE_STATS.maxMs) RELEASE_STATS.maxMs = ms;
        if (!more) break;
        await gate();
      }
    } catch (err) { console.error('tile release', err); }
    finally { RELEASE_STATS.jobs++; onEnd?.(); finish(); }
  });
}

/** A listener's part of a job: its own steps if it returned any; an error in one does not stop the others. */
export function* guarded(cb, ev) {
  let it;
  try { it = cb(ev); } catch (err) { console.error('tile release', err); return; }
  if (!it || typeof it.next !== 'function') return;
  for (;;) {
    let r;
    try { r = it.next(); } catch (err) { console.error('tile release', err); return; }
    if (r.done) return;
    yield;
  }
}

/** Every item of `list` into `set`, a slice at a time. */
export function* addAllSteps(set, list) {
  for (let i = 0; i < list.length; i++) { set.add(list[i]); if ((i & 8191) === 8191) yield; }
}

// In place, in two steps: the survivors are gathered a slice at a time, then
// written back in one go (every consumer holds these arrays by reference, and
// one read between two slices of an in-place compaction would see a list
// with holes in it). Nothing appends meanwhile: indexing waits for the job.
export function* compactSteps(arr, gone) {
  if (!gone.size || !arr.length) return;
  const keep = [];
  for (let i = 0; i < arr.length; i++) {
    if (!gone.has(arr[i])) keep.push(arr[i]);
    if ((i & 8191) === 8191) yield;
  }
  if (keep.length === arr.length) return;
  for (let i = 0; i < keep.length; i++) arr[i] = keep[i];
  arr.length = keep.length;
  yield;
}
