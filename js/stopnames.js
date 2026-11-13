// ---- stopnames.js: the name of the stop, on its pole -----------------------------
// The mesher gives every bus stop its označník (js/meshes.js busStopInto): a
// post, the blue plate, the timetable case. What it cannot give it is the NAME:
// that is text, there are twenty thousand stops, and chunk geometry is built in
// a worker that has no canvas. So the names are a handful of real plates this
// module owns: the few stops nearest the player (the only ones whose name can
// be read anyway) each get one, hung under the blue plate and facing both ways
// along the street like it, and a plate moves on to another pole when its stop
// falls behind. A dozen little canvases for the whole world.

import * as THREE from 'three';

const PLATES = 8;
const REACH = 70;             // m: the stops this near wear their name
const GRID = 128;
const SCAN_DT = 0.6;
const W = 0.96, H = 0.2;      // m: the plate
const Y = 2.07;               // m over the pavement: just under the blue plate (2.22 to 2.94)
const TEX_W = 384, TEX_H = 80;

function paint(cv, name) {
  const g = cv.getContext('2d');
  g.fillStyle = '#f2f2ee';
  g.fillRect(0, 0, TEX_W, TEX_H);
  g.strokeStyle = '#1a1c20'; g.lineWidth = 4;
  g.strokeRect(2, 2, TEX_W - 4, TEX_H - 4);
  g.fillStyle = '#15171a';
  g.textBaseline = 'middle';
  g.font = 'bold 46px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  let text = name, k = 1;
  const room = TEX_W - 28;
  let w = g.measureText(text).width;
  if (w > room) k = room / w;
  if (k < 0.55) {
    while (text.length > 3 && g.measureText(text + '…').width * 0.55 > room) text = text.slice(0, -1);
    text = text.trimEnd() + '…'; k = 0.55;
    w = g.measureText(text).width;
  }
  g.save();
  g.translate((TEX_W - w * k) / 2, TEX_H / 2 + 3);
  g.scale(k, 1);
  g.fillText(text, 0, 0);
  g.restore();
}

/**
 * The direction of the street a stop serves: the nearest segment of the
 * nearest road, as busStopInto finds it. `edges` is anything near (traffic
 * graph edges, each { pts }). Writes out = { dx, dz } and returns it.
 */
export function streetDir(x, z, edges, out) {
  let best = 30 * 30;
  out.dx = 0; out.dz = -1;
  for (const e of edges) {
    const p = e.pts;
    if (!p) continue;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], ex = p[i + 1][0] - ax, ez = p[i + 1][1] - az;
      const L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d2 = (x - ax - ex * t) ** 2 + (z - az - ez * t) ** 2;
      if (d2 < best) { best = d2; const L = Math.sqrt(L2); out.dx = ex / L; out.dz = ez / L; }
    }
  }
  return out;
}

export class StopNames {
  /**
   * scene     where the plates go
   * city      for city.pois and onTileLoaded
   * nearEdges (x, z) => the road edges round a point
   * standY    (x, z) => the height a pole stands at (the pavement)
   */
  constructor({ scene, city, nearEdges, standY }) {
    this.scene = scene; this.city = city;
    this.nearEdges = nearEdges; this.standY = standY;
    this._grid = new Map();       // coarse cell -> [poi, ...]
    this._seen = 0;               // how many of city.pois are in the grid
    this._plates = [];            // { mesh, cv, tex, stop }
    this._byStop = new Map();     // poi -> plate
    this._t = 0;
    this._near = [];
  }

  // city.pois only ever grows: file what has arrived since the last look
  _index() {
    const pois = this.city.pois ?? [];
    for (; this._seen < pois.length; this._seen++) {
      const poi = pois[this._seen];
      if (poi.t !== 'bus_stop' || !poi.p || !poi.n) continue;
      const k = Math.floor(poi.p[0] / GRID) + ',' + Math.floor(poi.p[1] / GRID);
      let a = this._grid.get(k);
      if (!a) this._grid.set(k, a = []);
      a.push(poi);
    }
  }

  _plate() {
    for (const p of this._plates) if (!p.stop) return p;
    if (this._plates.length >= PLATES) return null;
    const cv = document.createElement('canvas');
    cv.width = TEX_W; cv.height = TEX_H;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // one plate read from both sides: two quads back to back, a hand apart
    // (the post is between them), each with its text the right way round
    const a = new THREE.PlaneGeometry(W, H), b = new THREE.PlaneGeometry(W, H);
    a.translate(0, 0, 0.05);
    b.rotateY(Math.PI); b.translate(0, 0, -0.05);
    const geo = new THREE.BufferGeometry();
    for (const n of ['position', 'normal', 'uv']) {
      const A = a.attributes[n], B = b.attributes[n];
      const arr = new Float32Array(A.array.length + B.array.length);
      arr.set(A.array); arr.set(B.array, A.array.length);
      geo.setAttribute(n, new THREE.BufferAttribute(arr, A.itemSize));
    }
    const ia = a.index.array, idx = [];
    for (let i = 0; i < ia.length; i++) idx.push(ia[i]);
    for (let i = 0; i < ia.length; i++) idx.push(ia[i] + 4);
    geo.setIndex(idx);
    const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0x3a3a38, emissiveMap: tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    const p = { mesh, cv, tex, stop: null };
    this._plates.push(p);
    return p;
  }

  update(dt, pos) {
    this._t -= dt;
    if (this._t > 0 || !pos) return;
    this._t = SCAN_DT;
    this._index();
    // the stops within reach, nearest first
    const near = this._near;
    near.length = 0;
    const ci = Math.floor(pos.x / GRID), cj = Math.floor(pos.z / GRID);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = this._grid.get((ci + i) + ',' + (cj + j));
      if (!a) continue;
      for (const poi of a) {
        const d2 = (poi.p[0] - pos.x) ** 2 + (poi.p[1] - pos.z) ** 2;
        if (d2 < REACH * REACH) near.push({ poi, d2 });
      }
    }
    near.sort((p, q) => p.d2 - q.d2);
    if (near.length > PLATES) near.length = PLATES;
    // plates whose stop has fallen out of reach are free again
    for (const p of this._plates) {
      if (p.stop && !near.some((n) => n.poi === p.stop)) {
        this._byStop.delete(p.stop); p.stop = null; p.mesh.visible = false;
      }
    }
    // (a plate hung before the ground under it had loaded is hung again)
    for (const p of this._plates) {
      if (!p.stop) continue;
      const y = (this.standY?.(p.stop.p[0], p.stop.p[1]) ?? 0) + Y;
      if (Math.abs(y - p.mesh.position.y) > 0.03) { p.mesh.position.y = y; p.mesh.updateMatrix(); }
    }
    for (const { poi } of near) {
      if (this._byStop.has(poi)) continue;
      const p = this._plate();
      if (!p) break;
      const x = poi.p[0], z = poi.p[1];
      const d = streetDir(x, z, this.nearEdges(x, z), _dir);
      paint(p.cv, poi.n);
      p.tex.needsUpdate = true;
      // the plate's faces look along the street, as the blue plate's do
      p.mesh.position.set(x, (this.standY?.(x, z) ?? 0) + Y, z);
      p.mesh.rotation.y = Math.atan2(d.dx, d.dz);
      p.mesh.updateMatrix();
      p.mesh.visible = true;
      p.stop = poi;
      this._byStop.set(poi, p);
    }
  }
}

const _dir = { dx: 0, dz: -1 };
