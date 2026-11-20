// ---- stores/dressfast.js: the front of a fast-food pavilion ----
// WORKER SAFE. The brand fin beside the door, the thin canopy, the band sign,
// the tall pole sign, a terrace with parasols, the playground some of them
// have, and the drive-through's post, hatch and height bar where the map has
// the lane (js/stores/drive.js).

import { K } from '../landmarkskit.js';
import { signBrand, signQuad } from './signs.js';
import { column, wallSign, totem, apron, STEEL, DARK } from './dress.js';
import { driveOf } from './drive.js';
import { around } from './site.js';

function terrace(kit, F, site, u0, u1) {
  const acc = site.chain.arch.accent ?? 0xcc3322;
  const n = Math.max(0, Math.min(3, Math.floor(Math.abs(u1 - u0) / 2.6)));
  for (let i = 0; i < n; i++) {
    const u = u0 + (u1 - u0) * (i + 0.5) / n, v = 2.6;
    const [x, z] = F.xz(u, v);
    kit.set(0x8a8d90, K.metal);
    kit.lathe(x, z, [[0.05, 0], [0.05, 0.72], [0.48, 0.72], [0.48, 0.76], [0, 0.76]], 10);
    kit.set(0x5b4a3a, K.wood);
    for (const [du, dv] of [[-0.78, 0], [0.78, 0], [0, -0.78], [0, 0.78]]) {
      const [sx, sz] = F.xz(u + du, v + dv);
      kit.lathe(sx, sz, [[0.03, 0], [0.03, 0.44], [0.19, 0.44], [0.19, 0.48], [0, 0.48]], 8);
    }
    kit.set(STEEL, K.metal);
    kit.lathe(x, z, [[0.025, 0.76], [0.025, 2.35]], 6);
    kit.set(acc, K.metal);
    kit.lathe(x, z, [[1.35, 2.05], [0.05, 2.5], [0, 2.5]], 8);
    kit.lathe(x, z, [[1.35, 2.05], [1.35, 2.02], [0, 2.02]], 8);
  }
}

function playground(kit, F, u0, u1) {
  const u = (u0 + u1) / 2, v = 6.2;
  kit.set(0x2e7bbf, K.metal);
  for (const [du, dv] of [[-0.75, -0.75], [0.75, -0.75], [0.75, 0.75], [-0.75, 0.75]]) column(kit, F, u + du, v + dv, 2.6, 0.06);
  kit.set(0xe8c93a, K.metal);
  F.box(u - 0.85, u + 0.85, v - 0.85, v + 0.85, 1.25, 1.35);
  kit.set(0xd43a2f, K.metal);
  F.pyramid(u - 1.05, u + 1.05, v - 1.05, v + 1.05, 2.6, 3.4);
  // the slide: a sloped tray off one side
  kit.set(0xe8c93a, K.metal);
  kit.quad(F.P(u + 0.85, v - 0.35, 1.3), F.P(u + 0.85, v + 0.35, 1.3), F.P(u + 3.0, v + 0.35, 0.12), F.P(u + 3.0, v - 0.35, 0.12), 0.4, 1, 0);
  kit.quad(F.P(u + 0.85, v - 0.35, 1.3), F.P(u + 0.85, v + 0.35, 1.3), F.P(u + 3.0, v + 0.35, 0.12), F.P(u + 3.0, v - 0.35, 0.12), -0.4, -1, 0);
  // a low fence round it
  kit.set(0x6fa84a, K.metal);
  const a = u - 2.2, b = u + 3.6, c = v - 2.0, d = v + 2.0;
  for (const [p, q] of [[[a, c], [b, c]], [[b, c], [b, d]], [[b, d], [a, d]], [[a, d], [a, c]]]) {
    const A = F.xz(p[0], p[1]), B = F.xz(q[0], q[1]);
    const ex = B[0] - A[0], ez = B[1] - A[1], L = Math.hypot(ex, ez);
    kit.wall(A, B, 0.15, 0.85, ez / L, -ex / L);
    kit.wall(B, A, 0.15, 0.85, -ez / L, ex / L);
  }
}

/** The drive-through: the order post under its little roof, the hatch, the height bar. */
function drive(kit, f, site, ctx) {
  const d = driveOf(f, around(f, ctx?.cell)?.roads);
  if (!d) return;
  const acc = site.chain.arch.accent ?? 0xcc3322;
  const rel = (x, z) => kit.rel(x, z);
  // ---- the hatch: a projecting glazed bay on the wall, a counter under it ----
  const tx = -d.mz, tz = d.mx;
  const W = (s, o, y) => [d.wx + tx * s + d.mx * o, y, d.wz + tz * s + d.mz * o];
  kit.set(DARK, K.metal);
  kit.quad(W(-0.9, 0.5, 0.95), W(0.9, 0.5, 0.95), W(0.9, 0.5, 2.25), W(-0.9, 0.5, 2.25), d.mx, 0, d.mz);
  kit.quad(W(-0.9, 0.02, 2.25), W(0.9, 0.02, 2.25), W(0.9, 0.5, 2.25), W(-0.9, 0.5, 2.25), 0, 1, 0);
  kit.quad(W(-0.9, 0.02, 0.95), W(0.9, 0.02, 0.95), W(0.9, 0.5, 0.95), W(-0.9, 0.5, 0.95), 0, -1, 0);
  kit.quad(W(-0.9, 0.02, 0.95), W(-0.9, 0.5, 0.95), W(-0.9, 0.5, 2.25), W(-0.9, 0.02, 2.25), -tx, 0, -tz);
  kit.quad(W(0.9, 0.02, 0.95), W(0.9, 0.5, 0.95), W(0.9, 0.5, 2.25), W(0.9, 0.02, 2.25), tx, 0, tz);
  kit.set(0x9fc0d2, K.glassDark); kit.gl = 0.9;
  kit.pane(W(-0.75, 0.52, 1.1), W(0.75, 0.52, 1.1), W(0.75, 0.52, 2.1), W(-0.75, 0.52, 2.1), d.mx, d.mz, 2, 1);
  kit.gl = 0;
  kit.set(acc, K.metal);
  kit.quad(W(-1.3, 0.02, 2.45), W(1.3, 0.02, 2.45), W(1.3, 1.2, 2.45), W(-1.3, 1.2, 2.45), 0, 1, 0);
  kit.quad(W(-1.3, 0.02, 2.4), W(1.3, 0.02, 2.4), W(1.3, 1.2, 2.4), W(-1.3, 1.2, 2.4), 0, -1, 0);
  kit.quad(W(-1.3, 1.2, 2.4), W(1.3, 1.2, 2.4), W(1.3, 1.2, 2.45), W(-1.3, 1.2, 2.45), d.mx, 0, d.mz);

  // ---- the order post: a lit menu board and a speaker column, on the building's side ----
  const bx = d.ox + d.sx * 2.3, bz = d.oz + d.sz * 2.3, by = rel(bx, bz);
  const P = (s, o, y) => [bx + d.dx * s + d.sx * o, by + y, bz + d.dz * s + d.sz * o];
  kit.set(DARK, K.metal);
  const box = (s0, s1, o0, o1, y0, y1) => {
    kit.quad(P(s0, o0, y0), P(s1, o0, y0), P(s1, o0, y1), P(s0, o0, y1), -d.sx, 0, -d.sz);
    kit.quad(P(s0, o1, y0), P(s1, o1, y0), P(s1, o1, y1), P(s0, o1, y1), d.sx, 0, d.sz);
    kit.quad(P(s0, o0, y0), P(s0, o1, y0), P(s0, o1, y1), P(s0, o0, y1), -d.dx, 0, -d.dz);
    kit.quad(P(s1, o0, y0), P(s1, o1, y0), P(s1, o1, y1), P(s1, o0, y1), d.dx, 0, d.dz);
    kit.quad(P(s0, o0, y1), P(s1, o0, y1), P(s1, o1, y1), P(s0, o1, y1), 0, 1, 0);
  };
  box(-0.16, 0.16, -0.12, 0.12, -0.2, 1.45);                 // the speaker column
  box(0.9, 2.5, -0.1, 0.1, 0.55, 2.2);                       // the menu board's case
  kit.set(0xf2ead8, K.glassDark); kit.gl = 1;                 // ...and its lit face, toward the lane
  kit.pane(P(1.0, -0.11, 0.7), P(2.4, -0.11, 0.7), P(2.4, -0.11, 2.1), P(1.0, -0.11, 2.1), -d.sx, -d.sz, 3, 2);
  kit.gl = 0;
  kit.set(acc, K.metal);
  box(-0.5, 2.8, -2.6, 0.5, 2.9, 3.0);                        // the little roof over the car
  kit.set(STEEL, K.metal);
  box(-0.4, -0.3, 0.3, 0.4, -0.2, 2.9); box(2.6, 2.7, 0.3, 0.4, -0.2, 2.9);

  // ---- the height bar, a few metres before the post ----
  const hx = d.ox - d.dx * 6, hz = d.oz - d.dz * 6, hy = rel(hx, hz);
  const H = (o, y) => [hx + d.sx * o, hy + y, hz + d.sz * o];
  kit.set(STEEL, K.metal);
  kit.lathe(H(2.3, 0)[0], H(2.3, 0)[2], [[0.06, hy - 0.2], [0.06, hy + 2.75]], 6);
  kit.set(0xe8c93a, K.metal);
  kit.quad(H(-2.3, 2.45), H(2.3, 2.45), H(2.3, 2.7), H(-2.3, 2.7), -d.dx, 0, -d.dz);
  kit.quad(H(-2.3, 2.45), H(2.3, 2.45), H(2.3, 2.7), H(-2.3, 2.7), d.dx, 0, d.dz);
}

export function dressFast(kit, F, site, ctx, f = ctx?.f) {
  const chain = site.chain, A = chain.arch, sp = site.spots, w = site.door.w;
  const c = sp.canopy;
  // ---- the thin canopy over the door ----
  kit.set(A.canopy, K.metal);
  F.box(c.u0, c.u1, -0.05, c.d, c.y, c.y + 0.14, null, true, true);

  // ---- the fin: a tall slab beside the door carrying the sign ----
  const s = sp.side, fu0 = s > 0 ? w / 2 + 1.0 : -(w / 2 + 2.3), fu1 = fu0 + 1.3;
  if (fu0 > site.uL + 0.2 && fu1 < site.uR - 0.2) {
    kit.set(A.fin, A.finKind ?? K.metal);
    F.box(fu0, fu1, -0.1, 0.55, -0.3, A.finH);
    const [x, z] = site.dw((fu0 + fu1) / 2, 0.57);
    signQuad(ctx?.marks, signBrand(chain, 'sq'), x, z, kit.ground + A.finH - 0.85, 1.1, 1.1, site.nx, site.nz);
  }
  // KFC's red stripes down the front wall, either side of the glass
  if (A.stripes) {
    kit.set(A.accent, K.metal);
    for (const u of [site.uL + 0.5, site.uL + 1.3, site.uL + 2.1, site.uR - 0.9, site.uR - 1.7, site.uR - 2.5]) {
      if (Math.abs(u) < w / 2 + 2.6) continue;
      F.box(u, u + 0.4, 0, 0.07, 0.5, site.hF - (A.bandH ?? 0));
    }
  }
  // ---- the band sign over the door ----
  const bh = Math.min(0.85, (A.bandH ?? 0.9) * 0.9), bw = bh * 4;
  {
    const u = Math.max(site.uL + bw / 2 + 0.3, Math.min(site.uR - bw / 2 - 0.3, -s * 1.2));
    const [x, z] = site.dw(u, 0);
    wallSign(kit, ctx, signBrand(chain, 'band'), x, z, site.hF - (A.bandH ?? 0.9) / 2, bw, bh, site.nx, site.nz);
  }
  // ---- paving, hours board ----
  apron(kit, F, site);
  const hu = sp.hours.u;
  kit.set(DARK, K.metal);
  F.box(hu - 0.36, hu + 0.36, 0.02, 0.08, site.floor + 1.1, site.floor + 2.0);
  {
    const [x, z] = site.dw(hu, 0.1);
    signQuad(ctx?.marks, signBrand(chain, 'hours'), x, z, kit.ground + site.floor + 1.55, 0.64, 0.8, site.nx, site.nz);
  }
  // ---- terrace on the side away from the fin, a playground beyond it ----
  const room = s > 0 ? -site.uL : site.uR;
  if (room > w / 2 + 4) {
    const t0 = -s * (w / 2 + 1.4), t1 = -s * Math.min(room - 0.6, w / 2 + 9);
    terrace(kit, F, site, t0, t1);
    if (chain.eat?.play && room > w / 2 + 7) playground(kit, F, Math.min(t0, t1), Math.max(t0, t1));
  }
  totem(kit, F, site, ctx);
  if (chain.eat?.drive && f) drive(kit, f, site, ctx);
}
