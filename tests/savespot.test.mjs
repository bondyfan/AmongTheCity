// Where a save puts the player down again (js/savespot.js), and that the save
// keeps the level it was taken on (js/savegame.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { standY, groundReady, motorwayStop, motorwaySave, STOP } from '../js/savespot.js';
import { parse, serialize, blank } from '../js/savegame.js';
import { d11At, d11Locate, onBridge } from '../js/d11.js';

// A world with one bridge: the riverbed at 182, the deck at 190.7 over
// x in [-10, 10], and (optionally) a path on the ground under it.
function bridgeWorld({ pathUnder = false } = {}) {
  const ground = 182, deck = 190.7;
  const levelsAt = (x) => (Math.abs(x) <= 10 ? [ground, deck] : [ground]);
  // city.js heightAt: the highest level at or below near + 1.5, else the
  // lowest above; with no hint the highest
  const heightAt = (x, z, near) => {
    const ls = levelsAt(x);
    if (!Number.isFinite(near)) return Math.max(...ls);
    const below = ls.filter((y) => y <= near + 1.5);
    return below.length ? Math.max(...below) : Math.min(...ls);
  };
  return {
    terrain: { heightAt: () => ground, ready: () => true, _conformed: new Set(['0,0']) },
    city: { tile: 4800, chunkIndex: new Map([['0,0', {}]]) },
    heightAt,
    supportY: (x, z, maxY) => heightAt(x, z, maxY),
    walkY: (x) => (pathUnder ? ground : heightAt(x, 0, ground + 2.6)),
    _deckAt: (x, z, y) => (Math.abs(y - deck) < 1e-3 ? 2 : 0),
    _onGroundWay: () => pathUnder,
  };
}

test('a save with y stands on the level it was taken on: the deck, not the riverbed', () => {
  const w = bridgeWorld();
  assert.equal(standY(w, 0, 5, 190.7), 190.7);
  // a hair under it (a deck regraded a few cm by a later build): still the deck
  assert.equal(standY(w, 0, 5, 190.2), 190.7);
  // taken on the bank under the bridge: the bank
  assert.equal(standY(w, 0, 5, 182), 182);
});

test('an old save (no y) on a bridge stands on the deck before the riverbed', () => {
  const w = bridgeWorld();
  assert.equal(standY(w, 0, 5, NaN), 190.7);
  assert.equal(standY(w, 0, 5, undefined), 190.7);
  // off the bridge it is the ground
  assert.equal(standY(w, 50, 5, NaN), 182);
});

test('an old save on a path UNDER a bridge stays on the path', () => {
  const w = bridgeWorld({ pathUnder: true });
  assert.equal(standY(w, 0, 5, NaN), 182);
});

test('groundReady waits for the cell, the height map and the earthworks', () => {
  const w = bridgeWorld();
  assert.equal(groundReady(w, 5, 5), true);
  assert.equal(groundReady(w, 500, 5), false, 'no chunk cell yet');
  w.terrain.ready = () => false;
  assert.equal(groundReady(w, 5, 5), false, 'no height map yet');
  w.terrain.ready = () => true;
  w.terrain._conformed = new Set();
  assert.equal(groundReady(w, 5, 5), false, 'not conformed yet');
});

test('the save keeps y for the player and the car, and an old save has none', () => {
  const s = { ...blank(), savedAt: 1, pos: { x: -96298.04, z: -6088.2, h: 1, y: 190.7123 },
    car: { kind: 'octavia', color: 0x112233, x: 1, z: 2, h: 0, y: 250.456, fuel: 10, damage: 0, seed: 4, parkIdx: null } };
  const r = parse(serialize(s));
  assert.equal(r.ok, true);
  assert.equal(r.state.pos.y, 190.71);
  assert.equal(r.state.car.y, 250.46);
  const old = parse(JSON.stringify({ ...blank(), pos: { x: 1, z: 2, h: 0 } }));
  assert.equal('y' in old.state.pos, false);
  // nonsense heights are dropped, not trusted
  for (const y of ['190', NaN, 1e9, null]) {
    const b = parse(JSON.stringify({ ...blank(), pos: { x: 1, z: 2, h: 0, y } }));
    assert.equal('y' in b.state.pos, false, String(y));
  }
});

// ---- the D11 -----------------------------------------------------------------
const head = (dx, dz) => Math.atan2(-dx, -dz);   // heading 0 faces -z

test('a car in the overtaking lane of the D11 is saved on the hard shoulder, its driver behind the rail', () => {
  const out = {};
  let n = 0;
  for (const cw of ['E', 'W']) {
    for (let km = 20; km <= 90; km += 3.7) {
      const a = d11At(km, cw);
      if (!a || onBridge(km, cw, 0.05)) continue;
      // the overtaking lane: 1.875 m LEFT of the line ((dz, -dx) is left of travel)
      const x = a.x + a.dz * 1.875, z = a.z - a.dx * 1.875;
      const r = motorwayStop(x, z, head(a.dx, a.dz), out);
      assert.ok(r, `km ${km} ${cw}: not found on its carriageway`);
      const lc = d11Locate(r.cx, r.cz), lp = d11Locate(r.px, r.pz);
      assert.equal(lc.cw, cw);
      assert.ok(Math.abs(lc.off - STOP.CAR_SHOULDER) < 0.3, `car offset ${lc.off}`);
      assert.ok(Math.abs(lp.off - STOP.WALK_VERGE) < 0.3, `driver offset ${lp.off}`);
      // the driver is on the RIGHT, away from the median and the other carriageway
      assert.ok(lp.off > 6.85, 'driver not past the guard rail');
      assert.ok(Math.abs(Math.cos(r.h - head(a.dx, a.dz))) > 0.99);
      n++;
    }
  }
  assert.ok(n > 20, 'too few samples ' + n);
});

test('on a D11 bridge the car keeps the right lane and the driver stays on the deck', () => {
  const out = {};
  const km = (59.777 + 60.343) / 2;               // a 570 m viaduct, eastbound
  assert.ok(onBridge(km, 'E'));
  const a = d11At(km, 'E');
  const r = motorwayStop(a.x, a.z, head(a.dx, a.dz), out);
  assert.ok(r && r.deck);
  const lp = d11Locate(r.px, r.pz);
  assert.ok(lp.off < 6.25 - 0.45, 'driver beyond the bridge kerb: ' + lp.off);
});

test('a road crossing the D11 (or a point off it) is not a motorway stop', () => {
  const out = {};
  const a = d11At(50, 'E');
  // perpendicular: an overpass across the carriageway
  assert.equal(motorwayStop(a.x, a.z, head(a.dz, -a.dx), out), null);
  // 20 m off the line: a parallel road, not this carriageway
  assert.equal(motorwayStop(a.x - a.dz * 20, a.z + a.dx * 20, head(a.dx, a.dz), out), null);
  // driving the wrong way on it still counts (and still saves on ITS shoulder)
  const r = motorwayStop(a.x, a.z, head(-a.dx, -a.dz), out);
  assert.ok(r);
  assert.ok(Math.abs(d11Locate(r.px, r.pz).off - STOP.WALK_VERGE) < 0.3);
});

// A world along the D11 at km 50 eastbound: levels as a function of the offset
// right of the line, asked the way city.js heightAt is (the highest level at
// or below near + 1.5, else the lowest above).
function laneWorld(levelsAtOff) {
  const heightAt = (x, z, near) => {
    const ls = levelsAtOff(d11Locate(x, z).off);
    const below = ls.filter((y) => y <= near + 1.5);
    return below.length ? Math.max(...below) : Math.min(...ls);
  };
  return { heightAt };
}

test('motorwaySave keeps the shoulder save only where both spots are on the car\'s level', () => {
  const a = d11At(50, 'E');
  assert.ok(!onBridge(50, 'E', 0.05));
  const x = a.x + a.dz * 1.875, z = a.z - a.dx * 1.875, hd = head(a.dx, a.dz);
  const out = {};
  // level ground: kept, the driver's floor is the ground there
  assert.equal(motorwaySave(laneWorld(() => [222]), x, z, hd, 222, out), true);
  assert.equal(out.ok, true);
  assert.equal(out.py, 222);
  // the shoulder 0.7 m proud of the lane (the km 66.3 abutment): still kept
  assert.equal(motorwaySave(laneWorld((o) => [o > 3.75 ? 222.7 : 222]), x, z, hd, 222, out), true);
  // under an overpass: the deck 8 m overhead is not where anyone is put
  assert.equal(motorwaySave(laneWorld(() => [222, 230]), x, z, hd, 222, out), true);
  assert.equal(out.py, 222);
  // ON a deck that lies along the line, 8 m over the ground beyond it: the
  // verge behind the rail is a drop, so the save keeps the driver's door
  assert.equal(motorwaySave(laneWorld((o) => (Math.abs(o) < 6.5 ? [222, 230] : [222])), x, z, hd, 230, out), false);
  assert.equal(out.ok, false);
  // a car spot a step higher than the car (a kerb, a wall): not a shoulder
  assert.equal(motorwaySave(laneWorld((o) => [o > 3.75 ? 224 : 222]), x, z, hd, 222, out), false);
  // no level known, or off the motorway: nothing to do
  assert.equal(motorwaySave(laneWorld(() => [222]), x, z, hd, NaN, out), false);
  assert.equal(motorwaySave(laneWorld(() => [222]), a.x - a.dz * 30, a.z + a.dx * 30, hd, 222, out), false);
});
