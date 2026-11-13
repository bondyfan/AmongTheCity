// ---- The five bodies of Pardubice, and the buffers that have an owner ----
//
// js/citizen.js v3 is one skinned, vertex-coloured mesh per citizen on a
// seventeen-bone skeleton. That bought a smooth figure for ONE draw call where
// the box figure paid thirteen, and it means every body owns a geometry and a
// bone texture that die with it. The room runs 24/7 and walkers come and go
// every few minutes, so a dispose() that forgets either is a leak measured in
// an evening: the lifecycle tests below are the ones worth having.
//
// Several tests here pinned the box figure (13 meshes, a stick that was its
// own brown mesh, a stoop with the wrong sign, a car seat folded like a
// chair). They were rewritten ON PURPOSE with v3, each with a note saying
// what changed.
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
    // headTop counts the hair and the hat, so pin both: the question here is
    // whether the five BODIES differ, not whether a beanie evens two of them up
    const c = makeCitizen({ archetype: key, style: { hat: null, hairStyle: 'short' } });
    assert.ok(c.group, `${key}: no group`);
    assert.equal(c.arch.key, key);
    assert.ok(c.headTop > 1.4 && c.headTop < 1.95, `${key}: headTop ${c.headTop}`);
    tops.set(key, +c.headTop.toFixed(3));
    c.dispose();
  }
  assert.equal(new Set(tops.values()).size, KEYS.length,
    `two archetypes are the same height: ${JSON.stringify([...tops])}`);
});

// The whole point of v3: a whole person is ONE mesh, so one draw call. The box
// figure drew thirteen (fourteen with the stick). If a future edit hangs a
// second mesh off the body, this is where it says so, because the cost is
// invisible until the frame rate moves.
test('a citizen is one mesh, whoever they are and whatever they carry', () => {
  for (const key of KEYS) {
    const c = makeCitizen({ archetype: key });
    assert.equal(meshesIn(c.group), 1, `${key} drew ${meshesIn(c.group)} meshes`);
    assert.ok(c.parts.cluster.isSkinnedMesh, `${key}: the body is not skinned`);
    c.dispose();
  }
  for (const role of ['police', 'medic']) {
    const c = makeCitizen({ role });
    assert.equal(meshesIn(c.group), 1, `${role} drew ${meshesIn(c.group)} meshes`);
    c.dispose();
  }
});

test('the body carries its colours and its skin weights in the geometry', () => {
  const c = makeCitizen({ archetype: 'm30' });
  const g = c.parts.cluster.geometry;
  assert.ok(g.getAttribute('color'), 'no vertex colours');
  assert.ok(g.getAttribute('skinIndex') && g.getAttribute('skinWeight'), 'no skin weights');
  assert.ok(g.getAttribute('position').count > 600, 'suspiciously few vertices to be a person');
  assert.ok(c.parts.cluster.material.vertexColors, 'the material ignores the colours');
  assert.equal(c.parts.cluster.material.emissive.getHex(), 0, 'people must not glow at night');
  for (const v of g.getAttribute('position').array) assert.ok(Number.isFinite(v), 'a NaN vertex');
  for (const v of g.getAttribute('normal').array) assert.ok(Number.isFinite(v), 'a NaN normal');
  c.dispose();
});

// The distance variant is a second run of indices over the SAME vertices, so
// switching costs a draw range and nothing else.
test('the far variant is a draw range, and a fraction of the triangles', () => {
  for (const key of KEYS) {
    const c = makeCitizen({ archetype: key });
    const g = c.parts.cluster.geometry, u = g.userData;
    assert.equal(g.index.count, u.nearCount + u.farCount);
    assert.equal(g.drawRange.start, 0);
    assert.equal(g.drawRange.count, u.nearCount, 'a new body should start in the near variant');
    assert.ok(u.tris.far > 120, `${key}: the far variant is only ${u.tris.far} triangles`);
    assert.ok(u.tris.far < u.tris.near * 0.3, `${key}: far ${u.tris.far} is not much cheaper than near ${u.tris.near}`);
    assert.ok(u.tris.near < 2900, `${key}: ${u.tris.near} triangles is past the budget`);
    c.dispose();
  }
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

// THE LEAK TEST. dispose() has to free the two things this body owns (its
// geometry and its skeleton's bone texture) and must NOT free the material
// every other citizen is still drawing with.
test('dispose frees the body its own buffers and nothing shared', () => {
  const c = makeCitizen({ archetype: 'm30' });
  const mesh = c.parts.cluster;
  const geo = mesh.geometry, mat = mesh.material, skel = mesh.skeleton;
  skel.computeBoneTexture();           // what the renderer does on first draw

  let freedGeo = 0, freedMat = 0, freedBones = 0;
  geo.addEventListener('dispose', () => freedGeo++);
  mat.addEventListener('dispose', () => freedMat++);
  skel.boneTexture.addEventListener('dispose', () => freedBones++);

  c.dispose();
  assert.equal(freedGeo, 1, 'the per-body geometry leaked');
  assert.equal(freedBones, 1, 'the per-body bone texture leaked');
  assert.equal(freedMat, 0, 'dispose freed the material other citizens share');
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

  // v3: a car seat is not a chair. The cushion is barely 30 cm over the floor,
  // so the legs go OUT to the pedals (the knee half open) instead of folding
  // 90 degrees and putting the feet through the floor pan. The chair fold is
  // still there for a bench, as sitPose(k, 0).
  c.sitPose(1);
  assert.ok(legL.rotation.x > 0.9, 'the hip did not fold into the footwell');
  assert.ok(kneeL.rotation.x < -0.3 && kneeL.rotation.x > -1.0, 'a car seat should leave the knee half open');
  c.sitPose(1, 0);
  assert.ok(kneeL.rotation.x < -1.2, 'on a bench the shin did not fold down under the seat');

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
  // NEGATIVE is forward for the trunk: it stands ON its joint, so the positive
  // angle that swings a hanging limb forward tips a back backward. The box
  // figure had this sign wrong and its old man leaned back.
  assert.ok(old.parts.torso.rotation.x < -0.1, 'the ninety-year-old stands up straight');
  assert.equal(old.parts.body.rotation.x, 0, 'the stoop rotated the whole body about the ankles');
  old.dispose();

  const young = makeCitizen({ archetype: 'm30' });
  young.walk(0, 1, 0);
  assert.equal(young.parts.torso.rotation.x, 0, 'a thirty-year-old is stooping');
  young.dispose();
});

// v3: the stick is part of the one mesh, on a bone of its own (16), so it is
// found by its skin weights and not by a brown material.
test('the walking stick belongs to the man who needs it, and only to him', () => {
  for (const key of KEYS) {
    const c = makeCitizen({ archetype: key });
    const si = c.parts.cluster.geometry.getAttribute('skinIndex').array;
    let onStick = 0;
    for (let i = 0; i < si.length; i += 4) if (si[i] === 16) onStick++;
    assert.equal(c.outfit.cane, key === 'm90', `${key}: cane flag`);
    assert.equal(onStick > 0, key === 'm90', `${key} has ${onStick} vertices of walking stick`);
    c.dispose();
  }
});

// ---------------------------------------------------------------- gait ----

// THE FOOT-PLANT TEST. Walk a body forward the way an owner does (advance
// walkT with distance, move the group) and watch the left ankle in the WORLD:
// while the foot lies flat on the ground it must not travel. The box figure
// advanced a fixed 3.9 m per stride at any speed, so at a pensioner's pace the
// planted foot slid most of a metre.
function slide(key, mps, scale = 0.9) {
  const c = makeCitizen({ archetype: key });
  c.group.scale.setScalar(scale);
  const foot = c.parts.footL, v = new THREE.Vector3();
  const dt = 1 / 120;
  let dist = 0, worst = 0, runStart = null, flat = 0;
  const ankle = c.parts.kneeL.position.y;      // only its sign matters below
  assert.ok(ankle < 0);
  let lowest = Infinity;
  const ys = [], zs = [];
  for (let i = 0; i < 1200; i++) {
    dist += mps * dt;
    c.group.position.z = -dist;
    c.walk(dist * 1.6, Math.min(1.3, mps / 1.4), 0, mps);
    c.group.updateMatrixWorld(true);
    v.setFromMatrixPosition(foot.matrixWorld);
    ys.push(v.y); zs.push(v.z);
    if (v.y < lowest) lowest = v.y;
  }
  for (let i = 0; i < ys.length; i++) {
    const isFlat = ys[i] < lowest + 0.004 && Math.abs(c.parts.footL.rotation.x) < 10;
    if (isFlat) {
      if (runStart == null) runStart = zs[i];
      worst = Math.max(worst, Math.abs(zs[i] - runStart));
      flat++;
    } else runStart = null;
  }
  c.dispose();
  return { worst, flat };
}

test('a planted foot stays where it was put, at each body\'s own pace', () => {
  for (const [key, mps] of [['m30', 1.4], ['f30', 1.25], ['f60', 1.15], ['m60', 1.5], ['m90', 1.2], ['m30', 0.8]]) {
    const r = slide(key, mps);
    assert.ok(r.flat > 60, `${key}: the foot was hardly ever flat on the ground (${r.flat} samples)`);
    assert.ok(r.worst < 0.02, `${key} at ${mps} m/s: the planted foot slid ${(r.worst * 100).toFixed(1)} cm`);
  }
});

test('standing still is a pose of its own, not a frozen stride', () => {
  const c = makeCitizen({ archetype: 'm30' });
  c.walk(0, 0, 0, 0);
  assert.ok(Math.abs(c.parts.legL.rotation.x) < 0.12, 'a standing leg is mid-stride');
  assert.ok(Math.abs(c.parts.legR.rotation.x) < 0.12, 'a standing leg is mid-stride');
  for (const j of ['legL', 'kneeL', 'armL', 'elbowL', 'torso', 'chest', 'head']) {
    const r = c.parts[j].rotation;
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z), `${j} is NaN`);
  }
  c.dispose();
});

// A corrupt phase or speed must cost a stride, never the body: a NaN in a
// joint turns the whole figure's matrix to NaN and it silently disappears.
test('the walk survives nonsense input', () => {
  const c = makeCitizen({ archetype: 'f60' });
  for (const [t, k, r, v] of [[NaN, 1, 0, 1], [1, NaN, 0, NaN], [1e9, 1, 5, -3], [2, 1, NaN, 1e9], [Infinity, 1, 0, 1]]) {
    c.walk(t, k, r, v);
    for (const j of Object.keys(c.parts)) {
      const o = c.parts[j];
      if (!o.rotation) continue;
      assert.ok(Number.isFinite(o.rotation.x + o.rotation.y + o.rotation.z + o.position.x + o.position.y + o.position.z),
        `${j} went NaN on walk(${t}, ${k}, ${r}, ${v})`);
    }
  }
  c.dispose();
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
  assert.deepEqual(a.outfit, b.outfit);
  // …down to the last vertex, and without touching Math.random on the way
  assert.deepEqual(a.parts.cluster.geometry.getAttribute('position').array,
    b.parts.cluster.geometry.getAttribute('position').array);
  a.dispose(); b.dispose();
  // (three itself draws from Math.random for object uuids, so the test is not
  // "zero calls" but "the answer does not depend on what the calls return")
  const real = Math.random;
  const withRandom = (v) => { Math.random = () => v; try { return makeCitizen({ uid: 'peer-8' }); } finally { Math.random = real; } };
  const lo = withRandom(0.02), hi = withRandom(0.97);
  assert.deepEqual(lo.outfit, hi.outfit, 'a player body rolled dice: two screens would disagree about it');
  assert.deepEqual(lo.parts.cluster.geometry.getAttribute('color').array, hi.parts.cluster.geometry.getAttribute('color').array);
  lo.dispose(); hi.dispose();
});

// What js/pedestrians.js relies on: it lends one seeded Math.random for the
// length of the call, and everything about the citizen has to come out of it.
test('the crowd path is a pure function of the random stream it is lent', () => {
  const build = (seed) => {
    const real = Math.random;
    let n = 0;
    Math.random = () => { n++; const x = Math.sin(seed * 999 + n * 12.9898) * 43758.5453; return x - Math.floor(x); };
    try { return makeCitizen({ archetype: 'f30' }); } finally { Math.random = real; }
  };
  const a = build(5), b = build(5), c = build(6);
  assert.deepEqual(a.outfit, b.outfit);
  assert.deepEqual(a.parts.cluster.geometry.getAttribute('color').array, b.parts.cluster.geometry.getAttribute('color').array);
  assert.notDeepEqual(a.outfit, c.outfit, 'two different citizens drew the same wardrobe');
  a.dispose(); b.dispose(); c.dispose();
});

test('a uniform is a uniform: fixed colours, and the right hat', () => {
  const p = makeCitizen({ role: 'police' }), q = makeCitizen({ role: 'police' }), m = makeCitizen({ role: 'medic' });
  assert.equal(p.outfit.role, 'police');
  assert.equal(p.outfit.hat, 'police');
  assert.deepEqual(p.look.jacket, q.look.jacket);
  assert.ok(p.outfit.vest && p.outfit.strips, 'an officer without the reflective vest');
  assert.equal(m.outfit.role, 'medic');
  assert.ok(m.outfit.yoke && m.outfit.strips, 'a medic without the yellow yoke and the strips');
  assert.equal((m.look.jacket >> 16) > 150 && ((m.look.jacket >> 8) & 255) < 80, true, 'a medic who is not red');
  p.dispose(); q.dispose(); m.dispose();
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
  assert.equal(meshesIn(d.group), 1);
  d.dispose();
});
