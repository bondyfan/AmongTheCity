// ---- praguezone.js: where in the world a building is Prague, and which Prague ----
// Pure data (no three, no DOM): typology.js, roofdata.js, interiors.js and the
// mesh worker all ask it. Nothing in a tile says "this roof was surveyed by
// IPR" or "this house is medieval" (that would take a rebuild), so geography is
// the only runtime witness, and these are the shapes of it, in world metres
// (x east, z south, origin in Pardubice).
//
// The outlines are an inference from the map, not a survey: the city limit is
// a coarse polygon of Prague's administrative boundary, the old-town zones are
// boxes round Staré Město with Josefov, Malá Strana and Hradčany. A hard line
// would flip a roof's pitch and a facade's palette from one house to the next,
// so the old-town test is soft: a 70 m margin where a per-building hash
// decides, which reads as a town growing into its suburb, not as a seam.

import { rnd } from './typology.js';

const X = (lon) => (lon - 15.7560881) * 71648.6;
const Z = (lat) => -(lat - 50.0317084) * 111230.7;
// Prague's city limit, clockwise from Suchdol, [lat, lon] (coarse: a few
// hundred metres either way at the edge, where the city is villas and fields)
const LIMIT = [
  [50.137, 14.37], [50.150, 14.45], [50.160, 14.53], [50.127, 14.58], [50.118, 14.63],
  [50.105, 14.67], [50.075, 14.705], [50.040, 14.665], [50.008, 14.625], [49.998, 14.56],
  [49.990, 14.49], [49.972, 14.455], [49.945, 14.395], [49.965, 14.345], [50.000, 14.335],
  [50.030, 14.295], [50.048, 14.250], [50.085, 14.230], [50.110, 14.27], [50.125, 14.330],
].map(([lat, lon]) => [X(lon), Z(lat)]);
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
for (const [x, z] of LIMIT) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }

function inRing(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Is (x, z) inside the city of Prague? */
export function inPrague(x, z) {
  if (x < x0 || x > x1 || z < z0 || z > z1) return false;
  return inRing(x, z, LIMIT);
}
const at = (f) => f.o?.[0] ?? [0, 0];
/** The building stands in Prague (its first vertex does: plain, cheap, stable). */
export const praguePlace = (f) => { const p = at(f); return inPrague(p[0], p[1]); };

// The medieval and baroque core: every roof there is steep clay, every house
// pastel plaster. [x0, z0, x1, z1] boxes in world metres.
const OLD = [
  [-96195, -6762, -95084, -5600],    // Staré Město with Josefov
  [-97233, -6706, -96410, -5761],    // Malá Strana
  [-98022, -6818, -97019, -6150],    // Hradčany
];
const MARGIN = 70;
/** 0..1: how far inside the old-town zone a point is (1 well inside). */
export function oldTownK(x, z) {
  let k = 0;
  for (const [a, b, c, d] of OLD) {
    const e = Math.min(x - a, c - x, z - b, d - z);
    if (e > -MARGIN) k = Math.max(k, Math.min(1, (e + MARGIN) / (2 * MARGIN)));
  }
  return k;
}
/** Is this building part of the old town (soft at the edge, salt 150)? */
export function inOldTown(f) {
  const p = at(f), k = oldTownK(p[0], p[1]);
  return k >= 1 || (k > 0 && rnd(f._id ?? 0, 150) < k);
}

// Prague plaster. Central Prague is not beige: ochre, Theresian yellow,
// salmon, old pink, pistachio and sage, powder blue, cream and warm white,
// the odd terracotta. Picked from looking at real facades (an inference, not a
// measurement), and a little stronger than the rest of the country's palettes
// because the atlas cells are near-white plaster multiplied by it.
export const PRAGUE_WALLS = [
  0xe2c27c, 0xe8cf8a, 0xdca58c, 0xd7a9a0, 0xc3cfa0, 0xb8c7a8, 0xb7c8d2, 0xa9b8c0,
  0xeee2c4, 0xece6d8, 0xc98f72, 0xd9c4a0,
];
/** Does this typology wear the Prague plaster when it stands in Prague? */
export const praguePlaster = (typ, pitched) =>
  typ === 'tenement' || typ === 'civic' || (typ === 'block' && pitched);
