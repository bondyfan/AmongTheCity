// ---- cardress.js: the kinds redrawn from the real cars ---------------------------
// js/cardetail.js holds the drawing tools (greenhouse, lamps, flanks) and the
// older kinds. These four were redrawn against the real cars' dimensions on
// 20 Nov 2026, after "nemá tvar jako pravdová Škoda Octavia":
//
//   tesla         Model 3 Performance (Highland): blade lamps, no grille, a
//                 splitter and side ducts, clamp tail lamps, a lip on the lid
//   octavia       Octavia IV liftback: the wide high grille between slim lamps
//   octaviaCombi  the estate: long roof, rails, third window, raked tailgate
//   roadster      the 2026 Roadster: a wedge with pop-down lamps, a light bar
//                 across the tail, four nozzles and a wing
//
// The skeleton (stations, greenhouse) is vehicles.js KIND; STYLE_NEW is the
// exterior-only refinement of the nose and tail, DRESS_NEW the drawings. Each
// dress is called as fn(c, T): c the drawing context, T the tools of
// cardetail.js, so this file imports nothing from it (no cycle).
// No brand marks are drawn here: shapes and proportions only.

import { rect, rrect } from './carbody.js';

export const STYLE_NEW = {
  octavia: {
    wheel: 'five', sweepF: 0.15, sweepR: 0.08,
    sts: [[-2.243, 0.27, 0.68, 0.70], [-2.17, 0.21, 0.76, 0.86], [-1.85, 0.18, 0.825, 0.945],
      [-1.05, 0.16, 0.925, 0.99], [-0.60, 0.16, 0.965, 1.00], [0.60, 0.16, 0.995, 1.00],
      [1.45, 0.16, 1.03, 0.985], [2.10, 0.20, 1.085, 0.925], [2.38, 0.24, 1.09, 0.86], [2.443, 0.31, 1.04, 0.80]],
  },
  octaviaCombi: {
    wheel: 'five', sweepF: 0.15, sweepR: 0.07,
    sts: [[-2.243, 0.27, 0.68, 0.70], [-2.17, 0.21, 0.76, 0.86], [-1.85, 0.18, 0.825, 0.945],
      [-1.05, 0.16, 0.925, 0.99], [-0.60, 0.16, 0.965, 1.00], [0.60, 0.16, 0.995, 1.00],
      [1.45, 0.16, 1.03, 0.985], [2.15, 0.20, 1.06, 0.935], [2.40, 0.24, 1.05, 0.875], [2.443, 0.31, 1.02, 0.84]],
  },
  tesla: {
    wheel: 'aero', sweepF: 0.18, sweepR: 0.09, fender: 0.07, archGap: 0.045,
    sts: [[-2.305, 0.25, 0.555, 0.66], [-2.235, 0.19, 0.645, 0.84], [-1.86, 0.16, 0.735, 0.945],
      [-1.10, 0.15, 0.885, 0.99], [-0.66, 0.15, 0.935, 0.995], [0.60, 0.15, 0.975, 0.995],
      [1.50, 0.15, 1.02, 1.00], [2.08, 0.19, 1.075, 0.94], [2.35, 0.23, 1.088, 0.875], [2.415, 0.31, 1.03, 0.82]],
  },
  roadster: {
    wheel: 'multi', sweepF: 0.20, sweepR: 0.05, fender: 0.045, archGap: 0.03, crown: 0.02, sweepLenF: 0.75,
    sts: [[-2.342, 0.15, 0.335, 0.70], [-2.25, 0.11, 0.42, 0.86], [-1.80, 0.10, 0.56, 0.955],
      [-1.05, 0.10, 0.68, 0.99], [-0.60, 0.10, 0.73, 0.97], [0.50, 0.10, 0.80, 0.97],
      [1.40, 0.11, 0.90, 1.00], [1.95, 0.15, 0.93, 0.965], [2.17, 0.20, 0.925, 0.93], [2.212, 0.30, 0.89, 0.91]],
  },
};

// the grille of an Octavia IV: a wide hexagon pulled up to the bonnet edge
function skodaGrille(c, T, y0, y1) {
  const { M } = T, hex = (a) => [[-0.39 + a, y0 + a], [0.39 - a, y0 + a], [0.47 - a, y0 + 0.12], [0.44 - a, y1 - a], [-0.44 + a, y1 - a], [-0.47 + a, y0 + 0.12]];
  c.d('front', hex(0), M.chrome, { eps: 0.003, h: 0.05, hu: 0.1 });
  c.d('front', hex(0.016), M.gloss, { eps: 0.0055, h: 0.05, hu: 0.1 });
  c.near(() => { for (let k = -7; k <= 7; k++) if (k) c.d('front', rect(k * 0.055 - 0.005, y0 + 0.032, k * 0.055 + 0.005, y1 - 0.03), M.satin, { eps: 0.0075, h: 0.08 }); });
}

// what the two Octavias share: the face, the bumper, the bonnet creases
function octaviaFace(c, T) {
  const { M } = T;
  // slim lamps that touch the grille and rise a little toward the wing
  T.headlamp(c, 0.455, 0.80, 0.665, 0.735, 0.685, 0.76, { drl: 'bottom', proj: 2 });
  skodaGrille(c, T, 0.47, 0.728);
  // the lower intake: one wide mouth with an air curtain blade at each end
  c.d('front', [[-0.56, 0.255], [0.56, 0.255], [0.62, 0.375], [-0.62, 0.375]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
  c.near(() => {
    c.d('front', rect(-0.50, 0.30, 0.50, 0.312), M.satin, { eps: 0.0065, h: 0.05, hu: 0.12 });
    c.d('front', [[0.66, 0.27], [0.80, 0.30], [0.80, 0.43], [0.66, 0.40]], M.gloss, { mirror: true, eps: 0.004, h: 0.05, hu: 0.07 });
    // the two creases of the bonnet, running back from the grille's corners
    for (const sg of [1, -1]) c.d('top', [[sg * 0.40, c.S.z0 + 0.16], [sg * 0.405, c.S.z0 + 0.16], [sg * 0.525, c.S.green.z0 - 0.16], [sg * 0.52, c.S.green.z0 - 0.16]], M.gloss, { eps: 0.0025, h: 0.25, hu: 0.2 });
  });
  T.plinth(c, false, c.K.plateF, 0.56, 0.14);
}

export const DRESS_NEW = {
  // Škoda Octavia IV liftback
  octavia(c, T) {
    const { M } = T;
    const gh = T.greenhouse(c, { sideBack: 0.34, sideEnd: 0.11, backTop: 0.10, backEnd: 0.06 });
    T.flanks(c, gh, { handleDrop: 0.10 });
    T.fin(c, 0.92); T.wipers(c, gh);
    octaviaFace(c, T);
    // wide angular lamps running into the lid, the plate in the lid between them
    T.taillamp(c, 0.33, 0.775, 0.90, 0.985, 0.91, 1.02);
    T.plinth(c, true, c.K.plateR);
    c.d('rear', [[-0.66, 0.31], [0.66, 0.31], [0.60, 0.43], [-0.60, 0.43]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
    c.near(() => {
      c.d('rear', rect(-0.83, 0.865, 0.83, 0.874), M.gloss, { eps: 0.0025, h: 0.05, hu: 0.1 });   // lid shut line
      c.d('rear', rect(0.66, 0.45, 0.80, 0.48), M.ruby, { mirror: true, eps: 0.004, h: 0.05 });     // reflectors
    });
  },

  // Škoda Octavia IV Combi
  octaviaCombi(c, T) {
    const { M } = T, S = c.S, G = S.green;
    const cP = 1.36;                                       // the C-pillar, behind the rear door
    const gh = T.greenhouse(c, { sideBack: 0.0, sideEnd: 0.10, backTop: 0.10, backEnd: 0.04, backIn: 0.07, cPillar: cP, sideMax: G.cZ - 0.19 });
    T.flanks(c, gh, { handleDrop: 0.10, lines: [gh.zs0 - 0.10, (gh.zB0 + gh.zB1) / 2, cP + 0.02], handles: [gh.zB0 - 0.17, cP - 0.19] });
    T.fin(c, 1.55); T.wipers(c, gh);
    octaviaFace(c, T);
    // roof rails: the mark of the estate
    c.near(() => {
      for (const sg of [1, -1]) {
        const x = (z) => sg * (gh.edge(z) - 0.035);
        c.d('top', [[x(-0.02), -0.02], [x(1.0), 1.0], [x(1.95), 1.95], [x(1.95) - sg * 0.035, 1.95], [x(1.0) - sg * 0.035, 1.0], [x(-0.02) - sg * 0.035, -0.02]],
          M.satin, { eps: 0.022, h: 0.3, hu: 0.5 });
      }
      // the roof spoiler over the tailgate glass, with its brake light
      c.d('top', rect(-0.60, G.cZ - 0.02, 0.60, G.cZ + 0.05), M.gloss, { eps: 0.012, h: 0.2, hu: 0.3 });
    });
    // lamps: wide, high, cut by the tailgate, the plate in the gate below them
    T.taillamp(c, 0.36, 0.775, 0.86, 0.94, 0.865, 0.965);
    T.plinth(c, true, c.K.plateR);
    c.d('rear', [[-0.68, 0.30], [0.68, 0.30], [0.62, 0.43], [-0.62, 0.43]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
    c.near(() => {
      c.d('rear', rect(-0.84, 0.60, 0.84, 0.609), M.gloss, { eps: 0.0025, h: 0.05, hu: 0.1 });     // the gate's lower edge
      c.d('rear', rect(0.59, 0.62, 0.598, 1.03), M.gloss, { mirror: true, eps: 0.0025, h: 0.08 });  // …and its sides
      c.d('rear', rect(0.66, 0.45, 0.80, 0.48), M.ruby, { mirror: true, eps: 0.004, h: 0.05 });
      c.d('rear', rect(-0.16, 0.655, 0.16, 0.672), M.satin, { eps: 0.006, h: 0.05, hu: 0.1 });       // handle strip
    });
  },

  // Tesla Model 3 Performance
  tesla(c, T) {
    const { M } = T, S = c.S, G = S.green;
    const gh = T.greenhouse(c, { sideBack: 0.42, sideEnd: 0.085, backTop: 0.06, backEnd: 0.05, screenTop: 0.93, frame: M.gloss });
    T.flanks(c, gh, { flushHandles: true, handleDrop: 0.095 });
    T.wipers(c, gh);
    // the glass roof: header to the backlight in one piece
    const r0 = G.hdrZ + 0.09, r1 = G.cZ + (G.z1 - G.cZ) * 0.03;
    const rx = (z) => gh.edge(z) - 0.065;
    c.g('top', [[-rx(r0), r0], [rx(r0), r0], [rx(r1), r1], [-rx(r1), r1]], { h: 0.2, hu: 0.25 });
    // blade lamps: slim, set into the wing line, the inner tip lower than the outer
    T.headlamp(c, 0.43, 0.855, 0.628, 0.668, 0.652, 0.715, { drl: 'top', proj: 1, drlT: 0.012 });
    // the Performance bumper: a low wide intake, an upright duct at each corner, a splitter
    c.d('front', [[-0.50, 0.265], [0.50, 0.265], [0.56, 0.345], [-0.56, 0.345]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
    c.d('front', [[0.63, 0.275], [0.80, 0.30], [0.79, 0.50], [0.66, 0.47]], M.gloss, { mirror: true, eps: 0.004, h: 0.05, hu: 0.07 });
    c.d('front', [[-0.80, 0.205], [0.80, 0.205], [0.82, 0.245], [-0.82, 0.245]], M.gloss, { eps: 0.005, h: 0.05, hu: 0.1 });
    T.plinth(c, false, c.K.plateF, 0.54, 0.12);
    // clamp-shaped tail lamps in the lid, taller at the corner
    T.taillamp(c, 0.40, 0.775, 0.915, 0.965, 0.895, 1.0, { t: 0.022 });
    c.near(() => {
      c.put(c.tail, 'rear', rect(0.725, 0.905, 0.765, 0.99), null, { mirror: true, eps: 0.0085, gate: 0.9, h: 0.05 });   // the clamp's upright
      // the lip on the lid, gloss black
      c.d('top', [[-0.62, S.z1 - 0.09], [0.62, S.z1 - 0.09], [0.65, S.z1 - 0.035], [-0.65, S.z1 - 0.035]], M.gloss, { eps: 0.014, h: 0.2, hu: 0.2 });
      c.d('rear', rect(-0.84, 0.865, 0.84, 0.873), M.gloss, { eps: 0.0025, h: 0.05, hu: 0.1 });
    });
    T.plinth(c, true, c.K.plateR);
    // diffuser with its fins
    c.d('rear', [[-0.70, 0.27], [0.70, 0.27], [0.64, 0.45], [-0.64, 0.45]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
    c.near(() => {
      for (const x of [-0.36, -0.12, 0.12, 0.36]) c.d('rear', rect(x - 0.008, 0.28, x + 0.008, 0.40), M.gloss, { eps: 0.0065, h: 0.05 });
      c.d('rear', rect(0.70, 0.47, 0.82, 0.495), M.ruby, { mirror: true, eps: 0.004, h: 0.05 });
    });
  },

  // Tesla Roadster (2026)
  roadster(c, T) {
    const { M } = T, S = c.S, G = S.green, z1 = S.z1;
    const gh = T.greenhouse(c, { sideBack: 0.25, sideEnd: 0.07, backTop: 0.10, backEnd: 0.08, screenTop: 0.94, sideStart: 0.12, frame: M.gloss });
    T.flanks(c, gh, { flushHandles: true, handleDrop: 0.07, lines: [gh.zs0 - 0.16, gh.zB1 + 0.30], handles: [gh.zB1 + 0.12], mirrorS: 0.8, mirrorY: 0.05 });
    // the T-top: two glass panels with a spine between them
    const r0 = G.hdrZ + 0.06, r1 = gh.zB1 + 0.10;
    for (const sg of [1, -1]) {
      const x0 = sg * 0.035, x1 = (z) => sg * (gh.edge(z) - 0.06);
      c.g('top', [[x0, r0], [x1(r0), r0], [x1(r1), r1], [x0, r1]], { h: 0.2, hu: 0.2 });
    }
    // pop-down lamps: shut, they are two slits of light in the nose
    T.headlamp(c, 0.50, 0.90, 0.405, 0.428, 0.43, 0.458, { drl: 'top', proj: 1, drlT: 0.01 });
    // splitter, a low central intake, a duct in each corner
    c.d('front', [[-0.86, 0.125], [0.86, 0.125], [0.90, 0.165], [-0.90, 0.165]], M.gloss, { eps: 0.005, h: 0.05, hu: 0.1 });
    c.d('front', [[-0.36, 0.19], [0.36, 0.19], [0.42, 0.275], [-0.42, 0.275]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
    c.d('front', [[0.56, 0.19], [0.84, 0.215], [0.82, 0.34], [0.60, 0.30]], M.gloss, { mirror: true, eps: 0.004, h: 0.05, hu: 0.07 });
    c.near(() => {
      // a spine down the bonnet
      c.d('top', [[-0.004, -2.2], [0.004, -2.2], [0.004, -1.0], [-0.004, -1.0]], M.gloss, { eps: 0.0025, h: 0.3, hu: 0.1 });
    });
    T.plinth(c, false, c.K.plateF, 0.50, 0.11);
    // the side: an intake cut into the flank ahead of the rear wheel, a dark sill
    c.d('side', [[0.34, 0.36], [0.86, 0.33], [0.92, 0.66], [0.58, 0.60]], M.gloss, { mirror: true, eps: 0.004, h: 0.08, hu: 0.1 });
    c.band(c.detail, -0.98, 0.98, 0.115, 0.185, M.dark, { mirror: true, eps: 0.005, h: 0.08, hu: 0.3 });
    // the tail: one bar of light from corner to corner
    c.d('rear', rrect(-0.90, 0.735, 0.90, 0.80, 0.02, 2), M.ruby, { eps: 0.004, h: 0.05, hu: 0.1 });
    c.put(c.tail, 'rear', rect(-0.885, 0.762, 0.885, 0.79), null, { eps: 0.0075, gate: 0.9, h: 0.05, hu: 0.1 });
    c.near(() => c.put(c.brake, 'rear', rect(-0.885, 0.742, 0.885, 0.762), null, { eps: 0.0095, h: 0.05, hu: 0.1 }));
    if (c.lod) c.put(c.tail, 'rear', rect(-0.885, 0.742, 0.885, 0.79), null, { eps: 0.0075, gate: 0.9 });
    // the fascia under it: gloss black, with the four cold-gas nozzles
    c.d('rear', [[-0.84, 0.30], [0.84, 0.30], [0.88, 0.70], [-0.88, 0.70]], M.gloss, { eps: 0.004, h: 0.06, hu: 0.14 });
    c.d('rear', [[-0.74, 0.17], [0.74, 0.17], [0.80, 0.29], [-0.80, 0.29]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
    for (const x of [-0.46, -0.16, 0.16, 0.46]) {
      c.detail.add(T.cylZ(0.068, 0.11, x, 0.585, z1 - 0.005, c.lod ? 8 : 14), M.satin);
      if (!c.lod) c.detail.add(T.cylZ(0.05, 0.03, x, 0.585, z1 + 0.04, 12), M.liner);
    }
    c.near(() => { for (const x of [-0.31, 0, 0.31]) c.d('rear', rect(x - 0.008, 0.18, x + 0.008, 0.28), M.gloss, { eps: 0.0065, h: 0.05 }); });
    T.plinth(c, true, c.K.plateR, 0.50, 0.11);
    // the active wing, body colour, on two uprights
    // (low and wide: it rises out of the deck, it is not a tea tray on stilts)
    const wy = S.topAt(z1 - 0.20, 0) + 0.062;
    c.paint.add(T.box(1.70, 0.02, 0.27, 0, wy, z1 - 0.17, 0, -0.07));
    for (const sg of [1, -1]) c.detail.add(T.box(0.05, 0.07, 0.12, sg * 0.50, wy - 0.035, z1 - 0.16), M.dark);
  },
};
