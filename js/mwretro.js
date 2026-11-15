// ---- mwretro.js: the D11's delineators catch your headlights at night ----
// A Czech motorway at night is a black ribbon with two chains of points
// running ahead of you: the amber reflectors on the right-hand delineators
// and the white ones on the left and on the median barrier, lit by your own
// headlights out to 150 to 200 m and dark everywhere else. The reflectors
// themselves (js/mwdress.js) are 5 cm strips: at 40 m they are a third of a
// pixel, so geometry alone can never show that chain, and the ground
// material has no notion of a beam coming back along itself.
//
// So, as the town's far lamps and the trams do (js/farlights.js,
// js/tramglow.js): one camera-facing glow per reflector with the lamp glows'
// shader (js/lightpools.js), so it keeps a two-pixel floor and goes through
// the same bloom and haze. Unlike a lamp it is not a light: its brightness is
// worked out each frame from the player's car, the only car whose driver we
// are (main.js builds its two beams), as a retroreflector sends the light
// back to where it came from:
//   · only inside the beams (a cone round the car's heading),
//   · out to the reach of dipped beams on a reflector (BEAM_FAR),
//   · only on the faces turned toward the car (a delineator serves one
//     direction of travel: the westbound chain is dark from the eastbound),
//   · only after dusk and only with the beams on.
// Positions are the drawing's own (js/mwplan.js barrierPlan, the stations
// mwdress.js puts a delineator on), worked out for the cells round the car a
// cell or two per frame and kept while the car is near. Main thread only;
// nothing here is chunk geometry, so the worker and the codec never see it.

import * as THREE from 'three';
import { barrierPlan, K_RAIL, MEDIAN_H, RAIL_H, STRIDE, DELIN_STEP } from './mwplan.js';
import { d11Locate } from './d11.js';

const CHUNK = 120;
const MAX = 1500;              // reflectors in reach at once (about 12 a cell a side)
const AROUND = 2;              // cells either side of the car's that are kept planned
const NEAR = 6;                // m: nearer than this the drawn reflector does it
const RANGE = 600;             // m: the glow shader's fade-out (BEAM_FAR is ours)
// m: a glow's radius, four times a reflector's real size. Under the shader's
// two-pixel floor a glow gives back brightness for area, and the drawn
// reflector glares in dipped beams far past its size: at 0.07 m the chain
// was invisible past 40 m, at 0.12 a dot lost in the frame (seen in game);
// 0.28 reads as the row of points a driver sees, full strength to the beam's end.
const SIZE = 0.28;
const BEAM_FAR = 230;          // m: dipped beams on retroreflective sheeting
const CONE0 = 0.955, CONE1 = 0.992;   // cos of the beam's edge and its core (17 and 7 degrees)
// brightness in the core of the beam: about a street lamp's glow core, which
// is what a delineator in dipped beams looks like from the driver's seat
const GAIN = 3.5;
const POST_BACK = 0.12;        // mwdress.js: the post stands behind the beam
// linear colours of the sheeting: amber Z 11a on the right, white Z 11b
const AMBER = [1.0, 0.42, 0.05], WHITE = [0.95, 0.95, 0.9];

/**
 * The reflectors of one cell's plan as a flat array of
 * [x, y, z, tx, tz, r, g, b] per reflector: the stations mwdress.js draws a
 * delineator on, (tx, tz) the direction of travel its face serves. Pure.
 */
export function reflectorsOf(plan) {
  const out = [];
  for (const run of plan) {
    const v = run.v, n = v.length / STRIDE;
    for (let i = 0; i < n - 1; i++) {
      const a = i * STRIDE;
      if ((i === 0 && (run.ends & 1)) || Math.round(v[a + 6]) % DELIN_STEP !== 0) continue;
      const x = v[a], z = v[a + 1], y = v[a + 2], nx = v[a + 3], nz = v[a + 4];
      const tx = run.sd > 0 ? -nz : nz, tz = run.sd > 0 ? nx : -nx;
      if (run.k === K_RAIL) {
        const c = run.sd > 0 ? AMBER : WHITE;
        out.push(x - nx * POST_BACK, y + RAIL_H + 0.2, z - nz * POST_BACK, tx, tz, c[0], c[1], c[2]);
      } else {
        out.push(x + nx * 0.04, y + MEDIAN_H + 0.16, z + nz * 0.04, tx, tz, WHITE[0], WHITE[1], WHITE[2]);
      }
    }
  }
  return out;
}

/**
 * How much of the car's beam a reflector at (x, y, z) facing travel (tx, tz)
 * sends back, 0..1. (lx, ly, lz) the lamps, (fx, fz) the car's heading.
 */
export function retroGain(x, y, z, tx, tz, lx, ly, lz, fx, fz) {
  const dx = x - lx, dz = z - lz, dh = Math.hypot(dx, dz);
  if (dh < 1e-3 || dh > BEAM_FAR) return 0;
  const face = tx * fx + tz * fz;               // the reflector looks back at the car
  if (face < 0.5) return 0;
  const cone = (dx * fx + dz * fz) / dh;
  if (cone < CONE0) return 0;
  const dy = Math.abs(y - ly) / dh;              // dipped beams do not reach up a bank
  if (dy > 0.25) return 0;
  const c = Math.min(1, (cone - CONE0) / (CONE1 - CONE0));
  const far = dh < BEAM_FAR * 0.7 ? 1 : 1 - (dh - BEAM_FAR * 0.7) / (BEAM_FAR * 0.3);
  return c * c * (3 - 2 * c) * far * Math.min(1, (face - 0.5) * 4);
}

export class MwRetro {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.src = null;
    this.cells = new Map();          // key -> { cell, loads, pts }
    this._keep = [];                 // reusable key list
  }

  /** Take the lamp glows' shader from js/lightpools.js (main.js, once both exist). */
  attach(lightPools) {
    if (this.mesh || !lightPools?.glowMat) return;
    this.src = lightPools.glowMat;
    const mat = this.src.clone();
    mat.uniforms.uRange.value = RANGE;
    mat.uniforms.uSize.value = SIZE;
    mat.uniforms.uNear.value = NEAR;
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), mat, MAX);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.renderOrder = -788;            // with the lamp glows, before glass and smoke
    m.castShadow = m.receiveShadow = false;
    m.onBeforeRender = (renderer) => { mat.uniforms.uDirect.value = renderer.getRenderTarget() === null ? 1 : 0; };
    const im = m.instanceMatrix.array;
    for (let i = 0; i < MAX; i++) { im[i * 16] = im[i * 16 + 5] = im[i * 16 + 10] = im[i * 16 + 15] = 1; }
    this.mesh = m;
    this.scene.add(m);
  }

  /**
   * Once a frame from main.js updateNightLights. `car` the car being driven
   * (null on foot), `beams` whether its headlights are on, `lampY` their height.
   */
  update(world, car, beams, lampY) {
    const m = this.mesh;
    if (!m) return;
    const on = this.src.uniforms.uOn.value;
    if (!car || !beams || on <= 0.002 || !world?.city?.chunkIndex || !world.terrain
      || !d11Locate(car.x, car.z)) {
      m.visible = false;
      return;
    }
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    const lx = car.x + fx * 1.9, lz = car.z + fz * 1.9;
    const ccx = Math.floor(car.x / CHUNK), ccz = Math.floor(car.z / CHUNK);
    // plan at most two new cells a frame, nearest first (the ring is small)
    let planned = 0;
    for (let r = 0; r <= AROUND && planned < 2; r++) {
      for (let dx = -r; dx <= r && planned < 2; dx++) for (let dz = -r; dz <= r && planned < 2; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const key = (ccx + dx) + ',' + (ccz + dz);
        const cell = world.city.chunkIndex.get(key);
        const loads = world.terrain._loads ?? 0;
        const e = this.cells.get(key);
        if (!cell) { if (e) this.cells.delete(key); continue; }
        if (e && e.cell === cell && e.loads === loads) continue;
        this.cells.set(key, { cell, loads, cx: ccx + dx, cz: ccz + dz,
          pts: reflectorsOf(barrierPlan(cell, key, world.terrain, 0)) });
        planned++;
      }
    }
    // write this frame's reflectors; drop cells the car has left
    const keep = this._keep;
    keep.length = 0;
    const im = m.instanceMatrix.array, col = m.instanceColor.array;
    let n = 0;
    for (const [key, e] of this.cells) {
      if (Math.abs(e.cx - ccx) > AROUND + 1 || Math.abs(e.cz - ccz) > AROUND + 1) { keep.push(key); continue; }
      const p = e.pts;
      for (let i = 0; i < p.length && n < MAX; i += 8) {
        const g = retroGain(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], lx, lampY, lz, fx, fz);
        if (g < 0.01) continue;
        im[n * 16 + 12] = p[i]; im[n * 16 + 13] = p[i + 1]; im[n * 16 + 14] = p[i + 2];
        const k = g * GAIN;
        col[n * 3] = p[i + 5] * k; col[n * 3 + 1] = p[i + 6] * k; col[n * 3 + 2] = p[i + 7] * k;
        n++;
      }
    }
    for (const key of keep) this.cells.delete(key);
    const u = m.material.uniforms, su = this.src.uniforms;
    u.uOn.value = su.uOn.value; u.uLevel.value = su.uLevel.value; u.uPx.value = su.uPx.value;
    m.count = n;
    m.visible = n > 0;
    if (n) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
  }
}
