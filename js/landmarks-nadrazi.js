// ---- landmarks-nadrazi.js: Pardubice hlavní nádraží ----
// The station of 1958 (Karel Řepa, Karel Kalvoda, Josef Danda), a protected
// monument and the first thing a new player sees: a long low departure hall
// glazed from pavement to roof between slim concrete piers, lit all night; the
// tall slab of the hotel standing at its western end; low service wings
// running away along the tracks on both sides; everything that is not glass
// faced in red and black ceramic that reads as brick.
//
// The footprint is a 305 m chain of rectangles, so the frame is taken from its
// longest wall (fitFrame byEdge) and every volume is a box in that frame:
// u runs WEST along the forecourt front, v north toward the city.

import { K } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { clockFace, storeys, rect } from './landmarks-parts.js';

const CLAD = 0x8f4b36, CLAD_DK = 0x34292a, CONCRETE = 0xd3cfc5, GLASS = 0x45586a;
// The roof sign is neon in dark channel letters: dark by day, when it has the
// sky and the pale lantern behind it (cream letters vanished against both),
// and its own light after dusk.
const SIGN = 0x1c2536;

// the three volumes that stand over the low wings, in the frame below: [u0, u1, v0, v1, height]
const HALL = [-50.5, 22, -25, 12.9, 10.6], HOTEL = [22, 55, -25, 12.5, 23.4], ANNEX = [-70.2, -50.5, -25, 8.5, 10.6];

// 5 x 7 capitals, only the ones the roof sign needs
const FONT = {
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
};

/** Free-standing letters on a roof edge: each run of lit cells is one bar. */
function sign(kit, F, text, uc, y0, v, cell, glow) {
  const adv = cell * 6.4, w = text.length * adv - cell * 1.4;
  let u = uc - w / 2;
  for (const ch of text) {
    const g = FONT[ch];
    if (g) for (let r = 0; r < 7; r++) {
      let c = 0;
      while (c < 5) {
        if (g[r][c] !== '#') { c++; continue; }
        let e = c;
        while (e < 5 && g[r][e] === '#') e++;
        kit.gl = glow;
        F.slab(rect(u + c * cell, y0 + (6 - r) * cell, u + e * cell, y0 + (7 - r) * cell), v - 0.18, v);
        c = e;
      }
    }
    u += adv;
  }
  kit.gl = 0;
}

export function buildNadrazi(kit, f) {
  const { F } = fitFrame(kit, f.o, 0, -1, true);
  // no monument lighting here, only what the forecourt lamps throw on the base
  kit.floodFn = (x, y) => (y < 5 ? 0.22 : 0.06);
  kit.lid = 0x55575a;
  const win = (n, o) => storeys(n, 1.1, 3.2, 1.8, 2.2, { hex: GLASS, dark: true, glow: 0.35, ...o });

  // ---- the departure hall -------------------------------------------------
  const [hu0, hu1, hv0, hv1, HH] = HALL;
  const curtain = { cols: 17, rows: [{ y: 0.15, h: 3.25, w: 3.7, hex: GLASS, dark: true, glow: 0.92, rev: 0.25 },
    { y: 4.25, h: 5.5, w: 3.7, hex: GLASS, dark: true, glow: 0.92, rev: 0.25 }], seed: 1 };
  kit.set(CONCRETE, K.plaster);
  // Open door bays on the forecourt and platform faces, under the upper glazing.
  for (const v of [hv0, hv1]) {
    F.box(hu0, -18, v-.1, v+.1, 0, HH, { f: { ...curtain, cols: 8 }, b: { ...curtain, cols: 8 } });
    F.box(-10, hu1, v-.1, v+.1, 0, HH, { f: { ...curtain, cols: 8 }, b: { ...curtain, cols: 8 } });
    F.box(-18,-10,v-.1,v+.1,3.4,HH);
  }
  F.box(hu0, hu1, hv0, hv1, HH-.26, HH, null, true, true);
  for (const u of [hu0, hu1]) F.box(u-.1,u+.1,hv0,hv1,0,HH);
  for (const u of [-41,-30,0,12]) {
    F.box(u,u+.15,hv0+2,hv1-2,HH-.45,HH-.26);
    for (const v of [hv0+4,hv1-5]) F.box(u-1.8,u+1.8,v,v+.62,.35,.52);
  }
  // the canopy over the doors, the whole length of the glass
  F.box(hu0 + 2, hu1 - 1.5, hv1, hv1 + 4.6, 3.55, 3.9, null, true, true);
  // the raised lantern that lights the hall from above
  const lant = { cols: 15, rows: [{ y: 0.45, h: 1.9, w: 3.3, hex: GLASS, dark: true, glow: 0.92 }], seed: 4 };
  F.box(hu0 + 6, hu1 - 6, hv0 + 8, hv1 - 7, HH, HH + 2.9, { f: lant, b: lant });
  // The name on a steel frame over the front edge. The forecourt's limes stand
  // 11 to 13 m tall between the tram stop and the doors: letters sitting on
  // the parapet (10.6 m) hid behind their crowns from everywhere a player
  // stands, so they ride a frame 1.6 m up and stand 4.3 m tall.
  const um = (hu0 + hu1) / 2, cell = 0.62, half = (9 * cell * 6.4 - cell * 1.4) / 2 + 0.6, sy = HH + 1.6;
  kit.set(0x3a3d42, K.metal);
  F.box(um - half, um + half, hv1 - 0.62, hv1 - 0.42, sy - 0.3, sy, null, true, true);           // the rail
  for (let u = um - half + 0.4; u <= um + half - 0.3; u += (2 * half - 0.8) / 9)                 // its posts
    F.box(u - 0.08, u + 0.08, hv1 - 0.62, hv1 - 0.46, HH, sy + 3.9, null, true);
  kit.set(SIGN, K.metal);
  sign(kit, F, 'PARDUBICE', um, sy, hv1 - 0.24, cell, 1);

  // ---- the hotel ----------------------------------------------------------
  const [tu0, tu1, tv0, tv1, TH] = HOTEL;
  const rooms = (cols, seed) => ({ cols, inset: 1.2, seed,
    rows: [{ y: 0.7, h: 3.3, w: 2.5, hex: GLASS, dark: true, glow: 0.6 }, ...storeys(6, 5.3, 2.95, 1.75, 2.0, { hex: GLASS, dark: true, glow: 0.3 })] });
  kit.set(CLAD, K.clad);
  F.box(tu0, tu1, tv0, tv1, 0, TH, { f: rooms(9, 11), b: rooms(9, 12), l: rooms(10, 13), r: rooms(10, 14) }, false);
  kit.set(CLAD_DK, K.clad);
  F.box(tu0 - 0.06, tu1 + 0.06, tv0 - 0.06, tv1 + 0.06, 0, 0.6, null, false);         // the black plinth
  kit.set(CONCRETE, K.plaster);
  F.box(tu0 - 0.5, tu1 + 0.5, tv0 - 0.5, tv1 + 0.5, TH, TH + 0.55, null, true, true);   // the roof slab
  F.box(tu0 + 9, tu1 - 9, tv0 + 12, tv1 - 12, TH + 0.55, TH + 3.2);                     // lift house
  clockFace(kit, F.sub(tu0 + 3.2, tv1, 0, 0), TH - 3.2, 1.35, 0xf1ede2);
  // the restaurant before it, one storey of glass with a terrace on the roof
  const cafe = { cols: 7, rows: [{ y: 0.3, h: 3.4, w: 3.0, hex: GLASS, dark: true, glow: 0.8, rev: 0.2 }], seed: 6 };
  kit.set(CONCRETE, K.plaster);
  F.box(tu0, 47.4, tv1, 23.5, 0, 4.7, { f: cafe, l: { ...cafe, cols: 3 }, r: { ...cafe, cols: 3 }, b: false });
  kit.set(CLAD_DK, K.metal);
  F.box(tu0, 47.4, 23.38, 23.5, 4.7, 5.7); F.box(47.28, 47.4, tv1, 23.5, 4.7, 5.7); F.box(tu0, tu0 + 0.12, tv1, 23.5, 4.7, 5.7);

  // ---- the service wings along the tracks ---------------------------------
  kit.set(CLAD, K.clad);
  F.box(ANNEX[0], ANNEX[1], ANNEX[2], ANNEX[3], 0, ANNEX[4], { f: { cols: 5, inset: 1, rows: win(3), seed: 21 }, b: { cols: 5, inset: 1, rows: win(3), seed: 22 },
    l: { cols: 8, inset: 1, rows: win(3), seed: 23 } });
  F.box(-152.8, -70.2, -24.8, -11.8, 0, 7.3, { f: { pitch: 3.7, inset: 1, rows: win(2), seed: 24 }, b: { pitch: 3.7, inset: 1, rows: win(2), seed: 25 },
    l: { cols: 3, rows: win(2), seed: 26 } });
  F.box(tu1, 100.3, -0.6, 12.4, 0, 7.6, { f: { pitch: 3.7, inset: 1, rows: win(2), seed: 27 }, b: { pitch: 3.7, inset: 1, rows: win(2), seed: 28 } });
  F.box(100.3, 110.3, -0.6, 26.8, 0, 7.6, { f: { cols: 2, rows: win(2), seed: 29 }, l: { cols: 4, inset: 0.5, rows: win(2), seed: 30 }, r: { cols: 7, rows: win(2), seed: 31 } });
  F.box(110.3, 152.8, -0.7, 12.4, 0, 6.4, { f: { pitch: 3.7, inset: 1, rows: win(2, { h: 1.6 }), seed: 32 }, b: { pitch: 3.7, inset: 1, rows: win(2, { h: 1.6 }), seed: 33 },
    r: { cols: 3, rows: win(2, { h: 1.6 }), seed: 34 } });
  // black ceramic along every foot, the way the red is carried on the real one
  kit.set(CLAD_DK, K.clad);
  for (const [a, b, c, d] of [[-70.26, hu0, hv0 - 0.06, 8.56], [-152.86, -70.2, -24.86, -11.74], [tu1, 100.3, -0.66, 12.46], [100.3, 110.36, -0.66, 26.86], [110.3, 152.86, -0.76, 12.46]])
    F.box(a, b, c, d, 0, 0.55, null, false);
}

/** Solid as built: the low wings to their roofs (l.top), the hall, its annex and the hotel over them. */
export function nadraziSolids(f, l) {
  const { F } = fitFrame(null, f.o, 0, -1, true);
  const over = ([u0, u1, v0, v1, top]) => ({ ring: F.ring(u0, u1, v0, v1), holes: null, top, bot: 0 });
  const [a,b,c,d,top]=HALL;
  const walls = [over(HOTEL),over(ANNEX), { ...over(HALL),bot:top-.26 }];
  for (const v of [c,d]) {
    walls.push(over([a,-18,v-.1,v+.1,top]),over([-10,b,v-.1,v+.1,top]),{ ...over([-18,-10,v-.1,v+.1,top]),bot:3.4 });
  }
  for (const u of [a,b]) walls.push(over([u-.1,u+.1,c,d,top]));
  for (const r of [[-152.8,-70.2,-24.8,-11.8,7.3],[55,100.3,-.6,12.4,7.6],[100.3,110.3,-.6,26.8,7.6],[110.3,152.8,-.7,12.4,6.4],[22,47.4,12.5,23.5,4.7]]) walls.push(over(r));
  return walls;
}
