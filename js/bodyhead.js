// ---- bodyhead.js: skull, face, hair and what is worn on it -----------------
//
// The old head was a cube with a box for a nose. This one is a skull lofted
// through nine rings (a jaw narrower than the cranium, a face flatter than the
// back of the head) with the features laid ON it: eyes with a white, an iris
// and a lid line, brows, a nose with a tip, a mouth, ears. At three metres it
// is a face; at thirty it is still a head with a front, which is the job the
// old figure's oversized cartoon eyes were doing.
//
// HAIR IS A SHELL ROUND THE SKULL, NOT A LID ON IT. One tube from the crown
// down, a centimetre or two proud of the scalp, and wherever a style has no
// hair (the face, a bald crown) that part of the ring is sunk inside the head,
// so the hairline is simply where the shell dives under the skin. A long style
// is the same tube carried on past the jaw as a curtain behind the shoulders.

import { BONE } from './bodyshape.js';
import { shade, mix } from './bodymesh.js';

const lerp = (a, b, t) => a + (b - a) * t;

// u (0 chin .. 1 crown), half width, face depth, back depth, centre offset;
// metres on the reference head
const SKULL = [
  [0.00, 0.026, 0.030, 0.022, -0.040],
  [0.08, 0.050, 0.050, 0.050, -0.022],
  [0.22, 0.064, 0.076, 0.070, -0.008],
  [0.38, 0.072, 0.086, 0.086, 0.000],
  [0.54, 0.076, 0.086, 0.096, 0.002],
  [0.70, 0.077, 0.088, 0.100, 0.004],
  [0.84, 0.071, 0.078, 0.094, 0.006],
  [0.94, 0.052, 0.054, 0.070, 0.008],
];
const P = 2.25;       // the skull's superellipse: a little squarer than round

// Where each style HAS hair: (a = angle from the face 0..PI, u) => boolean,
// plus how thick it sits and how far down it goes.
const side = (a, f, t, s, b) => (a < 0.55 ? f : a < 1.15 ? lerp(f, t, (a - 0.55) / 0.6) : a < 1.95 ? lerp(t, s, Math.min(1, (a - 1.15) / 0.3)) : lerp(s, b, Math.min(1, (a - 1.95) / 0.5)));
const STYLES = {
  short: { th: 0.011, end: 0.26, has: (a, u) => u > side(a, 0.80, 0.66, 0.56, 0.30) },
  crop: { th: 0.004, end: 0.28, has: (a, u) => u > side(a, 0.82, 0.68, 0.58, 0.32), stubble: 0.45 },
  part: { th: 0.016, end: 0.26, top: 0.008, has: (a, u) => u > side(a, 0.77, 0.64, 0.54, 0.28) },
  bald: { th: 0.008, end: 0.26, has: (a, u) => a > 1.05 && u < 0.72 && u > side(a, 0.9, 0.6, 0.5, 0.30) },
  curly: { th: 0.026, end: 0.30, lump: 0.10, has: (a, u) => u > side(a, 0.76, 0.56, 0.44, 0.32) },
  bob: { th: 0.016, end: -0.04, has: (a, u) => u > side(a, 0.78, 0.60, -1, -1) },
  long: { th: 0.014, end: -0.78, has: (a, u) => u > side(a, 0.80, 0.62, -2, -2) },
  pony: { th: 0.010, end: 0.26, has: (a, u) => u > side(a, 0.80, 0.64, 0.54, 0.34), tail: true },
  bun: { th: 0.010, end: 0.26, has: (a, u) => u > side(a, 0.80, 0.64, 0.54, 0.34), bun: true },
};

/** Build the head on M. Returns the height of the top of the hair or hat. */
export function buildHead(M, D, o, eye) {
  const hk = D.headK * 1.05, k = D.k, h = D.crownY - D.chinY, z0 = -0.012 * k;
  const fem = o.fem, jaw = fem ? 0.92 : o.arch === 'm60' ? 1.07 : 1;
  const B = BONE.head;
  // skull parameters at any u (clamped), already in metres
  const at = (u) => {
    const S = SKULL;
    let i = 1;
    while (i < S.length - 1 && u > S[i][0]) i++;
    const a = S[i - 1], b = S[i], f = Math.max(0, Math.min(1, (u - a[0]) / (b[0] - a[0])));
    const j = u < 0.4 ? lerp(jaw, 1, Math.max(0, u) / 0.4) : 1;
    return { rx: lerp(a[1], b[1], f) * hk * j, fz: lerp(a[2], b[2], f) * hk, bz: lerp(a[3], b[3], f) * hk, cz: z0 + lerp(a[4], b[4], f) * hk };
  };
  const yOf = (u) => D.chinY + u * h;
  // the face surface: z at (x, u), lifted `lift` off the skin
  const fz = (x, u, lift = 0) => { const a = at(u); return a.cz - a.fz * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / a.rx, P)), 1 / P) - lift; };

  // ---- neck and skull ----
  M.tube([
    { y: D.shoulderTopY - 0.014 * k, z: 0.012 * k, rx: D.neckR * 1.16, c: o.skin, b: BONE.chest },
    { y: lerp(D.shoulderTopY, D.chinY, 0.55), z: 0.004 * k, rx: D.neckR, c: o.skin, b: [BONE.chest, BONE.head, 0.5] },
    { y: D.chinY + 0.06 * h, z: -0.004 * k, rx: D.neckR * 0.98, c: o.skin, b: B },
  ], { segs: 8, far: [0, 2] });
  const stub = o.beard ? mix(o.skin, o.hair, 0.42) : null;
  const rings = SKULL.map((s) => {
    const a = at(s[0]);
    const r = { y: yOf(s[0]), z: a.cz, rx: a.rx, fz: a.fz, bz: a.bz, c: o.skin, b: B };
    // a beard, the cheap way: the jaw's front half takes a little of the hair
    if (stub && s[0] < 0.36) r.cf = (j, S) => (Math.cos(j / S * Math.PI * 2) > -0.3 ? stub : o.skin);
    return r;
  });
  rings.unshift({ ...rings[0], y: yOf(-0.02), rx: 0, fz: 0, bz: 0 });
  rings.push({ y: D.crownY, z: z0 + 0.008 * hk, rx: 0, c: o.skin, b: B });
  M.tube(rings, { segs: 12, p: P, far: [0, 2, 4, 6, 8, 9] });

  // ---- face ----
  const ue = 0.545, xe = 0.031 * hk, ye = yOf(ue);
  if (eye) {
    const headY = D.shoulderTopY + .012 * k, headZ = .008 * k;
    Object.assign(eye, {
      x: xe, y: ye - headY, z: fz(xe, ue, .005 * hk) - headZ,
      lipY: yOf(.235) - headY,
      surface: (x, y) => fz(x, (y + headY - D.chinY) / h) - headZ,
    });
  }
  const lid = mix(o.skin, 0x1a1210, 0.72);
  const browC = o.arch === 'm90' ? 0xa9a59c : (o.arch === 'm60' || o.arch === 'f60') ? mix(o.hair, 0x3a3530, 0.5) : shade(o.hair, 0.8);
  const flat = { normal: [0, 0, -1] };
  const oval = (cx, cy, rx, ry, n, lift) => {
    const v = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
      v.push([x, y, fz(x, (y - D.chinY) / h, lift)]);
    }
    return v;
  };
  const bar = (cx, cy, hw, hh, tilt, lift) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = cx + sx * hw, y = cy + sy * hh + sx * tilt * (cx < 0 ? -1 : 1);
    return [x, y, fz(x, (y - D.chinY) / h, lift)];
  });
  for (const sx of [-1, 1]) {
    M.fan(oval(sx * xe, ye, 0.0140 * hk, 0.0066 * hk, 8, 0.0030 * hk), 0xf2efe6, B, flat);
    M.fan(oval(sx * xe, ye, 0.0062 * hk, 0.0062 * hk, 6, 0.0048 * hk), o.eyes ?? 0x3a2a1c, B, flat);
    M.fan(bar(sx * xe, ye + 0.0078 * hk, 0.0165 * hk, 0.0020 * hk, -0.0012 * hk, 0.0056 * hk), lid, B, flat);
    M.fan(bar(sx * xe * 1.03, ye + 0.0215 * hk, 0.0195 * hk, (fem ? 0.0026 : 0.0042) * hk, -0.0022 * hk, 0.0040 * hk), browC, B, flat);
    // ear
    const a = at(0.50);
    M.blob(sx * (a.rx + 0.003 * hk), yOf(0.50), a.cz + 0.014 * hk, 0.008 * hk, 0.027 * hk, 0.015 * hk, shade(o.skin, 0.96), B, { segs: 5, rings: 3 });
  }
  // mouth
  const um = 0.235, lip = mix(o.skin, 0x8a3a35, fem ? 0.72 : 0.5);
  M.fan(bar(0, yOf(um), 0.021 * hk, (fem ? 0.0056 : 0.0042) * hk, 0, 0.0030 * hk), lip, B, flat);
  // nose: bridge, tip and the two wings
  {
    const yb = yOf(0.60), yt = yOf(0.375), yu = yOf(0.335), w = 0.0155 * hk;
    const zb = fz(0, 0.60, 0.004 * hk), zt = fz(0, 0.375, 0.026 * hk), zu = fz(0, 0.335, 0.004 * hk), zw = fz(w, 0.36, 0.002 * hk);
    const c2 = shade(o.skin, 0.9);
    M.poly([[0, yb, zb], [0, yt, zt], [-w, yOf(0.36), zw], [w, yOf(0.36), zw], [0, yu, zu, c2], [-0.006 * hk, yb, fz(0.006 * hk, 0.6, 0)], [0.006 * hk, yb, fz(0.006 * hk, 0.6, 0)]],
      [[0, 2, 1], [0, 1, 3], [1, 2, 4], [1, 4, 3], [0, 5, 2], [0, 3, 6]], o.skin, B, { from: [0, yOf(0.47), zb + 0.03 * hk] });
  }
  // ---- glasses ----
  if (o.glasses) {
    const c = 0x1c1a19, hw = 0.021 * hk, hh = 0.0145 * hk, t = 0.0028 * hk, L = 0.011 * hk;
    const q = (x0, y0, x1, y1) => M.fan([[x0, y0, fz(x0, (y0 - D.chinY) / h, L)], [x1, y0, fz(x1, (y0 - D.chinY) / h, L)], [x1, y1, fz(x1, (y1 - D.chinY) / h, L)], [x0, y1, fz(x0, (y1 - D.chinY) / h, L)]], c, B, flat);
    for (const sx of [-1, 1]) {
      const cx = sx * xe;
      q(cx - hw, ye + hh - t, cx + hw, ye + hh + t); q(cx - hw, ye - hh - t, cx + hw, ye - hh + t);
      q(cx - hw - t, ye - hh, cx - hw + t, ye + hh); q(cx + hw - t, ye - hh, cx + hw + t, ye + hh);
      // the arm back to the ear
      const a = at(ue), x = sx * (a.rx + 0.004 * hk), zf = fz(cx + sx * hw, ue, L), zb = a.cz + 0.02 * hk;
      M.fan([[x, ye + 0.006 * hk, zf], [x, ye + 0.006 * hk, zb], [x, ye + 0.011 * hk, zb], [x, ye + 0.011 * hk, zf]], c, B, { normal: [sx, 0, 0] });
    }
    q(-xe + hw, ye + 0.004 * hk, xe - hw, ye + 0.008 * hk);
  }

  // ---- hair ----
  const hat = o.hat;
  const st = STYLES[o.hairStyle] ?? STYLES.short;
  const domed = hat === 'cap' || hat === 'beanie' || hat === 'flat' || hat === 'police' || hat === 'scarf';
  const th = (domed ? Math.min(st.th, 0.008) : st.th) * hk;
  const hc = st.stubble ? mix(o.hair, o.skin, st.stubble) : o.hair;
  let top = D.crownY;
  const shell = (us, thick, has, col, o2 = {}) => {
    const rs = [{ y: yOf(1) + thick + (o2.top ?? 0), z: z0 + 0.008 * hk, rx: 0, c: col, b: B }];
    for (const u of us) {
      const a = at(Math.max(u, 0.24)), below = Math.max(0, 0.24 - u);
      const r = { y: yOf(u) + (u > 0.9 ? (o2.top ?? 0) : 0), z: a.cz + below * 0.045 * hk, rx: a.rx + thick + (u > 0.8 ? (o2.top ?? 0) * 0.6 : 0),
        fz: a.fz + thick, bz: a.bz + thick + (u > 0.8 ? 0 : 0) + below * 0.02 * hk, c: u < 0.1 ? shade(col, 0.9) : col,
        b: u < -0.05 ? [BONE.head, BONE.chest, Math.max(0.25, 1 + u)] : B };
      // where there is no hair the ring goes under the skin, whatever its thickness
      const sink = 0.84 * Math.min(a.rx / r.rx, a.fz / r.fz, a.bz / r.bz);
      r.rf = (j, S) => {
        let ang = j / S * Math.PI * 2; if (ang > Math.PI) ang = Math.PI * 2 - ang;
        if (!has(ang, u)) return sink - below * 0.5;
        return o2.lump ? 1 + o2.lump * (0.5 + 0.5 * Math.sin(j * 2.4 + u * 23)) : 1;
      };
      rs.push(r);
    }
    const last = rs[rs.length - 1];
    rs.push({ ...last, y: last.y - 0.004 * hk, rx: last.rx * 0.7, fz: last.fz * 0.7, bz: last.bz * 0.7, rf: undefined, c: shade(col, 0.7) });
    const n = rs.length;
    M.tube(rs, { segs: 12, p: P, far: o2.far ?? [...new Set([0, 2, Math.min(4, n - 2), n - 2])] });
    top = Math.max(top, rs[0].y);
  };
  const steps = (end) => {
    const us = [0.95, 0.86, 0.74, 0.62, 0.50, 0.38];
    if (end < 0.2) us.push(0.26, 0.12);
    if (end < 0) { for (let u = -0.04; u > end + 0.05; u -= 0.16) us.push(u); }
    us.push(end);
    return us.filter((u, i) => i === us.length - 1 || u > end + 0.03);
  };
  if (hat !== 'scarf') shell(steps(st.end), th, st.has, hc, { top: (st.top ?? 0) * hk, lump: st.lump });
  const back = at(0.62);
  if (st.tail) {
    const zb = back.cz + back.bz + 0.006 * hk, y = yOf(0.66);
    M.tube([{ y: y + 0.02 * hk, z: zb - 0.01 * hk, rx: 0, c: hc, b: B }, { y, z: zb + 0.012 * hk, rx: 0.024 * hk, c: hc, b: B },
      { y: y - 0.07 * hk, z: zb + 0.03 * hk, rx: 0.026 * hk, c: hc, b: B }, { y: y - 0.17 * hk, z: zb + 0.022 * hk, rx: 0.018 * hk, c: hc, b: [BONE.head, BONE.chest, 0.6] },
      { y: y - 0.22 * hk, z: zb + 0.016 * hk, rx: 0, c: hc, b: [BONE.head, BONE.chest, 0.6] }], { segs: 6, far: [0, 2, 4] });
  }
  if (st.bun) M.blob(0, yOf(0.80), back.cz + back.bz + 0.012 * hk, 0.036 * hk, 0.034 * hk, 0.034 * hk, hc, B, { segs: 6, rings: 4, far: true });

  // ---- hats ----
  if (hat === 'cap' || hat === 'flat' || hat === 'beanie' || hat === 'police') {
    const c = o.hatColor, edge = hat === 'beanie' ? 0.66 : hat === 'police' ? 0.74 : 0.75, ht = (hat === 'beanie' ? 0.017 : 0.014) * hk;
    const all = () => true;
    if (hat === 'police') {
      // a peaked cap: band, a crown that flares out over it, a flat top
      const a = at(edge), b2 = at(0.90);
      M.tube([{ y: yOf(edge), z: a.cz, rx: a.rx + ht, fz: a.fz + ht, bz: a.bz + ht, c: 0x10151f, b: B },
        { y: yOf(0.86), z: b2.cz, rx: a.rx + ht, fz: a.fz + ht, bz: a.bz + ht, c: 0x10151f, c2: c, b: B },
        { y: yOf(1.04), z: b2.cz - 0.004 * hk, rx: a.rx + 0.032 * hk, fz: a.fz + 0.040 * hk, bz: a.bz + 0.022 * hk, c, b: B },
        { y: yOf(1.07), z: b2.cz, rx: a.rx + 0.022 * hk, fz: a.fz + 0.026 * hk, bz: a.bz + 0.014 * hk, c, b: B },
        { y: yOf(1.075), z: b2.cz, rx: 0, c, b: B }], { segs: 12, p: 2.1, far: [0, 2, 4] });
      top = Math.max(top, yOf(1.075));
      // the badge
      const yb = yOf(0.95), zb = a.cz - a.fz - 0.034 * hk, s = 0.013 * hk;
      M.fan([[-s, yb - s, zb], [s, yb - s, zb], [s, yb + s, zb - 0.004 * hk], [-s, yb + s, zb - 0.004 * hk]], 0xc9c2a2, B, flat);
    } else {
      const us = hat === 'beanie' ? [0.95, 0.86, 0.76, 0.70, edge] : [0.95, 0.86, 0.80, edge];
      shell(us, ht, all, c, { top: (hat === 'beanie' ? 0.012 : hat === 'flat' ? -0.004 : 0.004) * hk, far: [0, 2, us.length, us.length + 1] });
      if (hat === 'beanie') {     // the turned-up cuff
        const a = at(edge), b2 = at(0.74);
        M.tube([{ y: yOf(edge) - 0.002 * hk, z: a.cz, rx: a.rx + ht * 1.5, fz: a.fz + ht * 1.5, bz: a.bz + ht * 1.5, c: shade(c, 0.85), b: B },
          { y: yOf(0.745), z: b2.cz, rx: b2.rx + ht * 1.5, fz: b2.fz + ht * 1.5, bz: b2.bz + ht * 1.5, c: shade(c, 0.85), b: B },
          { y: yOf(0.75), z: b2.cz, rx: b2.rx + ht * 0.9, fz: b2.fz + ht * 0.9, bz: b2.bz + ht * 0.9, c: shade(c, 0.7), b: B }], { segs: 12, p: P, far: false });
      }
    }
    if (hat !== 'beanie') {
      // the peak: a tongue of cloth out over the brow, top and underside
      const a = at(edge), y = yOf(edge) + 0.002 * hk, len = (hat === 'flat' ? 0.045 : hat === 'police' ? 0.058 : 0.072) * hk;
      const vc = hat === 'police' ? 0x0c0d10 : shade(c, 0.9), rim = [];
      for (let i = 0; i <= 6; i++) {
        const t = -1 + i / 3, x = t * (a.rx + ht) * 0.88;
        rim.push([x, y, a.cz - (a.fz + ht) * Math.sqrt(Math.max(0, 1 - t * t * 0.72))]);
      }
      const out = rim.map(([x, yy, z], i) => { const t = -1 + i / 3; return [x * 0.92, yy - 0.012 * hk, z - len * (1 - t * t * 0.75)]; });
      const verts = [...rim, ...out], tris = [];
      for (let i = 0; i < 6; i++) tris.push([i, i + 1, 7 + i + 1], [i, 7 + i + 1, 7 + i]);
      M.poly(verts, tris.map((t) => t.slice()), vc, B, { normal: [0, 1, -0.2] });
      M.poly(verts, tris.map((t) => t.slice()), shade(vc, 0.6), B, { normal: [0, -1, 0.2] });
    }
  } else if (hat === 'scarf') {
    // šátek: the whole head wrapped, the face left open, a fringe of hair
    shell(steps(0.78), th, (a, u) => a < 1.1 && u > 0.70, hc, {});
    shell([0.95, 0.86, 0.74, 0.62, 0.50, 0.38, 0.24, 0.10, -0.02], 0.016 * hk, (a, u) => u > side(a, 0.76, 0.5, -1, -1), o.hatColor, {});
  }
  return top;
}
