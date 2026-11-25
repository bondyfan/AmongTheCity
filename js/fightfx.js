// ---- fightfx.js: a few drops of blood in the air ----------------------------
//
// Frank, 25 Nov 2026: "je tam trošku i krev". A solid punch throws a small
// spray from where it landed (a head, a ribcage) along the blow; a jab only a
// fleck or two. What reaches the ground is already js/pedestrians.js's
// business (its pooled stains: a split lip on a cross or a hook, a bigger one
// under the head of somebody knocked flat), so this file draws only the
// second the drops are in the air.
//
// Cheap on purpose: ONE Points object for the whole game, a pool of POOL
// drops written in place, gravity and nothing else. While no drop is flying
// the object is invisible and update() returns after one comparison.

import * as THREE from 'three';

const POOL = 64;
const G = 9.8;
const LIFE = 0.9;          // s a drop lives at most
const SIZE = 0.045;        // m, a drop seen up close

export class FightFx {
  constructor(scene) {
    this.scene = scene ?? null;
    this._pos = new Float32Array(POOL * 3);
    this._vel = new Float32Array(POOL * 3);
    this._life = new Float32Array(POOL);     // seconds left, 0 = free
    this._floor = new Float32Array(POOL);    // the y a drop stops at
    for (let j = 0; j < POOL; j++) this._pos[j * 3 + 1] = -1e6;   // a free drop is parked far below
    this._next = 0;
    this._live = 0;
    this.points = null;
    if (scene) {
      const g = new THREE.BufferGeometry();
      this._attr = new THREE.BufferAttribute(this._pos, 3);
      this._attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', this._attr);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);   // never culled by a stale sphere
      const m = new THREE.PointsMaterial({ color: 0x6e0a0a, size: SIZE, sizeAttenuation: true, depthWrite: false });
      this.points = new THREE.Points(g, m);
      this.points.frustumCulled = false;
      this.points.visible = false;
      this.points.renderOrder = 3;
      scene.add(this.points);
    }
  }

  /** A spray at (x, y, z) along (dx, dz); k 1 for a solid punch, 0.5 a jab. */
  blood(x, y, z, dx, dz, k = 1) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const n = Math.round(3 + 7 * Math.max(0, Math.min(1, k)));
    for (let i = 0; i < n; i++) {
      const j = this._next; this._next = (j + 1) % POOL;
      if (!(this._life[j] > 0)) this._live++;
      const o = j * 3, s = 1.2 + Math.random() * 2.2;
      this._pos[o] = x + (Math.random() - 0.5) * 0.08;
      this._pos[o + 1] = y + (Math.random() - 0.5) * 0.08;
      this._pos[o + 2] = z + (Math.random() - 0.5) * 0.08;
      this._vel[o] = (dx || 0) * s + (Math.random() - 0.5) * 1.4;
      this._vel[o + 1] = 0.4 + Math.random() * 1.8;
      this._vel[o + 2] = (dz || 0) * s + (Math.random() - 0.5) * 1.4;
      this._life[j] = LIFE * (0.6 + Math.random() * 0.4);
      this._floor[j] = y - 1.75;
    }
    if (this.points) this.points.visible = true;
  }

  update(dt) {
    if (!(this._live > 0) || !(dt > 0)) return;
    const P = this._pos, V = this._vel, L = this._life, F = this._floor;
    let live = 0;
    for (let j = 0; j < POOL; j++) {
      if (!(L[j] > 0)) continue;
      const o = j * 3;
      L[j] -= dt;
      V[o + 1] -= G * dt;
      P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
      if (L[j] <= 0 || P[o + 1] < F[j]) { L[j] = 0; P[o + 1] = -1e6; continue; }   // gone: parked far below
      live++;
    }
    this._live = live;
    if (this._attr) this._attr.needsUpdate = true;
    if (this.points && !live) this.points.visible = false;
  }

  /** How many drops are in the air (tests, the probe). */
  get live() { return this._live; }

  dispose() {
    if (!this.points) return;
    this.scene?.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points = null;
  }
}
