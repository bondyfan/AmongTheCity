// ---- streets: kerbs, pavements, corner radii --------------------------------
// js/streets.js derives what stands beside a carriageway and how a junction is
// shaped. Three promises are pinned here, because each is one a screenshot
// cannot check and each has a way of going quietly wrong:
//
//   the outline of a junction is a SIMPLE polygon that covers what the old
//   convex pad covered (a ring that folds over itself fills as torn triangles,
//   and one that falls short of an arm's trimmed end leaves a hole in the road);
//
//   a kerbed street's verge is where it should be and nowhere else (not across
//   a side street's mouth, not on another carriageway, dropped where a path
//   crosses);
//
//   the pavement that is DRAWN is the pavement that is STOOD ON: the mesh and
//   city.js read the same arrays, and the first time they disagree a player
//   walks shin-deep through the paving.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { indexJunctions, junctionHull, junctionsIn, polylineLength, pointInPolygon, streetOf,
  setStreetCity, roadGradeY, indexRoundabouts, JUNCTIONS, CLUSTERS } = await import('../js/geo.js');
const { simpleRing, vergeAt, vergeLift, inZone, cornerLift, KERB_H, DROP_LIP, WALK_W } =
  await import('../js/streets.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { CityWorld } = await import('../js/city.js');
const { SURF } = await import('../js/surfaces.js');
const { LAYER_Y } = await import('../js/config.js');

const G = 221;
const terrain = { res: 20, tile: 4800, missed: false, _loads: 1, ready: () => true, heightAt: () => G };
const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];

/** A street with houses along it, a side street, a path across, a yard road over it. */
function town() {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const tag = (f) => { f._id = ++id; f._home = '0,0'; return f; };
  const main = tag({ t: 'residential', w: 8, d: 1, p: [[4, 60], [60, 60], [116, 60]] });
  const side = tag({ t: 'residential', w: 8, d: 1, p: [[60, 60], [60, 116]] });
  const yard = tag({ t: 'service', w: 4.8, d: 1, p: [[96, 40], [96, 80]] });   // crosses, no shared node
  const path = tag({ t: 'footway', w: 1.8, p: [[30, 40], [30, 80]] });          // crosses the street
  const along = tag({ t: 'footway', w: 1.8, p: [[8, 51], [50, 51]] });          // runs beside it, 5 m out
  const roads = [main, side, yard, path, along];
  for (const r of roads) r._len = polylineLength(r.p);
  const buildings = [];
  for (let x = 6; x < 110; x += 20) buildings.push(tag({ o: square(x, 24, 10), h: 9, t: 'house' }));
  const cell = { buildings, roads, rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [], signals: [] };
  indexJunctions(roads);
  setStreetCity(city);
  return { city, cell, main, side, yard, path, along };
}

test('a junction outline is a simple polygon with a kerb radius, and covers the old pad', () => {
  const { main, side } = town();
  const j = junctionsIn('0,0')[0];
  assert.ok(j && j._t, 'a side street joining the MIDDLE of a way is a junction now');
  const ring = junctionHull(j);
  assert.ok(simpleRing(ring), 'the outline crosses itself');
  assert.ok(pointInPolygon(j.x, j.z, ring), 'the node is outside its own pad');
  // the corner between the street and the side street is ROUNDED: more outline
  // points than the six a T of three mouths has
  assert.ok(ring.length >= 12, `only ${ring.length} outline points: no corner was rounded`);
  // …and the asphalt reaches into the corner, past where the square pad stopped
  assert.ok(pointInPolygon(60 + 4 + 0.9, 60 + 4 + 0.9, ring),
    'the fillet did not add the sliver of asphalt between the sharp corner and the arc');
  assert.ok(!pointInPolygon(60 + 4 + 5, 60 + 4 + 5, ring), 'the corner was chamfered right across');
  // every arm's trimmed end is still under the pad
  for (const lg of j._legs) {
    assert.ok(lg.m >= j.pad - 1e-6, 'a mouth sits inside the pad radius: a hole at the trimmed end');
    assert.ok(pointInPolygon(lg.nx + lg.ux * (j.pad - 0.2), lg.nz + lg.uz * (j.pad - 0.2), ring));
  }
  // the ribbons know where their own kerb has to stop
  assert.ok(inZone(main, 60) && inZone(side, 2), 'no junction zone on the arms');
  assert.ok(!inZone(main, 20), 'the whole street is one junction zone');
});

test('a kerbed street has a pavement, dropped where a path crosses, absent where a road does', () => {
  const { main, yard } = town();
  const vg = streetOf(main);
  assert.ok(vg, 'a residential street with houses along it came out with no kerb');
  assert.equal(streetOf(yard), null, 'a service road got a kerb');
  // mid-block, both sides: a band at least the default pavement wide
  for (const side of [0, 1]) {
    const v = vergeAt(main, 16, side);
    assert.ok(v.u && v.w >= WALK_W - 0.11, `no pavement on side ${side} at 16 m (${v.w.toFixed(2)} m)`);
    assert.ok(v.drop < 0.01, 'the kerb is dropped where nothing crosses');
  }
  // the mapped footway 5 m out on one side turns that side's band into a lawn
  // strip reaching to it; the other side stays paving
  const types = [vergeAt(main, 30 - 8, 0).t, vergeAt(main, 30 - 8, 1).t].sort();
  assert.deepEqual(types, [1, 2], `expected one paved and one lawn verge, got ${types}`);
  // where the path crosses (x = 30, 26 m along) the kerb comes down, both sides
  assert.ok(vergeAt(main, 26, 0).drop > 0.9 && vergeAt(main, 26, 1).drop > 0.9, 'no dropped kerb at the crossing');
  assert.ok(Math.abs(vergeLift(1.7, 1, 0) - DROP_LIP) < 1e-9 && vergeLift(1.7, 1, 1.7) === KERB_H,
    'a dropped kerb comes down to its lip at the kerb line and keeps the back of the pavement');
  // where the yard road lies across the street (x = 96, 92 m along) there is no band
  assert.ok(vergeAt(main, 92, 0).w < 0.05 && vergeAt(main, 92, 1).w < 0.05, 'a kerb was laid across another carriageway');
});

test('the pavement that is drawn is the pavement that is stood on', () => {
  const { city, cell, main } = town();
  const mats = makeMaterials();
  mats.terrain = terrain; mats.trees = false; mats.lamps = false; mats.facades = false;
  const group = buildChunkMeshes(city, 0, 0, mats, 'roads');
  const sink = group.children.find((m) => m.isMesh && m.material === mats.flat);
  const pos = sink.geometry.attributes.position, sf = sink.geometry.attributes.surf;
  assert.ok(sink.geometry.attributes.uv, 'the ground sink lost its lane coordinate');
  const deck = roadGradeY(main, 16, terrain) + LAYER_Y.road;
  // paver vertices near (20, 60 ± 4..5.7): the generated band, 16 m along
  let top = -Infinity, n = 0, worst = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    worst = Math.max(worst, pos.getY(i));
    if (sf.getX(i) !== SURF.pavers) continue;
    const x = pos.getX(i) + group.position.x, z = pos.getZ(i) + group.position.z;
    if (Math.abs(x - 20) < 4 && Math.abs(Math.abs(z - 60) - 4.9) < 1.2) { top = Math.max(top, pos.getY(i)); n++; }
  }
  assert.ok(n > 0, 'no paving was drawn beside the street');
  assert.ok(Math.abs(top - (deck + KERB_H)) < 0.01, `the band is drawn ${(top - deck).toFixed(3)} m over the deck, not ${KERB_H}`);
  assert.ok(worst < G + 6, `something stands ${(worst - G).toFixed(1)} m up: an absolute height was draped twice`);
  // …and the same point, asked of the physics
  const w = Object.assign(Object.create(CityWorld.prototype), { city, terrain });
  const feet = w.heightAt(20, 60 + 4 + 0.9, G + 1);
  assert.ok(Math.abs(feet - top) < 0.01, `feet at ${(feet - deck).toFixed(3)} m over the deck, paving at ${(top - deck).toFixed(3)}`);
  assert.ok(Math.abs(w.heightAt(20, 60, G + 1) - deck) < 0.01, 'the carriageway itself moved');
  // a wheel on the pavement rides it; a wheel in the lane does not
  assert.ok(Math.abs(w.surfaceY(20, 60 + 4 + 0.9, G + 1).y - top) < 0.01, 'a wheel sinks into the pavement');
  assert.ok(Math.abs(w.surfaceY(20, 60 + 2, G + 1).y - deck) < 0.01);
  // round the junction corner the kerb is the junction's own, and it is stood on too
  const j = junctionsIn('0,0')[0];
  let found = false;
  for (const pc of j._edge) {
    if (!pc.any || !pc.arc) continue;
    const k = Math.floor(pc.p.length / 16) * 8;         // a point in the middle of the arc
    const x = pc.p[k] + pc.p[k + 2] * 0.8, z = pc.p[k + 1] + pc.p[k + 3] * 0.8;
    assert.ok(cornerLift(j, x, z) > 0.1, 'the corner pavement has no height');
    assert.ok(w.heightAt(x, z, G + 1) > G + LAYER_Y.road + 0.1, 'feet sink through the corner pavement');
    found = true;
  }
  assert.ok(found, 'the junction has no kerbed corner at all');
  void cell;
});

test('a roundabout ring finds its own middle, once', () => {
  let id = 0;
  const ring = [];
  const R = 14, N = 24;
  // the ring as four ways, the way OSM cuts it at every exit
  for (let q = 0; q < 4; q++) {
    const p = [];
    for (let k = 0; k <= N / 4; k++) {
      const a = ((q * N / 4 + k) / N) * Math.PI * 2;
      p.push([100 + Math.cos(a) * R, 200 + Math.sin(a) * R]);
    }
    ring.push({ _id: ++id, t: 'tertiary', w: 8, d: 1, rb: 1, ow: 1, p });
  }
  for (const r of ring) r._len = polylineLength(r.p);
  indexRoundabouts(ring);
  const owners = ring.filter((r) => r._isl);
  assert.equal(owners.length, 1, 'the island must be drawn exactly once');
  const [x, z, r] = owners[0]._isl;
  assert.ok(Math.hypot(x - 100, z - 200) < 0.3, 'the centre is off');
  assert.ok(Math.abs(r - (R - 4)) < 0.4, `island radius ${r.toFixed(1)}, expected ${R - 4}`);
});
