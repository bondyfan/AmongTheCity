// ---- dogs.js: the dogs people walk, and the leads they walk them on ------------
// Whoever js/pedprops.js gave a dog has one at their side: it trots at heel,
// pulls ahead until the lead is tight, stops to sniff and has to be waited for,
// and sits down when its owner stops at a kerb (js/dogwalk.js). The owner's
// arm is held for it (js/gait.js 'leash') and the lead runs from that wrist to
// the collar, sagging when slack and straight when the dog pulls.
//
// TWO DRAW CALLS FOR ALL OF THEM: the dogs are rows of one InstancedMesh whose
// legs, head and tail move in the vertex shader (js/dogmodel.js), and every
// lead is a strip in one small dynamic mesh. Past FAR metres neither is drawn
// nor stepped: at that distance a spaniel is two pixels.
//
// A dog belongs to its owner's body: it arrives and leaves with it, behind the
// crowd's own rule that nobody appears or disappears where the player can see.

import * as THREE from 'three';
import { PROP, DOG_BREEDS } from './pedprops.js';
import { PLAYER_SCALE } from './config.js';
import { makeDogMesh, dogClock, DOG_MAX, COLLAR } from './dogmodel.js';
import { makeDog, stepDog } from './dogwalk.js';

const FAR = 135;             // m from the player past which a dog is not drawn
const SEG = 6;               // pieces a lead is drawn in
const LEAD_W = 0.011;        // half its width, m
const LEAD_TINTS = [0x2b211a, 0x2b211a, 0x8a1f1c, 0x15171a, 0x23466e];

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _h = new THREE.Vector3();
const _o = { x: 0, z: 0, h: 0, speed: 0, side: 1, hx: 0, hz: 0, mode: 'walk' };

export class Dogs {
  /** @param env { groundY(x, z) } what a dog stands on (the pavement its owner walks) */
  constructor(scene, env = {}) {
    this.scene = scene; this.env = env;
    const { mesh, anim } = makeDogMesh(DOG_MAX);
    this.mesh = mesh; this.anim = anim;
    scene.add(mesh);
    // the leads: each a flat strip seen from the side and another seen from
    // above, so it has some width from wherever it is looked at
    const nv = DOG_MAX * (SEG + 1) * 4, idx = [];
    for (let d = 0; d < DOG_MAX; d++) for (let r = 0; r < 2; r++) for (let i = 0; i < SEG; i++) {
      const a = d * (SEG + 1) * 4 + r * (SEG + 1) * 2 + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    this.lpos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.lcol = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const nor = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) nor[i * 3 + 1] = 1;
    g.setAttribute('position', this.lpos);
    g.setAttribute('color', this.lcol);
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    this.leads = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.leads.frustumCulled = false;
    this.leads.name = 'vodítka';
    g.setDrawRange(0, 0);
    scene.add(this.leads);
    this.enabled = true;
    this.count = 0;
  }

  // a dog's ground, asked again only once it has moved a paw's length
  _ground(d) {
    const dx = d.x - d.gx, dz = d.z - d.gz;
    if (!(dx * dx + dz * dz < 0.04)) { d.gx = d.x; d.gz = d.z; d.gy = this.env.groundY ? this.env.groundY(d.x, d.z) : 0; }
    return d.gy;
  }

  _lead(n, ax, ay, az, bx, by, bz, slack, tint) {
    const P = this.lpos.array, C = this.lcol.array, base = n * (SEG + 1) * 4;
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1, px = -dz / L * LEAD_W, pz = dx / L * LEAD_W;
    _c.setHex(tint);
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG, x = ax + dx * t, z = az + dz * t;
      const y = ay + (by - ay) * t - slack * 4 * t * (1 - t);
      let o = (base + i * 2) * 3;                          // the strip seen from the side
      P[o] = x; P[o + 1] = y - LEAD_W; P[o + 2] = z; P[o + 3] = x; P[o + 4] = y + LEAD_W; P[o + 5] = z;
      o = (base + (SEG + 1) * 2 + i * 2) * 3;              // …and from above
      P[o] = x - px; P[o + 1] = y; P[o + 2] = z - pz; P[o + 3] = x + px; P[o + 4] = y; P[o + 5] = z + pz;
    }
    for (let i = base * 3, e = (base + (SEG + 1) * 4) * 3; i < e; i += 3) { C[i] = _c.r; C[i + 1] = _c.g; C[i + 2] = _c.b; }
  }

  /** Once a frame, after the crowd has moved. `peds` is js/pedestrians.js peds; focus the player. */
  update(dt, peds, focus) {
    this.mesh.visible = this.leads.visible = this.enabled;
    if (!this.enabled) return;
    dogClock.value += dt;
    let n = 0, leads = 0;
    const A = this.anim.array, k = PLAYER_SCALE;
    for (const p of peds) {
      if (p.prop !== PROP.DOG || n >= DOG_MAX) continue;
      const fx = p.x - focus.x, fz = p.z - focus.z;
      if (fx * fx + fz * fz > FAR * FAR) { p.dog = null; continue; }
      // ---- the owner, as the dog sees them ----
      const down = p.state !== 'walk' && p.state !== 'board';
      _o.x = p.x; _o.z = p.z; _o.h = p.heading; _o.speed = down ? 0 : p.speed;
      _o.mode = down ? 'down' : 'walk';
      _o.side = p.leadSide ?? 1;
      let hy = 0;
      if (p.hand) { p.hand.getWorldPosition(_h); _o.hx = _h.x; _o.hz = _h.z; hy = _h.y - 0.07 * k; }
      else { _o.hx = p.x; _o.hz = p.z; hy = p.mesh.position.y + 0.8; }
      let d = p.dog;
      if (!d) {
        d = p.dog = makeDog(p.pid ^ 0x51d, DOG_BREEDS[p.breed] ?? DOG_BREEDS[2], _o);
        d.gx = 1e9; d.gz = 1e9; d.gy = 0;
        d.lead = LEAD_TINTS[(p.pid >>> 5) % LEAD_TINTS.length];
      }
      stepDog(d, _o, dt);
      // ---- the row ----
      const b = d.breed, s = b.size * k, sy = s * (0.5 + 0.5 * b.leg), sz = s * b.long, gy = this._ground(d);
      _e.set(0.42 * d.sit, d.h, 0);
      _m.compose(_p.set(d.x, gy - 0.10 * sy * d.sit, d.z), _q.setFromEuler(_e), _s.set(s * 1.04, sy, sz));
      this.mesh.setMatrixAt(n, _m);
      this.mesh.setColorAt(n, _c.setHex(p.propTint));
      const o = n * 4;
      A[o] = d.phase; A[o + 1] = d.reach * (1 - d.sit); A[o + 2] = d.head; A[o + 3] = d.wag;
      // ---- the lead, while somebody is holding it ----
      if (!down && p.state !== 'board') {
        const cf = 0 - COLLAR.z * sz, cx = d.x - Math.sin(d.h) * cf, cz = d.z - Math.cos(d.h) * cf;
        const cy = gy + COLLAR.y * sy + 0.1 * sy * d.sit;
        const span = Math.hypot(cx - _o.hx, cz - _o.hz, cy - hy);
        this._lead(leads++, _o.hx, hy, _o.hz, cx, cy, cz, Math.min(0.13, Math.max(0.015, (b.lead * 1.05 - span) * 0.3)) * (1 - 0.8 * d.taut), d.lead);
      }
      n++;
    }
    this.count = n;
    this.mesh.count = n;
    if (n) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; this.anim.needsUpdate = true; }
    this.leads.geometry.setDrawRange(0, leads * SEG * 12);
    if (leads) { this.lpos.needsUpdate = true; this.lcol.needsUpdate = true; }
  }

  dispose() {
    this.scene.remove(this.mesh, this.leads);
    this.mesh.geometry.dispose();
    this.leads.geometry.dispose();
    this.leads.material.dispose();
  }
}
