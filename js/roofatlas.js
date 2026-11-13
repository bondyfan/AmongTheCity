// ---- roofatlas.js: what a roof is covered in, painted once ----
// MAIN THREAD ONLY (it needs a <canvas>). One 1024 x 1024 texture, 4 x 4 cells
// of 256 px, one cell per typology.ROOF_STYLES entry at roofIndex(style). The
// facade material (js/facadeatlas.js) samples it for every roof triangle and
// tiles it in metres, so a cell is ONE period of its pattern: everything drawn
// here wraps left to right and top to bottom.
//
// A cell is painted near white. The shader divides by the cell's mean, so the
// roof's vertex colour IS its colour and the cell only says where the courses,
// seams and stains are. A tint painted here (the brown runs on green copper)
// therefore survives as a tint relative to that colour.
//
// It used to be five cells in row 0 of the facade atlas. That atlas is full
// (57 facade cells and the reserved row), and the tiles now name ten roofings
// (roof:material), so the roofs moved out into a texture of their own.

import * as THREE from 'three';
import { ROOF_STYLES, roofIndex, rnd } from './typology.js';

export const ROOF_GRID = 4, ROOF_CELL = 256, ROOF_PX = ROOF_GRID * ROOF_CELL;
// each cell keeps an 8 px gutter a side; the pattern is periodic over the inner
// square, so the shader can wrap it with fract() and still filter cleanly
export const ROOF_GUT = 8;
const RP = ROOF_CELL - 2 * ROOF_GUT;

const css = (r, g, b, a) => (a === undefined ? `rgb(${r | 0},${g | 0},${b | 0})`
  : `rgba(${r | 0},${g | 0},${b | 0},${a})`);

// One period of one roofing, RP x RP, as its own canvas.
function paint(style, seed) {
  const R = (n) => rnd(seed, n);
  const t = document.createElement('canvas');
  t.width = t.height = RP;
  const c = t.getContext('2d');
  if (!c) return null;
  // drawn nine times, shifted by one period, so everything that crosses an edge
  // comes back in on the other side
  const wrap = (fn) => { for (const ox of [-RP, 0, RP]) for (const oy of [-RP, 0, RP]) { c.save(); c.translate(ox, oy); fn(); c.restore(); } };
  const blotch = (n, a, dark = '40,40,36', light = '255,250,240') => wrap(() => {
    for (let k = 0; k < n; k++) {
      const x = R(k * 5) * RP, y = R(k * 5 + 1) * RP, r = 14 + R(k * 5 + 2) * 46;
      const gr = c.createRadialGradient(x, y, 0, x, y, r);
      const d = R(k * 5 + 3) < 0.5 ? dark : light;
      gr.addColorStop(0, `rgba(${d},${a})`); gr.addColorStop(1, `rgba(${d},0)`);
      c.fillStyle = gr; c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  const grit = (n, a) => {
    for (let k = 0; k < n; k++) {
      c.fillStyle = R(2000 + k) < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a * 0.85})`;
      c.fillRect(R(3000 + k) * RP, R(4000 + k) * RP, 2, 2);
    }
  };
  c.fillStyle = '#d6d2cc'; c.fillRect(0, 0, RP, RP);
  if (style === 'tile' || style === 'slate' || style === 'ctile') {
    // courses: a pantile is 12 to the 4 m and rolled, a concrete tile is flat
    // and a little wider, slate is thin and square
    const rows = style === 'tile' ? 8 : style === 'ctile' ? 10 : 10;
    const cols = style === 'tile' ? 12 : style === 'ctile' ? 12 : 10;
    const th = RP / rows, tw = RP / cols;
    for (let r = 0; r < rows; r++) for (let k = -1; k < cols; k++) {
      const x = k * tw + (r % 2) * tw / 2, y = r * th, j = R(100 + r * 31 + ((k + cols) % cols));
      const v = style === 'ctile' ? 208 + j * 30 : 196 + j * 50;
      c.fillStyle = css(v, v - 4, v - 8); c.fillRect(x, y, tw + 0.5, th + 0.5);
      if (style === 'tile') {                        // the roll of a pantile, and the lap shadow
        c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(x + tw * 0.2, y, tw * 0.3, th);
        c.fillStyle = 'rgba(30,26,22,0.3)'; c.fillRect(x + tw - 2, y, 2, th);
      } else if (style === 'ctile') {                // a flat tile: two shallow flutes, a tight joint
        c.fillStyle = 'rgba(255,255,255,0.1)'; c.fillRect(x + tw * 0.12, y, tw * 0.2, th);
        c.fillStyle = 'rgba(255,255,255,0.1)'; c.fillRect(x + tw * 0.6, y, tw * 0.2, th);
        c.fillStyle = 'rgba(30,28,26,0.34)'; c.fillRect(x + tw - 1, y, 1, th);
      } else { c.fillStyle = 'rgba(30,30,30,0.28)'; c.fillRect(x + tw - 1, y, 1, th); }
    }
    for (let r = 0; r < rows; r++) {
      c.fillStyle = style === 'ctile' ? 'rgba(20,18,16,0.42)' : 'rgba(20,18,16,0.5)';
      c.fillRect(0, r * th + th - (style === 'ctile' ? 3 : 4), RP, style === 'ctile' ? 3 : 4);
      c.fillStyle = 'rgba(255,250,240,0.25)'; c.fillRect(0, r * th, RP, style === 'ctile' ? 1 : 2);
    }
    blotch(10, style === 'ctile' ? 0.12 : 0.16);
  } else if (style === 'bitumen') {
    c.fillStyle = '#cfcdc8'; c.fillRect(0, 0, RP, RP);
    for (let k = 0; k < 6; k++) {                    // sheets a metre wide, lapped and torched
      const x = k * RP / 6;
      c.fillStyle = css(120, 118, 112, 0.1 + R(k) * 0.16); c.fillRect(x, 0, RP / 6, RP);
      c.fillStyle = 'rgba(20,20,20,0.5)'; c.fillRect(x, 0, 2, RP);
      c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(x + 2, 0, 3, RP);
    }
    for (let k = 0; k < 900; k++) { c.fillStyle = R(2000 + k) < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)'; c.fillRect(R(3000 + k) * RP, R(4000 + k) * RP, 2, 2); }
    blotch(9, 0.2);
  } else if (style === 'gravel') {
    for (let k = 0; k < 5200; k++) {
      const v = 150 + R(2000 + k) * 100;
      c.fillStyle = css(v, v - 3, v - 8, 0.8); c.fillRect(R(3000 + k) * RP, R(4000 + k) * RP, 2 + R(k) * 2, 2 + R(k + 9) * 2);
    }
    blotch(8, 0.14);
  } else if (style === 'membrane') {
    // PVC or TPO sheet, two metres wide, hot-air welded: a faint lap every
    // sheet, a row of fixings under it, and where the water stands, dirt
    c.fillStyle = '#dedfdc'; c.fillRect(0, 0, RP, RP);
    for (let k = 0; k < 4; k++) {
      const x = k * RP / 4;
      c.fillStyle = css(150, 152, 150, R(k) * 0.1); c.fillRect(x, 0, RP / 4, RP);
      c.fillStyle = 'rgba(40,42,44,0.3)'; c.fillRect(x, 0, 1, RP);
      c.fillStyle = 'rgba(255,255,255,0.4)'; c.fillRect(x + 1, 0, 3, RP);
      for (let y = 6; y < RP; y += 15) { c.fillStyle = 'rgba(60,62,64,0.22)'; c.fillRect(x + 7, y, 2, 2); }
    }
    grit(260, 0.06);
    blotch(9, 0.17, '70,66,56', '250,250,246');
  } else if (style === 'grass') {
    // sedum: a mat of low plants in every green, rust and straw there is
    c.fillStyle = '#c9cdb8'; c.fillRect(0, 0, RP, RP);
    wrap(() => {
      for (let k = 0; k < 2600; k++) {
        const q = R(5000 + k), v = 150 + R(2000 + k) * 90;
        c.fillStyle = q < 0.6 ? css(v - 30, v + 8, v - 50, 0.7) : q < 0.85 ? css(v + 20, v - 14, v - 50, 0.6)
          : css(v + 26, v + 14, v - 30, 0.6);
        const r = 2 + R(k) * 4;
        c.beginPath(); c.arc(R(3000 + k) * RP, R(4000 + k) * RP, r, 0, 6.2832); c.fill();
      }
    });
    blotch(10, 0.2, '50,60,30', '240,235,190');
  } else if (style === 'glass') {
    // patent glazing: panes 0.8 m wide and 1.6 m up the slope between pale
    // aluminium bars, each pane a little its own sky
    const cols = 6, rows = 3, tw = RP / cols, th = RP / rows;
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
      const v = 150 + R(100 + r * 17 + k) * 40;
      const gr = c.createLinearGradient(0, r * th, 0, r * th + th);
      gr.addColorStop(0, css(v + 26, v + 30, v + 34)); gr.addColorStop(1, css(v - 22, v - 16, v - 8));
      c.fillStyle = gr; c.fillRect(k * tw, r * th, tw + 0.5, th + 0.5);
      // a streak of reflected cloud across one pane in three
      if (R(300 + r * 17 + k) < 0.34) { c.fillStyle = 'rgba(255,255,255,0.2)'; c.fillRect(k * tw + 3, r * th + th * R(400 + k + r), tw - 6, th * 0.18); }
    }
    for (let k = 0; k < cols; k++) {
      c.fillStyle = 'rgba(250,250,250,0.95)'; c.fillRect(k * tw - 1.5, 0, 3, RP);
      c.fillStyle = 'rgba(10,14,18,0.45)'; c.fillRect(k * tw + 1.5, 0, 1.5, RP);
    }
    wrap(() => { c.fillStyle = 'rgba(250,250,250,0.95)'; c.fillRect(-2, 0, 2, RP); });
    for (let r = 0; r < rows; r++) {
      c.fillStyle = 'rgba(245,245,245,0.9)'; c.fillRect(0, r * th, RP, 2);
      c.fillStyle = 'rgba(10,14,18,0.4)'; c.fillRect(0, r * th + 2, RP, 1.5);
    }
  } else {
    // standing seam sheet. Copper is the same trade with a wider tray, and a
    // century of weather: it runs brown and pale down the fall line.
    const copper = style === 'copper', n = copper ? 8 : 8;
    c.fillStyle = copper ? '#d6dbd6' : '#d8dadb'; c.fillRect(0, 0, RP, RP);
    for (let k = 0; k < n; k++) {
      const x = k * RP / n;
      c.fillStyle = css(90, 94, 98, R(k) * (copper ? 0.2 : 0.14)); c.fillRect(x, 0, RP / n, RP);
    }
    if (copper) {
      wrap(() => {
        for (let k = 0; k < 46; k++) {               // the runs
          const x = R(600 + k) * RP, y = R(700 + k) * RP, h = 30 + R(800 + k) * 110, w = 2 + R(900 + k) * 7;
          const gr = c.createLinearGradient(0, y, 0, y + h);
          const d = R(1000 + k) < 0.55 ? '96,74,52' : '236,246,238';
          gr.addColorStop(0, `rgba(${d},0)`); gr.addColorStop(0.3, `rgba(${d},0.3)`); gr.addColorStop(1, `rgba(${d},0)`);
          c.fillStyle = gr; c.fillRect(x, y, w, h);
        }
      });
      // the cross welts of the trays, staggered from one tray to the next
      for (let k = 0; k < n; k++) {
        const y = ((k % 2) * 0.5 + 0.2) * RP;
        c.fillStyle = 'rgba(30,40,36,0.4)'; c.fillRect(k * RP / n, y, RP / n, 2);
        c.fillStyle = 'rgba(255,255,255,0.3)'; c.fillRect(k * RP / n, y - 2, RP / n, 2);
      }
    }
    for (let k = 0; k < n; k++) {
      const x = k * RP / n;
      c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(x, 0, 2, RP);
      c.fillStyle = 'rgba(20,22,26,0.5)'; c.fillRect(x + 2, 0, 2, RP);
    }
    blotch(6, copper ? 0.16 : 0.1, copper ? '80,70,50' : '40,40,36');
  }
  return t;
}

const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };

let _roof = null;
/**
 * roofAtlas() -> { tex, avg, metres }
 * tex: the texture. avg[i]: cell i's mean in linear light (the shader divides
 * by it). metres[i]: metres per repeat. Both arrays are 16 long, indexed by
 * typology.roofIndex. Without a 2D context (a test, memory pressure) the
 * texture is one white texel and every roof is simply its own colour.
 */
export function roofAtlas() {
  if (_roof) return _roof;
  const N = ROOF_GRID * ROOF_GRID;
  const avg = new Array(N).fill(1), metres = new Array(N).fill(1);
  for (const [style, S] of Object.entries(ROOF_STYLES)) metres[roofIndex(style)] = S.m;
  const plain = () => {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
    return (_roof = { tex: t, avg, metres });
  };
  const cv = document.createElement('canvas');
  cv.width = cv.height = ROOF_PX;
  const g = cv.getContext?.('2d', { willReadFrequently: true });
  if (!g) return plain();
  g.fillStyle = '#d6d2cc'; g.fillRect(0, 0, ROOF_PX, ROOF_PX);
  for (const style of Object.keys(ROOF_STYLES)) {
    const i = roofIndex(style), X = (i % ROOF_GRID) * ROOF_CELL, Y = ((i / ROOF_GRID) | 0) * ROOF_CELL;
    // the seeds of the five original styles are the ones their cells had in
    // the facade atlas (31 + column), so those roofs did not change face
    const t = paint(style, 31 + ROOF_STYLES[style].col + 10 * (ROOF_STYLES[style].row ?? 0));
    if (!t) return plain();
    g.save(); g.beginPath(); g.rect(X, Y, ROOF_CELL, ROOF_CELL); g.clip();
    for (let ix = -1; ix <= 1; ix++) for (let iy = -1; iy <= 1; iy++)
      g.drawImage(t, X + ROOF_GUT + ix * RP, Y + ROOF_GUT + iy * RP);
    g.restore();
  }
  let src = null;
  try { src = g.getImageData(0, 0, ROOF_PX, ROOF_PX).data; } catch { /* lost canvas: plain roofs */ }
  if (!src || src.length < ROOF_PX * ROOF_PX * 4) return plain();
  // flip the rows (a canvas is y-down, uv is y-up): up the canvas is up the slope
  const out = new Uint8Array(ROOF_PX * ROOF_PX * 4), rowB = ROOF_PX * 4;
  for (let y = 0; y < ROOF_PX; y++)
    out.set(src.subarray(y * rowB, (y + 1) * rowB), (ROOF_PX - 1 - y) * rowB);
  for (const style of Object.keys(ROOF_STYLES)) {
    const i = roofIndex(style), X = (i % ROOF_GRID) * ROOF_CELL, Y = ((i / ROOF_GRID) | 0) * ROOF_CELL;
    let sum = 0, n = 0;
    for (let y = ROOF_GUT; y < ROOF_CELL - ROOF_GUT; y += 3) for (let x = ROOF_GUT; x < ROOF_CELL - ROOF_GUT; x += 3) {
      const o = ((Y + y) * ROOF_PX + X + x) * 4;
      sum += (lin(src[o]) + lin(src[o + 1]) + lin(src[o + 2])) / 3; n++;
    }
    avg[i] = sum / n;
  }
  const t = new THREE.DataTexture(out, ROOF_PX, ROOF_PX, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return (_roof = { tex: t, avg, metres });
}
