// ---- birdsky.js: the flocks that only pass overhead ---------------------------
// The closed-form flights of js/birdsites.js (skyFlight), given rows in the one
// bird mesh while they are near enough to be seen. Nothing here is simulated:
// a bird is where the shared clock says it is, so every player sees the same
// crows cross the same street at the same moment.

import { CHUNK } from './config.js';
import { SPECIES, SKY_CELL, SKY_T, skyFlight, skyBirdAt, hash32, rnd01 } from './birdsites.js';
import { MODE } from './birdflight.js';
import { urbanOf } from './birdperches.js';

const SEE_R = 300, LOSE_R = 340;       // a passing flock has rows inside SEE_R of the player
const MAX_SKY = 40;                    // rows the sky may hold at once
const TAU = Math.PI * 2;
const _o = { x: 0, y: 0, z: 0 };

export class BirdSky {
  constructor(owner, env) {
    this.o = owner; this.env = env;
    this.flights = new Map();          // "ci,cj,slot" -> flight (null: that slot is empty)
    this._t = 0; this._lookT = 0; this.rows = 0;
  }

  _ctx(ci, cj) {
    const x = (ci + 0.5) * SKY_CELL, z = (cj + 0.5) * SKY_CELL;
    const cell = this.env.city?.chunkIndex?.get(Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK));
    return { urban: cell ? urbanOf(cell) : 0.3, water: (cell?.water?.length ?? 0) > 0, hour: this.env.hourOf?.() ?? 12 };
  }

  _look(t, fx, fz) {
    const ci = Math.floor(fx / SKY_CELL), cj = Math.floor(fz / SKY_CELL), slot = Math.floor(t / SKY_T);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (let s = slot - 2; s <= slot; s++) {
      const key = i + ',' + j + ',' + s;
      if (this.flights.has(key)) continue;
      const f = skyFlight(i, j, s, this._ctx(i, j));
      if (f) { f.birds = null; f.sp = SPECIES[f.species]; f.gy = this.env.world?.terrain?.heightAt(f.x0 + f.dx * 300, f.z0 + f.dz * 300) ?? 0; }
      this.flights.set(key, f);
    }
    for (const [key, f] of this.flights) {
      const s = +key.slice(key.lastIndexOf(',') + 1);
      if (s < slot - 3 || (f && t > f.t0 + f.dur)) { if (f?.birds) this._drop(f); this.flights.delete(key); continue; }
      if (!f || t < f.t0) continue;
      // rows while the flock is near enough to be more than nothing
      const u = (t - f.t0) * f.speed, d = Math.hypot(f.x0 + f.dx * u - fx, f.z0 + f.dz * u - fz);
      if (!f.birds && d < SEE_R && this.rows + f.n <= MAX_SKY && this.o.live.length + f.n <= this.o.mesh.instanceMatrix.count) {
        f.birds = [];
        for (let i = 0; i < f.n; i++) {
          const b = { sky: true, mode: MODE.FLY, x: 0, y: 0, z: 0, yaw: Math.atan2(-f.dx, -f.dz), pitch: 0, bank: 0,
            phase: rnd01(hash32(f.seed, i, 9)) * TAU, spread: 1, amp: f.sp.amp * 0.8, seed: rnd01(hash32(f.seed, i, 8)) };
          f.birds.push(this.o._add(b, f.sp, f.sp.tints[hash32(f.seed, i, 7) % f.sp.tints.length]));
        }
        this.rows += f.n;
      } else if (f.birds && d > LOSE_R) this._drop(f);
    }
  }

  _drop(f) {
    for (const b of f.birds) this.o._remove(b);
    this.rows -= f.birds.length;
    f.birds = null;
  }

  update(dt, focus) {
    const t = this.env.clock?.() ?? (this._t += dt);
    if ((this._lookT -= dt) <= 0) { this._lookT = 1; this._look(t, focus.x, focus.z); }
    for (const f of this.flights.values()) {
      if (!f?.birds) continue;
      const sp = f.sp;
      for (let i = 0; i < f.birds.length; i++) {
        const b = f.birds[i];
        if (!skyBirdAt(f, i, t, _o)) { b.mode = MODE.GONE; continue; }
        b.mode = MODE.FLY;
        b.x = _o.x; b.z = _o.z; b.y = _o.y + f.gy;
        // sparrows in bursts, the long-winged ones with a glide now and then
        const w = Math.sin(t * 0.8 + b.seed * 30);
        b.spread = sp.bound && Math.sin(t * 7.5 + b.seed * 20) < -0.35 ? 0.14 : 1;
        b.amp = sp.glide > 0 && w > 1 - sp.glide ? 0.08 : sp.amp * 0.8;
        b.phase += dt * sp.hz * TAU * 0.9;
        b.bank = 0.12 * Math.sin(t * 0.7 + i * 1.9);
      }
    }
  }
}
