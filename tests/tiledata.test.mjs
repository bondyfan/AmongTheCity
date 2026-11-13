// ---- the real data in the tiles (docs/TILE-FORMAT.md) -------------------------
// Round 5 put tree species, kerb parking, roof tags, a roof colour read off the
// aerial photo and the real public transport lines into the world data. Other
// modules are built on these fields, so this pins the contract from both ends:
//
//   1. the tag readers (scripts/lib/tagdata.mjs) turn OSM's spelling into the
//      codes of js/tiledata.js, and the code tables agree with the game's own
//   2. the tiles on disk say what the docs say
//   3. the runtime takes a new tile AND a tile from before any of this
// The public transport routes have their own file, tests/tiledata-routes.test.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register(new URL('./three-alias.mjs', import.meta.url));

const TD = await import('../js/tiledata.js');
const { treeExtras, parkingSides, roofTags, colourHex } = await import('../scripts/lib/tagdata.mjs');
const { RoofPhoto } = await import('../scripts/lib/roofphoto.mjs');

const PUBLIC = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const readJSON = (rel) => JSON.parse(readFileSync(path.join(PUBLIC, rel), 'utf8'));

// ---- 1. the code tables and the tag readers ---------------------------------

test('every tree taxon names a species class the game can draw', async () => {
  const { SPECIES, SP } = await import('../js/treeshapes.js');
  assert.equal(TD.TREE_TAXA[0], null);
  const ids = new Set();
  for (let i = 1; i < TD.TREE_TAXA.length; i++) {
    const t = TD.TREE_TAXA[i];
    assert.ok(!ids.has(t.id), `taxon ${t.id} twice`);
    ids.add(t.id);
    assert.ok(t.sp === -1 || (t.sp >= 0 && t.sp < SPECIES.length), `${t.id} -> class ${t.sp}`);
    assert.ok(t.sp !== SP.SHRUB, `${t.id} is a tree, not a shrub`);
    assert.ok(t.leaf === 'b' || t.leaf === 'n');
  }
  // the classes are named in a comment there and by index here: keep them honest
  const cls = (id) => SPECIES[TD.TREE_TAXA.find((t) => t?.id === id).sp].name;
  assert.equal(cls('tilia'), 'linden');
  assert.equal(cls('acer'), 'maple');
  assert.equal(cls('aesculus'), 'chestnut');
  assert.equal(cls('platanus'), 'plane');
  assert.equal(cls('populus'), 'poplar');
  assert.equal(cls('betula'), 'birch');
  assert.equal(cls('picea'), 'spruce');
  assert.equal(cls('pinus'), 'pine');
  assert.equal(cls('malus'), 'fruit');
  assert.equal(cls('quercus'), 'oak');
  // APPEND ONLY: these indices are in the committed tiles
  assert.equal(TD.TREE_TAXA[1].id, 'broadleaved');
  assert.equal(TD.TREE_TAXA[2].id, 'needleleaved');
  assert.equal(TD.TREE_TAXA[3].id, 'tilia');
  assert.equal(TD.TREE_TAXA[8].id, 'betula');
  assert.equal(TD.TREE_TAXA[14].id, 'quercus');
});

test('a tree is read in Latin, Czech and English, however it is spelled', () => {
  const id = (t) => TD.TREE_TAXA[treeExtras(t)[0] ?? 0]?.id ?? null;
  assert.equal(id({ genus: 'Tilia' }), 'tilia');
  assert.equal(id({ genus: 'Tília' }), 'tilia');
  assert.equal(id({ 'genus:cs': 'Lípa' }), 'tilia');
  assert.equal(id({ species: 'Cordata' }), 'tilia');
  assert.equal(id({ 'species:cs': 'Lípa malolistá/srdčitá' }), 'tilia');
  assert.equal(id({ species: 'Platanus acerifolia' }), 'platanus', 'a plane, not a maple');
  assert.equal(id({ 'taxon:cs': 'platan javorolistý' }), 'platanus');
  assert.equal(id({ 'species:cs': 'Kaštanovník setý' }), 'castanea', 'not the horse chestnut');
  assert.equal(id({ 'species:cs': 'Jírovec (kaštan)' }), 'aesculus');
  assert.equal(id({ species: 'maďal' }), 'aesculus');
  assert.equal(id({ genus: 'smrk' }), 'picea');
  assert.equal(id({ genus: 'spruce' }), 'picea');
  assert.equal(id({ taxon: 'Quercus robur \'Fastigiata\'' }), 'quercus');
  assert.equal(id({ species: 'Prunus avium' }), 'prunus');
  assert.equal(id({ 'genus:cs': 'třešeň ptačí' }), 'prunus');
  assert.equal(id({ genus: 'jasan (Fraxinus)' }), 'fraxinus');
  assert.equal(id({ species: 'Betula pendula' }), 'betula');
  // the genus tag outranks a species that says something else
  assert.equal(id({ genus: 'Acer', species: 'Tilia cordata' }), 'acer');
  // nothing but a leaf type still narrows the choice
  assert.equal(id({ leaf_type: 'broadleaved' }), 'broadleaved');
  assert.equal(id({ leaf_type: 'needleleaved', leaf_cycle: 'evergreen' }), 'needleleaved');
  assert.equal(id({ species: 'letní' }), null, 'an epithet alone is not a genus');
});

test('a tree record stays [x, z] unless OSM says more, and trailing unknowns are cut', () => {
  assert.deepEqual(treeExtras({ natural: 'tree' }), []);
  assert.deepEqual(treeExtras({ leaf_type: 'mixed' }), []);
  assert.deepEqual(treeExtras({ genus: 'Tilia' }), [3]);
  assert.deepEqual(treeExtras({ height: '12' }), [0, 12]);
  assert.deepEqual(treeExtras({ genus: 'Quercus', height: '18.5 m', circumference: '3.2' }), [14, 18.5, 0, 3.2]);
  assert.deepEqual(treeExtras({ circumference: '320' }), [0, 0, 0, 3.2], 'a tape read in centimetres');
  assert.deepEqual(treeExtras({ diameter_crown: '9', height: '400' }), [0, 0, 9], 'a 400 m tree is a typo');
  const p = [10, 20, ...treeExtras({ genus: 'Betula', height: '14' })];
  assert.equal(TD.treeTaxon(p).id, 'betula');
  assert.equal(TD.treeClass(p), 5);
  assert.equal(TD.treeHeight(p), 14);
  assert.equal(TD.treeCrown(p), 0);
  // and the bare record every old tile holds
  assert.equal(TD.treeTaxon([10, 20]), null);
  assert.equal(TD.treeClass([10, 20]), -1);
  assert.equal(TD.treeHeight([10, 20]), 0);
});

test('both parking schemas come out as the same per-side code', () => {
  const P = TD;
  const lane = P.parkCode(1, 1);
  // new schema
  assert.deepEqual(parkingSides({ 'parking:both': 'lane', 'parking:both:orientation': 'parallel' }), [lane, lane]);
  assert.deepEqual(parkingSides({ 'parking:left': 'no', 'parking:right': 'half_on_kerb', 'parking:right:orientation': 'diagonal' }),
    [P.PARK_NO, P.parkCode(2, 3)]);
  assert.deepEqual(parkingSides({ 'parking:both': 'no', 'parking:both:restriction': 'no_stopping' }),
    [P.PARK_NO_STOPPING, P.PARK_NO_STOPPING]);
  assert.deepEqual(parkingSides({ 'parking:both': 'no', 'parking:right': 'street_side' }), [P.PARK_NO, P.parkCode(0, 2)]);
  assert.deepEqual(parkingSides({ 'parking:right': 'separate' }), [0, P.PARK_SEPARATE]);
  assert.deepEqual(parkingSides({ 'parking:both': 'no_parking' }), [P.PARK_NO_PARKING, P.PARK_NO_PARKING]);
  assert.deepEqual(parkingSides({ 'parking:left': 'yes' }), [P.parkCode(0, 0), 0]);
  // an orientation and no position key: cars park here, nobody said where
  assert.deepEqual(parkingSides({ 'parking:both:orientation': 'parallel' }), [P.parkCode(1, 0), P.parkCode(1, 0)]);
  assert.deepEqual(parkingSides({ 'parking:left:orientation': 'diagonal', 'parking:right': 'no' }), [P.parkCode(2, 0), P.PARK_NO]);
  // old schema
  assert.deepEqual(parkingSides({ 'parking:lane:both': 'parallel', 'parking:lane:both:parallel': 'on_street' }), [lane, lane]);
  assert.deepEqual(parkingSides({ 'parking:lane:left': 'perpendicular', 'parking:lane:left:perpendicular': 'street_side',
    'parking:lane:right': 'no_parking' }), [P.parkCode(3, 2), P.PARK_NO_PARKING]);
  assert.deepEqual(parkingSides({ 'parking:lane:right': 'marked' }), [0, P.parkCode(0, 0)]);
  // the new schema wins on a way that still carries the old keys
  assert.deepEqual(parkingSides({ 'parking:both': 'no', 'parking:lane:both': 'parallel' }), [P.PARK_NO, P.PARK_NO]);
  // nothing said, nothing stored
  assert.equal(parkingSides({ highway: 'residential' }), null);
  assert.equal(parkingSides({ 'parking:right': 'blue' }), null);
  // and the decoders
  const c = P.parkCode(3, 2);
  assert.ok(P.parkAllowed(c) && !P.parkForbidden(c));
  assert.equal(P.PARK_ORIENT[P.parkOrient(c)], 'perpendicular');
  assert.equal(P.PARK_POSITION[P.parkPosition(c)], 'street_side');
  assert.ok(P.parkForbidden(P.PARK_NO) && P.parkForbidden(P.PARK_NO_STOPPING));
  assert.ok(!P.parkForbidden(P.PARK_NONE) && !P.parkForbidden(P.PARK_SEPARATE) && !P.parkAllowed(P.PARK_SEPARATE));
  assert.equal(P.parkSide({ pk: [P.PARK_NO, lane] }, 1), lane);
  assert.equal(P.parkSide({}, 0), P.PARK_NONE);
  for (let o = 0; o < 4; o++) for (let p = 0; p < 6; p++) {
    const k = P.parkCode(o, p);
    assert.ok(k >= 8 && k < 32 && P.parkOrient(k) === o && P.parkPosition(k) === p);
  }
});

test('roof tags are normalised: a colour is a hex, a material an index', () => {
  assert.equal(colourHex('#E96B39'), '#e96b39');
  assert.equal(colourHex('#abc'), '#aabbcc');
  assert.equal(colourHex('1c71d8'), '#1c71d8');
  assert.equal(colourHex('darksalmon'), '#e9967a');
  assert.equal(colourHex('Light Grey'), '#d3d3d3');
  assert.equal(colourHex('no idea'), null);
  // a NAMED roof colour is the material it describes, not the CSS primary
  assert.equal(colourHex('red'), '#ff0000');
  assert.notEqual(colourHex('red', true), '#ff0000');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colourHex('red', true).slice(i, i + 2), 16));
  assert.ok(r > g + 40 && r > b + 40 && r < 230, 'fired clay');
  const t = roofTags({ 'roof:colour': 'red', 'roof:material': 'roof_tiles', 'building:material': 'brick',
    'roof:levels': '1', 'roof:height': '2.5', 'roof:direction': '165', 'roof:orientation': 'across' });
  assert.equal(t.rc, colourHex('red', true));
  assert.equal(TD.ROOF_MATERIALS[t.rm], 'roof_tiles');
  assert.equal(TD.WALL_MATERIALS[t.bm], 'brick');
  assert.deepEqual([t.rl, t.rh, t.rd, t.ro], [1, 2.5, 165, TD.ROOF_ACROSS]);
  assert.deepEqual(roofTags({ building: 'yes' }), {});
  assert.deepEqual(roofTags({ 'roof:levels': '0' }), { rl: 0 }, 'no attic is an answer');
  assert.deepEqual(roofTags({ 'roof:direction': 'across' }), { ro: TD.ROOF_ACROSS }, 'filed under the wrong key');
  assert.deepEqual(roofTags({ 'roof:direction': 'north_west' }), { rd: 315 });
  assert.deepEqual(roofTags({ 'roof:height': '-0.25', 'roof:levels': '1=' }), {});
  assert.equal(TD.ROOF_MATERIALS[roofTags({ 'roof:material': 'metal sheet' }).rm], 'metal');
  // APPEND ONLY
  assert.equal(TD.ROOF_MATERIALS[1], 'roof_tiles');
  assert.equal(TD.ROOF_MATERIALS[7], 'copper');
  assert.equal(TD.WALL_MATERIALS[2], 'brick');
  // tag over photo over nothing
  assert.equal(TD.roofColour({ rc: '#111111', rp: '#222222' }), '#111111');
  assert.equal(TD.roofColour({ rp: '#222222' }), '#222222');
  assert.equal(TD.roofColour({}), null);
});

test('the roof colour is the median of the inner, sunlit, leafless pixels', () => {
  // a synthetic photograph: 2 m pixels, a red roof at x 20..40, z 20..34 with a
  // shaded northern half, a tree over one corner, lawn all round
  const PX = 1200;
  const rgb = new Uint8Array(PX * PX * 3);
  for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) {
    const x = i * 2 + 1, z = j * 2 + 1, o = (j * PX + i) * 3;
    let c = [70, 120, 60];                                         // lawn
    if (x > 20 && x < 40 && z > 20 && z < 34) c = z < 25 ? [95, 52, 44] : [182, 96, 74];   // shade | lit tile
    if (x > 34 && x < 40 && z > 28 && z < 34) c = [60, 110, 50];   // a branch over the corner
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
  const photo = new RoofPhoto('/nowhere', () => { throw new Error('no file is read here'); });
  photo.cache.set('0,0', { rgb, i0: 0, j0: 0 });
  const roof = [[20, 20], [40, 20], [40, 34], [20, 34]];
  assert.equal(photo.sample(roof), '#b6604a', 'the lit tile, not the shade, the tree or the lawn');
  assert.deepEqual(photo.at(31, 31), [182, 96, 74]);
  // a shed wholly under a crown (here: a footprint on the lawn): what the
  // photograph saw is leaves, and a leaf green "roof" is worse than no answer
  assert.equal(photo.sample(roof.map(([x, z]) => [x + 40, z + 40])), null);
  // a footprint with no photograph under it has no answer
  photo.cache.set('5,5', null);
  assert.equal(photo.sample(roof.map(([x, z]) => [x + 5 * 2400, z + 5 * 2400])), null);
  // ...and neither has one too small to hold a pixel of its own
  assert.equal(photo.sample([[21, 21], [22.5, 21], [22.5, 22.5], [21, 22.5]]), null);
});

// ---- 2. what is on disk -----------------------------------------------------

const manifest = readJSON('data/manifest.json');
const haveRoutes = !!manifest.routes && existsSync(path.join(PUBLIC, 'data/routes/0_-1.json'));

test('the Pardubice tile carries the new fields in the documented shape', () => {
  const tile = readJSON('data/tiles/0_-1.json');
  let longer = 0;
  for (const p of tile.trees) {
    assert.ok(p.length >= 2 && p.length <= 6 && typeof p[0] === 'number' && typeof p[1] === 'number');
    if (p.length > 2) {
      longer++;
      assert.ok(p[p.length - 1] !== 0, 'trailing unknowns are cut');
      assert.ok(Number.isInteger(p[2]) && p[2] >= 0 && p[2] < TD.TREE_TAXA.length);
    }
  }
  assert.ok(longer > 800, `only ${longer} of ${tile.trees.length} trees say what they are`);
  for (const r of tile.roads) {
    if (!r.pk) continue;
    assert.ok(Array.isArray(r.pk) && r.pk.length === 2 && r.pk.every((c) => Number.isInteger(c) && c >= 0 && c < 32));
    assert.ok(r.pk[0] || r.pk[1]);
  }
  const hex = /^#[0-9a-f]{6}$/;
  let rp = 0, rc = 0;
  for (const b of tile.buildings) {
    if (b.rp !== undefined) { rp++; assert.match(b.rp, hex); }
    if (b.rc !== undefined) { rc++; assert.match(b.rc, hex); }
    if (b.rm !== undefined) assert.ok(TD.ROOF_MATERIALS[b.rm]);
    if (b.bm !== undefined) assert.ok(TD.WALL_MATERIALS[b.bm]);
    if (b.ro !== undefined) assert.ok(b.ro === 1 || b.ro === 2);
    if (b.rd !== undefined) assert.ok(b.rd >= 0 && b.rd < 360);
  }
  assert.ok(rp > tile.buildings.length * 0.95, `the photo covers this tile: ${rp} of ${tile.buildings.length}`);
  assert.ok(rc > 100);
  // the old town wears red tile and the photograph agrees: of the roofs tagged
  // maroon round Pernštýnské náměstí, most are read as warmer than they are blue
  const near = tile.buildings.filter((b) => Math.hypot(b.o[0][0] - 1600, b.o[0][1] + 720) < 160 && b.rp);
  const warm = near.filter((b) => parseInt(b.rp.slice(1, 3), 16) > parseInt(b.rp.slice(5, 7), 16) + 12);
  assert.ok(near.length > 60 && warm.length > near.length * 0.45, `${warm.length} of ${near.length} old-town roofs read warm`);
});

// ---- 3. the runtime ----------------------------------------------------------

globalThis.requestAnimationFrame ??= (cb) => { setImmediate(() => cb(0)); return 0; };
const NEW_KEYS = ['rc', 'rm', 'bm', 'rl', 'rh', 'rd', 'ro', 'rp'];
let serveOld = false;
globalThis.fetch = async (url) => {
  try {
    const buf = await readFile(path.join(PUBLIC, String(url).replace(/^\//, '')));
    return {
      ok: true, status: 200,
      json: async () => {
        const d = JSON.parse(buf.toString('utf8'));
        if (!serveOld) return d;
        // a tile (and a manifest) exactly as they were before round 5
        if (d.tiles) { delete d.routes; for (const t of d.tiles) delete t.rt; return d; }
        for (const b of d.buildings ?? []) for (const k of NEW_KEYS) delete b[k];
        for (const r of d.roads ?? []) delete r.pk;
        d.trees = (d.trees ?? []).map((p) => p.slice(0, 2));
        return d;
      },
    };
  } catch { return { ok: false, status: 404 }; }
};

test('the runtime indexes a new tile and an old one alike, and finds the routes from the manifest', async () => {
  const { loadCity } = await import('../js/geo.js');
  const count = (city) => [city.buildings.length, city.roads.length, city.trees.length,
    city.chunkIndex.size, city.roads.reduce((s, r) => s + r._len, 0).toFixed(1)];

  serveOld = false;
  const city = await loadCity('data/manifest.json');
  await city.ensureTiles(25, -122);
  const fresh = count(city);
  assert.ok(fresh[0] > 9000 && fresh[2] > 1000);
  // the new fields ride through on the features themselves
  assert.ok(city.buildings.some((b) => b.rp), 'buildings carry rp');
  const tree = city.trees.find((t) => t.p[0].length > 2);
  assert.ok(tree && TD.treeTaxon(tree.p[0]), 'a tree carries its taxon in p[0][2]');
  assert.equal(tree.p.length, 1, 'and is still one point to the bucketizer');
  if (haveRoutes) {
    const files = city.routeFilesNear(25, -122, 100);
    assert.ok(files.includes('data/routes/0_-1.json'), String(files));
    assert.deepEqual(files, [...new Set(files)].sort(), 'each file once, in a stable order');
    assert.ok(files.length < 40, `${files.length} files for one spot`);
    for (const f of files) assert.ok(existsSync(path.join(PUBLIC, f)), f);
    // far out in the fields nothing runs
    assert.ok(city.routeFilesNear(25, -122, 100).length >= city.routeFilesNear(25, -122, 1).length);
  }

  serveOld = true;
  const old = await loadCity('data/manifest.json');
  await old.ensureTiles(25, -122);
  assert.deepEqual(count(old), fresh, 'an old tile builds the same world');
  assert.ok(!old.buildings.some((b) => b.rp || b.rc));
  assert.ok(old.trees.every((t) => t.p[0].length === 2));
  assert.deepEqual(old.routeFilesNear(25, -122, 5000), [], 'and an old manifest simply has no lines');
  serveOld = false;
});
