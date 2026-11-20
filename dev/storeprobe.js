// ---- storeprobe: look at one shop of the running game from fixed viewpoints ----
// A dev tool, never imported by the game. Loaded from the console:
//
//   const S = (await import('/dev/storeprobe.js')).default; await S.init();
//   const f = S.find(/lidl/i, -388, -125);     // the named building nearest a point
//   S.stand(f, 30);                            // put the player before its door
//   S.front(f, 'lidl-front');                  // a still from the car park
//
// Stills are rendered by a throwaway camera straight to the canvas and POSTed
// to a local sink (a ten-line node receiver), so two builds give the same view.

let A = null, I = null, T = null;
const S = {
  sink: 'http://127.0.0.1:5498/',
  async init() {
    A = window.__atc;
    I = await import('/js/interiors.js');
    T = await import('/libs/three.module.js');
    return !!A;
  },
  /** Every named building matching `re` within r metres of (x, z), nearest first. */
  all(re, x, z, r = 400) {
    const idx = A.world.city.chunkIndex, seen = new Set(), out = [];
    for (const cell of idx.values()) for (const f of cell.buildings ?? []) {
      if (!f.n || seen.has(f._id) || !re.test(f.n) || !f.o?.length) continue;
      seen.add(f._id);
      let cx = 0, cz = 0;
      for (const p of f.o) { cx += p[0]; cz += p[1]; }
      cx /= f.o.length; cz /= f.o.length;
      const d = Math.hypot(cx - x, cz - z);
      if (d < r) out.push({ f, d, cx, cz });
    }
    return out.sort((a, b) => a.d - b.d);
  },
  find(re, x, z, r = 400) { return S.all(re, x, z, r)[0]?.f ?? null; },
  cellOf(f) { return A.world.city.chunkIndex.get(f._home); },
  ent(f) { const c = S.cellOf(f); return I.entranceOf(f, c?.roads, c?.buildings); },
  info(f) {
    const e = S.ent(f);
    return { id: f._id, n: f.n, u: f.u, t: f.t, h: f.h, use: I.classify(f), pts: f.o.length,
      area: Math.round(Math.abs(f._area ?? 0)), ent: e && { x: +e.x.toFixed(1), z: +e.z.toFixed(1), nx: +e.nx.toFixed(2), nz: +e.nz.toFixed(2) } };
  },
  /** Teleport: the tiles round (x, z) are asked for and the player stood there. */
  go(x, z, heading = 0) {
    const p = A.player, w = A.world;
    w.city.ensureTiles?.(x, z)?.catch?.(() => {});
    p.pos.x = x; p.pos.z = z; p.heading = heading;
    p.y = w.surfaceY?.(x, z)?.y ?? w.heightAt(x, z); p.vy = 0; p.grounded = true;
    return { x, z, y: +p.y.toFixed(2) };
  },
  /** Stand the player d metres out from the door, facing it. */
  stand(f, d = 12) {
    const e = S.ent(f);
    return S.go(e.x + e.nx * d, e.z + e.nz * d, Math.atan2(e.nx, e.nz));
  },
  /** A still from eye [x,y,z] looking at [x,y,z] (y absolute), sent to the sink as `name`. */
  shot(name, eye, look, fov = 55, w = 1440, h = 810) {
    const r = A.renderer, cam = new T.PerspectiveCamera(fov, w / h, 0.2, 3000);
    cam.position.set(...eye); cam.lookAt(...look); cam.updateMatrixWorld(true);
    const old = new T.Vector2(); r.getSize(old);
    const pr = r.getPixelRatio();
    r.setPixelRatio(1); r.setSize(w, h, false);
    r.setRenderTarget(null);
    r.render(A.scene, cam);
    const url = r.domElement.toDataURL('image/jpeg', 0.9);
    r.setPixelRatio(pr); r.setSize(old.x, old.y, false);
    fetch(S.sink + encodeURIComponent(name), { method: 'POST', mode: 'no-cors', body: url }).catch(() => {});
    return url.length;
  },
  /** From the car park: d metres out along the door's normal, `side` metres along the wall, eye height up. */
  front(f, name, d = 34, side = 10, up = 5) {
    const e = S.ent(f), g = A.world.heightAt(e.x, e.z);
    const tx = -e.nz, tz = e.nx;
    return S.shot(name, [e.x + e.nx * d + tx * side, g + up, e.z + e.nz * d + tz * side], [e.x, g + 2.6, e.z]);
  },
  /** From above and behind the car park: the whole lot. */
  aerial(f, name, d = 70, up = 45) {
    const e = S.ent(f), g = A.world.heightAt(e.x, e.z);
    return S.shot(name, [e.x + e.nx * d, g + up, e.z + e.nz * d], [e.x - e.nx * 15, g, e.z - e.nz * 15], 50);
  },
  /** From just inside the door, looking down the shop. */
  inside(f, name, depth = 3, up = 1.7, side = 0) {
    const e = S.ent(f), g = A.world.heightAt(e.x, e.z);
    const tx = -e.nz, tz = e.nx;
    return S.shot(name, [e.x - e.nx * depth + tx * side, g + up, e.z - e.nz * depth + tz * side],
      [e.x - e.nx * (depth + 20) + tx * side, g + 1.2, e.z - e.nz * (depth + 20) + tz * side], 70);
  },
  // ---- the generated stores (js/stores/) ----
  /** Mute, noon, and the site modules: call once after the game is in play. */
  async setup(tod = 0.5) {
    await S.init();
    (await import('/js/worldclock.js')).overrideTod(tod);
    (await import('/js/settings.js')).getSettings().volume = 0;
    (await import('/js/audio.js')).setVolume(0);
    S.SI = await import('/js/stores/site.js'); S.CH = await import('/js/stores/chains.js');
    S.SI.setStoreCity(A.world.city);
    return true;
  },
  /** The front wall of a chain building as the store generator picks it: { x, z, nx, nz, L }. */
  frontOf(f) {
    const ch = S.CH.chainOfName(f.n), i = f._sf ?? S.SI.pickFront(f, ch, S.SI.around(f, S.cellOf(f)));
    const o = f.o, a = o[i], b = o[(i + 1) % o.length];
    let s = 0;
    for (let k = 0; k < o.length; k++) { const p = o[k], q = o[(k + 1) % o.length]; s += p[0] * q[1] - q[0] * p[1]; }
    const sg = s > 0 ? 1 : -1, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, nx: sg * (b[1] - a[1]) / L, nz: -sg * (b[0] - a[0]) / L, L };
  },
  /** Stand the player before the front of the chain building nearest (x, z). */
  goFront(re, x, z, d = 14) {
    const f = S.find(re, x, z, 500);
    if (!f) return 'none';
    S.f = f;
    const F = S.frontOf(f);
    S.go(F.x + F.nx * d, F.z + F.nz * d, Math.atan2(F.nx, F.nz));
    return { n: f.n, lm: f._lm, front: [Math.round(F.x), Math.round(F.z)], L: Math.round(F.L) };
  },
  /** Three stills of S.f from its car park: front, aerial, near. The same views before and after. */
  three(tag) {
    const F = S.frontOf(S.f), g = A.world.heightAt(F.x + F.nx * 3, F.z + F.nz * 3);
    const tx = -F.nz, tz = F.nx, d = Math.max(26, Math.min(60, F.L * 0.75));
    return [S.shot(tag + '-front', [F.x + F.nx * d + tx * d * 0.35, g + 5, F.z + F.nz * d + tz * d * 0.35], [F.x, g + 3, F.z]),
      S.shot(tag + '-aerial', [F.x + F.nx * (d + 30), g + 48, F.z + F.nz * (d + 30)], [F.x - F.nx * 12, g, F.z - F.nz * 12], 50),
      S.shot(tag + '-near', [F.x + F.nx * 13 - tx * 5, g + 1.8, F.z + F.nz * 13 - tz * 5], [F.x + tx * 3, g + 2.4, F.z + tz * 3], 62)];
  },
  /** The store record the runtime holds for S.f (js/stores/world.js). */
  rec() { return A.world.stores.list.find((r) => r.f === S.f) ?? null; },
  /** A still inside S.f, in its room's own axes: from (a, b, up) toward (la, lb, lup). */
  room(name, a, b, up, la, lb, lup, fov = 68) {
    const rec = S.rec(), R = rec.full.layout.room, y = rec.base + rec.site.floor;
    const [x, z] = R.at(a, b), [lx, lz] = R.at(la, lb);
    return S.shot(name, [x, y + up, z], [lx, y + lup, lz], fov);
  },
  /** Stand the player at room point (a, b) of S.f. */
  stand2(a, b, heading = null) {
    const rec = S.rec(), [x, z] = rec.full.layout.room.at(a, b), p = A.player;
    p.pos.x = x; p.pos.z = z; p.y = rec.base + rec.site.floor; p.vy = 0;
    if (heading !== null) p.heading = heading;
    return [x, z];
  },
};
export default S;
