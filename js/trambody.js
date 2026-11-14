// ---- trambody.js: where things are on a Prague tram ------------------------------
// One table for the modules that have to agree about a tram body: the pose on
// the rail (js/trams.js puts each section on its two bogies), the drawing
// (js/trammesh.js builds each section type round the same numbers), the
// displays (js/tramsign.js) and the traffic hull (the blockers along it).
// Plain numbers, no imports.
//
// Lengths are metres BACK FROM THE NOSE of the whole consist, along the rail.
// A section stands on two bogies (`b0` ahead, `b1` behind) and reaches from
// `z0` to `z1`; its drawing is made in a frame whose origin is the midpoint of
// those two bogies, nose towards -z, kerb (door) side +x, y up from the rail
// panel. A Jacobs bogie under a joint is shared by the two sections either side
// of it, so the joint never opens however the track bends.
//
// Škoda 15T ForCity Alfa (Prague): 31.4 m, 2.46 m wide, three sections on four
// bogies, 100 % low floor, uni-directional, doors on the right (Škoda and
// Wikipedia; the bogie arcs are inferred from the section lengths, not from a
// drawing). Tatra T3 (general knowledge): 14.0 m, 2.5 m wide, two bogies
// 3.25 m in from each end, high floor, three double doors, in Prague mostly a
// coupled pair 1.0 m apart.

export const WIRE_H = 5.6;            // m: contact wire over the rail panel (js/meshes.js railWay draws it there)

export const TRAM_BODY = {
  '15T': {
    len: 31.4, wid: 2.46, floor: 0.35, roof: 3.2,
    bogies: [2.6, 11.0, 20.4, 28.8],
    sections: [
      { type: 'A', b0: 0, b1: 1, z0: 0, z1: 11.0 },          // the cab section
      { type: 'B', b0: 1, b1: 2, z0: 11.0, z1: 20.4 },       // the middle one, under the pantograph
      { type: 'C', b0: 2, b1: 3, z0: 20.4, z1: 31.4 },       // the tail
    ],
    doors: [3.4, 8.9, 15.7, 22.6, 28.0],                   // door centres, right side
    pantograph: { section: 1, at: 15.7 },
    sign: {
      front: { y: 2.68, w: 1.5, h: 0.24 },                 // on the nose, over the windscreen
      side: { at: 5.6, y: 2.34, w: 1.2, h: 0.2 },          // right side, behind the front door
      rear: { y: 2.62, w: 0.46, h: 0.24 },
    },
  },
  T3: {
    len: 14.0, wid: 2.5, floor: 0.9, roof: 3.06,
    bogies: [3.25, 10.75],
    sections: [{ type: 'T', b0: 0, b1: 1, z0: 0, z1: 14.0 }],
    doors: [1.6, 6.9, 12.3],
    pantograph: { section: 0, at: 7.0 },
    sign: {
      front: { y: 2.62, w: 1.2, h: 0.22 },
      side: { at: 4.2, y: 2.62, w: 1.0, h: 0.18 },
      rear: { y: 2.62, w: 0.42, h: 0.22 },
    },
  },
};

export const T3_GAP = 1.0;            // m between the two cars of a T3 pair, coupler to coupler

// The cars of a consist of `kind` (js/tramlines.js KIND_*): [{ body, off }],
// `off` metres from the consist's nose back to this car's nose.
const CONSISTS = [
  [{ body: '15T', off: 0 }],
  [{ body: 'T3', off: 0 }],
  [{ body: 'T3', off: 0 }, { body: 'T3', off: 14.0 + T3_GAP }],
];
export const consistOf = (kind) => CONSISTS[kind] ?? CONSISTS[0];

/** Nose to tail of a whole consist. */
export function consistLen(kind) {
  const c = consistOf(kind), last = c[c.length - 1];
  return last.off + TRAM_BODY[last.body].len;
}

/**
 * Where a section's drawing frame stands relative to its bogies: the
 * frame origin is the midpoint of b0 and b1, so the body reaches from
 * `front` (negative, ahead) to `back` metres along it.
 */
export function sectionSpan(body, sec) {
  const B = TRAM_BODY[body], mid = (B.bogies[sec.b0] + B.bogies[sec.b1]) / 2;
  return { mid, front: sec.z0 - mid, back: sec.z1 - mid };
}
