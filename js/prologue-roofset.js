// The roof of the block of flats, dressed by hand: felt laid in strips, a
// flashed parapet, brick chimneys with their aerials, vents, a skylight, the
// stair head with its door, and twenty years of weather. Local frame as in
// prologue-route.js roofFrame: the end wall he stands on is z = 0, the roof
// runs back along +z, x is across (the wall is 9.6 m wide). y = 0 is the deck.
const felt = [0x2f3336, 0x34383a, 0x2b2f32],
  zinc = 0x8f9793,
  brick = 0x8b4c39,
  mortar = 0xa58f7c,
  rust = 0x7a4a2c,
  moss = 0x4c5a33;
// A repeatable scatter, so the stains are in the same place every night.
function scatter(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function chimney(k, x, z, h, pots) {
  k.box(x, 0.06, z, 1.02, 0.12, 1.22, 0x6f7774); // lead apron
  k.box(x, h / 2, z, 0.78, h, 0.98, brick);
  for (let y = 0.2; y < h - 0.1; y += 0.22) k.box(x, y, z, 0.8, 0.018, 1.0, mortar);
  k.box(x, h + 0.05, z, 0.98, 0.1, 1.18, 0xa7a59c);
  k.box(x, h + 0.105, z, 0.6, 0.012, 0.8, 0x2a2826); // soot
  for (let i = 0; i < pots; i++) {
    const pz = z + (i - (pots - 1) / 2) * 0.4;
    k.box(x, h + 0.27, pz, 0.22, 0.34, 0.22, 0xb0603f);
    k.box(x, h + 0.45, pz, 0.27, 0.04, 0.27, 0x9c5236);
  }
  // rain streak down the weather side
  k.box(x - 0.395, h * 0.55, z + 0.2, 0.012, h * 0.8, 0.16, 0x5e3327);
}

// A television aerial of the old kind: mast, boom and a comb of elements.
function aerial(k, x, z, base, h, flip) {
  k.box(x, base + h / 2, z, 0.035, h, 0.035, 0x9aa19f);
  const top = base + h - 0.12;
  k.box(x, top, z, 0.03, 0.03, 1.5, 0xb4bab7);
  for (let i = 0; i < 8; i++) k.box(x, top, z - 0.7 + i * 0.2, 0.62 - i * 0.045, 0.014, 0.014, 0xc3c8c5);
  k.box(x, top - 0.5, z, 0.03, 0.03, 0.8, 0xb4bab7);
  for (let i = 0; i < 4; i++) k.box(x, top - 0.5, z - 0.32 + i * 0.21, 0.92, 0.014, 0.014, 0xc3c8c5);
  k.box(x + flip * 0.2, base + h * 0.42, z, 0.4, 0.02, 0.02, 0x7d8483); // strap to the stack
}

function vent(k, x, z, h, wide = 0.16) {
  k.box(x, 0.03, z, wide + 0.2, 0.06, wide + 0.2, 0x6f7774);
  k.box(x, h / 2, z, wide, h, wide, zinc);
  k.box(x, h + 0.03, z, wide + 0.14, 0.05, wide + 0.14, 0x7c8582);
  k.box(x, h + 0.09, z, wide + 0.06, 0.1, wide + 0.06, zinc, 0, false, 'round');
}

export function dressRoof(k) {
  const rnd = scatter(20261118);
  // ---- the covering: felt strips across the roof, lapped, with tarred seams
  for (let i = 0; i < 26; i++) {
    const z = 0.82 + i * 0.98;
    k.box(0, 0.016, z, 8.94, 0.03, 0.97, felt[i % 3]);
    k.box(0, 0.034, z + 0.485, 8.94, 0.006, 0.045, 0x1e2123);
  }
  // newer patches, older blisters and standing water after the last rain
  for (const [x, z, w, d] of [
    [-2.9, 2.6, 1.5, 1.1],
    [3.1, 6.2, 1.2, 1.9],
    [-0.6, 11.4, 2.1, 1.3],
    [2.2, 17.5, 1.4, 1.0],
  ]) {
    k.box(x, 0.036, z, w, 0.01, d, 0x222527);
    k.box(x, 0.042, z, w + 0.06, 0.004, 0.03, 0x15181a);
  }
  for (const [x, z, w, d] of [
    [1.2, 3.3, 1.9, 1.2],
    [-3.2, 7.7, 1.3, 2.0],
    [0.4, 14.6, 2.4, 1.1],
  ])
    k.box(x, 0.04, z, w, 0.006, d, 0x596a74, 0, false, 'glass');
  // ---- parapet: zinc coping with a drip edge, stained where water sits
  k.box(0, 0.572, 0.15, 9.72, 0.045, 0.42, zinc);
  k.box(0, 0.54, -0.07, 9.72, 0.05, 0.03, 0x7b8380);
  for (const sx of [-4.64, 4.64]) {
    k.box(sx, 0.572, 12.9, 0.42, 0.045, 25.2, zinc);
    for (let z = 3.2; z < 25; z += 3.1) k.box(sx, 0.598, z, 0.43, 0.006, 0.03, 0x6d7572); // standing seams
  }
  for (let x = -4.2; x < 4.4; x += 2.1) k.box(x, 0.598, 0.15, 0.03, 0.006, 0.43, 0x6d7572);
  for (let i = 0; i < 16; i++) {
    const side = rnd() < 0.5 ? -1 : 1,
      z = 0.8 + rnd() * 23;
    k.box(side * (4.47 - 0.004), 0.3 - rnd() * 0.08, z, 0.012, 0.28 + rnd() * 0.2, 0.07 + rnd() * 0.1, rnd() < 0.5 ? rust : 0x4b4f4a);
  }
  for (let i = 0; i < 9; i++) k.box(-4.2 + rnd() * 8.4, 0.3, 0.312, 0.07 + rnd() * 0.12, 0.3 + rnd() * 0.2, 0.012, rnd() < 0.5 ? rust : 0x4b4f4a);
  // moss and silt in the gutters along the upstand, leaves blown into corners
  for (let i = 0; i < 34; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    k.box(side * (4.28 - rnd() * 0.22), 0.045, 0.6 + rnd() * 24, 0.14 + rnd() * 0.3, 0.035, 0.2 + rnd() * 0.5, rnd() < 0.7 ? moss : 0x3d4429, 0, false, 'round');
  }
  for (let i = 0; i < 12; i++) k.box(-4.1 + rnd() * 8.2, 0.045, 0.42 + rnd() * 0.22, 0.2 + rnd() * 0.5, 0.03, 0.12 + rnd() * 0.14, moss, 0, false, 'round');
  for (let i = 0; i < 26; i++)
    k.box(-4.25 + rnd() * 0.9, 0.05, 0.4 + rnd() * 1.1, 0.07, 0.008, 0.045, [0x8a5a2b, 0x9a7433, 0x6d4a26][i % 3], rnd() * 3);
  // bird lime on the coping and round the stacks
  for (let i = 0; i < 22; i++) k.box(-4.5 + rnd() * 9, 0.598, 0.02 + rnd() * 0.26, 0.03 + rnd() * 0.05, 0.004, 0.03 + rnd() * 0.05, 0xe4e3d8, 0, false, 'round');
  // ---- chimneys and what is strapped to them
  chimney(k, -2.55, 4.9, 1.75, 3);
  chimney(k, 3.05, 13.4, 1.55, 2);
  aerial(k, -2.08, 4.9, 0.9, 3.3, -1);
  aerial(k, 3.52, 13.4, 0.8, 2.7, -1);
  // lightning rod and its tape along the coping
  k.box(-2.55, 2.75, 5.3, 0.018, 1.3, 0.018, 0x6a716f);
  k.box(-3.6, 0.61, 5.3, 2.1, 0.012, 0.025, 0x6a716f);
  // ---- satellite dishes on the side upstand, cables tacked along the felt
  for (const [z, tilt] of [
    [8.6, 0.25],
    [10.1, 0.38],
  ]) {
    k.box(-4.5, 0.95, z, 0.05, 0.8, 0.05, 0x858c8a);
    k.box(-4.34, 1.34, z, 0.09, 0.66, 0.66, 0xd5d7d2, tilt, false, 'round');
    k.box(-4.02, 1.2, z, 0.5, 0.02, 0.02, 0x858c8a, -0.3);
    k.box(-3.8, 1.13, z, 0.06, 0.09, 0.06, 0x3b4043);
  }
  for (const [x, z, w, d] of [
    [-3.2, 8.6, 2.5, 0.02],
    [-1.95, 7.2, 0.02, 2.8],
    [-3.2, 10.1, 2.5, 0.02],
    [0.2, 5.8, 4.3, 0.02],
  ])
    k.box(x, 0.045, z, w, 0.018, d, 0x121415);
  // ---- vents: soil stacks, a kitchen flue with its guy wire, a spinner
  vent(k, 0.4, 2.9, 0.62);
  vent(k, 0.95, 2.9, 0.48);
  vent(k, -0.9, 9.7, 0.7);
  vent(k, 3.4, 4.1, 1.5, 0.2);
  k.box(3.0, 0.75, 4.1, 0.9, 0.008, 0.008, 0x9aa19f, 1.0);
  k.box(-3.5, 0.3, 14.2, 0.24, 0.6, 0.24, zinc);
  k.box(-3.5, 0.78, 14.2, 0.44, 0.38, 0.44, 0xa9b0ad, 0, false, 'round');
  for (let i = 0; i < 6; i++) k.box(-3.5, 0.78, 14.2, 0.455, 0.36, 0.02, 0x6f7774, 0, false, 'round');
  // ---- skylight over the stairwell: a glazed lantern on an upstand
  k.box(-0.3, 0.16, 6.9, 1.7, 0.32, 1.2, 0x767e7b);
  k.box(-0.3, 0.335, 6.9, 1.82, 0.035, 1.32, zinc);
  k.box(-0.3, 0.3, 6.9, 1.5, 0.02, 1.0, 0xffcf8a, 0, true);
  k.box(-0.3, 0.37, 6.9, 1.56, 0.03, 1.06, 0x9bb6bd, 0, false, 'glass');
  for (const x of [-0.82, -0.3, 0.22]) k.box(x, 0.385, 6.9, 0.035, 0.03, 1.08, 0x5d6562);
  k.box(-0.3, 0.385, 6.9, 1.58, 0.03, 0.035, 0x5d6562);
  // a square service hatch with its hinges and a padlock
  k.box(1.9, 0.1, 2.2, 0.92, 0.2, 0.92, 0x6b7370);
  k.box(1.9, 0.22, 2.2, 1.0, 0.045, 1.0, 0x848c88);
  for (const x of [1.6, 2.2]) k.box(x, 0.25, 2.68, 0.1, 0.03, 0.06, 0x4c5351);
  k.box(1.9, 0.19, 1.72, 0.07, 0.09, 0.03, 0xb69a3d);
  // ---- the stair head: a rendered box with a steel door, lit from inside
  const sx = 2.25,
    sz = 9.4;
  k.box(sx, 1.2, sz, 3.0, 2.4, 3.2, 0xb9b3a4);
  k.box(sx, 2.46, sz, 3.3, 0.12, 3.5, 0x4a4f50);
  k.box(sx, 2.535, sz, 3.36, 0.03, 3.56, zinc);
  k.box(sx, 0.2, sz, 3.04, 0.4, 3.24, 0x8d877a); // damp at the foot
  for (let i = 0; i < 7; i++) k.box(sx - 1.3 + rnd() * 2.6, 1.9 - rnd() * 0.5, sz - 1.607, 0.05 + rnd() * 0.08, 0.6 + rnd() * 0.9, 0.012, 0x8f8372);
  // door in the wall that faces the edge (−z), standing ajar on a warm stair
  k.box(sx - 0.4, 1.06, sz - 1.61, 1.06, 2.12, 0.05, 0x3a4144);
  k.box(sx - 0.4, 1.05, sz - 1.63, 0.9, 2.0, 0.03, 0xffc98a, 0, true);
  k.box(sx - 0.62, 1.05, sz - 1.67, 0.5, 2.0, 0.045, 0x4f6a5b);
  k.box(sx - 0.42, 1.05, sz - 1.7, 0.035, 0.14, 0.05, 0xb9bdb9);
  k.box(sx - 0.4, 0.04, sz - 1.9, 1.3, 0.08, 0.6, 0x7e7a70);
  k.box(sx - 0.4, 2.3, sz - 1.72, 0.3, 0.1, 0.16, 0x4a5053);
  k.box(sx - 0.4, 2.24, sz - 1.72, 0.22, 0.05, 0.12, 0xffd9a0, 0, true);
  k.sign(sx + 0.72, 1.55, sz - 1.635, 0.62, 0.24, ['VSTUP NA STŘECHU', 'ZAKÁZÁN'], Math.PI, '#b53a2d', '#f6efe2');
  // cat ladder up the side of the stair head, and a cable tray on top
  for (const lz of [sz - 0.25, sz + 0.25]) k.box(sx - 1.56, 1.35, lz, 0.04, 2.7, 0.04, 0x8a918f);
  for (let y = 0.3; y < 2.7; y += 0.3) k.box(sx - 1.56, y, sz, 0.03, 0.03, 0.5, 0x8a918f);
  k.box(sx + 0.6, 2.62, sz + 0.4, 0.7, 0.14, 1.6, 0x6e7674);
  // ---- somebody comes up here: a chair, a crate, bottles, a tin of ash
  k.box(-1.2, 0.46, 1.75, 0.44, 0.04, 0.42, 0x7d2f2a);
  k.box(-1.2, 0.72, 1.97, 0.44, 0.46, 0.04, 0x7d2f2a, 0);
  for (const cx of [-1.4, -1.0]) for (const cz of [1.57, 1.94]) k.box(cx, 0.24, cz, 0.03, 0.44, 0.03, 0x9da3a1);
  k.box(-2.0, 0.18, 1.7, 0.42, 0.3, 0.32, 0x2d5f8a);
  for (let i = 0; i < 3; i++) k.box(-2.12 + i * 0.12, 0.42, 1.7, 0.065, 0.2, 0.065, 0x3b5a2a);
  k.box(-0.72, 0.13, 1.5, 0.07, 0.2, 0.07, 0x4a3520);
  k.box(-0.66, 0.085, 1.72, 0.1, 0.11, 0.1, 0xb9bdb9);
  for (let i = 0; i < 9; i++) k.box(-0.9 + rnd() * 0.6, 0.04, 1.3 + rnd() * 0.6, 0.035, 0.008, 0.01, 0xe6dfcf, rnd() * 3);
}

// The cat ladder down the outside of the end wall (roof frame; `drop` is the
// height of the deck over the pavement): two stiles, rungs, brackets to the
// wall, and safety hoops for the top third.
export function dressLadder(k, drop) {
  const x = -3.6,
    z = -0.36,
    steel = 0x8a918f;
  for (const s of [-0.24, 0.24]) k.box(x + s, (1.25 - drop) / 2, z, 0.05, drop + 1.25, 0.05, steel);
  for (let y = -drop + 0.3; y < 1.1; y += 0.3) k.box(x, y, z, 0.48, 0.03, 0.03, 0xa3a8a4);
  for (let y = -drop + 1.2; y < 0.4; y += 2.4) for (const s of [-0.24, 0.24]) k.box(x + s, y, z + 0.17, 0.04, 0.04, 0.34, 0x626563);
  // the stiles hook over the coping, with a little landing plate
  for (const s of [-0.24, 0.24]) k.box(x + s, 1.22, 0.1, 0.05, 0.05, 0.96, steel);
  k.box(x, 0.62, 0.15, 0.6, 0.03, 0.44, 0x6f7774);
  for (let y = -drop + 2.6; y < -0.2; y += 0.9) {
    k.box(x, y, z - 0.7, 0.7, 0.03, 0.03, steel);
    for (const s of [-0.35, 0.35]) k.box(x + s, y, z - 0.35, 0.03, 0.03, 0.7, steel);
  }
  for (const [s, dz] of [[-0.35, -0.7], [0.35, -0.7], [0, -0.7]]) k.box(x + s, -drop / 2 + 1.2, z + dz, 0.025, drop - 2.9, 0.025, steel);
}

// The bins at the foot of the end wall, where the cat sleeps (roof frame, on
// the ground: x along the wall, −z out from it).
export function dressDoor(k) {
  for (const [x, colour, lid] of [
    [-0.4, 0x2f4d3a, 0x263f30],
    [-1.1, 0x6b5a2b, 0x574a23],
    [-1.8, 0x32506e, 0x27405a],
  ]) {
    k.box(x, 0.55, -0.45, 0.56, 1.1, 0.62, colour);
    k.box(x, 1.13, -0.45, 0.6, 0.06, 0.66, lid);
    for (const s of [-0.2, 0.2]) k.box(x + s, 0.06, -0.5, 0.06, 0.12, 0.12, 0x1c1d1e, 0, false, 'round');
  }
}
