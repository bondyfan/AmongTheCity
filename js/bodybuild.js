// ---- bodybuild.js: trunk, limbs and clothes --------------------------------
//
// Turns the measurements of js/bodyshape.js and an outfit from js/wardrobe.js
// into tubes on a BodyMesh. Clothes are not a texture over a body: a jacket is
// the trunk lofted two centimetres fatter down to its hem, where it steps back
// in to the trousers underneath, and that step is what reads as a hem at ten
// metres. The same idea makes a cuff, a short sleeve, a sock and a skirt.
//
// EVERY LIMB SEGMENT IS A CLOSED CAPSULE ON ONE BONE, overlapping its
// neighbour inside the joint (a ball in a socket). Blending two bones across a
// knee would be smoother at 20 degrees and visibly collapsed at the 120 a kick
// or a car seat asks for; a ball joint looks the same at every angle. Only the
// trunk blends, because a spine bends a little everywhere and never a lot.

import { Matrix4 } from 'three';
import { BONE } from './bodyshape.js';
import { shade, mix } from './bodymesh.js';
import { buildExtras } from './bodyextras.js';

const SHOE_M = new Matrix4();

const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// What a top IS, in the four numbers that change its silhouette: how thick,
// where it ends, how long the sleeve is, what happens at the neck.
export const TOPS = {
  tee: { t: 0.010, hem: 'hip', sleeve: 'short', collar: 'crew' },
  shirt: { t: 0.011, hem: 'hip', sleeve: 'long', collar: 'shirt', front: 'placket' },
  sweater: { t: 0.014, hem: 'hip', sleeve: 'long', collar: 'crew', rib: true },
  hoodie: { t: 0.018, hem: 'hip', sleeve: 'long', collar: 'hood', front: 'pocket', rib: true },
  jacket: { t: 0.020, hem: 'low', sleeve: 'long', collar: 'stand', front: 'zip' },
  puffer: { t: 0.030, hem: 'low', sleeve: 'long', collar: 'stand', front: 'zip', quilt: true },
  coat: { t: 0.022, hem: 'thigh', sleeve: 'long', collar: 'stand', front: 'zip' },
  dress: { t: 0.010, hem: 'knee', sleeve: 'short', collar: 'crew' },
};

const BELT = 0x2a211a;

/**
 * Stack garment pieces over a section. `ys` are the section's own heights top
 * to bottom, at(y) gives { rx, fz, bz } there, and `pieces` cover it top to
 * bottom as [{ to, t, c, quilt }]. Where two pieces of different thickness
 * meet, the thicker one steps back in with a shaded lip: a hem. Where only the
 * colour changes the ring is split so the line is hard.
 */
function stack(ys, at, pieces, k) {
  const rings = [];
  const ring = (y, pc, extra) => {
    const a = at(y), t = pc.t + (extra ?? 0);
    return { y, rx: a.rx + t, fz: a.fz + t, bz: a.bz + t, c: pc.c };
  };
  let top = ys[0];
  for (let p = 0; p < pieces.length; p++) {
    const pc = pieces[p], bot = Math.max(pc.to, ys[ys.length - 1]);
    if (p === 0) rings.push(ring(top, pc));
    if (pc.quilt) {
      // a puffer: a seam every 9 cm and a roll of down between each pair
      const n = Math.max(1, Math.round((top - bot) / (0.09 * k)));
      for (let i = 1; i <= n * 2; i++) {
        const y = top + (bot - top) * i / (n * 2);
        if (i < n * 2) rings.push(ring(y, pc, i % 2 ? 0.011 * k : -0.002 * k));
      }
    } else {
      for (const y of ys) if (y < top - 1e-4 && y > bot + 1e-4) rings.push(ring(y, pc));
    }
    const nx = pieces[p + 1];
    if (!nx || bot <= ys[ys.length - 1] + 1e-5) { rings.push(ring(bot, pc)); break; }
    if (Math.abs(pc.t - nx.t) < 1e-4) {
      const r = ring(bot, pc); r.c2 = nx.c; rings.push(r);
    } else {
      const lip = shade(pc.t > nx.t ? pc.c : nx.c, 0.55);
      const a = ring(bot, pc), b = ring(bot, nx);
      a.c2 = lip; b.c = lip; b.c2 = nx.c;
      rings.push(a, b);
    }
    top = bot;
  }
  return rings;
}

// close a tube with a dome at each end (a ring at two thirds of the way, then
// the pole): the ball of a shoulder, a knee, a heel
const cap = (rings, dyTop, dyBot) => {
  const a = rings[0], z = rings[rings.length - 1];
  const sh = (r, dy, f, c) => ({ ...r, y: r.y + dy, rx: r.rx * f, fz: (r.fz ?? r.rx) * f, bz: (r.bz ?? r.rx) * f, c, c2: undefined });
  rings.unshift(sh(a, dyTop, 0, a.c), sh(a, dyTop * 0.62, 0.70, a.c));
  const zc = z.c2 ?? z.c;
  rings.push(sh(z, -dyBot * 0.62, 0.70, zc), sh(z, -dyBot, 0, zc));
  return rings;
};
const farCap = (n) => [0, 2, n - 3, n - 1];

// a round limb section: [[y, radius, backK], ...] to an at(y)
function roundAt(sec) {
  return (y) => {
    for (let i = 1; i < sec.length; i++) {
      if (y < sec[i][0] && i < sec.length - 1) continue;
      const a = sec[i - 1], b = sec[i];
      const f = Math.max(0, Math.min(1, (a[0] - y) / (a[0] - b[0])));
      const r = lerp(a[1], b[1], f), bk = lerp(a[2] ?? 1, b[2] ?? 1, f);
      return { rx: r, fz: r, bz: r * bk };
    }
    return { rx: sec[0][1], fz: sec[0][1], bz: sec[0][1] };
  };
}

// which bone a trunk vertex at height y belongs to
function trunkBone(D, y) {
  const k = D.k;
  if (y >= D.spineY + 0.06 * k) return BONE.chest;
  if (y >= D.spineY - 0.05 * k) return [BONE.chest, BONE.torso, sstep(D.spineY - 0.05 * k, D.spineY + 0.06 * k, y)];
  if (y >= D.beltY - 0.02 * k) return [BONE.torso, BONE.pelvis, sstep(D.beltY - 0.02 * k, D.waistY, y)];
  return BONE.pelvis;
}

// below the hip a skirt or a coat tail follows the thigh on its own side
function tailBone(D, y) {
  const w = Math.max(0, Math.min(0.92, (D.hipY - y) / (0.20 * D.k)));
  return (j, S) => [(j + 0.5) / S < 0.5 ? BONE.legR : BONE.legL, BONE.pelvis, w];
}

function bonesFor(D, rings) {
  for (const r of rings) {
    if (r.y < D.hipY - 0.01 * D.k) r.bf = tailBone(D, r.y); else r.b = trunkBone(D, r.y);
  }
  return rings;
}

// the trunk section, widened below the hip so a tail clears both thighs
function tailAt(D, hemY, flare) {
  const k = D.k, hip = D.trunkAt(D.hipY + 0.015 * k);
  return (y) => {
    if (y >= D.hipY + 0.015 * k) return D.trunkAt(y);
    const f = (D.hipY - y) / Math.max(0.01, D.hipY - hemY);
    return { rx: Math.max(hip.rx, 0.180 * k * (0.55 + 0.45 * D.s.hip)) + flare * f * 0.035 * k,
      fz: Math.max(hip.fz, 0.104 * k) + flare * f * 0.02 * k, bz: Math.max(hip.bz, 0.112 * k) + flare * f * 0.03 * k };
  };
}

/** A strip lying on the front of the trunk between two angles (a zip, a V). */
function frontStrip(M, D, y0, y1, half, t, c, steps = 5) {
  const verts = [], tris = [];
  for (let i = 0; i <= steps; i++) {
    const y = lerp(y0, y1, i / steps), a = D.trunkAt(y), h = typeof half === 'function' ? half(i / steps) : half;
    const x = Math.min(h, a.rx * 0.8), z = -(a.fz + t) * Math.sqrt(Math.max(0, 1 - (x / (a.rx + t)) ** 2)) - 0.004 * D.k;
    const b = trunkBone(D, y);
    verts.push([-x, y, z, c, b], [x, y, z, c, b]);
    if (i) { const q = i * 2; tris.push([q - 2, q + 1, q - 1], [q - 2, q, q + 1]); }
  }
  M.poly(verts, tris, c, BONE.chest, { normal: [0, 0.1, -1] });
}

function trunk(M, D, o) {
  const k = D.k, G = TOPS[o.top] ?? TOPS.tee;
  const tucked = (o.top === 'shirt' || o.top === 'tee') && (o.arch === 'm60' || o.arch === 'm90');
  const skirt = o.bottom === 'skirt';
  const hemY = tucked ? D.beltY + 0.004 * k
    : G.hem === 'hip' ? D.hipY + 0.035 * k : G.hem === 'low' ? D.hipY - 0.015 * k
      : G.hem === 'thigh' ? D.kneeY + (o.fem ? 0.10 : 0.16) * k
        : D.kneeY + (o.arch === 'f30' ? 0.07 : -0.03) * k;
  const t = G.t * k, tb = (o.bottom === 'leggings' ? 0.003 : 0.008) * k;
  const ysAll = D.trunk.map((r) => r.y).reverse();          // top to bottom

  // ---- hips: what the trousers (or the tights) look like above the legs ----
  if (!skirt) {
    const topY = Math.max(D.beltY + 0.03 * k, Math.min(hemY + 0.05 * k, D.waistY));
    const ys = [topY, ...ysAll.filter((y) => y < topY - 0.005)];
    const pieces = [];
    const bc = skirt ? shade(o.bottomColor, 0.8) : o.bottomColor;
    // under the top the hips are drawn a size smaller, or a thin shirt and
    // the trousers below it would be the same surface fighting for the pixel
    if (tucked) pieces.push({ to: D.beltY + 0.004 * k, t: -0.008 * k, c: bc }, { to: D.beltY - 0.022 * k, t: tb + 0.003 * k, c: BELT });
    else pieces.push({ to: hemY + 0.010 * k, t: -0.008 * k, c: bc });
    pieces.push({ to: -1, t: tb, c: bc });
    const rings = bonesFor(D, stack(ys, D.trunkAt, pieces, k));
    cap(rings, 0.01 * k, 0.03 * k);
    M.tube(rings, { segs: 10, b: BONE.pelvis, far: farCap(rings.length) });
    if (tucked) {     // the buckle: one bright square is the whole belt at 10 m
      const a = D.trunkAt(D.beltY - 0.01 * k), z = -(a.fz + tb + 0.008 * k), s = 0.016 * k, y = D.beltY - 0.009 * k;
      M.fan([[-s, y - s, z], [s, y - s, z], [s, y + s, z], [-s, y + s, z]], 0xb9b2a0, BONE.pelvis, { normal: [0, 0, -1] });
    }
  }

  // ---- a skirt worn under a short top ----
  if (skirt && o.top !== 'dress') {
    const sh = D.kneeY + (o.arch === 'f30' ? 0.12 : -0.03) * k;
    // under a coat the skirt hangs straight and thin, or its flare comes
    // through the coat's own tail
    const under = G.hem === 'thigh';
    const at = tailAt(D, sh, under ? 0.2 : o.arch === 'f30' ? 0.5 : 1);
    const ys = [D.beltY + 0.02 * k, D.beltY - 0.03 * k, D.hipY + 0.015 * k, lerp(D.hipY, sh, 0.5), sh];
    const rings = bonesFor(D, stack(ys, at, [{ to: -1, t: (under ? 0.003 : 0.012) * k, c: o.bottomColor }], k));
    const dark = shade(o.bottomColor, 0.35), last = rings[rings.length - 1];
    last.c2 = dark;
    rings.unshift({ ...rings[0], y: rings[0].y + 0.01 * k, rx: 0, fz: 0, bz: 0 });
    rings.push({ ...last, y: last.y + 0.01 * k, rx: 0, fz: 0, bz: 0, c: dark, c2: undefined });
    M.tube(rings, { segs: 12, phase: 0.5, far: [0, 1, 3, rings.length - 2, rings.length - 1] });
  }

  // ---- the top itself ----
  // any hem below the hip ring has to clear the tops of the thighs, so it
  // takes the widened section; only a real tail gets the dark underside
  const long = hemY < D.hipY - 0.08 * k;
  const at = hemY < D.hipY + 0.01 * k ? tailAt(D, hemY, G.hem === 'knee' ? 1 : G.hem === 'thigh' ? 0.7 : 0) : D.trunkAt;
  const ys = ysAll.filter((y) => y > hemY + 0.012 * k);
  if (long) ys.push(lerp(D.hipY, hemY, 0.5));
  ys.push(hemY);
  const col = o.topColor, pieces = [];
  // from the neck down: a crew neck shows skin, everything else its own cloth
  const neckC = G.collar === 'crew' ? o.skin : col;
  pieces.push({ to: D.neckY - 0.006 * k, t, c: neckC });
  if (o.yoke) pieces.push({ to: D.chestY + 0.035 * k, t, c: o.yoke });
  if (o.vest) {
    pieces.push({ to: D.chestY - 0.01 * k, t: t + 0.004 * k, c: o.vest });
    pieces.push({ to: D.chestY - 0.055 * k, t: t + 0.004 * k, c: o.strips });
    pieces.push({ to: D.waistY + 0.02 * k, t: t + 0.004 * k, c: o.vest });
    pieces.push({ to: D.waistY - 0.03 * k, t: t + 0.004 * k, c: o.strips });
    pieces.push({ to: D.beltY, t: t + 0.004 * k, c: o.vest });
  } else if (o.strips) {
    pieces.push({ to: D.chestY - 0.02 * k, t, c: col });
    pieces.push({ to: D.chestY - 0.065 * k, t, c: o.strips });
  }
  if (G.rib && !long) {
    pieces.push({ to: hemY + 0.045 * k, t, c: col, quilt: G.quilt });
    pieces.push({ to: hemY, t: t * 0.8, c: shade(col, 0.82) });
  } else pieces.push({ to: hemY, t, c: col, quilt: G.quilt });
  const rings = bonesFor(D, stack(ys, at, pieces, k));
  // close the hem: a shaded lip back in to the body, then a dark floor
  const last = rings[rings.length - 1], a0 = at(hemY), dark = shade(col, long ? 0.32 : 0.5);
  last.c2 = dark;
  const inner = { y: hemY + 0.004 * k, rx: a0.rx * (long ? 0.6 : 0.97), fz: a0.fz * (long ? 0.6 : 0.97), bz: a0.bz * (long ? 0.6 : 0.97), c: dark };
  const pole = { ...inner, y: hemY + 0.02 * k, rx: 0, fz: 0, bz: 0 };
  if (long) { inner.bf = last.bf; pole.bf = last.bf; } else { inner.b = last.b; pole.b = last.b; }
  rings.push(inner, pole);
  rings.unshift({ ...rings[0], y: rings[0].y + 0.006 * k, rx: 0, fz: 0, bz: 0 });
  const far = [0, 1];
  for (let i = 2; i < rings.length - 3; i++) if (!G.quilt ? i % 2 === 0 : i % 6 === 0) far.push(i);
  far.push(rings.length - 3, rings.length - 1);
  M.tube(rings, { segs: 12, phase: 0.5, far: [...new Set(far)] });

  // ---- what the front says about the garment ----
  const neckY = D.shoulderTopY + 0.005 * k;
  if (G.front === 'zip' && !o.vest) {
    if (o.open) {
      // worn open: a wedge of shirt from the collar, narrowing to the hem
      frontStrip(M, D, Math.max(hemY, D.beltY - 0.03 * k), neckY, (f) => (0.012 + 0.058 * f * f) * k, t, o.top2, 6);
    } else frontStrip(M, D, Math.max(hemY, D.crotchY), neckY, 0.006 * k, t, shade(col, 0.5));
  } else if (G.front === 'placket') {
    frontStrip(M, D, hemY, neckY, 0.011 * k, t, shade(col, 1.12));
  } else if (G.front === 'pocket') {
    frontStrip(M, D, D.beltY - 0.01 * k, D.beltY + 0.10 * k, 0.085 * k, t, shade(col, 0.84), 2);
    for (const sx of [-1, 1]) {
      const x = sx * 0.022 * k, y1 = D.shoulderTopY - 0.03 * k, y0 = y1 - 0.13 * k, w = 0.004 * k;
      const z = (y) => -(D.trunkAt(y).fz + t) - 0.005 * k;
      M.fan([[x - w, y0, z(y0)], [x + w, y0, z(y0)], [x + w, y1, z(y1)], [x - w, y1, z(y1)]], 0xd8d4c8, BONE.chest, { normal: [0, 0, -1] });
    }
  }
  // collars
  const nb = D.trunkAt(D.neckY);
  if (G.collar === 'stand' || G.collar === 'shirt') {
    const h = (G.collar === 'stand' ? 0.05 : 0.032) * k, e = (G.collar === 'stand' ? 0.022 : 0.012) * k;
    const c = G.collar === 'shirt' ? shade(col, 1.1) : col;
    M.tube([
      { y: D.neckY - 0.022 * k, rx: nb.rx + e * 1.4, fz: nb.fz + e * 1.2, bz: nb.bz + e * 1.5, c },
      { y: D.neckY + h, rx: nb.rx + e, fz: nb.fz + e * (o.open ? 0.3 : 1), bz: nb.bz + e * 1.2, c, c2: shade(c, 0.6) },
      { y: D.neckY + h, rx: nb.rx + 0.002, fz: nb.fz * 0.6, bz: nb.bz + 0.002, c: shade(c, 0.6) },
    ], { segs: 10, b: BONE.chest, far: false });
  } else if (G.collar === 'hood') {
    M.blob(0, D.shoulderTopY - 0.005 * k, 0.095 * k, 0.10 * k * D.s.sh, 0.062 * k, 0.055 * k, shade(col, 0.94), BONE.chest, { segs: 8, rings: 4, far: true });
    M.tube([
      { y: D.neckY - 0.02 * k, rx: nb.rx + 0.03 * k, fz: nb.fz + 0.022 * k, bz: nb.bz + 0.03 * k, c: col },
      { y: D.neckY + 0.03 * k, rx: nb.rx + 0.02 * k, fz: nb.fz + 0.006 * k, bz: nb.bz + 0.03 * k, c: col },
    ], { segs: 10, b: BONE.chest, far: false });
  }
  return { hemY, t };
}

function legs(M, D, o, hemY) {
  const k = D.k, L = D.limb;
  const bt = o.bottom, skirt = bt === 'skirt', cloth = bt === 'trousers' || bt === 'jeans' || bt === 'leggings';
  const tt = (bt === 'leggings' ? 0.002 : bt === 'jeans' ? 0.006 : bt === 'shorts' ? 0.009 : 0.010) * k;
  const tights = o.arch === 'f60' || o.arch === 'm90';
  const skin = skirt && tights ? mix(o.skin, 0x54463f, 0.5) : o.skin;
  const skirtHem = o.top === 'dress' ? hemY : D.kneeY + (o.arch === 'f30' ? 0.12 : -0.03) * k;
  const boots = o.shoes === 'boot' && !(bt === 'trousers' || bt === 'jeans');
  const sock = o.shoes === 'sneaker' && !cloth;
  const sole = o.shoes === 'sneaker' ? 0xe9e6de : shade(o.shoeColor, 0.55);
  for (const sx of [-1, 1]) {
    const x = sx * D.hipX;
    const [bl, bk, bf] = sx < 0 ? [BONE.legL, BONE.kneeL, BONE.footL] : [BONE.legR, BONE.kneeR, BONE.footR];
    // thigh (not built at all under a skirt that reaches the knee)
    if (!(skirt && skirtHem < D.kneeY + 0.08 * k)) {
      const sec = [[D.hipY + 0.045 * k, 0.060 * L * k], [D.hipY - 0.03 * k, 0.084 * L * k, 1.06],
        [lerp(D.hipY, D.kneeY, 0.52), 0.070 * L * k], [D.kneeY + 0.05 * k, 0.057 * L * k], [D.kneeY, 0.054 * L * k]];
      const pieces = cloth ? [{ to: -1, t: tt, c: o.bottomColor }]
        : bt === 'shorts' ? [{ to: D.kneeY + 0.10 * k, t: tt, c: o.bottomColor }, { to: -1, t: 0, c: skin }]
          : [{ to: -1, t: 0, c: skin }];
      const rings = cap(stack(sec.map((s) => s[0]), roundAt(sec), pieces, k), 0.035 * k, 0.045 * k);
      // denim fades on the front of the thigh
      if (bt === 'jeans') { const m = rings[4]; if (m) m.cf = (j, S) => (j === 0 || j === 1 || j === S - 1 ? shade(o.bottomColor, 1.22) : o.bottomColor); }
      for (const r of rings) r.x = x;
      M.tube(rings, { segs: 8, b: bl, far: farCap(rings.length) });
    }
    // shin
    {
      const sec = [[D.kneeY + 0.02 * k, 0.053 * L * k], [D.kneeY - 0.11 * k, 0.055 * L * k, 1.14],
        [D.ankleY + 0.12 * k, 0.040 * L * k], [D.ankleY + 0.03 * k, 0.036 * L * k]];
      // straight-cut trousers do not follow the calf down to the ankle
      if (bt === 'trousers' || bt === 'jeans') { const w = (bt === 'jeans' ? 0.040 : 0.045) * k * (0.6 + 0.4 * L); sec[2][1] = Math.max(sec[2][1], w); sec[3][1] = Math.max(sec[3][1], w + 0.002 * k); }
      const pieces = [];
      if (cloth) {
        if (o.strips) pieces.push({ to: D.kneeY - 0.16 * k, t: tt, c: o.bottomColor }, { to: D.kneeY - 0.21 * k, t: tt, c: o.strips });
        pieces.push({ to: -1, t: tt, c: o.bottomColor });
      } else if (boots) pieces.push({ to: D.ankleY + 0.17 * k, t: 0, c: skin }, { to: -1, t: 0.008 * k, c: o.shoeColor });
      else if (sock) pieces.push({ to: D.ankleY + 0.10 * k, t: 0, c: skin }, { to: -1, t: 0.004 * k, c: 0xdedbd2 });
      else pieces.push({ to: -1, t: 0, c: skin });
      const rings = cap(stack(sec.map((s) => s[0]), roundAt(sec), pieces, k), 0.04 * k, 0.03 * k);
      for (const r of rings) r.x = x;
      M.tube(rings, { segs: 8, b: bk, far: farCap(rings.length) });
    }
    // shoe: a tube lying along -z. In its own frame y runs heel to toe, the
    // ring's "front" is the sole and its "back" the upper.
    {
      const q = k * D.s.shoe, hc = 0.040 * k, up = o.shoes === 'boot' ? 1.25 : 1;
      const c = o.shoeColor, cf = (j, S) => (j <= 1 || j === S - 1 ? sole : c);
      const R = (y, rx, top) => ({ y: y * q, rx: rx * q, fz: hc - 0.002 * k, bz: top * q * up, cf });
      const rings = [{ ...R(-0.070, 0, 0), rx: 0, fz: 0, bz: 0 }, R(-0.060, 0.032, 0.040), R(-0.020, 0.043, 0.058), R(0.045, 0.047, 0.044),
        R(0.115, 0.050, 0.028), R(0.170, 0.045, 0.016), R(0.202, 0.030, 0.006), { ...R(0.214, 0, 0), rx: 0, fz: 0, bz: 0 }];
      M.tube(rings, { segs: 8, p: 2.6, b: bf, m: SHOE_M.makeRotationX(-Math.PI / 2).setPosition(x, hc, 0), far: [0, 2, 4, 7] });
    }
  }
}

function arms(M, D, o, t) {
  const k = D.k, L = D.limb, G = TOPS[o.top] ?? TOPS.tee;
  const ts = t * 0.85, col = o.topColor;
  const short = G.sleeve === 'short';
  for (const sx of [-1, 1]) {
    const x = sx * (D.shoulderX + 0.004 * k);
    const [ba, be, bh] = sx < 0 ? [BONE.armL, BONE.elbowL, BONE.handL] : [BONE.armR, BONE.elbowR, BONE.handR];
    {
      const sec = [[D.shoulderY + 0.010 * k, 0.042 * L * k], [D.shoulderY - 0.040 * k, 0.049 * L * k],
        [lerp(D.shoulderY, D.elbowY, 0.6), 0.043 * L * k], [D.elbowY + 0.03 * k, 0.039 * L * k], [D.elbowY, 0.037 * L * k]];
      const pieces = [];
      if (o.yoke) pieces.push({ to: D.shoulderY - 0.05 * k, t: ts, c: o.yoke });
      if (short) pieces.push({ to: D.shoulderY - 0.13 * k, t: ts + 0.002 * k, c: col }, { to: -1, t: 0, c: o.skin });
      else {
        if (o.strips) pieces.push({ to: D.shoulderY - 0.15 * k, t: ts, c: col }, { to: D.shoulderY - 0.195 * k, t: ts, c: o.strips });
        pieces.push({ to: -1, t: ts, c: col, quilt: G.quilt });
      }
      const rings = cap(stack(sec.map((s) => s[0]), roundAt(sec), pieces, k), 0.030 * k, 0.035 * k);
      for (const r of rings) r.x = x;
      M.tube(rings, { segs: 8, b: ba, far: farCap(rings.length) });
    }
    {
      const sec = [[D.elbowY + 0.012 * k, 0.037 * L * k], [D.elbowY - 0.07 * k, 0.039 * L * k],
        [D.wristY + 0.05 * k, 0.029 * L * k], [D.wristY + 0.005 * k, 0.026 * L * k]];
      const pieces = short ? [{ to: -1, t: 0, c: o.skin }]
        : G.rib ? [{ to: D.wristY + 0.045 * k, t: ts, c: col }, { to: -1, t: ts * 0.7, c: shade(col, 0.82) }]
          : [{ to: -1, t: ts, c: col }];
      const rings = cap(stack(sec.map((s) => s[0]), roundAt(sec), pieces, k), 0.03 * k, 0.012 * k);
      for (const r of rings) r.x = x;
      M.tube(rings, { segs: 8, b: be, far: farCap(rings.length) });
    }
    // hand: a mitt, flat toward the thigh, and a thumb that gives it a front
    const hy = D.wristY - 0.082 * k * (0.9 + 0.1 * L);
    M.blob(x, hy, -0.004 * k, 0.022 * k * (0.8 + 0.2 * L), 0.094 * k, 0.045 * k * (0.8 + 0.2 * L), o.skin, bh, { segs: 6, rings: 4, far: true });
    M.blob(x - sx * 0.006 * k, D.wristY - 0.060 * k, -0.040 * k, 0.012 * k, 0.034 * k, 0.014 * k, o.skin, bh, { segs: 5, rings: 3 });
  }
}

/** Trunk, limbs, clothes and whatever is carried. Returns the top's hem. */
export function buildBody(M, D, o) {
  const { hemY, t } = trunk(M, D, o);
  legs(M, D, o, hemY);
  arms(M, D, o, t);
  buildExtras(M, D, o, t);
  return hemY;
}
