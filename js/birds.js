// ---- birds.js: the birds of a town, around whoever is looking ------------------
// Pigeons on the pavement and the eaves, sparrows on the wires and the signs,
// crows on the lamps at the edge of town and in the fields, gulls by the river.
// They sit where birds sit, and go up when the player, a car, a passer-by or a
// bang comes too near: a hop of a few metres for somebody strolling past, the
// whole flock up and away round the corner for a car.
//
// HOW IT STAYS NEARLY FREE
//   one draw call   every bird is a row of one InstancedMesh (js/birdmodel.js)
//   no CPU at rest  a seated bird's row is written once; its peck is a uniform
//   near only       flocks get rows inside ON_R of the player and give them
//                   back past OFF_R; the map is searched one chunk at a time,
//                   once (js/birdscan.js)
//   a pool          BIRD_MAX rows for everything, the passing flocks included
//
// SHARED / LOCAL, for co-op (js/birdsites.js states the contract): which flock
// lives where is a pure function of the map and the hour, so two players see
// the same pigeons on the same lamp. Everything a flock DOES after that (who
// scared it, where it went) is this client's own, and it is back on its shared
// seat when it next comes into range.
//
// The campaign and anything else can use the same system: `scare(x, z, r)` for
// a bang, `flockNear(x, z, r)` to find one, `flush(flock, x, z)` to send it up.

import * as THREE from 'three';
import { makeBirdMesh, birdClock, BIRD_MAX, REST_TILT } from './birdmodel.js';
import { KIND, seatsFor, hash32, rnd01, rowGap } from './birdsites.js';
import { MODE, makeBird, launch, stepBird, routeTo, routeAway, routeHop } from './birdflight.js';
import { roofTopAt } from './birdperches.js';
import { scanStep } from './birdscan.js';
import { BirdSky } from './birdsky.js';
import { storyFlutter } from './audio.js';

const ON_R = 105, OFF_R = 140;          // a flock gets its rows inside ON_R and keeps them to OFF_R
const SKY_ROWS = 44;                    // rows kept back for the flocks passing overhead
const SEEN_R = 40;                      // a flock may appear closer than this only outside the view

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

export class Birds {
  /**
   * @param scene
   * @param env { city, world (terrain, poles, walkY, roofY, built, interiors), sites, signs(key),
   *              hourOf() -> 0..24, clock() -> shared seconds }
   */
  constructor(scene, env) {
    this.scene = scene; this.env = env;
    const { mesh, flap } = makeBirdMesh(BIRD_MAX);
    this.mesh = mesh; this.flap = flap;
    scene.add(mesh);
    this.live = [];                 // every bird with a row, in row order
    this.flocks = new Map();        // id -> flock
    this.chunks = new Map();        // key -> { t, ids: [], spares: [] }
    this.sky = new BirdSky(this, env);
    this.enabled = true;
    this.density = 1;               // 0..2, a local taste like the crowd slider
    this._t = 0; this._scanT = 0; this._actT = 0; this._threatT = 0; this._soundT = 0;
    this._cars = [];
    this.groundY = (x, z) => env.world?.walkY?.(x, z) ?? env.world?.terrain?.heightAt(x, z) ?? 0;
    // the top of whatever is built at (x, z), 0 for open sky
    this.topAt = (x, z) => roofTopAt(env.city, env.world?.terrain, x, z);
  }

  // ---- rows ----------------------------------------------------------------
  _add(b, sp, tint) {
    b.row = this.live.length; b.sp = sp; b.dirty = true;
    this.live.push(b);
    this.mesh.setColorAt(b.row, _c.setHex(tint));
    this.mesh.instanceColor.needsUpdate = true;
    return b;
  }
  _remove(b) {
    const last = this.live.pop();
    if (last !== b) {
      last.row = b.row; last.dirty = true;
      this.live[b.row] = last;
      this.mesh.getColorAt(this.live.length, _c);
      this.mesh.setColorAt(last.row, _c);
      this.mesh.instanceColor.needsUpdate = true;
    }
    b.row = -1;
  }
  _write(b) {
    const sp = b.sp, s = b.mode === MODE.GONE ? 0 : sp.size;       // (a bird that has left keeps its row until the flock is released)
    _e.set(b.pitch - REST_TILT * 0.9 * b.spread, b.yaw, b.bank);
    _m.compose(_p.set(b.x, b.y, b.z), _q.setFromEuler(_e), _s.set(s * (1 + (sp.wing - 1) * b.spread), s, s * (0.9 + 0.1 * sp.wing)));
    this.mesh.setMatrixAt(b.row, _m);
    const a = this.flap.array, o = b.row * 4;
    a[o] = b.phase; a[o + 1] = b.spread; a[o + 2] = b.mode === MODE.SEAT ? (b.pecks ? 1 : 0) : b.amp; a[o + 3] = b.seed;
  }

  // ---- the map, a chunk at a time (js/birdscan.js) ---------------------------------
  _scan(fx, fz) { scanStep(this, fx, fz); }

  _forget(f) {
    if (!f) return;
    this._release(f);
    this.flocks.delete(f.id);
  }
  _release(f) {
    if (f.birds) for (const b of f.birds) if (b.row >= 0) this._remove(b);
    f.birds = null; f.state = 'idle'; f.up = null;
    if (f.cand !== f.home) { f.cand.used = false; f.cand = f.home; f.x = f.home.x; f.z = f.home.z; }
  }

  // ---- rows for the flocks in range --------------------------------------------
  _activate(view, fx, fz) {
    const room = BIRD_MAX - SKY_ROWS;
    for (const f of this.flocks.values()) {
      const dx = f.x - fx, dz = f.z - fz, d2 = dx * dx + dz * dz;
      if (f.birds) {
        if (d2 > OFF_R * OFF_R) { this._release(f); if (f.dead) this.flocks.delete(f.id); }
        continue;
      }
      if (f.dead || d2 > ON_R * ON_R || this.live.length + f.n > room) continue;
      if (f.away > 0) continue;                              // flew off: back later (see update)
      // never out of thin air in front of somebody: far enough to be a speck, or outside the view
      if (d2 < SEEN_R * SEEN_R && view && this._started) {
        const vx = f.x - view.x, vz = f.z - view.z, vd = Math.hypot(vx, vz) || 1;
        if ((vx * view.dirX + vz * view.dirZ) / vd > 0.3) continue;
      }
      this._seat(f);
    }
    this._started = true;
  }

  _seat(f) {
    const seats = seatsFor(f.cand, f.species, f.n, f.seed, this.groundY), tints = f.sp.tints;
    f.birds = seats.map((st, i) => {
      const b = makeBird(st, rnd01(hash32(f.seed, i, 5)));
      b.pecks = f.cand.kind === KIND.GROUND;
      return this._add(b, f.sp, tints[hash32(f.seed, i, 6) % tints.length]);
    });
    f.state = 'sit';
  }

  // ---- going up -----------------------------------------------------------------
  /** Everything within r of a bang takes off (js/main.js chains this onto peds.panic). */
  scare(x, z, r = 30) {
    const R = Math.max(55, r * 2.4);
    for (const f of this.flocks.values()) {
      if (f.state !== 'sit') continue;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < R) this._flushFlock(f, x, z, true, false, d * 0.006);
    }
  }
  /** The nearest seated flock within r of (x, z), or null. */
  flockNear(x, z, r = 20) {
    let best = null, bd = r * r;
    for (const f of this.flocks.values()) {
      if (f.state !== 'sit') continue;
      const d = (f.x - x) ** 2 + (f.z - z) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  /** Send a flock up as if something came at it from (x, z). */
  flush(f, x, z, hard = true) { if (f?.state === 'sit') this._flushFlock(f, x, z, hard, false); }

  // a direction is no good if a wall stands a few metres along it
  _clearWay(x, y, z, ax, az) {
    return !(this.topAt(x + ax * 4, z + az * 4) > y + 2) && !(this.topAt(x + ax * 9, z + az * 9) > y + 4.5);
  }

  _flushFlock(f, tx, tz, hard, leave = false, wait = 0) {
    const b0 = f.birds[0];
    let ax = f.x - tx, az = f.z - tz;
    const L = Math.hypot(ax, az);
    if (L < 0.01) { const a = rnd01(hash32(f.seed, this._t | 0)) * 6.283; ax = Math.cos(a); az = Math.sin(a); } else { ax /= L; az /= L; }
    // away from what came, unless that is into a wall
    for (const turn of [0, 0.9, -0.9, 1.8, -1.8]) {
      const c = Math.cos(turn), s = Math.sin(turn), bx = ax * c - az * s, bz = ax * s + az * c;
      if (this._clearWay(f.x, b0.y, f.z, bx, bz)) { ax = bx; az = bz; break; }
    }
    const h = hash32(f.seed, (this._t * 10) | 0);
    let dest = null, pts = null;
    if (!hard && f.cand.kind === KIND.GROUND) {
      // a hop: the same patch, a few metres further from whoever is walking through
      const d = 4 + 3 * rnd01(h), nx = f.x + ax * d, nz = f.z + az * d;
      if (!(this.topAt(nx, nz) > b0.y + 1.5)) {
        dest = { ...f.cand, x: nx, z: nz, hop: true };
        pts = routeHop(f.x, b0.y, f.z, nx, this.groundY(nx, nz), nz);
      }
    }
    if (!dest && !leave) dest = this._destFor(f, tx, tz, h);
    if (dest && !pts) {
      const dy = dest.y ?? this.groundY(dest.x, dest.z);
      let top = 0;
      for (const t of [0.25, 0.5, 0.75]) {
        top = Math.max(top, this.topAt(f.x + (dest.x - f.x) * t, f.z + (dest.z - f.z) * t));
      }
      pts = routeTo(f.x, b0.y, f.z, dest.x, dy, dest.z, ax, az, top, 0.25 + 0.6 * rnd01(hash32(h, 2)));
    }
    if (!dest) {
      const turn = (rnd01(hash32(h, 3)) - 0.5) * 2.2, c = Math.cos(turn), sn = Math.sin(turn), bx = ax * c - az * sn, bz = ax * sn + az * c;
      let top = 0;
      for (const d of [14, 26, 38]) top = Math.max(top, this.topAt(f.x + ax * d, f.z + az * d), this.topAt(f.x + ax * 34 + bx * d, f.z + az * 34 + bz * d));
      pts = routeAway(f.x, b0.y, f.z, ax, az, turn, 190, top);
    }
    const seats = dest ? seatsFor(dest, f.species, f.n, hash32(f.seed, h), this.groundY) : null;
    f.birds.forEach((b, i) => {
      // the nearest to the threat goes first, and the rest follow it up
      const near = Math.hypot(b.x - tx, b.z - tz);
      launch(b, ax, az, { pts, seat: seats ? seats[i] : null },
        wait + Math.min(0.5, Math.max(0, near - L + 1.5) * 0.09) + 0.12 * rnd01(hash32(h, i, 4)),
        [rnd01(hash32(h, i, 5)), rnd01(hash32(h, i, 6)), rnd01(hash32(h, i, 7))]);
      b.pecks = !!dest && dest.kind === KIND.GROUND;
    });
    if (f.cand !== f.home) f.cand.used = false;
    if (dest) { dest.used = true; f.cand = dest; f.x = dest.x; f.z = dest.z; }
    f.up = null;
    f.state = dest ? 'air' : 'leaving';
    f.calm = dest?.hop ? 1.5 : 4;
    this._flutter(f, hard);
  }

  // somewhere else to sit: a free perch of a kind this bird likes, not too near what scared it
  _destFor(f, tx, tz, h) {
    if (rnd01(hash32(h, 9)) < 0.18) return null;                  // now and then they simply go
    const ground = f.species === 'sparrow' || f.species === 'pigeon';
    const need = (f.n - 1) * rowGap(f.sp);
    let best = null, bs = Infinity, n = 0;
    for (const ch of this.chunks.values()) for (const c of ch.spares) {
      if (c.used || c === f.cand) continue;
      if (c.kind === KIND.GROUND ? (!ground && !c.field) || c.road : (c.len ?? 0) + 0.2 < need) continue;
      const d = Math.hypot(c.x - f.x, c.z - f.z);
      if (d < 16 || d > 120 || Math.hypot(c.x - tx, c.z - tz) < 22) continue;
      // a preference with some chance in it, so a street's flocks do not all pick one roof
      const s = d * (0.6 + 0.8 * rnd01(hash32(h, n++))) * (c.kind === KIND.GROUND ? 1.5 : 1);
      if (s < bs) { bs = s; best = c; }
    }
    return best;
  }

  _flutter(f, hard) {
    if (this._t - this._soundT < 0.4 || !this._ears) return;
    const d = Math.hypot(f.x - this._ears.x, f.z - this._ears.z);
    if (d > 32) return;
    this._soundT = this._t;
    storyFlutter((hard ? 0.13 : 0.06) * (1 - d / 32) * Math.min(1, 0.3 + f.n / 8) * f.sp.size, Math.min(12, 3 + f.n));
  }

  // ---- who is too near -------------------------------------------------------------
  _threats(th) {
    const cars = this._cars;
    cars.length = 0;
    const px = th.x, pz = th.z;
    if (th.car && Math.abs(th.car.speed ?? 0) >= 0.6) cars.push(th.car);       // the one the player is driving
    for (const c of th.cars ?? []) {
      const sp = Math.abs(c.speed ?? 0);
      if (sp < 0.6) continue;
      const dx = c.x - px, dz = c.z - pz;
      if (dx * dx + dz * dz < 150 * 150) cars.push(c);
    }
    for (const f of this.flocks.values()) {
      if (f.state !== 'sit' || !f.birds) continue;
      if (f.calm > 0) continue;
      const nerve = f.sp.nerve;
      // how far over the street it sits (asked once per seat: the ground is a dear question)
      const up = f.up ?? (f.up = f.cand.kind === KIND.GROUND ? 0 : f.birds[0].y - this.groundY(f.x, f.z));
      // the player: on foot a hop when strolling, the lot when running; never reaches a lamp
      const pd = Math.hypot(f.x - px, f.z - pz), ps = th.speed ?? 0;
      if (up < 3.2 && !th.inCar) {
        const r = (ps > 3.4 ? 6.2 : 3.1) * nerve * (up > 1 ? 0.55 : 1);
        if (pd < r && (up < 1 || ps > 3.4)) { this._flushFlock(f, px, pz, ps > 2.3 || up > 1 || nerve > 1.2); continue; }
      }
      if (up < 3.2) {
        let hit = null;
        for (const c of cars) {
          const sp = Math.abs(c.speed), r = Math.min(15, 4.5 + 0.5 * sp) * nerve * (up > 1 ? 0.4 : 1);
          if (Math.hypot(f.x - c.x, f.z - c.z) < r && (up < 1 || sp > 8)) { hit = c; break; }
        }
        if (hit) { this._flushFlock(f, hit.x, hit.z, true); continue; }
      }
      // somebody walking through them: they step aside
      if (up < 0.6 && pd < 90) {
        for (const p of th.peds ?? []) {
          if (p.state !== 'walk' || !(p.speed > 0.3)) continue;
          if (Math.abs(p.x - f.x) < 1.6 * nerve && Math.abs(p.z - f.z) < 1.6 * nerve) { this._flushFlock(f, p.x, p.z, false); break; }
        }
      }
    }
  }

  // ---- the frame -------------------------------------------------------------------
  /**
   * @param focus   { x, z } the player
   * @param view    js/main.js viewerState() or null
   * @param threats { x, z, speed, inCar, car: the player's own or null, cars: iterable of { x, z, speed },
   *                  peds: [{ x, z, state, speed }] }
   */
  update(dt, focus, view = null, threats = null) {
    this.mesh.visible = this.enabled;
    if (!this.enabled) return;
    this._t += dt;
    birdClock.value = this._t;
    this._ears = focus;
    if ((this._scanT -= dt) <= 0) { this._scanT = 0.3; this._scan(focus.x, focus.z); }
    if ((this._actT -= dt) <= 0) { this._actT = 0.25; this._activate(view, focus.x, focus.z); this._roam(dt, focus); }
    if (threats && (this._threatT -= dt) <= 0) { this._threatT = 0.1; this._threats(threats); }
    this.sky.update(dt, focus);

    let dirty = false;
    for (let i = 0; i < this.live.length; i++) {
      const b = this.live[i];
      if (b.sky) { this._write(b); dirty = true; continue; }
      const was = b.mode;
      if (stepBird(b, dt, b.sp) || b.dirty || was !== b.mode) { this._write(b); b.dirty = false; dirty = true; }
    }
    this.mesh.count = this.live.length;
    if (dirty) { this.mesh.instanceMatrix.needsUpdate = true; this.flap.needsUpdate = true; }
  }

  // flocks settling, leaving, coming back, and moving about of their own accord
  _roam(dt, focus) {
    const hour = this.env.hourOf?.() ?? 12, asleep = hour > 21 || hour < 5;
    for (const f of this.flocks.values()) {
      if (f.away > 0) { f.away -= 0.25; continue; }
      if (!f.birds) continue;
      if (f.calm > 0) f.calm -= 0.25;
      if (f.state === 'air') {
        if (f.birds.every((b) => b.mode === MODE.SEAT)) f.state = 'sit';
      } else if (f.state === 'leaving') {
        if (f.birds.every((b) => b.mode === MODE.GONE)) {
          this._release(f);
          if (f.dead) this.flocks.delete(f.id); else f.away = 45 + 60 * rnd01(hash32(f.seed, this._t | 0));
        }
      } else if (f.state === 'sit' && !asleep && (f.roam -= 0.25) <= 0) {
        // nobody scared them: they just go and sit somewhere else for a while
        f.roam = 70 + 220 * rnd01(hash32(f.seed, this._t | 0, 3));
        const a = rnd01(hash32(f.seed, this._t | 0, 4)) * 6.283;
        if (Math.hypot(f.x - focus.x, f.z - focus.z) < 95) this._flushFlock(f, f.x + Math.cos(a) * 3, f.z + Math.sin(a) * 3, true);
      }
    }
  }

  get count() { return this.live.length; }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.live.length = 0; this.flocks.clear(); this.chunks.clear();
  }
}
