// ---- speedfx.js: the air shows itself past 100 km/h ----
// The anime speed-line: thin translucent streaks that flick past the vehicle
// once it is genuinely moving. The trick that makes them read as SPEED rather
// than as particles is that each streak is ANCHORED TO THE AIR — it spawns
// ahead and beside the machine, oriented along the velocity, and then stays
// where it is while the vehicle rushes through the swarm. Nothing here chases
// anything; the camera's own motion does all the work.
//
// One pool of stretched quads, one shared material, zero per-frame allocation.
// Streaks fade in over their first quarter of life and out over the rest, so
// the wrap of the pool is never a pop. update() is fed by main for whichever
// machine the player is in (car OR helicopter — same physics of perception).

import * as THREE from 'three';

const POOL = 44;
const V_ON = 100 / 3.6;         // streaks begin at 100 km/h…
const V_FULL = 145 / 3.6;       // …and reach full density/opacity by ~145
const LIFE = 0.34;              // s a streak hangs in the air
const R_IN = 1.7, R_OUT = 5.2;  // spawn annulus around the hull
const AHEAD = 0.65;             // bias spawns toward where the vehicle is GOING

export class SpeedStreaks {
  constructor(scene) {
    // a unit quad along +x; per-streak scale stretches it into a line
    const g = new THREE.PlaneGeometry(1, 0.045);
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xeef2f8, transparent: true, opacity: 0.0,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      // per-streak material clone is the one duplication we accept: opacity is
      // a material property and 44 tiny clones of one shader cost nothing
      const m = new THREE.Mesh(g, this.mat.clone());
      m.visible = false;
      m.renderOrder = 40;
      scene.add(m);
      this.pool.push({ m, t: 0, life: 0, peak: 0.2 });
    }
    this._acc = 0;
  }

  /** Call every frame with the player's machine; pass vx/vy/vz in m/s.
   *  Call with speed 0 (or not at all) when on foot — streaks just expire. */
  update(dt, x, y, z, vx, vy, vz) {
    const v = Math.hypot(vx, vy, vz);
    const k = Math.max(0, Math.min(1, (v - V_ON) / (V_FULL - V_ON)));
    // age the live ones
    for (const s of this.pool) {
      if (!s.m.visible) continue;
      s.t += dt;
      if (s.t >= s.life) { s.m.visible = false; continue; }
      const u = s.t / s.life;
      s.m.material.opacity = s.peak * (u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75);
    }
    if (k <= 0) return;
    // spawn rate scales with how far past the threshold we are
    this._acc += dt * (14 + 46 * k);
    while (this._acc >= 1) {
      this._acc -= 1;
      const s = this.pool.find((p) => !p.m.visible);
      if (!s) break;
      // random point on an annulus in the plane ⊥ velocity, biased ahead
      const ux = vx / v, uy = vy / v, uz = vz / v;
      // two perpendiculars to the velocity (Gram–Schmidt off world-up)
      let ax = -uz, ay = 0, az = ux;
      const al = Math.hypot(ax, ay, az) || 1; ax /= al; az /= al;
      const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
      const ang = Math.random() * Math.PI * 2;
      const r = R_IN + Math.random() * (R_OUT - R_IN);
      const off = (Math.random() * 2 - 0.5) * v * AHEAD * LIFE;
      s.m.position.set(
        x + (ax * Math.cos(ang) + bx * Math.sin(ang)) * r + ux * off,
        Math.max(0.4, y + (ay * Math.cos(ang) + by * Math.sin(ang)) * r + uy * off),
        z + (az * Math.cos(ang) + bz * Math.sin(ang)) * r + uz * off);
      // orient the quad's +x along the velocity
      s.m.quaternion.setFromUnitVectors(_X, _v.set(ux, uy, uz));
      s.m.scale.set(2.2 + v * 0.16, 1, 1);       // faster = longer lines
      s.t = 0;
      s.life = LIFE * (0.7 + Math.random() * 0.6);
      s.peak = (0.06 + 0.16 * k) * (0.6 + Math.random() * 0.7);
      s.m.material.opacity = 0;
      s.m.visible = true;
    }
  }
}

const _X = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
