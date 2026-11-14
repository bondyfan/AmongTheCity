// ---- tramstops.js: the označník of a tram stop, with its name ---------------------
// Tram stops are not in the tiles as pois (a stop is a point of the route
// file's track, js/tiledata.js routeStops), so the mesher never gives them the
// post it gives a bus stop (js/meshes.js busStopInto), and js/stopnames.js,
// which reads bus_stop pois, never names them. This module is that extra
// source: the tram stops nearest the player each get a post with the tram
// plate on top and the stop's name under it, a dozen pooled posts for the
// whole network, moved on to another stop when theirs falls behind.
//
// Where: on the platform when OSM has one (kind 3, px/pz), else a step to the
// right of the track at the stop (the doors open on the right).

import * as THREE from 'three';
import { pathAtExt } from './tramlines.js';

const POSTS = 12;
const REACH = 140;             // m: the stops this near have their post
const SCAN_DT = 0.7;
const RIGHT = 2.4;             // m right of the rail where no platform is mapped
const TEX = 256, NAME_H = 64;  // the plate canvas: the tram sign square over the name strip
const POST_H = 3.0;

function paint(cv, name) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, TEX, TEX + NAME_H);
  // the PID tram sign: white, a red border, the tram in black, ZASTÁVKA under it
  g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, TEX, TEX);
  g.strokeStyle = '#c4161c'; g.lineWidth = 18; g.strokeRect(9, 9, TEX - 18, TEX - 18);
  g.fillStyle = '#16181b';
  g.fillRect(52, 92, 152, 64);                          // the body
  g.fillStyle = '#f4f4f0';
  for (let x = 62; x < 196; x += 34) g.fillRect(x, 102, 24, 22);   // its windows
  g.fillStyle = '#16181b';
  g.fillRect(70, 160, 26, 14); g.fillRect(160, 160, 26, 14);        // bogies
  g.lineWidth = 6; g.strokeStyle = '#16181b';
  g.beginPath(); g.moveTo(110, 92); g.lineTo(140, 62); g.lineTo(118, 50); g.stroke();   // pantograph
  g.beginPath(); g.moveTo(40, 46); g.lineTo(216, 46); g.stroke();                      // wire
  g.font = 'bold 30px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('ZASTÁVKA', TEX / 2, 206);
  // the name strip
  g.fillStyle = '#f4f4f0'; g.fillRect(0, TEX, TEX, NAME_H);
  g.fillStyle = '#16181b';
  let k = 1, text = name || 'Zastávka';
  g.font = 'bold 40px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  const w = g.measureText(text).width;
  if (w > TEX - 16) k = (TEX - 16) / w;
  g.save(); g.translate(TEX / 2, TEX + NAME_H / 2 + 2); g.scale(k, 1); g.fillText(text, 0, 0); g.restore();
}

// the plate: two quads back to back (read from both ways along the rail), the
// sign square over the name strip, uv split to match the canvas
function plateGeometry() {
  const Wp = 0.62, Hs = 0.62, Hn = 0.62 * NAME_H / TEX;
  const pos = [], uv = [], idx = [];
  const quad = (z, flip) => {
    const b = pos.length / 3;
    const x0 = flip ? Wp / 2 : -Wp / 2, x1 = -x0;
    pos.push(x0, -Hn, z, x1, -Hn, z, x1, Hs, z, x0, Hs, z);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  quad(0.03, false); quad(-0.03, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class TramStops {
  /** scene, trams (js/trams.js), standY(x, z) the pavement height */
  constructor({ scene, trams, standY }) {
    this.scene = scene; this.trams = trams; this.standY = standY;
    this._posts = [];
    this._t = 0;
    this._cand = [];
    this._plateGeo = plateGeometry();
    this._poleGeo = new THREE.CylinderGeometry(0.045, 0.05, POST_H, 8);
    this._poleGeo.translate(0, POST_H / 2, 0);
    this._poleMat = new THREE.MeshStandardMaterial({ color: 0x6d7276, roughness: 0.5, metalness: 0.6 });
    this._at = { x: 0, z: 0, dx: 0, dz: 0 };
  }

  _post() {
    for (const p of this._posts) if (!p.key) return p;
    if (this._posts.length >= POSTS) return null;
    const cv = document.createElement('canvas');
    cv.width = TEX; cv.height = TEX + NAME_H;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // the plate is the texture's whole height: sign above, name below
    const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0x2c2c2a, emissiveMap: tex });
    const grp = new THREE.Group();
    const pole = new THREE.Mesh(this._poleGeo, this._poleMat);
    const plate = new THREE.Mesh(this._plateGeo, mat);
    plate.position.y = POST_H - 0.62 + 0.04;
    pole.castShadow = true;
    grp.add(pole, plate);
    grp.visible = false;
    this.scene.add(grp);
    const p = { grp, cv, tex, key: null };
    this._posts.push(p);
    return p;
  }

  update(dt, pos) {
    this._t -= dt;
    if (this._t > 0 || !pos) return;
    this._t = SCAN_DT;
    const cand = this._cand;
    cand.length = 0;
    const R2 = REACH * REACH;
    for (const e of this.trams.routes.values()) {
      const line = e.line;
      if (!line) continue;
      const b = line.bb;
      if (pos.x < b[0] - REACH || pos.x > b[2] + REACH || pos.z < b[1] - REACH || pos.z > b[3] + REACH) continue;
      for (const s of line.stops) {
        let x, z, dx, dz;
        pathAtExt(line.P, s.d, this._at);
        dx = this._at.dx; dz = this._at.dz;
        if (s.k === 3 && Math.hypot(s.px - this._at.x, s.pz - this._at.z) < 12) { x = s.px; z = s.pz; }
        else { x = this._at.x - dz * RIGHT; z = this._at.z + dx * RIGHT; }       // right of travel is (-dz, dx)
        const d2 = (x - pos.x) ** 2 + (z - pos.z) ** 2;
        if (d2 > R2) continue;
        // one post per platform, whichever lines call there
        if (cand.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < 16)) continue;
        cand.push({ x, z, dx, dz, n: s.n, d2, key: Math.round(x * 2) + ',' + Math.round(z * 2) });
      }
    }
    cand.sort((a, b) => a.d2 - b.d2);
    if (cand.length > POSTS) cand.length = POSTS;
    for (const p of this._posts) {
      if (p.key && !cand.some((c) => c.key === p.key)) { p.key = null; p.grp.visible = false; }
    }
    for (const c of cand) {
      if (this._posts.some((p) => p.key === c.key)) continue;
      const p = this._post();
      if (!p) break;
      paint(p.cv, c.n);
      p.tex.needsUpdate = true;
      p.grp.position.set(c.x, this.standY ? this.standY(c.x, c.z) : 0, c.z);
      p.grp.rotation.y = Math.atan2(c.dx, c.dz);        // faces along the rail, both ways
      p.grp.visible = true;
      p.key = c.key;
    }
    // (a post put down before the ground under it loaded is stood up again)
    for (const p of this._posts) {
      if (!p.key || !this.standY) continue;
      const y = this.standY(p.grp.position.x, p.grp.position.z);
      if (Math.abs(y - p.grp.position.y) > 0.03) p.grp.position.y = y;
    }
  }
}
