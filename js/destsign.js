// ---- destsign.js: the destination displays of a bus ----------------------------
// Every bus and trolleybus says where it is going: the line number and the
// terminus in amber on black, on the front, on the kerb side and (the number
// alone) on the tail. The housings are part of the body (js/cardetail.js);
// the lit faces are three small planes this module hangs on the car's body
// group, sharing ONE texture and ONE material per line, so thirty buses of
// eleven lines cost eleven little canvases.
//
// The left of the texture is the number, the rest the terminus; the tail
// display shows the left part only, by its texture coordinates.
//
// LIT AT NIGHT: the material is unlit (a display is a light), and the game's
// exposure opens up nearly three times after dark (js/sky.js), so its
// brightness is turned down as the night comes on. What is left reads as a
// glowing display instead of a white bar.

import * as THREE from 'three';
import { TRANSIT_BODY } from './transitbody.js';

const TEX_W = 512, TEX_H = 64, NUM_W = 122;
const CACHE_MAX = 40;
const AMBER = '#ffb028';
const DAY_K = 1.25, NIGHT_K = 0.62;

/**
 * What the display says for a line: [number, terminus]. A regional line's
 * six-digit number (650606) is shown as the three the timetable book uses.
 */
export function signText(line) {
  let ref = String(line?.ref ?? '').trim();
  if (/^\d{6}$/.test(ref)) ref = ref.slice(3);
  if (ref.length > 4) ref = ref.slice(0, 4);
  return [ref, String(line?.dest ?? '').trim()];
}

function draw(ref, dest) {
  const cv = document.createElement('canvas');
  cv.width = TEX_W; cv.height = TEX_H;
  const g = cv.getContext('2d');
  g.fillStyle = '#050505';
  g.fillRect(0, 0, TEX_W, TEX_H);
  g.fillStyle = AMBER;
  g.textBaseline = 'middle';
  const fit = (text, x0, x1, px, align) => {
    g.font = `bold ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
    const w = g.measureText(text).width, room = x1 - x0;
    // squeeze a long name as a real display does (a narrower font), and past
    // that cut it: half a name too small to read helps nobody
    let k = w > room ? room / w : 1;
    if (k < 0.6) {
      let t = text;
      while (t.length > 3 && g.measureText(t + '…').width * 0.6 > room) t = t.slice(0, -1);
      text = t.trimEnd() + '…'; k = 0.6;
    }
    const tw = g.measureText(text).width * k;
    const x = align === 'center' ? (x0 + x1 - tw) / 2 : x0;
    g.save();
    g.translate(x, TEX_H / 2 + 2);
    g.scale(k, 1);
    g.fillText(text, 0, 0);
    g.restore();
  };
  fit(ref, 8, NUM_W - 8, 52, 'center');
  fit(dest, NUM_W + 10, TEX_W - 8, 42, 'left');
  // the gaps between the diodes: without them it is print, not a display
  g.fillStyle = 'rgba(0,0,0,0.42)';
  for (let x = 0; x < TEX_W; x += 4) g.fillRect(x, 0, 1, TEX_H);
  for (let y = 0; y < TEX_H; y += 4) g.fillRect(0, y, TEX_W, 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class DestSigns {
  constructor() {
    this._mats = new Map();       // "ref|dest" -> { mat, tex, used }
    this._geo = new Map();        // kind -> { front, side, rear }
    this._k = DAY_K;
    this._tick = 0;
  }

  _material(line) {
    const [ref, dest] = signText(line), key = ref + '|' + dest;
    let m = this._mats.get(key);
    if (!m) {
      if (this._mats.size >= CACHE_MAX) this._evict();
      const tex = draw(ref, dest);
      // the body's own trim is laddered forward with polygonOffset (js/carpaint.js,
      // down to -5 for a number plate); a display 2 cm proud of its housing
      // was behind it in depth, so it joins the ladder one rung further out
      const mat = new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      mat.color.setScalar(this._k);
      this._mats.set(key, m = { mat, tex, used: 0 });
    }
    m.used = this._tick;
    return m;
  }

  // drop the display that has gone longest without a bus wearing it
  _evict() {
    let old = null, ok = null;
    for (const [k, m] of this._mats) if (!old || m.used < old.used) { old = m; ok = k; }
    if (!old || this._tick - old.used < 600) return;      // all in use: let the cache grow
    old.tex.dispose(); old.mat.dispose();
    this._mats.delete(ok);
  }

  _geometry(kind, surface) {
    let g = this._geo.get(kind);
    if (g) return g;
    const B = TRANSIT_BODY[kind].sign;
    const plane = (w, h, u0, u1) => {
      const p = new THREE.PlaneGeometry(w, h);
      const uv = p.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
      return p;
    };
    // PlaneGeometry faces +z. The front display looks along -z (the nose).
    const front = plane(B.front.w, B.front.h, 0, 1);
    front.rotateY(Math.PI);
    front.translate(B.front.x, B.front.y, surface.z0 - B.front.out - 0.004);
    const side = plane(B.side.w, B.side.h, 0, 1);
    side.rotateY(Math.PI / 2);                       // faces +x, the kerb
    side.translate(surface.halfAt(B.side.z, B.side.y) + 0.022, B.side.y, B.side.z);
    const rear = plane(B.rear.w, B.rear.h, 0, NUM_W / TEX_W);
    rear.translate(B.rear.x, B.rear.y, surface.z1 + B.rear.out + 0.004);
    this._geo.set(kind, g = { front, side, rear });
    return g;
  }

  /**
   * Hang the three displays of `line` on a car. `body` is the group that leans
   * with the suspension (mesh.userData.body), `surface` js/vehicles.js
   * bodySurface(kind). Returns the group, to be handed back to `use` each frame.
   */
  attach(body, kind, surface, line) {
    if (!TRANSIT_BODY[kind]) return null;
    const m = this._material(line), g = this._geometry(kind, surface);
    const grp = new THREE.Group();
    grp.name = 'destsign';
    for (const geo of [g.front, g.side, g.rear]) {
      const mesh = new THREE.Mesh(geo, m.mat);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;          // with the car, after the street-light quads (js/vehicles.js)
      grp.add(mesh);
    }
    grp.matrixAutoUpdate = false;
    grp.userData.sign = m;
    body.add(grp);
    return grp;
  }

  /** This display is on a bus that exists this frame: keep its texture. */
  use(grp) { if (grp) grp.userData.sign.used = this._tick; }

  /** Once a frame: how dark it is (0 day, 1 night). */
  update(nightK) {
    this._tick++;
    const k = DAY_K + (NIGHT_K - DAY_K) * (nightK < 0 ? 0 : nightK > 1 ? 1 : nightK);
    if (Math.abs(k - this._k) < 0.004) return;
    this._k = k;
    for (const m of this._mats.values()) m.mat.color.setScalar(k);
  }
}
