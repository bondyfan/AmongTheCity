// The Vyšehrad rock and tunnel as plain data: the stamps js/terrainstamps.js
// applies and the line js/vysehrad.js roofs over. A module of its own, with no
// imports, so that terrainstamps.js (which needs the stamps) and vysehrad.js
// (which needs terrainstamps.js to measure the rock) do not import each other.
// WORKER SAFE: plain data.

// The road's centreline through the spur, north portal to south portal (OSM
// 4890563, data/raw-region -20_-1), and on along both approaches, which the
// survey also carried up over the spur's flanks (to 203 m on the north one).
export const TUNNEL = [[-96033, -3595], [-96024, -3580], [-96015, -3566], [-96011, -3560],
  [-96007, -3554], [-96005, -3550], [-96003, -3544], [-96002, -3540], [-96001, -3536],
  [-96000, -3527], [-96000, -3518], [-95998, -3509], [-95993, -3495], [-95985, -3476],
  [-95977, -3458], [-95962, -3439], [-95950, -3420]];
// the road's level along it: Rašínovo nábřeží 193.3 to 193.7 at the north
// portal, Podolské nábřeží 194.9 at the south, rising to meet it at Podolí
export const TUNNEL_Y = [193.3, 193.5, 193.6, 193.6, 193.7, 193.8, 194.0, 194.1, 194.3,
  194.6, 194.9, 195.0, 195.1, 195.1, 195.3, 196.0, 196.6];
export const PORTALS = [4, 10];         // the vertices where the rock begins and ends
export const HALF = 7;                  // m: road, tram tracks and the footway inside

// m: the face rises from 7 m off the road's centreline, at 250 % to 30 m up
const FACE = { rise: 30, run: 12 };
const faceProf = [[-FACE.run - 20, FACE.rise, 0], [-FACE.run - 8, FACE.rise, 1], [-FACE.run, FACE.rise, 1],
  [0, 0, 1], [0.001, 0, 0]];

export const VYSEHRAD = {
  // the face north of the tunnel: the rock's foot 7 m east of Rašínovo
  // nábřeží, travelling south, so the rock is on the left (d < 0)
  faceN: { pts: [[-96035, -3667], [-96022, -3605], [-96013, -3583], [-96005, -3565]],
    base: [192.8, 193.4, 193.6, 193.8], mode: 'raise', prof: faceProf, capped: false },
  // and south of it, 7 m east of Podolské nábřeží, travelling south too
  faceS: { pts: [[-95990, -3505], [-95988, -3492], [-95970, -3460]],
    base: [195.2, 195.2, 195.0], mode: 'raise', prof: faceProf, capped: false },
  tunnel: { pts: TUNNEL, base: TUNNEL_Y, mode: 'dig', capped: false, snap: true,
    prof: [[-HALF - 0.001, 0, 0], [-HALF, 0, 1], [HALF, 0, 1], [HALF + 0.001, 0, 0]] },
};
