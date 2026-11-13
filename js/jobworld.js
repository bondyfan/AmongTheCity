// ---- Job world: what a job looks like out in the street ----
// Two things, both local to this client (a job is the local player's own, like
// the wallet): the BEACON that says "stop here", and the FARE standing at the
// kerb waiting for a taxi.
//
// The beacon is one mesh pair, built once and moved, never rebuilt: a flat
// ring the size of a parking space on the road, and a thin column of light
// over it that can be picked out from three streets away when the GPS line is
// behind a building. Unlit and additive-free on purpose: it has to read at
// noon against white concrete and at night under exposure 2.5, and a plain
// translucent colour does both where an emissive would bloom into a flare.

import * as THREE from 'three';
import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE } from './config.js';
import { MARK_COLOR } from './mapmarks.js';

const RING_R = 4.2;          // m: outer radius of the ground ring
const COL_H = 34;            // m: height of the column
const LIFT = 0.3;            // m over the road: clear of the markings (0.235)

export class JobBeacon {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this._on = false;
    this._t = 0; this._yT = 0;
    this._x = 0; this._z = 0;
    this._c = MARK_COLOR.goal; this._night = -1;
  }

  _build() {
    const ringG = new THREE.RingGeometry(RING_R - 0.75, RING_R, 40);
    ringG.rotateX(-Math.PI / 2);
    this.ringM = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    const colG = new THREE.CylinderGeometry(0.55, 0.9, COL_H, 14, 1, true);
    colG.translate(0, COL_H / 2, 0);
    // front faces only: one layer of tint, and nothing at all once you are
    // standing inside the column (where it would only be a yellow fog)
    this.colM = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.26,
      depthWrite: false });
    this.ring = new THREE.Mesh(ringG, this.ringM);
    this.col = new THREE.Mesh(colG, this.colM);
    this.ring.renderOrder = 4; this.col.renderOrder = 5;
    this.group = new THREE.Group();
    this.group.add(this.ring, this.col);
    this.group.visible = false;
    this.scene.add(this.group);
  }

  get on() { return this._on; }

  /** Put the beacon at a target of `kind` ('courier' | 'taxi' | 'goal'), or
   *  take it away with null. */
  set(target, kind = 'goal') {
    if (!target) {
      if (this._on) { this._on = false; this.group.visible = false; }
      return;
    }
    if (!this.group) this._build();
    this._c = MARK_COLOR[kind] ?? MARK_COLOR.goal;
    this._night = -1;                    // force the colour to be re-derived
    if (!this._on || target.x !== this._x || target.z !== this._z) this._yT = 0;
    this._x = target.x; this._z = target.z;
    this._on = true;
    this.group.visible = true;
  }

  // `night` is sky.nightK (0 noon .. 1 midnight). The renderer opens its
  // exposure about threefold after dark, and an unlit material goes with it:
  // the same yellow that sits quietly on sunlit concrete becomes a neon tube
  // at midnight. So the colour is dimmed by hand as the night comes on.
  update(dt, world, night = 0) {
    if (!this._on) return;
    this._t += dt;
    const n = Math.round(Math.min(1, Math.max(0, night)) * 20) / 20;
    if (n !== this._night) {
      this._night = n;
      const k = 1 - 0.80 * n;   // 0.68 still left the ring and pillar white at midnight (exposure 2.5)
      this.ringM.color.set(this._c).multiplyScalar(k);
      this.colM.color.set(this._c).multiplyScalar(k);
    }
    // The ground under a far beacon streams in after the beacon was placed, so
    // its height is re-read a couple of times a second rather than once.
    this._yT -= dt;
    if (this._yT <= 0) {
      this._yT = 0.5;
      const y = world?.surfaceY?.(this._x, this._z)?.y ?? world?.heightAt?.(this._x, this._z) ?? 0;
      this.group.position.set(this._x, y + LIFT, this._z);
    }
    const p = 1 + 0.06 * Math.sin(this._t * 3.2);
    this.ring.scale.set(p, 1, p);
    this.colM.opacity = (0.26 + 0.07 * Math.sin(this._t * 3.2)) * (1 - 0.35 * this._night);
  }
}

// ---- the fare --------------------------------------------------------------
// One citizen from the same factory the crowd uses, standing at the kerb. NOT
// a pedestrian: pedestrians.js never hears about them, so they cannot be run
// over, cannot panic and cannot be left behind as an immortal body. They exist
// from "job accepted" to "got in", and again for a few seconds after being
// dropped off, and this class is the only thing that can create or remove one.
const ARCHS = ['m30', 'f30', 'm60', 'f60', 'm90'];

export class JobFare {
  constructor(scene) {
    this.scene = scene;
    this.c = null;
    this._gone = 0;          // s until a dropped-off fare is removed (0 = stays)
    this._t = 0;
  }

  /** Stand a fare at (x, z) facing `heading`. `seed` picks the body. */
  show(x, z, heading, world, seed = 0, linger = 0) {
    this.hide();
    let c;
    try { c = makeCitizen({ archetype: ARCHS[(seed >>> 0) % ARCHS.length] }); }
    catch { c = makeCitizen(); }             // an unknown archetype key must not cost the job
    c.group.scale.setScalar(PLAYER_SCALE);
    const y = world?.footing?.heightAt?.(x, z) ?? world?.heightAt?.(x, z) ?? 0;
    c.group.position.set(x, y, z);
    c.group.rotation.y = heading;
    c.standPose?.();
    this.scene.add(c.group);
    this.c = c;
    this._gone = linger;
    this._x = x; this._z = z; this._world = world; this._yT = 0;
  }

  hide() {
    if (!this.c) return;
    this.scene.remove(this.c.group);
    try { this.c.dispose?.(); } catch { /* shared assets: nothing to free */ }
    this.c = null;
  }

  get visible() { return !!this.c; }

  update(dt) {
    if (!this.c) return;
    // same late-terrain rule as the beacon
    this._yT -= dt;
    if (this._yT <= 0) {
      this._yT = 0.7;
      const w = this._world;
      const y = w?.footing?.heightAt?.(this._x, this._z) ?? w?.heightAt?.(this._x, this._z);
      if (Number.isFinite(y)) this.c.group.position.y = y;
    }
    if (this._gone > 0) {
      this._gone -= dt;
      if (this._gone <= 0) this.hide();
    }
  }
}
