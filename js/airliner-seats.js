// ---- airliner-seats.js: the 180 seats, as one instanced mesh ----
// Every seat is the same little model: a pedestal, a cushion, a back with a
// headrest and a white antimacassar, two armrests, and a pocket on the back in
// front. The model is merged once into one geometry with vertex colours, and the
// 180 seats are instances of it, so the whole cabin's seating is a single draw call.
// The seat is built in its own frame: origin on the floor under the cushion's
// centre, facing -z, so an instance at (x, floor, z) is seated exactly where the
// layout puts the cushion.

import * as THREE from 'three';
import { AIRLINER as A, SEAT, SEATS } from './airliner-layout.js';
import { Bag, boxAt } from './airliner-geom.js';

export const SEAT_PAINT = {
  fabric: 0x4f5f74, // generic blue-grey, as brief
  frame: 0x2e3238,
  arm: 0x3a3f47,
  antimacassar: 0xf2f2f0,
  pocket: 0x262a30,
};

/** The one seat, merged, in the seat frame. */
export function seatGeometry() {
  const bag = new Bag();
  const cy = SEAT.cushionY;
  bag.add(boxAt(0, 0.12, 0.02, 0.06, 0.24, 0.12), SEAT_PAINT.frame); // pedestal
  bag.add(boxAt(0, cy, 0, 0.44, 0.08, 0.46), SEAT_PAINT.fabric); // cushion
  bag.add(boxAt(0, cy + 0.31, SEAT.backZ, 0.44, 0.62, 0.08), SEAT_PAINT.fabric); // back
  bag.add(boxAt(0, cy + 0.62 + 0.1, SEAT.backZ, 0.3, 0.2, 0.08), SEAT_PAINT.fabric); // headrest
  bag.add(boxAt(0, cy + 0.36, SEAT.backZ - 0.045, 0.34, 0.4, 0.01), SEAT_PAINT.antimacassar);
  bag.add(boxAt(0, cy + 0.2, SEAT.backZ - 0.05, 0.36, 0.24, 0.02), SEAT_PAINT.pocket); // pocket
  for (const sx of [-0.22, 0.22]) {
    bag.add(boxAt(sx, cy + 0.2, -0.02, 0.05, 0.04, 0.42), SEAT_PAINT.arm); // armrests
  }
  return bag.build();
}

/**
 * The seats as one InstancedMesh. `material` is the caller's (it carries the
 * cabin's emissive term, so the seats brighten with the cabin at night). The
 * instances are placed from the layout's SEATS list, in row order.
 */
export function makeSeats(material, floorY = A.floorY) {
  const mesh = new THREE.InstancedMesh(seatGeometry(), material, SEATS.length);
  const m = new THREE.Matrix4();
  for (let i = 0; i < SEATS.length; i++) {
    const s = SEATS[i];
    m.makeTranslation(s.x, floorY, s.z);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false; // the seats span the cabin, and it is one object
  return mesh;
}
