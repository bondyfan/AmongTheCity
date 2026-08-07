// ---- meshing one chunk, off the main thread ---------------------------------
// A dense Pardubice chunk is 30–330 ms of geometry. It used to be atomic (one
// dropped frame per chunk); then it became a generator sliced against a 7 ms
// budget, which spread the hitch out without removing any of it — the work was
// still on the thread that has to present a frame every 16.7 ms. Here it costs
// the frame nothing at all: the worker builds the group, geomcodec turns it
// into one ArrayBuffer, and the main thread's whole share is a decode that
// hands the bytes straight to BufferAttribute.
//
// THIS FILE HAS NO DOM AND MUST NOT GROW ONE. buildChunkMeshes touches
// `document` in exactly two places and both are handled by naming rather than
// by disabling:
//   · the 2048×1024 facade window atlas — the walls still carry their atlas
//     uvs, `mats._facadeMat` is a sentinel here, and the decode resolves the
//     'facade' key to the main thread's real textured material;
//   · the brand wordmark canvases — same trick, one key per chain, and the
//     brand's own {label, sign, trim} rides back so the main thread can paint
//     the canvas the first time it meets that chain.
// The aerial photo is the third canvas-shaped thing and it is not built here
// either: the main thread decides which supertile at what detail (that decision
// is what starts the WMS fetch), the worker builds the same displaced quad, and
// the decode puts the real material back. Facades are never silently off.
//
// The message handling below is a PURE FUNCTION of (state, message). Node has
// no DOM Worker, so that is what the tests drive — handleMessage() directly,
// against the same code the browser runs.

import { buildChunkMeshes } from './meshes.js';
import { encode } from './geomcodec.js';
import { applySpec, withJunctions } from './chunkspec.js';

/** A worker's whole memory: the rasters that outlive one chunk message. */
export function makeWorkerState() {
  return { cache: { terrain: null, canopy: null } };
}

/**
 * Build one chunk from its spec and return what the wire carries.
 *
 * @returns {{empty: boolean, payload?: {meta, buffers}, brands: object,
 *            canopyMissed: boolean, groundMissed: boolean, ms: number}}
 *   `empty` is a cell outside the mapped city — the streamer stores null for
 *   those and must be able to tell them from a failure.
 */
export function buildChunkPayload(state, spec) {
  const t0 = performance.now();
  const { city, mats, junctions, clusters } = applySpec(spec, state.cache);
  // The pads this chunk can read, seeded into geo.js's module maps for the
  // length of the build and taken out again — a worker never indexes a road,
  // so nothing else would ever put them there.
  const group = withJunctions(junctions, clusters,
    () => buildChunkMeshes(city, spec.cx, spec.cz, mats, spec.lod));
  const out = {
    empty: !group,
    brands: mats.brandsUsed ?? {},
    canopyMissed: !!mats.canopy?.missed,
    groundMissed: !!mats.ground?.missed,
    ms: 0,
  };
  if (group) out.payload = encode(group, mats);
  out.ms = performance.now() - t0;
  return out;
}

/**
 * The worker's one entry point, as data in and data out.
 * @returns {{reply: object, transfer: ArrayBuffer[]}}
 */
export function handleMessage(state, msg) {
  if (msg?.t !== 'build') return { reply: { t: 'unknown', id: msg?.id ?? null }, transfer: [] };
  try {
    const out = buildChunkPayload(state, msg.spec);
    return {
      reply: { t: 'done', id: msg.id, empty: out.empty, payload: out.payload ?? null,
        brands: out.brands, canopyMissed: out.canopyMissed,
        groundMissed: out.groundMissed, ms: out.ms },
      // The chunk's bytes MOVE. Cloning them here would put the megabytes this
      // whole format exists to avoid back on the receiving thread.
      transfer: out.payload ? out.payload.buffers : [],
    };
  } catch (err) {
    // A failed build is not a dead world: the streamer builds this chunk
    // synchronously instead, so the message that matters is which chunk and why.
    return { reply: { t: 'fail', id: msg.id,
      error: `${msg.spec?.cx},${msg.spec?.cz}: ${err?.message ?? err}` }, transfer: [] };
  }
}

// ---- the browser half -------------------------------------------------------
// Guarded so this module can be imported by a test (or by the main thread, for
// the two exports above) without trying to install a message handler.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function'
  && typeof window === 'undefined') {
  const state = makeWorkerState();
  self.onmessage = (e) => {
    const { reply, transfer } = handleMessage(state, e.data);
    self.postMessage(reply, transfer);
  };
}
