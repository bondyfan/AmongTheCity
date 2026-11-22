// ---- airstairs.js: the mobile stair truck that docks at L1 ----
// A white stair truck on two axles, docked perpendicular to the fuselage at the L1
// door and running out to -x. Its geometry is built from the STAIRS numbers in the
// layout, in the same plane-local frame as the aircraft, so the tread a walker
// stands on in floorAt() is the tread he sees. The steps are grey with a yellow
// nosing, the risers are white (a truck, not an open frame), the handrails run on
// both sides, and the platform has a small canopy at head height plus a little.
// One mesh, one material: the truck costs a single draw call.

import * as THREE from 'three';
import { AIRLINER as A, STAIRS, STAIRS_FOOT_X, DOOR_L1 } from './airliner-layout.js';
import { Bag, boxAt, cylAt } from './airliner-geom.js';

const PAINT = {
  white: 0xf2f4f6,
  step: 0x9a9b95,
  nosing: 0xe2c63a,
  steel: 0x9ca4ab,
  rubber: 0x23262b,
};

/** The stair truck's geometry, in the plane-local frame. */
export function stairsGeometry() {
  const bag = new Bag();
  const zc = STAIRS.zCentre, hw = STAIRS.width / 2, run = STAIRS.run, rise = STAIRS.rise;
  const floor = A.floorY;
  const pOuter = STAIRS.platformOuter, pInner = STAIRS.platformInner;

  // the platform deck, level with the sill, and the chassis under it
  const deckX = (pOuter + pInner) / 2, deckW = pInner - pOuter;
  bag.add(boxAt(deckX, floor - 0.06, zc, deckW, 0.12, STAIRS.width), PAINT.steel);
  bag.add(boxAt(deckX, (0.5 + floor - 0.12) / 2, zc, deckW, floor - 0.62, STAIRS.width - 0.1), PAINT.white);
  for (const dx of [-2.25, -2.9]) {
    for (const dz of [-0.5, 0.5]) {
      bag.add(cylAt(0, 0, 0, 0.4, 0.22, 14).rotateZ(Math.PI / 2).translate(dx, 0.4, zc + dz), PAINT.rubber);
    }
  }

  // the steps: step k covers x from pOuter - (k+1)*run to pOuter - k*run, and its
  // tread sits at floor - (k+1)*rise, the same height floorAt() returns there
  for (let k = 0; k < STAIRS.steps; k++) {
    const top = floor - (k + 1) * rise;
    const xIn = pOuter - k * run; // the edge nearest the aircraft
    const xc = xIn - run / 2;
    bag.add(boxAt(xc, top - 0.05, zc, run, 0.1, STAIRS.width), PAINT.step);
    bag.add(boxAt(xIn - 0.02, top - 0.012, zc, 0.04, 0.024, STAIRS.width), PAINT.nosing);
    if (top > 0.02) bag.add(boxAt(xc, top / 2 - 0.05, zc, run, top, STAIRS.width - 0.1), PAINT.white);
    // handrail posts and the rail, on both sides, one set per step
    for (const sg of [-1, 1]) {
      const rz = zc + sg * STAIRS.handrailOffset;
      bag.add(boxAt(xIn - 0.03, top + STAIRS.handrailHeight / 2, rz, 0.04, STAIRS.handrailHeight, 0.04), PAINT.steel);
      bag.add(boxAt(xc, top + STAIRS.handrailHeight, rz, run, 0.04, 0.04), PAINT.steel);
    }
  }
  // the platform's own rail: posts at its outer corners, and the rail across them
  for (const sg of [-1, 1]) {
    const rz = zc + sg * STAIRS.handrailOffset;
    bag.add(boxAt(pOuter + 0.03, floor + STAIRS.handrailHeight / 2, rz, 0.04, STAIRS.handrailHeight, 0.04), PAINT.steel);
    bag.add(boxAt(deckX, floor + STAIRS.handrailHeight, rz, deckW, 0.04, 0.04), PAINT.steel);
  }

  // the canopy: four posts at the platform's corners and a roof over it, high
  // enough to clear a walker (its underside is 2.1 m above the deck)
  const roof = floor + 2.1;
  for (const px of [pOuter + 0.1, pInner - 0.1]) {
    for (const sg of [-1, 1]) {
      bag.add(boxAt(px, floor + (roof - floor) / 2, zc + sg * 0.5, 0.06, roof - floor, 0.06), PAINT.steel);
    }
  }
  bag.add(boxAt(deckX, roof + 0.04, zc, deckW + 0.2, 0.08, STAIRS.width + 0.2), PAINT.white);
  return bag.build();
}

/** The stair truck: { group, dispose() }. The group is docked by its owner in the
 *  same plane-local frame as the airliner, so it needs no transform of its own. */
export function makeAirstairs() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(stairsGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  group.add(mesh);
  return {
    group,
    dispose() {
      mesh.geometry.dispose();
      mesh.material.dispose();
      group.clear();
    },
  };
}

// The foot of the stairs, plane-local: where the walker steps off the truck onto the apron.
export const STAIRS_FOOT = { x: STAIRS_FOOT_X, z: DOOR_L1.z };
