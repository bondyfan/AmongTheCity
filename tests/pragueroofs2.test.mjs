// ---- round 7 polish: chamfered corners, mansard dormers, the street door ----
// The pure halves of the BLOCKS polish: partywalls.chamferCorner (the Zizkov
// corner the oriel stands over), the dormers a Prague mansard's attic gets in
// place of roof windows (roofs.js roofCap -> roofgrammar.js), and the near
// shell's street door, which used to open two whole bays of ground floor.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { stampPartyWalls, chamferCorner, blockCorner } = await import('../js/partywalls.js');
const { roofInto } = await import('../js/roofs.js');
const { shellPieces } = await import('../js/pieces.js');
const { buildingPlan } = await import('../js/interiors.js');

// a point well inside Prague (Zizkov), so praguePlace() holds
const PX = -93500, PZ = -5700;
const recorder = () => {
  const tris = [];
  return { tris, triFacing(...a) { tris.push(a); }, tri() {}, quad() {}, pinTo() {} };
};

// a block corner house: two 20 m street walls joined by a 4 m cut, two walls
// shared with the neighbours, the corner pointing south-east
function cornerHouse(cut) {
  const c = cut / Math.SQRT2;
  return [[PX, PZ], [PX + 20 - c, PZ], [PX + 20, PZ + c], [PX + 20, PZ + 20], [PX + 8, PZ + 20],
    [PX + 8, PZ + 8], [PX, PZ + 8]].map(([x, z]) => [x, z]);
}

test('chamferCorner finds the cut-off corner, blockCorner the square one', () => {
  // neighbours on the two back walls make the street walls the free ones
  const mk = (cut) => {
    const f = { o: cornerHouse(cut), h: 18, lv: 5, r: 'gabled', _id: 501 };
    const n1 = { o: [[PX - 10, PZ], [PX, PZ], [PX, PZ + 8], [PX - 10, PZ + 8]], h: 18, _id: 502 };
    const n2 = { o: [[PX + 8, PZ + 20], [PX + 20, PZ + 20], [PX + 20, PZ + 30], [PX + 8, PZ + 30]], h: 18, _id: 503 };
    stampPartyWalls([f, n1, n2]);
    return f;
  };
  const cut = mk(4);
  assert.ok(cut._pw, 'the corner house shares walls');
  const k = chamferCorner(cut);
  assert.equal(k, 1, 'the 4 m cut is edge 1');
  assert.equal(blockCorner(cut), -1, 'a cut corner has no square street corner');
  // the square corner is the block corner's job, not the chamfer's
  const sq = mk(0.001);
  assert.equal(chamferCorner(sq), -1);
  // a cut of 9 m is a facade of its own, not a chamfer
  assert.equal(chamferCorner(mk(9)), -1);
  // a free-standing villa is no block corner of either kind
  assert.equal(chamferCorner({ o: cornerHouse(4) }), -1);
});

test('a Prague mansard shows its attic through dormers, not roof windows', () => {
  // a 24 x 12 m tenement whose two short walls are shared
  const o = [[PX, PZ], [PX + 24, PZ], [PX + 24, PZ + 12], [PX, PZ + 12]];
  const f = { o, h: 18, lv: 5, r: 'mansard', _id: 77, _pw: [0, 18, 0, 18] };
  const roof = { shape: 'cap', style: 'metal', hex: 0x4b4f57, ov: 0.32, src: 'proc', steep: true, attic: 1 };
  const full = recorder(), bare = recorder();
  assert.ok(roofInto(full, f, 'tenement', roof, 18, [0.6, 0.5, 0.4], 5, {}));
  assert.ok(roofInto(bare, f, 'tenement', roof, 18, [0.6, 0.5, 0.4], 5, { bare: true }));
  // the far shell ring keeps the roof windows (two tris each), the full tiers
  // trade them for dormers (eleven tris each), so the full roof is heavier,
  // but by tens of triangles, not hundreds
  const extra = full.tris.length - bare.tris.length;
  assert.ok(extra > 30 && extra < 300, `dormers add ${extra} triangles`);
  // every dormer stands on the roof, between the wall top and the mansard's top
  for (const t of full.tris.slice(bare.tris.length)) {
    for (const y of [t[1], t[4], t[7]]) assert.ok(y > 17 && y < 18 + 4.5, `a dormer vertex at y ${y}`);
  }
  // and none on the two shared walls: nothing beyond the long walls' span
  for (const t of full.tris) {
    for (const x of [t[0], t[3], t[6]]) assert.ok(x > PX - 1.5 && x < PX + 25.5);
  }
});

test('a mansard too shallow for a dormer keeps its roof windows', () => {
  // a 42 x 2.6 m wing: the slope steps down to 0.725 m deep, where no
  // dormer fits (one Prague mansard in eight), so the attic must still show
  // its windows in the slope instead of nothing at all
  const o = [[PX, PZ], [PX + 42, PZ], [PX + 42, PZ + 2.6], [PX, PZ + 2.6]];
  const f = { o, h: 18, lv: 5, r: 'mansard', _id: 78 };
  const roof = { shape: 'cap', style: 'metal', hex: 0x4b4f57, ov: 0.32, src: 'proc', steep: true, attic: 1 };
  const full = recorder(), bare = recorder();
  assert.ok(roofInto(full, f, 'tenement', roof, 18, [0.6, 0.5, 0.4], 5, {}));
  assert.ok(roofInto(bare, f, 'tenement', roof, 18, [0.6, 0.5, 0.4], 5, { bare: true }));
  // the panes are the dark glass colour roofs.js lays them in
  const panes = (r) => r.tris.filter((t) => t[12] < 0.06 && t[13] < 0.08 && t[14] < 0.11).length;
  assert.ok(panes(bare) >= 4, `the far ring shows ${panes(bare)} pane triangles`);
  assert.ok(panes(full) >= panes(bare), `the full tier shows ${panes(full)} pane triangles`);
});

test('the street door opens its own width, not two whole bays', () => {
  // a 5.4 m street front: two bays, and the door (t = 0.5) on the line between
  const o = [[PX, PZ], [PX + 5.4, PZ], [PX + 5.4, PZ + 10], [PX, PZ + 10]];
  const f = { o, h: 9.3, lv: 3, r: 'flat', t: 'residential', _id: 4242 };
  const plan = buildingPlan(f, [{ p: [[PX - 20, PZ - 6], [PX + 30, PZ - 6]], t: 'residential', d: 1 }], [f], 0);
  const ent = plan.entrance;
  assert.ok(ent, 'the house has a door');
  const pcs = shellPieces(plan).filter((p) => p.kind === 'ext' && p.leaf === 'ext' && !p.dead);
  // ground-floor wall pieces on the door's edge, below the lintel
  const a = o[ent.i], b = o[(ent.i + 1) % 4];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
  const low = pcs.filter((p) => p.y - p.hy < plan.y0 + 1.0 && p.y + p.hy > plan.y0 + 0.5
    && Math.abs((p.x - a[0]) * uz - (p.z - a[1]) * ux) < 0.6);
  // the open stretch along the edge at knee height
  const solid = [];
  for (const p of low) {
    const s = (p.x - a[0]) * ux + (p.z - a[1]) * uz;
    solid.push([s - p.hx, s + p.hx]);
  }
  solid.sort((x, y) => x[0] - y[0]);
  let gap = 0, at = 0;
  for (const [s0, s1] of solid) { gap = Math.max(gap, s0 - at); at = Math.max(at, s1); }
  gap = Math.max(gap, L - at);
  assert.ok(gap > ent.w - 0.1 && gap < ent.w + 0.3, `the doorway is ${gap.toFixed(2)} m for a ${ent.w} m door`);
});
