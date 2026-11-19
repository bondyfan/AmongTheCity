// ---- js/characters: bone names and the retarget bridge ----------------------
// Synthetic skeletons only: no downloaded model is needed to prove that a pose
// written for the game's seventeen joints lands on a rig bound in a T pose
// with bone axes of somebody else's choosing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { mapBones, missing, parseBoneName, SLOT } = await import('../js/characters/skeletonmap.js');
const R = await import('../js/characters/retarget.js');

const FAMILIES = {
  unreal: { hips: 'pelvis', spine: 'spine_01', mid: 'spine_02', chest: 'spine_03', neck: 'neck_01', head: 'Head',
    clavicle: 'clavicle_', upperArm: 'upperarm_', lowerArm: 'lowerarm_', hand: 'hand_', upperLeg: 'thigh_',
    lowerLeg: 'calf_', foot: 'foot_', toes: 'ball_', side: (n, s) => n + s.toLowerCase(), twist: 'upperarm_twist_01_' },
  mixamo: { hips: 'mixamorigHips', spine: 'mixamorigSpine', mid: 'mixamorigSpine1', chest: 'mixamorigSpine2',
    neck: 'mixamorigNeck', head: 'mixamorigHead', clavicle: 'Shoulder', upperArm: 'Arm', lowerArm: 'ForeArm',
    hand: 'Hand', upperLeg: 'UpLeg', lowerLeg: 'Leg', foot: 'Foot', toes: 'ToeBase',
    side: (n, s) => 'mixamorig' + (s === 'L' ? 'Left' : 'Right') + n },
  biped: { hips: 'Bip01 Pelvis', spine: 'Bip01 Spine', mid: 'Bip01 Spine1', chest: 'Bip01 Spine2', neck: 'Bip01 Neck',
    head: 'Bip01 Head', clavicle: 'Clavicle', upperArm: 'UpperArm', lowerArm: 'Forearm', hand: 'Hand',
    upperLeg: 'Thigh', lowerLeg: 'Calf', foot: 'Foot', toes: 'Toe0', side: (n, s) => 'Bip01 ' + s + ' ' + n },
};

// A standing figure facing -z. `arm` is the bind angle of the arms below
// horizontal (0 = T pose). `twirl` gives every bone an arbitrary bind
// orientation, the way exporters do.
function makeRig(family, { arm = 0, twirl = 0, yaw = 0, scale = 1 } = {}) {
  const F = FAMILIES[family];
  const frame = new THREE.Group();
  const root = new THREE.Group();
  root.rotation.y = yaw; root.scale.setScalar(scale);
  frame.add(root);
  const bones = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  // place a bone at a FIGURE-space position with an arbitrary world rotation
  const add = (name, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    (parent ?? root).add(b);
    frame.updateMatrixWorld(true);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * twirl, rnd() * twirl, rnd() * twirl));
    const pw = new THREE.Quaternion();
    b.parent.getWorldQuaternion(pw);
    b.quaternion.copy(pw.invert().multiply(q));
    b.position.copy(b.parent.worldToLocal(new THREE.Vector3(x, y, z)));
    bones.push(b);
    return b;
  };
  const hips = add(F.hips, null, 0, 0.95, 0);
  const sp = add(F.spine, hips, 0, 1.05, 0);
  const mid = add(F.mid, sp, 0, 1.15, 0);
  const chest = add(F.chest, mid, 0, 1.25, 0);
  const neck = add(F.neck, chest, 0, 1.5, 0);
  add(F.head, neck, 0, 1.6, 0);
  const c = Math.cos(arm), s = Math.sin(arm);
  for (const [sd, sx] of [['L', -1], ['R', 1]]) {
    const cl = add(F.side(F.clavicle, sd), chest, sx * 0.03, 1.45, 0);
    const ua = add(F.side(F.upperArm, sd), cl, sx * 0.18, 1.45, 0);
    if (F.twist) add(F.twist + sd.toLowerCase(), ua, sx * (0.18 + 0.15 * c), 1.45 - 0.15 * s, 0);
    const la = add(F.side(F.lowerArm, sd), ua, sx * (0.18 + 0.3 * c), 1.45 - 0.3 * s, 0);
    add(F.side(F.hand, sd), la, sx * (0.18 + 0.56 * c), 1.45 - 0.56 * s, 0);
    const ul = add(F.side(F.upperLeg, sd), hips, sx * 0.09, 0.92, 0);
    const ll = add(F.side(F.lowerLeg, sd), ul, sx * 0.1, 0.5, 0);
    const ft = add(F.side(F.foot, sd), ll, sx * 0.1, 0.08, 0);
    add(F.side(F.toes, sd), ft, sx * 0.1, 0.02, -0.14);
  }
  frame.updateMatrixWorld(true);
  return { frame, bones, rig: R.describeRig(bones, frame) };
}

// write local rotations onto the bones and read a slot's figure-space position
function apply(m, local) {
  m.rig.bones.forEach((b, i) => b.quaternion.set(local[i * 4], local[i * 4 + 1], local[i * 4 + 2], local[i * 4 + 3]));
  m.frame.updateMatrixWorld(true);
}
const at = (m, slot) => new THREE.Vector3().setFromMatrixPosition(m.rig.bones[m.rig.slotBone[SLOT[slot]]].matrixWorld);
const near = (a, b, eps = 1e-4, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b}`);

// the game's joints, bare: only what deltasFromJoints reads
function joints() {
  const o = () => new THREE.Object3D();
  const J = { body: o(), pelvis: o(), torso: o(), chest: o(), head: o() };
  for (const sd of ['L', 'R']) {
    const collar = o();
    J['arm' + sd] = o(); collar.add(J['arm' + sd]);
    for (const k of ['elbow', 'hand', 'leg', 'knee', 'foot']) J[k + sd] = o();
  }
  return J;
}
const fromJoints = (m, J) => {
  const delta = new Float32Array(R.SLOT_COUNT * 4), has = new Uint8Array(R.SLOT_COUNT);
  R.deltasFromJoints(J, delta, has);
  const out = new Float32Array(m.rig.n * 4);
  R.solve(m.rig, delta, has, out);
  apply(m, out);
};

test('bone names of three rig families land in the same slots', () => {
  for (const fam of Object.keys(FAMILIES)) {
    const m = makeRig(fam);
    assert.deepEqual(m.rig.missing, [], fam);
    for (const s of ['spine', 'neck', 'clavicleL', 'clavicleR', 'toesL', 'toesR']) assert.ok(m.rig.map[s] != null, `${fam} ${s}`);
    const F = FAMILIES[fam];
    assert.equal(m.rig.names[m.rig.map.chest], F.chest, fam);
    assert.equal(m.rig.names[m.rig.map.spine], F.spine, fam);
    assert.equal(m.rig.names[m.rig.map.upperArmL], F.side(F.upperArm, 'L'), fam);
    assert.equal(m.rig.names[m.rig.map.lowerLegR], F.side(F.lowerLeg, 'R'), fam);
  }
  assert.deepEqual(parseBoneName('mixamorig:LeftUpLeg'), { core: 'upleg', side: 'L', bare: 'upleg' });
  assert.equal(parseBoneName('Bip01 R Forearm').side, 'R');
  // a twist bone and an IK target carry the limb's name without being the limb
  const map = mapBones([{ name: 'pelvis', parent: -1 }, { name: 'ik_hand_l', parent: 0 }, { name: 'hand_l', parent: 0 },
    { name: 'lowerarm_twist_01_l', parent: 0 }, { name: 'lowerarm_l', parent: 0 }]);
  assert.equal(map.handL, 2);
  assert.equal(map.lowerArmL, 4);
  assert.ok(missing(map).includes('head'));
});

test('the standing joints hang a T-posed rig\'s arms straight down', () => {
  for (const fam of Object.keys(FAMILIES)) {
    for (const opt of [{ arm: 0, twirl: 0 }, { arm: 0, twirl: 2.5, yaw: Math.PI, scale: 0.01 }, { arm: 0.8, twirl: 1.3 }]) {
      const m = makeRig(fam, opt);
      fromJoints(m, joints());
      for (const sd of ['L', 'R']) {
        const sh = at(m, 'upperArm' + sd), el = at(m, 'lowerArm' + sd), ha = at(m, 'hand' + sd);
        near(el.x, sh.x, 1e-3, `${fam} elbow under shoulder`); near(ha.x, sh.x, 1e-3, `${fam} hand under shoulder`);
        near(sh.y - ha.y, 0.56, 1e-3, `${fam} arm length kept`);
        near(ha.z, sh.z, 1e-3);
      }
      near(m.rig.dims.thigh, 0.42, 0.01); near(m.rig.dims.upper, 0.3, 1e-3); near(m.rig.dims.hipY, 0.92, 1e-3);
    }
  }
});

test('the game\'s signs survive: arm forward, knee back, trunk and head', () => {
  const m = makeRig('mixamo', { twirl: 2, yaw: Math.PI });
  const J = joints();
  J.armR.rotation.x = Math.PI / 2;        // positive swings the lower end FORWARD (-z)
  J.kneeL.rotation.x = -Math.PI / 2;      // a knee bends negative: the shin goes back
  J.legR.rotation.x = 0.5;
  J.elbowL.rotation.x = Math.PI / 2;      // an elbow bends positive: forearm forward
  J.armL.parent.rotation.z = -0.3;        // the collar holds the left arm out to the left (-x)
  fromJoints(m, J);
  const shR = at(m, 'upperArmR'), haR = at(m, 'handR');
  near(haR.y, shR.y, 1e-3, 'right hand at shoulder height'); near(haR.z, shR.z - 0.56, 1e-3, 'right hand forward');
  const knL = at(m, 'lowerLegL'), ftL = at(m, 'footL');
  near(ftL.y, knL.y, 1e-3); assert.ok(ftL.z > knL.z + 0.4, 'left shin points back');
  assert.ok(at(m, 'lowerLegR').z < at(m, 'upperLegR').z - 0.15, 'right thigh swings forward');
  const elL = at(m, 'lowerArmL'), haL = at(m, 'handL'), shL = at(m, 'upperArmL');
  assert.ok(elL.x < shL.x - 0.05, 'left elbow out to the left');
  assert.ok(haL.z < elL.z - 0.2, 'left forearm forward');
  // a stoop is a NEGATIVE torso angle and carries the head forward
  const J2 = joints(); J2.torso.rotation.x = -0.5;
  fromJoints(m, J2);
  assert.ok(at(m, 'head').z < -0.2, 'stooped head is forward of the hips');
  near(at(m, 'footL').y, 0.08, 1e-3, 'the legs stay standing under a stoop');
  // looking left turns the face toward -x: the head's own forward axis
  const J3 = joints(); J3.head.rotation.y = 0.6;
  fromJoints(m, J3);
  const hb = m.rig.bones[m.rig.slotBone[SLOT.head]];
  const before = new THREE.Quaternion(...m.rig.worldQ.slice(m.rig.slotBone[SLOT.head] * 4, m.rig.slotBone[SLOT.head] * 4 + 4));
  const now = hb.getWorldQuaternion(new THREE.Quaternion());
  const turn = now.multiply(before.invert());
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(turn);
  near(fwd.x, -Math.sin(0.6), 1e-3, 'head yaw');
});

test('a pose crosses from one skeleton to another with its limbs where they were', () => {
  const a = makeRig('biped', { twirl: 2.2, arm: 0.7 }), b = makeRig('unreal', { twirl: 1.1, yaw: Math.PI, scale: 100 });
  const J = joints();
  J.armL.rotation.set(0.9, 0, -0.4); J.elbowL.rotation.x = 1.1; J.legR.rotation.set(0.7, 0, 0.2); J.kneeR.rotation.x = -1.2;
  J.torso.rotation.set(-0.2, 0.3, 0.05); J.head.rotation.y = -0.4; J.body.rotation.y = 0.2;
  fromJoints(a, J);
  // read A back as world rotations, turn them into deltas, solve B from those
  const localA = new Float32Array(a.rig.n * 4);
  a.rig.bones.forEach((bn, i) => bn.quaternion.toArray(localA, i * 4));
  const world = R.worldOf(a.rig, localA, new Float32Array(a.rig.n * 4));
  const delta = new Float32Array(R.SLOT_COUNT * 4), has = new Uint8Array(R.SLOT_COUNT);
  R.deltasOf(a.rig, world, delta, has);
  const out = new Float32Array(b.rig.n * 4);
  R.solve(b.rig, delta, has, out);
  apply(b, out);
  const dir = (m, p, q) => at(m, q).sub(at(m, p)).normalize();
  for (const [p, q] of [['upperArmL', 'lowerArmL'], ['lowerArmL', 'handL'], ['upperLegR', 'lowerLegR'], ['lowerLegR', 'footR'],
    ['upperArmR', 'lowerArmR'], ['chest', 'head']]) {
    const da = dir(a, p, q), db = dir(b, p, q);
    assert.ok(da.dot(db) > 0.9999, `${p} to ${q}: ${da.toArray()} vs ${db.toArray()}`);
  }
});

// ---- clips ------------------------------------------------------------------
const CB = await import('../js/characters/clipbank.js');

test('a clip baked for another skeleton swings the same limb the same way', () => {
  const a = makeRig('mixamo', { twirl: 2, arm: 0 }), b = makeRig('unreal', { twirl: 1.4, yaw: Math.PI, scale: 100, arm: 0.6 });
  // author a one second clip on A through the game's joints: the right arm
  // swings forward and back, the hips rise 5 cm and travel 2 m
  const times = [], vals = [], hipT = [], N = 20;
  const ua = a.rig.bones[a.rig.slotBone[SLOT.upperArmR]], hb = a.rig.bones[a.rig.slotBone[SLOT.hips]];
  const rest = hb.position.clone();
  for (let f = 0; f <= N; f++) {
    const J = joints();
    J.armR.rotation.x = Math.sin((f / N) * Math.PI * 2) * 0.8;
    fromJoints(a, J);
    times.push(f / N);
    vals.push(...ua.quaternion.toArray());
    const off = new THREE.Vector3(0, 0.05 * Math.sin((f / N) * Math.PI * 2), -2 * f / N);
    hipT.push(...rest.clone().add(off.applyQuaternion(a.rig.hipInv).divideScalar(a.rig.topS)).toArray());
  }
  fromJoints(a, joints());
  const clip = new THREE.AnimationClip('swing', 1, [
    new THREE.QuaternionKeyframeTrack(ua.name + '.quaternion', times, vals),
    new THREE.VectorKeyframeTrack(hb.name + '.position', times, hipT),
  ]);
  const bk = CB.bakeClip(clip, a.rig, b.rig, { fps: 30, loop: true });
  assert.equal(bk.frames, 30);
  assert.equal(CB.sameRig(a.rig, b.rig), false);
  const out = new Float32Array(b.rig.n * 4), hip = [0, 0, 0];
  for (const t of [0, 0.25, 0.5, 0.75, 1.25]) {
    CB.sampleClip(bk, t, out, hip);
    apply(b, out);
    const sh = at(b, 'upperArmR'), el = at(b, 'lowerArmR');
    const ang = Math.atan2(-(el.z - sh.z), -(el.y - sh.y));       // forward of straight down
    near(ang, Math.sin(t * Math.PI * 2) * 0.8, 0.02, `arm at ${t}`);
    // the clip does not key the left arm, so it stays as A was bound: straight out
    near(at(b, 'handL').x, at(b, 'upperArmL').x - 0.56, 1e-3, 'the unkeyed arm keeps the source bind');
    near(hip[1], 0.05 * Math.sin(t * Math.PI * 2), 0.004, 'the bounce is kept');
    near(hip[2], 0, 0.07, 'the travel is taken out');
  }
  // the same clip baked for its own skeleton is a straight copy
  const own = CB.bakeClip(clip, a.rig, a.rig, { loop: false, travel: 'keep' });
  assert.equal(CB.sameRig(a.rig, a.rig), true);
  CB.sampleClip(own, 1, out.subarray(0, a.rig.n * 4), hip);
  near(hip[2], -2, 1e-3, 'kept travel');
  // a blend half way between two poses is half way
  const p0 = CB.sampleClip(bk, 0, new Float32Array(b.rig.n * 4)), p1 = CB.sampleClip(bk, 0.25, new Float32Array(b.rig.n * 4));
  apply(b, CB.mixLocals(new Float32Array(b.rig.n * 4), p0, p1, 0.5));
  const sh = at(b, 'upperArmR'), el = at(b, 'lowerArmR');
  near(Math.atan2(-(el.z - sh.z), -(el.y - sh.y)), 0.4, 0.02, 'half blend');
  near(bk.travel, 2, 0.08, 'the baked clip knows the ground it covered');
  // grounding: a clip whose feet float 3 cm is brought down by 3 cm, once
  const before = bk.hip[1];
  const d = CB.groundClip(bk, (f) => 0.11 + 0.2 * (f % 5 === 0 ? 1 : 0), 0.08);
  near(d, -0.03, 1e-6); near(bk.hip[1], before - 0.03, 1e-6);
  // rolling a loop moves frame 7 to the front and keeps the rest in order
  const q7 = bk.q.slice(7 * bk.bones * 4, 7 * bk.bones * 4 + 4), h8 = bk.hip[8 * 3 + 1];
  CB.rollClip(bk, 7);
  near(bk.q[0], q7[0], 1e-9); near(bk.q[3], q7[3], 1e-9); near(bk.hip[1 * 3 + 1], h8, 1e-9);
});

// ---- the flat skeleton ---------------------------------------------------------
const SP = await import('../js/characters/skinpose.js');

test('the flat skeleton puts every bone where three.js would', () => {
  for (const opt of [{ twirl: 2 }, { twirl: 1.5, yaw: Math.PI, scale: 0.01, arm: 0.5 }]) {
    const m = makeRig('biped', opt);
    const J = joints();
    J.armL.rotation.set(1.1, 0, -0.5); J.elbowL.rotation.x = 0.8; J.legR.rotation.x = 0.9; J.kneeR.rotation.x = -1; J.torso.rotation.y = 0.4;
    const delta = new Float32Array(R.SLOT_COUNT * 4), has = new Uint8Array(R.SLOT_COUNT);
    R.deltasFromJoints(J, delta, has);
    const local = R.solve(m.rig, delta, has, new Float32Array(m.rig.n * 4));
    const hip = [0.07, -0.2, 0.11];
    const root = new Float32Array(m.rig.bones[0].parent.matrixWorld.elements);
    const fig = SP.figureMatrices(m.rig, local, hip, root, new Float32Array(m.rig.n * 16));
    // the same pose through the scene graph
    apply(m, local);
    const hb = m.rig.bones[m.rig.hips];
    hb.position.add(new THREE.Vector3(...hip).applyQuaternion(m.rig.hipInv).divideScalar(m.rig.topS));
    m.frame.updateMatrixWorld(true);
    for (let i = 0; i < m.rig.n; i++) {
      const e = m.rig.bones[i].matrixWorld.elements;
      for (let c = 0; c < 16; c++) near(fig[i * 16 + c], e[c], 2e-4, `bone ${m.rig.names[i]} element ${c}`);
    }
    // the hips moved by exactly the figure-space offset
    near(fig[m.rig.hips * 16 + 13], 0.95 - 0.2, 2e-4, 'hips height');
    // inverse of the rest pose times the rest pose is identity: a bound vertex stays put
    const rest = SP.figureMatrices(m.rig, m.rig.restQ, null, root, new Float32Array(m.rig.n * 16));
    const inv = SP.invertRigid(rest, m.rig.n, new Float32Array(m.rig.n * 16));
    const skin = SP.skinMatrices(rest, inv, m.rig.n, new Float32Array(m.rig.n * 16));
    for (let i = 0; i < m.rig.n; i++) for (let c = 0; c < 16; c++) near(skin[i * 16 + c], c % 5 === 0 ? 1 : 0, 1e-3, 'identity');
  }
});
