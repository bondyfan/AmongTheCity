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

// The pool has to cover the WHOLE speed range now, not just a fast car. A
// Gripen at Mach 2 does seventeen times the speed the old saturation point
// (145 km/h) allowed for, and everything above it looked identical — the same
// sparse handful of short lines whether you were doing 150 or 2 400. So the
// tuning splits in two: `k` is the onset ramp a car lives on, and `fast` keeps
// climbing all the way to jet speed, driving density, reach and lifetime.
const POOL = 170;               // enough for the jet's spawn rate × its lifetime
const V_ON = 115 / 3.6;         // streaks begin at 115 km/h…
const V_FULL = 145 / 3.6;       // …and reach a car's full density by ~145
const V_JET = 600;              // m/s — where the effect is as violent as it gets
const LIFE = 0.34;              // s a streak hangs in the air at car speed
const LIFE_FAST = 0.42;         // …shortened by this fraction at V_JET
const R_IN = 1.7, R_OUT = 5.2;  // spawn annulus around the hull, at car speed
const R_FAST = 26;              // …widened by this much at V_JET, past the wings
// Road-tested down: at 120 km/h the old numbers read like 400. A car spends its
// life in the bottom of this range and everyone has a calibrated feel for what
// 120 looks like, so the car band is deliberately sparse and faint — the drama
// is reserved for speeds that deserve it.
const RATE_CAR = 9, RATE_K = 26, RATE_FAST = 190;   // streaks per second
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
    // …and the part that does NOT saturate at a car's top speed
    const fast = Math.max(0, Math.min(1, (v - V_FULL) / (V_JET - V_FULL)));
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
    this._acc += dt * (RATE_CAR + RATE_K * k + RATE_FAST * fast * fast);
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
      // the swarm spreads out as it intensifies: at car speed it is a tight
      // sleeve around the roof, at Mach 2 it fills the frame
      const rOut = R_OUT + R_FAST * fast;
      const r = R_IN + Math.random() * (rOut - R_IN);
      const off = (Math.random() * 2 - 0.5) * v * AHEAD * LIFE;
      s.m.position.set(
        x + (ax * Math.cos(ang) + bx * Math.sin(ang)) * r + ux * off,
        Math.max(0.4, y + (ay * Math.cos(ang) + by * Math.sin(ang)) * r + uy * off),
        z + (az * Math.cos(ang) + bz * Math.sin(ang)) * r + uz * off);
      // orient the quad's +x along the velocity
      s.m.quaternion.setFromUnitVectors(_X, _v.set(ux, uy, uz));
      // length: gentle in the car band, then opened right up for the jet, where
      // a 100 m streak is what a 2 400 km/h frame actually looks like
      s.m.scale.set(2.2 + v * 0.09 + v * 0.11 * fast, 1, 1);
      s.t = 0;
      // Shorter lives at speed are what turn a drifting swarm into a WHIP: the
      // line is gone before it can drift far, so the eye reads pure velocity.
      s.life = LIFE * (1 - LIFE_FAST * fast) * (0.7 + Math.random() * 0.6);
      s.peak = (0.04 + 0.085 * k + 0.13 * fast) * (0.6 + Math.random() * 0.7);
      s.m.material.opacity = 0;
      s.m.visible = true;
    }
  }
}

const _X = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
