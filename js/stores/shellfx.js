// ---- stores/shellfx.js: the glass, the sliding door and the lit room ----
// Main thread only. The chunk mesh (js/stores/build.js) leaves a store's
// glazing as real holes and draws its room in whatever light the sun leaves
// under a roof. This is what the store runtime adds for every store within
// sight: the panes in those holes, the two leaves of the sliding door, and the
// same floor, walls and ceiling again as a room with its lights on.
//
// Everything is built in the store's own frame (X along the front, Z out
// through it, Y up from its ground) under one group, so a tile pattern or a
// shelf row is laid out in small numbers however far from the origin the town is.

import * as THREE from 'three';
import { EXPOSURE_DAY, EXPOSURE_NIGHT } from '../sky.js';
import { DOOR_H } from './build.js';

const LIT = new Set();          // every material that lights itself, for the night dimmer
let _night = -1;

/**
 * A surface under shop lighting: most of its colour is emitted, so it reads
 * the same at noon under a roof and at midnight. `lit` 0..1 is that share.
 */
export function litMaterial(hex, lit = 0.6, o = {}) {
  const m = new THREE.MeshLambertMaterial({ color: hex, ...o });
  m.userData.hex = o.map ? 0xffffff : hex; m.userData.lit = lit;
  if (o.map) { m.emissiveMap = o.map; m.color.setHex(0xffffff); }
  m.color.multiplyScalar(1 - lit * 0.55);
  m.emissive = new THREE.Color(m.userData.hex).multiplyScalar(lit);
  LIT.add(m);
  m.addEventListener('dispose', () => LIT.delete(m));
  return m;
}

/** 0 by day, 1 at night: the game opens its exposure after dark, a lit room must not blow out. */
export function fxNight(k, force = false) {
  if (!force && Math.abs(k - _night) < 0.01) return;
  _night = k;
  const dim = Math.pow(EXPOSURE_DAY / EXPOSURE_NIGHT, k);
  for (const m of LIT) m.emissive.setHex(m.userData.hex).multiplyScalar(m.userData.lit * (m.userData.closed ? 0.25 : 1) * dim);
  GLOW.color.setScalar(dim);
}

/** Things that are simply bright: light strips, screens. */
export const GLOW = new THREE.MeshBasicMaterial({ color: 0xffffff });

let _glass = null, _frame = null;
const _tile = [null, null];
export function glassMaterial() {
  return (_glass ??= new THREE.MeshLambertMaterial({ color: 0x8fb0bd, transparent: true, opacity: 0.3,
    depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, emissive: 0x24363f }));
}
const frameMaterial = () => (_frame ??= new THREE.MeshLambertMaterial({ color: 0x2f3338 }));

/** Shop floor tiles, 60 cm, as a texture laid in the store's own metres. */
function tileTexture(warm = false) {
  if (_tile[+warm]) return _tile[+warm];
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  // a supermarket's pale grey tiles; a restaurant's darker, warmer ones
  g.fillStyle = warm ? '#6f665c' : '#a9aba8'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const v = (warm ? 126 : 186) + ((i * 7 + j * 13) % 5) * 5;
    g.fillStyle = warm ? `rgb(${v + 14},${v + 4},${v - 8})` : `rgb(${v + 4},${v + 5},${v + 2})`;
    g.fillRect(i * 64 + 1, j * 64 + 1, 62, 62);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return (_tile[+warm] = t);
}

/** The group a store's runtime pieces hang in: its frame as a matrix. */
export function storeGroup(site, base) {
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.matrix.makeBasis(new THREE.Vector3(site.ux, 0, site.uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(site.nx, 0, site.nz));
  g.matrix.setPosition(site.ox, base, site.oz);
  g.matrixWorldNeedsUpdate = true;
  return g;
}

function quadGeo(quads) {
  const pos = new Float32Array(quads.length * 18), nrm = new Float32Array(quads.length * 18), uv = new Float32Array(quads.length * 12);
  quads.forEach((q, i) => {
    let [A, B, C, D] = q;
    const n = q[4], o = i * 18;
    // wound to face the way its normal says, whichever way round the footprint was drawn
    const gx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
    const gy = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
    const gz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (gx * n[0] + gy * n[1] + gz * n[2] < 0) { const t = B; B = D; D = t; }
    [A, B, C, A, C, D].forEach((p, k) => { pos.set(p, o + k * 3); nrm.set(n, o + k * 3); });
    uv.set([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], i * 12);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** The ceiling height over local (u, v): the roof's own underside. */
export function ceilAt(site, v) {
  // (`arch.ceil`: a hung ceiling, where a lower neighbour's eaves would show under the roof)
  if (site.hF === site.hB) return Math.min(site.hF - 0.78, site.chain.arch.ceil ?? Infinity);
  const t = Math.max(0, Math.min(1, (v + site.hv) / Math.max(1, 2 * site.hv)));
  return site.hB + (site.hF - site.hB) * t - 0.33;
}

/**
 * The panes, the door and the lit room of one store.
 * @returns {{group, door: {left, right, w}, setDoor(k), dispose()}}
 */
export function buildShellFx(site, base) {
  const group = storeGroup(site, base);
  const L = (p) => site.local(p[0], p[1]);
  const fl = site.floor;
  const made = [];
  const add = (geo, mat, order = 0) => { const m = new THREE.Mesh(geo, mat); m.renderOrder = order; m.matrixAutoUpdate = false; group.add(m); made.push(geo); return m; };

  // ---- glass in the holes, lit wall faces round the room ----
  const panes = [], walls = [];
  for (const s of site.segs) {
    const [au, av] = L(s.a), [bu, bv] = L(s.b);
    const [mu, mv] = [s.mx * site.ux + s.mz * site.uz, s.mx * site.nx + s.mz * site.nz];
    const ta = site.topAt(s.a[0], s.a[1]), tb = site.topAt(s.b[0], s.b[1]);
    const gt = Math.min(site.glassTop, ta - (site.chain.arch.bandH ?? 0) - 0.25, tb - (site.chain.arch.bandH ?? 0) - 0.25);
    const n = [mu, 0, mv], ni = [-mu, 0, -mv];
    if (s.kind === 'glass') panes.push([[au, fl + 0.1, av], [bu, fl + 0.1, bv], [bu, gt, bv], [au, gt, av], n]);
    if (s.kind === 'door') panes.push([[au, fl + DOOR_H, av], [bu, fl + DOOR_H, bv], [bu, gt, bv], [au, gt, av], n]);
    // the room side, a hand inside the chunk's own inner face
    const o = 0.36, ia = [au - mu * o, av - mv * o], ib = [bu - mu * o, bv - mv * o];
    const y0 = s.kind === 'wall' ? fl : gt;
    walls.push([[ib[0], y0, ib[1]], [ia[0], y0, ia[1]], [ia[0], ta - 0.3, ia[1]], [ib[0], tb - 0.3, ib[1]], ni]);
  }
  if (panes.length) add(quadGeo(panes), glassMaterial(), 3);
  const fast = site.chain.kind === 'fast';
  const wallMat = litMaterial(fast ? 0xe6dccb : 0xe4e5e2, 0.4);
  add(quadGeo(walls), wallMat);

  // ---- floor and ceiling over the footprint ----
  const shape = new THREE.Shape(site.ring.map((p) => { const [u, v] = L(p); return new THREE.Vector2(u, v); }));
  const lid = (yAt, up) => {
    const g = new THREE.ShapeGeometry(shape);
    const P = g.attributes.position, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      const u = P.getX(i), v = P.getY(i);
      P.setXYZ(i, u, yAt(v), v);
      U.setXY(i, u / 2.4, v / 2.4);
    }
    // which way the triangles face once laid flat: summed over all of them (one may be a sliver)
    const idx = g.index.array;
    let ny = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      ny += (P.getZ(b) - P.getZ(a)) * (P.getX(c) - P.getX(a)) - (P.getX(b) - P.getX(a)) * (P.getZ(c) - P.getZ(a));
    }
    if ((ny > 0) !== up) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.computeVertexNormals();
    return g;
  };
  const floorMat = litMaterial(0xffffff, 0.34, { map: tileTexture(fast) });
  const ceilMat = litMaterial(site.hF === site.hB ? 0xdfe0dd : 0xcfd3d5, 0.42);
  add(lid(() => fl + 0.03, true), floorMat);
  add(lid((v) => ceilAt(site, v) - 0.01, false), ceilMat);

  // ---- the sliding door: two framed leaves that part along the wall ----
  const dl = L([site.door.x, site.door.z]);
  const w = site.door.w, lw = w / 2;
  const leaf = () => {
    const g = new THREE.Group();
    const glass = new THREE.Mesh(new THREE.BoxGeometry(lw - 0.08, DOOR_H - 0.1, 0.02), glassMaterial());
    glass.position.y = DOOR_H / 2; glass.renderOrder = 3;
    g.add(glass); made.push(glass.geometry);
    for (const [x, y, sx, sy] of [[0, 0.04, lw, 0.08], [0, DOOR_H - 0.04, lw, 0.08], [-lw / 2 + 0.03, DOOR_H / 2, 0.06, DOOR_H], [lw / 2 - 0.03, DOOR_H / 2, 0.06, DOOR_H]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.05), frameMaterial());
      b.position.set(x, y, 0); g.add(b); made.push(b.geometry);
    }
    group.add(g);
    return g;
  };
  const left = leaf(), right = leaf();
  const z = dl[1] - 0.12;
  const setDoor = (k) => {
    left.position.set(dl[0] - lw / 2 - k * lw * 0.94, fl, z);
    right.position.set(dl[0] + lw / 2 + k * lw * 0.94, fl, z);
    left.updateMatrix(); right.updateMatrix();
  };
  for (const g of [left, right]) { g.matrixAutoUpdate = false; g.children.forEach((c) => { c.updateMatrix(); c.matrixAutoUpdate = false; }); }
  setDoor(0);
  return {
    group, setDoor, mats: { wallMat, floorMat, ceilMat },
    dispose() {
      group.removeFromParent();
      for (const g of made) g.dispose();
      wallMat.dispose(); floorMat.dispose(); ceilMat.dispose();
    },
  };
}
