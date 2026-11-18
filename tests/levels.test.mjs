// ---- bridges and underpasses: things on different levels do not meet ----------
// "Pořád to dělá blbosti a chyby" (18 Nov 2026). Under the railway in Jana
// Palacha the fences and lamps stood on ground that is not drawn, the cars lay
// along the terrain instead of the road with their tails in the asphalt, a
// three-way rail joint on the bridge dived into the street, and under any
// bridge the player's car crashed into the traffic crossing over it. Each
// piece of pure logic behind the fixes is pinned here.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { sameLevel, inBand, LEVEL_GAP } = await import('../js/levelsep.js');
const { deckLevel, deckSlope, pitchOf, surfaceLift, deckOver, LIFT_MAX } = await import('../js/roadpose.js');
const { drawnGround } = await import('../js/drawnground.js');
const { roadCorr } = await import('../js/batter.js');
const { driveStep } = await import('../js/vehicles.js');
const { Poles } = await import('../js/poles.js');
const geo = await import('../js/geo.js');
const { stitchStructures } = await import('../js/underpass.js');
const THREE = await import('three');

// a way with a levelled profile of its own (what geo.roadProfile caches)
function gradedWay(p, levels, terrain, extra = {}) {
  const len = geo.polylineLength(p);
  const n = levels.length, ds = len / (n - 1);
  return { p, t: 'secondary', w: 9, d: 1, _len: len, _vg: null,
    _prof: { terrain, ready: true, n, ds, y: Float32Array.from(levels), ground: Float32Array.from(levels) }, ...extra };
}

test('levels: a kerb, a ramp and a flight of steps are one level; a deck overhead is not', () => {
  assert.ok(sameLevel(220, 220.12), 'a kerb');
  assert.ok(sameLevel(220, 221.9), 'a flight of steps');
  assert.ok(!sameLevel(214.3, 221.4), 'the railway over Jana Palacha');
  assert.ok(!sameLevel(221.4, 214.3), '…and the other way round');
  assert.ok(!sameLevel(220, 220 + LEVEL_GAP + 0.01));
  // far ahead a road may have climbed: a leader 40 m up a 7 % ramp is still a leader
  assert.ok(sameLevel(220, 222.8, 40));
  assert.ok(!sameLevel(220, 226, 20), 'a deck 6 m up, 20 m ahead, is not');
  // what cannot be told apart behaves as it always did
  assert.ok(sameLevel(220, undefined) && sameLevel(NaN, 220) && sameLevel(undefined, undefined));
});

test('levels: a tall body is met anywhere up its height, and not from over it', () => {
  assert.ok(inBand(220.3, 220, 3.4), 'a car beside a tram');
  assert.ok(inBand(222, 220, 3.4), 'the roof line');
  assert.ok(!inBand(226, 220, 3.4), 'a car on the bridge over the tram');
  assert.ok(!inBand(214, 220, 3.4), 'a car in the underpass below it');
  assert.ok(inBand(undefined, 220, 3.4) && inBand(220, NaN, 3.4));
});

test('a car lies along its ROAD: level on a deck whatever the valley under it does', () => {
  // a flat deck 12 m over a river valley whose bank falls 40 % under the car
  const terrain = { ready: () => true, heightAt: (x) => 220 - Math.max(0, Math.min(12, (x - 10) * 0.4)) };
  const deck = { p: [[0, 0], [60, 0]], _len: 60, br: 1, t: 'secondary', w: 9, d: 1,
    _bridgeProfile: { terrain, ready: true, start: 220, end: 220, deck: 220, m0: 0, m1: 0, r0: 6, r1: 6 } };
  assert.strictEqual(deckLevel(deck, 20, terrain), 220);
  const g = deckSlope(deck, 20, terrain, 4.6);
  assert.ok(Math.abs(g) < 1e-9, `the deck read a slope of ${g}`);
  // what the terrain under the same wheelbase says: the bug
  const ter = (terrain.heightAt(22.3, 0) - terrain.heightAt(17.7, 0)) / 4.6;
  assert.ok(Math.abs(ter) > 0.3, 'the fixture has no valley');
  assert.strictEqual(pitchOf(0), 0);
});

test('a car lies along its ROAD: the grade of a ramp, signed, never past 45 degrees', () => {
  const terrain = { ready: () => true, heightAt: () => 0 };
  // 6 % up along the way
  const ramp = gradedWay([[0, 0], [100, 0]], Array.from({ length: 51 }, (_, i) => 200 + i * 2 * 0.06), terrain);
  const g = deckSlope(ramp, 50, terrain, 12);          // a trolleybus
  assert.ok(Math.abs(g - 0.06) < 1e-3, `read ${g}`);
  assert.ok(Math.abs(pitchOf(g) - Math.atan(g)) < 1e-12);
  assert.ok(pitchOf(-g) < 0, 'driving down it the nose is down');
  // at the very end of the way the chord stays on the way
  assert.ok(Math.abs(deckSlope(ramp, 0, terrain, 4.6) - 0.06) < 1e-3);
  assert.ok(Math.abs(deckSlope(ramp, 100, terrain, 4.6) - 0.06) < 1e-3);
  assert.strictEqual(pitchOf(50), Math.atan(1));
  // an ungraded way says nothing rather than something wrong
  assert.strictEqual(deckSlope({ p: [[0, 0], [9, 0]], _len: 9 }, 4, null), 0);
});

test('an AI car is lifted onto the sheet drawn over its road, never onto a deck', () => {
  assert.strictEqual(surfaceLift(227.15, 227.88), 227.88 - 227.15, 'a slip road inside its carriageway');
  assert.strictEqual(surfaceLift(220, 220.01), 0, 'its own road');
  assert.strictEqual(surfaceLift(220, 219.5), 0, 'its own road is the one on top');
  assert.strictEqual(surfaceLift(214.3, 221.4), 0, 'the bridge overhead is another level');
  assert.strictEqual(surfaceLift(220, 220 + LIFT_MAX + 0.01), 0);
  assert.strictEqual(surfaceLift(220, 220.5, false), 0, 'grass beside the road');
});

test('props stand on the ground that is DRAWN: under the corridor of a cutting, the grid elsewhere', () => {
  // the height grid arches to 217.1 over a street laid at 214.3 (Jana Palacha)
  const terrain = { ready: () => true, heightAt: () => 217.1 };
  const street = gradedWay([[0, 0], [0, 100]], [214.3, 214.3, 214.3], terrain);
  const corr = [roadCorr(street, [0, 0, 0, 100])];
  const g = drawnGround(terrain, corr);
  // beside the kerb, where the fence along the cutting runs: at the street, not 2.8 m over it
  const atFence = g.heightAt(5.6, 50);
  assert.ok(atFence < 214.3 + 0.2 + 0.01 && atFence > 214.3, `the fence would stand at ${atFence}`);
  // up the bank the ceiling rises until it meets the grid
  assert.ok(g.heightAt(12, 50) > atFence && g.heightAt(12, 50) < 217.1);
  // far from every corridor it is the grid, to the bit
  assert.strictEqual(g.heightAt(60, 50), 217.1);
  assert.strictEqual(g.heightAt(5.6, 400), 217.1);
  // asked twice (the bucket is remembered) it answers the same
  assert.strictEqual(g.heightAt(5.6, 50), atFence);
  assert.strictEqual(g.raw, terrain);
  // nothing to clamp under: the terrain itself, untouched
  assert.strictEqual(drawnGround(terrain, []), terrain);
  assert.strictEqual(drawnGround(null, corr), null);
});

test('no lamp under a deck lower than the column: the deck over a spot is found by its height', () => {
  const terrain = { ready: () => true, heightAt: () => 214 };
  const rail = { p: [[-30, 20], [30, 20]], _len: 60, br: 1, t: 'rail',
    _bridgeProfile: { terrain, ready: true, start: 221.4, end: 221.4, deck: 221.4, m0: 0, m1: 0, r0: 6, r1: 6 } };
  // a 7.6 m column standing at 214.5 under the track
  assert.strictEqual(deckOver([rail], 5, 20.5, 214.5 + 1.5, 214.5 + 7.6 + 0.8, terrain), 221.4);
  // beside the bridge, clear of its edge
  assert.strictEqual(deckOver([rail], 5, 26, 216, 223, terrain), null);
  // a viaduct 15 m up is over the lamp, not in it
  assert.strictEqual(deckOver([rail], 5, 20.5, 200 + 1.5, 200 + 8.4, terrain), null);
  // a way that is no bridge is no deck
  assert.strictEqual(deckOver([{ ...rail, br: 0 }], 5, 20.5, 216, 223, terrain), null);
});

// ---- the player's car against the traffic of another level ----------------------
const DT = 1 / 60;
const FLAT = { collide: () => false, surfaceY: () => ({ y: 0, road: true }) };
const carOf = (speed = 0) => ({ x: 0, z: 0, y: 0, heading: 0, speed, steer: 0, len: 4.7, wid: 1.81, kind: 'octavia', offroad: 0 });

test('driving under a bridge with a car on it: no crash, and the car above is not touched', () => {
  const c = carOf(60 / 3.6);
  const above = { x: 0, z: -12, y: 6.8, heading: Math.PI / 2, speed: 0, len: 4.7, wid: 1.81, kind: 'octavia' };
  let hit = 0;
  for (let i = 0; i < 90; i++) {
    driveStep(c, { gas: 0, steer: 0, brake: 0 }, DT, FLAT, [above]);
    if (c.impactV > 0) hit = c.impactV;
  }
  assert.strictEqual(hit, 0, 'crashed into the car on the deck');
  assert.ok(c.z < -14, `stopped under the bridge at z ${c.z.toFixed(1)}`);
  assert.strictEqual(above.x, 0); assert.strictEqual(above.z, -12);
  assert.strictEqual(above.speed, 0);
  assert.ok(!above._rammedT, 'the traffic on the deck was told it had been hit');
});

test('…and on the same level they still collide as before', () => {
  for (const dy of [0, 0.4, 1.1]) {          // level, a kerb, a ramp's foot
    const c = carOf(60 / 3.6);
    const o = { x: 0, z: -12, y: dy, heading: 0, speed: 0, len: 4.7, wid: 1.81, kind: 'octavia' };
    let rec = 0;
    for (let i = 0; i < 60; i++) { driveStep(c, { gas: 0, steer: 0, brake: 0 }, DT, FLAT, [o]); if (c.impactV > rec) rec = c.impactV; }
    assert.ok(rec > 5, `no crash with a car ${dy} m higher`);
    assert.ok(o.speed > 5, 'the struck car was not shoved');
  }
});

test('a tram is met anywhere up its height, and driven under where it is on a bridge', () => {
  const tramAt = (y) => ({ x: 0, z: -12, y, heading: 0, speed: 0, len: 14, wid: 2.5, kind: 'bus', tallY: 3.4, tram: true });
  const hits = (y) => { const c = carOf(15); let r = 0; const t = tramAt(y); for (let i = 0; i < 60; i++) { driveStep(c, { gas: 0, steer: 0, brake: 0 }, DT, FLAT, [t]); if (c.impactV > r) r = c.impactV; } return r; };
  assert.ok(hits(0) > 3, 'drove through a tram in the street');
  assert.strictEqual(hits(7), 0, 'hit a tram on the bridge overhead');
});

// ---- lamp masts ---------------------------------------------------------------
function batch(spots, ys) {
  const g = new THREE.BoxGeometry(0.2, 7.2, 0.2), m = new THREE.MeshBasicMaterial();
  const posts = new THREE.InstancedMesh(g, m, spots.length), heads = new THREE.InstancedMesh(g, m, spots.length);
  posts.userData.ys = ys;
  return [posts, heads];
}
test('a mast on the deck is not in the way of the street below, nor a street lamp of the viaduct', () => {
  const p = new Poles(new THREE.Group());
  const spots = [[50, 50, 0]];
  p.register('0,0', spots, ...batch(spots, [221.6]), { heightAt: () => 214, ready: () => true });
  // a car in the underpass, 7 m under the mast's foot
  assert.strictEqual(p.collide({ x: 50.1, z: 50 }, 0.5, 214.6), false, 'the street below hit a mast on the deck');
  assert.strictEqual(p.strike(50, 50, 20, 0, 1.6, 214.6), 0, 'a car below felled a mast on the deck');
  // a car on the deck beside it: solid, and felled at speed
  assert.strictEqual(p.collide({ x: 50.1, z: 50 }, 0.5, 221.9), true);
  // a car on a viaduct 15 m over a street lamp
  assert.strictEqual(p.collide({ x: 50.1, z: 50 }, 0.5, 236.6), false, 'a viaduct hit the street lamp under it');
  // asked without a height (an old caller): every mast, as before
  assert.strictEqual(p.collide({ x: 50.1, z: 50 }, 0.5), true);
  assert.strictEqual(p.strike(50, 50, 20, 0, 1.6, 221.9), 1);
});

// ---- a set of points on a railway bridge -----------------------------------------
// Three rail decks sharing a node over a street's cutting (the bridge over Jana
// Palacha: ways 164640895, 164640977, 164640978). None has an approach at the
// joint; the ground under it is the cutting.
function railJoint(order) {
  const rail = (p, br = 0) => ({ p, t: 'rail', br, _len: geo.polylineLength(p) });
  // the bed at 221.4 either side, the street's cutting (212.6) under the bridge
  const terrain = { ready: () => true, heightAt: (x) => (x > 11 && x < 21 ? 212.6 : 221.4), _loads: 1 };
  const west = rail([[-100, 0], [10, 0]]), east = rail([[22, 0], [140, 0]]), east2 = rail([[22, 0.2], [140, 6]]);
  const A = rail([[10, 0], [16, 0]], 1), B = rail([[16, 0], [22, 0]], 1), C = rail([[16, 0], [22, 0.2]], 1);
  const tiles = [[west, A], [B, C, east, east2]];
  const cell = { roads: [], rails: [] };
  const city = { chunkIndex: new Map([['0,0', cell], ['-1,0', cell], ['1,0', cell]]) };
  for (const i of order) { for (const w of tiles[i]) cell.rails.push(w); stitchStructures(city, [], tiles[i]); }
  return { terrain, A, B, C };
}
test('a rail joint on a bridge holds the level of the track, not the cutting under it', () => {
  const { terrain, A, B, C } = railJoint([0, 1]);
  for (const [name, w] of [['A', A], ['B', B], ['C', C]]) for (let s = 0; s <= w._len; s += 1) {
    const y = geo.bridgeDeckHeight(w, s, terrain);
    assert.ok(Math.abs(y - 221.4) < 0.05, `deck ${name} is at ${y.toFixed(2)} m, ${s} m along (the V in the road)`);
  }
});
test('…whichever of its tiles arrived first', () => {
  const a = railJoint([0, 1]), b = railJoint([1, 0]);
  for (const k of ['A', 'B', 'C']) for (let s = 0; s <= a[k]._len; s += 1.5) {
    const ya = geo.bridgeDeckHeight(a[k], s, a.terrain), yb = geo.bridgeDeckHeight(b[k], s, b.terrain);
    assert.ok(Math.abs(ya - yb) < 1e-9, `deck ${k} at ${s} m: ${ya} against ${yb}`);
  }
});

// ---- who a walker waits for -------------------------------------------------------
test('the traffic on a viaduct is no threat to whoever crosses the path under it', async () => {
  const { Traffic } = await import('../js/traffic.js');
  const t = Object.create(Traffic.prototype);
  // a bus passing over the spot at deck level, 221.4
  const bus = { speed: 8, len: 11, wid: 2.5, ai: { sx: 0, sz: 0, sy: 221.4, sh: 0 } };
  t.cars = new Set([bus]);
  assert.strictEqual(t.threatens(0, -1, 3, 4, false, 214.5), false, 'a walker under the bridge waited for the bus on it');
  assert.strictEqual(t.threatens(0, -1, 3, 4, false, 221.5), true, 'a walker on the deck stepped into the side of the bus');
  // asked without a level (an old caller): as before
  assert.strictEqual(t.threatens(0, -1, 3, 4, false), true);
});
