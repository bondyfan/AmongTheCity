// ---- the passenger aircraft: its numbers, its seats, its walls and its meshes ----
// The layout is the contract between what the player sees and where he can walk.
// These tests pin the numbers an airline pilot would recognise, and the walking
// rules the sit-down and the boarding walk depend on: a walker stays in the
// aisle, a seat is a seat, a step rises from the apron to the sill.
//
// three.js is resolved through the same hook the other tests use, so the real
// airliner modules run; nothing here re-implements geometry.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const L = await import('../js/airliner-layout.js');
const { makeAirliner } = await import('../js/airliner.js');
const { makeAirstairs } = await import('../js/airstairs.js');

const { AIRLINER: A, STAIRS, STAIRS_FOOT_X, SEATS, seatAt, inCabin, floorAt, push, ROW_Z } = L;

// ---- the numbers -------------------------------------------------------------

test('the airframe has an A320-class size', () => {
  assert.ok(Math.abs(A.length - 37.6) < 1e-9);
  assert.ok(Math.abs((A.tailZ - A.noseZ) - A.length) < 1e-9, 'nose and tail disagree with the length');
  assert.ok(Math.abs(A.span - 35.8) < 1e-9);
  assert.ok(Math.abs(-A.noseGearZ - A.wheelbase) < 1e-9, 'the nose gear is not one wheelbase forward');
  assert.ok(Math.abs(A.track - 2 * A.mainGearX) < 1e-9, 'the main gear track is not 7.6 m');
  assert.ok(Math.abs(A.floorY - 3.35) < 1e-9, 'the cabin floor is not at the sill height');
  assert.ok(A.ceilingY - A.floorY > 2.0 && A.ceilingY - A.floorY <= 2.2, 'the cabin is not 2 m tall');
  assert.ok(Math.abs(A.fuselageHalfWidth * 2 - 3.95) < 1e-9);
  assert.ok(A.fuselageTopY - A.fuselageBottomY <= A.height + 1e-9, 'the cabin is taller than the skin');
});

test('the stairs climb exactly to the sill, and the last step lands on the apron', () => {
  assert.ok(Math.abs(STAIRS.steps * STAIRS.rise - A.floorY) < 1e-9);
  assert.ok(Math.abs(STAIRS_FOOT_X - (STAIRS.platformOuter - STAIRS.steps * STAIRS.run)) < 1e-9);
});

// ---- the seats ------------------------------------------------------------------

test('there are 180 unique seats in 30 rows of six', () => {
  assert.equal(SEATS.length, 180);
  const keys = new Set(SEATS.map((s) => `${s.row}${s.letter}`));
  assert.equal(keys.size, 180, 'two seats share a name');
  assert.equal(new Set(SEATS.map((s) => s.row)).size, 30);
});

test('14A is a window seat on the left', () => {
  const p = seatAt(14, 'A');
  assert.ok(p.x < 0, 'A is not on the left');
  // the window seat is the one nearest the skin on that side
  const wall = A.fuselageHalfWidth - A.lining;
  assert.ok(Math.abs(p.x) > wall - 0.5, `14A sits ${(wall - Math.abs(p.x)).toFixed(2)} m from the wall`);
  assert.ok(Math.abs(p.z - ROW_Z[13]) < 1e-9, 'row 14 is not at its own z');
  assert.ok(Math.abs(p.y - (A.floorY + L.SEAT.cushionY)) < 1e-9, 'the cushion is not at floor + seat height');
});

test('seatAt is symmetric about the aisle', () => {
  for (let r = 1; r <= 30; r++) {
    for (const [a, b] of [['A', 'F'], ['B', 'E'], ['C', 'D']]) {
      const pa = seatAt(r, a), pb = seatAt(r, b);
      assert.ok(Math.abs(pa.x + pb.x) < 1e-9, `${r}${a} and ${r}${b} are not mirror images`);
      assert.equal(pa.z, pb.z);
    }
  }
});

// ---- where a walker may stand ---------------------------------------------------

test('a walker may stand in the aisle beside row 14', () => {
  const z = ROW_Z[13];
  assert.ok(inCabin(0, z), 'the aisle at row 14 is not walkable');
  assert.ok(inCabin(-0.1, z), 'the aisle edge beside row 14 is not walkable');
});

test('a walker may not stand outside the skin, nor inside a seat back', () => {
  assert.equal(inCabin(3.0, -1.0), false, 'a point outside the skin is walkable');
  assert.equal(inCabin(-1.49, ROW_Z[13] + 0.1), false, 'a point inside 14A is walkable');
});

test('the floor is the cabin floor inside and the steps outside when docked', () => {
  assert.equal(floorAt(0, ROW_Z[13], false), A.floorY);
  assert.equal(floorAt(-7.0, L.DOOR_L1.z, false), null, 'steps exist when the stairs are not docked');
});

test('the steps rise monotonically from the apron to the sill', () => {
  const zc = L.DOOR_L1.z;
  let last = -Infinity;
  // from the foot to the door: step centres, then the platform, then the doorway
  for (let k = STAIRS.steps - 1; k >= 0; k--) {
    const x = STAIRS.platformOuter - (k + 0.5) * STAIRS.run;
    const h = floorAt(x, zc, true);
    assert.ok(h !== null, `no floor on step ${k}`);
    assert.ok(h > last - 1e-9, `step ${k} at ${h} is below the one before at ${last}`);
    last = h;
  }
  const platform = floorAt((STAIRS.platformOuter + STAIRS.platformInner) / 2, zc, true);
  assert.ok(platform >= last, 'the platform is lower than the top step');
  assert.ok(Math.abs(platform - A.floorY) < 1e-9, 'the platform is not at the sill');
  assert.ok(Math.abs(floorAt(STAIRS_FOOT_X + 0.05, zc, true)) < 0.3, 'the foot is not on the ground');
});

// ---- pushing the walker back into bounds ---------------------------------------

test('push leaves a walker in the aisle alone', () => {
  assert.equal(push(0, ROW_Z[13]), null);
});

test('push takes a walker out of a seat row and back into the cabin', () => {
  const z = ROW_Z[13];
  const p = push(-0.9, z);
  assert.ok(p, 'a walker inside a seat was not moved');
  assert.ok(inCabin(p.x, p.z), 'the pushed walker is still not in the cabin');
  const q = push(-1.6, z + 0.3);
  assert.ok(q, 'a walker inside the window seat was not moved');
  assert.ok(inCabin(q.x, q.z), 'the walker pushed out of the window seat is outside the cabin');
});

test('push keeps a walker inside the skin, but lets him out through the door', () => {
  const p = push(-1.95, -10);
  assert.ok(p && Math.abs(p.x) < 1.95, 'a walker in the wall was not pushed back in');
  assert.equal(push(-1.9, L.DOOR_L1.z), null, 'the doorway pushes the walker back in');
});

// ---- the meshes -----------------------------------------------------------------

function meshesOf(root) {
  const out = [];
  root.traverse((o) => {
    if (o.isMesh) out.push(o);
  });
  return out;
}

test('the exterior builds with at most 8 meshes and every vertex is finite', () => {
  const air = makeAirliner();
  const meshes = meshesOf(air.group);
  assert.ok(meshes.length <= 8, `${meshes.length} meshes`);
  for (const m of meshes) {
    const pos = m.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i++) assert.ok(Number.isFinite(pos[i]), `non-finite vertex in ${m.name || 'a mesh'}`);
  }
  air.dispose();
});

test('the exterior fits its numbers within half a metre', () => {
  const air = makeAirliner();
  air.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(air.group);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - A.span) < 0.5, `span ${size.x.toFixed(2)} m`);
  assert.ok(Math.abs(size.z - A.length) < 0.5, `length ${size.z.toFixed(2)} m`);
  assert.ok(Math.abs(size.y - A.height) < 0.5, `height ${size.y.toFixed(2)} m`);
  assert.ok(Math.abs(box.min.z - A.noseZ) < 0.5, 'the nose is not where the layout puts it');
  assert.ok(Math.abs(box.max.z - A.tailZ) < 0.5, 'the tail is not where the layout puts it');
  air.dispose();
});

test('the skin is FrontSide, so the cabin sees through it', () => {
  const air = makeAirliner();
  // the body is the first mesh the aircraft adds (see airliner.js)
  const body = meshesOf(air.group)[0];
  assert.ok(body, 'no body mesh');
  assert.equal(body.material.side, THREE.FrontSide);
  air.dispose();
});

test('the cabin is built only when first shown, and then has at most 10 meshes', () => {
  const air = makeAirliner();
  const before = air.group.children.length;
  const exterior = meshesOf(air.group).length;
  air.setCabin(false);
  assert.equal(air.group.children.length, before, 'a hidden cabin was built');
  air.setCabin(true);
  assert.ok(air.group.children.length > before, 'showing the cabin did not add it');
  const cabinMeshes = meshesOf(air.group).length - exterior;
  assert.ok(cabinMeshes <= 10, `${cabinMeshes} cabin meshes`);
  air.dispose();
});

test('the stair truck is one mesh and stays inside the stairs footprint', () => {
  const st = makeAirstairs();
  const meshes = meshesOf(st.group);
  assert.equal(meshes.length, 1);
  st.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(st.group);
  assert.ok(box.min.x >= STAIRS.platformOuter - STAIRS.steps * STAIRS.run - 0.2, 'the truck runs past the foot');
  assert.ok(box.max.x <= STAIRS.platformInner + 0.2, 'the truck runs into the fuselage');
  assert.ok(box.max.y <= A.floorY + STAIRS.handrailHeight + 2.2, 'the canopy is too high');
  st.dispose();
});
