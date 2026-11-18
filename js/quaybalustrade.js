// ---- quaybalustrade.js: which Prague embankments carry a stone balustrade ----
// The quay walls (js/quaywall.js) carry a parapet wherever an embankment street
// runs along the top. On most of the Vltava that is a plain granite wall; the
// nineteenth-century embankments of the Old and New Town and Smíchov (Smetanovo,
// Masarykovo, Janáčkovo nábřeží) have a balustrade instead: a plinth, a top
// rail, pedestals at intervals and the balusters between them. The tiles carry
// no tag for it, so it is a hand list: each embankment's street, simplified
// from its OSM line (tiles -21_-2, -20_-2, -21_-1), and a quay piece within
// REACH of one wears the balustrade. A pure function of position (both threads
// and every client agree). Charles Bridge keeps its solid parapet
// (js/landmarks-karluv.js): that is what it has.
// WORKER SAFE: plain data.

const REACH = 32;            // m from the street's centreline to the parapet it owns

export const BALUSTRADES = [
  { name: 'Smetanovo nábřeží', pts: [[-96131, -6045], [-96148, -6002], [-96162, -5967], [-96175, -5928],
    [-96197, -5865], [-96210.5, -5763.5], [-96221, -5651], [-96230, -5549], [-96229.4, -5526.7]] },
  { name: 'Masarykovo nábřeží', pts: [[-96229.4, -5526.7], [-96228, -5515], [-96212, -5454.5], [-96205, -5436],
    [-96172, -5342], [-96151, -5223], [-96139, -5082], [-96153.6, -4973.6], [-96161, -4929], [-96166, -4903.5],
    [-96168.5, -4892.3]] },
  { name: 'Janáčkovo nábřeží', pts: [[-96435, -4558.7], [-96484.6, -4698.8], [-96494, -4729], [-96511, -4776],
    [-96519, -4802], [-96536, -4867], [-96550, -4940.7], [-96561, -4997.4], [-96576.4, -5137.4], [-96585, -5326.2],
    [-96588.5, -5423.3], [-96592, -5490.4], [-96593.5, -5511.9]] },
];

const BOX = (() => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of BALUSTRADES) for (const [x, z] of b.pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return { x0: x0 - REACH, z0: z0 - REACH, x1: x1 + REACH, z1: z1 + REACH };
})();

/** Does the quay parapet at (x, z) take the balustrade form? */
export function balustradeAt(x, z) {
  if (x < BOX.x0 || x > BOX.x1 || z < BOX.z0 || z > BOX.z1) return false;
  for (const b of BALUSTRADES) {
    const p = b.pts;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], ex = p[i + 1][0] - ax, ez = p[i + 1][1] - az;
      const L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - ax - ex * t, dz = z - az - ez * t;
      if (dx * dx + dz * dz < REACH * REACH) return true;
    }
  }
  return false;
}
