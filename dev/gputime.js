// ---- dev/gputime.js: GPU milliseconds of the frame, pass by pass ----------
// The machine this game is tuned on is shared with half a dozen other sessions,
// and gl.finish()-timed frames swing from 56 to 220 ms at one spot. The post
// stack's cost is GPU time, so it is measured on the GPU instead: one
// EXT_disjoint_timer_query_webgl2 query around every renderer.render() call of
// the frame (the scene draw, which includes the shadow pass, the lamp bake and
// each full-screen post pass), at a FIXED size like gfxprobe's shots, so two
// builds are compared at the same pixel count whatever the pane is doing.
//
// Results only become available after control returns to the event loop
// (WebGL's own rule), so it is two calls, made from two separate tool calls:
//   const T = (await import('/dev/gputime.js')).default;
//   T.start(30);   // issues 30 frames with a query per draw
//   T.read();      // later: medians per label, and the post stack's total
// Labels: 'scene' for the main scene draw, the post pass's material name
// otherwise (postfx.js names every pass material), 'other' for the rest.
//
// THE OLD STACK AGAINST THE NEW ONE (js/lookab.js). Build the old one first:
//   const old = await (await import('/dev/postfx-legacy.js')).install();
//   __atc.postfx.ab.post = true;           // the game keeps drawing the new one
// then either time whichever stack is switched in (start() follows ab.post:
// with it false, the frames are drawn through the old one), or interleave the
// two in one throughput run, which is the steadier figure:
//   T.ab({ new: null, old: { $pf: old } })
// `$pf` in an `over` object names the stack that draws; the old one is handed
// the same options, `rays.full` and all, so its noon frame runs the rays pass.

const T = {
  _q: null,
  start(n = 30, w = 1728, h = 1000) {
    const A = window.__atc, r = A.renderer, gl = r.getContext(), cam = A.camera;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return 'no timer query';
    const G = window.G;
    G.frame();
    if (A.postfx && !G._pf) return 'no post frame captured yet, call again';
    const ab = A.postfx?.ab;
    const alt = ab && !ab.post && ab.legacy ? ab.legacy : null;
    const pf = alt ?? A.postfx;
    const frame = alt ? () => { r.shadowMap.needsUpdate = true; alt.render(...G._pf); } : () => G.frame();
    const pr = r.getPixelRatio(), cw = r.domElement.width / pr, ch = r.domElement.height / pr;
    const aspect = cam.aspect;
    r.setPixelRatio(1); r.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    pf?.setSize(w, h);
    const frames = [];
    let cur = null;
    const orig = r.render;
    r.render = function (scene, camera) {
      let label = 'other';
      if (pf && scene === pf.quadScene) label = pf.quad.material?.name || 'pass';
      else if (scene === A.scene) label = 'scene';
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      try { return orig.apply(this, arguments); }
      finally { gl.endQuery(ext.TIME_ELAPSED_EXT); cur.push([label, q]); }
    };
    try {
      for (let i = 0; i < n + 3; i++) {
        cur = [];
        frame();
        gl.finish();
        if (i >= 3) frames.push(cur);
        else for (const [, q] of cur) gl.deleteQuery(q);
      }
    } finally {
      r.render = orig;
      r.setPixelRatio(pr); r.setSize(cw, ch, false);
      cam.aspect = aspect; cam.updateProjectionMatrix();
      pf?.setSize(r.domElement.width, r.domElement.height);
    }
    T._q = { gl, ext, frames };
    return 'issued ' + frames.length + ' frames, call T.read() from the next tool call';
  },
  /**
   * The post stack's THROUGHPUT, by wall clock, at the fixed size: the scene is
   * drawn into the post target once, then only the post work (lamp bake by
   * night, every full-screen pass, the composite) runs `n` times back to back
   * with one GPU wait at the end, `reps` times over. Timer queries cannot be
   * used for this on ANGLE's Metal backend: an EMPTY 4 x 4 pass measures
   * 2 ms there, so per-pass figures are mostly the query's own floor. A
   * throughput loop has no such floor and almost no CPU in it (a dozen draw
   * calls a frame), so the load other sessions put on the CPU barely moves it.
   * The wait is a one-pixel readPixels from the canvas, NOT gl.finish():
   * Chrome's finish() returns without waiting for the GPU (sixty post passes
   * at full size "finished" in 0.3 ms), so every finish()-timed figure in the
   * probes is CPU time. A readback cannot return before the pixel exists.
   * `over` is merged into the frame's options (e.g. { ssao: false }).
   * Returns ms per post frame: [min, median] over the reps.
   */
  post(n = 40, reps = 5, over = null, w = 1728, h = 1000) {
    const A = window.__atc, r = A.renderer, gl = r.getContext(), cam = A.camera;
    const G = window.G;
    G.frame();
    if (!A.postfx || !G._pf) return 'no post frame captured yet, call again';
    const { $pf: alt = null, ...rest } = over ?? {};
    const pf = alt ?? A.postfx;
    const draw = alt ? (s, c, o) => alt.render(s, c, o) : pf.__g;
    const pr = r.getPixelRatio(), cw = r.domElement.width / pr, ch = r.domElement.height / pr;
    const aspect = cam.aspect;
    r.setPixelRatio(1); r.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    pf.setSize(w, h);
    const [s, c, op0] = G._pf;
    const op = over ? { ...op0, ...rest } : op0;
    r.shadowMap.needsUpdate = true;
    // the one real frame: draws the scene into THIS stack's own target
    draw(s, c, op);
    const orig = r.render;
    const skip = function (scene) { if (scene === A.scene) return; return orig.apply(this, arguments); };
    const res = [];
    const px = new Uint8Array(4);
    const sync = () => { r.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    r.render = skip;
    try {
      sync();
      for (let k = 0; k < reps; k++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) draw(s, c, op);
        sync();
        res.push((performance.now() - t0) / n);
      }
    } finally {
      r.render = orig;
      r.setPixelRatio(pr); r.setSize(cw, ch, false);
      cam.aspect = aspect; cam.updateProjectionMatrix();
      pf.setSize(r.domElement.width, r.domElement.height);
    }
    res.sort((a, b) => a - b);
    return [+res[0].toFixed(3), +res[res.length >> 1].toFixed(3)];
  },
  /**
   * Interleaved A/B of post options: `cfgs` maps a name to an `over` object
   * (null = the frame as the game draws it). Every round runs every config
   * once, so a burst of load from another session lands on all of them alike.
   * Returns { name: [min, lower quartile] } in ms per post frame.
   */
  ab(cfgs, rounds = 6, n = 20) {
    const all = {};
    for (let k = 0; k < rounds; k++) {
      for (const [name, over] of Object.entries(cfgs)) {
        const v = T.post(n, 2, over);
        if (typeof v === 'string') return v;
        (all[name] ??= []).push(...v);
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      v.sort((a, b) => a - b);
      out[k] = [+v[0].toFixed(3), +v[Math.floor((v.length - 1) / 4)].toFixed(3)];
    }
    return out;
  },
  read() {
    const s = T._q;
    if (!s) return 'start first';
    const { gl, ext, frames } = s;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) return 'disjoint, start again';
    const by = new Map();
    const post = [];
    for (const f of frames) {
      const per = new Map();
      for (const [label, q] of f) {
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return 'not ready, read again';
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
        per.set(label, (per.get(label) ?? 0) + ms);
      }
      let p = 0;
      for (const [k, v] of per) {
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(v);
        if (k !== 'scene' && k !== 'other') p += v;
      }
      post.push(p);
    }
    T._q = null;
    // the median AND the lower quartile: on a GPU other sessions are also
    // drawing on, a pass's time includes waiting for theirs, and the quartile
    // is the steadier figure for an A/B
    const q = (a, f) => { const b = [...a].sort((x, y) => x - y); return +b[Math.floor((b.length - 1) * f)].toFixed(3); };
    const out = {};
    for (const [k, v] of by) out[k] = [q(v, 0.5), q(v, 0.25)];
    out.postTotal = [q(post, 0.5), q(post, 0.25)];
    return out;
  },
};

export default T;
