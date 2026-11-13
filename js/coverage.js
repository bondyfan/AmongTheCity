// ---- coverage.js: is alpha to coverage actually there this frame? ------------
// The tree tier swap, the ragged crown edge, the round sign plates and the
// shelter glass all write an ALPHA and leave it to multisampling to turn that
// into coverage (js/treeshader.js, js/signatlas.js). Where the frame is not
// multisampled the alpha is simply ignored: both tree tiers draw whole across
// the swap band and pop at its ends, every sign stands in a square of its rim
// colour and a pane of glass is a blue-grey slab.
//
// The post stack's scene target always has four samples. The direct path (the
// low preset, or every post effect switched off) draws to the canvas, which
// ASKS for antialiasing and is not always given it: a browser may refuse it on
// a weak or blocklisted GPU, and that is exactly the machine the low preset is
// for. So the answer is per frame, and the materials read it from one shared
// uniform and fall back when it is 0: a cut-out for crown edges, a hard
// per-tree swap at the middle of the band (exactly one tier at any distance),
// and an ordered dither for the sign atlas, which a plate's edge crosses in a
// pixel and a pane of glass wears as a fine screen.
//
// No DOM: this file is in the worker import graph (through js/meshes.js).

/** 1 when the target being drawn is multisampled, 0 when it is not. */
export const COVERAGE = { value: 1 };

let canvasSamples = -1;
let forced = null;

/**
 * Called once a frame, before the scene is drawn.
 * @param renderer  the WebGLRenderer
 * @param targetSamples  samples of the offscreen scene target this frame, or
 *   null / undefined when the scene goes straight to the canvas
 */
export function setCoverage(renderer, targetSamples) {
  if (forced !== null) { COVERAGE.value = forced; return; }
  if (targetSamples != null) {
    // a target ASKS for samples too: the driver's ceiling can be zero
    COVERAGE.value = Math.min(targetSamples, renderer.capabilities?.maxSamples ?? targetSamples) > 0 ? 1 : 0;
    return;
  }
  if (canvasSamples < 0) {
    const gl = renderer.getContext();
    // SAMPLES answers for whichever framebuffer is bound, and this is asked
    // between frames: with an offscreen target still current (a shadow map, a
    // shade map) it would say 0 for good. Then the context's own word is taken.
    canvasSamples = gl.getParameter(gl.FRAMEBUFFER_BINDING) === null
      ? gl.getParameter(gl.SAMPLES) | 0
      : (gl.getContextAttributes?.()?.antialias ? 4 : 0);
  }
  COVERAGE.value = canvasSamples > 0 ? 1 : 0;
}

/** For a harness: force the fallback on (0) or off (1), or hand it back (null). */
export function forceCoverage(v) {
  forced = v === null || v === undefined ? null : (v ? 1 : 0);
  if (forced !== null) COVERAGE.value = forced;
}

// The fragment-shader half, shared so the two materials dither alike. A 4x4
// ordered (Bayer) threshold: a stable pattern that does not crawl when the
// camera is still, which interleaved noise does without temporal filtering.
// Thresholds run from 1/32 to 31/32, so an alpha of 0 is always cut and an
// alpha of 1 never is.
export const COVERAGE_GLSL = /* glsl */`
uniform float uCoverage;
float atcBayer2( vec2 q ) { return mod( 2.0 * q.x + 3.0 * q.y, 4.0 ); }   // 0 2 / 3 1
float atcBayer4( vec2 p ) {
	vec2 q = floor( mod( p, 4.0 ) );
	return ( 4.0 * atcBayer2( mod( q, 2.0 ) ) + atcBayer2( floor( q * 0.5 ) ) + 0.5 ) / 16.0;
}`;
