// ---- mwatlas.js: painting the motorway sign atlas (main thread only) ----
// The pictures js/mwfaces.js maps: Czech motorway signs as they stand on the
// D11 (vyhláška 294/2015 and photos of the D11 / D1): white on green with a
// white border, the EXIT number in its own framed box, road number shields
// (dálnice red, silnice I. třídy red, II. třídy white, E roads green), the
// diagonal exit arrow and the straight-on arrow, the rest area pictograms,
// the kilometrovník (black on retroreflective orange) composed from digit
// cells, and IP 15a / 15b. Canvas 2D calls only: no image, no font file.
//
// LAZY. The canvas is painted the first time a motorway sign is about to be
// drawn (material.onBeforeRender, main thread), not at boot: a player who
// never leaves Pardubice never pays the paint or the 15 MB of texture (20 MB
// with its mips; half the size each way on the low preset, see
// setMotorwayAtlasScale). The
// texture is created at boot from an EMPTY canvas of the final size, so the
// shader program never changes when the paint lands.
//
// Night: real signs are retroreflective, they light up in headlights rather
// than glow. The map is also the emissive map, at a modest intensity driven by
// motorwayNight() (the darker, the more of the paint comes back), so the faces
// read at night without turning into lamps.

import * as THREE from 'three';
import { MW_ATLAS_W, MW_ATLAS_H, mwRects } from './mwfaces.js';
import { motorwayFaces } from './mwsigns.js';

const GREEN = '#00764c', WHITE = '#f4f6f1', RED = '#c8202c', BLACK = '#141414';
const ORANGE = '#ef8a1d', BLUE = '#1b5aa6', BACK = '#8a8d92';
const FONT = '"Arial Narrow", "Roboto Condensed", Arial, "Helvetica Neue", Helvetica, sans-serif';

// ---- helpers --------------------------------------------------------------
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

// One line of text fitted into [x0, x1]: squeezed down to 0.6 of its width as
// a narrower lettering would be, cut with an ellipsis past that (destsign.js).
function fit(g, text, x0, x1, base, px, align = 'left', weight = 'bold') {
  g.font = `${weight} ${px}px ${FONT}`;
  const room = x1 - x0;
  let w = g.measureText(text).width;
  let k = w > room ? room / w : 1;
  if (k < 0.6) {
    let t = text;
    while (t.length > 3 && g.measureText(t + '…').width * 0.6 > room) t = t.slice(0, -1);
    text = t.trimEnd() + '…'; k = 0.6; w = g.measureText(text).width;
  }
  const tw = w * k;
  const x = align === 'center' ? (x0 + x1 - tw) / 2 : align === 'right' ? x1 - tw : x0;
  g.save(); g.translate(x, base); g.scale(k, 1); g.fillText(text, 0, 0); g.restore();
  return tw;
}

// a green plate with the white border every Czech direction sign has
function plate(g, x, y, w, h, fill = GREEN, edge = WHITE) {
  g.fillStyle = edge; rr(g, x, y, w, h, 7); g.fill();
  g.fillStyle = fill; rr(g, x + 3, y + 3, w - 6, h - 6, 5); g.fill();
}

// A road number shield, its width returned. 'D11' / 'D35' / 'D0': red with
// white letters; 'I/36': red, the number only; 'II/322': white with black;
// 'E67': green, white border.
function shieldW(g, ref, px) {
  const txt = ref.startsWith('II/') ? ref.slice(3) : ref.startsWith('I/') ? ref.slice(2) : ref;
  g.font = `bold ${px}px ${FONT}`;
  return Math.ceil(g.measureText(txt).width) + px * 0.55;
}
function shield(g, ref, x, y, px) {
  const txt = ref.startsWith('II/') ? ref.slice(3) : ref.startsWith('I/') ? ref.slice(2) : ref;
  const w = shieldW(g, ref, px), h = Math.round(px * 1.18);
  let fill = RED, ink = WHITE, edge = WHITE;
  if (ref.startsWith('II/')) { fill = WHITE; ink = BLACK; edge = BLACK; }
  else if (ref.startsWith('E')) { fill = GREEN; ink = WHITE; edge = WHITE; }
  g.fillStyle = edge; rr(g, x, y, w, h, 3); g.fill();
  g.fillStyle = fill; rr(g, x + 1.5, y + 1.5, w - 3, h - 3, 2); g.fill();
  g.fillStyle = ink; g.font = `bold ${px}px ${FONT}`; g.textBaseline = 'alphabetic';
  g.fillText(txt, x + px * 0.27, y + h - px * 0.26);
  return w;
}

// arrows, drawn as a filled shaft and head in a box (cx, cy) of size s
function arrow(g, cx, cy, s, ang) {
  g.save(); g.translate(cx, cy); g.rotate(ang);
  g.fillStyle = WHITE;
  g.beginPath();
  g.moveTo(0, -s * 0.5); g.lineTo(s * 0.32, -s * 0.12); g.lineTo(s * 0.1, -s * 0.12);
  g.lineTo(s * 0.1, s * 0.5); g.lineTo(-s * 0.1, s * 0.5); g.lineTo(-s * 0.1, -s * 0.12);
  g.lineTo(-s * 0.32, -s * 0.12); g.closePath(); g.fill();
  g.restore();
}

// the "EXIT nn" box: white frame, white letters on the green
function exitBox(g, n, x, y, px) {
  g.font = `bold ${px}px ${FONT}`;
  const t = 'EXIT ' + n, w = Math.ceil(g.measureText(t).width) + px * 0.6, h = Math.round(px * 1.3);
  g.strokeStyle = WHITE; g.lineWidth = 2.5; rr(g, x, y, w, h, 3); g.stroke();
  g.fillStyle = WHITE; g.fillText(t, x + px * 0.3, y + h - px * 0.3);
  return w;
}

// ---- the faces ------------------------------------------------------------
function paintExit(g, r, s) {
  const [x, y, w, h] = r;
  plate(g, x, y, w, h);
  g.textBaseline = 'alphabetic';
  const bw = exitBox(g, s.n, x + 10, y + 9, 19);
  // shields to the right of the exit box
  let sx = x + 10 + bw + 8;
  for (const ref of s.refs.slice(0, 2)) {
    const sw = shieldW(g, ref, 18);
    if (sx + sw > x + w - 10) break;
    shield(g, ref, sx, y + 9, 18); sx += sw + 5;
  }
  // the destinations, up to three lines, left of the arrow
  const lines = s.to.slice(0, 3), lh = lines.length > 2 ? 34 : 41;
  g.fillStyle = WHITE;
  let base = y + 9 + 25 + lh - 4;
  for (const t of lines) { fit(g, t, x + 12, x + w - 50, base, lines.length > 2 ? 30 : 35); base += lh; }
  arrow(g, x + w - 28, y + h - 34, 40, Math.PI / 4);
}

function paintThru(g, r, s) {
  const [x, y, w, h] = r;
  plate(g, x, y, w, h);
  let sx = x + 11;
  for (const ref of s.refs) { sx += shield(g, ref, sx, y + 10, 19) + 6; }
  const lines = s.to.length ? s.to : ['Hradec Králové'];
  const n = Math.min(3, lines.length), lh = n > 2 ? 34 : 41;
  g.fillStyle = WHITE;
  let base = y + 10 + 24 + lh - 4;
  for (let i = 0; i < n; i++) { fit(g, lines[i], x + 12, x + w - 50, base, n > 2 ? 30 : 35); base += lh; }
  arrow(g, x + w - 26, y + h - 38, 44, 0);
}

function pict(g, kind, x, y, s) {
  g.fillStyle = WHITE; rr(g, x, y, s, s, 3); g.fill();
  const c = x + s / 2, m = y + s / 2;
  g.fillStyle = BLUE; g.strokeStyle = BLUE;
  if (kind === 'P') {
    g.font = `bold ${Math.round(s * 0.82)}px ${FONT}`; g.textAlign = 'center';
    g.fillText('P', c, y + s * 0.83); g.textAlign = 'left';
  } else if (kind === 'F') {           // fuel pump
    g.fillStyle = BLACK;
    g.fillRect(x + s * 0.24, y + s * 0.2, s * 0.34, s * 0.62);
    g.fillStyle = WHITE; g.fillRect(x + s * 0.3, y + s * 0.27, s * 0.22, s * 0.16);
    g.strokeStyle = BLACK; g.lineWidth = s * 0.06;
    g.beginPath(); g.moveTo(x + s * 0.58, y + s * 0.32); g.lineTo(x + s * 0.74, y + s * 0.42);
    g.lineTo(x + s * 0.74, y + s * 0.7); g.stroke();
  } else if (kind === 'R') {           // fork and knife
    g.strokeStyle = BLACK; g.lineWidth = s * 0.07;
    g.beginPath(); g.moveTo(c - s * 0.14, y + s * 0.18); g.lineTo(c - s * 0.14, y + s * 0.82);
    g.moveTo(c - s * 0.24, y + s * 0.18); g.lineTo(c - s * 0.24, y + s * 0.4); g.lineTo(c - s * 0.04, y + s * 0.4);
    g.lineTo(c - s * 0.04, y + s * 0.18);
    g.moveTo(c + s * 0.18, y + s * 0.82); g.lineTo(c + s * 0.18, y + s * 0.18); g.stroke();
    g.fillStyle = BLACK; g.beginPath(); g.ellipse(c + s * 0.2, y + s * 0.34, s * 0.07, s * 0.17, 0, 0, Math.PI * 2); g.fill();
  } else if (kind === 'W') {
    g.fillStyle = BLACK; g.font = `bold ${Math.round(s * 0.46)}px ${FONT}`; g.textAlign = 'center';
    g.fillText('WC', c, m + s * 0.17); g.textAlign = 'left';
  }
}

function paintRest(g, r, s) {
  const [x, y, w, h] = r;
  plate(g, x, y, w, h);
  const kinds = [s.parking && 'P', s.fuel && 'F', s.food && 'R', s.wc && 'W'].filter(Boolean);
  const ps = 46, gap = 8, row = kinds.length * ps + (kinds.length - 1) * gap;
  let px = x + (w - row) / 2;
  for (const k of kinds) { pict(g, k, px, y + 14, ps); px += ps + gap; }
  g.fillStyle = WHITE;
  fit(g, 'Odpočívka', x + 12, x + w - 12, y + 92, 22, 'center', '600');
  fit(g, s.name, x + 12, x + w - 12, y + 126, 32, 'center');
}

function paintDist(g, r, s) {
  const [x, y, w, h] = r;
  plate(g, x, y, w, h);
  const n = s.lines.length, lh = n > 2 ? 33 : 40;
  let base = y + (h - n * lh) / 2 + lh - 9;
  g.fillStyle = WHITE;
  for (const [name, km] of s.lines) {
    const kw = fit(g, String(km), x + w - 64, x + w - 14, base, 29, 'right');
    fit(g, name, x + 14, x + w - 22 - kw, base, 28);
    base += lh;
  }
}

function paintGore(g, r, s) {
  const [x, y, w, h] = r;
  plate(g, x, y, w, h);
  g.fillStyle = WHITE;
  fit(g, 'EXIT', x + 10, x + 70, y + 30, 22);
  fit(g, String(s.n), x + 10, x + 76, y + 76, 44);
  arrow(g, x + w - 24, y + h / 2 + 4, 40, Math.PI / 4);
}

// IP 15a: the motorway pictogram (a carriageway under an overpass); 15b the
// same struck through in red
function paintIp15(g, r, s) {
  const [x, y, w, h] = r;
  plate(g, x, y, w, h);
  const c = x + w / 2;
  g.fillStyle = WHITE;
  // the overpass deck and its two piers
  g.fillRect(x + 16, y + 26, w - 32, 7);
  g.fillRect(x + 22, y + 33, 7, 14); g.fillRect(x + w - 29, y + 33, 7, 14);
  // the two carriageways converging to the horizon, a median between
  g.beginPath();
  g.moveTo(c - 6, y + 40); g.lineTo(c - 2, y + 40); g.lineTo(c - 12, y + h - 14); g.lineTo(c - 32, y + h - 14); g.closePath(); g.fill();
  g.beginPath();
  g.moveTo(c + 2, y + 40); g.lineTo(c + 6, y + 40); g.lineTo(c + 32, y + h - 14); g.lineTo(c + 12, y + h - 14); g.closePath(); g.fill();
  if (s.end) {
    g.strokeStyle = RED; g.lineWidth = 9; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(x + 12, y + h - 12); g.lineTo(x + w - 12, y + 12); g.stroke();
  }
}

function paintPlate(g, r, s) {
  const [x, y, w, h] = r;
  plate(g, x, y, w, h);
  g.fillStyle = WHITE;
  fit(g, s.text, x + 6, x + w - 6, y + h - 8, 22, 'center');
}

function paintKmPlate(g, r) {
  const [x, y, w, h] = r;
  g.fillStyle = BLACK; g.fillRect(x, y, w, h);
  g.fillStyle = ORANGE; g.fillRect(x + 3, y + 3, w - 6, h - 6);
}
function paintGlyph(g, r, s) {
  const [x, y, w, h] = r;
  g.fillStyle = ORANGE; g.fillRect(x, y, w, h);
  g.fillStyle = BLACK;
  if (s.c === ',') { g.fillRect(x + w / 2 - 3, y + h - 17, 6, 8); g.fillRect(x + w / 2 - 5, y + h - 11, 3, 6); return; }
  g.font = `bold 44px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.save(); g.translate(x + w / 2, y + h - 6); g.scale(0.82, 1); g.fillText(s.c, 0, 0); g.restore();
  g.textAlign = 'left';
}

const PAINT = { exit: paintExit, thru: paintThru, rest: paintRest, dist: paintDist, gore: paintGore,
  ip15: paintIp15, plate: paintPlate, kmplate: paintKmPlate, glyph: paintGlyph,
  back: (g, r) => { g.fillStyle = BACK; g.fillRect(r[0], r[1], r[2], r[3]); } };

/** Paint every face into canvas `cv` (MW_ATLAS_W x MW_ATLAS_H, or a scaled
 *  copy of that size: the faces are drawn in atlas pixels through a scale, so
 *  a half-size canvas holds the same pictures at the same uvs). Returns ms. */
export function paintMotorwayAtlas(cv) {
  const t0 = performance.now();
  const g = cv.getContext('2d');
  g.setTransform(cv.width / MW_ATLAS_W, 0, 0, cv.height / MW_ATLAS_H, 0, 0);
  g.fillStyle = BACK; g.fillRect(0, 0, MW_ATLAS_W, MW_ATLAS_H);
  const rects = mwRects();
  for (const [k, s] of motorwayFaces()) {
    const r = rects.get(k), p = PAINT[s.type];
    if (!r || !p) continue;
    g.save();
    g.beginPath(); g.rect(r[0], r[1], r[2], r[3]); g.clip();
    p(g, r, s);
    g.restore();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  return performance.now() - t0;
}

/**
 * The material every motorway sign face wears. In node (no document) it has no
 * pictures, which is all the tests and the worker's geometry need.
 */
export function motorwayDecoMaterial() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0 });
  mat.name = 'motorwayDeco';
  if (typeof document === 'undefined') return mat;
  const cv = document.createElement('canvas');
  cv.width = MW_ATLAS_W; cv.height = MW_ATLAS_H;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  mat.map = tex; mat.emissiveMap = tex;
  const st = mat.userData.atlas = { cv, tex, painted: false, scale: 1 };
  // the first draw of any motorway sign: paint, then let three upload it
  mat.onBeforeRender = () => {
    if (st.painted) return;
    st.painted = true;
    mat.userData.paintMs = paintMotorwayAtlas(cv);
    tex.needsUpdate = true;
  };
  return mat;
}

// The atlas at full size is 2048 x 1792 RGBA with its mip chain: 19.6 MB of
// GPU memory once the first motorway sign is drawn. On a machine that runs the
// low preset that is a large share of what it has, so there the canvas is
// half the size each way (4.9 MB). The uvs are fractions of the atlas
// (js/mwfaces.js mwUV), so nothing else changes: the same faces, read at half
// the pixels, which the low preset's 0.75 render scale cannot resolve anyway.
export const MW_ATLAS_SCALES = [1, 0.5];

/** Bytes the atlas texture takes on the GPU at `scale` (RGBA8 plus mips). */
export function motorwayAtlasBytes(scale = 1) {
  return Math.round(Math.round(MW_ATLAS_W * scale) * Math.round(MW_ATLAS_H * scale) * 4 * 4 / 3);
}

/**
 * Resize the atlas of `mat` (a motorwayDecoMaterial) to `scale` (1 or 0.5).
 * Before the first motorway sign has been drawn this only resizes the empty
 * canvas (nothing is on the GPU yet); after it, the canvas is repainted and the
 * old texture freed, because a texture's storage cannot change size in place
 * (three allocates it once): dispose() makes the next draw upload it anew.
 * The program does not change (same map), so no shader recompiles.
 */
export function setMotorwayAtlasScale(mat, scale) {
  const st = mat?.userData?.atlas;
  if (!st) return false;
  const k = scale === 0.5 ? 0.5 : 1;
  if (st.scale === k) return false;
  st.scale = k;
  st.cv.width = Math.round(MW_ATLAS_W * k); st.cv.height = Math.round(MW_ATLAS_H * k);
  if (st.painted) {
    mat.userData.paintMs = paintMotorwayAtlas(st.cv);
    st.tex.dispose();
    st.tex.needsUpdate = true;
  }
  return true;
}

/**
 * Once a frame (from meshes.js streetNight): the retroreflective faces give
 * back a share of their own paint as the night deepens.
 */
export function motorwayNight(mat, nightK) {
  let on = (nightK - 0.15) / 0.5;
  on = on < 0 ? 0 : on > 1 ? 1 : on;
  mat.emissiveIntensity = 0.16 * on;
}
