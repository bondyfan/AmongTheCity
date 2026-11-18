import { depth, platforms } from './prologue-route.js';

const paving = 0x989599,
  steel = 0x3e535d,
  tile = 0xd2c9ba,
  lamp = 0xffe7b3;
const pi = Math.PI;
function strip(k, x, y, z, length) {
  k.box(x, y, z, length, 0.07, 0.19, lamp, 0, true);
}

function kolin(k) {
  const { box, sign } = k;
  // River and reflections between the two quays, below the bridge deck.
  box(0, -1.83, 71, 450, 0.12, 50, 0x46556e);
  for (let i = 0; i < 150; i++) {
    const x = ((i * 37) % 171) - 85,
      z = 49 + ((i * 19) % 42);
    box(x, -1.75, z, 0.6 + (i % 6), 0.015, 0.08, i % 5 ? 0x707485 : 0xb79d87);
  }
  for (const z of [43, 98]) box(0, -1, z, 250, 2, 6, 0x716b62);
  box(0, 2.12, 66.8, 6.2, 0.52, 28, 0x777675);
  for (let i = 0; i < 30; i++) {
    const z = 41 + (i + 0.5) * 0.4,
      height = (z - 41) / 5;
    box(0, height - 0.15, z, 6.2, 0.3, 0.42, paving);
  }
  for (const x of [-2.95, 2.95]) {
    for (let z = 41; z <= 81; z += 1) {
      const y = Math.min(2.4, (z - 41) / 5);
      box(x, y + 0.51, z, 0.075, 1.06, 0.075, steel);
      box(x, y + 1.06, z, 0.13, 0.1, 1.04, steel);
    }
    for (const z of [55, 70, 80]) {
      box(x, 4.65, z, 0.12, 4.6, 0.12, steel);
      box(x, 7, z, 0.55, 0.21, 0.55, lamp, 0, true);
    }
  }
  for (const side of [-1, 1]) {
    box(side * 18, -0.55, 48, 30, 0.8, 1.2, 0x77695e);
    box(side * 18, 0.04, 47.7, 30, 0.21, 0.64, tile);
    for (let i = 0; i < 21; i++) {
      box(side * (i * 1.4 + 3.4), -0.78, 48.68, 0.035, 1.32, 0.02, 0x554e4a);
    }
  }
  for (let z = 42; z < 81; z += 1.7) {
    const y = Math.min(2.4, (z - 41) / 5);
    box(0, y + 0.007, z, 5.8, 0.012, 0.022, 0x585d5f);
  }
  box(0, -0.16, 34.5, 14, 0.32, 14, paving);
  sign(1.8, 2, 39, 2.2, 0.52, ['Nádraží  ↑']);
  box(1.8, 0.89, 38.94, 0.08, 1.8, 0.08, steel);
}

function hall(k, arrival) {
  const { box, sign } = k,
    width = arrival ? 37 : 24,
    height = arrival ? 8.4 : 5.3;
  const clad = arrival ? 0xa25946 : 0xbcaa87;
  box(0, -0.13, 19, width, 0.26, 18, tile);
  for (let x = -width / 2 + 1; x < width / 2; x += 1.8) box(x, 0.007, 19, 0.018, 0.012, 18, 0x9d9289);
  for (let z = 10; z < 28; z += 1.8) box(0, 0.008, z, width, 0.012, 0.018, 0x9d9289);
  box(0, height, 19, width + 1.2, 0.38, 19.5, 0xb7b3aa);
  for (const side of [-1, 1]) {
    box((side * width) / 2, height / 2, 19, 0.36, height, 18, clad);
    for (const z of [10, 27.5]) {
      const wing = width / 2 - 2.6;
      box(side * (2.6 + wing / 2), 1.65, z, wing, 3.3, 0.18, z === 10 ? clad : 0x597888);
      box(side * (2.6 + wing / 2), height * 0.7, z, wing, height * 0.6, 0.19, 0x688596);
    }
  }
  for (let x = -width / 2; x <= width / 2; x += 2.5) {
    if (Math.abs(x) < 2.55) continue;
    box(x, height / 2, 27.7, 0.18, height, 0.32, tile);
  }
  if (!arrival) {
    // Low functionalist wings and the winged station clock above the doors.
    for (const side of [-1, 1]) {
      box(side * 18, 2.15, 19, 12, 4.3, 15.8, 0xb8a685);
      for (let i = 0; i < 5; i++) box(side * (13.7 + i * 2.13), 2.45, 27, 1.46, 1.36, 0.11, 0x5e7880);
      for (let i = 0; i < 3; i++)
        box(side * (0.85 + i * 0.1), 4.2 + i * 0.11, 27.74, 1.13 - i * 0.21, 0.07, 0.13, steel);
    }
    box(0, 4.4, 27.71, 1.05, 1.05, 0.17, 0xf6ebd0, 0, false, 'round');
    box(-0.13, 4.52, 27.81, 0.045, 0.41, 0.025, steel, 0.72);
    box(-0.04, 4.61, 27.82, 0.035, 0.45, 0.025, steel, 0.2);
  }
  const name = arrival ? 'PARDUBICE' : 'KOLÍN';
  sign(0, height + 0.35, 27.7, arrival ? 11 : 6, 1.12, [name], 0, '#384652');
  sign(
    0,
    3.8,
    10.3,
    6.1,
    1.12,
    ['ODJEZDY   /   DEPARTURES', arrival ? 'Praha hl. n.      nást. 3' : 'Pardubice hl. n.       2  →'],
    0,
    '#171d22',
    '#ffc468'
  );
  sign(0, 3.5, 27.3, 4.2, 0.65, ['Východ  ↑   •   MHD'], pi);
  for (const z of [14, 19, 24]) {
    strip(k, 0, height - 0.25, z, width - 4);
    for (const x of [-7, 7]) {
      box(x, 0.48, z, 2.2, 0.13, 0.48, 0x946849);
      for (const dx of [-0.76, 0.76]) box(x + dx, 0.22, z, 0.12, 0.44, 0.32, steel);
    }
  }
  // Glazed booking counters on the flanks and a ceramic wall panel in Pardubice.
  for (const x of [-7, -4.5, 4.5, 7]) {
    box(x, 1.47, 10.3, 2.2, 1.3, 0.18, 0x607d83);
    box(x, 0.93, 10.6, 2.3, 0.11, 0.6, paving);
  }
  if (arrival)
    for (let i = 0; i < 88; i++) {
      const colors = [0x4e6b72, 0xc4a671, 0xb26f4e, 0x798a78];
      box(
        -9 + (i % 22) * 0.75,
        4.35 + Math.floor(i / 22) * 0.49,
        10.22,
        0.73,
        0.47,
        0.07,
        colors[(i * 13 + Math.floor(i / 9)) % 4]
      );
    }
  // Stairs to the tunnel; Pardubice also has a parallel moving escalator.
  for (let i = 0; i < 28; i++) {
    const z = 2 + ((i + 0.5) * 8) / 28,
      y = ((z - 10) * depth) / 8;
    box(0, y - 0.12, z, 4.55, 0.24, 8 / 28 + 0.01, arrival ? 0x777e82 : paving);
    box(0, y + 0.003, z - 0.114, 4.45, 0.015, 0.035, 0xd8bd78);
  }
  for (const x of [-2.3, 2.3])
    for (let i = 0; i < 20; i++) {
      const z = 2 + (i + 0.5) * 0.4,
        y = ((z - 10) * depth) / 8;
      box(x, y + 0.54, z, 0.12, 1.08, 0.41, steel);
      box(x, y + 1.1, z, 0.2, 0.12, 0.42, 0x333b40);
    }
  if (arrival)
    for (let i = 0; i < 20; i++) {
      const z = 2 + (i + 0.5) * 0.4;
      box(0, ((z - 10) * depth) / 8 + 0.54, z, 0.14, 1.08, 0.42, steel);
    }
}

function subway(k, arrival) {
  const { box, sign } = k;
  box(0, -depth - 0.1, -20, 4.7, 0.2, 44, paving);
  box(0, -0.55, -20, 4.7, 0.22, 44, tile);
  for (let z = -41.5; z < 2; z += 1) {
    for (const x of [-2.26, 2.26]) {
      if (x > 0 && platforms.some((p) => Math.abs(z - p) < 1.6)) continue;
      box(x, -2.12, z, 0.22, 3.25, 0.99, tile);
      box(x * 0.944, -2.12, z, 0.04, 0.25, 1, arrival ? 0x8b5340 : 0x416879);
    }
  }
  box(0, -2.12, -42.2, 4.6, 3.25, 0.24, tile);
  for (let z = -40; z < 1; z += 4) strip(k, 0, -0.72, z, 1.4);
  for (const [index, p] of platforms.entries()) {
    sign(12.3, 2.5, p + 1.95, 2.9, 0.46, ['↓  Podchod • Hala'], Math.PI / 2);
    sign(0, -1.23, p + 2.3, 2.7, 0.46, [index + 2 + '. nástupiště  →']);
    sign(0, -1.23, p + 2.28, 2.7, 0.46, ['↑  Východ • Hala'], pi);
    for (let i = 0; i < 24; i++) {
      const x = 2 + ((i + 0.5) * 9) / 24,
        y = ((x - 11) * depth) / 9;
      box(x, y - 0.12, p, 0.385, 0.24, 2.65, paving);
      box(x - 0.16, y + 0.003, p, 0.042, 0.014, 2.6, 0xeac584);
      for (const side of [-1, 1]) box(x, y + 0.48, p + side * 1.4, 0.385, 0.98, 0.11, steel);
    }
    // Platform wraps the open stairwell on both long sides.
    for (const side of [-1, 1]) box(4.5, -0.19, p + side * 2.16, 56, 0.38, 1.66, paving);
    box(-10.65, -0.19, p, 25.3, 0.38, 2.67, paving);
    box(21.9, -0.19, p, 21.8, 0.38, 2.67, paving);
    for (const side of [-1, 1]) box(4.5, 0.012, p + side * 2.78, 56, 0.022, 0.14, 0xeac584);
    const roof = arrival ? 0x8e9292 : 0x777f7c;
    box(4.5, 4.35, p, 53, 0.22, 5.9, roof);
    for (let x = -19; x < 33; x += 10) {
      box(x, 2.1, p + 2.16, 0.14, 4.28, 0.16, steel);
      strip(k, x, 4.19, p, 5);
    }
    const title = arrival ? 'Pardubice hlavní nádraží' : 'Kolín';
    for (const x of [-13, 17]) {
      sign(x, 3.2, p + 0.85, 5.3, 0.78, [title], pi);
      sign(x, 3.2, p + 0.86, 5.3, 0.78, [title]);
    }
    for (const side of [-1, 1]) {
      const rail = p + side * 4.9;
      for (const dz of [-0.72, 0.72]) box(4, -0.59, rail + dz, 145, 0.13, 0.08, steel);
      for (let x = -65; x < 74; x += 1.05) box(x, -0.72, rail, 0.21, 0.12, 2.2, 0x6a625b);
    }
  }
}

export function station(k, arrival) {
  if (!arrival) kolin(k);
  hall(k, arrival);
  subway(k, arrival);
  // Ground outside the excavated concourse, including what can be seen
  // through the front doors and the carriage windows.
  k.box(0, -4.28, 0, 440, 0.3, 350, 0x535d54);
  k.box(0, -0.97, -66, 330, 0.38, 36, 0x565f59);
  if (arrival) {
    k.box(0, -0.21, 61, 170, 0.35, 66, 0x737473);
    for (let x = -50; x <= 50; x += 2.6) k.box(x, -0.024, 47, 0.09, 0.018, 4.8, 0xcec9ab);
    for (let x = -30; x <= 30; x += 30) {
      k.box(x, 2.84, 40, 8, 0.22, 2.4, steel);
      for (const dx of [-3.5, 3.5]) k.box(x + dx, 1.37, 40, 0.095, 2.75, 0.1, steel);
      strip(k, x, 2.69, 40, 5.8);
    }
  } else {
    k.box(0, -0.22, 36, 220, 0.34, 18, 0x828477);
    k.box(0, -0.3, 111, 250, 0.52, 38, 0x5a6759);
  }
  for (let i = 0; i < 38; i++) {
    const x = ((i * 29) % 124) - 62;
    if (Math.abs(x) < 8) continue;
    const z = i % 2 ? 33 + (i % 9) : -52 - (i % 4),
      h = 3 + (i % 4);
    k.box(x, h * 0.35, z, 0.32, h * 0.72, 0.32, 0x524b41);
    k.box(x, h * 0.81, z, 2.8 + (i % 3), h * 0.76, 3.8, i % 3 ? 0x687353 : 0x8b7651, 0, false, 'round');
    k.box(x + 0.7, h * 0.72, z + 0.52, 2.7, h * 0.65, 2.8, 0x737853, 0, false, 'round');
  }
  // Ballast stays below the underpass; only continuous strips flank the excavation.
  for (const x of [-52, 53]) k.box(x, -1, -29, 80, 0.35, 46, 0x766f69);
  for (let i = 0; i < 47; i++) {
    const x = i * 6.2 - 140,
      z = i % 2 ? -59 - (i % 7) : 96 + (i % 9);
    const h = 6 + ((i * 17) % 12),
      w = 4.5 + (i % 5);
    k.box(x, h / 2 - 1.5, z, w, h, 6, i % 3 ? 0x746b72 : 0x525b6b);
    for (let j = 0; j < 4; j++)
      for (let y = 1; y < h - 2; y += 2.6)
        if ((i + j + Math.floor(y)) % 3)
          k.box(x - w * 0.36 + j * w * 0.24, y, z + (z < 0 ? 3.01 : -3.01), 0.65, 0.86, 0.05, 0xf4bd7c, 0, true);
  }
}
