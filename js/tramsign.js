// ---- tramsign.js: the destination displays of the trams --------------------------
// Every tram says its line and its terminus on the front, the number and the
// terminus on the door side, the number alone on the tail: amber diodes on
// black, the look js/destsign.js gives the buses. Trams are instanced
// (js/trams.js), so the displays are too: ONE InstancedMesh of unit quads for
// every display of every tram, reading one canvas ATLAS in which each line in
// sight has a row. Per instance an attribute says which row and how much of
// it (the tail shows only the number at the left of the row).
//
// Lit, so unlit (MeshBasicMaterial), and turned down after dark as the game's
// exposure opens up (js/sky.js), as destsign.js does.

import * as THREE from 'three';
import { signText } from './destsign.js';

const TEX_W = 512, ROW_H = 64, ROWS = 64, NUM_W = 122;
const AMBER = '#ffb028';
const DAY_K = 1.25, NIGHT_K = 0.62;
export const SIGN_NUM_U = NUM_W / TEX_W;

export class TramSigns {
  constructor(max = 512) {
    this.max = max;
    this.canvas = document.createElement('canvas');
    this.canvas.width = TEX_W; this.canvas.height = ROW_H * ROWS;
    this.g = this.canvas.getContext('2d');
    this.g.fillStyle = '#050505';
    this.g.fillRect(0, 0, TEX_W, ROW_H * ROWS);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this._rows = new Map();          // line id -> { row, used }
    this._free = [];
    for (let i = ROWS - 1; i >= 0; i--) this._free.push(i);
    this._tick = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.aSign = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.aSign.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSign', this.aSign);
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute vec2 aSign;\n' + sh.vertexShader.replace('#include <uv_vertex>',
        `#include <uv_vertex>
        vMapUv = vec2(uv.x * aSign.y, 1.0 - (aSign.x + 1.0 - uv.y) / ${ROWS}.0);`);
    };
    mat.customProgramCacheKey = () => 'tramsign';
    mat.color.setScalar(DAY_K);
    this.mat = mat;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;      // instances are everywhere; the bounding sphere is of one quad
    this.mesh.name = 'tramsigns';
    this.n = 0;
  }

  // the atlas row of a line, drawn when it is first wanted
  rowOf(line) {
    let r = this._rows.get(line.id);
    if (!r) {
      let row = this._free.pop();
      if (row === undefined) {
        // reuse the row of the line seen longest ago
        let old = null, ok = null;
        for (const [k, v] of this._rows) if (!old || v.used < old.used) { old = v; ok = k; }
        row = old.row; this._rows.delete(ok);
      }
      r = { row, used: 0 };
      this._rows.set(line.id, r);
      this._draw(row, line);
    }
    r.used = this._tick;
    return r.row;
  }

  _draw(row, line) {
    const g = this.g, y0 = row * ROW_H;
    const [ref, dest] = signText(line);
    g.fillStyle = '#050505';
    g.fillRect(0, y0, TEX_W, ROW_H);
    g.fillStyle = AMBER;
    g.textBaseline = 'middle';
    const fit = (text, x0, x1, px, align) => {
      g.font = `bold ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
      const w = g.measureText(text).width, room = x1 - x0;
      let k = w > room ? room / w : 1;
      if (k < 0.6) {
        let t = text;
        while (t.length > 3 && g.measureText(t + '…').width * 0.6 > room) t = t.slice(0, -1);
        text = t.trimEnd() + '…'; k = 0.6;
      }
      const tw = g.measureText(text).width * k;
      const x = align === 'center' ? (x0 + x1 - tw) / 2 : x0;
      g.save();
      g.translate(x, y0 + ROW_H / 2 + 2);
      g.scale(k, 1);
      g.fillText(text, 0, 0);
      g.restore();
    };
    fit(ref, 8, NUM_W - 8, 52, 'center');
    fit(dest, NUM_W + 10, TEX_W - 8, 40, 'left');
    g.fillStyle = 'rgba(0,0,0,0.42)';
    for (let x = 0; x < TEX_W; x += 4) g.fillRect(x, y0, 1, ROW_H);
    for (let y = y0; y < y0 + ROW_H; y += 4) g.fillRect(0, y, TEX_W, 1);
    this.tex.needsUpdate = true;
  }

  begin() { this._tick++; this.n = 0; }

  /** One display: world matrix `m` (a Matrix4 of the unit quad), atlas row, the share of the row shown. */
  push(m, row, uMax) {
    if (this.n >= this.max) return;
    const i = this.n++;
    m.toArray(this.mesh.instanceMatrix.array, i * 16);
    this.aSign.array[i * 2] = row;
    this.aSign.array[i * 2 + 1] = uMax;
  }

  end(nightK) {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aSign.needsUpdate = true;
    const k = DAY_K + (NIGHT_K - DAY_K) * (nightK < 0 ? 0 : nightK > 1 ? 1 : nightK);
    if (Math.abs(k - this.mat.color.r) > 0.004) this.mat.color.setScalar(k);
  }
}
