// ---- Mahé's granite ----
// The Seychelles are granite: grey-pink domes and boulders the size of houses,
// rounded by the weather, standing at the ends of every beach (Anse Intendance,
// Anse Takamaka, Anse Royale) and breaking out of the forest on the slopes as
// bare glacis. scripts/mahe/extras.mjs places them from ESA WorldCover's bare
// rock and every OSM natural=rock; this draws them.
//
// One shape, many sizes: an icosahedron pushed out of round by low waves and
// squashed a little, so each instance reads as a boulder and not a ball. The
// instances are grouped by 600 m cell, one InstancedMesh per cell, so the
// frustum culls them a cell at a time. Each sits a third of its height into
// the terrain, the way a boulder settles. Built once; nothing per frame except
// standing late cells on terrain that arrived after them.

import * as THREE from 'three';
import { dataUrl } from '../regions.js';

const CELL = 600;

function boulderGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.getAttribute('position'), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = 1 + 0.10 * Math.sin(v.x * 3.1 + v.y * 1.7) + 0.07 * Math.sin(v.z * 4.3 - v.x * 2.2) + 0.05 * Math.sin(v.y * 6.1);
    v.multiplyScalar(d);
    v.y *= v.y < 0 ? 0.8 : 0.72;   // a flatter top and a buried foot
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export async function buildBoulders(scene, terrain) {
  let data;
  try { data = await (await fetch(dataUrl('boulders.json'))).json(); } catch { return null; }
  const list = data.b ?? [];
  if (!list.length) return null;
  const geo = boulderGeometry();
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const cells = new Map();
  for (const b of list) {
    const k = Math.floor(b[0] / CELL) + ',' + Math.floor(b[1] / CELL);
    let c = cells.get(k);
    if (!c) cells.set(k, c = []);
    c.push(b);
  }
  const group = new THREE.Group();
  group.name = 'mahe-granite';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), e = new THREE.Euler();
  const col = new THREE.Color();
  const hash = (x, z, k) => { let h = Math.imul(Math.round(x * 10) ^ 0x51ed27, 2654435761) ^ Math.imul(Math.round(z * 10) + k, 0x27d4eb2d); h ^= h >>> 15; h = Math.imul(h, 2246822519); return ((h ^ (h >>> 13)) >>> 0) / 4294967296; };
  const pending = [];
  for (const items of cells.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    mesh.castShadow = true; mesh.receiveShadow = true;
    let anyMissing = false;
    items.forEach((b, i) => {
      const [x, z, r] = b;
      const a = hash(x, z, 1), w = hash(x, z, 2);
      s.set(r * (0.9 + 0.5 * a), r * (0.55 + 0.35 * w), r * (0.8 + 0.4 * hash(x, z, 3)));
      e.set((hash(x, z, 4) - 0.5) * 0.3, a * Math.PI * 2, (hash(x, z, 5) - 0.5) * 0.3);
      q.setFromEuler(e);
      const y = terrain?.heightAt?.(x, z);
      if (terrain?.missed) anyMissing = true;
      t.set(x, (y ?? 0) + s.y * 0.35, z);
      m.compose(t, q, s);
      mesh.setMatrixAt(i, m);
      // weathered grey granite, some pinker, some darker with lichen
      col.setHSL(0.06 + 0.04 * hash(x, z, 6), 0.06 + 0.10 * hash(x, z, 7), 0.42 + 0.16 * hash(x, z, 8));
      mesh.setColorAt(i, col);
    });
    mesh.computeBoundingSphere();
    mesh.userData.items = items;
    if (anyMissing) pending.push(mesh);
    group.add(mesh);
  }
  group.userData.pending = pending;
  scene.add(group);
  return group;
}

/** Re-stand the cells whose terrain arrived after they were built. */
export function settleBoulders(group, terrain) {
  const pend = group?.userData.pending;
  if (!pend?.length) return;
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (let k = pend.length - 1; k >= 0; k--) {
    const mesh = pend[k];
    terrain.missed = false;
    mesh.userData.items.forEach((b, i) => {
      mesh.getMatrixAt(i, m); m.decompose(p, q, s);
      p.y = terrain.heightAt(b[0], b[1]) + s.y * 0.35;
      m.compose(p, q, s); mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    if (!terrain.missed) pend.splice(k, 1);
  }
}
