// The Prague náplavky: the LOWER QUAYS of the Vltava, a stone floor about two
// metres over the water at the foot of the embankment wall, where the boats
// tie up and the summer markets stand. DMR 5G at 20 m cannot hold a 5 m wall,
// so the survey smeared each quay into a slope from the street down to the
// water, 2 to 4 m too high at its outer edge, and the walls (OSM
// barrier=retaining_wall) had no ground to stand in.
//
// Each náplavka is a terrain stamp (js/terrainstamps.js makes them): its line
// is the retaining wall's own polyline, traced in the direction that leaves
// the water on the RIGHT (d > 0; OSM draws a retaining wall with its low side
// on the right, which these all keep), dug with a hard edge at the wall face
// down to its pool level (js/riverpools.js) plus the quay's height. The street
// side (d < 0) is not touched. WORKER SAFE: plain data.
//
// Vertices are the shipped tile barriers (tiles -21_-2, -20_-2, -21_-1,
// -20_-1), chained where two walls overlap, the riverward one kept.

import { POOLS } from './riverpools.js';

// m: from the wall out past the waterline (the river carve takes over there),
// short of the nearest island, then 4 m back up to the survey
const QUAY_W = 30, QUAY_FADE = 4;
const prof = [[-0.001, 0, 0], [0, 0, 1], [QUAY_W, 0, 1], [QUAY_W + QUAY_FADE, 0, 0]];

export const NAPLAVKY = [
  // Novoměstská náplavka under Rašínovo nábřeží, Jiráskův most to Výtoň,
  // pool A (above Šítkovský jez); travelling south, the river to the west
  { name: 'Novoměstská náplavka', mode: 'dig', base: POOLS.A + 1.6, prof,
    pts: [[-96168, -4934.1], [-96182.2, -4865.3], [-96172.9, -4607.3], [-96170.7, -4579.3],
      [-96162, -4446.4], [-96150.9, -4416.1], [-96141.7, -4336.4], [-96133.7, -4273],
      [-96126.5, -4195.1], [-96108.3, -4066.1], [-96105.9, -4045.2], [-96071.8, -3788.5],
      [-96062, -3705.6]] },
  // Staroměstská náplavka under Dvořákovo nábřeží and Na Františku, pool C
  // (below Staroměstský jez); travelling west, the river to the north
  { name: 'Staroměstská náplavka', mode: 'dig', base: POOLS.C + 1.5, prof,
    pts: [[-95238.3, -6853.1], [-95379.9, -6849.6], [-95420.9, -6849.1], [-95478.1, -6844.3],
      [-95555.6, -6835], [-95651.3, -6818.4], [-95700.4, -6807.5], [-95756.9, -6794],
      [-95794.6, -6780.8], [-95842.3, -6760.4], [-95865.4, -6750.2], [-95885, -6740],
      [-95918.3, -6720.5], [-95952.7, -6701], [-95989, -6672.3], [-96025.7, -6639.3],
      [-96049.1, -6609], [-96082.3, -6563]] },
];
