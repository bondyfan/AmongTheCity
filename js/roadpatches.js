// ---- roadpatches.js: road ways the tile build dropped, put back at index time ----
// Pure data and pure functions, no imports: js/geo.js indexPayload calls it,
// and geo.js is in the mesh WORKER's import graph.
//
// scripts/build-region.mjs drops every way tagged tunnel (anything but "no"),
// and that includes tunnel=building_passage: the street that runs THROUGH a
// gate tower. Where that street is a car road the tile then has a hole in it:
// Celetná stopped at the west face of the Powder Tower and began again at the
// east face, so no car could drive from the Old Town to náměstí Republiky,
// the AI turned round there and the GPS routed round the block. The landmark
// model has had its open passage since round 7; what was missing was the way.
//
// A patch is a tile road record exactly as the build would have written it
// (docs/TILE-FORMAT.md `roads`), its geometry baked from the OSM way (Overpass
// shape, projected with scripts/lib/world-area.mjs). Its ends are the SAME
// points as the tile roads it joins, to the decimetre, because every graph
// (traffic, routes, cyclists) links ways by their rounded end points.
//
// Identity: a patch is handed over with the tile that holds its first vertex
// (the rule every tile feature follows) and its _id is taken from the TOP of
// that tile's id block, counting down, so it never shifts the ids the tile's
// own features get (those seed tree sizes, lamp staggers, parking lots) and
// two co-op clients give it the same id whatever order their tiles came in.
// The record is made fresh on every call: indexPayload widens r.w and smooths
// r.p in place, and a tile can be indexed more than once in a session.
//
// THE TWO GREEN BRIDGES OF THE D11 (round 8). The same defect, four times: the
// motorway passes under the ecoducts by Žehuň (km 52.0) and Voleč (km 71.7;
// js/d11.js ECODUCTS) in OSM ways tagged tunnel=yes layer=-1, so the tiles
// had a 48 m and a 79 m HOLE in both carriageways and every graph dead-ended
// there (measured: the eastbound chain from the D0 stopped at x -32582). The
// OSM tunnel ways are straight two-node segments; the patches run a cubic
// (Hermite) curve between the tile ways' end points instead, leaving each
// end with the heading of the way it continues (the bend is 1.4 to 3.0
// degrees, the curve stays within 0.92 m of the chord), so the ribbon and a car at 130 km/h see no
// kink at the joins. Attributes are the neighbours' (they agree on both
// sides of each hole): motorway, w 11, v 130, oneway, ln 2, asphalt by
// Žehuň and concrete by Voleč. The green deck itself is the look package's.
//
// THE GROUND. The elevation model keeps the ecoduct: the earth of the green
// bridge stands 9 to 11 m over the carriageway, and geo.levelWay may cut a
// road only GRADE_CUT (14 cm) into a hill, so a patch levelled on it rode a
// hump 11.6 m high (measured on the real height maps). ecoductCuts() below are
// terrain stamps (js/terrainstamps.js makeStamp shape), ONE PER CARRIAGEWAY,
// along its own line: a flat floor 7.5 m out on the verge side (fading to
// nothing at 11.5 m) and 6.4 m on the median side, so the two floors meet at
// the median, each carriageway at its own level (they differ by up to 1.1 m
// here). The floor is the straight line between the ground 40 m before and
// 40 m after the hole, outside the mound and the dip the survey draws round
// it; one more vertex 20 m further on each end lies 0.5 m OVER the ground, so
// the dig (which only lowers) dies out where the floor meets the survey and
// never ends in a step. Why not one stamp along the midline: a cross slope
// made its open ends dig a pit (the end cap measures the distance radially),
// and its floor ended 0.5 m under the ground, a 1 m step that the levelling
// (which pins a road to dug ground, geo.js stampDelta) turned into a 0.6 m
// per 2 m kink at 130 km/h. Dug as below, and read as the game reads it
// (stampDelta included), the road over 150 m either side bends at most
// 0.053 m per 2 m step (the D11's own 300 m stretches nearby: median 0.017,
// worst 0.142) and rises at most 0.15 m over the line between its approaches
// 40 m out; the earth either side stays 10 m up for the deck to rest on. The
// corridor clamp in meshes.js lowers the drawn ground under the ribbon as
// everywhere. The stamps take effect only once terrainstamps.js lists them
// (its STAMP_REGIONS and STAMPS), which is not this file's to edit.

const PATCHES = [
  // Celetná through the Powder Tower (OSM way 225234148: residential, oneway,
  // one lane, covered, building_passage). w 1.5 is the CARRIAGEWAY the
  // passage holds: geo.js pave() adds the residential 2.5 for 4.0 m of
  // asphalt, and the kerbs and the narrow pavements either side (streets.js
  // verge, 1.7 m) reach the walls of the 6 m arch (js/landmarks-prasna.js PB).
  // The tile's Celetná is 8 m and stops at both faces of the tower: the street
  // narrows to one lane in the gate, which is what the real one does.
  { tx: -20, tz: -2, road: () => ({
    p: [[-95179.9, -6179.1], [-95169.4, -6175.9], [-95166.4, -6175]],
    t: 'residential', w: 1.5, v: 50, d: 1, s: 'asphalt', ow: 1, ln: 1, n: 'Celetná', pk: [1, 1],
  }) },
  // D11 under the Žehuň ecoduct, km 52.0, tile -7_-3. Eastbound (OSM way
  // 50417478) from the end of the way out of Prague to the start of the next;
  // westbound (50417476) the other way round, 12.8 m north of it.
  { tx: -7, tz: -3, road: () => ({
    p: [[-32581.9, -9975.1], [-32574.2, -9977.1], [-32566.5, -9979.3], [-32558.8, -9981.5],
      [-32551.2, -9983.9], [-32543.6, -9986.4], [-32536.1, -9989]],
    t: 'motorway', w: 11, v: 130, d: 1, s: 'asphalt', ow: 1, ln: 2,
  }) },
  { tx: -7, tz: -3, road: () => ({
    p: [[-32539.9, -10001.2], [-32547.4, -9998.7], [-32554.9, -9996.2], [-32562.4, -9993.8],
      [-32570, -9991.5], [-32577.6, -9989.3], [-32585.2, -9987.3]],
    t: 'motorway', w: 11, v: 130, d: 1, s: 'asphalt', ow: 1, ln: 2,
  }) },
  // D11 under the Voleč ecoduct, km 71.7. Both holes begin east of x -14400,
  // so both patches belong to tile -3_-3 (the tile of the first vertex), though
  // the eastbound way that arrives at the hole is filed in -4_-3 (its first
  // vertex is). Eastbound OSM 28403112, westbound 28403110.
  { tx: -3, tz: -3, road: () => ({
    p: [[-13701.1, -10738.7], [-13693.8, -10735.6], [-13686.6, -10732.5], [-13679.3, -10729.5],
      [-13671.9, -10726.6], [-13664.6, -10723.7], [-13657.2, -10720.9], [-13649.8, -10718.2],
      [-13642.3, -10715.5], [-13634.9, -10712.9], [-13627.4, -10710.4]],
    t: 'motorway', w: 11, v: 130, d: 1, s: 'concrete', ow: 1, ln: 2,
  }) },
  { tx: -3, tz: -3, road: () => ({
    p: [[-13622.8, -10721.5], [-13630.3, -10724], [-13637.8, -10726.7], [-13645.2, -10729.4],
      [-13652.6, -10732.3], [-13660, -10735.2], [-13667.4, -10738.1], [-13674.7, -10741.1],
      [-13682.1, -10744.2], [-13689.4, -10747.2], [-13696.7, -10750.3]],
    t: 'motorway', w: 11, v: 130, d: 1, s: 'concrete', ow: 1, ln: 2,
  }) },
];

/**
 * The trenches under the two ecoducts (see the header), as js/terrainstamps.js
 * makeStamp descriptions: one per carriageway, along its direction of travel
 * (so d < 0, the left, is the median), from 60 m before its hole to 60 m past
 * it, resampled every 20 m. base per vertex: the floor, read on the real
 * height maps; the first and last lie 0.5 m over the ground, so the dig fades
 * out on the survey itself. 'dig' only lowers. Fresh objects on every call.
 */
const TRENCH = [
  // Žehuň, eastbound
  { pts: [[-32640, -9960.2], [-32620.6, -9965.1], [-32600, -9970.5], [-32579.4, -9975.8], [-32558.8, -9981.5],
    [-32538.6, -9988.1], [-32518.5, -9995.3], [-32498.4, -10002.4], [-32479.6, -10009.1]],
  base: [241.28, 241.08, 240.74, 240.4, 240.05, 239.71, 239.37, 239.03, 240.29] },
  // Žehuň, westbound
  { pts: [[-32483.1, -10020.4], [-32502, -10013.9], [-32522.1, -10007.1], [-32542.2, -10000.4], [-32562.4, -9993.8],
    [-32582.8, -9987.9], [-32603.4, -9982.6], [-32623.9, -9977.4], [-32643.3, -9972.4]],
  base: [238.09, 237.89, 238.25, 238.6, 238.96, 239.32, 239.67, 240.03, 240.55] },
  // Voleč, eastbound
  { pts: [[-13756.1, -10762.6], [-13737.8, -10754.6], [-13719.6, -10746.7], [-13701.3, -10738.8], [-13683, -10731],
    [-13664.6, -10723.7], [-13645.9, -10716.8], [-13627.2, -10710.3], [-13608.3, -10704], [-13589.5, -10697.8],
    [-13570.4, -10691.7]],
  base: [265.81, 265.94, 266.43, 266.91, 267.39, 267.87, 268.36, 268.84, 269.32, 269.8, 270.4] },
  // Voleč, westbound
  { pts: [[-13565.7, -10703], [-13584.8, -10708.9], [-13603.7, -10715.2], [-13622.6, -10721.4], [-13641.4, -10728],
    [-13660, -10735.2], [-13678.5, -10742.7], [-13696.9, -10750.4], [-13715.2, -10758.1], [-13733.6, -10765.8],
    [-13752, -10773.6]],
  base: [269.97, 268.71, 268.31, 267.9, 267.5, 267.09, 266.69, 266.28, 265.88, 265.47, 265.33] },
];
// across the line: the median side (d < 0) to 6.4 m, the verge side to 7.5 m
// at full depth (the ribbon is 6.25), then a 1 m and a 4 m fade
const TRENCH_PROF = [[-7.4, 0, 0], [-6.4, 0, 1], [7.5, 0, 1], [11.5, 0, 0]];
export const ecoductCuts = () => TRENCH.map((c) => ({
  pts: c.pts.map((q) => q.slice()), base: c.base.slice(), mode: 'dig', prof: TRENCH_PROF.map((q) => q.slice()),
}));

/**
 * The tile's roads with the patches of tile (tx, tz) appended. `top` is one
 * past the last id of the tile's id block (geo.js: (slot + 1) * IDS_PER_TILE).
 * Returns `roads` itself (appended to in place), so the call is a drop-in.
 */
export function withRoadPatches(roads, tx, tz, top) {
  let k = 0;
  for (const q of PATCHES) {
    if (q.tx !== tx || q.tz !== tz) continue;
    const r = q.road();
    r._id = top - 1 - k++;
    roads.push(r);
  }
  return roads;
}

/** For tests and tools: every patch as the plain record (no _id). */
export const roadPatches = () => PATCHES.map((q) => ({ tx: q.tx, tz: q.tz, road: q.road() }));
