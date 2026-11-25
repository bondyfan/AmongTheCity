// ---- navprobe: drive the satnav route and look at the maps ---------------------
// A dev tool, never imported by the game. Loaded into a running tab:
//
//   const N = (await import('/dev/navprobe.js')).default;
//   N.seat('octavia');          // a car under the player, already sat in
//   N.pin(x, z);                // the world map's waypoint → a route
//   N.drive(14);                // the car follows the route at 14 m/s
//   N.timeOn(); ... N.timeStats();   // minimap/navline cost per frame
//   N.shot('name');             // the minimap canvas to the local sink
//
// It only touches what window.__atc exposes (and the career host behind it),
// so the same file drives the game before and after a change.

const A = () => window.__atc;
// the career host has navigation and the minimap; newer builds also expose them on __atc
const H = () => {
  const a = window.__atc;
  return a.navigation ? { navigation: a.navigation, minimap: a.minimap } : a.career.debug.garage.h;
};
const SINK = 'http://127.0.0.1:5470/';

const stat = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const q = (p) => s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const r = (v) => Math.round(v * 1000) / 1000;
  return { med: r(q(0.5)), mean: r(s.reduce((t, v) => t + v, 0) / n), p90: r(q(0.9)), max: r(s[n - 1]), n };
};

const N = {
  H,
  /** Spawn a car with the dev panel's own button (it unlocks it) and get in
   *  through the real E handler. Needs ?devmode. */
  seat(kind = 'octavia') {
    const a = A(), p = a.player;
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Spawnout');
    if (!btn) return 'no dev panel (?devmode)';
    const before = new Set(a.vehicles.cars);
    btn.previousElementSibling.value = kind;
    btn.click();
    for (let i = 0; i < 5; i++) a.stepGame(1 / 60);
    const car = [...a.vehicles.cars].find((c) => !before.has(c));
    if (!car) return 'no car spawned';
    p.pos.x = car.x + Math.cos(car.heading) * 2.0;
    p.pos.z = car.z - Math.sin(car.heading) * 2.0;
    a.input.keyHandlers.get('KeyE')?.();
    for (let i = 0; i < 900 && a.game.car !== car; i++) a.stepGame(1 / 60);
    return a.game.car === car ? 'seated' : 'not seated';
  },
  /** Drop the world map's waypoint. */
  pin(x, z) {
    const wm = A().worldMap;
    wm.setWaypoint(x, z);
    return wm.waypoint;
  },
  route() {
    const nav = H().navigation;
    return nav?.route ? { n: nav.route.length, m: Math.round(nav.remainingM), partial: nav.partial } : null;
  },
  /** Carry the car along the route at v m/s, keeping to the right (or left)
   *  lane. Follows a re-route (a career job moving the pin) from wherever
   *  navigation then has the car. */
  drive(v = 14, lane = 1.8) {
    const a = A(), nav = H().navigation;
    if (!nav?.route || !a.game.car) return 'no route or car';
    const d = N._d = { s: 0, v, lane, i: 0, last: performance.now(), route: null, cum: null };
    const sync = () => {
      const r = d.route = nav.route;
      d.cum = [0];
      for (let i = 1; i < r.length; i++) d.cum.push(d.cum[i - 1] + Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]));
      d.s = nav.routeS ?? nav._s ?? 0; d.i = 0;
    };
    sync();
    const up = a.world.update.bind(a.world);
    if (!N._wrapped) {
      N._wrapped = true;
      a.world.update = function (dt, focus, opts) {
        N._move?.();
        return up(dt, focus, opts);
      };
    }
    N._move = () => {
      const car = a.game.car;
      if (!car || N.paused || !nav.route) return;
      if (d.route !== nav.route) sync();
      const r = d.route, cum = d.cum;
      const now = performance.now();
      const el = Math.min(0.1, (now - d.last) / 1000); d.last = now;
      d.s = Math.min(cum[cum.length - 1] - 1, d.s + d.v * el);
      while (d.i < r.length - 2 && cum[d.i + 1] < d.s) d.i++;
      const L = (cum[d.i + 1] - cum[d.i]) || 1e-6, t = (d.s - cum[d.i]) / L;
      const dx = (r[d.i + 1][0] - r[d.i][0]) / L, dz = (r[d.i + 1][1] - r[d.i][1]) / L;
      // right of travel is (−dz, dx) in this frame (x east, z south)
      const x = r[d.i][0] + (r[d.i + 1][0] - r[d.i][0]) * t - dz * d.lane;
      const z = r[d.i][1] + (r[d.i + 1][1] - r[d.i][1]) * t + dx * d.lane;
      car.x = x; car.z = z; car.heading = Math.atan2(-dx, -dz); car.speed = d.v;
      car._lat = 0;
      const gy = a.world.surfaceY?.(x, z)?.y;
      if (gy !== undefined && car.y !== undefined) car.y = gy;
    };
    return 'driving from ' + Math.round(d.s) + ' m';
  },
  stop() { N._move = null; const c = A().game.car; if (c) c.speed = 0; return 'stopped'; },
  /** Time the minimap's per-frame update (and the nav line's, when exposed). */
  timeOn() {
    const h = H();
    N.t = { mini: [], line: [] };
    const wrap = (obj, key, bucket) => {
      if (!obj || obj['__nav' + key]) return;
      const o = obj[key].bind(obj);
      obj['__nav' + key] = o;
      obj[key] = function (...args) {
        const t0 = performance.now();
        const out = o(...args);
        N.t?.[bucket].push(performance.now() - t0);
        return out;
      };
    };
    wrap(h.minimap, 'update', 'mini');
    wrap(A().navLine ?? null, 'update', 'line');
    return 'timing';
  },
  timeStats() { return { mini: stat(N.t?.mini ?? []), line: stat(N.t?.line ?? []) }; },
  /** Post an image (data URL) to the local sink. */
  post(name, url) {
    return fetch(SINK, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ name, url }) }).then(() => name);
  },
  postText(name, text) {
    return fetch(SINK, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ name, text }) }).then(() => name);
  },
  /** The minimap canvas as it is drawn (its own pixels, before CSS scaling). */
  // (the new disc is two layers: snapshot() composes them; never toDataURL the
  // live #minimap canvas itself, a readback can move it off the GPU path)
  shot(name) {
    const mm = H().minimap;
    const c = mm.snapshot ? mm.snapshot() : mm.canvas;
    return N.post(name, c.toDataURL('image/png'));
  },
  /** The 3D frame plus the HUD minimap pasted where CSS puts it. */
  frame(name) {
    const a = A(), r = a.renderer, pf = a.postfx;
    // the post chain's own call, captured once, so the shot has the bloom a
    // player sees (a bare render() would drop it)
    if (pf && !pf.__navo) {
      const o = pf.render.bind(pf);
      pf.__navo = o;
      pf.render = (s, c, opts) => { N._pf = [s, c, opts]; return o(s, c, opts); };
      return 'armed, call again';
    }
    if (pf && N._pf) pf.__navo(...N._pf); else r.render(a.scene, a.camera);
    const src = r.domElement;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    const mm = H().minimap.canvas, rb = mm.getBoundingClientRect(), sb = src.getBoundingClientRect();
    const k = src.width / sb.width;
    g.drawImage(mm, (rb.left - sb.left) * k, (rb.top - sb.top) * k, rb.width * k, rb.height * k);
    return N.post(name, c.toDataURL('image/jpeg', 0.9));
  },
};

export default N;
