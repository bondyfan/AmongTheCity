// ---- batchflags.js: the draw-call batching, switchable for an A/B ----------
// Three savings that must not change what is on screen, each with its old
// path kept alive behind one flag so the two can be compared in the same
// session, from the console:
//
//   __batch.signals = false   every mast in range goes back to seven Meshes of
//                             its own (js/signalbatch.js), at once
//   __batch.marks = false     chunks built from now on keep one wordmark Mesh
//                             per chain (js/wordmarkatlas.js mergeMarks), and a
//                             label painted from now on gets its own canvas;
//                             __atc.world.rebuildAll() makes it every chunk
//   __batch.shadows = false   people cast at any distance again
//                             (js/citizen.js cullPeopleShadows), at once
//
// `?batch=0` in the URL starts with all three off, `?batch=signals` with only
// that one on (a comma list). Nothing here is shared state: two co-op clients
// may hold different flags and still agree about every light and every shop.

const flags = { signals: true, marks: true, shadows: true };
const selection = new URLSearchParams(globalThis.location?.search).get('batch');
if (selection !== null) {
  const on = new Set(selection.split(',').map((s) => s.trim()));
  const all = selection === '1' || selection === 'all';
  for (const key in flags) flags[key] = all || on.has(key);
}

const subs = { signals: [], marks: [], shadows: [] };

/** The live flags. Assigning one runs whatever subscribed to it. */
export const BATCH = {};
for (const k of Object.keys(flags)) {
  Object.defineProperty(BATCH, k, {
    enumerable: true,
    get: () => flags[k],
    set: (v) => {
      v = !!v;
      if (v === flags[k]) return;
      flags[k] = v;
      for (const f of subs[k]) f(v);
    },
  });
}

/** Run `f(on)` whenever flag `k` is flipped. */
export function onBatchFlag(k, f) { subs[k].push(f); }

if (typeof window !== 'undefined') window.__batch = BATCH;
