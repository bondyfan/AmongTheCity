// ---- landmarks-walks.js: the ways through the gates, for the crowd ----
// Pure data, no imports (js/pedestrians.js reads it; it is not in the mesher's
// graph and needs nothing from it).
//
// A covered way is not in the tile: Zelenobranská stops at the west face of
// the fore-gate and begins again at the east face of the tower, and the road
// into the chateau ends at one face of its gatehouse and starts at the other.
// The player walks through because the models have passages; the crowd walks
// the tile's footways and so turned round at every one of those walls.
//
// Each link below is one synthetic footway down the middle of a passage, from
// the end of a real footway to the end of the next (the crowd joins paths at
// their ENDS only). It is handed over WITH THE TILE that holds its anchor, the
// footway end it starts from, so every client gets it at the same moment of
// its own streaming, whatever the order its tiles came in; a path's identity
// in the crowd is a hash of its geometry, which is the same constant
// everywhere. Nothing here is drawn: the paving is the models' own.
//
// The coordinates are the passages' centre lines as the models build them
// (tests/landmarks.test.mjs walks every link against the models' solids).

const way = (id, p) => ({ _id: 'lmw:' + id, t: 'footway', w: 1.8, d: 0, s: 'cobble', p });

export const WALKS = [
  // Zelenobranská: under the fore-gate, across the little yard, under the tower
  { anchor: [1551.2, -693.2], way: way('zelena-brana', [[1551.2, -693.2], [1555.1, -695.4], [1565.4, -700.4], [1568.7, -702.5]]) },
  // the chateau: from the path in the moat up the bridge, through the gate in
  // the rampart and along the north side of the court road
  { anchor: [1558.1, -1030.4], way: way('zamek-brana', [[1558.1, -1030.4], [1549.0, -1036.1], [1539.2, -1039.0],
    [1525.3, -1043.8], [1520.5, -1050.5], [1504.5, -1057.3], [1499.4, -1057.1]]) },
  // ...on to the bridge over the inner moat
  { anchor: [1499.4, -1057.1], way: way('zamek-dvur', [[1499.4, -1057.1], [1497.4, -1060.4], [1479.0, -1068.3], [1476.7, -1066.4]]) },
  // ...and through the portal, under the north wing, into the courtyard
  { anchor: [1470.3, -1053.2], way: way('zamek-prujezd', [[1470.3, -1053.2], [1469.32, -1049.22], [1462.7, -1030.35], [1462.1, -1026.7]]) },
];

const near = (p, q) => Math.abs(p[0] - q[0]) < 0.6 && Math.abs(p[1] - q[1]) < 0.6;

/**
 * The links whose anchor is an end of one of these ways: call it with every
 * batch of roads the crowd ingests (the same link may come back twice; the
 * crowd already ignores a way it has seen).
 */
export function landmarkWalks(roads) {
  const out = [];
  if (!roads) return out;
  for (const r of roads) {
    const p = r.p;
    if (r.d || !p || p.length < 2) continue;
    const a = p[0], b = p[p.length - 1];
    // every anchor lies in the old town: one compare refuses the rest of the world
    if (a[0] < 1400 || a[0] > 1650 || a[1] < -1100 || a[1] > -650) continue;
    for (const w of WALKS) if (near(a, w.anchor) || near(b, w.anchor)) out.push(w.way);
  }
  return out;
}
