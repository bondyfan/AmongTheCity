// ---- coopprobe: what does THIS client draw, at one shared instant ----------
// A dev tool, never imported by the game. Load it into each of two co-op tabs
// (two origins, a LOCAL relay, both players at the same spot):
//
//   const C = (await import('/dev/coopprobe.js')).default;
//   C.arm(T, 'a');          // T = a shared second both tabs were given
//   ...the frame after traffic.now() passes T takes the picture...
//   C.shot                  // { t, cars, parked, sched, peds, ... }
//   C.post('http://localhost:8094')   // to a local sink that writes <tag>.json
//
// Two shots taken for the same T are then compared with js/coopdiff.js
// (diffCars): how many cars both tabs draw in the same place, how many only
// one draws, and why. Reads only window.__atc.

const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

const C = {
  shot: null, shots: [], R: 300,

  /** Everything this client draws within R of (x, z), right now. */
  take(x, z, R = C.R, tag = '') {
    const A = window.__atc, tr = A.traffic;
    const t = tr.now();
    const near = (c) => (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) <= R * R;
    const cars = [];
    for (const c of tr.cars) {
      if (!near(c)) continue;
      const p = c.ai;
      cars.push({ key: p?.key ?? null, gen: p?.gen ?? null, ghost: p?.ghost ? 1 : 0,
        fixed: p?.fixed ? 1 : 0, police: p?.police ? 1 : 0, kind: c.kind, color: c.color,
        x: r1(c.x), z: r1(c.z), h: r3(c.heading), v: r1(c.speed ?? 0),
        lag: p && !p.ghost && !p.stolen && tr.lagOf ? r1(tr.lagOf(p, t)) : null });
    }
    // the schedules the shared world claims here, bodied or not
    const sched = tr.snapshot(x, z, R).map((s) => ({ key: s.key, gen: s.gen, x: r1(s.x), z: r1(s.z), done: s.done ? 1 : 0 }));
    const parked = [];
    for (const c of A.parked) {
      if (!near(c)) continue;
      parked.push({ key: null, kind: c.kind, color: c.color, owned: c.owned ? 1 : 0,
        x: r1(c.x), z: r1(c.z), h: r3(c.heading), src: c._kerb ? 'kerb' : c._lot ? 'lot' : 'other' });
    }
    const peds = [];
    for (const p of A.peds?.peds ?? []) {
      const px = p.x ?? p.pos?.x, pz = p.z ?? p.pos?.z;
      if (!Number.isFinite(px) || !near({ x: px, z: pz })) continue;
      peds.push({ key: p.sch?.key ?? null, ghost: p.sch ? 0 : 1, x: r1(px), z: r1(pz) });
    }
    const pedSched = A.peds?.snapshot ? A.peds.snapshot(x, z, R).map((s) => ({ key: s.key, gen: s.gen, x: r1(s.x), z: r1(s.z), body: s.body ? 1 : 0 })) : [];
    const riders = [];
    for (const p of A.cyclists?.riders ?? []) {
      if (!Number.isFinite(p.x) || !near(p)) continue;
      riders.push({ key: p.sch?.key ?? p.key ?? null, ghost: p.ghost ? 1 : 0, x: r1(p.x), z: r1(p.z) });
    }
    const trams = (A.cityLife?.trams?.snapshot?.() ?? window.trams?.snapshot?.() ?? []).filter(near)
      .map((s) => ({ key: s.key, x: r1(s.x), z: r1(s.z), kind: s.kind }));
    // what each square of city owes the world, as this client worked it out
    const cells = [];
    for (const c of tr._cells.values()) {
      const cx = (c.ci + 0.5) * 256, cz = (c.cj + 0.5) * 256;
      if ((cx - x) * (cx - x) + (cz - z) * (cz - z) > 1500 * 1500) continue;
      cells.push([c.ci + ',' + c.cj, r1(c.len), r1(c.lenMajor), c._u === undefined ? null : r3(c._u), tr._slots(c)]);
    }
    const v = tr._view;
    const shot = {
      tag, t, T: C._T ?? null, x, z, R,
      me: { x: r1(A.player.pos.x), z: r1(A.player.pos.z) },
      view: v ? { x: r1(v.x), z: r1(v.z), dx: r3(v.dx), dz: r3(v.dz), hideR: r1(v.hideR) } : null,
      densK: tr._densK, maxCars: tr.maxCars, patrolP: tr.patrolP ?? null,
      edges: tr.edges.length, cells: tr._cells.size, pool: tr._pool.size, ghosts: tr._ghosts.size,
      tod: A.tod, peers: A.net ? A.net.remotes.size : -1,
      settings: { traffic: A.settings.traffic, peds: A.settings.peds, police: A.settings.police, quality: A.settings.quality ?? A.settings.preset ?? null },
      cars, sched, parked, peds, pedSched, riders, trams, cells,
    };
    C.shot = shot; C.shots.push(shot);
    return { t, cars: cars.length, sched: sched.length, parked: parked.length, peds: peds.length };
  },

  /** Take the picture on the first frame after shared second T (every `every` s after, `n` times). */
  arm(T, tag = '', x, z, n = 1, every = 10) {
    const A = window.__atc, tr = A.traffic;
    C._T = T; C._left = n; C.shots = [];
    if (!C._wrapped) {
      C._wrapped = true;
      const up = tr.update.bind(tr);
      tr.update = (...a) => {
        const r = up(...a);
        if (C._left > 0 && tr.now() >= C._T) {
          C.take(C._x ?? A.player.pos.x, C._z ?? A.player.pos.z, C.R, C._tag);
          C._left--; C._T += C._every;
        }
        return r;
      };
    }
    C._x = x; C._z = z; C._tag = tag; C._every = every;
    return { T, now: tr.now(), inS: r1(T - tr.now()) };
  },

  /** Send the shots to a local sink (a ten-line node receiver that writes them to disk). */
  post(url, name) {
    return fetch(url + '/' + (name ?? C._tag ?? 'shot'), { method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(C.shots) }).then(() => C.shots.length);
  },
};

export default C;
