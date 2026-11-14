// ==========================================================================
// Copfire: police pistol rounds. Real traces that can miss, hit the car you
// are sitting in, or hit you.
//
// A SHOT IS ONE RAY, RESOLVED ON THE FRAME IT IS FIRED. A pistol round covers
// a city block in a tenth of a second, so integrating it as a projectile buys
// nothing but a chance to tunnel through a wall between two frames. What the
// player SEES is still a moving thing: a 6 m tracer streak that travels the
// resolved path at TRACER_V (well under the real 360 m/s, so the eye can
// follow it), and stops where the round stopped.
//
// HOW IT IS RESOLVED, and why it is cheap. js/combat.js's header killed a
// player hitscan on cost: a 110 m trace walked in 1.2 m bites against the
// chunk index is 92 queries a shot. This one is analytic against the only
// target that matters (the player: a vertical cylinder on foot, the car's
// oriented box in a car) and samples the building index every WALL_STEP m only
// up to that distance, capped at WALL_MAX samples. A police shot is at most a
// few a second for the whole force, never spammed by the player.
//
// The scatter is js/policetune.js's Gaussian angle on yaw and on pitch, the
// same distribution its hitChance() integrates, so the hit rate a test
// measures is the hit rate the game plays.
//
// DAMAGE. A round that hits you on foot costs HIT_FOOT; one that hits the car
// dents the car's damage figure a little and reaches you CABIN_P of the time.
// Everything goes through vitals.damage(), so armour, regeneration, the death
// card and the hospital all work exactly as for any other injury.
//
// Local only, like the whole pursuit (police.js, DETERMINISM): your heat, your
// police, your bullets. Math.random is allowed here; a test injects `rnd`.
// ==========================================================================

import * as THREE from 'three';
import {
  aimSigma, gauss, FOOT_R, FOOT_H, FOOT_CY, CAR_CY, CAR_H,
  HIT_FOOT, HIT_CABIN, CABIN_P,
} from './policetune.js';
import * as VITALS from './vitals.js';
import { gunshotAt, bulletHitAt } from './audio.js';

const WALL_STEP = 3.5;          // m between building samples along a shot
const WALL_MAX = 24;            // never more samples than this per shot
const WALL_SKIP = 1.2;          // m of muzzle the wall test ignores (cover)
const OVERSHOOT = 45;           // m a miss flies on past its target
const TRACER_V = 210;           // m/s the drawn streak travels
const TRACER_L = 6;             // m of streak
const TRACERS = 24;
const FLASHES = 6;
const FLASH_T = 0.05;           // s a muzzle flash is up
const CAUSE = 'postřelení';

const _hit = { t: 0, kind: '' };

// Ray (o + d·t) against a vertical cylinder; writes the entry t or returns
// false. y-range checked at the entry point.
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, r, y0, y1, tMax) {
  const fx = ox - cx, fz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return -1;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (!(t > 0) || t > tMax) return -1;
  const y = oy + dy * t;
  return y >= y0 && y <= y1 ? t : -1;
}

// Ray against a car's oriented box (heading h, forward (−sin h, −cos h)).
function rayCarBox(ox, oy, oz, dx, dy, dz, car, y0, tMax) {
  const h = car.heading ?? 0;
  const fx = -Math.sin(h), fz = -Math.cos(h);     // forward
  const rx = -fz, rz = fx;                        // right (cos h, −sin h)
  const px = ox - car.x, pz = oz - car.z;
  // local coords: a along forward, b along right, y up
  const oa = px * fx + pz * fz, ob = px * rx + pz * rz, oyl = oy - y0;
  const da = dx * fx + dz * fz, db = dx * rx + dz * rz;
  const hl = (car.len ?? 4.4) / 2, hw = (car.wid ?? 1.8) / 2;
  let t0 = 0, t1 = tMax;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let ta = (lo - o) / d, tb = (hi - o) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    return t0 <= t1;
  };
  if (!slab(oa, da, -hl, hl)) return -1;
  if (!slab(ob, db, -hw, hw)) return -1;
  if (!slab(oyl, dy, 0.25, CAR_H)) return -1;
  return t0 > 0 ? t0 : -1;
}

export class Gunfire {
  /**
   * { scene, city, vitals, rnd }. All optional. `scene` null (a test) means no
   * tracers and no flashes, every other line runs. `city` blocks rounds with
   * buildingAt(x, z); `vitals` defaults to the game's module.
   */
  constructor(opts = {}) {
    this.scene = opts.scene ?? null;
    this.city = opts.city ?? null;
    this.vitals = opts.vitals ?? VITALS;
    this.rnd = typeof opts.rnd === 'function' ? opts.rnd : Math.random;
    /** Counters for tests and the dev overlay. */
    this.stats = { shots: 0, hitFoot: 0, hitCar: 0, hitCabin: 0, wall: 0, miss: 0, dmg: 0 };
    this._wallOff = false;
    this._tr = [];
    this._fl = [];
    this._built = false;
  }

  /**
   * Fire one round from (sx, sy, sz) at `tgt`:
   *   { foot: true, x, y, z, speed }           a man on foot (y = his feet)
   *   { foot: false, car, speed }              a car (y from car.y)
   * `moving` is whether the shooter is walking; `acc` the tier's accuracy;
   * `dmgK` the tier's damage factor. Returns 'foot' | 'cabin' | 'car' |
   * 'wall' | 'miss'.
   */
  shoot(sx, sy, sz, tgt, moving, acc = 1, dmgK = 1) {
    if (!tgt) return 'miss';
    const foot = !!tgt.foot;
    const car = foot ? null : tgt.car;
    if (!foot && !car) return 'miss';
    const cx = foot ? tgt.x : car.x, cz = foot ? tgt.z : car.z;
    const by = foot ? tgt.y : (car.y ?? 0);
    const cy = by + (foot ? FOOT_CY : CAR_CY);
    let dx = cx - sx, dy = cy - sy, dz = cz - sz;
    const d = Math.hypot(dx, dy, dz);
    if (!(d > 0.3)) return 'miss';
    // the aim, thrown off by the Gaussian angle on both axes
    const sig = aimSigma(moving, tgt.speed ?? 0, acc);
    const yaw = Math.atan2(dx, dz) + gauss(this.rnd) * sig;
    const pitch = Math.asin(dy / d) + gauss(this.rnd) * sig;
    const cp = Math.cos(pitch);
    dx = Math.sin(yaw) * cp; dz = Math.cos(yaw) * cp; dy = Math.sin(pitch);
    const tMax = d + OVERSHOOT;

    let t = foot
      ? rayCylinder(sx, sy, sz, dx, dy, dz, cx, cz, FOOT_R, by, by + FOOT_H, tMax)
      : rayCarBox(sx, sy, sz, dx, dy, dz, car, by, tMax);
    let kind = t > 0 ? (foot ? 'foot' : 'car') : 'miss';
    let end = t > 0 ? t : tMax;
    // a wall in between stops it, whether it would have hit or not
    const w = this._wall(sx, sz, dx, dz, end);
    if (w > 0) { kind = 'wall'; end = w; }
    // the ground stops a low miss too: a flat plane at the target's feet
    if (kind === 'miss' && dy < 0) {
      const tg = (by - sy) / dy;
      if (tg > 0 && tg < end) end = tg;
    }

    const st = this.stats;
    st.shots++;
    const ex = sx + dx * end, ey = sy + dy * end, ez = sz + dz * end;
    gunshotAt(sx, sz, 1);
    if (kind === 'foot') {
      st.hitFoot++;
      this._hurt(HIT_FOOT, dmgK);
      bulletHitAt(ex, ez, false, 0.8);
    } else if (kind === 'car') {
      st.hitCar++;
      car.damage = Math.min(1.2, (car.damage ?? 0) + 0.012);
      bulletHitAt(ex, ez, true, 1);
      if (this.rnd() < CABIN_P) { kind = 'cabin'; st.hitCabin++; this._hurt(HIT_CABIN, dmgK); }
    } else if (kind === 'wall') {
      st.wall++;
      bulletHitAt(ex, ez, false, 0.7);
    } else st.miss++;
    this._tracer(sx, sy, sz, ex, ey, ez, end);
    this._flash(sx, sy, sz);
    return kind;
  }

  _hurt(range, k) {
    const v = this.vitals;
    if (!v || typeof v.damage !== 'function') return;
    if (typeof v.down === 'function' && v.down()) return;
    const n = (range[0] + (range[1] - range[0]) * this.rnd()) * (k > 0 ? k : 1);
    this.stats.dmg += n;
    v.damage(n, CAUSE);
  }

  // First building sample along the shot, or −1. Footprint only (buildingAt
  // has no height), which is the honest answer for a pistol fired at chest
  // height down a street: the round does not clear a roof.
  _wall(sx, sz, dx, dz, tEnd) {
    const city = this.city;
    if (this._wallOff || !city || typeof city.buildingAt !== 'function') return -1;
    const h = Math.hypot(dx, dz);
    if (h < 1e-6) return -1;
    const span = tEnd * h;
    let n = Math.ceil((span - WALL_SKIP) / WALL_STEP);
    if (n > WALL_MAX) n = WALL_MAX;
    try {
      for (let i = 0; i < n; i++) {
        const s = WALL_SKIP + (span - WALL_SKIP) * (i + 0.5) / n;
        const t = s / h;
        if (city.buildingAt(sx + dx * t, sz + dz * t)) return t;
      }
    } catch (err) {
      this._wallOff = true;
      console.warn('[copfire] wall test disabled:', err);
    }
    return -1;
  }

  // ---------------------------------------------------------------- look --

  _build() {
    if (this._built || !this.scene || typeof this.scene.add !== 'function') return false;
    this._built = true;
    // Tracers: ONE LineSegments for all of them, so a firefight is one draw
    // call. Additive, so fading a streak is just darkening its colour.
    const pos = new Float32Array(TRACERS * 6);
    const col = new Float32Array(TRACERS * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this._lines = new THREE.LineSegments(g, m);
    this._lines.frustumCulled = false;
    this._lines.renderOrder = 3;
    this.scene.add(this._lines);
    for (let i = 0; i < TRACERS; i++) {
      this._tr.push({ life: 0, t: 0, L: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 });
    }
    // Muzzle flashes: a radial DataTexture (no canvas, no asset) on sprites.
    const N = 32, px = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N * 2 - 1, v = (j + 0.5) / N * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      const star = Math.max(0, 1 - Math.min(Math.abs(u), Math.abs(v)) * 6) * Math.max(0, 1 - r);
      const a = Math.min(1, Math.max(0, 1 - r) ** 2.2 * 1.4 + star * 0.8);
      const k = (j * N + i) * 4;
      px[k] = 255; px[k + 1] = 214; px[k + 2] = 140; px[k + 3] = (a * 255) | 0;
    }
    const tex = new THREE.DataTexture(px, N, N);
    tex.needsUpdate = true;
    for (let i = 0; i < FLASHES; i++) {
      const sm = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 });
      const s = new THREE.Sprite(sm);
      s.visible = false;
      s.scale.setScalar(0.55);
      this.scene.add(s);
      this._fl.push({ s, sm, t: 0 });
    }
    return true;
  }

  _tracer(sx, sy, sz, ex, ey, ez, L) {
    if (!this._build() && !this._built) return;
    let r = null;
    for (let i = 0; i < this._tr.length && !r; i++) if (this._tr[i].life <= 0) r = this._tr[i];
    if (!r) r = this._tr[0];
    const inv = L > 1e-6 ? 1 / L : 0;
    r.x = sx; r.y = sy; r.z = sz;
    r.dx = (ex - sx) * inv; r.dy = (ey - sy) * inv; r.dz = (ez - sz) * inv;
    r.L = L; r.t = 0; r.life = L / TRACER_V + 0.06;
  }

  _flash(x, y, z) {
    if (!this._built) return;
    let f = null;
    for (let i = 0; i < this._fl.length && !f; i++) if (this._fl[i].t <= 0) f = this._fl[i];
    if (!f) f = this._fl[0];
    f.t = FLASH_T;
    f.s.position.set(x, y, z);
    f.s.material.rotation = this.rnd() * Math.PI;
    f.sm.opacity = 1;
    f.s.visible = true;
  }

  /** Advance the drawn streaks and flashes. Cheap and allocation free. */
  update(dt) {
    if (!this._built || !(dt > 0)) return;
    const pos = this._lines.geometry.attributes.position;
    const col = this._lines.geometry.attributes.color;
    const P = pos.array, C = col.array;
    for (let i = 0; i < this._tr.length; i++) {
      const r = this._tr[i], k = i * 6;
      if (r.life <= 0) {
        if (C[k] !== 0 || C[k + 3] !== 0) for (let j = 0; j < 6; j++) C[k + j] = 0;
        continue;
      }
      r.t += dt; r.life -= dt;
      let head = r.t * TRACER_V;
      if (head > r.L) head = r.L;
      let tail = head - TRACER_L;
      if (tail < 0) tail = 0;
      P[k] = r.x + r.dx * tail; P[k + 1] = r.y + r.dy * tail; P[k + 2] = r.z + r.dz * tail;
      P[k + 3] = r.x + r.dx * head; P[k + 4] = r.y + r.dy * head; P[k + 5] = r.z + r.dz * head;
      const fade = r.life > 0 ? Math.min(1, r.life * 12) : 0;
      // tail dim, head bright: the streak reads as moving even when paused
      C[k] = 0.35 * fade; C[k + 1] = 0.22 * fade; C[k + 2] = 0.08 * fade;
      C[k + 3] = 1.6 * fade; C[k + 4] = 1.25 * fade; C[k + 5] = 0.6 * fade;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    for (let i = 0; i < this._fl.length; i++) {
      const f = this._fl[i];
      if (f.t <= 0) continue;
      f.t -= dt;
      if (f.t <= 0) { f.s.visible = false; f.sm.opacity = 0; } else f.sm.opacity = f.t / FLASH_T;
    }
  }

  dispose() {
    if (this._lines) {
      this._lines.parent?.remove(this._lines);
      this._lines.geometry.dispose();
      this._lines.material.dispose();
    }
    for (const f of this._fl) { f.s.parent?.remove(f.s); f.sm.dispose(); }
    this._fl.length = 0; this._tr.length = 0; this._built = false;
  }
}

export default Gunfire;
