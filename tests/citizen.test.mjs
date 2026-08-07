// ---- The five bodies of Pardubice, and the buffer that now has an owner ----
//
// js/citizen.js v2 traded a purely-shared geometry cache for one MERGED,
// vertex-coloured mesh per citizen, and that trade bought a better figure for
// fewer draw calls. It also introduced the one thing the old file was
// carefully designed not to have: a GPU buffer that belongs to a single body
// and dies with it. The room runs 24/7 and walkers come and go every few
// minutes, so a dispose() that forgets it is a leak measured in an evening
// rather than in a session — which is why the first test below is the one
// worth having.
//
// three.js is the vendored copy; the resolver hook teaches node what the page's
// importmap teaches the browser, so the real three runs and simply never
// touches WebGL. See tests/three-alias.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { makeCitizen, disposeCitizenAssets } = await import('../js/citizen.js');
const { ARCHETYPES, archetypeAt, archetype } = await import('../js/people.js');

const KEYS = ARCHETYPES.map((a) => a.key);

function meshesIn(g) {
  let n = 0;
  g.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

// ---------------------------------------------------------------- shape ----

test('every archetype builds, and no two of them are the same height', () => {
  const tops = new Map();
  for (const key of KEYS) {
    const c = makeCitizen({ archetype: key });
    assert.ok(c.group, `${key}: no group`);
    assert.equal(c.arch.key, key);
    assert.ok(c.headTop > 1.4 && c.headTop < 1.95, `${key}: headTop ${c.headTop}`);
    tops.set(key, +c.headTop.toFixed(3));
    c.dispose();
  }
  assert.equal(new Set(tops.values()).size, KEYS.length,
    `two archetypes are the same height: ${JSON.stringify([...tops])}`);
});

// The whole point of the rewrite: MORE figure, FEWER meshes. The old one drew
// fifteen. If a future edit splits the cluster back out, this is where it says
// so, because the cost is invisible until the frame rate moves.
test('a citizen is 13 meshes, 14 with a walking stick', () => {
  for (const key of KEYS) {
    const c = makeCitizen({ archetype: key });
    const n = meshesIn(c.group);
    assert.equal(n, key === 'm90' ? 14 : 13, `${key} drew ${n} meshes`);
    c.dispose();
  }
});

test('the static half really is one mesh with colours in the geometry', () => {
  const c = makeCitizen({ archetype: 'm30' });
  const g = c.parts.cluster.geometry;
  assert.ok(g.getAttribute('color'), 'the cluster carries no vertex colours');
  assert.ok(g.getAttribute('position').count > 200, 'suspiciously few vertices to be a torso and a head');
  assert.ok(c.parts.cluster.material.vertexColors, 'the material ignores them');
  c.dispose();
});

// One material for every citizen in the world is what makes 13 meshes cheap.
test('two citizens with different clothes still share the cluster material', () => {
  const a = makeCitizen({ archetype: 'm30', jacket: 0x112233, pants: 0x445566 });
  const b = makeCitizen({ archetype: 'f60', jacket: 0xaabbcc, pants: 0xddeeff });
  assert.equal(a.parts.cluster.material, b.parts.cluster.material);
  assert.notEqual(a.parts.cluster.geometry, b.parts.cluster.geometry);
  a.dispose(); b.dispose();
});

// ------------------------------------------------------------- lifecycle ----

// THE LEAK TEST. dispose() has to free the one buffer this body owns, and must
// NOT free the shared limb geometry forty other people are still drawing from.
test('dispose frees the body its own geometry and nothing else', () => {
  const c = makeCitizen({ archetype: 'm30' });
  const clusterGeo = c.parts.cluster.geometry;
  const thighGeo = c.parts.legL.children[0].geometry;

  let freedCluster = 0, freedShared = 0;
  clusterGeo.addEventListener('dispose', () => freedCluster++);
  thighGeo.addEventListener('dispose', () => freedShared++);

  c.dispose();
  assert.equal(freedCluster, 1, 'the per-body cluster geometry leaked');
  assert.equal(freedShared, 0, 'dispose freed geometry other citizens share');
});

test('a disposed citizen is off the scene graph and empty', () => {
  const scene = new THREE.Scene();
  const c = makeCitizen({ archetype: 'f30' });
  scene.add(c.group);
  assert.equal(scene.children.length, 1);
  c.dispose();
  assert.equal(scene.children.length, 0, 'still attached');
  assert.equal(c.group.children.length, 0, 'still holding its own subtree');
});

// js/chatter.js uses a null mesh parent as its liveness test for a speaker.
test('a disposed body reads as gone the way chatter tests for it', () => {
  const scene = new THREE.Scene();
  const c = makeCitizen({ archetype: 'm60' });
  scene.add(c.group);
  assert.ok(c.group.parent, 'a live body has a parent');
  c.dispose();
  assert.equal(c.group.parent, null, 'chatter would keep talking for a dead man');
});

// --------------------------------------------------------------- posing ----

test('the poses move the joints they claim to and undo each other', () => {
  const c = makeCitizen({ archetype: 'm30' });
  const { legL, kneeL, elbowL, torso } = c.parts;

  c.walk(1.2, 1, 0);
  assert.notEqual(legL.rotation.x, 0, 'the hip never moved');
  assert.notEqual(kneeL.rotation.x, 0, 'the knee never bent — that is the whole feature');

  c.sitPose(1);
  assert.ok(legL.rotation.x > 0.9, 'the hip did not fold into the footwell');
  assert.ok(kneeL.rotation.x < -0.9, 'the shin did not fold back under the seat');

  c.ragdollPose();
  c.standPose();
  assert.equal(legL.rotation.x, 0);
  assert.equal(kneeL.rotation.x, 0);
  assert.equal(elbowL.rotation.x, 0);
  assert.equal(legL.rotation.z, 0, 'the ragdoll splay survived standing up');
  assert.equal(torso.rotation.x, 0, 'a thirty-year-old is standing up crooked');
  c.dispose();
});

// A knee bends one way. If a future tweak to the phase lets it go positive the
// shin swings through the thigh and the walk breaks in a way that reads as a
// glitchy limb rather than as a wrong number.
test('a knee never bends forwards, at any phase or speed', () => {
  const c = makeCitizen({ archetype: 'm30' });
  for (let t = 0; t < 12.6; t += 0.05) {
    for (const run of [0, 0.5, 1]) {
      c.walk(t, 1.25, run);
      assert.ok(c.parts.kneeL.rotation.x <= 1e-9, `knee L bent forward at t=${t.toFixed(2)}`);
      assert.ok(c.parts.kneeR.rotation.x <= 1e-9, `knee R bent forward at t=${t.toFixed(2)}`);
    }
  }
  c.dispose();
});

// The stoop is what the hip joint was added for: it must bend the BACK and
// leave the legs standing vertically, not tip the whole figure about its feet.
test('an old back bends at the hip and leaves the legs alone', () => {
  const old = makeCitizen({ archetype: 'm90' });
  old.walk(0, 1, 0);
  assert.ok(old.parts.torso.rotation.x > 0.1, 'the ninety-year-old stands up straight');
  assert.equal(old.parts.body.rotation.x, 0, 'the stoop rotated the whole body about the ankles');
  old.dispose();

  const young = makeCitizen({ archetype: 'm30' });
  young.walk(0, 1, 0);
  assert.equal(young.parts.torso.rotation.x, 0, 'a thirty-year-old is stooping');
  young.dispose();
});

test('the walking stick belongs to the man who needs it, and only to him', () => {
  for (const key of KEYS) {
    const c = makeCitizen({ archetype: key });
    let brown = 0;
    c.group.traverse((o) => { if (o.isMesh && o.material?.color?.getHex() === 0x6b4a2a) brown++; });
    assert.equal(brown, key === 'm90' ? 1 : 0, `${key} has ${brown} walking sticks`);
    c.dispose();
  }
});

// -------------------------------------------------------------- identity ----

test('an unknown or missing archetype falls back to the adult, never throws', () => {
  for (const bad of [undefined, null, '', 'nonsense', 42]) {
    const c = makeCitizen({ archetype: bad });
    assert.equal(c.arch.key, 'm30', `archetype ${JSON.stringify(bad)} did not fall back`);
    c.dispose();
  }
  assert.equal(archetype('nope').key, 'm30');
});

// The hero and every peer come through the uid path; their name tags and seat
// anchors were measured against the reference adult and must not move.
test('the uid path still produces the reference adult', () => {
  const c = makeCitizen({ uid: 'somebody-1234' });
  assert.equal(c.arch.key, 'm30');
  assert.ok(Math.abs(c.headTop - 1.78) < 0.05, `headTop drifted to ${c.headTop}`);
  c.dispose();
});

test('a uid outfit is stable — the same person twice is the same person', () => {
  const a = makeCitizen({ uid: 'peer-7' });
  const b = makeCitizen({ uid: 'peer-7' });
  assert.deepEqual(a.look, b.look);
  a.dispose(); b.dispose();
});

test('the old are given old hair', () => {
  const GREYS = new Set([0x8a8a86, 0x9a978f, 0x6f6d68, 0xcfcdc6, 0xbdbab2]);
  for (const key of ['f60', 'm60', 'm90']) {
    for (let i = 0; i < 30; i++) {
      const c = makeCitizen({ archetype: key });
      assert.ok(GREYS.has(c.look.hair), `${key} drew hair ${c.look.hair.toString(16)}`);
      c.dispose();
    }
  }
});

test('archetypeAt and makeCitizen agree about who they were asked for', () => {
  for (let i = 0; i < 1000; i++) {
    const a = archetypeAt(i / 1000);
    const c = makeCitizen({ archetype: a.key });
    assert.equal(c.arch.key, a.key);
    c.dispose();
  }
});

// Runs last: it empties the caches every other test in this file relied on.
test('disposeCitizenAssets empties the shared caches', () => {
  const c = makeCitizen({ archetype: 'm30' });
  c.dispose();
  disposeCitizenAssets();
  // and building again after a hard reset still works, which is the point of
  // having a teardown at all
  const d = makeCitizen({ archetype: 'f30' });
  assert.equal(meshesIn(d.group), 13);
  d.dispose();
});
