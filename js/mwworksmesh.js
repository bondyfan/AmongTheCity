// ---- mwworksmesh.js: the roadworks zones of the D11, drawn ----
// The three.js half of js/mwworks.js (which plans every cone, board and
// trailer from the shared zone table, so every client draws the same). Main
// thread only: it paints its boards into a canvas.
//
// COST. Only the zones whose road is within NEAR m of the player are drawn
// (a day has two or three on 192 km of carriageway, so usually none and at
// most one or two): two instanced meshes for the cones (the orange body and
// the white retroreflective bands, sharing one matrix per cone), one merged
// mesh for the boards' faces, one for posts, backs and trailers, one for the
// trailer's arrow lamps. Five draw calls while a zone is near, none when not.
// Rebuilt only when the set of near zones, or how much of their road has
// streamed in, changes: a few hundred matrices and a few hundred triangles.
// Nothing casts a shadow (the shadow map is paced, js/shadowpace.js).
//
// HEIGHT. Every item stands on the carriageway's own surface as the traffic
// computes it (traffic.js: bridgeDeckHeight on a deck, else roadGradeY, plus
// LAYER_Y.road), read from the motorway way under its centreline point in the
// chunk index. An item whose chunk has not streamed in yet waits (it is at
// least NEAR - the attach band away, far past the fog) and the mesh is
// rebuilt when it can stand.

import * as THREE from 'three';
import { worksPlan, zoneNear } from './mwworks.js';
import { zonesAt } from './mwtraffic.js';
import { chunkKey, roadGradeY, bridgeDeckHeight } from './geo.js';
import { LAYER_Y } from './config.js';

const NEAR = 2600;                 // m, a zone this close is drawn
const CHECK_DT = 0.5;              // s between looks at which zones are near
const CONE_CAP = 900;              // cones drawn at most (two long zones)

// ---- small geometry sinks ------------------------------------------------------
function sink() { return { p: [], n: [], c: [], uv: [] }; }
function geoOf(s, color, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(s.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(s.n, 3));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(s.c, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(s.uv, 2));
  g.computeBoundingSphere();
  return g;
}
const _col = new THREE.Color();
// one quad: corner o, edge vectors a and b (counter-clockwise seen from the
// front), normal n; uv rect [u0, v0, u1, v1] or a colour
function quad(s, o, a, b, n, hex, uvr) {
  const P = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
  if (hex != null) _col.setHex(hex).convertSRGBToLinear();
  for (const [i, j] of P) {
    s.p.push(o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j);
    s.n.push(n[0], n[1], n[2]);
    if (hex != null) s.c.push(_col.r, _col.g, _col.b);
    if (uvr) s.uv.push(uvr[0] + (uvr[2] - uvr[0]) * i, uvr[1] + (uvr[3] - uvr[1]) * j);
  }
}
// an upright box centred at (x, y0 + h/2, z), `w` across the road (along r),
// `l` along it (along f), yawed to the road's frame
function box(s, x, y0, z, f, r, w, h, l, hex) {
  const up = [0, 1, 0];
  const R = [r[0] * w, 0, r[2] * w], F = [f[0] * l, 0, f[2] * l], U = [0, h, 0];
  const o = [x - R[0] / 2 - F[0] / 2, y0, z - R[2] / 2 - F[2] / 2];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const neg = (a) => [-a[0], -a[1], -a[2]];
  quad(s, o, R, U, neg(f), hex);                           // facing back up the road
  quad(s, add(add(o, F), R), neg(R), U, f, hex);           // facing down it
  quad(s, add(o, R), F, U, r, hex);                        // right
  quad(s, add(o, F), neg(F), U, neg(r), hex);              // left
  quad(s, add(o, U), R, F, up, hex);                       // top
}

// The cone: TP 66's Z 4 road cone, 0.75 m, red-orange with two white
// retroreflective bands, on a black square foot. A turned profile; the bands
// are their own geometry a hair proud of the body (their own material).
const SEG = 10;
function lathe(s, prof, hex) {
  if (hex != null) _col.setHex(hex).convertSRGBToLinear();
  for (let k = 0; k < prof.length - 1; k++) {
    const [r0, y0] = prof[k], [r1, y1] = prof[k + 1];
    const sl = Math.atan2(r0 - r1, y1 - y0), ny = Math.sin(sl), nr = Math.cos(sl);
    for (let i = 0; i < SEG; i++) {
      const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const v = [[r0 * c0, y0, r0 * s0, c0, s0], [r1 * c1, y1, r1 * s1, c1, s1], [r0 * c1, y0, r0 * s1, c1, s1],
        [r0 * c0, y0, r0 * s0, c0, s0], [r1 * c0, y1, r1 * s0, c0, s0], [r1 * c1, y1, r1 * s1, c1, s1]];
      for (const q of v) {
        s.p.push(q[0], q[1], q[2]); s.n.push(q[3] * nr, ny, q[4] * nr);
        if (hex != null) s.c.push(_col.r, _col.g, _col.b);
      }
    }
  }
}
const coneR = (y) => 0.165 - 0.135 * (y / 0.75);
function coneGeometries() {
  const body = sink(), band = sink();
  box(body, 0, 0, 0, [0, 0, -1], [1, 0, 0], 0.4, 0.035, 0.4, 0x1c1c1c);
  lathe(body, [[0.17, 0.035], [coneR(0.035), 0.035], [0.03, 0.75], [0, 0.752]], 0xe0401c);
  for (const [y0, y1] of [[0.30, 0.42], [0.50, 0.58]]) {
    lathe(band, [[coneR(y0) + 0.004, y0], [coneR(y1) + 0.004, y1]], null);
  }
  return [geoOf(body, true), geoOf(band, false)];
}

// ---- the boards ------------------------------------------------------------------
// One 1024 x 512 canvas, four slots of 256 x 512: the closure board, the A 15
// triangle over the 80, the same over the 60, and the arrow trailer's dark
// board (its lamps are geometry, they flash). Transparent round the shapes:
// the material cuts them out (alphaTest).
const SLOT = { closure: 0, works80: 1, works60: 2, arrow: 3 };
const FACE = { closure: [1.3, 2.6, 0.8], works80: [1.05, 2.1, 1.0], works60: [1.05, 2.1, 1.0] };   // w, h, bottom (m)
function slotUV(k) { return [k / 4 + 0.002, 0.002, (k + 1) / 4 - 0.002, 0.998]; }
function paintBoards(cv) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const YEL = '#f6c400', RED = '#d0101c', BLK = '#141414';
  // the closure board (IP 22 style, temporary: yellow): two lanes, the left
  // one ending in a bend into the right, the right one straight on
  let x = 0;
  g.fillStyle = BLK; g.fillRect(x + 6, 6, 244, 500);
  g.fillStyle = YEL; g.fillRect(x + 14, 14, 228, 484);
  g.strokeStyle = BLK; g.lineWidth = 22; g.lineCap = 'butt';
  g.beginPath(); g.moveTo(x + 168, 470); g.lineTo(x + 168, 120); g.stroke();
  g.beginPath(); g.moveTo(x + 88, 470); g.lineTo(x + 88, 300); g.quadraticCurveTo(x + 88, 230, x + 150, 190); g.stroke();
  g.fillStyle = BLK;
  g.beginPath(); g.moveTo(x + 168, 60); g.lineTo(x + 206, 122); g.lineTo(x + 130, 122); g.fill();
  g.fillStyle = RED; g.fillRect(x + 62, 236, 52, 14);    // the left lane's end bar
  // the A 15 "práce" triangle (yellow, temporary) over a round limit
  const works = (x0, n) => {
    g.fillStyle = RED;
    g.beginPath(); g.moveTo(x0 + 128, 10); g.lineTo(x0 + 250, 222); g.lineTo(x0 + 6, 222); g.closePath(); g.fill();
    g.fillStyle = YEL;
    g.beginPath(); g.moveTo(x0 + 128, 44); g.lineTo(x0 + 220, 204); g.lineTo(x0 + 36, 204); g.closePath(); g.fill();
    // the worker with his shovel and the heap
    g.fillStyle = BLK;
    g.beginPath(); g.arc(x0 + 118, 104, 12, 0, Math.PI * 2); g.fill();
    g.lineWidth = 11; g.strokeStyle = BLK; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0 + 114, 122); g.lineTo(x0 + 106, 160); g.lineTo(x0 + 92, 190); g.moveTo(x0 + 106, 160); g.lineTo(x0 + 124, 190); g.stroke();
    g.beginPath(); g.moveTo(x0 + 112, 132); g.lineTo(x0 + 146, 150); g.lineTo(x0 + 160, 186); g.stroke();
    g.beginPath(); g.moveTo(x0 + 150, 196); g.quadraticCurveTo(x0 + 176, 160, x0 + 200, 196); g.fill();
    // B 20a, temporary: red ring on yellow, black digits
    g.fillStyle = RED; g.beginPath(); g.arc(x0 + 128, 372, 120, 0, Math.PI * 2); g.fill();
    g.fillStyle = YEL; g.beginPath(); g.arc(x0 + 128, 372, 94, 0, Math.PI * 2); g.fill();
    g.fillStyle = BLK; g.font = 'bold 118px Arial, Helvetica, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), x0 + 128, 380);
  };
  works(256, 80); works(512, 60);
  // the arrow trailer's board: black, unlit dots of the arrow
  x = 768;
  g.fillStyle = BLK; g.fillRect(x, 0, 256, 512);
  g.fillStyle = '#3a3220';
  // (the board's uv is this slot's middle half: 252 px for its 2.2 m, 256 px for its 1.5 m)
  for (const [u, v] of ARROW) { g.beginPath(); g.arc(x + 128 + u * 252 / BOARD_W, 256 - v * 256 / BOARD_H, 6, 0, Math.PI * 2); g.fill(); }
}
// the lamps of the arrow, in board metres from its centre (+u right, +v up):
// a shaft and a head pointing right, the way the closed lane's traffic goes
const ARROW = [];
for (let u = -0.85; u <= 0.62; u += 0.105) ARROW.push([u, 0]);
for (let k = 1; k <= 5; k++) { const t = k * 0.1; ARROW.push([0.72 - t * 0.85, t * 0.9], [0.72 - t * 0.85, -t * 0.9]); }
ARROW.push([0.74, 0]);
const BOARD_W = 2.2, BOARD_H = 1.5, BOARD_Y = 1.55;   // the trailer's board, m

// ---- height ----------------------------------------------------------------------
const _q = { x: 0, z: 0 };
function nearestOnWay(r, x, z) {
  let best = Infinity, along = 0, acc = 0;
  for (let i = 0; i < r.p.length - 1; i++) {
    const ax = r.p[i][0], az = r.p[i][1], ex = r.p[i + 1][0] - ax, ez = r.p[i + 1][1] - az;
    const L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
    let t = ((x - ax) * ex + (z - az) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - ax - ex * t, dz = z - az - ez * t, d = dx * dx + dz * dz;
    if (d < best) { best = d; along = acc + L * t; }
    acc += L;
  }
  _q.x = Math.sqrt(best); _q.z = along;
  return _q;
}
/** The carriageway surface at its centreline point (x, z), or null while its chunk is not in. */
export function carriagewayY(world, x, z) {
  const cell = world?.city?.chunkIndex?.get(chunkKey(x, z));
  if (!cell || !cell.roads) return null;
  let best = null, bd = 3, bl = 0;
  for (const r of cell.roads) {
    if (r.t !== 'motorway' || !r.p || r.p.length < 2) continue;
    const q = nearestOnWay(r, x, z);
    if (q.x < bd) { bd = q.x; best = r; bl = q.z; }
  }
  if (!best) return null;
  const ter = world.terrain;
  const y = best.br ? bridgeDeckHeight(best, bl, ter) : (roadGradeY(best, bl, ter) ?? ter.heightAt(x, z));
  return y + LAYER_Y.road;
}

// ---- the system ------------------------------------------------------------------
export class RoadWorks {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this._t = 0; this._sig = ''; this._near = [];
    this._built = false;
  }

  _init() {
    const [cb, cw] = coneGeometries();
    this.coneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 });
    this.bandMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2, emissive: 0xffffff, emissiveIntensity: 0 });
    this.cones = new THREE.InstancedMesh(cb, this.coneMat, CONE_CAP);
    this.bands = new THREE.InstancedMesh(cw, this.bandMat, CONE_CAP);
    for (const m of [this.cones, this.bands]) {
      m.count = 0; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
      m.name = 'roadworks';
      this.scene.add(m);
    }
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    paintBoards(cv);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    this.faceMat = new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff,
      emissiveIntensity: 0, alphaTest: 0.5, side: THREE.FrontSide });
    this.solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffa21a });
    this.faces = this.solids = this.lamps = null;
    this._built = true;
  }

  /** Once a frame: T shared seconds, nightK 0..1 (sky.js), the player's position. */
  update(dt, T, nightK, px, pz) {
    this._t -= dt;
    if (this._t <= 0) {
      this._t = CHECK_DT;
      this._look(T, px, pz);
    }
    if (!this._built) return;
    // retroreflective: the darker it is, the more of their paint comes back
    // (the same curve js/mwatlas.js gives the motorway's own signs)
    let on = (nightK - 0.15) / 0.5;
    on = on < 0 ? 0 : on > 1 ? 1 : on;
    this.faceMat.emissiveIntensity = 0.16 * on;
    this.bandMat.emissiveIntensity = 0.3 * on;
    // the arrow flashes about once a second, on the shared clock (one phase for
    // every trailer on every screen); brighter than its board by night
    if (this.lamps) {
      const lit = (T * 1.1) % 1 < 0.55;
      this.lamps.visible = lit;
      const k = 1.1 + 2.4 * nightK;
      this.lampMat.color.setRGB(k, k * 0.55, k * 0.08);
    }
  }

  _look(T, px, pz) {
    const near = [];
    for (const z of zonesAt(T)) if (zoneNear(z, px, pz, NEAR)) near.push(z);
    let sig = '', n = 0;
    for (const z of near) {
      const p = worksPlan(z);
      n += this._stand(p);
      sig += z.cw + z.a.toFixed(3) + ':';
    }
    sig += n;
    if (sig === this._sig) return;
    this._sig = sig; this._near = near;
    if (!this._built) { if (!near.length) return; this._init(); }
    this._rebuild(near);
  }

  // read the height of every item of plan p that has none yet; how many stand
  _stand(p) {
    let n = 0;
    const one = (it) => {
      if (it.y == null) {
        const y = carriagewayY(this.world, it.cx, it.cz);
        if (y == null) return;
        it.y = y;
      }
      n++;
    };
    for (const it of p.cones) one(it);
    for (const it of p.signs) one(it);
    if (p.trailer) one(p.trailer);
    return n;
  }

  _rebuild(near) {
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), P = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    let c = 0;
    const faces = sink(), solids = sink(), lamps = sink();
    for (const z of near) {
      const p = worksPlan(z);
      for (const it of p.cones) {
        if (it.y == null || c >= CONE_CAP) continue;
        Q.setFromAxisAngle(UP, Math.atan2(-it.hx, -it.hz));
        M.compose(P.set(it.x, it.y, it.z), Q, S);
        this.cones.setMatrixAt(c, M); this.bands.setMatrixAt(c, M);
        c++;
      }
      for (const it of p.signs) if (it.y != null) board(faces, solids, it);
      if (p.trailer && p.trailer.y != null) trailer(faces, solids, lamps, p.trailer);
    }
    this.cones.count = this.bands.count = c;
    // (an instanced mesh with no instances is still a draw call each frame)
    this.cones.visible = this.bands.visible = c > 0;
    this.cones.instanceMatrix.needsUpdate = this.bands.instanceMatrix.needsUpdate = true;
    this.faces = swap(this.scene, this.faces, faces.p.length ? geoOf(faces, false, true) : null, this.faceMat);
    this.solids = swap(this.scene, this.solids, solids.p.length ? geoOf(solids, true) : null, this.solidMat);
    this.lamps = swap(this.scene, this.lamps, lamps.p.length ? geoOf(lamps) : null, this.lampMat);
  }

  /** What is drawn now (for tests and the dev console). */
  stats() {
    return { zones: this._near.length, cones: this.cones?.count ?? 0,
      faceTris: (this.faces?.geometry.attributes.position.count ?? 0) / 3 };
  }
}

function swap(scene, old, geo, mat) {
  if (old) { scene.remove(old); old.geometry.dispose(); }
  if (!geo) return null;
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false; m.receiveShadow = false; m.name = 'roadworks';
  scene.add(m);
  return m;
}

// A board on its two posts, face to the oncoming traffic; a grey back.
function board(faces, solids, it) {
  const [w, h, b] = FACE[it.face];
  const f = [it.hx, 0, it.hz], r = [-it.hz, 0, it.hx], nb = [-it.hx, 0, -it.hz];
  const y = it.y;
  // (the face a few mm in front of its back, the back facing down the road)
  const ox = it.x - r[0] * w / 2 - f[0] * 0.03, oz = it.z - r[2] * w / 2 - f[2] * 0.03;
  quad(faces, [ox, y + b, oz], [r[0] * w, 0, r[2] * w], [0, h, 0], nb, null, slotUV(SLOT[it.face]));
  const bx = it.x + r[0] * w / 2, bz = it.z + r[2] * w / 2;
  quad(solids, [bx, y + b, bz], [-r[0] * w, 0, -r[2] * w], [0, h, 0], f, 0x8c8f92);
  for (const s of [-1, 1]) {
    const u = s * (w / 2 - 0.12);
    box(solids, it.x + r[0] * u + f[0] * 0.04, y - 0.6, it.z + r[2] * u + f[2] * 0.04, f, r, 0.07, b + h * 0.9 + 0.6, 0.07, 0x9a9da0);
    // the portable foot: a red-and-white ballast block (TP 66 temporary stand)
    box(solids, it.x + r[0] * u, y - 0.05, it.z + r[2] * u, f, r, 0.35, 0.16, 0.8, s < 0 ? 0xc81e1e : 0xe8e8e8);
  }
}

// The arrow trailer: a yellow box on two wheels, its black board raised.
function trailer(faces, solids, lamps, it) {
  const f = [it.hx, 0, it.hz], r = [-it.hz, 0, it.hx], nb = [-it.hx, 0, -it.hz];
  const y = it.y;
  box(solids, it.x, y + 0.32, it.z, f, r, 2.3, 0.9, 1.7, 0xf2b705);
  // its red-and-white rear markings, to the oncoming traffic
  for (let k = 0; k < 4; k++) {
    const u = -1.1 + k * 0.575;
    quad(solids, [it.x + r[0] * u - f[0] * 0.856, y + 0.4, it.z + r[2] * u - f[2] * 0.856],
      [r[0] * 0.5, 0, r[2] * 0.5], [0, 0.28, 0], nb, k % 2 ? 0xe8e8e8 : 0xc81e1e);
  }
  for (const s of [-1, 1]) box(solids, it.x + r[0] * s * 1.0, y, it.z + r[2] * s * 1.0, f, r, 0.25, 0.62, 0.62, 0x1a1a1a);
  // the board on its mast
  box(solids, it.x, y + 1.2, it.z, f, r, 0.14, BOARD_Y - 1.2, 0.14, 0x2a2a2a);
  box(solids, it.x + f[0] * 0.05, y + BOARD_Y - 0.06, it.z + f[2] * 0.05, f, r, BOARD_W + 0.12, BOARD_H + 0.12, 0.1, 0xf2b705);
  const ox = it.x - r[0] * BOARD_W / 2 - f[0] * 0.012, oz = it.z - r[2] * BOARD_W / 2 - f[2] * 0.012;
  quad(faces, [ox, y + BOARD_Y, oz], [r[0] * BOARD_W, 0, r[2] * BOARD_W], [0, BOARD_H, 0], nb, null, [0.752, 0.25, 0.998, 0.75]);
  // the lamps: little squares a hair in front of the board
  const cy = y + BOARD_Y + BOARD_H / 2, d = 0.045;
  for (const [u, v] of ARROW) {
    const x0 = it.x + r[0] * (u - d) - f[0] * 0.02, z0 = it.z + r[2] * (u - d) - f[2] * 0.02;
    quad(lamps, [x0, cy + v - d, z0], [r[0] * 2 * d, 0, r[2] * 2 * d], [0, 2 * d, 0], nb);
  }
}
