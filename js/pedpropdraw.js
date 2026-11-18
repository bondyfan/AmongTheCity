// ---- pedpropdraw.js: the prams ------------------------------------------------
// Whoever js/pedprops.js gave a pram pushes one: both hands on the handle
// (js/gait.js 'push') and the pram rolling an arm's length ahead. Every pram in
// the world is a row of one InstancedMesh, tinted per row, so ten prams cost
// what one does.
//
// The pram is not a thing in the world, it is a prop of its pusher: it goes
// where they go, stops when they stop and stands by the bench when they sit.
// When its pusher is knocked down or taken hold of it stays where it was.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { PROP } from './pedprops.js';
import { PLAYER_SCALE } from './config.js';

const MAX = 24;
const AHEAD = 1.04;        // m from the pusher's feet to the pram's middle, at full scale: the handle meets the hands

function tinted(geo, shade) {
  const g = geo.index ? geo.toNonIndexed() : geo, n = g.attributes.position.count;
  const col = new Float32Array(n * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

// Faces -z (the way it is pushed), wheels on y = 0, the handle toward +z.
function pramGeometry() {
  const parts = [];
  const box = (w, h, d, x, y, z, shade, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    parts.push(tinted(g.translate(x, y, z), shade));
  };
  // the tub, a little longer than a baby, and its lighter lining showing at the rim
  box(0.40, 0.24, 0.74, 0, 0.66, -0.06, 1.0);
  box(0.36, 0.02, 0.70, 0, 0.775, -0.06, 1.6);
  // the hood over the end by the handle: three flat panels of an arc
  box(0.42, 0.20, 0.03, 0, 0.86, 0.30, 0.82);
  box(0.42, 0.03, 0.22, 0, 0.965, 0.185, 0.82, 0.28);
  box(0.42, 0.03, 0.16, 0, 0.925, 0.03, 0.82, -0.62);
  // the frame: two crossed legs a side, and the handle
  for (const sx of [-1, 1]) {
    box(0.022, 0.62, 0.022, sx * 0.21, 0.36, -0.03, 0.34, 0.86);
    box(0.022, 0.62, 0.022, sx * 0.21, 0.36, -0.03, 0.34, -0.86);
    box(0.022, 0.50, 0.022, sx * 0.20, 0.90, 0.445, 0.34, 0.78);
  }
  box(0.44, 0.03, 0.03, 0, 1.08, 0.62, 0.2);
  // four wheels
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const w = new THREE.CylinderGeometry(0.13, 0.13, 0.04, 10, 1).rotateZ(Math.PI / 2);
    parts.push(tinted(w.translate(sx * 0.24, 0.13, -0.03 + sz * 0.27), 0.16));
  }
  const g = mergeGeometries(parts, false);
  g.computeBoundingSphere();
  return g;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Color(), _Y = new THREE.Vector3(0, 1, 0);

export class Prams {
  constructor(scene) {
    this.scene = scene;
    this.mesh = new THREE.InstancedMesh(pramGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    this.mesh.name = 'kočárky';
    scene.add(this.mesh);
    this.enabled = true;
  }

  /** Once a frame, after the crowd has moved: `peds` is js/pedestrians.js peds. */
  update(peds) {
    this.mesh.visible = this.enabled;
    if (!this.enabled) return;
    let n = 0;
    for (const p of peds) {
      if (p.prop !== PROP.PRAM || n >= MAX) continue;
      const k = PLAYER_SCALE;
      // it follows its pusher while they walk, stand or sit; otherwise it stays put
      if (p.state === 'walk' || p.state === 'board' || p.pramX !== p.pramX) {
        const h = p.heading, fx = -Math.sin(h), fz = -Math.cos(h);
        // (beside the knees of somebody on a bench, not through them)
        const out = p.pose === 2 ? AHEAD * 1.12 : AHEAD;
        p.pramX = p.x + fx * out * k; p.pramZ = p.z + fz * out * k; p.pramH = h;
        p.pramY = p.mesh.position.y + (p.pose === 2 ? p.sitDrop : 0);
      }
      _m.compose(_p.set(p.pramX, p.pramY, p.pramZ), _q.setFromAxisAngle(_Y, p.pramH), _s.setScalar(k));
      this.mesh.setMatrixAt(n, _m);
      this.mesh.setColorAt(n, _c.setHex(p.propTint));
      n++;
    }
    if (n || this.mesh.count) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
    this.mesh.count = n;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
