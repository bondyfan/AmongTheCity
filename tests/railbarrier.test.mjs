// ---- nobody walks across the railway ---------------------------------------
// Frank, 21 Nov 2026: "v pardubicich muzu chodit pres koleje na nadrazi. to se
// nesmi stat nikde!" js/railbarrier.js keeps a walker off every heavy-rail
// track at grade, except where a way crosses it, on a platform, or on another
// level. A walk is simulated the way player.js moves: short substeps, each one
// pushed by the barrier.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkKey } from '../js/geo.js';
import { CHUNK } from '../js/config.js';
import {
  RAIL_HALF, heavyAtGrade, crossingGates, inGate, railPush, railCollide,
} from '../js/railbarrier.js';

const R = 0.38;                                   // the walker's radius (config WALK.radius)
const TRACK_Z = 10;

function makeWorld({ rails, roads = [], paved = [], passages = null, coach = null }) {
  const idx = new Map();
  const cell = () => ({ rails, roads, paved, buildings: [] });
  for (let x = -360; x <= 360; x += CHUNK / 2)
    for (let z = -240; z <= 240; z += CHUNK / 2) {
      const k = chunkKey(x, z);
      if (!idx.has(k)) idx.set(k, cell());
    }
  return {
    city: { chunkIndex: idx },
    terrain: { heightAt: () => 0, ready: () => true },
    stationPassages: passages,
    storyCoach: coach,
  };
}
// walk from (x, z0) towards +z for `dist` metres at level y; return where we end up
function walk(world, x, z0, dist, y = 0) {
  const pos = { x, z: z0 };
  const step = R * 0.8;
  for (let d = 0; d < dist; d += step) {
    pos.z += step;
    railCollide(world, pos, R, y);
  }
  return pos;
}

const track = () => ({ t: 'rail', p: [[-300, TRACK_Z], [300, TRACK_Z]] });

test('which tracks are a barrier: heavy rail at grade, not a tram, a bridge or a tunnel', () => {
  assert.equal(heavyAtGrade(track()), true);
  assert.equal(heavyAtGrade({ ...track(), t: 'tram' }), false);
  assert.equal(heavyAtGrade({ ...track(), br: 1 }), false);
  assert.equal(heavyAtGrade({ ...track(), l: -1 }), false);
  assert.equal(heavyAtGrade({ t: 'rail', p: [[0, 0]] }), false);
});

test('a walker cannot cross a track: he is stopped at the edge of the ballast', () => {
  const w = makeWorld({ rails: [track()] });
  const end = walk(w, 0, 0, 30);
  assert.equal(RAIL_HALF, 2.25, 'the foot of the drawn ballast bed (meshes.js BED_FOOT)');
  assert.ok(end.z <= TRACK_Z - RAIL_HALF - R + 1e-6, `stopped at z ${end.z.toFixed(2)}`);
  assert.ok(end.z > TRACK_Z - RAIL_HALF - R - 0.35, 'right at the edge, not somewhere short of it');
  // and from the other side the same, pushed back to the side he came from
  const pos = { x: 0, z: 20 };
  for (let i = 0; i < 80; i++) { pos.z -= R * 0.8; railCollide(w, pos, R, 0); }
  assert.ok(pos.z >= TRACK_Z + RAIL_HALF + R - 1e-6);
});

test('two tracks side by side are one barrier, not a pair with a path between', () => {
  const a = { t: 'rail', p: [[-300, 10], [300, 10]] }, b = { t: 'rail', p: [[-300, 14.75], [300, 14.75]] };
  const w = makeWorld({ rails: [a, b] });
  assert.ok(walk(w, 5, 0, 40).z < 10);
});

test('a level crossing or a footway crossing is the way over', () => {
  // OSM draws the crossing as the two ways sharing a node: a footway in two
  // halves that end on the track, and a road straight across it
  const foot1 = { t: 'footway', w: 2, p: [[50, -20], [50, TRACK_Z]] };
  const foot2 = { t: 'footway', w: 2, p: [[50, TRACK_Z], [50, 40]] };
  const road = { t: 'tertiary', w: 7, p: [[-80, -40], [-80, 60]] };
  const w = makeWorld({ rails: [track()], roads: [foot1, foot2, road] });
  const gates = crossingGates([track()], [foot1, foot2, road]);
  assert.ok(gates.length >= 2);
  assert.ok(inGate(gates, 50, TRACK_Z) && inGate(gates, -80, TRACK_Z));
  assert.equal(inGate(gates, 0, TRACK_Z), false);
  assert.ok(walk(w, 50, 0, 30).z > TRACK_Z + 5, 'over on the footway');
  assert.ok(walk(w, -80, 0, 30).z > TRACK_Z + 5, 'over on the level crossing');
  assert.ok(walk(w, -81.5, 0, 30).z > TRACK_Z + 5, 'anywhere across the road\'s width');
  assert.ok(walk(w, -88, 0, 30).z < TRACK_Z, 'but not beside it');
});

test('a road bridge over the track is not a crossing; its deck is another level', () => {
  const bridge = { t: 'primary', w: 9, br: 1, p: [[-50, -40], [-50, 60]] };
  const w = makeWorld({ rails: [track()], roads: [bridge] });
  assert.equal(crossingGates([track()], [bridge]).length, 0);
  assert.ok(walk(w, -50, 0, 30, 0).z < TRACK_Z, 'at track level under the bridge: blocked');
  assert.ok(walk(w, -50, 0, 30, 6.5).z > TRACK_Z + 5, 'on the deck 6.5 m up: free');
});

test('an underpass under the tracks is another level', () => {
  const w = makeWorld({ rails: [track()] });
  assert.ok(walk(w, 0, 0, 30, -4.5).z > TRACK_Z + 5);
});

test('a platform ends where the drawn bed begins, whatever its mapped polygon says', () => {
  // the mapped polygon reaches to 1.6 m of the rail; the ballast is drawn over it
  const platform = { t: 'platform', o: [[100, TRACK_Z + 1.6], [160, TRACK_Z + 1.6], [160, 18], [100, 18]] };
  const w = makeWorld({ rails: [track()], paved: [platform] });
  const pos = { x: 120, z: 16 };
  for (let i = 0; i < 40; i++) { pos.z -= R * 0.8; railCollide(w, pos, R, 0.3); }
  assert.ok(Math.abs(pos.z - (TRACK_Z + RAIL_HALF + R)) < 0.05, `stopped at the foot of the bed (z ${pos.z.toFixed(2)})`);
});

test('the station\'s own floors and the story coach\'s door let a walker through', () => {
  const passages = { floor: (x, z) => (Math.abs(x - 200) < 2 ? 0.1 : null) };
  const coach = { boarding: (x, z) => Math.abs(x + 200) < 1 };
  const w = makeWorld({ rails: [track()], passages, coach });
  assert.ok(walk(w, 200, 0, 30).z > TRACK_Z + 5, 'a flight of stairs mapped by the station layout');
  assert.ok(walk(w, -200, 0, 30).z > TRACK_Z + 5, 'the coach door');
  assert.ok(walk(w, 0, 0, 30).z < TRACK_Z, 'everywhere else still blocked');
});

test('railPush puts the walker just outside the strip on his own side', () => {
  const r = track(), out = {};
  assert.equal(railPush(r, 0, TRACK_Z - 3, R, out), null);
  const hit = railPush(r, 7, TRACK_Z - 1, R, out);
  assert.ok(hit);
  assert.ok(Math.abs(out.z - (TRACK_Z - RAIL_HALF - R)) < 1e-9 && Math.abs(out.x - 7) < 1e-9);
  assert.ok(Math.abs(hit.s - 307) < 1e-6, 'chainage along the way');
});
