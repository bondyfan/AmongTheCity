// Prague's night lights that the round 7 build left in the wrong place
// (round 7 polish, package OLDTOWN):
//   · the lanterns of Charles Bridge are part of the model, not masts, and
//     lit nothing: js/landmarklamps.js reads them from the model's own list;
//   · the surveyed lamps of the other bridges stood on the riverbed under the
//     deck (meshes.js lampSpots placed them like street lamps, at the terrain);
//   · the far field lit windows at the TILE's heights in the landmark
//     footprints and under lifted ones (js/farlights.js).
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { karluvLanterns, AXIS, LANTERN_UP } = await import('../js/landmarks-karluv.js');
const { addLandmarkLamps } = await import('../js/landmarklamps.js');
const { lampPlan } = await import('../js/meshes.js');
const { cellPoints } = await import('../js/farlights.js');
const { Terrain } = await import('../js/terrain.js');
const { LANDMARKS, matches } = await import('../js/landmarks.js');
const { setStreetCity, chunkKey, bridgeDeckHeight, JUNCTIONS, CLUSTERS } = await import('../js/geo.js');

const CHUNK = 120;
const load = (k) => JSON.parse(readFileSync(new URL(`../public/data/tiles/${k}.json`, import.meta.url), 'utf8'));
const west = load('-21_-2'), east = load('-20_-2');

// A flat valley at 185 m. A deck is anchored on its banks (geo.js
// bridgeDeckHeight), so on flat ground it lies at about 185 too: what tells a
// lamp ON the deck from one at the terrain is that it carries the deck's
// height at all (spot[3]), and that the height is the deck's.
function flatTerrain(keys) {
  const terrain = new Terrain(4800, 20);
  for (const k of keys) {
    const g = new Int16Array(terrain.n * terrain.n).fill(1850);
    terrain.grids.set(k, g);
  }
  terrain._loads = 1;
  return terrain;
}
const terrain = flatTerrain(['-21,-2', '-20,-2']);

// The tile's roads and lamps filed by chunk, the way geo.js bucketizes them
// (a way in every cell its box touches, a point in its own cell).
function index(tiles) {
  const idx = new Map();
  const cell = (k) => {
    let c = idx.get(k);
    if (!c) idx.set(k, c = { buildings: [], roads: [], furniture: [], trees: [] });
    return c;
  };
  for (const t of tiles) {
    for (const r0 of t.roads) {
      const r = { ...r0, p: r0.p.map((q) => q.slice()) };
      let len = 0;
      for (let i = 0; i + 1 < r.p.length; i++) len += Math.hypot(r.p[i + 1][0] - r.p[i][0], r.p[i + 1][1] - r.p[i][1]);
      r._len = len; r._id = r._id ?? Math.round(Math.abs(r.p[0][0] * 7 + r.p[0][1] * 3));
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of r.p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++)
        for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++) cell(cx + ',' + cz).roads.push(r);
    }
    for (const f of t.furniture) cell(chunkKey(f.p[0], f.p[1])).furniture.push({ p: [f.p], k: f.k });
  }
  return idx;
}
const city = { chunkIndex: index([west, east]), tile: 4800, pois: [], waterways: [] };
setStreetCity(city);
JUNCTIONS.clear(); CLUSTERS.clear();

test('every lantern of Charles Bridge lights the deck it stands on', () => {
  const roadsAt = (x, z) => city.chunkIndex.get(chunkKey(x, z))?.roads ?? [];
  const L = karluvLanterns(roadsAt, terrain);
  assert.equal(L.length, 32, `${L.length} lanterns: one pair per arch is 32`);
  for (const q of L) {
    // over the river, well above the flat 185 m valley, and not floating
    assert.ok(q.deck >= 185 && q.deck < 200, `a lantern deck at ${q.deck.toFixed(1)} m`);
    // on the parapet: 4.8 m off the centre line, its light pointing in over the walk
    let best = Infinity, bx = 0, bz = 0;
    for (let i = 0; i + 1 < AXIS.length; i++) {
      const [ax, az] = AXIS[i], [cx, cz] = AXIS[i + 1], ex = cx - ax, ez = cz - az;
      const t = Math.max(0, Math.min(1, ((q.x - ax) * ex + (q.z - az) * ez) / (ex * ex + ez * ez)));
      const d = Math.hypot(ax + ex * t - q.x, az + ez * t - q.z);
      if (d < best) { best = d; bx = ax + ex * t; bz = az + ez * t; }
    }
    assert.ok(Math.abs(best - 4.775) < 0.05, `a lantern ${best.toFixed(2)} m off the axis`);
    assert.ok((bx - q.x) * q.nx + (bz - q.z) * q.nz > 4.5, 'a lantern lights the river, not the deck');
    assert.ok(Math.abs(Math.hypot(q.ax, q.az) - 1) < 1e-6 && Math.abs(q.ax * q.nx + q.az * q.nz) < 1e-6);
  }
  // nothing read where the bridge ways are not indexed: no lantern over a dark river
  assert.equal(karluvLanterns(() => [], terrain).length, 0);
  assert.ok(LANTERN_UP > 3.5 && LANTERN_UP < 5);
});

test('the lanterns go into the pool and glow instances after the masts, near the bridge only', () => {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mk = () => { const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 64); m.setColorAt(0, new THREE.Color()); return m; };
  const pools = mk(), glows = mk();
  const world = { city, terrain };
  const k = addLandmarkLamps(pools, glows, world, -96350, -6095, 5, 64, 500, 0.17);
  assert.equal(k, 5 + 32);
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  pools.getMatrixAt(5, m); p.setFromMatrixPosition(m);
  assert.ok(p.y >= 185, 'the pool lies under the ground');
  glows.getMatrixAt(5, m); const g = new THREE.Vector3().setFromMatrixPosition(m);
  assert.ok(g.y - p.y > 3.5, 'the glow is not up at the lantern');
  // the cap is kept, and a camera in Pardubice adds nothing
  assert.equal(addLandmarkLamps(pools, glows, world, -96350, -6095, 60, 64, 500, 0.17), 64);
  assert.equal(addLandmarkLamps(pools, glows, world, 1500, -900, 5, 64, 500, 0.17), 5);
});

test('the surveyed lamps of the Vltava bridges stand on the deck, not in the river', () => {
  const names = /^(Mánesův most|most Legií|Čechův most|Jiráskův most|Štefánikův most)$/;
  const bridges = [];
  for (const c of city.chunkIndex.values()) for (const r of c.roads) if (r.br && r.d && names.test(r.n ?? '') && !bridges.includes(r)) bridges.push(r);
  assert.ok(bridges.length >= 5);
  // the cells that hold a mapped lamp within 6 m of one of those decks
  const keys = new Set();
  const offDeck = (x, z, r) => {
    let best = Infinity;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1], ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1e-9)));
      best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
    }
    return best - r.w / 2;
  };
  for (const [k, c] of city.chunkIndex) for (const f of c.furniture)
    if (f.k === 'lamp' && bridges.some((r) => offDeck(f.p[0][0], f.p[0][1], r) < 6)) keys.add(k);
  assert.ok(keys.size >= 3, `only ${keys.size} cells with a bridge lamp`);
  let onDeck = 0;
  for (const k of keys) {
    const plan = lampPlan(city.chunkIndex.get(k), k, terrain, city);
    for (const sp of plan.street) {
      const r = bridges.find((b) => offDeck(sp[0], sp[1], b) < 1);
      if (!r) continue;
      onDeck++;
      assert.ok(sp[3] !== undefined, `a lamp of ${r.n} at ${sp[0].toFixed(1)}, ${sp[1].toFixed(1)} stands at the terrain`);
      // the deck under it, as the ribbon is drawn (plus the road layer)
      let best = Infinity, run = 0, s = 0;
      for (let i = 0; i + 1 < r.p.length; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1], ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez);
        const t = Math.max(0, Math.min(1, ((sp[0] - ax) * ex + (sp[1] - az) * ez) / (L * L || 1e-9)));
        const d = Math.hypot(ax + ex * t - sp[0], az + ez * t - sp[1]);
        if (d < best) { best = d; s = run + L * t; }
        run += L;
      }
      const deck = bridgeDeckHeight(r, s, terrain);
      assert.ok(Math.abs(sp[3] - deck) < 0.3, `a lamp of ${r.n} at ${sp[3].toFixed(2)} m on a deck at ${deck.toFixed(2)}`);
      assert.ok(offDeck(sp[0], sp[1], r) <= 0, `a lamp of ${r.n} stands in the air beside its deck`);
    }
  }
  assert.ok(onDeck >= 10, `only ${onDeck} lamps found on the decks`);
});

test('far windows: none in a landmark footprint, none under a lifted one', () => {
  // the Powder Tower's cell and the Old Town Hall's: their footprints are models
  for (const id of ['prasna-brana', 'radnice-vez', 'tyn']) {
    const l = LANDMARKS.find((q) => q.id === id), f = east.buildings.find((b) => matches(l, b));
    assert.ok(f, id);
    const key = chunkKey(f.o[0][0], f.o[0][1]);
    const solo = { buildings: [{ ...f, _id: 1 }, { ...f, _id: 2 }, { ...f, _id: 3 }, { ...f, _id: 4 }], roads: [], furniture: [] };
    assert.equal(cellPoints(key, solo, terrain, true, null).length, 0, `${id}: windows lit in a landmark footprint`);
  }
  // a generic skyway 6 m up: its windows are in its walls, from 6 m
  const sky = { o: [[-95900, -6300], [-95890, -6300], [-95890, -6296], [-95900, -6296]], h: 14, y: 6, t: 'bridge' };
  const pts = [];
  for (let id = 1; id < 40; id++) {
    const out = cellPoints(chunkKey(-95900, -6300), { buildings: [{ ...sky, _id: id }], roads: [], furniture: [] }, terrain, true, null);
    for (let i = 1; i < out.length; i += 6) pts.push(out[i]);
  }
  assert.ok(pts.length > 5);
  for (const y of pts) assert.ok(y >= 185 + 6 + 1.5 && y <= 185 + 14, `a window at ${(y - 185).toFixed(1)} m under a skyway 6 to 14 m up`);
});
