// ---- airliner-cabin.js: the inside of the aircraft ----
// Built lazily: nothing is made until the cabin is first shown (airliner.js calls
// buildCabin in setCabin), so a parked aircraft costs nothing inside. The shell is
// one merged, vertex-coloured mesh: carpet, the sidewalls with a real opening for
// every passenger window and for the L1 doorway, the ceiling, the overhead bins,
// the window shades (most up, some half or shut), the galleys, the lavatories, and the cockpit and
// rear bulkheads. The L1 door's inner face is its own pivot so it swings with the
// outside panel. The seats are the 180-instance mesh from airliner-seats.js. A
// warm LED strip runs down the ceiling.
//
// Every surface is MeshLambertMaterial with an emissive term, so the cabin is lit
// by its own lamps at any hour: setBrightness(k) dims the emissive for a night
// cruise without touching the scene's lights.

import * as THREE from 'three';
import { AIRLINER as A, DOOR_L1, WINDOW, BLOCKS, ROW_Z, skinHalfWidth, skinSection } from './airliner-layout.js';
import { DOOR_HINGE } from './airliner-body.js';
import { Bag, boxAt } from './airliner-geom.js';
import { makeSeats } from './airliner-seats.js';

const Z0 = A.cockpitBulkheadZ, Z1 = A.cabinEndZ;
const FLOOR = A.floorY;
const DOOR_OPEN = 1.45; // rad, the same swing as the outside door in airliner.js

const C = {
  carpet: 0x3c4046,
  wall: 0xe9ebee,
  ceiling: 0xf3f4f5,
  bins: 0xc9ced4,
  shade: 0xe8e2d0,
  galley: 0x9aa3ab,
  lav: 0xdfe4ea,
  door: 0xd9dde2,
  led: 0xfff1d6,
};

// Half the width of the lining at z. The lining is the skin less its 12 cm.
const innerHalf = (z) => skinHalfWidth(z) - A.lining;
// The ceiling is 2.10 m over the floor, but in the nose it must stay under the
// skin's crown, which curves down toward the ogive.
function ceilingAt(z) {
  const s = skinSection(z);
  return Math.min(A.ceilingY, s.yc + s.b - 0.1);
}

// A wall plate: a thin box on the lining at side s (+1 right, -1 left), spanning
// z from za to zb and y from y0 to y1.
function plate(bag, s, za, zb, y0, y1) {
  if (zb - za < 1e-3 || y1 - y0 < 1e-3) return;
  const zm = (za + zb) / 2;
  bag.add(boxAt(s * innerHalf(zm), (y0 + y1) / 2, zm, 0.02, y1 - y0, zb - za), C.wall);
}

// The sidewall on side s, with an opening for every passenger window (the window
// band on the lining) and the L1 doorway on the left. Between the openings are
// full-height plates; beside, under and over each opening are plates to fill it.
function sidewall(bag, s) {
  const y0 = FLOOR + WINDOW.centreAbove - WINDOW.height / 2;
  const y1 = y0 + WINDOW.height;
  const hw = WINDOW.width / 2;
  const spans = ROW_Z.map((z) => ({ a: z - hw, b: z + hw, z, win: true }));
  if (s < 0) spans.push({ a: DOOR_L1.z - DOOR_L1.w / 2, b: DOOR_L1.z + DOOR_L1.w / 2, door: true });
  spans.sort((p, q) => p.a - q.a);
  let cur = Z0;
  for (const sp of spans) {
    if (sp.a > cur) plate(bag, s, cur, sp.a, FLOOR, ceilingAt((cur + sp.a) / 2));
    cur = Math.max(cur, sp.b);
    if (sp.win) {
      plate(bag, s, sp.a, sp.b, FLOOR, y0); // under the window
      plate(bag, s, sp.a, sp.b, y1, ceilingAt(sp.z)); // over it
    } else {
      plate(bag, s, sp.a, sp.b, FLOOR + DOOR_L1.h, ceilingAt(sp.a)); // over the doorway
    }
  }
  if (cur < Z1) plate(bag, s, cur, Z1, FLOOR, ceilingAt((cur + Z1) / 2));
}

// The shade on one window, drawn down by k (0 up in its slot, a strip at the
// top; 1 shut). It sits just inside the lining so it never z-fights the plates.
function shade(bag, s, z, k) {
  const y0 = FLOOR + WINDOW.centreAbove - WINDOW.height / 2;
  const y1 = y0 + WINDOW.height;
  const ym = y1 - Math.max(0.03, WINDOW.height * k);
  bag.add(boxAt(s * (innerHalf(z) - 0.03), (ym + y1) / 2, z, 0.012, y1 - ym, WINDOW.width + 0.02), C.shade);
}
// how far each passenger has his shade down: most up for the take-off (the crew
// ask for that), a few half, the odd one shut, the same every flight
const shadeOf = (row, s) => {
  if (row === 14 && s < 0) return 0;           // 14A: the player's own window
  const h = Math.abs(Math.sin(row * 12.9898 + s * 78.233) * 43758.5453) % 1;
  return h < 0.62 ? 0 : h < 0.88 ? 0.5 : 1;
};

// Floor and ceiling in 0.5 m slabs, so each follows the lining's taper in the nose.
function floorAndCeiling(bag) {
  for (let za = Z0; za < Z1 - 1e-6; za += 0.5) {
    const zb = Math.min(Z1, za + 0.5), zm = (za + zb) / 2;
    bag.add(boxAt(0, FLOOR - 0.05, zm, 2 * innerHalf(zm), 0.1, zb - za), C.carpet);
    const c = ceilingAt(zm);
    bag.add(boxAt(0, c - 0.05, zm, 2 * innerHalf(zm), 0.1, zb - za), C.ceiling);
  }
}

// The cockpit bulkhead, with its door in the middle, and the rear bulkhead.
function bulkheads(bag) {
  const iz = innerHalf(Z0), cz = ceilingAt(Z0);
  const dh = 1.9, dw = 0.35;
  bag.add(boxAt(-(iz + dw) / 2, (FLOOR + cz) / 2, Z0, iz - dw, cz - FLOOR, 0.1), C.wall);
  bag.add(boxAt((iz + dw) / 2, (FLOOR + cz) / 2, Z0, iz - dw, cz - FLOOR, 0.1), C.wall);
  bag.add(boxAt(0, FLOOR + dh + (cz - FLOOR - dh) / 2, Z0, 2 * dw, cz - FLOOR - dh, 0.1), C.wall);
  bag.add(boxAt(0, FLOOR + dh / 2, Z0 + 0.02, 2 * dw, dh, 0.06), C.door); // the cockpit door
  const rz = ceilingAt(Z1);
  bag.add(boxAt(0, (FLOOR + rz) / 2, Z1, 2 * innerHalf(Z1), rz - FLOOR, 0.1), C.wall);
}

// Overhead bins along each side of the aisle, and the galley and lavatory blocks.
function bins(bag) {
  for (const s of [1, -1]) {
    bag.add(boxAt(s * 1.2, 5.12, -1.0, 1.2, 0.45, 27), C.bins); // z -14.5 to 12.5
  }
}
function blocks(bag) {
  BLOCKS.forEach((b, i) => {
    const zm = (b.z0 + b.z1) / 2;
    const x0 = Math.max(b.x0, -innerHalf(zm)), x1 = Math.min(b.x1, innerHalf(zm));
    bag.add(boxAt((x0 + x1) / 2, FLOOR + 0.975, zm, x1 - x0, 1.95, b.z1 - b.z0), i === 3 ? C.lav : C.galley);
  });
}

/** The cabin: { group, setBrightness(k), setDoor(k), dispose() }. */
export function buildCabin() {
  const group = new THREE.Group();
  const bag = new Bag();
  floorAndCeiling(bag);
  for (const s of [1, -1]) sidewall(bag, s);
  for (let i = 0; i < ROW_Z.length; i++) {
    shade(bag, 1, ROW_Z[i], shadeOf(i + 1, 1));
    shade(bag, -1, ROW_Z[i], shadeOf(i + 1, -1));
  }
  bulkheads(bag);
  bins(bag);
  blocks(bag);
  const lining = new THREE.MeshLambertMaterial({ vertexColors: true });
  const shell = new THREE.Mesh(bag.build(), lining);
  group.add(shell);

  // The L1 door's inner face, pivoted on its forward edge at the lining's plane.
  const doorBag = new Bag();
  doorBag.add(boxAt(0, FLOOR + DOOR_L1.h / 2, DOOR_L1.w / 2, 0.03, DOOR_L1.h, DOOR_L1.w), C.door);
  const doorPivot = new THREE.Group();
  doorPivot.position.set(-innerHalf(DOOR_L1.z), 0, DOOR_HINGE.z);
  doorPivot.add(new THREE.Mesh(doorBag.build(), lining));
  group.add(doorPivot);

  // The seats, one instanced mesh with its own emissive term.
  const seatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  group.add(makeSeats(seatMat));

  // The LED strip: a basic material, so it reads as a light source.
  const ledMat = new THREE.MeshBasicMaterial({ color: C.led });
  const led = new THREE.Mesh(boxAt(0, A.ceilingY - 0.12, -1.0, 0.14, 0.03, 26), ledMat);
  group.add(led);

  return {
    group,
    /** The cabin's own light, 0 (dark, night cruise) to 1 (full). */
    setBrightness(k) {
      const kk = Math.max(0, Math.min(1, k));
      lining.emissive.setScalar(0.32 * kk);
      seatMat.emissive.setScalar(0.22 * kk);
      ledMat.color.setRGB(kk, 0.95 * kk, 0.82 * kk);
    },
    /** The L1 door: 0 closed (the inner face covers the doorway), 1 open. */
    setDoor(k) {
      doorPivot.rotation.y = -Math.max(0, Math.min(1, k)) * DOOR_OPEN;
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      group.clear();
    },
  };
}
