// ---- landmarks-praha.js: the Old Town of Prague and Charles Bridge, registered ----
// WORKER SAFE (js/landmarks.js spreads these into its registry). Footprints
// and centroids measured in tiles -20_-2 and -21_-2 (round 7 survey); the
// entries follow the contract in js/landmarks.js.

import { buildRadniceVez, buildOrloj, buildKaple, buildArkyr, buildRadnice,
  radniceSolids, vezSolids, orlojSolids, kapleSolids, arkyrSolids } from './landmarks-staromak.js';
import { buildTyn, buildTynskaSkola, tynSolids, skolaSolids } from './landmarks-tyn.js';
import { buildSloup, sloupSolids, buildHus, HUS } from './landmarks-sloup.js';
import { buildOtbt, otbtSolids, buildMlst, mlstSolids, buildJudita, juditaSolids, buildMlstBrana, mlstBranaSolids } from './landmarks-mostecke.js';
import { buildKarluv, KARLUV_BOX, KARLUV_ZONES } from './landmarks-karluv.js';
import { buildPrasna, prasnaSolids, buildPrasnaSpoj, buildObecniDum, obecniSolids, buildMarkyza } from './landmarks-prasna.js';
import { MLYN_KOLO_EXTRA } from './landmarks-certovka.js';

const P = 'praha';

export const LANDMARKS_OLD = [
  // ---- the Old Town Hall: five footprints, one model (js/landmarks-staromak.js)
  { id: 'radnice-vez', region: P, name: 'Radniční věž', at: [-95680.9, -6155.2], area: 121, r: 4, top: 42.5, build: buildRadniceVez, solids: vezSolids },
  // the strip of the orloj housing on the tower's south face (unnamed, 28 m2)
  { id: 'radnice-orloj', region: P, at: [-95678.0, -6149.2], area: 28, r: 3, top: 15.4, build: buildOrloj, solids: orlojSolids },
  // the chapel east of the tower (unnamed, 50 m2) and its oriel, which the tile lifts to 8 m
  { id: 'radnice-kaple', region: P, at: [-95673.7, -6158.4], area: 50, r: 3, top: 14.6, build: buildKaple, solids: kapleSolids },
  { id: 'radnice-arkyr', region: P, at: [-95671.9, -6159.7], area: 13, r: 2, sky: true, top: 15.6, bot: 8.2, build: buildArkyr, solids: arkyrSolids },
  { id: 'staromak-radnice', region: P, name: 'Staroměstská radnice', at: [-95709.9, -6147.3], area: 1236, r: 10, top: 14.2, build: buildRadnice, solids: radniceSolids },
  // ---- Týn (js/landmarks-tyn.js)
  { id: 'tyn', region: P, name: 'Matka Boží před Týnem', at: [-95533.9, -6229.6], area: 1723, r: 12, top: 20, build: buildTyn, solids: tynSolids },
  { id: 'tynska-skola', region: P, name: 'Týnská škola', at: [-95576.2, -6221.5], area: 538, r: 8, top: 9.5, build: buildTynskaSkola, solids: skolaSolids },
  // ---- the Marian column: the tile's 0.5 m "house" of 57 m2 in the middle of the square
  { id: 'mariansky-sloup', region: P, name: 'Mariánský sloup', at: [-95633.9, -6191.0], area: 57, r: 3, top: 1.95, build: buildSloup, solids: sloupSolids },
  // ---- the bridge towers (js/landmarks-mostecke.js); the Old Town one and the
  // Lesser Town gate are lifted in the tile over their (missing) passages
  { id: 'otbt', region: P, name: 'Staroměstská mostecká věž', at: [-96186.9, -6057.5], area: 130, r: 4, lifted: true, top: 30.5, build: buildOtbt, solids: otbtSolids },
  { id: 'mlst', region: P, name: 'Malostranská mostecká věž', at: [-96670.6, -6184.7], area: 123, r: 4, top: 28.5, build: buildMlst, solids: mlstSolids },
  { id: 'judita', region: P, name: 'Juditina věž', at: [-96671.0, -6166.0], area: 110, r: 4, top: 13.5, build: buildJudita, solids: juditaSolids },
  { id: 'mlst-brana', region: P, at: [-96671.1, -6175.6], area: 79, r: 3, lifted: true, top: 11.6, build: buildMlstBrana, solids: mlstBranaSolids },
  // ---- the Powder Tower (lifted over Celetná in the tile), its covered bridge
  // to the Municipal House (a tile `bridge` 6 m up), and the house with the
  // canopy over its entrance (a lifted `roof` piece) (js/landmarks-prasna.js)
  { id: 'prasna-brana', region: P, name: 'Prašná brána', at: [-95173.1, -6177.5], area: 213, r: 5, lifted: true, top: 44, build: buildPrasna, solids: prasnaSolids },
  { id: 'prasna-spoj', region: P, at: [-95167.9, -6186.5], area: 47, r: 3, sky: true, kind: 'bridge', top: 14, bot: 6.3, build: buildPrasnaSpoj },
  { id: 'obecni-dum', region: P, name: 'Obecní dům', at: [-95169.5, -6231.7], area: 4225, r: 12, top: 16.5, build: buildObecniDum, solids: obecniSolids },
  { id: 'obecni-markyza', region: P, at: [-95134.1, -6216.9], area: 65, r: 3, sky: true, top: 10, bot: 9, build: buildMarkyza },
];

/** Footprint-less landmarks (js/landmarks.js EXTRAS). */
export const EXTRAS_OLD = [
  { id: 'hus', region: P, box: [HUS[0] - 10, HUS[1] - 10, HUS[0] + 10, HUS[1] + 10], build: buildHus },
  { id: 'karluv-most', region: P, box: KARLUV_BOX, build: buildKarluv },
  // the Velkopřevorský mlýn's wheel on the Čertovka (js/landmarks-certovka.js)
  MLYN_KOLO_EXTRA,
];
/** Where those draw their own props: capsules [ax, az, bx, bz, r] (js/landmarks.js ZONES). */
export const ZONES_OLD = [
  // the Hus monument's stone and its plaque (the ring of benches at 14.5 m stays)
  [HUS[0], HUS[1], HUS[0], HUS[1], 10.5],
  // Charles Bridge: the 25 statue props and the cross the tile stands on the riverbed
  ...KARLUV_ZONES,
];
/** Clear zones: no scattered tree in a passage or on a monument (js/landmarks.js CLEAR). */
export const CLEAR_OLD = [
  // no tree of Kampa grows up through Charles Bridge
  ...KARLUV_ZONES.map(([ax, az, bx, bz]) => [ax, az, bx, bz, 6]),
  // Celetná through the Powder Tower, and the passages of the bridge towers
  [-95195, -6182, -95149, -6170, 4],
  [-96200, -6061.5, -96172, -6055, 3.5],
  [-96684, -6176, -96658, -6175, 3.5],
  // Mostecká from the gate down to Malostranské náměstí: a street of houses
  // wall to wall, where the surface model read the gate and the eaves as
  // crowns and planted limes across the view of the towers
  // (past the facades: a crown there leans over the street from a stem the
  // raster put a metre or two inside the house front, 7 to 8 m off the line)
  [-96676, -6175.7, -96721.1, -6185.8, 8],
  [-96721.1, -6185.8, -96771.1, -6200, 7.5],
  [-96771.1, -6200, -96842.5, -6222.9, 5.5],
];

/** A way of Charles Bridge (its tile name; only bridge ways are asked). */
export const isOldBridgeWay = (f) => {
  if (f.n !== 'Karlův most') return false;
  const [x, z] = f.p[0], b = KARLUV_BOX;
  return x > b[0] && x < b[2] && z > b[1] && z < b[3];
};
