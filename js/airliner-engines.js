// ---- airliner-engines.js: what you see inside the engines, and the landing gear ----
// The nacelle's outer skin is white and belongs to the body pass. What you see
// through the intake is in this file: a dark disc at the back of the intake
// (so the inlet reads as black, not as sky), a fan that turns, a spinner, and the
// dark nozzle at the back. The fan geometry is built once and shared by both
// engines, each engine gets its own mesh so it can spin on its own.
//
// The gear is one merged mesh: two main legs with two wheels each, and a nose leg
// with two wheels. It is retracted by hiding it behind closed bay doors, which is
// what the brief allowed.

import * as THREE from 'three';
import { AIRLINER as A } from './airliner-layout.js';
import { PAINT, boxAt } from './airliner-geom.js';

const BLADES = 14;

/** The dark bits of one engine, poured into the dark bag: the intake's far disc
 *  and the nozzle cone. `side` is +1 right, -1 left. */
export function addEngineDark(dark, side) {
  const x = side * A.engineX, y = A.engineY;
  const z0 = A.engineZ - A.nacelleLength / 2, z1 = A.engineZ + A.nacelleLength / 2;
  // the intake's far disc, facing forward (its normal flipped to -z so it is seen
  // from the front, where the intake is)
  const disc = new THREE.CircleGeometry(0.85, 28).rotateY(Math.PI).translate(x, y, z0 + 0.5);
  dark.add(disc, PAINT.intake);
  // the nozzle: a cone narrowing toward the tail, closing the back of the nacelle
  const nozzle = new THREE.CylinderGeometry(0.4, 0.62, 0.6, 20).rotateX(Math.PI / 2).translate(x, y, z1 - 0.2);
  dark.add(nozzle, PAINT.nozzle);
}

/**
 * The fan: fourteen blades around a hub, and a spinner in front. Built in the
 * fan's own frame, its axis along z through the origin, so a mesh placed at the
 * engine's front and rotated about z turns the fan.
 */
export function fanGeometry(bag) {
  for (let i = 0; i < BLADES; i++) {
    const a = (i / BLADES) * Math.PI * 2;
    bag.add(boxAt(0, 0.45, 0, 0.1, 0.8, 0.03).rotateZ(a), PAINT.fan);
  }
  bag.add(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 14).rotateX(Math.PI / 2), PAINT.fan);
  // the spinner's point faces forward (-z), out of the intake
  bag.add(new THREE.CylinderGeometry(0.02, 0.32, 0.5, 18).rotateX(-Math.PI / 2).translate(0, 0, -0.25),
    PAINT.spinner);
  return bag;
}

/** Where a fan's mesh sits: its origin at the engine's front, on the engine axis. */
export function fanPosition(side) {
  return { x: side * A.engineX, y: A.engineY, z: A.engineZ - A.nacelleLength / 2 + 0.25 };
}

/** The landing gear, poured into `bag` (one merged mesh). The main legs are at
 *  x = ±3.8 with two wheels each, side by side; the nose leg is on the centreline
 *  under the cockpit with two wheels. Wheels touch y = 0. */
export function addGear(bag) {
  const R = A.wheelRadius, RN = 0.5;
  const wheel = (x, z, r) =>
    new THREE.CylinderGeometry(r, r, 0.36, 16).rotateZ(Math.PI / 2).translate(x, r, z);
  for (const side of [1, -1]) {
    const lx = side * A.mainGearX;
    // the leg from the belly down to the axle, and a short beam under the belly
    bag.add(boxAt(lx, 1.2, 0, 0.26, 1.36, 0.3), PAINT.strut);
    bag.add(boxAt(lx, 1.2 + 0.7, 0, 0.6, 0.12, 0.3), PAINT.strut);
    for (const dx of [-0.2, 0.2]) bag.add(wheel(lx + dx, 0, R), PAINT.wheel);
  }
  // the nose leg
  bag.add(boxAt(0, 1.1, A.noseGearZ, 0.2, 1.1, 0.2), PAINT.strut);
  for (const dx of [-0.22, 0.22]) bag.add(wheel(dx, A.noseGearZ, RN), PAINT.wheel);
  return bag;
}
