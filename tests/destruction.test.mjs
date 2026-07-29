// ---- destruction, and what multiplayer does to it ----
// Blowing buildings up is the game. In one session that is a local effect; in a
// shared city it is STATE, and every test here encodes a way that state used to
// come apart between two clients standing in the same street:
//
//   · the blast was reported to the network a frame LATE (netcity polled
//     weapons.live). At MISSILE.vmax the peer wrecked a wall up to 10 m from
//     the one the shooter hit. onDetonate fires from inside the blast instead.
//   · a hit past the streamed region (TILE_REACH is 2.6 km; the world is tens
//     of km wide) landed on a chunk index that had no cell there and was gone
//     FOREVER. applyHit queues it against city.onTileLoaded.
//   · a late joiner arrived in an intact city, because nothing kept a record of
//     what had been destroyed. city.hitLog is that record, and hit ids are what
//     stop the record being applied twice on top of the live events.
//   · a peer's rocket shook the local camera and detonated at full volume in
//     the local headphones, wherever in the region it went off.
//   · _pruneWrecks restored buildings by distance from the BLAST and by local
//     streaming recency, so two clients healed different houses even when every
//     hit was delivered correctly.
//
// three.js is not an npm package here, so the resolver hook is registered
// before the modules under test are imported. See tests/three-alias.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { Weapons } = await import('../js/weapons.js');
const { CityWorld } = await import('../js/city.js');
const { Interiors } = await import('../js/interiorsim.js');
const { MISSILE, INTERIOR } = await import('../js/config.js');

// ---------------------------------------------------------------------------
// city.applyHit — the one door every blast goes through
// ---------------------------------------------------------------------------

// CityWorld's constructor builds materials (canvas textures), so these exercise
// the hit bookkeeping against a stand-in wearing the real prototype. Everything
// under test is pure logic over the chunk index and the tile manifest.
function mkWorld({ manifest = true } = {}) {
  const damaged = [];
  const city = {
    chunkIndex: new Map(),
    ...(manifest ? { tile: 4800, manifestTiles: [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }] } : {}),
  };
  const w = Object.assign(Object.create(CityWorld.prototype), {
    city, damaged,
    damageBuilding: (b, x, y, z, r) => damaged.push({ x, y, z, r }),
  });
  CityWorld.prototype._initHits.call(w);
  return w;
}
const withBuildings = (w, key = '0,0') => w.city.chunkIndex.set(key, { buildings: [{}] });

test('a hit on ground that is loaded is applied at once and logged', () => {
  const w = mkWorld();
  withBuildings(w);
  assert.equal(w.applyHit({ x: 10, y: 5, z: 10, r: MISSILE.blast }), true);
  assert.equal(w.damaged.length, 1);
  assert.deepEqual(w.hitLog.map((h) => h.x), [10]);
});

test('a hit beyond the streamed region waits for its tile instead of vanishing', () => {
  const w = mkWorld();
  // 7 km out: inside manifest tile 1,0, which this client has never fetched.
  // Before applyHit existed, damageBuilding found no chunk cell and the peer's
  // demolition simply never happened here.
  assert.equal(w.applyHit({ x: 7000, y: 5, z: 100, r: MISSILE.blast }), false);
  assert.equal(w.damaged.length, 0, 'nothing to damage yet');
  assert.equal(w.hitLog.length, 1, 'but it is already part of our history');
  w._tileIn({ tx: 1, tz: 0 }, true);
  w._flushHits();
  assert.equal(w.damaged.length, 1, 'it lands the moment the tile arrives');
  assert.equal(w._pendingHits.length, 0);
});

test('a hit outside the region, or in legacy data, is never queued forever', () => {
  const w = mkWorld();
  assert.equal(w.applyHit({ x: 900000, y: 5, z: 900000 }), true, 'no tile owns it');
  assert.equal(w._pendingHits.length, 0);
  const legacy = mkWorld({ manifest: false });   // whole-city JSON: it is all here
  assert.equal(legacy.applyHit({ x: 7000, y: 5, z: 100 }), true);
  assert.equal(legacy._pendingHits.length, 0);
});

test('hit ids make a snapshot replay idempotent', () => {
  const w = mkWorld();
  withBuildings(w);
  const mine = { x: 10, y: 5, z: 10, r: MISSILE.blast };
  w.applyHit(mine);
  assert.ok(mine.id, 'the id is stamped back so the sender can put it on the wire');
  assert.equal(w.applyHit(mine), false, 'the same blast never goes off twice');
  // a peer hands us the room history: our own hit plus one we have not seen
  const landed = w.applyHits([{ ...mine }, { x: 12, y: 5, z: 12, r: MISSILE.blast, id: 'peer:1' }]);
  assert.equal(landed, 1);
  assert.equal(w.damaged.length, 2);
});

test('nothing off the wire can be trusted into the blast solver', () => {
  const w = mkWorld();
  withBuildings(w);
  assert.equal(w.applyHit(null), false);
  assert.equal(w.applyHit({ x: NaN, y: 0, z: 0 }), false);
  assert.equal(w.applyHit({ x: 'over there', y: 0, z: 0 }), false);
  w.applyHit({ x: 1, y: 1, z: 1, r: 1e9 });
  assert.ok(w.damaged[0].r <= MISSILE.blast * 3, 'an absurd radius is clamped');
  w.applyHit({ x: 2, y: 1, z: 1, r: 'huge' });
  assert.equal(w.damaged[1].r, MISSILE.blast, 'a nonsense radius falls back to a rocket');
});

test('the log, the queue and the dedupe set are all bounded', () => {
  const w = mkWorld();
  withBuildings(w);
  for (let i = 0; i < 600; i++) w.applyHit({ x: 1, y: 1, z: 1, r: MISSILE.blast });
  assert.ok(w.hitLog.length <= 240, 'the snapshot cannot grow without limit');
  assert.ok(w._hitIds.size <= 8192);
  const q = mkWorld();
  for (let i = 0; i < 400; i++) q.applyHit({ x: 7000, y: 1, z: i, r: MISSILE.blast });
  assert.ok(q._pendingHits.length <= 128, 'a peer bombing an unloaded region is not a leak');
});

// ---------------------------------------------------------------------------
// weapons.onDetonate / detonate({remote})
// ---------------------------------------------------------------------------

function mkWeapons() {
  const hits = [];
  const world = {
    heightAt: () => 0,
    interiors: { focus: { x: 0, z: 0 } },   // the local player, at the origin
    applyHit: (h) => { hits.push(h); return true; },
  };
  return { w: new Weapons(new THREE.Scene(), world, {}), hits };
}

test('a local detonation reports itself synchronously, carrying its id', () => {
  const { w, hits } = mkWeapons();
  const seen = [];
  const off = w.onDetonate((e) => seen.push(e));
  w.detonate(100, 5, 200, null, null);
  assert.equal(seen.length, 1, 'not a frame later — now');
  assert.equal(seen[0].x, 100);
  assert.equal(seen[0].r, MISSILE.blast);
  assert.equal(seen[0], hits[0], 'the reported event IS the applied hit record');
  assert.ok(w.shake > 0, 'our own rocket shakes our own camera');
  off();
  w.detonate(1, 1, 1, null, null);
  assert.equal(seen.length, 1, 'unsubscribe works');
});

test("a peer's detonation wrecks the city without touching the local player", () => {
  const { w, hits } = mkWeapons();
  const seen = [];
  w.onDetonate((e) => seen.push(e));
  w.detonate(3000, 5, 3000, null, null, { remote: true, id: 'peer:7' });
  assert.equal(seen.length, 0, 'a relayed blast must not bounce back onto the wire');
  assert.equal(w.shake, 0, 'and must not shake a camera three kilometres away');
  assert.equal(hits.length, 1, 'the demolition still happens');
  assert.equal(hits[0].id, 'peer:7', "the sender's id survives the trip");
});

test('a blast far out of sight does not spend the local FX pools', () => {
  const { w } = mkWeapons();
  w.detonate(9000, 5, 9000, null, null, { remote: true });
  assert.equal(w.balls.some((b) => b.s.visible), false);
  assert.equal(w.light.visible, false, 'a 90 m light 12 km away is a stolen slot');
  w.detonate(10, 5, 10, null, null, { remote: true });
  assert.ok(w.balls.some((b) => b.s.visible), 'a blast down the street is fully drawn');
});

test('a throwing subscriber cannot half-explode the rocket', () => {
  const { w, hits } = mkWeapons();
  w.onDetonate(() => { throw new Error('bug in the network layer'); });
  let after = 0;
  w.onDetonate(() => { after++; });
  const err = console.error;
  console.error = () => {};        // the throw IS the fixture — don't print it
  try { w.detonate(1, 1, 1, null, null); } finally { console.error = err; }
  assert.equal(after, 1);
  assert.equal(hits.length, 1);
});

// ---------------------------------------------------------------------------
// which wreck goes back — the quiet way two cities drifted apart
// ---------------------------------------------------------------------------

function mkInteriors(focus) {
  const it = Object.create(Interiors.prototype);
  it.models = new Map();
  it.hidden = new Set();
  it.drawR = INTERIOR.drawR;
  it.focus = focus;
  it.dropped = [];
  it.world = { unhideBuilding() {} };
  it._drop = (id) => { it.dropped.push(id); it.models.delete(id); };
  return it;
}
// dseq = the order it was wrecked in (shared); lastTouch = local streaming
// recency (deliberately the OPPOSITE order, so a test that passes cannot be
// passing by accident on the old sort key)
const mkWreck = (i, x) => ({ damaged: true, dseq: i, lastTouch: -i, f: { _id: i },
  bb: { minX: x, maxX: x + 10, minZ: 0, maxZ: 10 } });

test('past the wreck cap the EARLIEST-wrecked building goes back, not the locally stalest', () => {
  const it = mkInteriors({ x: 0, z: 0 });
  for (let i = 1; i <= INTERIOR.maxDamaged + 1; i++) it.models.set(i, mkWreck(i, 4000 + i * 50));
  it._pruneWrecks();
  assert.deepEqual(it.dropped, [1], 'damage order is the same on every client');
});

test('a wreck the local player is looking at is never restored under them', () => {
  const it = mkInteriors({ x: 4050, z: 5 });   // standing at the oldest wreck
  for (let i = 1; i <= INTERIOR.maxDamaged + 1; i++) it.models.set(i, mkWreck(i, 4000 + i * 50));
  it._pruneWrecks();
  assert.equal(it.dropped.includes(1), false);
  assert.equal(it.dropped.length, 1, 'the next-oldest one out of view goes instead');
});

test('replaying a whole snapshot does not re-mesh the city in one frame', () => {
  const it = mkInteriors({ x: 0, z: 0 });
  for (let i = 1; i <= 40; i++) it.models.set(i, mkWreck(i, 4000 + i * 50));
  it._pruneWrecks();
  assert.equal(it.dropped.length, 2, 'restores are capped per call, cap or no cap');
});

// ---------------------------------------------------------------------------
// buildings live 221 m up now, and every height test in city.js had to learn it
// ---------------------------------------------------------------------------

// `b.h` and `b.y` in the data are heights ABOVE THE GROUND. While the ground was
// a plane at zero they doubled as absolute heights and city.js compared world-y
// against them directly. On terrain that is 221 m out in Pardubice and 350 in
// Zlín — a rocket arriving at a roof was tested against `y > b.h` with b.h = 15,
// missed every building in the city, and flew on to bury itself in the ground.
// Nothing could be blown up from the air at all, and since interiorsim only
// builds rooms for a building that takes damage, nothing had an inside either.
function mkTerrainWorld(groundY = 221) {
  const terrain = { ready: () => true, heightAt: () => groundY, underRing: () => ({ lo: groundY, hi: groundY, mean: groundY }) };
  const b = {
    _id: 1, h: 15, y: 0,
    o: [[0, 0], [20, 0], [20, 20], [0, 20]],
  };
  const city = { chunkIndex: new Map([['0,0', { buildings: [b] }]]) };
  const w = Object.assign(Object.create(CityWorld.prototype), {
    city, terrain, interiors: { hidden: new Set(), isActive: () => false, damage: () => {} },
  });
  return { w, b, groundY };
}

test('a rocket at roof height hits the building it is aimed at', () => {
  const { w, b, groundY } = mkTerrainWorld();
  // mid-wall, well inside the footprint
  assert.equal(w.buildingHitAt(10, groundY + 8, 10), b, 'the rocket flew straight through');
  // just under the eaves
  assert.equal(w.buildingHitAt(10, groundY + 14.5, 10), b);
});

test('…and misses the sky above it and the ground below it', () => {
  const { w, groundY } = mkTerrainWorld();
  assert.equal(w.buildingHitAt(10, groundY + 15.5, 10), null, 'hit something over the roof');
  assert.equal(w.buildingHitAt(10, groundY - 2, 10), null, 'hit something underground');
  assert.equal(w.buildingHitAt(40, groundY + 8, 40), null, 'hit outside the footprint');
});

test('the blast radius finds the building at altitude, so damage() runs', () => {
  const { w, groundY } = mkTerrainWorld();
  const hit = [];
  w.interiors.damage = (f, x, y, z, r) => hit.push({ f, y, r });
  w.damageBuilding(null, 10, groundY + 9, 10, MISSILE.blast);
  assert.equal(hit.length, 1, 'the blast passed through the building without touching it');
  // interiorsim.damage() calls activate(), which is what gives a wrecked
  // building its rooms — so "no interior" and "indestructible" were one bug.
});

test('a roof you are above reads as a surface at its real altitude', () => {
  const { w, groundY } = mkTerrainWorld();
  // a helicopter 40 m up over the footprint should find the roof at 236, not 15
  assert.equal(w.roofY(10, 10, groundY + 40), groundY + 15);
  // …and standing in the street beside it, the roof is over your head, not under
  assert.equal(w.roofY(10, 10, groundY + 2), 0);
});

test('the same building in Zlín is 130 m higher and still hittable', () => {
  const { w, b, groundY } = mkTerrainWorld(351);
  assert.equal(w.buildingHitAt(10, groundY + 8, 10), b);
  assert.equal(w.buildingHitAt(10, 229, 10), null, 'a Pardubice altitude hit a Zlín building');
});
