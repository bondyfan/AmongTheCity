// ---- airliner-wings.js: wings, flaps, slats, sharklets, tailplane, fin, pylons ----
// Everything that is a flat planform or a side profile. The wings are two slabs
// swept back 25 degrees with 5 degrees of dihedral. The flaps and slats are
// separate pieces of the same wing, poured into the same body buffer, so their
// vertices can be moved on their hinge lines when the flaps come out: no extra
// meshes, and the wing keeps its draw call.
//
// The planform formulas below are the single source for the wing's outline. The
// hinge lines and the flap positions are computed from them, so the pieces meet.

import { AIRLINER as A } from './airliner-layout.js';
import { PAINT, slab, prismZY, mirrorX, tube } from './airliner-geom.js';

const DEG = Math.PI / 180;
const H = A.wingHalfSpan;
const TAN_SWEEP = Math.tan(A.wingSweepDeg * DEG);
const TAN_DIHED = Math.tan(A.wingDihedralDeg * DEG);
const WING_T = 0.3; // thickness of the wing slab, taken downward from the top

// Leading edge, chord and top surface of the wing at spanwise distance x from the
// fuselage centreline. These are straight lines, so the planform is a trapezoid.
const LE = (x) => A.wingRootLeadingZ + x * TAN_SWEEP;
const CHORD = (x) => A.wingRootChord + (A.wingTipChord - A.wingRootChord) * (x / H);
const TE = (x) => LE(x) + CHORD(x);
const TOP = (x) => A.wingRootY + x * TAN_DIHED;
// the point at fraction f of the chord (0 at the leading edge, 1 at the trailing)
const AT = (x, f) => LE(x) + f * CHORD(x);

// The control surfaces, on the right wing (x > 0). Flaps hang from 72% of the
// chord; slats from the leading 12%. Each is a span of the wing.
const FLAP_SPANS = [[5.2, 9.6], [11.0, 16.2]];
const SLAT_SPAN = [8.5, 16.5];
const FLAP_F = 0.72, SLAT_F = 0.12;

// The hinge of a control surface: a point at its own inboard end and the unit
// direction along the span. `side` is +1 right, -1 left.
function hinge(side, x0, x1, f) {
  const p0 = [side * x0, TOP(x0) - 0.15, AT(x0, f)];
  const p1 = [side * x1, TOP(x1) - 0.15, AT(x1, f)];
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  return { p0, h: [d[0] / L, d[1] / L, d[2] / L] };
}

/**
 * Pour the airframe's flat and profile pieces into `body`. Returns the control
 * surfaces: { kind, start, count, p0, h, sign }. `start` and `count` are vertex
 * indices in the body buffer, and `sign` is the rotation sense that moves the
 * trailing (flap) or leading (slat) edge downward.
 */
export function addAirframe(body) {
  const panels = [];
  for (const side of [1, -1]) {
    const put = (geom, color) => body.add(side > 0 ? geom : mirrorX(geom), color);
    const piece = (geom, color, kind = null, hg = null) => {
      const start = body.vertexCount;
      put(geom, color);
      if (kind) {
        const h = hg.h;
        panels.push({ kind, start, count: body.vertexCount - start, p0: hg.p0, h,
          sign: kind === 'flap' ? Math.sign(h[0]) : -Math.sign(h[0]) });
      }
    };

    // the wing: a planform slab, painted white (the grey belly is on the fuselage
    // only; the wing underside stays white, which reads well from the chase camera)
    const plan = [[0, LE(0)], [H, LE(H)], [H, TE(H)], [0, TE(0)]];
    piece(slab(plan, TOP, WING_T), PAINT.white);

    // flaps and slats lie inside the wing at rest, just below its top surface, so
    // they are only seen once they move
    for (const [x0, x1] of FLAP_SPANS) {
      const fp = [[x0, AT(x0, FLAP_F)], [x1, AT(x1, FLAP_F)], [x1, AT(x1, 1)], [x0, AT(x0, 1)]];
      piece(slab(fp, (x) => TOP(x) - 0.03, 0.12), PAINT.white, 'flap', hinge(side, x0, x1, FLAP_F));
    }
    {
      const [x0, x1] = SLAT_SPAN;
      const sp = [[x0, AT(x0, 0)], [x1, AT(x1, 0)], [x1, AT(x1, SLAT_F)], [x0, AT(x0, SLAT_F)]];
      piece(slab(sp, (x) => TOP(x) - 0.03, 0.1), PAINT.white, 'slat', hinge(side, x0, x1, SLAT_F));
    }

    // sharklets: a short swept winglet on each tip, rising 2 m off the wingtip
    const yT = TOP(H), lt = LE(H), tt = TE(H);
    const winglet = [[lt + 0.15, yT - 0.05], [tt - 0.15, yT - 0.05], [tt - 0.02, yT + 2.0], [lt + 0.55, yT + 2.0]];
    piece(prismZY(winglet, 0.06, H - 0.03), PAINT.white);

    // tailplane: 12.6 m across, swept 30 degrees, root in the tail cone
    const SH = A.stabHalfSpan, TAN_S = Math.tan(A.stabSweepDeg * DEG);
    const sLE = (x) => A.stabRootLeadingZ + x * TAN_S;
    const sCH = (x) => A.stabRootChord + (A.stabTipChord - A.stabRootChord) * (x / SH);
    const sTOP = (x) => A.stabY + x * TAN_DIHED;
    const stab = [[0, sLE(0)], [SH, sLE(SH)], [SH, sLE(SH) + sCH(SH)], [0, sLE(0) + sCH(0)]];
    piece(slab(stab, sTOP, 0.2), PAINT.white);

    // pylon: a strut from the wing's underside down into the nacelle's top
    const ex = A.engineX, ey = A.engineY, ez = A.engineZ;
    const y0 = ey + 0.5, y1 = TOP(ex) - 0.05;
    const pylon = [[ez - 1.5, y1], [ez + 1.3, y1], [ez + 1.1, y0], [ez - 1.2, y0]];
    piece(prismZY(pylon, 0.3, ex - 0.15), PAINT.white);
  }

  // the fin: a navy profile in the (z, y) plane, 0.32 m thick, on the centreline
  // The leading edge sweeps back at 35 degrees from the root, and the trailing
  // edge keeps the root chord at the root and the tip chord at the tip.
  const tipLE = A.finRootLeadingZ + Math.tan(A.finSweepDeg * DEG) * (A.height - A.finRootY);
  const fin = [
    [A.finRootLeadingZ, A.finRootY],
    [tipLE, A.height],
    [tipLE + A.finTipChord, A.height],
    [A.finRootLeadingZ + A.finRootChord, A.finRootY],
  ];
  body.add(prismZY(fin, 0.32, -0.16), PAINT.navy);
  return panels;
}

/** Stations along the nacelle's axis: a rounded intake lip, a cylinder, and a
 *  taper to the nozzle. Returns the radius at z. Both engines use it. */
export function nacelleRadius(z) {
  const z0 = A.engineZ - A.nacelleLength / 2;
  const R = A.nacelleDiameter / 2;
  const u = (z - z0) / A.nacelleLength;
  let r = R;
  if (u < 0.08) r = R * (0.93 + 0.07 * Math.sqrt(Math.max(0, u) / 0.08));
  if (u > 0.7) r = R * (1 - 0.3 * ((u - 0.7) / 0.3) ** 2);
  return r;
}

/** The nacelle outer skin for one engine: a white tube, open at both ends. */
export function nacelleGeometry(side) {
  const z0 = A.engineZ - A.nacelleLength / 2, z1 = A.engineZ + A.nacelleLength / 2;
  const zs = [];
  for (let z = z0; z < z1; z += 0.2) zs.push(z);
  zs.push(z1);
  return tube(zs, (z) => {
    const r = nacelleRadius(z);
    return { xc: side * A.engineX, yc: A.engineY, a: r, b: r };
  }, 36);
}
