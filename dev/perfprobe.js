// ---- perfprobe: one measuring stick for two builds of the game ---------------
// A dev tool, never imported by the game. It is loaded into a running tab from
// the console (or an automation harness):
//
//   const P = (await import('http://localhost:PORT/dev/perfprobe.js')).default;
//   P.clock(await import('/js/worldclock.js'));
//   P.install();            // at the MENU, before clicking Hrat
//   ...click Hrat, wait for play...
//   P.attach();             // once game.mode === 'play'
//   P.preset('medium'); P.time(0.5); P.go(-66, -182, 1.57);
//   P.status();             // wait until .quiet
//   P.measure(40);          // gl.finish-timed renders of the SAME frame
//
// It deliberately touches only what window.__atc already exposes and the
// settings panel's own <select>, so the same file measures the game as it was
// before the upgrade and as it is now: every before/after number in a perf
// table comes from this one piece of code.
//
// WHY gl.finish. The game's own fps readout times the render CALL, which is
// the CPU submitting draws. The GPU's share only shows when the thread waits
// for it, so each sample here is render + gl.finish(). In a hidden pane the
// compositor does not present, and that makes the numbers a little optimistic,
// equally for both builds.

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const q = (p) => s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const r = (v) => Math.round(v * 100) / 100;
  return { med: r(q(0.5)), mean: r(s.reduce((t, v) => t + v, 0) / n),
    p10: r(q(0.1)), p90: r(q(0.9)), min: r(s[0]), max: r(s[n - 1]), n };
};

const P = {
  log: { workers: [], warns: [], refused: 0, click: null, play: null },

  /** The hidden-tab pump, the Worker log and the warning log. Call at the menu. */
  install(pump = true) {
    if (window.__probe) return 'already';
    window.__probe = P;
    const seePlay = () => {
      if (P.log.play === null && P.log.click !== null && window.__atc?.game?.mode === 'play') {
        P.log.play = performance.now();
        if (P._bootTrace) { P.bootStats = P.traceStats(); P.bootStats.worldAt = Math.round(P.log.world - P.log.click); P.recAll = false; P.traceReset(); }
      }
      // P.bootTrace = true before the click: the world is traced from the
      // moment it exists, so a boot says where its seconds went
      if (P.bootTrace && !P._bootTrace && P.log.click !== null && window.__atc?.world?.interiors) {
        P._bootTrace = true; P.log.world = performance.now();
        P.attach(); P.recAll = true; P.trace();
      }
    };
    if (pump) {
      // ONE MESSAGE IN THE AIR, NEVER MORE. The pump every engineer of this
      // project copied posted a message for every callback it was handed, and
      // each message runs ALL the queued callbacks. A page with two loops that
      // re-arm themselves (the frame, and any short setTimeout chain) then
      // posts two messages per message handled: the thread's message queue
      // grows by one every frame, for ever, and each of those is a whole frame
      // of work. Everything else that reaches the page as a message waits at
      // the back of that queue. Measured in the game ten minutes into a
      // session: a worker's reply was delivered 3.2 to 4.4 s after it was
      // posted (through postMessage, a MessagePort and a BroadcastChannel
      // alike), a worker took 6.6 s to start, and a console evaluation timed
      // out at 45 s. That, not the game, is what retired the mesher pool in
      // three engineers' tabs, and in the original build too.
      const ch = new MessageChannel(); const q = [], rq = [];
      let inAir = false, lastFrame = 0;
      const kick = () => { if (!inAir) { inAir = true; ch.port2.postMessage(0); } };
      ch.port1.onmessage = () => {
        inAir = false;
        seePlay();
        // paused: the callbacks stay queued, so the tab stops rendering and
        // stops competing for the GPU while the OTHER build is being measured
        if (P.paused) return;
        for (const cb of q.splice(0)) cb(performance.now());
        // P.vsync: frames no faster than a shown tab's 60 Hz. Without it the
        // render loop runs back to back and a BOOT measured here is mostly
        // renders of a scene behind the loading overlay, with every network
        // reply queued behind one (round 7: 4.5 s of renders in a 9 s boot).
        const now = performance.now();
        if (rq.length && (!P.vsync || now - lastFrame >= 16.6)) { lastFrame = now; for (const cb of rq.splice(0)) cb(now); }
        if (rq.length || q.length) kick();
      };
      P._kick = kick;
      const realSt = window.setTimeout.bind(window);
      window.requestAnimationFrame = (cb) => { rq.push(cb); kick(); return 0; };
      window.setTimeout = (fn, d, ...a) => (typeof fn === 'function' && (d ?? 0) <= 50)
        ? (q.push(() => fn(...a)), kick(), -1) : realSt(fn, d, ...a);
    } else {
      // a shown pane: the browser's own frame clock, as a player has it
      const raf = window.requestAnimationFrame.bind(window);
      const loop = () => { seePlay(); if (P.log.play === null) raf(loop); };
      raf(loop);
    }
    // THE DEV SERVER'S OWN RELOAD. When its socket drops (a loaded machine is
    // enough: measured twice in one hour with five dev servers running), the
    // client polls with a 'vite-ping' socket and reloads the page the moment
    // one opens, and a twelve-minute tour is gone. Those pings are pointed at
    // a closed port, so the poll never succeeds; a file save while the socket
    // is up still reloads, as it should.
    const RWS = window.WebSocket;
    const WS = function (url, protocols) {
      const ping = protocols === 'vite-ping' || (Array.isArray(protocols) && protocols.includes('vite-ping'));
      return new RWS(ping ? 'ws://127.0.0.1:9/' : url, protocols);
    };
    WS.prototype = RWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WS[k] = RWS[k];
    window.WebSocket = WS;
    const RW = window.Worker;
    window.Worker = function (url, o) {
      const w = new RW(url, o);
      const rec = { made: Math.round(performance.now()), first: null, n: 0, err: null };
      P.log.workers.push(rec);
      w.addEventListener('message', () => {
        rec.n++;
        if (rec.first === null) rec.first = Math.round(performance.now() - rec.made);
      });
      w.addEventListener('error', (e) => { rec.err = e.message || 'error'; });
      return w;
    };
    const cw = console.warn.bind(console);
    console.warn = (...a) => {
      const s = a.map((x) => String(x)).join(' ');
      if (s.includes('spec refused')) P.log.refused++;
      if (P.log.warns.length < 60) P.log.warns.push(Math.round(performance.now()) + ' ' + s.slice(0, 240));
      cw(...a);
    };
    document.addEventListener('pointerdown', () => {
      if (P.log.click === null) P.log.click = performance.now();
    }, true);
    return 'installed';
  },

  /** Hooks into the live world. Call once the game is in play. */
  attach() {
    const A = window.__atc, w = A.world;
    if (P._att) return 'already';
    P._att = true;
    P.builds = { worker: 0, sync: 0 };
    // live WebGL buffers and textures, counted at the context: renderer.info
    // counts geometries, and an InstancedMesh's matrix buffer is not one
    P.gl = { buf: 0, tex: 0 };
    const gl = A.renderer.getContext();
    for (const [mk, rm, k] of [['createBuffer', 'deleteBuffer', 'buf'], ['createTexture', 'deleteTexture', 'tex']]) {
      const c = gl[mk].bind(gl), d = gl[rm].bind(gl);
      gl[mk] = () => { P.gl[k]++; return c(); };
      gl[rm] = (o) => { if (o) P.gl[k]--; return d(o); };
    }
    const sb = w._startBuild.bind(w);
    w._startBuild = function (key, ...r) {
      const ok = sb(key, ...r);
      if (ok) { if (this._inflight.get(key)?.job) P.builds.worker++; else P.builds.sync++; }
      return ok;
    };
    // every world.update is timed; the same wrapper is where a scripted drive
    // or a pinned helicopter moves the focus, so both builds are driven alike
    P.upd = []; P.frames = []; P._lastFrame = 0; P.rec = false;
    const up = w.update.bind(w);
    w.update = function (dt, focus, opts) {
      P._move?.(dt);
      const t0 = performance.now();
      const out = up(dt, focus, opts);
      if (P.rec) {
        const t1 = performance.now();
        P.upd.push(t1 - t0);
        if (P._lastFrame) P.frames.push(t0 - P._lastFrame);
        P._lastFrame = t0;
      }
      return out;
    };
    return 'attached';
  },

  /** The live settings. The original build has no __atc.settings: its panel
   *  writes every change to localStorage, and an untouched profile is medium. */
  gs() {
    if (window.__atc.settings) return window.__atc.settings;
    try { return JSON.parse(localStorage.getItem('atc-settings')) ?? { preset: 'medium' }; }
    catch { return { preset: 'medium' }; }
  },

  preset(name) {
    const sel = [...document.querySelectorAll('select')]
      .find((s) => [...s.options].some((o) => o.value === 'low') && [...s.options].some((o) => o.value === 'high'));
    if (!sel) return 'no preset select';
    sel.value = name;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return P.gs().preset;
  },

  // The page's own js/worldclock.js module, handed in by the caller
  // (`P.clock(await import('/js/worldclock.js'))`). Not imported from here on
  // purpose: a dynamic import in this file makes the dev server inject its
  // hot-reload client, and a tab of ANOTHER build then reloads on every save.
  clock(m) { P._clock = m; return !!m.setSoloTime; },
  /** The page's own js/shadowpace.js (merged build only), same reason. */
  shadow(m) { P._shadow = m; return !!m.shadowDue; },
  time(t) { P._tod = t; P._clock?.setSoloTime(t); return t; },

  /** Stand the player at a place, with the chase camera looking along `yaw`. */
  go(x, z, yaw = 0) {
    const A = window.__atc, p = A.player, w = A.world;
    P._move = null; P._drive = null; P.rec = false;
    if (A.game.heli) { A.game.heli = null; }
    w.city.ensureTiles?.(x, z)?.catch?.(() => {});
    p.pos.x = x; p.pos.z = z; p.heading = yaw;
    const gy = w.surfaceY?.(x, z)?.y ?? w.heightAt(x, z);
    p.y = gy; p.vy = 0; p.grounded = true;
    P._yaw = yaw;
    P._aim();
    return { x, z, y: Math.round(gy * 100) / 100 };
  },
  _aim() {
    // the chase cam's bearing is private to main.js; a drag of exactly the
    // right size is the public way to set it (0.004 rad per pixel, unlocked)
    const A = window.__atc;
    const d = A.cam().camYaw - P._yaw;
    A.input.dragX += Math.atan2(Math.sin(d), Math.cos(d)) / 0.004;
  },

  /** Pin the helicopter `agl` metres over a spot and put the player in it. */
  heli(x, z, agl, yaw = 0) {
    const A = window.__atc, h = A.heli, w = A.world;
    w.city.ensureTiles?.(x, z)?.catch?.(() => {});
    A.game.heli = h;
    P._yaw = yaw; P._drive = null; P.rec = false;
    P._move = () => {
      const g = w.terrain?.heightAt(x, z) ?? 0;
      h.x = x; h.z = z; h.y = g + agl; h.vx = 0; h.vy = 0; h.vz = 0;
      h.heading = yaw; h.airborne = true; h.pitch = 0; h.roll = 0; h.yawRate = 0;
    };
    return 'heli';
  },

  /** Carry the player along a polyline at `v` m/s (a car's pace, on foot). */
  drive(pts, v) {
    const A = window.__atc, p = A.player, w = A.world;
    const d = P._drive = { pts, i: 1, v, dist: 0, done: false };
    p.pos.x = pts[0][0]; p.pos.z = pts[0][1];
    P.upd.length = 0; P.frames.length = 0; P._lastFrame = 0;
    P.builds.worker = 0; P.builds.sync = 0; P.log.refused = 0;
    P._ans0 = w.pool?.answered ?? null;
    P._move = (dt) => {
      if (d.i >= d.pts.length) {
        if (!d.done) { d.done = true; try { localStorage.setItem('probe-drive', JSON.stringify(P.driveStats())); } catch { /* full */ } }
        P.rec = false; return;
      }
      const [tx, tz] = d.pts[d.i];
      const dx = tx - p.pos.x, dz = tz - p.pos.z, L = Math.hypot(dx, dz);
      // real elapsed time, not the frame's clamped dt: a slow frame must cost
      // distance, or a build that hitches would also get more frames to hide in
      const now = performance.now();
      const el = Math.min(0.25, (now - (d.t ?? now)) / 1000); d.t = now;
      const s = Math.min(L, d.v * el);
      if (L < 0.5) d.i++;
      else { p.pos.x += dx / L * s; p.pos.z += dz / L * s; d.dist += s; }
      p.y = w.surfaceY?.(p.pos.x, p.pos.z)?.y ?? w.heightAt(p.pos.x, p.pos.z);
      p.vy = 0; p.grounded = true;
    };
    P.rec = true;
    return 'driving';
  },
  driveStats() {
    const A = window.__atc, w = A.world, d = P._drive;
    const big = (a, ms) => a.reduce((n, v) => n + (v > ms ? 1 : 0), 0);
    return { done: d?.done, dist: Math.round(d?.dist ?? 0), leg: d?.i,
      frame: P.frames.length ? stat(P.frames) : null,
      over16: big(P.frames, 16.7), over33: big(P.frames, 33.4), over50: big(P.frames, 50),
      // milliseconds by which frames overran a 60 Hz slot, summed: unlike the
      // counts above it does not depend on how many frames the pump squeezed in
      lateMs: Math.round(P.frames.reduce((n, v) => n + Math.max(0, v - 16.7), 0)),
      secs: Math.round(P.frames.reduce((n, v) => n + v, 0) / 100) / 10,
      update: P.upd.length ? stat(P.upd) : null,
      worstUpdates: [...P.upd].sort((x, y) => y - x).slice(0, 5).map((v) => Math.round(v)),
      worstFrames: [...P.frames].sort((x, y) => y - x).slice(0, 5).map((v) => Math.round(v)),
      builds: { ...P.builds }, refused: P.log.refused,
      answered: w.pool ? (w.pool.answered ?? '?') - (P._ans0 ?? 0) : 'pool gone',
      poolDead: !w.pool || w.pool.dead };
  },

  status() {
    const A = window.__atc, w = A.world;
    if (P._tod !== undefined) P._clock?.setSoloTime(P._tod);
    if (P._yaw !== undefined && !P._drive?.t) P._aim();
    return { mode: A.game.mode, inflight: w._inflight.size, fill: w.queue.length,
      up: w.queueUp?.length ?? 0, built: w.built.size,
      quiet: !w._inflight.size && !w.queue.length && !(w.queueUp?.length),
      rings: [w.viewChunks, w.shellChunks, w.farChunks],
      pool: w.pool ? { dead: w.pool.dead, size: w.pool.size, ready: w.pool.ready, answered: w.pool.answered } : null,
      workers: P.log.workers, refused: P.log.refused, warns: P.log.warns.length,
      boot: P.log.play && P.log.click ? Math.round(P.log.play - P.log.click) : null };
  },

  /** n timed renders of the frame as it stands, then n timed sim steps. */
  measure(n = 40, simN = 30) {
    const A = window.__atc, r = A.renderer, gl = r.getContext();
    if (P._tod !== undefined) P._clock?.setSoloTime(P._tod);
    const pf = A.postfx;
    if (pf && !pf.__probe) {
      const o = pf.render.bind(pf);
      pf.__probe = o;
      pf.render = (s, c, opts) => { P._pfArgs = [s, c, opts]; return o(s, c, opts); };
    }
    const gs = P.gs();
    const post = !!pf && (gs.bloom !== false || gs.rays !== false || gs.mblur !== false
      || gs.flare !== false || gs.ao !== false);
    if (post && !P._pfArgs) return { err: 'no post frame captured yet, call again' };
    const frame = () => {
      // The merged game decides per frame whether the shadow map is redrawn
      // (js/shadowpace.js: every other frame under the moon, below the high
      // tier). Re-rendering one frame here would otherwise draw it once and
      // never again, and flatter the build. So the page's own rule is asked
      // for every sample, and the MEAN is the honest figure (the samples are
      // two populations at night).
      if (r.shadowMap.autoUpdate === false)
        r.shadowMap.needsUpdate = P._shadow ? P._shadow.shadowDue(gs, A.sky?.nightK ?? 0) : true;
      if (post) pf.__probe(...P._pfArgs); else r.render(A.scene, A.camera);
    };
    for (let i = 0; i < 4; i++) { frame(); gl.finish(); }
    const ts = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      frame(); gl.finish();
      ts.push(performance.now() - t0);
    }
    r.info.autoReset = false; r.info.reset();
    frame();
    const calls = r.info.render.calls, tris = r.info.render.triangles;
    r.info.autoReset = true;
    const sim = [];
    for (let i = 0; i < simN; i++) {
      const t0 = performance.now();
      A.stepGame(1 / 60);
      sim.push(performance.now() - t0);
    }
    const c = A.camera.position;
    return { preset: gs.preset, tod: Math.round((A.tod ?? 0) * 1000) / 1000, post,
      render: stat(ts), sim: stat(sim), calls, tris,
      geoms: r.info.memory.geometries, tex: r.info.memory.textures,
      programs: r.info.programs?.length ?? null,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      cars: A.traffic?.cars?.size ?? null,
      peds: A.peds?.bodies?.length ?? A.peds?.peds?.length ?? A.peds?.list?.length ?? null,
      px: [r.domElement.width, r.domElement.height],
      cam: [Math.round(c.x), Math.round(c.y), Math.round(c.z)],
      built: A.world.built.size };
  },

  /** What the last run() had finished, from this or an earlier page load. */
  saved() { try { return JSON.parse(localStorage.getItem('probe-results')) ?? []; } catch { return []; } },
  /** One row per result, the columns of the perf table. */
  rows(rs = P.results) {
    return rs.map((r) => [r.place, r.preset, r.tod, r.render.mean ?? r.render.med, r.render.p10, r.render.p90, r.sim.med,
      r.calls, r.tris, r.geoms, r.tex, r.heapMB, r.px.join('x'), r.post ? 1 : 0, r.cars, r.peds,
      r.cam.join(','), r.timedOut ? 'T' : ''].join(' '));
  },

  pause(on) { P.paused = !!on; if (!on) P._kick?.(); return P.paused; },

  /**
   * The whole matrix, run by the page itself: presets x places x hours. One
   * step per frame, so nothing here ever waits inside a console call.
   *   plan = { presets: ['medium'], tods: [0.5, 0], n: 40,
   *            places: [{ name, x, z, yaw, agl? }] }
   * Poll P.results / P.running.
   */
  run(plan) {
    const A = window.__atc;
    P.results = []; P.running = true;
    const todo = [];
    for (const pr of plan.presets) for (const pl of plan.places) todo.push({ pr, pl });
    let i = -1, st = 'next', t0 = 0, quiet = 0, ti = 0, cur = null;
    const tick = () => {
      try { step(); } catch (err) { P.running = false; P.error = String(err?.stack ?? err).slice(0, 400); }
    };
    const step = () => {
      if (!P.running) return;
      const now = performance.now();
      if (st === 'next') {
        if (++i >= todo.length) { P.running = false; P.pause(plan.pauseAfter !== false); return; }
        cur = todo[i];
        if (P.gs().preset !== cur.pr) P.preset(cur.pr);
        if (cur.pl.agl) P.heli(cur.pl.x, cur.pl.z, cur.pl.agl, cur.pl.yaw ?? 0);
        else P.go(cur.pl.x, cur.pl.z, cur.pl.yaw ?? 0);
        P.time(plan.tods[0]);
        t0 = now; quiet = 0; st = 'settle';
      } else if (st === 'settle') {
        P._clock?.setSoloTime(plan.tods[0]);
        if (!cur.pl.agl) P._aim();
        const s = A.world;
        quiet = (!s._inflight.size && !s.queue.length && !(s.queueUp?.length)) ? quiet + 1 : 0;
        const waited = now - t0;
        if ((waited > (plan.minWait ?? 6000) && quiet > 40) || waited > (cur.pl.maxWait ?? plan.maxWait ?? 70000)) {
          cur.settleMs = Math.round(waited); cur.timedOut = quiet <= 40;
          ti = 0; t0 = now; st = 'tod';
        }
      } else if (st === 'tod') {
        P._clock?.setSoloTime(plan.tods[ti]); P._tod = plan.tods[ti];
        if (now - t0 > (plan.todWait ?? 1500)) {
          const m = P.measure(plan.n ?? 40, plan.simN ?? 30);
          if (m.err) { t0 = now; }
          else {
            P.results.push({ place: cur.pl.name, settleMs: cur.settleMs, timedOut: cur.timedOut, ...m });
            // kept outside the page too: a tab that hangs or is closed half way
            // through a matrix must not take the finished cells with it
            try { localStorage.setItem('probe-results', JSON.stringify(P.results)); } catch { /* full */ }
            t0 = performance.now();
            if (++ti >= plan.tods.length) st = 'next';
          }
        }
      }
      window.requestAnimationFrame(tick);
    };
    P.pause(false);
    window.requestAnimationFrame(tick);
    return todo.length + ' cells queued';
  },

  /**
   * Teleport round `places` `laps` times and back to the first, waiting at each
   * for the streamer to go quiet, and note what the renderer holds. A leak is
   * a number that climbs lap over lap at the SAME place.
   */
  tour(places, laps = 3, opts = {}) {
    const A = window.__atc;
    P.tourLog = []; P.touring = true;
    const stops = [];
    for (let l = 0; l < laps; l++) for (const pl of places) stops.push({ lap: l + 1, pl });
    stops.push({ lap: laps + 1, pl: places[0] });
    let i = -1, t0 = 0, quiet = 0;
    const step = () => {
      if (!P.touring) return;
      const now = performance.now(), w = A.world;
      if (i >= 0) {
        quiet = (!w._inflight.size && !w.queue.length && !(w.queueUp?.length)) ? quiet + 1 : 0;
        const waited = now - t0;
        if (!((waited > (opts.minWait ?? 5000) && quiet > 40) || waited > (opts.maxWait ?? 45000))) {
          window.requestAnimationFrame(step); return;
        }
        P.tourLog.push({ lap: stops[i].lap, place: stops[i].pl.name, ms: Math.round(waited),
          T: quiet <= 40 ? 1 : 0, ...P.mem() });
        try { localStorage.setItem('probe-tour', JSON.stringify(P.tourLog)); } catch { /* full */ }
      }
      if (++i >= stops.length) { P.touring = false; return; }
      P.go(stops[i].pl.x, stops[i].pl.z, stops[i].pl.yaw ?? 0);
      t0 = now; quiet = 0;
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
    return stops.length + ' stops';
  },

  mem() {
    const r = window.__atc.renderer;
    return { glBuf: P.gl?.buf ?? null, glTex: P.gl?.tex ?? null,
      geoms: r.info.memory.geometries, tex: r.info.memory.textures,
      programs: r.info.programs?.length ?? null,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      built: window.__atc.world.built.size };
  },
};

// ---- round 5: who pays for a hitch, and what a lap leaves behind ------------
// Everything below is measurement only. Three designs, each reachable from
// plain page script (no DevTools heap snapshot):
//   trace()   exclusive milliseconds per named function inside world.update,
//             so a slow frame names its owner instead of "the streamer";
//   gc()      a major collection forced by allocation pressure and PROVEN by a
//             WeakRef sentinel that had been promoted to the old generation,
//             so usedJSHeapSize is read after garbage is gone, not before;
//   census()  the game's own containers counted, WeakRef samples of evicted
//             buildings and dropped chunk groups (a sample still alive after a
//             proven collection is a leak with a name), and every live WebGL
//             texture grouped by what it is.
Object.assign(P, {
  /** Wrap obj[name] so its EXCLUSIVE time lands in the current frame's row. */
  _wrap(obj, name, label) {
    const f = obj?.[name];
    if (typeof f !== 'function' || f.__probe) return;
    const st = P._stack;
    const w = function (...a) {
      const t0 = performance.now();
      st.push(0);
      try { return f.apply(this, a); }
      finally {
        const el = performance.now() - t0;
        const child = st.pop();
        if (st.length) st[st.length - 1] += el;
        const row = P._row;
        row[label] = (row[label] ?? 0) + el - child;
      }
    };
    w.__probe = true;
    obj[name] = w;
  },
  trace() {
    const A = window.__atc, w = A.world, it = w.interiors;
    if (P._traced) return 'already';
    P._traced = true; P._stack = []; P._row = {}; P.hitches = []; P.tot = {}; P.max = {}; P.cnt = {};
    P.over = {};                                   // label -> calls over 4 ms
    for (const n of ['_stepShellQ', '_drainChunks', '_occupantStep', 'activate', '_model', '_drop', '_populate', '_flushChunks'])
      P._wrap(it, n, 'int.' + n.replace('_', ''));
    P._wrap(it, 'update', 'int.scan');             // what is left of update IS the scan
    P._wrap(it.debris, 'update', 'int.fx'); P._wrap(it.dust, 'update', 'int.fx');
    P._wrap(w, '_warmRoads', 'warm');
    P._wrap(w, '_bakeStep', 'bake'); P._wrap(w, '_startBake', 'bake');
    P._wrap(w, '_warmVerges', 'vergeWarm'); P._wrap(w, '_sweepMarks', 'markSweep');
    P._wrap(it, '_stepFullQ', 'int.fullQ'); P._wrap(it, '_stepPopQ', 'int.popQ'); P._wrap(it, '_spawnOccupant', 'int.popQ');
    P._wrap(w, '_landFlights', 'land');
    P._wrap(w, '_landRibbons', 'landRibbon');
    P._wrap(w, '_pumpBuild', 'syncBuild');
    P._wrap(w, '_sweepFarRibbons', 'ribbons');
    P._wrap(w, '_dropTileChunks', 'dropTile');
    P._wrap(w, '_flushGuessedDrops', 'guessDrops');
    P._wrap(w, '_rebuildBuildings', 'rebuildBld');
    P._wrap(w.poles, 'update', 'poles');
    if (w.pool) P._wrap(w.pool, 'submit', 'spec');
    P._wrap(w.city, 'ensureTiles', 'ensureTiles');
    const up = w.update;                           // attach()'s wrapper, or the method
    w.update = function (dt, focus, opts) {
      P._row = {}; P._stack.length = 0;
      const t0 = performance.now();
      P._stack.push(0);
      const out = up.call(this, dt, focus, opts);
      const el = performance.now() - t0, child = P._stack.pop();
      const row = P._row; row.rest = el - child; row.total = el;
      if (P.rec || P.recAll) {
        for (const k in row) {
          P.tot[k] = (P.tot[k] ?? 0) + row[k];
          if (row[k] > (P.max[k] ?? 0)) P.max[k] = row[k];
          if (row[k] > 4) P.over[k] = (P.over[k] ?? 0) + 1;
          P.cnt[k] = (P.cnt[k] ?? 0) + 1;
        }
        if (el > (P.hitchMs ?? 12) && P.hitches.length < 400) {
          const r = { at: Math.round(performance.now()) };
          for (const k in row) if (row[k] > 0.5) r[k] = Math.round(row[k] * 10) / 10;
          P.hitches.push(r);
        }
      }
      return out;
    };
    return 'tracing';
  },
  traceStats() {
    const r1 = (v) => Math.round(v * 10) / 10;
    const out = {};
    for (const k of Object.keys(P.max).sort((a, b) => P.max[b] - P.max[a]))
      out[k] = [r1(P.max[k]), r1(P.tot[k]), P.over[k] ?? 0, P.cnt[k]];   // max, sum, calls>4ms, calls
    return { labels: out, worst: [...P.hitches].sort((a, b) => b.total - a.total).slice(0, 12) };
  },
  traceReset() { P.hitches = []; P.tot = {}; P.max = {}; P.cnt = {}; P.over = {}; },

  /**
   * A REAL major collection, and the only way found to get one from page
   * script. usedJSHeapSize counts garbage, and V8 lets a gigabyte heap grow
   * by another gigabyte before it marks: measured here, the same spot read
   * 2305 MB and, thirty seconds later with nothing changed, 1073 MB. Pressure
   * does not help (a WeakRef sentinel dies in a scavenge and proves nothing;
   * three variants were tried and each time the reading went UP). What works
   * is what the browser does for a tab at rest: tell V8 a context died (a
   * detached iframe), stop every frame (the pump is paused, so nothing
   * allocates) and wait for its idle-time collector, which marks the whole
   * heap. The reading is taken when the heap has dropped and then stood still
   * for `calm` seconds. Polled once a second from a WORKER's timer: a page
   * hidden for five minutes has its own timers woken once a minute (the first
   * version of this used setInterval and a stop took six minutes), a worker's
   * are left alone. cb({ heapMB, before, secs, dropped }).
   */
  idleGC(cb, opts = {}) {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.appendChild(f); f.remove();
    P.pause(true);
    const h = () => performance.memory.usedJSHeapSize / 1048576;
    const s = { t0: performance.now(), h0: h(), min: h(), last: h(), calm: 0 };
    P._tick ??= new Worker(URL.createObjectURL(new Blob(
      ['setInterval(() => postMessage(0), 1000);'], { type: 'text/javascript' })));
    P._tick.onmessage = () => {
      const v = h();
      s.calm = Math.abs(v - s.last) < Math.max(4, s.last * 0.004) ? s.calm + 1 : 0;
      s.last = v; if (v < s.min) s.min = v;
      const el = performance.now() - s.t0;
      const dropped = s.min < s.h0 * 0.97;
      if ((dropped && s.calm >= (opts.calm ?? 6)) || el > (opts.maxMs ?? 50000)) {
        P._tick.onmessage = null;
        P.pause(false);
        cb({ heapMB: Math.round(s.last), before: Math.round(s.h0), secs: Math.round(el / 1000), dropped });
      }
    };
    return 'collecting';
  },

  /** Hooks for the leak samples. Call once in play, after attach(). */
  watch() {
    const A = window.__atc, w = A.world;
    if (P._watching) return 'already';
    P._watching = true;
    P.samples = new Map();                         // 'tx,tz' -> WeakRef[] of every 40th building
    P.groups = [];                                 // WeakRef of every chunk group that was built
    const fb = w._finalizeBuild;
    w._finalizeBuild = function (inf, group, ...r) {
      if (group) P.groups.push(new WeakRef(group));
      return fb.call(this, inf, group, ...r);
    };
    // every texture three ever asks about, weakly, with what it was
    P.texs = new Map();
    const pr = A.renderer.properties, og = pr.get.bind(pr);
    P._props = og;
    pr.get = (o) => {
      if (o && o.isTexture && !P.texs.has(o.id)) {
        const im = o.image, d = Array.isArray(im) ? im[0] : im;
        P.texs.set(o.id, { ref: new WeakRef(o), what: [o.constructor.name, o.name || '-',
          (d?.width ?? '?') + 'x' + (d?.height ?? '?'), d?.constructor?.name ?? typeof d].join('|') });
      }
      return og(o);
    };
    return 'watching';
  },
  _sampleTiles() {
    if (!P.samples) return;                        // watch() not called: nothing to sample into
    const city = window.__atc.world.city;
    for (const t of city.manifestTiles ?? []) {
      const k = t.tx + ',' + t.tz;
      if (t.state !== 2 || !t.heavy) continue;
      const cur = P.samples.get(k);
      if (cur && cur.first === t.heavy.buildings[0]) continue;      // this load already sampled
      const refs = cur?.refs ?? [];
      for (let i = 0; i < t.heavy.buildings.length; i += 40) refs.push(new WeakRef(t.heavy.buildings[i]));
      P.samples.set(k, { refs, first: t.heavy.buildings[0] });
    }
  },
  texCensus() {
    const by = {};
    let live = 0;
    for (const [id, e] of P.texs) {
      const t = e.ref.deref();
      if (!t) { P.texs.delete(id); continue; }
      if (P._props(t).__webglTexture === undefined && P._props(t).__webglInit === undefined) continue;
      live++; by[e.what] = (by[e.what] ?? 0) + 1;
    }
    return { live, by };
  },
  census() {
    const A = window.__atc, w = A.world, city = w.city, it = w.interiors, T = w.terrain;
    P._sampleTiles?.();
    const tiles = [0, 0, 0, 0];
    for (const t of city.manifestTiles ?? []) tiles[t.state]++;
    // evicted buildings that something still holds: samples of tiles that are
    // SLIM now, or loaded again with different objects
    let leakB = 0, sampB = 0;
    for (const [k, s] of P.samples ?? []) {
      const t = (city.manifestTiles ?? []).find((m) => m.tx + ',' + m.tz === k);
      const cur = t?.state === 2 && t.heavy ? new Set(t.heavy.buildings) : null;
      s.refs = s.refs.filter((r) => {
        const o = r.deref();
        if (!o) return false;
        if (cur?.has(o)) return true;              // still loaded: not a leak, keep watching
        leakB++; return true;
      });
      sampB += s.refs.length;
    }
    let leakG = 0;
    if (P.groups) {
      const liveG = new Set(w.built.values());
      for (const g of w._farRibbons?.values() ?? []) liveG.add(g);
      P.groups = P.groups.filter((r) => { const g = r.deref(); if (!g) return false; if (!liveG.has(g)) leakG++; return true; });
    }
    let prof = 0, vg = 0, cells = 0, feats = 0;
    for (const r of city.roads) { if (r._prof) prof++; if (r._vg !== undefined) vg++; }
    for (const c of city.chunkIndex.values()) { cells++; for (const k in c) feats += c[k].length; }
    let scene = 0; A.scene.traverse(() => { scene++; });
    const sz = (m) => m?.size ?? m?.length ?? 0;
    return { heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), 
      ...P.mem(), tiles: tiles.join('/'),
      bld: city.buildings.length, trees: city.trees.length, roads: city.roads.length, cells, feats, prof, vg,
      grids: sz(T.grids), raw: sz(T._raw), canopy: sz(w.canopy?.grids ?? w.canopy?.tiles), ground: sz(w.ground?.grids ?? w.ground?.tiles),
      detail: sz(w._detail), px: sz(w._px), had: sz(w._hadTerrain), miss: sz(w._missBy), stale: sz(w._stale),
      ribbons: sz(w._farRibbons), retried: sz(w._rasterRetried), models: sz(it.models), hidden: sz(it.hidden),
      occ: sz(it.occupants), scene, cars: sz(A.traffic?.cars), leakB, sampB, leakG, groups: sz(P.groups),
      texLive: P.texs ? P.texCensus().live : null };
  },

  /** A loaded tile is still waiting its turn to go slim (geo evicts one a second). */
  _evictDue() {
    const A = window.__atc, city = A.world.city, T = city.tile || 4800, p = A.player.pos;
    for (const t of city.manifestTiles ?? []) {
      if (t.state !== 2 || !t.heavy) continue;
      const dx = Math.max(t.tx * T - p.x, 0, p.x - (t.tx + 1) * T), dz = Math.max(t.tz * T - p.z, 0, p.z - (t.tz + 1) * T);
      if (dx * dx + dz * dz > 9000 * 9000) return true;
    }
    return false;
  },
  /**
   * tour() with a proven collection before every reading. One step a frame.
   * A row per stop: P.tour2Log (also localStorage 'probe-tour2').
   */
  tour2(places, laps = 3, opts = {}) {
    const A = window.__atc;
    P.tour2Log = []; P.tex2 = []; P.touring = true;
    const stops = [];
    for (let l = 0; l < laps; l++) for (const pl of places) stops.push({ lap: l + 1, pl });
    stops.push({ lap: laps + 1, pl: places[0] });
    let i = -1, t0 = 0, quiet = 0, st = 'go', waited = 0;
    const step = () => {
      if (!P.touring) return;
      const now = performance.now(), w = A.world;
      if (st === 'go') {
        if (++i >= stops.length) { P.touring = false; return; }
        P.go(stops[i].pl.x, stops[i].pl.z, stops[i].pl.yaw ?? 0);
        t0 = now; quiet = 0; st = 'settle';
      } else if (st === 'settle') {
        quiet = (!w._inflight.size && !w.queue.length && !(w.queueUp?.length)) ? quiet + 1 : 0;
        waited = now - t0;
        if ((waited > (opts.minWait ?? 6000) && quiet > 40 && !P._evictDue()) || waited > (opts.maxWait ?? 60000)) {
          st = 'gc';
          const at = i, w8 = waited, q = quiet;
          // the pump is paused inside: this frame's re-arm below simply waits
          P.idleGC((g) => {
            const row = { lap: stops[at].lap, place: stops[at].pl.name, ms: Math.round(w8), T: q <= 40 ? 1 : 0,
              gcSecs: g.secs, gcFrom: g.before, gcOK: g.dropped ? 1 : 0, ...P.census(), heapMB: g.heapMB };
            P.tour2Log.push(row);
            P.tex2.push(P.texs ? P.texCensus().by : null);
            try { localStorage.setItem('probe-tour2', JSON.stringify(P.tour2Log)); } catch { /* full */ }
            st = 'go';
          }, opts);
        }
      }
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
    return stops.length + ' stops';
  },
});

// ---- round 5: is it the same world ------------------------------------------
// A performance fix must change nothing that is drawn. Screenshots cannot say
// so (traffic and people move), so the static world is summed instead: every
// built chunk (meshes, vertices, and the summed WORLD position of its vertices
// and instances), every terrain tile after its earthworks, and every building
// that stands as boxes (pieces, survivors, a checksum, shell or full).
// World positions, not the raw arrays: the same chunk is float32 metres when
// this thread built it and int16 about its own centre when a worker did, and
// which of the two a boot gets is a race. Two worlds are the same when no
// chunk's mean position moved by more than the codec's own few millimetres.
Object.assign(P, {
  fingerprint() {
    const A = window.__atc, w = A.world;
    const out = { chunks: {}, tiles: {}, models: {} };
    for (const [key, g] of w.built) {
      if (!g) { out.chunks[key] = [0, 0, 0, 0, 0, 0]; continue; }
      g.updateWorldMatrix(true, true);
      let n = 0, v = 0, k = 0, sx = 0, sy = 0, sz = 0;
      g.traverse((o) => {
        const p = o.geometry?.attributes?.position;
        if (!p) return;
        n++;
        const e = o.matrixWorld.elements;
        if (o.isInstancedMesh) {
          // where each instance stands (its template is the same data either way)
          const m = o.instanceMatrix.array;
          v += o.count;
          for (let i = 0; i < o.count; i++) {
            const x = m[i * 16 + 12], y = m[i * 16 + 13], z = m[i * 16 + 14];
            sx += e[0] * x + e[4] * y + e[8] * z + e[12];
            sy += e[1] * x + e[5] * y + e[9] * z + e[13];
            sz += e[2] * x + e[6] * y + e[10] * z + e[14];
            k++;
          }
          return;
        }
        v += p.count;
        for (let i = 0; i < p.count; i += 3) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          sx += e[0] * x + e[4] * y + e[8] * z + e[12];
          sy += e[1] * x + e[5] * y + e[9] * z + e[13];
          sz += e[2] * x + e[6] * y + e[10] * z + e[14];
          k++;
        }
      });
      out.chunks[key] = [n, v, k, Math.round(sx * 100) / 100, Math.round(sy * 100) / 100, Math.round(sz * 100) / 100];
    }
    for (const [k, g] of w.terrain.grids) {
      if (!g) continue;
      let s = 0;
      for (let i = 0; i < g.length; i++) s += g[i];
      out.tiles[k] = s + (w.terrain._conformed?.has(k) ? 'c' : 'u');
    }
    for (const [id, m] of w.interiors.models) {
      let s = 0;
      for (const p of m.pieces) s += p.x + p.y * 3 + p.z * 7 + p.k;
      out.models[id] = m.pieces.length + '/' + m.alive + '/' + Math.round(s * 100) + (m.interiorBuilt ? 'F' : 'S');
    }
    return out;
  },
  fpSave(name) {
    const f = P.fingerprint();
    localStorage.setItem('fp-' + name, JSON.stringify(f));
    return { chunks: Object.keys(f.chunks).length, models: Object.keys(f.models).length,
      full: Object.values(f.models).filter((s) => s.endsWith('F')).length,
      tiles: Object.values(f.tiles).filter((s) => s.endsWith('c')).length + ' baked' };
  },
  /** What differs between a saved fingerprint and the world as it stands. */
  fpDiff(name, tol = 0.005) {
    const a = JSON.parse(localStorage.getItem('fp-' + name) ?? 'null'), b = P.fingerprint();
    if (!a) return 'no such fingerprint';
    const out = {};
    for (const part of ['chunks', 'tiles', 'models']) {
      const keys = new Set([...Object.keys(a[part]), ...Object.keys(b[part])]);
      let same = 0, worst = 0; const diff = [];
      for (const k of keys) {
        const x = a[part][k], y = b[part][k];
        let eq = x === y;
        if (part === 'chunks' && x && y) {
          // the same meshes and vertices, standing in the same place on average
          const d = Math.max(Math.abs(x[3] - y[3]), Math.abs(x[4] - y[4]), Math.abs(x[5] - y[5])) / Math.max(1, x[2]);
          eq = x[0] === y[0] && x[1] === y[1] && d <= tol;
          if (x[0] === y[0] && x[1] === y[1] && d > worst) worst = d;
        }
        if (eq) same++; else diff.push(k + ' ' + JSON.stringify(x) + ' -> ' + JSON.stringify(y));
      }
      out[part] = { same, differ: diff.length, first: diff.slice(0, 5) };
      if (part === 'chunks') out[part].worstMeanShiftMm = Math.round(worst * 10000) / 10;
    }
    return out;
  },
});

// ---- round 7: where a boot's seconds go -------------------------------------
// bootPhases() at the MENU, before the click (with install()); bootReport()
// once in play. Every fetch is timed to its parsed body (the main thread's
// JSON.parse is the part a player waits for), and the streamer's warm-up is
// timed from its first readyFull() question to its last.
Object.assign(P, {
  async bootPhases() {
    performance.setResourceTimingBufferSize(5000);
    P.fetches = [];
    const rf = window.fetch.bind(window);
    window.fetch = async (u, o) => {
      const rec = { u: String(u).replace(/^.*\/data\//, ''), t0: performance.now(), hdr: 0, body: 0, kb: 0 };
      P.fetches.push(rec);
      const res = await rf(u, o);
      rec.hdr = performance.now();
      const json = res.json.bind(res), ab = res.arrayBuffer.bind(res);
      res.json = async () => { const t = performance.now(); const v = await json(); rec.body = performance.now(); rec.parse = rec.body - t; return v; };
      res.arrayBuffer = async () => { const v = await ab(); rec.body = performance.now(); rec.kb = v.byteLength >> 10; return v; };
      return res;
    };
    const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/js\/city\.js/.test(n));
    const { CityWorld } = await import(url ?? '/js/city.js');
    const rr = CityWorld.prototype.readyFull;
    P.warm = { first: 0, last: 0, n: 0 };
    CityWorld.prototype.readyFull = function (...a) {
      const now = performance.now();
      if (!P.warm.first) P.warm.first = now;
      P.warm.last = now; P.warm.n++;
      return rr.apply(this, a);
    };
    return url ?? 'no city.js url';
  },
  bootReport() {
    const c = P.log.click, r = (v) => (v ? Math.round(v - c) : null);
    const tiles = (P.fetches ?? []).filter((f) => f.t0 < (P.log.play ?? Infinity));
    return { play: r(P.log.play), world: r(P.log.world), warmFrom: r(P.warm?.first), warmTo: r(P.warm?.last), warmCalls: P.warm?.n,
      fetches: tiles.map((f) => [f.u, r(f.t0), r(f.hdr), r(f.body), Math.round(f.parse ?? 0)].join(' ')) };
  },
});

export default P;
