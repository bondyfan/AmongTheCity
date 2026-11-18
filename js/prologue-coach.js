import { trainZ, doorX } from './prologue-route.js';

// A second-class open saloon, four seats around a table, with an end vestibule.
export function coach(k) {
  const { box, sign } = k,
    z = trainZ;
  const blue = 0x1b5791,
    cream = 0xe0dfd6,
    metal = 0x8797a0,
    seat = 0x245581;
  box(3, 0.04, z, 26.4, 0.25, 3.05, 0x656a70);
  box(3, 2.77, z, 26.5, 0.2, 3.14, cream);
  for (const x of [-10.1, 16.1]) box(x, 1.42, z, 0.15, 2.62, 3.05, cream);
  for (const side of [-1, 1]) {
    const edge = z + side * 1.51;
    for (const [a, b] of side === 1
      ? [
          [-10.14, 13.25],
          [14.75, 16.12]
        ]
      : [[-10.14, 16.12]]) {
      const mid = (a + b) / 2,
        w = b - a;
      box(mid, 0.56, edge, w, 0.81, 0.1, cream);
      box(mid, 0.39, edge + side * 0.06, w, 0.37, 0.045, blue);
      box(mid, 2.55, edge, w, 0.26, 0.11, cream);
      box(mid, 0.98, edge, w, 0.09, 0.13, metal);
    }
    for (let x = -9.5; x < 15; x += 2.27) {
      if (side === 1 && Math.abs(x - doorX) < 1) continue;
      box(x, 1.7, edge, 0.21, 1.44, 0.13, cream);
    }
    box(1.4, 1.72, edge, 22.8, 1.43, 0.018, 0x8cb3c7, 0, false, 'glass');
    // Luggage rack with a lip, overhead reading lights, textured upholstery.
    box(1.44, 2.25, z + side * 1.21, 21, 0.075, 0.46, metal);
    box(1.44, 2.32, z + side * 0.99, 21, 0.13, 0.035, metal);
    for (let x = -8.3; x < 12; x += 2.27) {
      box(x, 2.618, z + side * 0.71, 1.51, 0.044, 0.125, 0xffedcd, 0, true);
    }
    for (let bay = 0; bay < 8; bay++) {
      const x = -8.2 + bay * 2.62;
      for (const facing of [-1, 1]) {
        const sx = x + facing * 0.84;
        for (let col = 0; col < 2; col++) {
          const sz = z + side * (0.6 + col * 0.48);
          box(sx, 0.55, sz, 0.57, 0.2, 0.45, seat, 0, false, 'round');
          box(sx + facing * 0.24, 0.94, sz, 0.13, 0.73, 0.44, seat, -facing * 0.085);
          box(sx + facing * 0.26, 1.24, sz, 0.18, 0.23, 0.4, 0xb3c4d4, 0, false, 'round');
          for (let band = 0; band < 3; band++)
            box(sx + facing * 0.155, 0.78 + band * 0.09, sz, 0.025, 0.019, 0.39, 0x5b85a4);
        }
        box(sx, 0.77, z + side * 0.37, 0.42, 0.055, 0.045, metal);
      }
      box(x, 0.83, z + side * 1.14, 0.67, 0.06, 0.58, 0xbba58b);
    }
  }
  for (const side of [-1, 1]) {
    box(12.64, 1.43, z + side * 1.0, 0.12, 2.5, 0.92, cream);
    box(12.57, 1.59, z + side * 0.99, 0.04, 0.58, 0.57, 0x708a98);
  }
  sign(14.16, 2.45, z + 1.58, 2.24, 0.33, ['2   Pardubice hl. n.'], 0, '#17222a', '#ffd46c');
  sign(12.72, 2.32, z, 1.14, 0.21, ['2   TICHÝ ODDÍL'], Math.PI / 2);
  sign(4.3, 0.61, z + 1.58, 2.2, 0.27, ['České dráhy'], 0, '#255489');
  box(doorX, 0.02, z + 1.58, 1.43, 0.2, 0.65, metal);
  // The neighbouring blue coaches make the consist legible from the platform.
  for (const x of [-23.7, 29.7]) {
    box(x, 1.03, z, 26.1, 2.05, 3.04, blue);
    box(x, 2.42, z, 26.12, 0.55, 3.09, cream);
    for (let i = 0; i < 10; i++)
      for (const side of [-1, 1])
        box(x - 10.95 + i * 2.42, 1.65, z + side * 1.53, 1.72, 0.91, 0.045, 0xdabf99, 0, true);
  }
  for (const x of [-7.8, -5.7, 11.4, 13.5]) box(x, -0.29, z, 0.63, 0.74, 2.18, 0x30383e);
}
