// ---- a lamp column is an object -------------------------------------------
// Street lamps were instanced geometry and nothing else: the car drove through
// seven metres of steel as if it were fog. These are the four things that had
// to become true, and the one that is easy to get wrong.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { Poles, POLE_R, _test } = await import('../js/poles.js');

const scene = () => new THREE.Group();
/** Two batches shaped exactly like the ones meshes.js builds. */
function batch(spots) {
  const g = new THREE.BoxGeometry(0.2, 7.2, 0.2);
  const m = new THREE.MeshBasicMaterial();
  const posts = new THREE.InstancedMesh(g, m, spots.length);
  const heads = new THREE.InstancedMesh(g, m, spots.length);
  const mat = new THREE.Matrix4();
  for (let i = 0; i < spots.length; i++) {
    mat.setPosition(spots[i][0], 0, spots[i][1]);
    posts.setMatrixAt(i, mat); heads.setMatrixAt(i, mat);
  }
  return [posts, heads];
}
const flat = { heightAt: () => 220, ready: () => true };
/** Is instance i still drawn? A felled mast is zero-scaled out of the batch. */
function visible(mesh, i) {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const s = new THREE.Vector3();
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  return s.x > 1e-6;
}

test('a standing mast is solid — you cannot drive through it', () => {
  const p = new Poles(scene());
  const spots = [[50, 50, 0]];
  p.register('0,0', spots, ...batch(spots), flat);
  const pos = { x: 50.1, z: 50 };           // 10 cm off the axis, well inside
  assert.equal(p.collide(pos, 0.5), true, 'the car passed straight through it');
  const d = Math.hypot(pos.x - 50, pos.z - 50);
  assert.ok(Math.abs(d - (POLE_R + 0.5)) < 1e-6,
    `pushed to ${d.toFixed(3)} m, expected exactly the contact radius`);
});

test('…and a point that never touched it is left alone', () => {
  const p = new Poles(scene());
  const spots = [[50, 50, 0]];
  p.register('0,0', spots, ...batch(spots), flat);
  const pos = { x: 53, z: 50 };
  assert.equal(p.collide(pos, 0.5), false);
  assert.equal(pos.x, 53, 'a pole three metres away moved the car');
});

test('parking against a mast does not fell it', () => {
  const p = new Poles(scene());
  const spots = [[50, 50, 0]];
  const [posts, heads] = batch(spots);
  p.register('0,0', spots, posts, heads, flat);
  assert.equal(p.strike(50, 50, 1.0, 0, 1.2), 0, 'a walking-pace nudge felled it');
  assert.ok(visible(posts, 0), 'the mast left the batch anyway');
  assert.equal(p.falling.length, 0);
});

test('hitting one at speed puts it in the gutter', () => {
  const p = new Poles(scene());
  const spots = [[50, 50, 0]];
  const [posts, heads] = batch(spots);
  p.register('0,0', spots, posts, heads, flat);
  const n = p.strike(50, 50, 0, -14, 1.2);       // ~50 km/h, heading north
  assert.equal(n, 1, 'the mast survived a 50 km/h hit');
  assert.ok(!visible(posts, 0), 'it is still being drawn upright in the batch');
  assert.ok(!visible(heads, 0), 'its lamp head is still floating there');
  assert.equal(p.falling.length, 1, 'nothing was spawned to fall over');
  // …and it is no longer in the way
  const pos = { x: 50.1, z: 50 };
  assert.equal(p.collide(pos, 0.5), false, 'a felled mast is still solid');
});

test('it goes over the way it was pushed, then lies still', () => {
  const p = new Poles(scene());
  const spots = [[50, 50, 0]];
  p.register('0,0', spots, ...batch(spots), flat);
  p.strike(50, 50, 0, -14, 1.2);
  const mesh = p.falling[0].mesh;
  assert.equal(mesh.quaternion.angleTo(new THREE.Quaternion()), 0, 'it starts bent');
  for (let t = 0; t < _test.FALL_T + 0.2; t += 1 / 60) p.update(1 / 60);
  const tilt = mesh.quaternion.angleTo(new THREE.Quaternion());
  assert.ok(Math.abs(tilt - Math.PI / 2) < 0.05,
    `it came to rest at ${(tilt * 180 / Math.PI).toFixed(0)}°, not flat`);
  // the top ends up DOWNSTREAM of the base — it was pushed north (−z)
  const top = new THREE.Vector3(0, 7.2, 0).applyQuaternion(mesh.quaternion);
  assert.ok(top.z < -3, `the mast fell the wrong way: top at z ${top.z.toFixed(1)}`);
});

test('a rebuilt chunk does not stand a felled mast back up', () => {
  // the one that is easy to get wrong: chunks rebuild on LOD upgrades, on tile
  // arrival, on re-entry — each time with brand-new batches, every pole upright
  const p = new Poles(scene());
  const spots = [[50, 50, 0], [80, 50, 0]];
  p.register('0,0', spots, ...batch(spots), flat);
  p.strike(50, 50, 0, -14, 1.2);
  const [posts2, heads2] = batch(spots);
  const gone = p.register('0,0', spots, posts2, heads2, flat);
  assert.equal(gone, 1, 'the rebuild reported no felled masts');
  assert.ok(!visible(posts2, 0), 'the felled mast is standing again after a rebuild');
  assert.ok(visible(posts2, 1), 'its untouched neighbour vanished too');
  const pos = { x: 50.1, z: 50 };
  assert.equal(p.collide(pos, 0.5), false, 'the felled mast is solid again');
});

test('a chunk that unloads takes its masts but not its damage', () => {
  const p = new Poles(scene());
  const spots = [[50, 50, 0]];
  p.register('0,0', spots, ...batch(spots), flat);
  p.strike(50, 50, 0, -14, 1.2);
  p.unregister('0,0');
  assert.equal(p.near(50, 50, 5).length, 0, 'the chunk left poles behind');
  // …and coming back does not resurrect it
  const [posts2, heads2] = batch(spots);
  assert.equal(p.register('0,0', spots, posts2, heads2, flat), 1,
    'driving away and back repaired the lamp');
});

test('two chunks do not evict each other', () => {
  const p = new Poles(scene());
  const a = [[10, 10, 0]], b = [[100, 100, 0]];
  p.register('0,0', a, ...batch(a), flat);
  p.register('0,1', b, ...batch(b), flat);
  p.unregister('0,0');
  assert.equal(p.near(10, 10, 5).length, 0, '0,0 kept its pole');
  assert.equal(p.near(100, 100, 5).length, 1, 'unregistering 0,0 removed 0,1\'s pole');
});

test('…whichever way it was hit from', () => {
  // the sign of the hinge axis is the easy thing to get backwards, and one
  // direction can pass by luck
  for (const [vx, vz, want] of [[0, -14, 'z<'], [0, 14, 'z>'], [14, 0, 'x>'], [-14, 0, 'x<']]) {
    const p = new Poles(scene());
    const spots = [[50, 50, 0]];
    p.register('0,0', spots, ...batch(spots), flat);
    p.strike(50, 50, vx, vz, 1.2);
    for (let t = 0; t < _test.FALL_T + 0.2; t += 1 / 60) p.update(1 / 60);
    const top = new THREE.Vector3(0, 7.2, 0).applyQuaternion(p.falling[0].mesh.quaternion);
    const ok = want === 'z<' ? top.z < -3 : want === 'z>' ? top.z > 3
      : want === 'x>' ? top.x > 3 : top.x < -3;
    assert.ok(ok, `hit travelling (${vx}, ${vz}) laid the mast at `
      + `(${top.x.toFixed(1)}, ${top.z.toFixed(1)}) — it should follow the blow`);
  }
});
