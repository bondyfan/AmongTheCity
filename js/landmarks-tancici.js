// ---- landmarks-tancici.js: the Dancing House ----
// Milunić and Gehry, 1996, on the corner of the embankment and Jiráskovo
// náměstí: "Ginger", a glass tower pinched at the waist and standing on
// sloping pillars, leans into "Fred", a concrete cylinder that flares at the
// top under a dome of twisted steel tubes ("Medusa"); behind them nine
// storeys whose square windows do not keep to one line but ride up and down
// along the facade like a wave.
//
// Frame: fitted to the footprint (tile -21_-2, relation 6751056), front (v+)
// to the river (west), u+ south. The two towers sit on the north-west lobes
// the footprint itself has; the wave is done edge by edge: each edge of the
// outline gets its windows at its own height, so the run of short edges on
// the river front undulates.

import { K, hash2 } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { strut } from './landmarks-prahaparts.js';

const CONC = 0xd8d2c3, GLASS = 0x7f95a3, STEEL = 0x707372, PANE = 0x46545f;
const H = 26.5;                              // the roof of the office storeys
const GINGER = [-11.2, 6.2, 4.6], FRED = [-3.2, 6.9, 3.9];   // u, v, radius

export function tanciciFrame(kit, f) { return fitFrame(kit, f.o, -1, 0); }

/** A vertical surface of revolution whose facets are window panes (the shader draws the mullions). */
function glassLathe(kit, x, z, prof, n, phase, lean) {
  const ring = (r, y) => { const t = [lean[0] * y / H, lean[1] * y / H]; const out = [];
    for (let i = 0; i < n; i++) { const a = phase + i * 2 * Math.PI / n; out.push([x + Math.cos(a) * r + t[0], y, z + Math.sin(a) * r + t[1]]); } return out; };
  for (let j = 0; j + 1 < prof.length; j++) {
    const A = ring(prof[j][0], prof[j][1]), B = ring(prof[j + 1][0], prof[j + 1][1]);
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n, mx = (A[i][0] + A[i2][0]) / 2 - x, mz = (A[i][2] + A[i2][2]) / 2 - z;
      kit.gl = hash2(i, j, 31) < 0.35 ? 0.7 : 0;
      kit.pane(A[i], A[i2], B[i2], B[i], mx, mz, 2, 2);
    }
  }
  kit.gl = 0;
}

export function buildTancici(kit, f) {
  const { F } = tanciciFrame(kit, f);
  kit.floodFn = (x, y) => 0.55;
  const inTower = (e) => {
    const m = F.local((e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2);
    return Math.hypot(m[0] - GINGER[0], m[1] - GINGER[1]) < GINGER[2] + 0.6 || Math.hypot(m[0] - FRED[0], m[1] - FRED[1]) < FRED[2] + 0.4;
  };
  // the wave: each edge's windows at a height of their own, along u
  kit.set(CONC, K.plaster);
  kit.ringWalls(f.o, 0, H, (e) => {
    if (inTower(e)) return false;
    if (e.len < 1.8) return null;
    const u = F.local((e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2)[0];
    const dy = 0.55 * Math.sin(u * 0.55) + 0.25 * Math.sin(u * 1.7 + 1);
    const rows = [];
    for (let k = 0; k < 8; k++) rows.push({ y: 4.2 + k * 2.75 + dy * (k % 2 ? 1 : -0.6), h: 1.45, w: 1.3, hex: PANE, glow: 0.35, rev: 0.12, nx: 1, ny: 1 });
    rows.unshift({ y: 0, h: 3.2, w: 2.6, hex: 0x3f4a52, glow: 0.4, rev: 0.2 });
    return { pitch: 1.95, inset: 0.3, rows, seed: e.i };
  });
  kit.set(0x5e6062, K.metal);
  kit.cap(f.o, f.i, H, true);
  // the wavy cornice lines the window bands sit between
  kit.set(0xc4bdac, K.plaster);
  const fn = F.dir(0, 1);
  for (let k = 0; k < 8; k++) {
    for (let u = 3; u < 16.5; u += 1.5) {
      const y0 = 3.9 + k * 2.75 + 0.55 * Math.sin(u * 0.55) * (k % 2 ? 1 : -0.6), y1 = 3.9 + k * 2.75 + 0.55 * Math.sin((u + 1.5) * 0.55) * (k % 2 ? 1 : -0.6);
      kit.quad(F.P(u, 11.55, y0 - 0.12), F.P(u + 1.5, 11.55, y1 - 0.12), F.P(u + 1.5, 11.55, y1 + 0.12), F.P(u, 11.55, y0 + 0.12), fn[0], 0, fn[1]);
    }
  }

  // ---- Ginger: glass, pinched at the waist, on her legs ---------------------
  const [gx, gz] = F.xz(GINGER[0], GINGER[1]), gr = GINGER[2];
  const lean = F.dir(-0.9, 0.6);
  kit.set(GLASS, K.glass);
  glassLathe(kit, gx, gz, [[gr * 0.95, 4.0], [gr * 0.9, 8], [gr * 0.66, 13.5], [gr * 0.7, 16], [gr * 0.95, 21], [gr * 1.04, H - 0.5]], 12, 0, lean);
  kit.set(0x8c8a84, K.metal);
  kit.lathe(gx + lean[0] * (H - 0.5) / H, gz + lean[1] * (H - 0.5) / H, [[gr * 1.06, H - 0.5], [gr * 1.06, H + 0.3], [0, H + 0.3]], 12);
  kit.set(CONC, K.plaster);
  for (let i = 0; i < 3; i++) {
    const a = 0.6 + i * 2.1, ox = Math.cos(a) * gr * 0.8, oz = Math.sin(a) * gr * 0.8;
    strut(kit, [gx + ox * 0.6, 0, gz + oz * 0.6], [gx + ox + lean[0] * 0.15, 4.2, gz + oz + lean[1] * 0.15], 0.35, 6);
  }

  // ---- Fred: concrete, flaring at the top, and Medusa on his head ------------
  const [fx, fz] = F.xz(FRED[0], FRED[1]), fr = FRED[2];
  kit.set(CONC, K.plaster);
  kit.lathe(fx, fz, [[fr, 0], [fr, H - 6], [fr * 1.12, H - 2], [fr * 1.16, H], [0, H]], 14);
  // his windows: square, and in no straight line either
  kit.set(PANE, K.glassDark);
  for (let k = 0; k < 8; k++) for (let i = 0; i < 7; i++) {
    const a = (i + (k % 2) * 0.5) * 2 * Math.PI / 7 + 2.4, r = fr * (k > 5 ? 1.08 : 1) + 0.03, y = 4 + k * 2.75 + 0.35 * Math.sin(i * 1.3);
    const c = Math.cos(a), s = Math.sin(a), t = [-s * 0.6, c * 0.6];
    kit.gl = hash2(i, k, 41) < 0.35 ? 0.8 : 0;
    kit.pane([fx + c * r - t[0], y, fz + s * r - t[1]], [fx + c * r + t[0], y, fz + s * r + t[1]], [fx + c * r + t[0], y + 1.3, fz + s * r + t[1]], [fx + c * r - t[0], y + 1.3, fz + s * r - t[1]], c, s, 1, 1);
  }
  kit.gl = 0;
  kit.set(STEEL, K.metal);
  const prof = [];
  for (let i = 0; i <= 5; i++) { const a = i / 5 * Math.PI / 2; prof.push([fr * 1.1 * Math.cos(a) + 0.1, H + 0.2 + 4.6 * Math.sin(a)]); }
  kit.lathe(fx, fz, prof, 10, 0.3);
  // the tubes it is twisted from: a few struts round it, crossing
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, b = a + 1.1;
    strut(kit, [fx + Math.cos(a) * fr * 1.15, H + 0.3, fz + Math.sin(a) * fr * 1.15], [fx + Math.cos(b) * 1.2, H + 4.9, fz + Math.sin(b) * 1.2], 0.12, 4);
  }
}
