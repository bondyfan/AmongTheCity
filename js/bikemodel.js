// ---- bikemodel.js: four bicycles, in tubes -----------------------------------
// A town bike with a rack, a step-through with a basket, a road bike on drop
// bars and a child's bike: the four you see on any cycle path in Pardubice.
// Each is built here once, as plain triangles, from the SAME numbers the rider
// is posed with (`fit`: where the saddle, the cranks and the grips are), so a
// hand is on the bar and a foot is on the pedal by construction.
//
// A bicycle is drawn as five instanced parts (js/bikefleet.js):
//   frame   everything bolted to the main triangle: saddle, rack, rear guard
//   front   everything that turns with the bars: fork, stem, bars, front guard
//   wheel   one geometry for both wheels of every bike, scaled to its size
//   crank   the two arms and pedals
//   lamps   front white, rear red (at night)
// so the front can steer, the wheels roll and the cranks turn without a
// skeleton. The frame's colour is per bicycle: a `paint` vertex attribute says
// which triangles take it (tubes) and which keep their own (rubber, chrome,
// leather), see bikeMaterial().
//
// THE FRAME OF A BICYCLE, as for every vehicle and figure in the game: it
// faces -z, +x is its right, the origin is on the ground under the bottom
// bracket. Dimensions are those of an adult's bike for the reference rider
// (1.78 m); js/bikefleet.js scales each one to who is on it. Below, `f` is
// metres FORWARD of the bottom bracket (so z = -f).
//
// Pure geometry: three.js only, nothing from the DOM.

import * as THREE from 'three';
import { C, WHEEL_R, Sink, wheelGeo, crankGeo, lampGeo, poolGeo } from './bikeparts.js';

export { WHEEL_R };


/**
 * fit: what the rider's pose is solved against (js/poses.js makeRidePose,
 * js/gait.js makePedal), all for the reference rider, f forward of the bracket:
 *   seatY, seatF   the hip joint when seated
 *   bbY, crank     bottom bracket height, crank length; pedalX: half the tread
 *   gripY, gripF, gripX   where a hand holds the bar
 *   lean           how far the back is bent forward, radians
 *   standDrop, standF     how the hips come off the saddle at a stop
 */
export const BIKES = [
  { key: 'town', wheelR: 0.345, rearF: -0.47, frontF: 0.63, tyre: 1,
    pivot: [0.44, 0.79], top: [0.40, 0.96],
    lampF: [0.50, 0.80], lampR: [-0.74, 0.705],
    fit: { seatY: 1.03, seatF: -0.21, bbY: 0.285, crank: 0.165, pedalX: 0.115,
      gripY: 1.13, gripF: 0.30, gripX: 0.27, lean: 0.26, standDrop: 0.125, standF: 0.11 } },
  { key: 'lady', wheelR: 0.345, rearF: -0.48, frontF: 0.64, tyre: 1,
    pivot: [0.45, 0.79], top: [0.41, 0.99],
    lampF: [0.52, 0.80], lampR: [-0.75, 0.705],
    fit: { seatY: 1.02, seatF: -0.22, bbY: 0.285, crank: 0.165, pedalX: 0.115,
      gripY: 1.17, gripF: 0.27, gripX: 0.28, lean: 0.16, standDrop: 0.12, standF: 0.11 } },
  { key: 'road', wheelR: 0.335, rearF: -0.41, frontF: 0.585, tyre: 0.62,
    pivot: [0.43, 0.78], top: [0.395, 0.92],
    lampF: [0.47, 0.99], lampR: [-0.27, 0.845],
    fit: { seatY: 1.03, seatF: -0.19, bbY: 0.27, crank: 0.17, pedalX: 0.105,
      gripY: 0.97, gripF: 0.51, gripX: 0.20, lean: 0.78, standDrop: 0.14, standF: 0.12 } },
  // a child's: the rider is drawn at child size (js/cyclists.js), so in these
  // units the wheels are as big as an adult's and the frame is simply lower
  { key: 'child', wheelR: 0.33, rearF: -0.43, frontF: 0.58, tyre: 1.5,
    pivot: [0.41, 0.75], top: [0.375, 0.93],
    lampF: [0.47, 0.80], lampR: [-0.33, 0.82],
    fit: { seatY: 0.985, seatF: -0.20, bbY: 0.275, crank: 0.15, pedalX: 0.115,
      gripY: 1.11, gripF: 0.29, gripX: 0.25, lean: 0.18, standDrop: 0.10, standF: 0.10 } },
];

/** Frame paints, sRGB. Append only: a rider's colour is an index into this. */
export const PAINTS = [0x1d1f23, 0x24402e, 0x1e2f52, 0x9c2520, 0xdcdcd6, 0x8f959c, 0x3f8fb8, 0xd2691e,
  0x5e1f2c, 0x1f7a78, 0xd8b21c, 0x6c4a9a, 0x2e2e2e, 0x7a8f3a];
export const PAINTS_BRIGHT = [3, 6, 7, 9, 10, 11, 4, 13];   // road bikes and children's

const P = (f, y, x = 0) => [x, y, -f];      // forward-of-bracket to the model's own axes

// ---- the main triangle, and what is bolted to it ------------------------------
function frameGeo(b) {
  const s = new Sink(), t = b.key, fit = b.fit;
  const bb = P(0, fit.bbY), ra = b.rearF, R = b.wheelR;
  const road = t === 'road', lady = t === 'lady', child = t === 'child';
  const seatTop = P(fit.seatF + 0.035, fit.seatY - 0.19);          // top of the seat tube
  const post = P(fit.seatF + 0.012, fit.seatY - 0.105);            // top of the seat post
  const ht0 = P(b.pivot[0], b.pivot[1]), ht1 = P(b.top[0], b.top[1]);
  const r1 = road ? 0.016 : 0.019;
  // seat tube and post
  s.tube(bb, seatTop, r1, 0xffffff, 1);
  s.tube(seatTop, post, 0.012, C.chrome);
  // down tube, head tube
  s.tube(bb, [0, ht0[1] + 0.02, ht0[2] + 0.01], r1 * 1.1, 0xffffff, 1);
  s.tube(ht0, ht1, 0.021, 0xffffff, 1);
  // top tube: level on the road bike, sloping on the town bike, a low swoop on
  // the step-through and the child's
  const onSeat = (u, df = 0) => [0, bb[1] + (seatTop[1] - bb[1]) * u, bb[2] + (seatTop[2] - bb[2]) * u - df];
  if (lady) {
    s.path([onSeat(0.42), P(0.12, fit.bbY + 0.17), [0, ht0[1] + 0.05, ht0[2] + 0.012]], r1, 0xffffff, 1);
    s.path([onSeat(0.62), P(0.13, fit.bbY + 0.31), [0, ht1[1] - 0.035, ht1[2] + 0.012]], r1 * 0.85, 0xffffff, 1);
  } else if (child) {
    s.path([onSeat(0.72), P(0.14, fit.bbY + 0.31), [0, ht1[1] - 0.05, ht1[2] + 0.012]], r1, 0xffffff, 1);
  } else {
    s.tube(onSeat(road ? 0.97 : 0.9), [0, ht1[1] - 0.025, ht1[2] + 0.008], r1 * 0.95, 0xffffff, 1);
  }
  // rear triangle, both sides
  for (const sx of [-1, 1]) {
    const axle = P(ra, R, sx * 0.062);
    s.tube([sx * 0.03, bb[1], bb[2]], axle, 0.010, 0xffffff, 1, 5);
    s.tube([sx * 0.022, seatTop[1] - 0.04, seatTop[2]], axle, 0.008, 0xffffff, 1, 5);
  }
  // bottom bracket shell
  s.tube([-0.04, bb[1], bb[2]], [0.04, bb[1], bb[2]], 0.026, 0xffffff, 1, 8);
  // saddle: a wide back and a narrow nose
  const sy = fit.seatY - 0.085, sf = fit.seatF;
  const leather = road ? C.dark : lady ? C.tan : C.saddle;
  s.box(0, sy, -(sf - 0.055), road ? 0.13 : 0.19, 0.035, 0.14, leather);
  s.box(0, sy - 0.003, -(sf + 0.075), road ? 0.045 : 0.07, 0.03, 0.13, leather);
  if (!road) {
    // rear mudguard, hugging the tyre from behind the seat tube down the back
    s.band(R, -ra, R + 0.035, child ? 0.036 : 0.03, -0.75, 1.55, 9, child ? 0xffffff : C.guard, child ? 1 : 0);
    // chain guard
    s.box(0.052, fit.bbY + 0.045, -(ra / 2 + 0.04), 0.008, 0.07, Math.abs(ra) + 0.16, child ? 0xffffff : C.guard, child ? 1 : 0);
  } else {
    s.tube(P(0.02, fit.bbY + 0.01, 0.045), P(ra, R, 0.045), 0.004, C.steel, 0, 4);   // the chain
  }
  if (t === 'town' || lady) {
    // carrier: a platform over the wheel on two stays, and a stand
    const py = 2 * R + 0.055;
    s.box(0, py, -(ra - 0.10), 0.13, 0.012, 0.40, C.dark);
    for (const sx of [-1, 1]) {
      s.tube(P(ra, R, sx * 0.066), P(ra - 0.24, py - 0.006, sx * 0.058), 0.005, C.dark, 0, 4);
      s.tube(P(ra, R, sx * 0.066), P(ra + 0.02, py - 0.006, sx * 0.058), 0.005, C.dark, 0, 4);
    }
    s.tube(P(-0.10, fit.bbY - 0.02, -0.03), P(-0.26, 0.05, -0.16), 0.007, C.steel, 0, 4);
  }
  // rear reflector: red by day (the lamp itself is drawn over it at night)
  s.box(0, b.lampR[1], -b.lampR[0], 0.04, 0.03, 0.012, 0x8a1512);
  return s.build();
}

// ---- everything that turns with the bars ----------------------------------------
// Modelled about the PIVOT (the foot of the head tube), which is where
// js/bikefleet.js hangs it: positions here are relative to that point.
function frontGeo(b) {
  const s = new Sink(), t = b.key, fit = b.fit, R = b.wheelR;
  const road = t === 'road', lady = t === 'lady', child = t === 'child';
  const o = (f, y, x = 0) => [x, y - b.pivot[1], -(f - b.pivot[0])];
  // fork, both blades, curving forward to the axle
  for (const sx of [-1, 1]) {
    s.path([o(b.pivot[0], b.pivot[1] - 0.02, sx * 0.045), o(b.frontF - 0.07, R + 0.20, sx * 0.055), o(b.frontF, R, sx * 0.058)],
      0.011, road ? C.dark : 0xffffff, road ? 0 : 1, 5);
  }
  s.tube(o(b.pivot[0], b.pivot[1] - 0.02, -0.05), o(b.pivot[0], b.pivot[1] - 0.02, 0.05), 0.014, road ? C.dark : 0xffffff, road ? 0 : 1, 5);
  // stem, up the steering axis and then to the bar
  const topF = b.top[0], topY = b.top[1];
  const barF = road ? fit.gripF - 0.07 : fit.gripF + 0.075, barY = road ? fit.gripY - 0.02 : fit.gripY - 0.035;
  s.path([o(topF, topY), o(topF - 0.012, topY + 0.05), o(barF, barY)], 0.012, C.chrome, 0, 5);
  if (road) {
    // drop bars: across, forward to the hoods, down and back
    for (const sx of [-1, 1]) {
      const gx = sx * fit.gripX;
      s.path([o(barF, barY, 0), o(barF, barY, gx), o(fit.gripF, barY + 0.01, gx),
        o(fit.gripF + 0.03, barY - 0.07, gx), o(fit.gripF - 0.05, barY - 0.13, gx), o(fit.gripF - 0.13, barY - 0.13, gx)],
      0.011, C.dark, 0, 5);
      s.tube(o(fit.gripF - 0.01, barY + 0.012, gx), o(fit.gripF + 0.035, barY + 0.045, gx), 0.014, C.dark, 0, 5);   // the hood
    }
  } else {
    // swept bars: out from the stem and back to the grips
    for (const sx of [-1, 1]) {
      const gx = sx * fit.gripX;
      s.path([o(barF, barY, 0), o(barF + 0.005, barY + 0.012, gx * 0.55), o(fit.gripF + 0.05, fit.gripY, gx * 0.93)], 0.010, C.chrome, 0, 5);
      s.tube(o(fit.gripF + 0.05, fit.gripY, gx * 0.93), o(fit.gripF - 0.06, fit.gripY, gx * 1.03), 0.016, C.grip, 0, 6);
      s.tube(o(fit.gripF + 0.075, fit.gripY - 0.004, gx * 0.86), o(fit.gripF + 0.13, fit.gripY - 0.03, gx * 0.9), 0.005, C.dark, 0, 4);   // brake lever
    }
  }
  if (!road) {
    // front mudguard (round the axle, which is not on the pivot)
    const ay = R - b.pivot[1], az = -(b.frontF - b.pivot[0]);
    s.band(ay, az, R + 0.035, child ? 0.036 : 0.03, -1.15, 1.0, 8, child ? 0xffffff : C.guard, child ? 1 : 0);
  }
  if (lady) {
    // a wicker basket on the bars
    const bf = fit.gripF + 0.24, by = fit.gripY - 0.13;
    const c = o(bf, by);
    s.box(c[0], c[1], c[2], 0.30, 0.17, 0.21, C.wicker);
    s.box(c[0], c[1] + 0.09, c[2], 0.32, 0.015, 0.23, 0x7d5c33);
  }
  // headlamp housing (the glow is the fleet's lamp instance)
  const l = o(b.lampF[0], b.lampF[1]);
  s.box(l[0], l[1], l[2], 0.045, 0.045, 0.05, C.dark);
  return s.build();
}

let _geo = null;
/** Every geometry, built once: { frame: [4], front: [4], wheel, wheelFar, crank, lamp, pool }. */
export function bikeGeometry() {
  if (!_geo) {
    _geo = {
      frame: BIKES.map(frameGeo), front: BIKES.map(frontGeo),
      wheel: wheelGeo(false), wheelFar: wheelGeo(true), crank: crankGeo(), lamp: lampGeo(), pool: poolGeo(),
    };
  }
  return _geo;
}

let _mat = null;
/**
 * One material for every part of every bicycle. The instance colour is the
 * frame's paint and reaches only the triangles whose `paint` attribute is 1:
 * the stock shader would tint the tyres and the saddle with it too.
 */
export function bikeMaterial() {
  if (!_mat) {
    _mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.35,
      envMapIntensity: 0.8, side: THREE.DoubleSide });
    _mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float paint;')
        .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
	vColor.xyz = color * mix( vec3( 1.0 ), instanceColor.xyz, paint );
#endif`);
    };
    _mat.customProgramCacheKey = () => 'bike-paint-1';
  }
  return _mat;
}

/** For tests and a hard reset: every bicycle in the world draws with these. */
export function disposeBikeAssets() {
  if (_geo) {
    for (const g of [..._geo.frame, ..._geo.front, _geo.wheel, _geo.wheelFar, _geo.crank, _geo.lamp, _geo.pool]) g.dispose();
    _geo = null;
  }
  _mat?.dispose(); _mat = null;
}
