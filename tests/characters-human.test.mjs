// ---- js/characters/human.js on the crash-test dummy --------------------------
// The dummy (js/characters/dummy.js) is a Biped-named skeleton bound in a T
// pose, in centimetres, facing +z, with arbitrary bone axes. These tests prove
// the interface makeCitizen's callers rely on, on such a body, headless.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { installDummies } = await import('../js/characters/dummy.js');
const AV = await import('../js/characters/avatars.js');
const { makeHuman } = await import('../js/characters/human.js');
const { figureMatrices } = await import('../js/characters/skinpose.js');
const { SLOT } = await import('../js/characters/skeletonmap.js');
const { bakeFar, farRow } = await import('../js/characters/farbody.js');
const { pose: blend } = await import('../js/bodymoves.js');

const [man, woman] = installDummies();
const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

// figure-space position of a slot's bone for the pose a human holds right now
function joint(h, slot) {
  const av = h.avatar, local = h.pose();
  const fig = figureMatrices(av.rig, local, h.lastHip ?? null, av.root, new Float32Array(av.rig.n * 16));
  const i = av.rig.slotBone[SLOT[slot]];
  return new THREE.Vector3(fig[i * 16 + 12], fig[i * 16 + 13], fig[i * 16 + 14]);
}

test('a dummy becomes an avatar in figure space: metres, feet on the ground, facing -z', () => {
  assert.equal(AV.peopleReady(), true);
  near(man.height, 1.78, 0.05, 'height in metres');
  near(man.geometry.boundingBox.min.y, 0, 1e-3, 'feet at zero');
  near(man.rig.dims.hipY, 0.92, 0.02, 'hip joint height');
  // the left side is at -x once the figure faces -z, and the toes point to -z
  const L = man.rig.slotBone[SLOT.upperArmL], toe = man.rig.slotBone[SLOT.toesL], foot = man.rig.slotBone[SLOT.footL];
  assert.ok(man.rig.worldP[L * 3] < -0.15, 'left shoulder at -x');
  assert.ok(man.rig.worldP[toe * 3 + 2] < man.rig.worldP[foot * 3 + 2] - 0.1, 'toes ahead (-z) of the ankle');
  near(woman.height / man.height, 0.94, 0.01, 'the second dummy is smaller');
  // the same bones at another size share one set of baked rotations (never assert.equal
  // on an avatar: a failure would try to print the whole scene graph)
  assert.ok(woman.cls === man, 'a scaled copy of a skeleton is the same class');
  assert.ok(man.cls === null);
  assert.ok(man.tris > 100);
});

test('the clips recorded on the dummy know their ground and start on the same foot', () => {
  AV.motionSet(man);
  assert.deepEqual(man.gaits.map((g) => g.clip.name), ['walk', 'run']);
  near(man.gaits[0].speed, 1.35, 0.06, 'walk speed'); near(man.gaits[1].speed, 4.6, 0.25, 'run speed');
  for (const g of man.gaits) {
    const n = man.rig.n, fig = new Float32Array(n * 16), c = g.clip;
    figureMatrices(man.rig, c.q.subarray(0, n * 4), c.hip.subarray(0, 3), man.root, fig);
    const l = man.rig.slotBone[SLOT.footL], r = man.rig.slotBone[SLOT.footR];
    assert.ok(fig[l * 16 + 14] < fig[r * 16 + 14] - 0.2, `${c.name} starts with the left foot ahead`);
    // grounded: over the cycle the lower ankle comes down to standing ankle height
    let low = Infinity;
    for (let f = 0; f < c.frames; f++) {
      figureMatrices(man.rig, c.q.subarray(f * n * 4, (f + 1) * n * 4), c.hip.subarray(f * 3, f * 3 + 3), man.root, fig);
      low = Math.min(low, fig[l * 16 + 13], fig[r * 16 + 13]);
    }
    near(low, man.rig.dims.ankleY, 0.03, `${c.name} touches the ground`);
  }
  assert.equal(man.idles.length, 1);
});

test('a human has the citizen\'s interface and stands in its idle clip', () => {
  const h = makeHuman(man, {}, { seed: 0.3, near: true });
  for (const k of ['group', 'walk', 'sitPose', 'ragdollPose', 'standPose', 'dispose', 'punchPose', 'kickPose', 'aimPose', 'handsPose', 'parts', 'look', 'headTop'])
    assert.ok(h[k] != null, k);
  for (const k of ['body', 'torso', 'chest', 'head', 'armL', 'armR', 'elbowL', 'kneeR', 'footL', 'handL', 'handR', 'legL']) assert.ok(h.parts[k], k);
  near(h.parts.legL.position.y, man.rig.dims.hipY, 1e-6, 'the driver is sized off the skeleton');
  // standing: the idle clip holds the arms 0.12 rad out; the bare stand pose would hang them at the collar's 0.06
  const sh = joint(h, 'upperArmR'), ha = joint(h, 'handR');
  const out = Math.atan2(ha.x - sh.x, sh.y - ha.y);
  near(out, 0.12, 0.02, 'arm angle from the idle clip');
  assert.equal(h.state.kind, 'idle');
  h.dispose();
});

test('walking: the cycle advances with distance over the recorded stride', () => {
  const h = makeHuman(man, {}, { seed: 0, near: true });
  const stride = man.gaits[0].stride, v = man.gaits[0].speed;
  let walkT = 0;
  h.walk(walkT, v / 1.4, 0, v);
  const p0 = h.state.phase;
  // half a stride of ground in small steps
  for (let i = 0; i < 50; i++) { walkT += (stride / 2 / 50) * 1.6; h.walk(walkT, v / 1.4, 0, v); }
  near(((h.state.phase - p0) % 1 + 1) % 1, 0.5, 0.01, 'half a stride is half a cycle');
  assert.equal(h.state.kind, 'move');
  // …and at that point the feet have swapped: the right one leads
  for (let i = 0; i < 40; i++) h.pose();           // let the cross-fade from standing run out
  const end = Date.now() + 400; while (Date.now() < end) h.pose();
  const l = joint(h, 'footL'), r = joint(h, 'footR');
  assert.ok(Math.abs(l.z - r.z) > 0.25, `feet apart mid stride: ${l.z} ${r.z}`);
  h.dispose();
});

test('a joint the game moves is the game\'s, the rest stays with the clip', () => {
  const h = makeHuman(man, {}, { seed: 0, near: true });
  const wait = () => { const end = Date.now() + 350; while (Date.now() < end) h.pose(); };
  h.standPose(); wait();
  const kneeBefore = joint(h, 'lowerLegL').clone(), handBefore = joint(h, 'handR').clone();
  // a hand out to a door handle: the game's reach pose over the standing base
  blend(h.parts, { arx: 1.4, er: 0.2 }, 1);
  wait();
  const sh = joint(h, 'upperArmR'), ha = joint(h, 'handR');
  assert.ok(ha.z < sh.z - 0.4, `the right hand went forward: ${ha.z} vs ${sh.z}`);
  assert.ok(ha.y > handBefore.y + 0.3, 'and up');
  near(joint(h, 'lowerLegL').distanceTo(kneeBefore), 0, 0.01, 'the legs did not notice');
  // a small nudge is ADDED to the clip rather than replacing it
  h.standPose(); wait();
  const headBefore = joint(h, 'head').clone();
  h.parts.torso.rotation.x -= 0.05; wait();
  const headAfter = joint(h, 'head');
  assert.ok(headAfter.z < headBefore.z - 0.01 && headAfter.z > headBefore.z - 0.08, `a lean of 0.05 rad moves the head a few cm: ${headBefore.z - headAfter.z}`);
  // the next plain base call gives the joint back
  h.standPose(); wait();
  near(joint(h, 'handR').distanceTo(handBefore), 0, 0.02, 'back to the clip');
  h.dispose();
});

test('no recording for it: a car seat and a ragdoll are the game\'s own poses', () => {
  const h = makeHuman(man, {}, { seed: 0, near: true });
  const wait = () => { const end = Date.now() + 300; while (Date.now() < end) h.pose(); };
  h.sitPose(1, 1); wait();
  assert.equal(h.state.kind, 'proc');
  const hip = joint(h, 'upperLegL'), knee = joint(h, 'lowerLegL');
  assert.ok(knee.z < hip.z - 0.3 && Math.abs(knee.y - hip.y) < 0.12, 'thighs forward and level in the seat');
  h.sitPose(1, 0); wait();
  assert.equal(h.state.kind, 'sit');
  h.ragdollPose(); wait();
  assert.equal(h.state.kind, 'proc');
  h.dispose();
});

test('hands are sockets on the real wrist', () => {
  const h = makeHuman(woman, { height: 1.6 }, { seed: 0, near: true });
  h.group.updateMatrixWorld(true);
  h.pose();
  const w = joint(h, 'handR').multiplyScalar(1.6 / woman.height);
  const s = new THREE.Vector3().setFromMatrixPosition(h.parts.handR.matrix);
  near(s.distanceTo(w), 0, 1e-3, 'socket at the wrist, at this body\'s scale');
  near(h.headTop, 1.6, 1e-9, 'asked height');
  h.dispose();
});

test('the far rows hold the same poses the near body resolves', () => {
  const rows = bakeFar(man);
  assert.ok(rows.size >= 3, 'walk, run, idle (and sit) are baked');
  const walk = man.gaits[0].clip, e = rows.get(walk);
  assert.ok(e.frames > 10 && e.row >= 1);
  assert.equal(farRow(man, walk, 0), e.row);
  assert.equal(farRow(man, walk, walk.dur * 0.5), e.row + Math.floor(e.frames / 2));
  assert.equal(farRow(man, walk, walk.dur * 1.5), e.row + Math.floor(e.frames / 2), 'wraps');
  assert.equal(farRow(man, { name: 'unknown' }, 1), 0, 'an unbaked clip is the bind row');
  // row 0 is the bind pose: every bone's skinning matrix is identity
  const W = man.farWidth, d = man.farData;
  for (let b = 0; b < man.rig.n; b++) {
    const o = b * 3 * 4;
    near(d[o], 1, 1e-3, 'm00'); near(d[o + 5], 1, 1e-3, 'm11'); near(d[o + 10], 1, 1e-3, 'm22'); near(d[o + 3], 0, 1e-3, 'tx');
  }
  assert.equal(d.length, W * (1 + [...rows.values()].reduce((n, r) => n + r.frames, 0)) * 4);
});

test('a carrier bag and a phone hang on the hand; the busy arm is the game\'s', () => {
  const b = makeHuman(man, { prop: 'bag', propTint: 0xc8452f }, { seed: 0, near: true });
  const bagMesh = b.parts.handR.children.find((o) => o.isMesh);
  assert.ok(bagMesh, 'the bag is a mesh on the right hand socket');
  assert.equal(bagMesh.material.color.getHex(), 0xc8452f);
  assert.deepEqual(b.hold, { L: null, R: 'bag' });
  const p = makeHuman(man, { prop: 'phone' }, { seed: 0, near: true });
  const wait = (h) => { const end = Date.now() + 350; while (Date.now() < end) h.pose(); };
  p.standPose(); wait(p);
  // the phone is held up at the ear: the right hand is above the elbow
  assert.ok(joint(p, 'handR').y > joint(p, 'lowerArmR').y + 0.1, 'phone hand raised');
  assert.ok(joint(p, 'handL').y < joint(p, 'lowerArmL').y, 'the other arm hangs');
  // a pram and a dog are drawn elsewhere: nothing is added to the hand
  const d = makeHuman(man, { prop: 'dog' }, { seed: 0 });
  assert.equal(d.parts.handR.children.length, 0);
  assert.deepEqual(d.hold, { L: null, R: 'leash' });
  for (const h of [b, p, d]) h.dispose();
});

test('the save keeps a look and nothing else that claims to be one', async () => {
  const { sanitize, blank } = await import('../js/savegame.js');
  assert.equal(blank().look, '');
  assert.equal(sanitize({ look: '1-m04-m01' }).look, '1-m04-m01');
  for (const bad of ['<img>', 7, null, '1-' + 'x'.repeat(40) + '-a', { head: 'a' }]) assert.equal(sanitize({ look: bad }).look, '');
});

test('a body is born far and asks for nothing until it is drawn near', () => {
  const h = makeHuman(man, {}, { seed: 0.2 });
  assert.equal(h.state.far, true);
  const meshes = h.group.children.filter((o) => o.isMesh);
  assert.equal(meshes.find((o) => o.isSkinnedMesh).visible, false, 'the skinned body waits');
  assert.equal(meshes.find((o) => o.isInstancedMesh).visible, true, 'the baked one stands in');
  assert.equal(man.hiUsers, 0, 'no claim on the sharp texture');
  // walking far only counts the stride: the solver and the stamp are skipped
  let t = 0;
  for (let i = 0; i < 30; i++) { t += 0.05 * 1.6; h.walk(t, 1, 0, 1.35); }
  assert.equal(h.state.kind, 'move');
  assert.ok(h.state.phase !== 0.2);
  // forced near (the showroom, a test): the skinned body shows and claims its texture
  h.setLod('near');
  assert.equal(h.state.far, false);
  assert.equal(man.hiUsers, 1);
  h.dispose();
  assert.equal(man.hiUsers, 0);
  // a player or a story person is never far
  const p = makeHuman(man, {}, { seed: 0.2, near: true });
  assert.equal(p.state.far, false);
  p.dispose();
});

test('a head from one person on the body of another', async () => {
  const { partGeometry } = await import('../js/characters/avatars.js');
  // the dummies come as one piece: nothing to mix, and the request is ignored
  assert.equal(partGeometry(man, 'head'), null);
  const h = makeHuman(man, {}, { seed: 0, near: true, head: woman });
  assert.equal(h.group.children.filter((o) => o.isSkinnedMesh).length, 1);
  h.dispose();
  // a body that keeps its parts apart gives a geometry per part over the same buffers
  const fake = { geometry: man.geometry, ranges: { body: [0, 300], head: [300, 120], hair: [420, 60] } };
  const body = partGeometry(fake, 'body'), head = partGeometry(fake, 'head');
  assert.deepEqual([body.drawRange.start, body.drawRange.count], [0, 300]);
  assert.deepEqual([head.drawRange.start, head.drawRange.count], [300, 180], 'the head brings its hair');
  assert.ok(body.attributes.position === man.geometry.attributes.position, 'no copy of the vertices');
  assert.ok(partGeometry(fake, 'body') === body, 'made once');
});
