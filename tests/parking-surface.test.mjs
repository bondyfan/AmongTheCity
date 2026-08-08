// ---- a car park is a surface, not a photograph -----------------------------
// Fills normally stand down under the aerial ground, and for a lawn or a plaza
// that is right: the orthophoto shows them better than flat colour ever will.
//
// A car park is the exception. The photo was flown on one morning with one set
// of cars standing in it, so the lot arrives with cars baked into the ground
// texture — and then parkinglots.js parks its own cars on top of them. Two cars
// to a bay, one of them a blur, and no asphalt anywhere between them. Since the
// aerial ground became a default this is what every large lot looked like.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');

const G = 220;
const AREAS = {
  parking: { _id: 1, _home: '0,0', t: 'parking', o: [[10, 10], [110, 10], [110, 60], [10, 60]] },
  lawn:    { _id: 2, _home: '0,0', t: 'grass',   o: [[10, 70], [110, 70], [110, 110], [10, 110]] },
  plaza:   { _id: 3, _home: '0,0', t: 'plaza',   o: [[10, 150], [110, 150], [110, 190], [10, 190]] },
};

function build(withPhoto) {
  const cell = { buildings: [], roads: [], rails: [], water: [],
    green: [AREAS.lawn], paved: [AREAS.parking, AREAS.plaza],
    trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt: () => G };
  mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null;
  mats.ortho = withPhoto ? { tierOf: () => 1, orthoGroundMesh: () => {
    const g = new THREE.PlaneGeometry(120, 120, 2, 2); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    m.position.set(60, G, 60);
    return m;
  } } : null;
  const group = buildChunkMeshes(city, 0, 0, mats, 'full');
  // count vertices laid ABOVE the ground plane inside each area — that is a
  // fill, as opposed to the photo which sits at ground level
  return (x0, z0, x1, z1) => {
    let n = 0;
    for (const c of group?.children ?? []) {
      const p = c.geometry?.attributes?.position;
      if (!p) continue;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) + group.position.x;
        const y = p.getY(i) + group.position.y;
        const z = p.getZ(i) + group.position.z;
        if (x > x0 && x < x1 && z > z0 && z < z1 && y > G + 0.02 && y < G + 0.5) n++;
      }
    }
    return n;
  };
}

test('with the aerial ground ON, the car park still gets real asphalt', () => {
  const at = build(true);
  const lot = at(12, 12, 108, 58);
  assert.ok(lot > 200, `the lot has ${lot} surface vertices — the player is driving on a photograph `
    + 'of somebody else\'s cars');
});

test('…and the lawn and the plaza are still left to the photo', () => {
  const at = build(true);
  assert.equal(at(12, 72, 108, 108), 0, 'flat green was painted over the aerial lawn');
  assert.equal(at(12, 152, 108, 188), 0, 'flat grey was painted over the aerial plaza');
});

test('with the aerial ground OFF nothing changed — every fill is drawn', () => {
  const at = build(false);
  for (const [name, box] of [['parking', [12, 12, 108, 58]], ['lawn', [12, 72, 108, 108]],
    ['plaza', [12, 152, 108, 188]]])
    assert.ok(at(...box) > 200, `${name} lost its fill when there is no photo to defer to`);
});
