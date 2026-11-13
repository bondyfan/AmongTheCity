// ---- landmarks-valy.js: the ramparts of the chateau ----
// WORKER SAFE. "Valy": what Vilém of Pernštejn threw up round his palace after
// 1491, and what Pardubice still walks its dogs on. A square of earth eleven
// metres high with a round gun bastion (rondel) on each corner, a wall with
// loopholes along its foot, the moat outside it (dry and grassed today) and
// one way in: from Příhrádek over the bridge, between two walls that close
// like a funnel, through the gate.
//
// THE EARTH IS THE TERRAIN'S. The survey (DMR 5G) holds the banks and the
// bastions already, and the footways on their crest are levelled into it like
// every other way, so people, trees and benches stand on them without this
// file knowing. What the survey cannot hold at 20 m a sample is anything with
// an edge: that is what is modelled here, on the lines the tile gives for it
// (its one `citywall` barrier and the two walls of the inner moat, which this
// replaces: landmarkBarrier in js/landmarks.js).
//
// It is built with the palace (js/landmarks-zamek.js) and rides in the palace's
// chunk, so the whole fortress arrives as one piece.

import { K, ringArea, hash2 } from './landmarkskit.js';

/** The foot wall, a closed ring: the tile's citywall barrier as surveyed (0_-1, July 2026). */
export const VALY = [
  [1398.3,-1095.1],[1371.8,-986],[1363.3,-986.6],[1351.5,-985.4],[1344.5,-983],[1338.1,-979.5],[1334.5,-975],
  [1327.8,-958.5],[1326.5,-951.3],[1325.5,-951.3],[1325.6,-949.4],[1326.8,-949.5],[1331,-930.1],[1331.9,-930.4],
  [1333.5,-927.3],[1342.2,-919.5],[1349.6,-915.9],[1356.3,-914.2],[1369.6,-914.1],[1374.1,-914.9],[1381.3,-918.3],
  [1395.3,-936.2],[1397.6,-937.6],[1400,-937.4],[1478.5,-912.1],[1482.1,-908.8],[1482.7,-902.7],[1481.4,-902.4],
  [1481.7,-901.3],[1482.8,-901.5],[1484.3,-894.8],[1483.2,-894.4],[1483.7,-892.9],[1485.1,-893.3],[1489.1,-887.1],
  [1488,-885.9],[1488.8,-885],[1490,-886],[1492.6,-883],[1491.6,-882],[1492.6,-881.1],[1493.5,-881.8],[1497.5,-878.3],
  [1496.8,-877.2],[1498,-876.3],[1498.7,-877.5],[1506.2,-874.2],[1505.6,-872.4],[1507.7,-871.8],[1508.3,-873.6],
  [1517.2,-871.7],[1527.3,-874.6],[1528.1,-873.1],[1529.8,-873.9],[1529.2,-875.5],[1534.6,-878.5],[1535.3,-877.4],
  [1536.8,-878.7],[1536.1,-879.7],[1540,-882.7],[1540.9,-881.7],[1542.5,-883],[1541.6,-884],[1546.8,-889.1],
  [1547.9,-888.2],[1549.1,-889.6],[1548.2,-890.6],[1551.1,-895.5],[1553.3,-903.9],[1554.6,-903.8],[1554.8,-905.2],
  [1553.5,-905.3],[1554.6,-913.8],[1553.6,-913.6],[1552.3,-920.8],[1553,-921.2],[1549.4,-927],[1544.8,-932.6],
  [1538.3,-937.9],[1524.1,-944.9],[1534,-973.4],[1535.1,-973.1],[1535.4,-974.2],[1534.5,-974.6],[1537.7,-983.8],
  [1538.8,-983.5],[1539.3,-984.9],[1538.3,-985.3],[1541.9,-995.1],[1542.9,-995],[1543.5,-996.5],[1542.3,-996.8],
  [1551.2,-1021.7],[1552.2,-1021.3],[1553.4,-1023.6],[1552,-1025.6],[1550.9,-1024.8],[1547.1,-1029.2],[1548.4,-1030],
  [1547.2,-1031.8],[1545.9,-1030.9],[1543.1,-1033.4],[1544.3,-1034.8],[1542.1,-1036],[1541.2,-1035],[1538.6,-1037.2],
  [1544.5,-1053.1],[1558.6,-1054.9],[1558.8,-1053.1],[1563.1,-1054.1],[1564.6,-1058.1],[1563.4,-1058.6],
  [1568.9,-1070.4],[1571.5,-1079.1],[1571.2,-1080.5],[1572.6,-1082.2],[1574.9,-1082.4],[1585.4,-1079.1],
  [1590.9,-1078.9],[1591,-1077.7],[1592.5,-1077.8],[1592.4,-1078.7],[1601.9,-1080.2],[1601.7,-1081.2],
  [1608.5,-1084.4],[1609.1,-1083.6],[1610.7,-1084.5],[1610.3,-1085.4],[1615.2,-1088.2],[1616.1,-1087],
  [1617.4,-1088.1],[1616.6,-1089.3],[1622.9,-1097.3],[1627.3,-1104.4],[1629.1,-1110.5],[1630.1,-1110.7],
  [1630,-1111.8],[1629.1,-1111.8],[1627,-1124.9],[1628.5,-1125.3],[1628.1,-1127],[1626.4,-1126.6],[1619.4,-1138.7],
  [1614.4,-1143.4],[1601.6,-1151.1],[1588.2,-1155.4],[1580.4,-1154.2],[1566.7,-1148.5],[1553.5,-1131.8],
  [1548.6,-1132.4],[1488.3,-1158.3],[1456.1,-1171],[1453.2,-1174.2],[1451.1,-1197.1],[1451.9,-1197.2],
  [1451.8,-1198.3],[1450.8,-1198.2],[1449.8,-1202],[1450.5,-1202.3],[1447.5,-1206.3],[1448.3,-1206.7],
  [1444.8,-1209.9],[1445.5,-1210.7],[1439.2,-1214.2],[1429.7,-1217.2],[1425.2,-1217.8],[1411.6,-1216.3],
  [1399.2,-1212.2],[1393.9,-1208],[1386.6,-1197],[1384.5,-1191.7],[1384.1,-1175.4],[1387,-1165.8],[1396.2,-1154.5],
  [1396.9,-1155.3],[1408.5,-1151.4],[1410.5,-1148.1],
];
// the stretch the gate and the house beside it stand ON: no wall across the portal
const GAP = [[1538.6, -1037.2], [1544.5, -1053.1]];
/** The gate, where the funnel ends: the floodlight is spent 45 m from here. */
export const GATE_AT = [1532, -1041.4];
// the bridge from Příhrádek, as the road runs: the stone bridge of 1805 (the
// tile's 7 m bridge way, s -7.2 to 0, which the generic ribbon dresses in a
// steel railing) and the embankment it was built with, as far as the path
// that climbs out of the moat to join it. The parapets' inner face stands 5 cm
// inside the deck's edge, so the railing and the kerb faces are inside them.
const BRIDGE = [[1576.7, -1018.6], [1546, -1038]], SPAN = [-7.6, 18.5], DECK = 2.35;
// the parapet's coping over the TERRAIN (the deck lies about 0.2 m over it,
// and the steel railing inside rises 0.9 m over the deck)
const BRIDGE_H = 1.3;

// The two walls the tile draws along the inner moat, either side of the bridge
// to the palace portal. Drawn by the generic ribbon they are 2 m of grey that
// hides the portal from the whole outer court; they are the moat's parapets,
// waist high, in the stone of the bridge (the moat itself is narrower than the
// survey's 20 m samples, so the ground does not dip for it).
const INNER = [
  [[1466.3, -1067.4], [1472.6, -1064.6], [1472.7, -1061.6], [1468, -1054.4]],
  [[1473.1, -1051.8], [1476.4, -1059.8], [1479, -1061.9], [1480.4, -1061.8], [1496.8, -1053.9], [1492.4, -1050.1]],
];
const PARAPET_H = 1.05, PARAPET_T = 0.5;

const STONE = 0xa99d87, BRICK = 0x9b6249, COPING = 0x8a8273, SLIT = 0x1b1916;
const WALL_H = 4.8, WALL_MIN = 1.7, THICK = 0.9;
// The bank behind the wall crests about here (absolute metres): where the soft
// ground of the survey already stands high at the wall's foot, the wall is the
// lower for it, so it never stands taller than the rampart it guards.
const CREST = 225.2;

const same = (p, q) => Math.abs(p[0] - q[0]) < 0.3 && Math.abs(p[1] - q[1]) < 0.3;

/** The wall, the bridge parapets: everything of the fortress that is masonry. */
export function buildValy(kit) {
  const ao = kit.ao, flood = kit.floodFn;
  kit.ao = false;                       // heights here are not "above the pavement"
  kit.floodFn = (x, y, z) => 0.55 * (1 - Math.hypot(x - GATE_AT[0], z - GATE_AT[1]) / 45);
  wall(kit);
  bridge(kit);
  for (const line of INNER) parapet(kit, line);
  kit.ao = ao; kit.floodFn = flood;
}

function wall(kit) {
  const S = ringArea(VALY) > 0 ? 1 : -1, n = VALY.length;
  const inner = kit.offsetRing(VALY, THICK);
  const top = (x, z) => {
    const g = kit.rel(x, z);
    return g + Math.max(WALL_MIN, Math.min(WALL_H, CREST - kit.ground - g));
  };
  for (let i = 0; i < n; i++) {
    const a = VALY[i], b = VALY[(i + 1) % n], a2 = inner[i], b2 = inner[(i + 1) % n];
    if ((same(a, GAP[0]) && same(b, GAP[1])) || (same(a, GAP[1]) && same(b, GAP[0]))) continue;
    const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    if (L < 0.05) continue;
    const nx = S * ez / L, nz = -S * ex / L;
    const m = Math.max(1, Math.ceil(L / 5));
    for (let k = 0; k < m; k++) {
      const t0 = k / m, t1 = (k + 1) / m;
      const p0 = [a[0] + ex * t0, a[1] + ez * t0], p1 = [a[0] + ex * t1, a[1] + ez * t1];
      const q0 = [a2[0] + (b2[0] - a2[0]) * t0, a2[1] + (b2[1] - a2[1]) * t0];
      const q1 = [a2[0] + (b2[0] - a2[0]) * t1, a2[1] + (b2[1] - a2[1]) * t1];
      const g0 = kit.rel(p0[0], p0[1]), g1 = kit.rel(p1[0], p1[1]);
      const h0 = top(p0[0], p0[1]), h1 = top(p1[0], p1[1]);
      const face = (u, v, lo0, lo1, hi0, hi1, fx, fz) =>
        kit.quad([u[0], lo0, u[1]], [v[0], lo1, v[1]], [v[0], hi1, v[1]], [u[0], hi0, u[1]], fx, 0, fz);
      // outside: rubble stone, the brick of later repairs under the coping
      kit.set(STONE, K.stone); face(p0, p1, g0 - 1.2, g1 - 1.2, h0 - 1.15, h1 - 1.15, nx, nz);
      kit.set(BRICK, K.brick); face(p0, p1, h0 - 1.15, h1 - 1.15, h0 - 0.22, h1 - 0.22, nx, nz);
      kit.set(COPING, K.stone); face(p0, p1, h0 - 0.22, h1 - 0.22, h0, h1, nx, nz);
      // inside, where the bank lies against it, and the top
      kit.set(STONE, K.stone); face(q0, q1, g0 - 1.2, g1 - 1.2, h0, h1, -nx, -nz);
      kit.set(COPING, K.stone);
      kit.quad([p0[0], h0, p0[1]], [p1[0], h1, p1[1]], [q1[0], h1, q1[1]], [q0[0], h0, q0[1]], 0, 1, 0);
      // a loophole for a handgun every few metres of a straight run
      if (L / m > 3.2 && h0 - g0 > 3 && hash2(i, k, 77) < 0.6) {
        const sx = (p0[0] + p1[0]) / 2 + nx * 0.03, sz = (p0[1] + p1[1]) / 2 + nz * 0.03, gy = (g0 + g1) / 2 + 1.9;
        const dx = ex / L * 0.11, dz = ez / L * 0.11;
        kit.set(SLIT, K.metal);
        kit.quad([sx - dx, gy, sz - dz], [sx + dx, gy, sz + dz], [sx + dx, gy + 0.95, sz + dz], [sx - dx, gy + 0.95, sz - dz], nx, 0, nz);
      }
    }
  }
}

// Two stone parapets with a pier every four metres. The deck is the road's
// own: the earthworks carry it over the moat as a causeway, and this is what
// makes a causeway read as the bridge it is.
function bridge(kit) {
  const [A, B] = BRIDGE, ex = B[0] - A[0], ez = B[1] - A[1], L = Math.hypot(ex, ez);
  const dx = ex / L, dz = ez / L, px = -dz, pz = dx;
  const at = (s, o) => [A[0] + dx * s + px * o, A[1] + dz * s + pz * o];
  const road = (s) => kit.rel(A[0] + dx * s, A[1] + dz * s);
  const block = (s0, s1, o0, o1, lo, hi0, hi1) => {
    const c = [at(s0, o0), at(s1, o0), at(s1, o1), at(s0, o1)], hi = [hi0, hi1, hi1, hi0];
    const f = [[-px, -pz], [dx, dz], [px, pz], [-dx, -dz]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      kit.quad([c[i][0], lo, c[i][1]], [c[j][0], lo, c[j][1]], [c[j][0], hi[j], c[j][1]], [c[i][0], hi[i], c[i][1]], f[i][0], 0, f[i][1]);
    }
    kit.quad([c[0][0], hi0, c[0][1]], [c[1][0], hi1, c[1][1]], [c[2][0], hi1, c[2][1]], [c[3][0], hi0, c[3][1]], 0, 1, 0);
  };
  const m = 6, step = (SPAN[1] - SPAN[0]) / m;
  for (const side of [-1, 1]) {
    const o0 = side * DECK, o1 = side * (DECK + 0.45);
    for (let k = 0; k < m; k++) {
      const s0 = SPAN[0] + k * step, s1 = s0 + step;
      kit.set(STONE, K.stone);
      block(s0, s1, Math.min(o0, o1), Math.max(o0, o1), Math.min(road(s0), road(s1)) - 2.2, road(s0) + BRIDGE_H, road(s1) + BRIDGE_H);
    }
    for (let k = 0; k <= m; k++) {
      const s = SPAN[0] + k * step, y = road(s);
      kit.set(COPING, K.stone);
      block(s - 0.4, s + 0.4, Math.min(o0, o1) - 0.14, Math.max(o0, o1) + 0.14, y - 2.2, y + BRIDGE_H + 0.3, y + BRIDGE_H + 0.3);
    }
  }
}

// A waist-high stone wall along a polyline, its foot and coping following the
// ground, in pieces of at most 3 m so it never floats over a dip.
function parapet(kit, line) {
  const t = PARAPET_T / 2;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    if (L < 0.05) continue;
    const dx = ex / L, dz = ez / L, px = -dz, pz = dx, m = Math.max(1, Math.ceil(L / 3));
    // (a joint's ends run on by half the thickness, so a corner closes)
    const s0 = i ? -t : 0, s1 = L + (i + 2 < line.length ? t : 0);
    for (let k = 0; k < m; k++) {
      const sa = s0 + (s1 - s0) * k / m, sb = s0 + (s1 - s0) * (k + 1) / m;
      const at = (s, o) => [a[0] + dx * s + px * o, a[1] + dz * s + pz * o];
      const ga = kit.rel(...at(sa, 0)), gb = kit.rel(...at(sb, 0));
      const c = [at(sa, -t), at(sb, -t), at(sb, t), at(sa, t)];
      const lo = [ga - 0.5, gb - 0.5, gb - 0.5, ga - 0.5], hi = [ga + PARAPET_H, gb + PARAPET_H, gb + PARAPET_H, ga + PARAPET_H];
      const fn = [[-px, -pz], [dx, dz], [px, pz], [-dx, -dz]];
      kit.set(STONE, K.stone);
      for (let j = 0; j < 4; j++) {
        const q = (j + 1) % 4;
        if ((j === 1 && k < m - 1) || (j === 3 && k > 0)) continue;     // inner joints are never seen
        kit.quad([c[j][0], lo[j], c[j][1]], [c[q][0], lo[q], c[q][1]], [c[q][0], hi[q], c[q][1]], [c[j][0], hi[j], c[j][1]], fn[j][0], 0, fn[j][1]);
      }
      kit.set(COPING, K.stone);
      kit.quad([c[0][0], hi[0], c[0][1]], [c[1][0], hi[1], c[1][1]], [c[2][0], hi[2], c[2][1]], [c[3][0], hi[3], c[3][1]], 0, 1, 0);
    }
  }
}

/**
 * Is this barrier one the fortress models itself: the chateau's foot wall
 * (citywall) or a parapet of the inner moat?
 */
export function isValyBarrier(f) {
  if (!f.p?.length) return false;
  const p = f.p[0];
  if (f.k === 'wall') return INNER.some((l) => l.length === f.p.length && same(p, l[0]));
  if (f.k !== 'citywall') return false;
  for (const q of VALY) if (same(p, q)) return true;
  return false;
}
