// ---- groundblob.js: the patch of shade a person stands on ------------------
//
// The sun's shadow map covers 230 m with 2048 texels: eleven centimetres each,
// and a leg is ten wide. A walker's real shadow is therefore a smudge at best
// and nothing at all at noon, and a figure with nothing under its feet reads
// as pasted onto the pavement. Cars got a contact shadow in wave 1 for the
// same reason; this is the people's one.
//
// ONE InstancedMesh for everybody: a soft dark disc per person, one draw call
// for the whole crowd, no texture (the falloff is vertex alpha). The instances
// are rewritten from the bodies' own positions at the top of every render, by
// hooking the mesh's updateMatrixWorld, which the renderer calls before it
// collects anything to draw: so the disc is never a frame behind a sprinter.
//
// A body past the distance variant, hidden, seated in a vehicle (parented to
// it) or tumbling through the air gets none.

import * as THREE from 'three';

const MAX = 256;
// Above the soles, not at them: kerb paint, tactile paving and crossing stripes
// are layered up to 3.6 cm over the level feet stand on (measured in the game),
// and a disc below any of those is simply not drawn. The cars' sits at 3.5 cm.
const LIFT = 0.045;
const live = [];          // { group, mesh } per registered body
let blob = null;

function build() {
  const N = 14, pos = [0, 0, 0], col = [0, 0, 0, 0.46], idx = [];
  for (const [r, a] of [[0.55, 0.28], [1, 0]]) {
    for (let i = 0; i < N; i++) {
      const t = i / N * Math.PI * 2;
      pos.push(Math.cos(t) * r, 0, Math.sin(t) * r); col.push(0, 0, 0, a);
    }
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(0, 1 + j, 1 + i, 1 + i, 1 + j, 1 + N + j, 1 + i, 1 + N + j, 1 + N + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(g, m, MAX);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;                    // under the lamp pools and every other blend
  mesh.matrixAutoUpdate = false;
  const base = mesh.updateMatrixWorld;
  mesh.updateMatrixWorld = function (force) { sync(this); base.call(this, force); };
  return mesh;
}

function sync(mesh) {
  const a = mesh.instanceMatrix.array, scene = mesh.parent;
  let n = 0;
  for (let i = 0; i < live.length && n < MAX; i++) {
    const { group, mesh: body } = live[i];
    if (group.parent !== scene || !group.visible || body.userData.far) continue;
    const r = group.rotation;
    if (r.x > 0.35 || r.x < -0.35 || r.z > 0.35 || r.z < -0.35) continue;
    const s = group.scale.x * 0.36, o = n * 16, p = group.position;
    a[o] = s; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = s; a[o + 11] = 0;
    a[o + 12] = p.x; a[o + 13] = p.y + LIFT; a[o + 14] = p.z; a[o + 15] = 1;
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
}

/** A body joins the crowd of shaded feet. Returns the record to hand back. */
export function addBlob(group, mesh) {
  const rec = { group, mesh };
  live.push(rec);
  return rec;
}

export function removeBlob(rec) {
  const i = live.indexOf(rec);
  if (i >= 0) { live[i] = live[live.length - 1]; live.pop(); }
}

/** Called from a body's render hook: make sure the discs are in THIS scene. */
export function blobsIn(scene) {
  if (!blob) blob = build();
  if (blob.parent !== scene) scene.add(blob);
}

export function disposeBlobs() {
  if (!blob) return;
  blob.parent?.remove(blob);
  blob.geometry.dispose(); blob.material.dispose(); blob.dispose();
  blob = null;
}
