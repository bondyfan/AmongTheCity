// ---- stores/dressshow.js: what stands on and in front of a car showroom ----
// WORKER SAFE (called from js/stores/dress.js on both threads). A maker's own
// store is a quiet box: a dark band with the name in it over the gate, the
// same name on the walls that can be seen from the road, one pylon with the
// mark, the hours by the gate and a short row of charging posts. No canopy
// and no trolleys: the floor inside is the shop window.

import { K } from '../landmarkskit.js';
import { signBrand, signAspect, signQuad } from './signs.js';
import { wallSign, totem, apron, DARK } from './dress.js';
import { apronOf } from './site.js';

export function dressShow(kit, F, site, ctx) {
  const chain = site.chain, A = chain.arch, sp = site.spots;
  const band = signBrand(chain, 'band');
  const h = Math.min(1.05, (A.bandH ?? 1.2) * 0.8), w = h * signAspect('band');

  // ---- the paving out of the gate: level with the floor, down to the ground ----
  apron(kit, F, site);

  // ---- the name: in the band over the gate, and on every long wall that is not the back ----
  const yc = site.hF - (A.bandH ?? 1.2) / 2;
  {
    const [x, z] = site.dw(0, 0);
    wallSign(kit, ctx, band, x, z, yc, w, h, site.nx, site.nz);
  }
  for (const e of site.edges) {
    if (e === site.front || e.role === 'back' || e.len < w + 5) continue;
    const px = (e.a[0] + e.b[0]) / 2, pz = (e.a[1] + e.b[1]) / 2;
    wallSign(kit, ctx, band, px, pz, yc, w, h, e.mx, e.mz);
  }

  // ---- the hours, on the glass post beside the gate ----
  const hu = sp.hours.u;
  kit.set(DARK, K.metal);
  F.box(hu - 0.36, hu + 0.36, 0.02, 0.08, site.floor + 1.1, site.floor + 2.0);
  {
    const [x, z] = site.dw(hu, 0.1);
    signQuad(ctx?.marks, signBrand(chain, 'hours'), x, z, kit.ground + site.floor + 1.55, 0.64, 0.8, site.nx, site.nz);
  }

  // ---- charging posts along the front, past the apron: a white blade with a dark face ----
  const ap = apronOf(site, (x, z) => kit.rel(x, z));
  const s = sp.totem.u > 0 ? -1 : 1;                   // the side the pylon is not on
  for (let i = 0; i < 3; i++) {
    const u = s > 0 ? ap.u1 + 1.2 + i * 2.6 : ap.u0 - 1.2 - i * 2.6;
    if (u < site.uL + 0.6 || u > site.uR - 0.6) break;
    kit.set(0xf1f2f2, K.metal);
    F.box(u - 0.16, u + 0.16, 1.5, 1.72, -0.2, 1.85);
    kit.set(0x17181a, K.metal);
    F.box(u - 0.12, u + 0.12, 1.72, 1.75, 0.5, 1.7);
    kit.set(chain.sign.accent ?? chain.sign.fg, K.metal);
    F.box(u - 0.16, u + 0.16, 1.5, 1.72, 1.85, 1.93);
  }

  totem(kit, F, site, ctx);
}
