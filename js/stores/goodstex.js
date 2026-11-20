// ---- stores/goodstex.js: one sheet of stocked shelves, drawn here ----
// Main thread only (a 2D canvas). Every shelf, fridge and crate of every store
// shows a cell of this one 2048 x 2048 sheet: 8 x 8 cells of 256 pixels, each a
// whole module of shelving seen from the aisle (five boards of packaging with
// their price rails) or a crate seen from above. Nothing is copied from any
// photograph or product: the packs are coloured shapes in the tones a Czech
// shopper knows the departments by, and no pack carries a name.
//
// A fixture instance names its cell by column and row (js/stores/fixtures.js),
// so a 60 m aisle of thirty different-looking modules is one draw call.

import * as THREE from 'three';

export const CELLS = 8;
/** First cell and number of variants of every look: [col, row, count] (cells run along the row, then wrap). */
export const LOOK = {
  dry: [0, 0, 4], drinks: [4, 0, 4], sweets: [0, 1, 3], snacks: [3, 1, 3], beer: [6, 1, 2],
  drug: [0, 2, 3], home: [3, 2, 3], dairy: [6, 2, 2], dairy2: [0, 3, 2], meat: [2, 3, 3], bakery: [5, 3, 3],
  frozen: [0, 4, 3], produce: [3, 4, 5], bins: [0, 5, 3], belt: [3, 5, 1], selfscreen: [4, 5, 1],
  kiosk: [5, 5, 1], menu: [6, 5, 2], wood: [0, 6, 1], steel: [1, 6, 1], counter: [2, 6, 1], white: [7, 7, 1],
};

/** The [col, row] of variant `i` of a look. */
export function cellOf(look, i = 0) {
  const [c, r, n] = LOOK[look] ?? LOOK.white;
  const k = c + (((i % n) + n) % n);
  return [k % CELLS, r + Math.floor(k / CELLS)];
}

// a small deterministic generator: the sheet is the same on every machine
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return ((s ^ (s >>> 13)) >>> 0) / 4294967296; };
}
const hsl = (h, s, l) => `hsl(${h | 0},${s | 0}%,${l | 0}%)`;

// what a department's packaging looks like: hues, and which shapes
const DEPT = {
  dry: { hues: [45, 30, 210, 0, 120], sat: 62, shapes: ['box', 'bag', 'jar'] },
  drinks: { hues: [200, 0, 130, 30, 280], sat: 70, shapes: ['bottle', 'bottle', 'can'] },
  sweets: { hues: [275, 350, 25, 200, 50], sat: 68, shapes: ['bar', 'box', 'bag'] },
  snacks: { hues: [10, 45, 95, 205], sat: 80, shapes: ['bag', 'bag', 'can'] },
  beer: { hues: [35, 100, 20, 45], sat: 55, shapes: ['bottle', 'can', 'crate'] },
  drug: { hues: [190, 300, 215, 150, 0], sat: 45, shapes: ['bottle', 'box', 'roll'] },
  home: { hues: [0, 210, 40, 160, 280], sat: 50, shapes: ['box', 'box', 'roll', 'jar'] },
  dairy: { hues: [205, 50, 0, 120], sat: 40, light: 82, shapes: ['carton', 'cup', 'block'], back: '#eef2f4' },
  dairy2: { hues: [45, 30, 205, 350], sat: 48, light: 76, shapes: ['block', 'cup', 'carton'], back: '#eef2f4' },
  meat: { hues: [355, 5, 15, 340], sat: 55, light: 58, shapes: ['tray', 'tray', 'block'], back: '#f1eeee' },
};

function pack(g, shape, x, y, w, h, hue, sat, light, r) {
  const body = hsl(hue, sat, light), dark = hsl(hue, sat, light * 0.62), lab = hsl((hue + 30 + r() * 300) % 360, 25, 92);
  g.fillStyle = body;
  if (shape === 'bottle') {
    g.fillRect(x + w * 0.12, y + h * 0.3, w * 0.76, h * 0.7);
    g.fillRect(x + w * 0.36, y, w * 0.28, h * 0.34);
    g.fillStyle = dark; g.fillRect(x + w * 0.34, y, w * 0.32, h * 0.07);
    g.fillStyle = lab; g.fillRect(x + w * 0.12, y + h * 0.5, w * 0.76, h * 0.26);
  } else if (shape === 'can') {
    g.fillRect(x + w * 0.1, y + h * 0.18, w * 0.8, h * 0.82);
    g.fillStyle = '#c9ced2'; g.fillRect(x + w * 0.1, y + h * 0.18, w * 0.8, h * 0.07);
    g.fillStyle = lab; g.fillRect(x + w * 0.1, y + h * 0.45, w * 0.8, h * 0.22);
  } else if (shape === 'jar') {
    g.fillRect(x + w * 0.1, y + h * 0.25, w * 0.8, h * 0.75);
    g.fillStyle = dark; g.fillRect(x + w * 0.16, y + h * 0.14, w * 0.68, h * 0.13);
    g.fillStyle = lab; g.fillRect(x + w * 0.1, y + h * 0.5, w * 0.8, h * 0.3);
  } else if (shape === 'bag') {
    g.beginPath(); g.moveTo(x + w * 0.08, y + h); g.lineTo(x + w * 0.16, y + h * 0.08); g.lineTo(x + w * 0.84, y + h * 0.08); g.lineTo(x + w * 0.92, y + h); g.closePath(); g.fill();
    g.fillStyle = lab; g.beginPath(); g.ellipse(x + w / 2, y + h * 0.55, w * 0.26, h * 0.2, 0, 0, 7); g.fill();
  } else if (shape === 'carton') {
    g.fillRect(x + w * 0.1, y + h * 0.16, w * 0.8, h * 0.84);
    g.beginPath(); g.moveTo(x + w * 0.1, y + h * 0.16); g.lineTo(x + w / 2, y); g.lineTo(x + w * 0.9, y + h * 0.16); g.fill();
    g.fillStyle = lab; g.fillRect(x + w * 0.1, y + h * 0.4, w * 0.8, h * 0.3);
  } else if (shape === 'cup') {
    g.beginPath(); g.moveTo(x + w * 0.1, y + h * 0.35); g.lineTo(x + w * 0.9, y + h * 0.35); g.lineTo(x + w * 0.78, y + h); g.lineTo(x + w * 0.22, y + h); g.closePath(); g.fill();
    g.fillStyle = '#f4f4f1'; g.fillRect(x + w * 0.06, y + h * 0.27, w * 0.88, h * 0.1);
  } else if (shape === 'tray') {
    g.fillStyle = '#16181a'; g.fillRect(x + w * 0.04, y + h * 0.3, w * 0.92, h * 0.7);
    g.fillStyle = body; g.fillRect(x + w * 0.1, y + h * 0.38, w * 0.8, h * 0.54);
    g.fillStyle = '#f4f4f1'; g.fillRect(x + w * 0.5, y + h * 0.42, w * 0.36, h * 0.2);
  } else if (shape === 'roll') {
    g.fillStyle = '#f1f1ee'; g.fillRect(x + w * 0.06, y + h * 0.1, w * 0.88, h * 0.9);
    g.fillStyle = body; g.fillRect(x + w * 0.06, y + h * 0.36, w * 0.88, h * 0.3);
  } else if (shape === 'crate') {
    g.fillRect(x + w * 0.02, y + h * 0.3, w * 0.96, h * 0.7);
    g.fillStyle = dark; for (let i = 0; i < 4; i++) g.fillRect(x + w * (0.08 + i * 0.23), y + h * 0.16, w * 0.14, h * 0.2);
  } else if (shape === 'bar') {
    g.fillRect(x + w * 0.04, y + h * 0.45, w * 0.92, h * 0.55);
    g.fillStyle = lab; g.fillRect(x + w * 0.2, y + h * 0.58, w * 0.6, h * 0.26);
  } else if (shape === 'block') {
    g.fillRect(x + w * 0.06, y + h * 0.4, w * 0.88, h * 0.6);
    g.fillStyle = lab; g.fillRect(x + w * 0.5, y + h * 0.5, w * 0.36, h * 0.3);
  } else {
    g.fillRect(x + w * 0.05, y + h * 0.06, w * 0.9, h * 0.94);
    g.fillStyle = lab; g.fillRect(x + w * 0.14, y + h * 0.3, w * 0.72, h * 0.34);
    g.fillStyle = dark; g.fillRect(x + w * 0.05, y + h * 0.06, w * 0.9, h * 0.08);
  }
}

/** A module of shelving seen from the aisle: five boards, stock on each, a price rail under it. */
function shelfCell(g, ox, oy, dept, seed) {
  const r = rng(seed), d = DEPT[dept];
  g.fillStyle = d.back ?? '#5d6166'; g.fillRect(ox, oy, 256, 256);
  const rows = 5, rh = 256 / rows;
  for (let i = 0; i < rows; i++) {
    const y0 = oy + i * rh, railH = 7, stock = rh - railH - 3;
    // one or two products to a board, each a run of the same pack
    let x = 3;
    while (x < 250) {
      const shape = d.shapes[(r() * d.shapes.length) | 0], hue = d.hues[(r() * d.hues.length) | 0] + r() * 16 - 8;
      const w = shape === 'crate' ? 44 : 15 + r() * 14, h = stock * (0.72 + r() * 0.26);
      const n = Math.max(2, Math.round((60 + r() * 80) / w));
      const light = (d.light ?? 50) + r() * 14 - 7;
      for (let k = 0; k < n && x + w < 254; k++, x += w + 1) pack(g, shape, ox + x, y0 + 2 + stock - h, w, h, hue, d.sat, light, r);
      x += 3;
    }
    g.fillStyle = '#f2f2ee'; g.fillRect(ox, y0 + rh - railH - 1, 256, railH);
    for (let k = 6; k < 250; k += 24 + ((r() * 14) | 0)) {
      const promo = r() < 0.16;
      g.fillStyle = promo ? '#ffd400' : '#ffffff'; g.fillRect(ox + k, y0 + rh - railH - 1, 17, railH);
      g.fillStyle = promo ? '#d81e1e' : '#2a2d31'; g.fillRect(ox + k + 3, y0 + rh - railH + 1, 10, 3);
    }
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(ox, y0, 256, 3);
  }
}

function bakeryCell(g, ox, oy, seed) {
  const r = rng(seed);
  g.fillStyle = '#8a643c'; g.fillRect(ox, oy, 256, 256);
  for (let i = 0; i < 4; i++) {
    const y0 = oy + i * 64;
    g.fillStyle = '#6f4e2c'; g.fillRect(ox, y0 + 56, 256, 8);
    g.fillStyle = '#4a3520'; g.fillRect(ox, y0, 256, 4);
    for (let k = 0; k < 4; k++) {
      const x0 = ox + 4 + k * 63;
      g.fillStyle = '#c9a36b'; g.fillRect(x0, y0 + 30, 58, 26);           // the wicker tray
      const kind = (r() * 3) | 0;
      for (let j = 0; j < 7; j++) {
        g.fillStyle = hsl(28 + r() * 10, 58, 38 + r() * 18);
        const bx = x0 + 6 + (j % 4) * 13 + r() * 3, by = y0 + 22 + Math.floor(j / 4) * 12 + r() * 4;
        g.beginPath(); g.ellipse(bx, by + 8, kind === 0 ? 9 : 6.5, kind === 1 ? 6.5 : 5, kind === 2 ? 0.5 : 0, 0, 7); g.fill();
      }
      g.fillStyle = '#fbf8ee'; g.fillRect(x0 + 16, y0 + 46, 26, 8);
    }
  }
}

function topCell(g, ox, oy, kind, seed) {
  const r = rng(seed);
  if (kind === 'frozen') {
    g.fillStyle = '#dfeaf0'; g.fillRect(ox, oy, 256, 256);
    for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) {
      g.fillStyle = hsl([200, 0, 30, 130, 280][(r() * 5) | 0], 60, 48 + r() * 12);
      g.fillRect(ox + 6 + k * 62, oy + 8 + i * 62, 56, 54);
      g.fillStyle = '#f4f4ee'; g.fillRect(ox + 14 + k * 62, oy + 22 + i * 62, 40, 16);
    }
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(ox, oy, 256, 256);
    g.strokeStyle = '#8f9aa2'; g.lineWidth = 6; g.strokeRect(ox + 3, oy + 3, 250, 250);
    return;
  }
  if (kind === 'bins') {
    g.fillStyle = '#b58f5e'; g.fillRect(ox, oy, 256, 256);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = hsl(r() * 360, 55, 45 + r() * 20);
      g.save(); g.translate(ox + 20 + r() * 216, oy + 20 + r() * 216); g.rotate(r() * 3); g.fillRect(-18, -11, 36, 22);
      g.fillStyle = '#f0efe8'; g.fillRect(-10, -4, 20, 8); g.restore();
    }
    g.strokeStyle = '#7a5d38'; g.lineWidth = 10; g.strokeRect(ox + 5, oy + 5, 246, 246);
    return;
  }
  // produce: four crates of one kind each, seen from above
  const FRUIT = [[5, 70, 46], [95, 55, 42], [32, 85, 52], [52, 90, 55], [10, 75, 42], [30, 40, 38], [110, 50, 38], [280, 35, 35]];
  g.fillStyle = '#2b2f2a'; g.fillRect(ox, oy, 256, 256);
  for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) {
    const x0 = ox + 4 + k * 126, y0 = oy + 4 + i * 126, f = FRUIT[(seed + i * 2 + k * 3) % FRUIT.length];
    g.fillStyle = '#1c1f1c'; g.fillRect(x0, y0, 122, 122);
    for (let j = 0; j < 46; j++) {
      const cx = x0 + 12 + r() * 98, cy = y0 + 12 + r() * 98, rad = 9 + r() * 4;
      g.fillStyle = hsl(f[0] + r() * 14 - 7, f[1], f[2] + r() * 12 - 6);
      g.beginPath(); g.ellipse(cx, cy, rad, f[0] === 52 ? rad * 0.45 : rad, r() * 3, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.arc(cx - 3, cy - 3, rad * 0.32, 0, 7); g.fill();
    }
    g.fillStyle = '#fff9d6'; g.fillRect(x0 + 40, y0 + 104, 42, 14);
    g.fillStyle = '#c21d1d'; g.fillRect(x0 + 46, y0 + 108, 30, 6);
  }
}

function plain(g, ox, oy, colour) { g.fillStyle = colour; g.fillRect(ox, oy, 256, 256); }

function screenCell(g, ox, oy, kind, seed) {
  const r = rng(seed);
  g.fillStyle = kind === 'menu' ? '#1c1a18' : '#f3f4f2'; g.fillRect(ox, oy, 256, 256);
  if (kind === 'menu') {
    // three columns of dishes: a picture, a name bar, a price
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) {
      const x0 = ox + 8 + k * 83, y0 = oy + 10 + i * 82;
      g.fillStyle = hsl(20 + r() * 30, 70, 48); g.beginPath(); g.ellipse(x0 + 36, y0 + 28, 30, 20, 0, 0, 7); g.fill();
      g.fillStyle = hsl(95, 50, 40); g.fillRect(x0 + 10, y0 + 24, 52, 5);
      g.fillStyle = '#f2ead8'; g.fillRect(x0 + 4, y0 + 54, 50, 6);
      g.fillStyle = '#ffc72c'; g.fillRect(x0 + 4, y0 + 64, 26, 7);
    }
    return;
  }
  g.fillStyle = '#20262c'; g.fillRect(ox, oy, 256, 44);
  for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) {
    g.fillStyle = hsl([28, 95, 200, 350, 45, 150][i * 3 + k], 60, 55); g.fillRect(ox + 12 + k * 80, oy + 60 + i * 76, 70, 62);
    g.fillStyle = '#ffffff'; g.fillRect(ox + 20 + k * 80, oy + 104 + i * 76, 54, 10);
  }
  g.fillStyle = '#2e9d4a'; g.fillRect(ox + 128, oy + 216, 116, 30);
  g.fillStyle = '#c8ccd0'; g.fillRect(ox + 12, oy + 216, 106, 30);
}

let _tex = null;
/** The sheet, painted on first use. */
export function goodsTexture() {
  if (_tex) return _tex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = CELLS * 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
  for (const [look, [c, r, n]] of Object.entries(LOOK)) {
    for (let i = 0; i < n; i++) {
      const k = c + i, ox = (k % CELLS) * 256, oy = (r + Math.floor(k / CELLS)) * 256, seed = (c * 131 + r * 977 + i * 31337 + 7) >>> 0;
      if (DEPT[look]) shelfCell(g, ox, oy, look, seed);
      else if (look === 'bakery') bakeryCell(g, ox, oy, seed);
      else if (look === 'frozen' || look === 'bins' || look === 'produce') topCell(g, ox, oy, look, seed + i);
      else if (look === 'belt') { plain(g, ox, oy, '#1b1d1f'); g.fillStyle = '#2a2d30'; for (let y = 0; y < 256; y += 16) g.fillRect(ox, oy + y, 256, 2); }
      else if (look === 'selfscreen' || look === 'kiosk' || look === 'menu') screenCell(g, ox, oy, look === 'selfscreen' ? 'self' : look, seed);
      else if (look === 'wood') { plain(g, ox, oy, '#a37b4c'); g.fillStyle = 'rgba(70,45,20,0.25)'; for (let x = 0; x < 256; x += 21) g.fillRect(ox + x, oy, 2, 256); }
      else if (look === 'steel') { plain(g, ox, oy, '#b9bec2'); g.fillStyle = 'rgba(255,255,255,0.25)'; for (let y = 0; y < 256; y += 9) g.fillRect(ox, oy + y, 256, 2); }
      else if (look === 'counter') { plain(g, ox, oy, '#3a3d41'); g.fillStyle = '#e8e9e6'; g.fillRect(ox, oy, 256, 26); }
    }
  }
  _tex = new THREE.CanvasTexture(cv);
  _tex.colorSpace = THREE.SRGBColorSpace;
  _tex.anisotropy = 8;
  _tex.generateMipmaps = true;
  return _tex;
}
