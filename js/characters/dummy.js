// ---- dummy.js: a crash-test person, for tests and the dev showroom ----------
//
// Not a character of the game. It is a human skeleton with 3ds Max Biped names,
// bound in a T pose, in centimetres, facing +z, with every bone's axes turned
// some arbitrary way: everything a downloaded model does to the code that has
// to carry the game's moves onto it. Boxes are skinned to it so the result can
// be looked at (dev/people.html?rig=dummy), and its clips are the game's own
// walk and poses recorded onto its bones, so the clip path can be compared
// with the procedural one by eye and by number.

import * as THREE from 'three';
import { bodyDims } from '../bodyshape.js';
import { buildJoints } from '../bodyjoints.js';
import { makeGait } from '../gait.js';
import { makePoses } from '../poses.js';
import { deltasFromJoints, solve, SLOT_COUNT } from './retarget.js';
import { prepareAvatar, addClipSource, setRoles, setPeopleReady } from './avatars.js';
import { setCatalog } from './cast.js';

const COL = { skin: 0xd9a066, top: 0x3f6f9a, bottom: 0x2f3540, shoe: 0x1c1b1a, hair: 0x3a2a1a };

/** A scene holding the armature and (unless bare) a skinned box figure. */
export function dummyScene({ twirl = 1.3, cm = true, female = false, bare = false, tint = COL.top, skin = COL.skin, bottom = COL.bottom } = {}) {
  const scene = new THREE.Group();
  const arm = new THREE.Group();
  arm.name = 'Armature';
  if (cm) { arm.scale.setScalar(0.01); arm.rotation.x = -Math.PI / 2; }
  scene.add(arm);
  const k = female ? 0.94 : 1;
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const bones = [], segs = [];
  // a bone at a position given in metres, model facing +z, its LEFT at +x
  const add = (name, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    (parent ?? arm).add(b);
    scene.updateMatrixWorld(true);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * twirl, rnd() * twirl, rnd() * twirl));
    const pw = b.parent.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(pw.invert().multiply(q));
    b.position.copy(b.parent.worldToLocal(new THREE.Vector3(x * k, y * k, z * k)));
    b.userData.at = new THREE.Vector3(x * k, y * k, z * k);
    bones.push(b);
    return b;
  };
  const seg = (a, b, r, col, rz = r) => segs.push({ a, b, r: r * k, rz: rz * k, col });
  const root = add('Bip01', null, 0, 0, 0);
  const hips = add('Bip01 Pelvis', root, 0, 0.95, 0);
  const sp = add('Bip01 Spine', hips, 0, 1.04, 0);
  const sp1 = add('Bip01 Spine1', sp, 0, 1.17, 0);
  const sp2 = add('Bip01 Spine2', sp1, 0, 1.30, 0);
  const neck = add('Bip01 Neck', sp2, 0, 1.49, 0);
  const head = add('Bip01 Head', neck, 0, 1.56, 0);
  const top = add('Bip01 HeadNub', head, 0, 1.78, 0);
  seg(hips, sp, 0.15, bottom, 0.10); seg(sp, sp1, 0.14, tint, 0.10); seg(sp1, sp2, 0.16, tint, 0.11);
  seg(sp2, neck, 0.17, tint, 0.10); seg(neck, head, 0.05, skin); seg(head, top, 0.085, skin, 0.10);
  for (const [sd, sx] of [['L', 1], ['R', -1]]) {
    const cl = add(`Bip01 ${sd} Clavicle`, sp2, sx * 0.03, 1.44, 0);
    const ua = add(`Bip01 ${sd} UpperArm`, cl, sx * 0.19, 1.44, 0);
    const la = add(`Bip01 ${sd} Forearm`, ua, sx * 0.49, 1.44, 0);
    const ha = add(`Bip01 ${sd} Hand`, la, sx * 0.75, 1.44, 0);
    const fi = add(`Bip01 ${sd} Finger0`, ha, sx * 0.92, 1.44, 0);
    seg(ua, la, 0.045, tint); seg(la, ha, 0.038, skin); seg(ha, fi, 0.035, skin, 0.015);
    const ul = add(`Bip01 ${sd} Thigh`, hips, sx * 0.09, 0.92, 0);
    const ll = add(`Bip01 ${sd} Calf`, ul, sx * 0.09, 0.50, 0);
    const ft = add(`Bip01 ${sd} Foot`, ll, sx * 0.09, 0.085, 0);
    const toe = add(`Bip01 ${sd} Toe0`, ft, sx * 0.09, 0.02, 0.15);
    seg(ul, ll, 0.07, bottom); seg(ll, ft, 0.05, bottom); seg(ft, toe, 0.045, COL.shoe, 0.035);
  }
  scene.updateMatrixWorld(true);
  if (bare) return { scene, bones, mesh: null };
  // one box per segment, skinned rigidly to the segment's first bone. Built in
  // world metres, then taken into the armature's own space (centimetres, z up)
  // because that is where a file's vertices live.
  const P = [], N = [], C = [], I = [], W = [], idx = [];
  const col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), v = new THREE.Vector3();
  const armInv = arm.getWorldQuaternion(new THREE.Quaternion()).invert();
  for (const sgm of segs) {
    const a = sgm.a.userData.at, b = sgm.b.userData.at, len = a.distanceTo(b);
    const box = new THREE.BoxGeometry(sgm.r * 2, len, sgm.rz * 2).toNonIndexed();
    q.setFromUnitVectors(up, v.copy(b).sub(a).normalize());
    box.applyQuaternion(q).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    const base = P.length / 3, pa = box.attributes.position, na = box.attributes.normal;
    col.setHex(sgm.col);
    for (let i = 0; i < pa.count; i++) {
      arm.worldToLocal(v.fromBufferAttribute(pa, i)); P.push(v.x, v.y, v.z);
      v.fromBufferAttribute(na, i).applyQuaternion(armInv); N.push(v.x, v.y, v.z);
      C.push(col.r, col.g, col.b); I.push(bones.indexOf(sgm.a), 0, 0, 0); W.push(1, 0, 0, 0);
      idx.push(base + i);
    }
    box.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(I, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(W, 4));
  g.setIndex(idx);
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  arm.add(mesh);
  scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return { scene, bones, mesh };
}

/** Record the game's own moves onto an avatar's bones as clips (walk, run, idle, sit). */
export function recordClips(av, fps = 30) {
  const D = bodyDims('m30', av.height), dm = av.rig.dims;
  Object.assign(D, { hipY: dm.hipY, hipX: dm.hipX, thigh: dm.thigh, shin: dm.shin, ankleY: dm.ankleY, spineY: dm.spineY,
    shoulderY: dm.shoulderY, shoulderX: dm.shoulderX, upper: dm.upper, fore: dm.fore });
  const group = new THREE.Group(), body = new THREE.Group();
  group.add(body);
  const { J } = buildJoints(D, group, body);
  const gait = makeGait(J, D, { unit: 1.4, seed: 0 });
  const P = makePoses(J, { stoop: 0, hunch: 0, headUp: 0, reset: gait.reset });
  const delta = new Float32Array(SLOT_COUNT * 4), has = new Uint8Array(SLOT_COUNT), out = new Float32Array(av.rig.n * 4);
  const hb = av.rig.bones[av.rig.hips], rest = hb.position.clone();
  const make = (name, dur, pose, travel = 0) => {
    const frames = Math.round(dur * fps), times = [], tracks = av.rig.bones.map(() => []), hip = [];
    for (let f = 0; f <= frames; f++) {
      pose(f / frames);
      deltasFromJoints(J, delta, has);
      solve(av.rig, delta, has, out);
      times.push((f / frames) * dur);
      for (let i = 0; i < av.rig.n; i++) tracks[i].push(out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]);
      const off = new THREE.Vector3(body.position.x, body.position.y, body.position.z - travel * (f / frames));
      hip.push(...rest.clone().add(off.applyQuaternion(av.rig.hipInv).divideScalar(av.rig.topS)).toArray());
    }
    const tr = av.rig.bones.map((b, i) => new THREE.QuaternionKeyframeTrack(b.name + '.quaternion', times, tracks[i]));
    tr.push(new THREE.VectorKeyframeTrack(hb.name + '.position', times, hip));
    return new THREE.AnimationClip(name, dur, tr);
  };
  // the gait is driven by distance: one cycle of the stride it takes at speed v
  const cycle = (name, v) => {
    gait.reset();
    gait.walk(0, v / 1.4, 0, v);
    // find the stride by walking until the phase wraps
    let dist = 0, last = gait.state.phase, stride = 0;
    for (let i = 0; i < 4000 && !stride; i++) { dist += 0.004; gait.walk(dist * 1.6, v / 1.4, 0, v); if (gait.state.phase < last) stride = dist; last = gait.state.phase; }
    const start = dist;
    return make(name, stride / v, (u) => gait.walk((start + u * stride) * 1.6, v / 1.4, 0, v), stride);
  };
  const clips = [cycle('walk', 1.35), cycle('run', 4.6)];
  clips.push(make('idle', 2, (u) => { P.standPose(); J.head.rotation.y = 0.25 * Math.sin(u * Math.PI * 2); J.armL.rotation.z = -0.12; J.armR.rotation.z = 0.12; }));
  clips.push(make('sit', 2, (u) => { P.sitPose(1, 0); J.head.rotation.x = 0.06 * Math.sin(u * Math.PI * 2); }));
  P.standPose();
  return clips;
}

/**
 * Register dummies and their clips: what a manifest load does for real people.
 * `many` gives the character creator something to choose between: both
 * sexes, three skin tones, three styles of "clothes" (colours).
 */
export function installDummies({ many = false } = {}) {
  const out = [], cat = [];
  const SKINS = [0xf0c8a0, 0xc78d5a, 0x7a5236];
  const STYLES = { casual: [0x3f6f9a, 0x8a3d4f, 0x4f7a4a], smart: [0x23262e, 0x4a4d57], sport: [0xd0652a, 0x1f7a78] };
  const one = (id, female, tint, tone, style, bottom) => {
    const d = dummyScene({ female, tint, skin: SKINS[tone], bottom });
    out.push(prepareAvatar({ id, sex: female ? 'f' : 'm', family: 'dummy', scene: d.scene, mesh: d.mesh, material: d.mesh.material,
      meta: { top: tint, bottom, skin: SKINS[tone], hair: COL.hair } }));
    cat.push({ id, sex: female ? 'f' : 'm', kind: 'adult', age: 'adult', tone, style, skin: SKINS[tone], top: tint, bottom });
  };
  if (!many) { one('dummy-m', false, 0x3f6f9a, 0, 'casual', COL.bottom); one('dummy-f', true, 0x9a3f6f, 0, 'casual', COL.bottom); } else {
    for (const female of [false, true]) for (let tone = 0; tone < 3; tone++) {
      let i = 0;
      for (const style in STYLES) for (const tint of STYLES[style])
        one(`${female ? 'f' : 'm'}${tone}${String.fromCharCode(97 + i++)}`, female, tint, tone, style, style === 'smart' ? 0x1d1f23 : style === 'sport' ? 0x26303f : COL.bottom);
    }
  }
  const src = dummyScene({ bare: true });
  addClipSource({ family: 'dummy', scene: src.scene, clips: recordClips(out[0]) });
  setRoles({ walk: 'walk', run: 'run', idle: 'idle', sit: 'sit' }, { idle: { ground: true }, sit: { ground: false } });
  setCatalog(cat);
  setPeopleReady(true);
  return out;
}
