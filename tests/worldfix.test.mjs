// ---- world geometry debts, round 5 ----------------------------------------------
// Five defects measured on real tiles, each pinned here on a fixture small
// enough to read:
//
//   a tram's panel lies on the deck of the street it is set into, not on the
//     track's own levelled line (geo.railGradeY), for the mesh, for feet and
//     for the mesh worker alike;
//   a trolley mast stands at a kerb: not in another carriageway, a bus lay-by,
//     a junction's asphalt, a house or at a crossing (meshes.trolleyMasts);
//   a street does not pull a footway at the foot of its embankment up to its
//     own level, and its lawn does not reach out to that footway as a shelf
//     (meshes.footPullW, geo.levelVerge);
//   a chunk spec gathered before anybody asked for the junction buckets
//     carries finished crossing clusters.
//
// (The far lamp points reading the mesher's plan are in farlights.test.mjs.)
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const geo = await import('../js/geo.js');
const { indexJunctions, polylineLength, streetOf, setStreetCity, roadGradeY, railGradeY, roadProfile,
  JUNCTIONS, CLUSTERS } = geo;
const { bayAt, indexBays, vergeAt, cornerLift, KERB_H, WALK_W } = await import('../js/streets.js');
const { buildChunkMeshes, makeMaterials, footPullW, trolleyPlan } = await import('../js/meshes.js');
const { CityWorld } = await import('../js/city.js');
const { chunkSpec, applySpec, withJunctions } = await import('../js/chunkspec.js');
const { Terrain } = await import('../js/terrain.js');
const { SURF } = await import('../js/surfaces.js');
const { LAYER_Y, CHUNK } = await import('../js/config.js');

const G = 221;
const ground = (heightAt) => ({ res: 20, tile: 4800, missed: false, _loads: 1, ready: () => true, heightAt });
const flat = ground(() => G);
/** A real height tile (0,0) filled from `fn`: what chunkSpec can ship to a worker. */
function realTerrain(fn = () => G) {
  const t = new Terrain(4800, 20), g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) g[j * t.n + i] = Math.round(fn(i * 20, j * 20) * 10);
  t.grids.set('0,0', g);
  t._loads = 1;
  return t;
}
const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
const emptyCell = () => ({ buildings: [], roads: [], rails: [], trees: [], water: [], green: [], paved: [],
  furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] });

/** Bucket ways, rails and buildings by bbox, the way geo.bucketize does; _home is the first point's cell. */
function cityOf(roads, { buildings = [], pois = [], rails = [], crossings = [] } = {}) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  const chunkIndex = new Map();
  const cellAt = (k) => { let c = chunkIndex.get(k); if (!c) chunkIndex.set(k, c = emptyCell()); return c; };
  let id = 0;
  const put = (f, kind, ring) => {
    f._id = ++id;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const [x, z] of ring) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
    for (let i = Math.floor(a / CHUNK); i <= Math.floor(c / CHUNK); i++)
      for (let j = Math.floor(b / CHUNK); j <= Math.floor(d / CHUNK); j++) cellAt(i + ',' + j)[kind].push(f);
    f._home = Math.floor(ring[0][0] / CHUNK) + ',' + Math.floor(ring[0][1] / CHUNK);
  };
  for (const r of roads) { r._len = polylineLength(r.p); put(r, 'roads', r.p); }
  for (const r of rails) { r._len = polylineLength(r.p); put(r, 'rails', r.p); }
  for (const b of buildings) put(b, 'buildings', b.o);
  for (const c of crossings) put(c, 'crossings', c.p);
  const city = { chunkIndex, tile: 4800, pois, waterways: [], signals: [], roads };
  indexJunctions(roads);
  indexBays(city, pois);
  setStreetCity(city);
  return city;
}
const matsFor = (terrain) => {
  const mats = makeMaterials();
  mats.terrain = terrain; mats.trees = false; mats.lamps = false; mats.facades = false;
  mats.canopy = null; mats.ground = null; mats.ortho = null; mats.hidden = new Set();
  return mats;
};
/** Every triangle of the chunk's ground sink in one surface class, as [x, top y, z, mean y]. */
function trisOf(city, cx, cz, surf, terrain, mats = matsFor(terrain)) {
  const group = buildChunkMeshes(city, cx, cz, mats, 'full');
  const sink = group.children.find((m) => m.isMesh && m.material === mats.flat);
  const pos = sink.geometry.attributes.position, sf = sink.geometry.attributes.surf;
  const out = [];
  for (let i = 0; i < pos.count; i += 3) {
    if (surf !== null && sf.getX(i) !== surf) continue;
    out.push([(pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3 + group.position.x,
      Math.max(pos.getY(i), pos.getY(i + 1), pos.getY(i + 2)) + group.position.y,
      (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3 + group.position.z,
      (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 + group.position.y]);
  }
  return out;
}
const worldOf = (city, terrain) => Object.assign(Object.create(CityWorld.prototype), { city, terrain });
/** The flat sink's vertex count and a rounded position sum: enough to tell two builds apart. */
function sinkSig(group, mats) {
  const sink = group.children.find((m) => m.isMesh && m.material === mats.flat);
  const p = sink.geometry.attributes.position;
  let sum = 0;
  for (let i = 0; i < p.count; i++) sum += p.getX(i) + p.getY(i) * 3 + p.getZ(i) * 7;
  return { n: p.count, sum: Math.round(sum * 100) / 100 };
}
/** The chunk built from its spec, with no city and only the shipped pad buckets: a mesh worker. */
function workerBuild(w, cx, cz, read) {
  const got = chunkSpec(w, cx, cz, 'full', null);
  const posted = structuredClone(got.spec);
  const J = new Map(JUNCTIONS), C = new Map(CLUSTERS);
  JUNCTIONS.clear(); CLUSTERS.clear(); setStreetCity(null);
  try {
    const a = applySpec(posted, { terrain: null, canopy: null });
    return read(a, withJunctions(a.junctions, a.clusters, () => buildChunkMeshes(a.city, cx, cz, a.mats, 'full')));
  } finally {
    for (const [k, v] of J) JUNCTIONS.set(k, v);
    for (const [k, v] of C) CLUSTERS.set(k, v);
    setStreetCity(w.city);
  }
}
const segD = (x, z, p) => {
  let best = Infinity;
  for (let k = 0; k < p.length - 1; k++) {
    const ax = p[k][0], az = p[k][1], ex = p[k + 1][0] - ax, ez = p[k + 1][1] - az, L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return best;
};

// ---- (a) the tram panel and the street it is set into ---------------------------
// The street is 200 m of a longer tram line, on ground with a hump west of
// where the street begins: the tram's own profile is still coming down off the
// hump where the street starts level, so the two lines differ there.
function tramTown() {
  const terrain = realTerrain((x) => G + 2.4 * Math.exp(-((x - 210) ** 2) / (2 * 45 * 45)));
  const street = { t: 'secondary', w: 9, d: 1, v: 50, p: [[260, 60], [360, 60], [460, 60]] };
  const tram = { t: 'tram', p: [[40, 61.5], [200, 61.5], [360, 61.5], [640, 61.5]] };
  const city = cityOf([street], { rails: [tram] });
  return { city, street, tram, terrain };
}

test('a tram is laid at the level of the street that contains it, and at its own off the street', () => {
  const { street, tram, terrain } = tramTown();
  let worstOwn = 0, worst = 0;
  for (let x = 264; x <= 456; x += 2) {
    const deck = roadGradeY(street, x - 260, terrain);
    worstOwn = Math.max(worstOwn, Math.abs(roadGradeY(tram, x - 40, terrain) - deck));
    worst = Math.max(worst, Math.abs(railGradeY(tram, x - 40, terrain) - deck));
  }
  assert.ok(worstOwn > 0.1, `the fixture's two profiles only differ by ${worstOwn.toFixed(3)} m: nothing to fix`);
  assert.ok(worst < 0.03, `the tram lies ${worst.toFixed(3)} m off the deck of its street`);
  // well clear of the street it is on its own bed again, and gets there without a step
  assert.ok(Math.abs(railGradeY(tram, 20, terrain) - roadGradeY(tram, 20, terrain)) < 1e-6, 'off the street the tram left its own profile');
  assert.ok(Math.abs(railGradeY(tram, 590, terrain) - roadGradeY(tram, 590, terrain)) < 1e-6);
  for (let s = 180; s < 440; s += 0.5) {
    const step = Math.abs(railGradeY(tram, s + 0.5, terrain) - railGradeY(tram, s, terrain));
    assert.ok(step < 0.06, `a ${step.toFixed(3)} m step in the track ${s} m along it`);
  }
  // heavy rail keeps its own bed whatever road it crosses
  const rail = { t: 'rail', p: tram.p, _len: tram._len };
  assert.equal(railGradeY(rail, 300, terrain), roadGradeY(rail, 300, terrain));
});

test('the drawn panel, the feet on it and the mesh worker all get the street\'s level', () => {
  const { city, street, tram, terrain } = tramTown();
  const mats = matsFor(terrain);
  const w = worldOf(city, terrain);
  // the worker FIRST (it has no streets to ask: the level travels with the rail)
  const got = workerBuild({ city, terrain, canopy: null, ground: null, mats }, 0, 0, (a) => {
    const t2 = a.city.chunkIndex.get('0,0').rails[0], out = [];
    for (let s = 230; s < 400; s += 7) out.push(railGradeY(t2, s, a.mats.terrain));
    return out;
  });
  const main = [];
  for (let s = 230; s < 400; s += 7) main.push(railGradeY(tram, s, terrain));
  assert.deepEqual(got, main, 'the mesh worker lays the tram at another level than the main thread');
  // the panel top: concrete along the track's axis, three centimetres over the asphalt
  const panel = trisOf(city, 0, 0, SURF.concrete, terrain, mats)
    .filter(([x, , z]) => x > 270 && x < 350 && Math.abs(z - 61.5) < 0.5);
  assert.ok(panel.length > 20, `only ${panel.length} triangles of panel: the fixture drew no track in the street`);
  let off = 0;
  for (const [x, , , y] of panel) off = Math.max(off, Math.abs(y - (roadGradeY(street, x - 260, terrain) + LAYER_Y.road + 0.03)));
  assert.ok(off < 0.03, `the panel is drawn ${off.toFixed(3)} m off 3 cm over its street's asphalt`);
  // feet: on the panel over the track, on the asphalt beside it (the panel is 1.42 m either side, not 2.6)
  for (const x of [274, 300, 330]) {
    const deck = roadGradeY(street, x - 260, terrain) + LAYER_Y.road;
    assert.ok(Math.abs(w.heightAt(x, 61.5, deck + 0.5) - (deck + 0.03)) < 0.03, `feet on the track at x = ${x} are not on the panel`);
    assert.ok(Math.abs(w.heightAt(x, 59.2, deck + 0.5) - deck) < 0.02, `2.3 m from the track at x = ${x} feet are not on the asphalt`);
  }
});

test('where two carriageways on different levels cover the track, the tram lies on the higher one', () => {
  // the two halves of a boulevard on a cross slope: two ways 6 m apart, each
  // drawn 9 m wide, so they overlap where the track runs, 0.9 m apart in level
  const terrain = realTerrain((x, z) => G + 0.15 * (z - 60));
  const low = { t: 'secondary', w: 9, d: 1, v: 50, ow: 1, p: [[20, 60], [380, 60]] };
  const high = { t: 'secondary', w: 9, d: 1, v: 50, ow: 1, p: [[20, 66], [380, 66]] };
  // nearer the LOWER centreline (2.6 m against 3.4): the nearest way is the wrong one to ask
  const tram = { t: 'tram', p: [[20, 62.6], [380, 62.6]] };
  cityOf([low, high], { rails: [tram] });
  for (let x = 60; x <= 340; x += 20) {
    const a = roadGradeY(low, x - 20, terrain), b = roadGradeY(high, x - 20, terrain);
    assert.ok(b - a > 0.5, `the fixture's two decks are only ${(b - a).toFixed(2)} m apart at x = ${x}`);
    const laid = railGradeY(tram, x - 20, terrain);
    assert.ok(Math.abs(laid - b) < 0.02, `at x = ${x} the tram lies ${(b - laid).toFixed(2)} m under the asphalt that covers it`);
  }
});

test('across a junction the tram lies on the pad, for the mesh, for feet and for the mesh worker', () => {
  // A crossroads whose ground the earthworks raise AFTER its streets were
  // levelled (another way's claim on the same grid samples, which is what
  // Prague's stacked embankments do): the pad may not sink more than the cut
  // budget under the ground as it stands, so it comes up over its own arms.
  const terrain = realTerrain();
  const main = { t: 'secondary', w: 9, d: 1, v: 50, p: [[40, 60], [200, 60], [360, 60]] };
  const a = { t: 'residential', w: 7, d: 1, v: 30, p: [[200, 2], [200, 60]] };
  const a2 = { t: 'residential', w: 7, d: 1, v: 30, p: [[200, 60], [200, 118]] };
  const tram = { t: 'tram', p: [[44, 61.5], [200, 61.5], [356, 61.5]] };
  const city = cityOf([main, a, a2], { rails: [tram] });
  const pad = [...JUNCTIONS.values()].flat().find((j) => Math.hypot(j.x - 200, j.z - 60) < 1);
  assert.ok(pad, 'the fixture made no junction');
  for (const r of [main, a, a2, tram]) roadProfile(r, terrain);
  assert.ok(Math.abs(railGradeY(tram, 156, terrain) - G) < 0.02, 'before the ground moves the tram is not on its street');
  const grid = terrain.grids.get('0,0');
  for (let j = 2; j <= 4; j++) for (let i = 9; i <= 11; i++) grid[j * terrain.n + i] += 6;      // 0.6 m, 20 m round (200, 60)
  const ring = geo.junctionHull(pad);
  let seen = 0, lift = 0;
  for (let x = 190; x <= 210; x += 1) {
    if (!geo.pointInPolygon(x, 61.5, ring)) continue;
    seen++;
    const deck = geo.junctionDeckY(pad, x, 61.5, terrain);
    lift = Math.max(lift, deck - roadGradeY(main, x - 40, terrain));
    const laid = railGradeY(tram, x - 44, terrain);
    assert.ok(Math.abs(laid - (deck + 0.012)) < 0.004, `at x = ${x} the tram is ${(deck + 0.012 - laid).toFixed(3)} m under the pad it crosses`);
  }
  assert.ok(seen > 5, `only ${seen} stations of track on the pad`);
  assert.ok(lift > 0.05, `the fixture's pad is only ${lift.toFixed(3)} m over its street: nothing to tell apart`);
  // off the pad it is the street again
  assert.ok(Math.abs(railGradeY(tram, 80, terrain) - roadGradeY(main, 84, terrain)) < 0.02);
  // feet on the track in the crossing: on the panel, three centimetres over the pad
  const w = worldOf(city, terrain);
  const deck = geo.junctionDeckY(pad, 200, 61.5, terrain) + LAYER_Y.road + 0.012;
  assert.ok(Math.abs(w.heightAt(200, 61.5, deck + 0.5) - (deck + 0.03)) < 0.005, 'feet on the track in the crossing are not on the panel');
  // and the worker, which has the pad's bucket and no streets, gets the same numbers
  const mats = matsFor(terrain);
  const main2 = [];
  for (let s = 120; s < 200; s += 3) main2.push(railGradeY(tram, s, terrain));
  // (asked inside withJunctions, as the worker's build asks: the pad buckets are only in place there)
  const got = workerBuild({ city, terrain, canopy: null, ground: null, mats }, 0, 0, (ap, g) => {
    const t2 = ap.city.chunkIndex.get('0,0').rails[0], out = [];
    withJunctions(ap.junctions, ap.clusters, () => { for (let s = 120; s < 200; s += 3) out.push(railGradeY(t2, s, ap.mats.terrain)); });
    return { out, sig: sinkSig(g, ap.mats) };
  });
  assert.deepEqual(got.out, main2, 'the mesh worker lays the tram across the pad at another level than the main thread');
  // the track is drawn whole from its home chunk: the same vertices from both threads
  const here = sinkSig(buildChunkMeshes(city, 0, 0, mats, 'full'), mats);
  assert.equal(got.sig.n, here.n);
  assert.ok(Math.abs(got.sig.sum - here.sum) < 0.5, 'the worker drew the track across the pad somewhere else');
  // and that drawing has the panel over the pad: concrete on the axis, 3 cm over the pad's asphalt
  const panel = trisOf(city, 0, 0, SURF.concrete, terrain, mats).filter(([x, , z]) => Math.abs(x - 200) < 2 && Math.abs(z - 61.5) < 0.5);
  assert.ok(panel.length > 0, 'no panel drawn in the crossing');
  for (const [, , , y] of panel) assert.ok(Math.abs(y - (deck + 0.03)) < 0.02, `the panel in the crossing is drawn ${(y - deck).toFixed(3)} m over the pad`);
});

// ---- (b) trolley masts ---------------------------------------------------------
// A wired street 300 m long. A second carriageway runs 7.5 m to its north for
// the first half, so a mast offset to that side would stand in its lane; a
// house stands on the building line to the south further on; a bus stop digs a
// lay-by; and a crossing lands on both kerbs.
function wiredTown() {
  const wired = { t: 'secondary', w: 9, d: 1, v: 50, tw: 1, p: [[5, 60], [150, 60], [355, 60]] };
  const beside = { t: 'tertiary', w: 7, d: 1, v: 50, p: [[5, 52], [150, 52]] };
  const side = { t: 'residential', w: 7, d: 1, v: 30, p: [[250, 60], [250, 118]] };
  const buildings = [];
  for (let x = 160; x < 240; x += 6) buildings.push({ o: square(x, 64.9, 5.6), h: 9, t: 'house' });   // on the building line
  for (let x = 262; x < 350; x += 20) buildings.push({ o: square(x, 74, 10), h: 9, t: 'house' });
  const crossings = [{ p: [[320, 60]] }];
  const city = cityOf([wired, beside, side], { buildings, crossings, pois: [{ t: 'bus_stop', p: [300, 66], n: 'Test' }] });
  return { city, wired, beside, side, buildings, crossings };
}

test('a trolley mast stands at a kerb: not in a road, a lay-by, a junction, a house or at a crossing', () => {
  const { city, wired, beside, side, buildings } = wiredTown();
  assert.ok(wired._bays?.length, 'the stop made no lay-by');
  const masts = [];
  for (const key of city.chunkIndex.keys()) for (const m of trolleyPlan(city, key)) masts.push(m);
  assert.ok(masts.length >= 7, `only ${masts.length} masts on 350 m of wire`);
  const pads = [...JUNCTIONS.values()].flat();
  let north = 0;
  for (const [x, z, cx, cz, sd, , , s] of masts) {
    const at = `${x.toFixed(1)}, ${z.toFixed(1)}`;
    assert.ok(segD(x, z, beside.p) >= beside.w / 2, `a mast at ${at} stands in the carriageway beside the wired street`);
    assert.ok(segD(x, z, side.p) >= side.w / 2, `a mast at ${at} stands in the side street`);
    // behind the kerb line of its own street, wherever a lay-by has moved that line
    const out = segD(x, z, wired.p) - wired.w / 2 - bayAt(wired, s, -sd);
    assert.ok(out > 0.5, `a mast at ${at} is ${out.toFixed(2)} m behind its kerb line: in the lay-by or the lane`);
    for (const b of buildings) assert.ok(!geo.pointInPolygon(x, z, b.o), `a mast at ${at} comes up through a house`);
    for (const j of pads) {
      const ring = geo.junctionHull(j);
      assert.ok(!(ring && geo.pointInPolygon(x, z, ring) && cornerLift(j, x, z) < 0), `a mast at ${at} stands on the asphalt of a junction`);
    }
    assert.ok(Math.hypot(cx - 320, cz - 60) >= 4, `a mast at ${at} stands at the crossing`);
    if (z < 60) north++;
  }
  // none on the side where the second carriageway is, while it runs there
  assert.equal(masts.filter(([x, z]) => x < 150 && z < 60).length, 0);
  assert.ok(north > 0, 'every mast went to one side: the alternation is gone where nothing is in the way');
  // each mast is one cell's and no other's
  const ids = new Set(masts.map(([x, z]) => x.toFixed(2) + ',' + z.toFixed(2)));
  assert.equal(ids.size, masts.length, 'a mast is planted by two cells');
});

test('the masts and their wire come out of a mesh worker as the main thread builds them', () => {
  const { city } = wiredTown();
  const terrain = realTerrain();
  const mats = matsFor(terrain);
  const w = { city, terrain, canopy: null, ground: null, mats };
  for (const [cx, cz] of [[1, 0], [2, 0]]) {
    // the worker FIRST: nothing on the main thread has asked for this cell yet
    const there = workerBuild(w, cx, cz, (a, g) => sinkSig(g, a.mats));
    const here = sinkSig(buildChunkMeshes(city, cx, cz, mats, 'full'), mats);
    assert.equal(there.n, here.n, `chunk ${cx},${cz}: the worker built ${there.n} vertices, the main thread ${here.n}`);
    assert.ok(Math.abs(there.sum - here.sum) < 0.5, `chunk ${cx},${cz}: same count, different places`);
  }
});

// ---- (c) the pull of a street on a footway, and its cap ---------------------------
test('footPullW: whole beside the kerb and when level, gone beside an embankment or a wall', () => {
  // level with the street: the pull as it was, at any distance
  assert.equal(footPullW(1, 0.3, 8), 1);
  assert.equal(footPullW(0.6, -0.5, 9), 0.6);
  // five metres out, a street 1.5 m or more up is an embankment: no pull, and a ramp in between
  assert.equal(footPullW(1, 1.5, 5), 0);
  assert.equal(footPullW(1, -3, 6), 0);
  assert.ok(Math.abs(footPullW(1, 1, 5) - 0.5) < 1e-9);
  // right beside the kerb, or on the street's own band, a couple of metres is the survey's smear
  assert.equal(footPullW(1, 1.8, 2), 1);
  assert.equal(footPullW(1, 1.8, 5, 5.2), 1);
  // but more than three is a wall with the path under it
  assert.equal(footPullW(1, 5, 1), 0);
  // and it never grows a pull, or changes sign
  for (let dy = -6; dy <= 6; dy += 0.25) for (let xo = 0; xo <= 10; xo += 0.5) {
    const k = footPullW(0.8, dy, xo, 2);
    assert.ok(k >= 0 && k <= 0.8, `footPullW(0.8, ${dy}, ${xo}) = ${k}`);
  }
});

/** A kerbed street on a bank, the ground falling `drop` metres to the south of it, and a cycleway down there. */
function bankTown(drop) {
  // 225 under the street, down to 225 - drop from z = 54 to z = 50
  const terrain = ground((x, z) => G + 4 - drop * Math.max(0, Math.min(1, (54.5 - z) / 4)));
  const street = { t: 'secondary', w: 9, d: 1, v: 50, p: [[4, 60], [60, 60], [116, 60]] };
  const cycle = { t: 'cycleway', w: 2, s: 'cobble', p: [[6, 50], [114, 50]] };       // 5.5 m past the kerb line
  const buildings = [];
  for (let x = 6; x < 110; x += 20) buildings.push({ o: square(x, 72, 10), h: 9, t: 'house' });
  const city = cityOf([street, cycle], { buildings });
  return { city, street, cycle, terrain };
}

test('a cycleway at the foot of an embankment stays down there: paving, feet and the street\'s lawn', () => {
  const { city, street, cycle, terrain } = bankTown(4);
  const w = worldOf(city, terrain);
  const deck = roadGradeY(street, 56, terrain) + LAYER_Y.road;
  const own = roadGradeY(cycle, 54, terrain) + LAYER_Y.footway;
  assert.ok(deck - own > 3.5, `the fixture's street is only ${(deck - own).toFixed(2)} m over its cycleway`);
  const slab = trisOf(city, 0, 0, SURF.cobble, terrain).filter(([x, , z]) => x > 30 && x < 90 && Math.abs(z - 50) < 0.8);
  assert.ok(slab.length > 0, 'the cycleway was not drawn');
  const top = Math.max(...slab.map((t) => t[1]));
  assert.ok(top < own + 0.1, `the cycleway is drawn ${(top - own).toFixed(2)} m over its own level, up the embankment`);
  const feet = w.walkY(60, 50);
  assert.ok(Math.abs(feet - top) < 0.03, `feet on the cycleway stand ${(feet - top).toFixed(2)} m off its paving`);
  // the street's band on that side is the plain pavement, not a lawn shelf out to the cycleway
  assert.ok(streetOf(street), 'the street came out with no kerb');
  roadProfile(street, terrain);
  const side = [0, 1].find((sd) => vergeAt(street, 56, sd).w > 0 && vergeAt(street, 56, sd).t === 1 && Math.abs(vergeAt(street, 56, sd).w - WALK_W) < 0.01);
  let lawn = 0;
  for (const sd of [0, 1]) if (vergeAt(street, 56, sd).t === 2) lawn = Math.max(lawn, vergeAt(street, 56, sd).w);
  assert.ok(side !== undefined && lawn < 3, `the street still has a ${lawn.toFixed(1)} m lawn reaching for the cycleway`);
});

test('the same cycleway on level ground still rides the street\'s pavement', () => {
  const { city, street, terrain } = bankTown(0);
  const w = worldOf(city, terrain);
  const deck = roadGradeY(street, 56, terrain) + LAYER_Y.road;
  const slab = trisOf(city, 0, 0, SURF.cobble, terrain).filter(([x, , z]) => x > 30 && x < 90 && Math.abs(z - 50) < 0.8);
  const top = Math.max(...slab.map((t) => t[1]));
  assert.ok(top > deck + KERB_H - 0.01, `on the level the cycleway is ${(top - deck).toFixed(3)} m over the deck, under the pavement beside it`);
  assert.ok(Math.abs(w.walkY(60, 50) - top) < 0.03);
  let lawn = 0;
  for (const sd of [0, 1]) if (vergeAt(street, 56, sd).t === 2) lawn = Math.max(lawn, vergeAt(street, 56, sd).w);
  assert.ok(lawn > 5, 'on the level the lawn no longer reaches the cycleway');
});

test('on a path whose ground the earthworks raised, feet are on the slab that is drawn, not on the grid over it', () => {
  // a cycleway on flat ground, levelled, and THEN the height grid comes up
  // 0.6 m round the middle of it (the shoulder of a street's embankment
  // claiming the same 20 m samples). The drawn ground is clamped under the
  // path's strip; the grid is not.
  const terrain = realTerrain();
  const cycle = { t: 'cycleway', w: 2, s: 'asphalt', p: [[10, 60], [110, 60]] };
  const city = cityOf([cycle]);
  const w = worldOf(city, terrain);
  roadProfile(cycle, terrain);
  const slab = roadGradeY(cycle, 50, terrain) + LAYER_Y.footway;
  assert.ok(Math.abs(w.walkY(60, 60) - slab) < 0.01, 'before the ground moves feet are not on the path');
  const grid = terrain.grids.get('0,0');
  for (let j = 2; j <= 4; j++) for (let i = 2; i <= 4; i++) grid[j * terrain.n + i] += 6;
  assert.ok(terrain.heightAt(60, 60) - slab > 0.4, 'the fixture did not raise the grid over the path');
  assert.ok(Math.abs(w.walkY(60, 60) - slab) < 0.01, `feet on the path stand ${(w.walkY(60, 60) - slab).toFixed(2)} m over its slab, on ground that is not drawn`);
  assert.ok(Math.abs(w.walkY(60, 60.9) - slab) < 0.01, 'the edge of the strip is the strip too');
  // beside the path the ground is the ground
  assert.ok(Math.abs(w.walkY(60, 64) - terrain.heightAt(60, 64)) < 0.01, 'off the path feet left the ground');
  // and where the ground is UNDER the slab nothing changed: the slab
  for (let j = 2; j <= 4; j++) for (let i = 2; i <= 4; i++) grid[j * terrain.n + i] -= 12;
  assert.ok(Math.abs(w.walkY(60, 60) - slab) < 0.01);
});

// ---- (e) the spec that is first to ask ------------------------------------------
test('a chunk spec gathered before anything asked for the junctions carries finished clusters', () => {
  // two crossroads 16 m apart on one street: one crossing cluster
  // (each side street is two ways, so each node is three ways meeting: a
  // junction in its own right, which is what a cluster is made of)
  const main = { t: 'secondary', w: 9, d: 1, v: 50, p: [[4, 60], [52, 60], [68, 60], [116, 60]] };
  const a = { t: 'residential', w: 7, d: 1, v: 30, p: [[52, 8], [52, 60]] };
  const a2 = { t: 'residential', w: 7, d: 1, v: 30, p: [[52, 60], [52, 112]] };
  const b = { t: 'residential', w: 7, d: 1, v: 30, p: [[68, 8], [68, 60]] };
  const b2 = { t: 'residential', w: 7, d: 1, v: 30, p: [[68, 60], [68, 112]] };
  const buildings = [];
  for (let x = 6; x < 40; x += 14) for (const z of [34, 76]) buildings.push({ o: square(x, z, 10), h: 9, t: 'house' });
  for (let x = 80; x < 110; x += 14) for (const z of [34, 76]) buildings.push({ o: square(x, z, 10), h: 9, t: 'house' });
  const city = cityOf([main, a, a2, b, b2], { buildings });
  const clusters = [...CLUSTERS.values()].flat();
  assert.ok(clusters.length > 0, 'the fixture made no crossing cluster');
  assert.ok(clusters.every((cl) => !cl._kd), 'something finished the cluster before the spec: the fixture tests nothing');
  const terrain = realTerrain();
  const mats = matsFor(terrain);
  const w = { city, terrain, canopy: null, ground: null, mats };
  const there = workerBuild(w, 0, 0, (ap, g) => {
    for (const list of Object.values(ap.clusters ?? {})) for (const cl of list) {
      assert.ok(cl._kd, 'a cluster crossed to the worker unfinished');
    }
    return sinkSig(g, ap.mats);
  });
  const here = sinkSig(buildChunkMeshes(city, 0, 0, mats, 'full'), mats);
  assert.equal(there.n, here.n, `the worker-first chunk has ${there.n} vertices, the main thread's rebuild ${here.n}`);
  assert.ok(Math.abs(there.sum - here.sum) < 0.5);
});
