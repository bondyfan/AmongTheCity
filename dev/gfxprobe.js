// ---- gfxprobe: where a frame's draw calls, triangles and milliseconds go ----
// A dev tool, never imported by the game. Load it into a running tab:
//
//   const G = (await import('/dev/gfxprobe.js')).default;
//   G.list();        // the main pass's render list, grouped by owner
//   G.ablate(30);    // hide each owner in turn and time the frame without it
//   G.passes(30);    // the post stack, pass by pass
//
// The render list is read back from three's own `renderer.renderLists` after a
// plain render, so it is exactly what the GPU was asked to draw (frustum culled,
// invisible skipped). An item is charged to its OWNER: the nearest ancestor
// that a classifier recognises (a chunk group, the trees, the traffic, the
// crowd...), falling back to the top-level scene child.
//
// Timing is render + gl.finish, the same stick dev/perfprobe.js uses, so the
// numbers add up against its tables.

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const q = (p) => s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return { med: +q(0.5).toFixed(2), p10: +q(0.1).toFixed(2), p90: +q(0.9).toFixed(2) };
};

const G = {
  // A name for the object an item belongs to. Walks up to the scene child and
  // keeps the most telling label met on the way.
  // Roots the game's managers own, mapped to a label once per call of list().
  _roots() {
    const A = window.__atc, m = new Map();
    const tag = (o, k) => { if (o && !m.has(o)) m.set(o, k); };
    for (const c of A.traffic?.cars ?? []) tag(c.mesh, 'traffic-car');
    for (const c of A.vehicles?.cars ?? []) tag(c.mesh ?? c.group ?? c, 'vehicle');
    for (const c of A.parked?.cars ?? A.parked?.list ?? []) tag(c.mesh ?? c, 'parked');
    for (const b of A.peds?.bodies ?? A.peds?.peds ?? A.peds?.list ?? []) tag(b.mesh ?? b.group ?? b.root ?? b, 'ped');
    for (const b of A.cyclists?.riders ?? A.cyclists?.list ?? []) tag(b.mesh ?? b.group ?? b, 'cyclist');
    tag(A.player?.mesh ?? A.player?.group, 'player');
    return m;
  },
  owner(o) {
    const A = window.__atc, scene = A.scene, roots = G._rootMap ?? (G._rootMap = G._roots());
    let label = null, cur = o, top = o, chunk = null;
    while (cur && cur.parent && cur !== scene) {
      if (roots.has(cur)) return { label: roots.get(cur), top: cur };
      if (cur.name?.startsWith('chunk:')) chunk = cur;
      if (!label && cur.name && !cur.name.startsWith('chunk:')) label = cur.name;
      if (cur.parent === scene) break;
      cur = cur.parent;
    }
    top = cur;
    if (chunk) return { label: 'chunk/' + (o.name || o.material?.name || o.material?.type || 'mesh'), top };
    if (!label) {
      let sk = false; o.traverseAncestors?.(() => {}); if (o.isSkinnedMesh) sk = true;
      label = sk ? 'skinned-person' : (top?.type ?? 'obj') + ':' + (o.material?.type ?? '') + ':' + (o.material?.name || '');
    }
    return { label, top };
  },

  _items() {
    const A = window.__atc, r = A.renderer;
    r.render(A.scene, A.camera);
    const list = r.renderLists.get(A.scene, 0);
    return [...list.opaque, ...list.transmissive, ...list.transparent];
  },

  _tris(it) {
    const g = it.geometry, o = it.object;
    let n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    if (it.group) n = it.group.count;
    n = Math.min(n, g.drawRange.count === Infinity ? n : g.drawRange.count);
    const inst = o.isInstancedMesh ? o.count : (g.isInstancedBufferGeometry ? (g.instanceCount ?? 1) : 1);
    const per = o.isPoints ? 1 : o.isLine || o.isLineSegments ? 0.5 : 1 / 3;
    return Math.round(n * per * inst);
  },

  /** The main pass's render list grouped by owner: calls, triangles, materials. */
  list(top = 40) {
    G._rootMap = G._roots();
    const by = new Map();
    for (const it of G._items()) {
      const { label } = G.owner(it.object);
      const e = by.get(label) ?? { calls: 0, tris: 0, mats: new Set(), shadow: 0 };
      e.calls++; e.tris += G._tris(it); e.mats.add(it.material.type + (it.material.name ? ':' + it.material.name : ''));
      if (it.object.castShadow) e.shadow++;
      by.set(label, e);
    }
    const rows = [...by.entries()].sort((a, b) => b[1].tris - a[1].tris).slice(0, top)
      .map(([k, e]) => [k, e.calls, e.tris, e.shadow, [...e.mats].slice(0, 3).join(',')]);
    const all = [...by.values()].reduce((t, e) => [t[0] + e.calls, t[1] + e.tris], [0, 0]);
    return { total: all, rows };
  },

  /** Shadow casters as the shadow pass sees them (castShadow and visible). */
  shadowCasters(top = 25) {
    const A = window.__atc, by = new Map();
    A.scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isInstancedMesh) || !o.castShadow) return;
      const { label } = G.owner(o);
      const e = by.get(label) ?? { calls: 0, tris: 0 };
      e.calls++; e.tris += G._tris({ geometry: o.geometry, object: o });
      by.set(label, e);
    });
    return [...by.entries()].sort((a, b) => b[1].tris - a[1].tris).slice(0, top).map(([k, e]) => [k, e.calls, e.tris]);
  },

  _time(n, frame) {
    const gl = window.__atc.renderer.getContext();
    for (let i = 0; i < 3; i++) { frame(); gl.finish(); }
    const ts = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); frame(); gl.finish(); ts.push(performance.now() - t0); }
    return stat(ts);
  },

  /** The full game frame (post stack when on), as perfprobe's measure draws it. */
  frame() {
    const A = window.__atc, r = A.renderer, pf = A.postfx;
    if (pf && !pf.__g) { const o = pf.render.bind(pf); pf.__g = o; pf.render = (s, c, op) => { G._pf = [s, c, op]; return o(s, c, op); }; }
    if (r.shadowMap.enabled) r.shadowMap.needsUpdate = true;
    if (pf && G._pf) pf.__g(...G._pf); else r.render(A.scene, A.camera);
  },

  /** Hide each heavy owner in turn and time the frame without it. */
  ablate(n = 25, top = 14) {
    const A = window.__atc;
    G.frame();
    if (A.postfx && !G._pf) return 'no post frame captured yet, call again';
    const base = G._time(n, G.frame);
    G._rootMap = G._roots();
    // owners by triangle weight, but hidden at the level that owns them: the
    // top-level scene child for the singletons, every chunk mesh for 'chunk:'
    const groups = new Map();
    for (const it of G._items()) {
      const { label } = G.owner(it.object);
      const set = groups.get(label) ?? new Set();
      set.add(it.object);
      groups.set(label, set);
    }
    const weight = (s) => [...s].reduce((t, o) => t + G._tris({ geometry: o.geometry, object: o }), 0);
    const order = [...groups.entries()].map(([k, s]) => [k, s, weight(s), s.size])
      .sort((a, b) => b[2] - a[2]).slice(0, top);
    const out = [];
    for (const [k, set, tris, calls] of order) {
      for (const o of set) o.visible = false;
      const t = G._time(n, G.frame);
      for (const o of set) o.visible = true;
      out.push([k, calls, tris, +(base.med - t.med).toFixed(2)]);
    }
    // the shadow pass on its own: the same frame with the map not redrawn
    const r = A.renderer;
    const noShadow = G._time(n, () => {
      const pf = A.postfx;
      r.shadowMap.needsUpdate = false;
      if (pf && G._pf) pf.__g(...G._pf); else r.render(A.scene, A.camera);
    });
    return { base, shadowPass: +(base.med - noShadow.med).toFixed(2), rows: out };
  },

  /**
   * Where the SIMULATION's milliseconds go: wraps the update method of every
   * manager window.__atc exposes, lets the live loop run, then reports the mean
   * per frame. `G.simStart()`, wait a few seconds (separate tool calls), then
   * `G.simStop()`.
   */
  simStart() {
    const A = window.__atc;
    const targets = {
      world: A.world, traffic: A.traffic, peds: A.peds, cyclists: A.cyclists, trains: A.trains,
      police: A.police, vehicles: A.vehicles, trees: A.trees, clouds: A.clouds, lights: A.lightPools,
      interiors: A.world?.interiors, player: A.player, ambulance: A.ambulance, chatter: A.chatter,
      parked: A.parked, grass: A.world?.grass, farTerrain: A.farTerrain, wanted: A.wanted,
      combat: A.combat, net: A.net, worldMap: A.worldMap, statusbar: A.statusbar, ui: A.ui,
    };
    G._sim = { t: {}, undo: [], frames: 0, t0: performance.now() };
    for (const [k, o] of Object.entries(targets)) {
      if (!o) continue;
      for (const m of ['update', 'tick', 'draw', 'render', 'bake']) {
        if (typeof o[m] !== 'function') continue;
        const orig = o[m], key = k + '.' + m;
        try {
          o[m] = function (...a) { const t0 = performance.now(); try { return orig.apply(this, a); } finally { G._sim.t[key] = (G._sim.t[key] ?? 0) + performance.now() - t0; } };
          G._sim.undo.push(() => { o[m] = orig; });
        } catch { /* a module namespace: read-only */ }
      }
    }
    const r = A.renderer, ro = r.render;
    r.render = function (...a) { const t0 = performance.now(); try { return ro.apply(this, a); } finally { G._sim.t['renderer.render'] = (G._sim.t['renderer.render'] ?? 0) + performance.now() - t0; } };
    G._sim.undo.push(() => { r.render = ro; });
    const w = A.world, wu = w.update;
    // frames are counted on world.update, which the loop calls once per step
    const prev = G._sim.t;
    G._sim.count = () => G._sim.frames++;
    return 'profiling';
  },
  simStop() {
    const s = G._sim; if (!s) return 'not started';
    for (const u of s.undo) u();
    const secs = (performance.now() - s.t0) / 1000;
    const steps = Math.max(1, (window.P?.upd?.length) || 1);
    G._sim = null;
    return { secs: +secs.toFixed(1), perSecondMs: Object.fromEntries(Object.entries(s.t)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / secs).toFixed(1)])) };
  },

  /**
   * A full-resolution frame of the canvas, without the HUD, posted to a local
   * sink (a tiny HTTP server that writes it to disk). Fire and forget: nothing
   * here awaits, so it is safe while the hidden-tab pump runs.
   */
  shot(name, sink = 'http://127.0.0.1:5499/') {
    const A = window.__atc;
    G.frame();
    if (A.postfx && !G._pf) return 'no post frame captured yet, call again';
    const url = A.renderer.domElement.toDataURL('image/jpeg', 0.92);
    fetch(sink + name, { method: 'POST', body: url }).catch(() => {});
    return name + ' ' + Math.round(url.length / 1024) + ' kB';
  },

  /** The post stack, one pass at a time (each switched off on its own). */
  passes(n = 25) {
    const A = window.__atc;
    G.frame();
    if (!G._pf) return 'no post frame';
    const [s, c, op] = G._pf, pf = A.postfx;
    const run = (o) => G._time(n, () => { A.renderer.shadowMap.needsUpdate = true; pf.__g(s, c, o); });
    const base = run(op);
    const res = { base: base.med };
    for (const [k, v] of [['ssao', false], ['bloom', false], ['rays', null], ['lamps', null], ['canopy', null]])
      res['-' + k] = +(base.med - run({ ...op, [k]: v }).med).toFixed(2);
    // the bare scene draw into the canvas, no post at all
    res.plain = G._time(n, () => { A.renderer.shadowMap.needsUpdate = true; A.renderer.render(A.scene, A.camera); }).med;
    return res;
  },
};

export default G;
