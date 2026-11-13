// ---- transitbody.js: where things are on a bus and on a trolleybus -------------
// One table for the four modules that have to agree about a body: the drawing
// (js/cardetail.js puts the door leaves and the display housings there), the
// crowd (js/pedestrians.js walks people to the doors), the destination
// displays (js/destsign.js) and the trolley poles (js/trolleypoles.js).
// Plain numbers, no imports: local frame of a car, nose at -z, kerb side +x,
// y up from the road.
//
// doors   metres BACK FROM THE NOSE along the kerb side to the middle of the
//         door people board by (the front one) and step off by (the middle)
// sign    the lit face of each display: its centre, width and height. `front`
//         and `rear` are across the car (x, y), `side` along it (z, y) on the
//         kerb side; front and rear stand `out` metres proud of the nose/tail
// poles   a trolleybus: where the two pole bases are hinged on the roof
// halt    metres from the stop to where the CENTRE of the body halts: a Czech
//         driver pulls up with the nose at the označník (half the body and a
//         hand short of it), so the post stands just ahead of the bumper, never
//         through the bodywork of a bus in a lay-by, and the front door is a
//         step back from where the people are waiting
export const TRANSIT_BODY = {
  bus: {
    doors: { front: 0.95, mid: 5.3 },
    halt: -6.2,                       // js/vehicles.js: 11.0 m long
    sign: {
      front: { x: 0, y: 2.73, w: 1.74, h: 0.21, out: 0.05 },
      side: { z: -3.2, y: 2.3, w: 1.3, h: 0.17 },
      rear: { x: 0.52, y: 2.38, w: 0.44, h: 0.24, out: 0.035 },
    },
    poles: null,
  },
  trolleybus: {
    doors: { front: 0.98, mid: 6.1 },
    halt: -6.8,                       // 12.2 m long
    sign: {
      front: { x: 0, y: 2.72, w: 1.8, h: 0.23, out: 0.05 },
      side: { z: -3.65, y: 2.27, w: 1.36, h: 0.18 },
      rear: { x: 0.54, y: 2.42, w: 0.46, h: 0.25, out: 0.035 },
    },
    // the bases sit on the roof behind the traction container; the wires of a
    // pair hang 0.6 m apart and so do the bases
    poles: { z: 1.9, y: 3.26, gap: 0.6, len: 6.2, restY: 3.36 },
  },
};

/** The table row for a car (by its kind), or null for anything that is not a bus. */
export const transitBody = (car) => TRANSIT_BODY[car?.kind] ?? null;

/** Where the front and the middle door of a bus are, metres back from its nose. */
export function doorsOf(car) {
  return (TRANSIT_BODY[car?.kind] ?? TRANSIT_BODY.bus).doors;
}
