// ---- the people bank's clip file, and a skeleton whose root is not a bone ----
// Rocketbox clips move the Biped's ROOT, which the exporter writes as the
// armature node above the bones; a person's own file has that node standing
// still. These tests build such a clip file by hand (the format of
// scripts/people/bake-clips.mjs) and play it on a body.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { dummyScene } = await import('../js/characters/dummy.js');
const AV = await import('../js/characters/avatars.js');
const { readClipFile } = await import('../js/characters/rawclips.js');
const { figureMatrices } = await import('../js/characters/skinpose.js');
const { SLOT } = await import('../js/characters/skeletonmap.js');
const { makeHuman } = await import('../js/characters/human.js');

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

// write a clip file: `nodes` are Object3Ds (parents first), `clips` are
// [{ name, fps, rot: (node, k) => Quaternion | null, pos: Map(node -> (k) => Vector3) , keys }]
function encode(nodes, clips, still = () => false) {
  const names = nodes.map((o) => o.name), n = nodes.length;
  const rig = { names, parent: nodes.map((o) => nodes.indexOf(o.parent)), restQ: nodes.flatMap((o) => o.quaternion.toArray()),
    restP: nodes.flatMap((o) => o.position.toArray()), restS: nodes.map((o) => o.scale.x) };
  rig.move = names.map((nm, i) => (still(nm) ? -1 : i)).filter((i) => i >= 0);
  const parts = [], head = [];
  let at = 0;
  const push = (t) => { const b = new Uint8Array(t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength)); const o = at; parts.push(b); at += b.length; while (at % 4) { parts.push(new Uint8Array(1)); at++; } return o; };
  for (const c of clips) {
    const m = rig.move.length, q = new Int16Array(c.keys * m * 4), hold = new Int16Array(n * 4);
    nodes.forEach((o, i) => {
      const slot = rig.move.indexOf(i);
      for (let k = 0; k < (slot < 0 ? 1 : c.keys); k++) {
        const a = (c.rot(o, k) ?? o.quaternion).toArray();
        if (k === 0) for (let x = 0; x < 4; x++) hold[i * 4 + x] = Math.round(a[x] * 32767);
        if (slot >= 0) for (let x = 0; x < 4; x++) q[(k * m + slot) * 4 + x] = Math.round(a[x] * 32767);
      }
    });
    const pos = [];
    for (const [o, f] of c.pos ?? []) {
      const p = new Float32Array(c.keys * 3);
      for (let k = 0; k < c.keys; k++) f(k).toArray(p, k * 3);
      pos.push([nodes.indexOf(o), push(p)]);
    }
    head.push({ name: c.name, fps: c.fps, keys: c.keys, q: push(q), hold: push(hold), pos });
  }
  let json = JSON.stringify({ v: 1, family: 'dummy', faces: '+z', rig, clips: head });
  while (json.length % 4) json += ' ';
  const hb = new TextEncoder().encode(json), out = new Uint8Array(4 + hb.length + at);
  new DataView(out.buffer).setUint32(0, hb.length, true);
  out.set(hb, 4);
  let o = 4 + hb.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

test('a clip file round-trips, and its root above the bones turns and carries the body', () => {
  AV.clearPeople();
  const d = dummyScene({});
  const man = AV.prepareAvatar({ id: 'm', sex: 'm', family: 'dummy', scene: d.scene, mesh: d.mesh, material: d.mesh.material });
  // the clip's own skeleton: the same bones under an armature node that is ANIMATED
  const s = dummyScene({ bare: true });
  const arm = s.scene.children[0];
  arm.name = 'Root';
  const nodes = [arm];
  arm.traverse((o) => { if (o !== arm) nodes.push(o); });
  const armQ = arm.quaternion.clone(), armP = arm.position.clone();
  const yaw = (k) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (k / 30) * Math.PI / 2);
  const thigh = nodes.find((o) => o.name === 'Bip01 L Thigh'), thighQ = thigh.quaternion.clone();
  const swing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
  const buf = encode(nodes, [{
    name: 'turn', fps: 30, keys: 31,
    // the root turns a quarter (about the world's up) and walks 1.2 m; one thigh is held 0.5 rad off its bind
    rot: (o, k) => (o === arm ? yaw(k).multiply(armQ) : o === thigh ? thighQ.clone().multiply(swing) : null),
    pos: new Map([[arm, (k) => armP.clone().add(new THREE.Vector3(0, 0, (k / 30) * 1.2))]]),
  }], (nm) => /Finger/.test(nm));
  const file = readClipFile(buf);
  assert.equal(file.family, 'dummy');
  assert.deepEqual([...file.clips.keys()], ['turn']);
  const clip = file.clips.get('turn')();
  near(clip.duration, 1, 1e-6, 'thirty keys a second, thirty-one keys');
  assert.ok(file.clips.get('turn')() === clip, 'tracks are built once');
  // a still node (a finger) has one key, a moving one has them all
  const finger = clip.tracks.find((t) => t.name === 'Bip01 L Finger0.quaternion'), spine = clip.tracks.find((t) => t.name === 'Bip01 Spine.quaternion');
  assert.equal(finger.times.length, 1); assert.equal(spine.times.length, 31);

  AV.addClipSource({ family: file.family, scene: file.scene, clips: file.clips, faces: file.faces, moved: file.moved });
  AV.setRoles({}, { turn: { loop: false, travel: 'keep', ground: false } });
  const bk = AV.clipFor(man, 'turn');
  assert.ok(bk, 'baked');
  near(bk.travel, 1.2, 0.02, 'the root carried the hips 1.2 m');
  // the pose at the end: the hips have turned a quarter with the root, though the body's own root never moves
  const n = man.rig.n, fig = new Float32Array(n * 16);
  const at = (f) => figureMatrices(man.rig, bk.q.subarray(f * n * 4, (f + 1) * n * 4), null, man.root, fig);
  const dirOf = (a, b) => new THREE.Vector3(fig[b * 16 + 12] - fig[a * 16 + 12], fig[b * 16 + 13] - fig[a * 16 + 13], fig[b * 16 + 14] - fig[a * 16 + 14]).normalize();
  const L = man.rig.slotBone[SLOT.upperArmL], Rr = man.rig.slotBone[SLOT.upperArmR];
  at(0);
  const across0 = dirOf(L, Rr);
  near(across0.x, 1, 1e-3, 'shoulders across +x at the start');
  at(bk.frames - 1);
  const across1 = dirOf(L, Rr);
  near(Math.abs(across1.z), 1, 2e-3, 'shoulders turned a quarter at the end');
  near(across1.x, 0, 2e-3, 'no longer across x');
  // the thigh kept the angle the clip gave it, in its own parent's frame, through the turn
  at(0);
  const kn = man.rig.slotBone[SLOT.lowerLegL], th = man.rig.slotBone[SLOT.upperLegL];
  near(Math.acos(Math.min(1, -dirOf(th, kn).y)), 0.5, 0.02, 'thigh half a radian off straight down');
});

test('a body of the family with its bones listed another way round still gets the right ones', () => {
  // the first body fixes the family's bone order; a second file lists its skin's joints backwards
  const d2 = dummyScene({ female: true });
  d2.mesh.skeleton.bones.reverse();
  d2.mesh.skeleton.boneInverses.reverse();
  const si = d2.mesh.geometry.attributes.skinIndex, nb = d2.mesh.skeleton.bones.length;
  for (let i = 0; i < si.count; i++) si.setX(i, nb - 1 - si.getX(i));
  const woman = AV.prepareAvatar({ id: 'f', sex: 'f', family: 'dummy', scene: d2.scene, mesh: d2.mesh, material: d2.mesh.material });
  const man = AV.avatar('m');
  assert.deepEqual(woman.rig.names, man.rig.names, 'one order for the family');
  assert.equal(woman.kin, true);
  const a = AV.clipFor(man, 'turn'), b = AV.clipFor(woman, 'turn');
  assert.ok(a.q === b.q, 'one bake of the rotations serves both');
  near(b.travel / a.travel, 0.94, 0.01, 'the smaller body covers less ground');
  // and she stands up as a person, not as a knot: head over hips, feet under them
  const h = makeHuman(woman, {}, { seed: 0, near: true });
  const fig = figureMatrices(woman.rig, h.pose(), null, woman.root, new Float32Array(woman.rig.n * 16));
  const y = (slot) => fig[woman.rig.slotBone[SLOT[slot]] * 16 + 13];
  assert.ok(y('head') > y('chest') && y('chest') > y('hips') && y('hips') > y('lowerLegL') && y('lowerLegL') > y('footL'));
  h.dispose();
  AV.clearPeople();
});
