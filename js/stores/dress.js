// ---- stores/dress.js: what stands on and in front of a store's shell ----
// WORKER SAFE (called from js/stores/build.js on both threads).
// The canopy over the door, the chain's signs on the walls, the pylon by the
// car park, the trolley bay, the hours board and the small furniture of a shop
// front. Positions come from js/stores/site.js spotsOf, in the door's frame,
// so the runtime that lets the player take a trolley reads the same numbers.

import { K } from '../landmarkskit.js';
import { Frame } from '../landmarksframe.js';
import { signBrand, signAspect, signQuad } from './signs.js';
import { dressFast } from './dressfast.js';
import { dressShow } from './dressshow.js';
import { apronOf } from './site.js';

const STEEL = 0x9da1a5, DARK = 0x33373c;

/** A slim round column from the ground to y. */
function column(kit, F, u, v, y, r = 0.09) {
  const [x, z] = F.xz(u, v);
  kit.lathe(x, z, [[r, -0.3], [r, y]], 8);
}

/** A sign on a wall face: centred s metres along a->b... given directly in world terms. */
function wallSign(kit, ctx, brand, x, z, yc, w, h, mx, mz) {
  // a backing plate first, so the sign has an edge and a shadow line
  const tx = -mz, tz = mx, o = 0.1;
  const c = (su, y) => [x + tx * su * (w / 2 + 0.08) + mx * o, y, z + tz * su * (w / 2 + 0.08) + mz * o];
  kit.ao = false;
  kit.set(DARK, K.metal);
  kit.quad(c(-1, yc - h / 2 - 0.08), c(1, yc - h / 2 - 0.08), c(1, yc + h / 2 + 0.08), c(-1, yc + h / 2 + 0.08), mx, 0, mz);
  kit.ao = true;
  signQuad(ctx?.marks, brand, x + mx * (o + 0.03), z + mz * (o + 0.03), kit.ground + yc, w, h, mx, mz);
}

/** The chain's sign over the door and on the flanks. */
function facadeSigns(kit, site, ctx) {
  const chain = site.chain, A = chain.arch, sq = !!chain.sign.square;
  const brand = signBrand(chain);
  const top = site.hF, bandH = A.bandH ?? 0;
  // over the door: a square tile on the wall over the canopy, or a panel in the band
  let w, h, yc;
  if (sq && A.style === 'hall') { h = Math.min(2.7, top - 4.3); w = h; yc = top - 0.45 - h / 2; }
  // a square tile on a low box stands on the band and a little over the coping
  else if (sq) { h = Math.max(1.5, Math.min(2.8, top * 0.3)); w = h; yc = top + 0.3 - h / 2; }
  else { h = Math.max(1.0, Math.min(1.7, bandH > 0 ? bandH * 0.92 : 1.3)); w = h * signAspect('band'); yc = top - (bandH > 0 ? bandH / 2 : 0.3 + h / 2); }
  // over the door, kept on the front edge
  const half = w / 2 + 0.3;
  const u = Math.max(site.uL + half, Math.min(site.uR - half, 0));
  const [x, z] = site.dw(u, 0);
  wallSign(kit, ctx, brand, x, z, yc, w, h, site.nx, site.nz);
  // the flanks: the same sign near the front corner of each long side wall
  for (const e of site.edges) {
    if ((e.role !== 'left' && e.role !== 'right') || e.len < w + 3) continue;
    const va = site.local(e.a[0], e.a[1])[1], vb = site.local(e.b[0], e.b[1])[1];
    if (Math.max(va, vb) < site.hv - 3) continue;       // a wall that never reaches the front
    const s = va > vb ? Math.min(e.len / 2, w / 2 + 2.2) : e.len - Math.min(e.len / 2, w / 2 + 2.2);
    const px = e.a[0] + (e.b[0] - e.a[0]) * s / e.len, pz = e.a[1] + (e.b[1] - e.a[1]) * s / e.len;
    const t = site.topAt(px, pz);
    wallSign(kit, ctx, brand, px, pz, sq ? (A.style === 'hall' ? t - 0.45 - h / 2 : t + 0.3 - h / 2) : t - (bandH > 0 ? bandH / 2 : 0.3 + h / 2), w, h, e.mx, e.mz);
  }
}

/** The pylon: a mast with the chain's sign on every face that can be seen. */
function totem(kit, F, site, ctx) {
  const chain = site.chain, sq = !!chain.sign.square;
  const { u, v } = site.spots.totem;
  const H = chain.kind === 'hyper' ? 12 : chain.kind === 'fast' ? 10.5 : 8.6;
  const brand = signBrand(chain, sq || chain.kind === 'fast' ? 'sq' : 'band');
  const s = sq || chain.kind === 'fast' ? 2.3 : 0.95;      // panel height
  const w = sq || chain.kind === 'fast' ? s : s * 4;
  kit.set(0xd9dbdc, K.metal);
  F.box(u - 0.2, u + 0.2, v - 0.2, v + 0.2, -0.4, H - s);
  // the head: a box the panels sit on
  kit.set(chain.sign.bg, K.metal);
  const hw = w / 2 + 0.06, hd = sq || chain.kind === 'fast' ? hw : 0.22;
  F.box(u - hw, u + hw, v - hd, v + hd, H - s - 0.06, H + 0.06);
  const yc = kit.ground + H - s / 2;
  const [x, z] = F.xz(u, v);
  const [nx, nz] = F.dir(0, 1), [ux, uz] = F.dir(1, 0);
  signQuad(ctx?.marks, brand, x + nx * (hd + 0.02), z + nz * (hd + 0.02), yc, w, s, nx, nz);
  signQuad(ctx?.marks, brand, x - nx * (hd + 0.02), z - nz * (hd + 0.02), yc, w, s, -nx, -nz);
  if (hd === hw) {
    signQuad(ctx?.marks, brand, x + ux * (hw + 0.02), z + uz * (hw + 0.02), yc, w, s, ux, uz);
    signQuad(ctx?.marks, brand, x - ux * (hw + 0.02), z - uz * (hw + 0.02), yc, w, s, -ux, -uz);
  }
}

/** Rows of nested trolleys: each a basket with the chain's handle. */
function trolleys(kit, F, site) {
  const bay = site.spots.bay;
  if (!bay) return;
  const handle = site.chain.trolley ?? site.chain.sign.bg;
  const rows = 2, n = Math.max(3, Math.floor((bay.u1 - bay.u0 - 0.9) / 0.26));
  const dir = site.spots.side;                      // the rows nest away from the door
  for (let r = 0; r < rows; r++) {
    const v0 = bay.v0 + 0.15 + r * 0.95, v1 = v0 + 0.56;
    for (let i = 0; i < n; i++) {
      const front = dir > 0 ? bay.u0 + 0.5 + i * 0.26 : bay.u1 - 0.5 - i * 0.26;
      const a = Math.min(front, front + dir * 0.62), b = Math.max(front, front + dir * 0.62);
      kit.set(0xb7bcc0, K.metal);
      F.box(a, b, v0, v1, 0.52, 1.0, null, false, true);
      if (i === n - 1 || i % 3 === 0) {             // legs and the under-frame, now and then
        kit.set(0x8f9498, K.metal);
        F.box(a + 0.05, b - 0.05, v0 + 0.05, v1 - 0.05, 0.12, 0.2);
      }
      kit.set(handle, K.metal);
      const h0 = dir > 0 ? b - 0.03 : a - 0.03;
      F.box(h0, h0 + 0.06, v0 - 0.02, v1 + 0.02, 1.0, 1.06);
    }
  }
}

/** A steel shelter with a clear roof over the trolley bay (a box store has no deep canopy). */
function shelter(kit, F, site) {
  const bay = site.spots.bay;
  if (!bay) return;
  const y = 2.25;
  kit.set(STEEL, K.metal);
  for (const u of [bay.u0, bay.u1]) for (const v of [bay.v0 - 0.1, bay.v1 + 0.3]) column(kit, F, u, v, y, 0.045);
  kit.set(0xc9d6dc, K.metal);
  F.box(bay.u0 - 0.15, bay.u1 + 0.15, bay.v0 - 0.25, bay.v1 + 0.45, y, y + 0.07);
  kit.set(site.chain.sign.bg, K.metal);
  F.box(bay.u0 - 0.15, bay.u1 + 0.15, bay.v1 + 0.45, bay.v1 + 0.5, y - 0.28, y + 0.07);
}

/** The paved apron before the doors: level with the floor at the wall, down to the ground at its edge. */
function apron(kit, F, site) {
  const ap = apronOf(site, (x, z) => kit.rel(x, z));
  kit.set(0xb9bbb8, K.paving);
  const A = F.P(ap.u0, 0.02, ap.y0), B = F.P(ap.u1, 0.02, ap.y0), C = F.P(ap.u1, ap.d, ap.yR), D = F.P(ap.u0, ap.d, ap.yL);
  kit.quad(A, B, C, D, 0, 1, 0);
  // its two cheeks and its toe, down into the ground
  const low = (p) => [p[0], -0.9, p[2]];
  const [lx, lz] = F.dir(-1, 0), [fx, fz] = F.dir(0, 1);
  kit.quad(low(A), low(D), D, A, lx, 0, lz);
  kit.quad(low(B), low(C), C, B, -lx, 0, -lz);
  kit.quad(low(D), low(C), C, D, fx, 0, fz);
}

export function dressStore(kit, f, site, ctx) {
  const chain = site.chain, A = chain.arch, sp = site.spots;
  const F = new Frame(kit, site.door.x, site.door.z, site.nx, site.nz, 0);
  kit.ao = false;
  if (chain.kind === 'fast') { dressFast(kit, F, site, ctx, f); kit.ao = true; return; }
  if (chain.kind === 'showroom') { dressShow(kit, F, site, ctx); kit.ao = true; return; }

  // ---- the canopy ----
  const c = sp.canopy;
  kit.set(A.canopy, K.metal);
  F.box(c.u0, c.u1, -0.05, c.d, c.y, c.y + 0.26, null, true, false);
  kit.set(0xf4f4f0, K.plaster); kit.gl = 0.7;            // its soffit, lit after dark
  F.flat(c.u0, c.u1, 0, c.d, c.y, false);
  kit.gl = 0;
  kit.set(A.style === 'hall' ? STEEL : A.frame, K.metal);
  const cols = Math.max(2, Math.round((c.u1 - c.u0) / 5.5) + 1);
  for (let i = 0; i < cols; i++) column(kit, F, c.u0 + 0.3 + (c.u1 - c.u0 - 0.6) * i / (cols - 1), c.d - 0.3, c.y);
  // a portal round the doors of the big boxes: two fins and a beam in the chain's colour
  if (A.portal !== undefined) {
    kit.set(A.portal, K.metal);
    const pu = site.door.w / 2 + 2.2;
    F.box(-pu - 0.4, -pu, -0.05, c.d, -0.3, c.y);
    F.box(pu, pu + 0.4, -0.05, c.d, -0.3, c.y);
  }

  // ---- paving under the canopy and out to the kerb ----
  apron(kit, F, site);

  // ---- trolleys ----
  if (A.style !== 'hall') shelter(kit, F, site);
  trolleys(kit, F, site);

  // ---- hours board, bin, bike hoops ----
  const hu = sp.hours.u;
  kit.set(DARK, K.metal);
  F.box(hu - 0.36, hu + 0.36, 0.02, 0.08, site.floor + 1.1, site.floor + 2.0);
  {
    const [x, z] = site.dw(hu, 0.1);
    signQuad(ctx?.marks, signBrand(chain, 'hours'), x, z, kit.ground + site.floor + 1.55, 0.64, 0.8, site.nx, site.nz);
  }
  kit.set(0x4a4f55, K.metal);
  F.box(hu - 0.25 - sp.side * 1.0, hu + 0.25 - sp.side * 1.0, 0.25, 0.75, 0, 0.95);
  kit.set(STEEL, K.metal);
  for (let i = 0; i < 4; i++) {
    const bu = hu - sp.side * (2.4 + i * 0.7);
    if (bu < site.uL + 0.5 || bu > site.uR - 0.5) break;
    F.box(bu - 0.025, bu + 0.025, 0.9, 1.7, 0, 0.8);
  }

  facadeSigns(kit, site, ctx);
  totem(kit, F, site, ctx);
  kit.ao = true;
}

export { column, wallSign, totem, apron, STEEL, DARK };
