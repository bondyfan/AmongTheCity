// ---- stores/lotpaint.js: white lines on a store's car park ----
// Main thread. A supermarket's car park is marked out; the mapped parking
// polygons round a store were bare paving. The bays painted here are exactly
// the stalls js/parkinglots.js parks its cars in (the same function lays them
// out), so a car stands between its lines, and two players see the same bays.
// One small mesh per store, drawn only while the store is in sight.

import * as THREE from 'three';
import { lotStalls, STALL } from '../parkinglots.js';
import { around } from './site.js';

const REACH = 80;          // m from the store's walls: further off it is somebody else's car park
let _mat = null;

/**
 * The bay lines of every car park round a store, standing on the ground as
 * `heightAt(x, z)` gives it. Returns a Mesh in world coordinates, or null.
 */
export function buildLotPaint(f, heightAt) {
  const src = around(f, null);
  if (!src?.paved) return null;
  const pos = [];
  const quad = (x0, z0, x1, z1, w) => {
    // a strip from (x0, z0) to (x1, z1), w wide, laid on the ground at both ends
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz) || 1, px = -dz / L * w / 2, pz = dx / L * w / 2;
    const y0 = heightAt(x0, z0) + 0.035, y1 = heightAt(x1, z1) + 0.035;
    const a = [x0 - px, y0, z0 - pz], b = [x0 + px, y0, z0 + pz], c = [x1 + px, y1, z1 + pz], d = [x1 - px, y1, z1 - pz];
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  let cx = 0, cz = 0;
  for (const p of f.o) { cx += p[0]; cz += p[1]; }
  cx /= f.o.length; cz /= f.o.length;
  const reach = REACH + Math.max(...f.o.map((p) => Math.hypot(p[0] - cx, p[1] - cz)));
  for (const lot of src.paved) {
    if (lot.t !== 'parking' || !lot.o?.length) continue;
    if (!lot.o.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < reach)) continue;
    for (const st of lotStalls(lot)) {
      // the car's nose is along its heading: the lines run that way, one each side
      const fx = -Math.sin(st.h), fz = -Math.cos(st.h), rx = -fz, rz = fx;
      for (const s of [-1, 1]) {
        const ox = st.x + rx * s * STALL.across / 2, oz = st.z + rz * s * STALL.across / 2;
        quad(ox - fx * STALL.deep / 2, oz - fz * STALL.deep / 2, ox + fx * STALL.deep / 2, oz + fz * STALL.deep / 2, 0.1);
      }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  // paint lies face up whichever way a strip was wound
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  _mat ??= new THREE.MeshLambertMaterial({ color: 0xe9e9e4, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const m = new THREE.Mesh(g, _mat);
  m.matrixAutoUpdate = false;
  m.receiveShadow = true;
  return m;
}
