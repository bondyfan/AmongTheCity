// ---- human.js: a downloaded person behind the citizen's interface ----------
//
// makeHuman() returns exactly what js/citizen.js makeCitizen() returns (group,
// walk, sitPose, standPose, ragdollPose, the combat four, parts, dispose), so
// the player, the pedestrians, the police and the campaign do not know which
// kind of body they hold. What differs is inside:
//
//   * The seventeen joints the game's moves are written for still exist, as an
//     invisible DRIVER (js/bodyjoints.js). The walk solver and every fixed pose
//     write onto them as before.
//   * The surface is a modelled human on its own skeleton, kept as flat arrays
//     (js/characters/skinpose.js). Each frame the body is on screen its pose is
//     RESOLVED: a recorded clip where the game has one (walking, standing,
//     sitting on a bench), the driver's pose carried across by
//     js/characters/retarget.js where it does not (a car door, a vault, an
//     arrest), and joint by joint in between. A joint the game moved away from
//     the plain base it last asked for belongs to the game: a little movement
//     is added on top of the clip, a large one replaces it.
//   * Past FAR_OUT metres the skinned mesh gives way to a baked one
//     (js/characters/farbody.js) and nothing here runs but a phase counter.
//
// Resolving happens in onBeforeRender, so a person behind the camera costs
// nothing. The sun's shadow pass of a frame therefore sees the pose of the
// frame before: one sixtieth of a second, on a shadow.

import * as THREE from 'three';
import { bodyDims } from '../bodyshape.js';
import { buildJoints } from '../bodyjoints.js';
import { makeGait } from '../gait.js';
import { makePoses } from '../poses.js';
import { addBlob, removeBlob, blobsIn } from '../groundblob.js';
import { FAR_OUT, FAR_IN, trackBody, untrackBody } from '../peopleshadows.js';
import { holdFor } from '../pedprops.js';
import { SLOT, SLOT_COUNT } from './skeletonmap.js';
import { deltasFromJoints } from './retarget.js';
import { figureMatrices, skinMatrices, skinMatricesMapped } from './skinpose.js';
import { pickGait } from './animset.js';
import { motionSet, retainHi, releaseHi, partGeometry, roleClip } from './avatars.js';
import { makeFarBody, farRow } from './farbody.js';
import { makeResolver } from './resolve.js';
import { addHandProp } from './props.js';
import { JAW_OPEN, setMouth, startTalk, mouthLevel } from './mouth.js';
import { makeFist, applyFist } from './fist.js';
import { ACT_LINGER } from './actlayer.js';

const TAU = Math.PI * 2;
const _pg = {};
const _jq = new THREE.Quaternion(), _ja = new THREE.Quaternion(), _jv = new THREE.Vector3();
let _dummy = null;      // bones and inverses three's Skeleton wants to hold; never read

function skeletonFor(av) {
  if (!_dummy || _dummy.bones.length < av.rig.n) {
    const bones = [], inv = [];
    for (let i = 0; i < Math.max(96, av.rig.n); i++) { bones.push(new THREE.Bone()); inv.push(new THREE.Matrix4()); }
    _dummy = { bones, inv };
  }
  const sk = new THREE.Skeleton(_dummy.bones.slice(0, av.rig.n), _dummy.inv.slice(0, av.rig.n));
  sk.update = () => {};           // the matrices are written by resolve(), below
  return sk;
}

/**
 * av     an avatar (js/characters/avatars.js)
 * look   what makeCitizen takes: { archetype, uid, role, prop, propTint, height }
 * opts   { near: true } keeps the skinned mesh at any distance (the player,
 *        campaign people: their joints are posed by hand from far away too)
 *        { calm: true } stands without fidgets (a portrait in the creator)
 *        { head: avatar } wears another person's head (and hair) on this
 *        body: the character creator's choice. Such a body is always near.
 */
export function makeHuman(av, look = {}, { near = false, seed = Math.random(), unit = 1.4, head = null, calm = false, sharp: wantSharp = true } = {}) {
  motionSet(av);
  const H = look.height ?? av.height;
  const s = H / av.height;                       // this body against the modelled one
  // ---- the driver: the game's joints, sized off this skeleton ----
  const d = av.rig.dims;
  const D = bodyDims(av.sex === 'f' ? 'f30' : 'm30', H);
  D.s = { ...D.s, stoop: 0, hunch: 0, headUp: 0, crouch: 0 };
  Object.assign(D, { hipY: d.hipY * s, hipX: d.hipX * s, thigh: d.thigh * s, shin: d.shin * s, ankleY: d.ankleY * s,
    spineY: d.spineY * s, shoulderY: d.shoulderY * s, shoulderX: d.shoulderX * s, upper: d.upper * s, fore: d.fore * s,
    shoulderTopY: (d.neckY || d.shoulderY) * s });
  D.kneeY = D.hipY - D.thigh; D.elbowY = D.shoulderY - D.upper; D.wristY = D.elbowY - D.fore;
  const group = new THREE.Group(), body = new THREE.Group();
  group.add(body);
  body.visible = false;                           // joints only: nothing to draw, nothing to traverse
  const { J, collarL, collarR } = buildJoints(D, group, body);
  collarL.rotation.z = -0.06; collarR.rotation.z = 0.06;
  const prop = look.prop ?? null, hold = holdFor(prop, false);
  const gait = makeGait(J, D, { unit, seed, cane: false, carry: null, hold });
  const P = makePoses(J, { stoop: 0, hunch: 0, headUp: 0, reset: gait.reset });

  // ---- the surface ----
  const n = av.rig.n;
  // somebody else's head: this body without its own, and theirs on its bones
  const hg = head && head !== av ? partGeometry(head, 'head') : null, bg = hg ? partGeometry(av, 'body') : null;
  const mixed = !!(hg && bg);
  if (mixed) near = true;
  const mesh = new THREE.SkinnedMesh(mixed ? bg : av.geometry, av.material);
  const skeleton = skeletonFor(av);
  mesh.bindMode = 'detached';
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.scale.setScalar(s);
  mesh.castShadow = true;
  mesh.renderOrder = 1;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, d.hipY, 0), 1.35 * av.height / 1.78);
  mesh.userData.far = false; mesh.userData.force = null; mesh.userData.shNear = true;
  group.add(mesh);
  trackBody(mesh);
  const shade = addBlob(group, mesh);
  // hands and head as the game knows them: a pistol, a lead, a phone hang here
  const socket = () => { const o = new THREE.Object3D(); o.matrixAutoUpdate = false; group.add(o); return o; };
  const handL = socket(), handR = socket();
  const carried = addHandProp(handR, prop, look.propTint, H / 1.78);
  const headS = socket();                        // what is worn on the head follows the drawn skull (js/heist-mask.js)

  let headMesh = null, headSk = null, headMap = null;
  if (mixed) {
    headSk = skeletonFor(head);
    headMesh = new THREE.SkinnedMesh(hg, head.material);
    headMesh.bindMode = 'detached';
    headMesh.bind(headSk, new THREE.Matrix4());
    headMesh.scale.setScalar(s);
    headMesh.castShadow = true; headMesh.renderOrder = 1;
    headMesh.boundingSphere = mesh.boundingSphere;
    group.add(headMesh);
    // their bones by name on ours (one family: the names are the same)
    headMap = head.rig.names.map((nm) => av.rig.names.indexOf(nm));
    if (wantSharp) retainHi(head);
  }

  const st = { calm, kind: 'idle', phase: seed, lastT: NaN, v: 0, sitK: 1, moveK: 0, far: false, frame: -1, t: 0, seed: (seed * 1e6) | 0,
    act: null, actOn: false, fistW: 0, fistAt: 0 };
  // a one-off recording by role, looked up once per role for this body
  const acts = new Map();
  const actClip = (role) => { if (!acts.has(role)) acts.set(role, roleClip(av, role)); return acts.get(role); };
  const R = makeResolver(av, J, st, hold);
  const fig = new Float32Array(n * 16);
  let farB = null;

  let lastNow = 0;
  const resolve = (frame) => {
    if (st.frame === frame) return;
    st.frame = frame;
    const hip = R.resolve(s);
    // the jaw, over whatever the body is doing: open as far as the voice is loud
    if (av.jaw >= 0) {
      const now = performance.now() * 0.001, dt = Math.min(0.1, Math.max(0, now - lastNow));
      lastNow = now;
      const open = mouthLevel(st, now, dt);
      if (open > 0) {
        _jq.fromArray(R.cur, av.jaw * 4).multiply(_ja.setFromAxisAngle(_jv.fromArray(av.jawAxis), -JAW_OPEN * open));
        _jq.toArray(R.cur, av.jaw * 4);
      }
    }
    // the fingers close over whatever pose that was (a punch, a guard)
    if (st.fistW > 0 && performance.now() * 0.001 - st.fistAt < ACT_LINGER) applyFist(av.fist ??= makeFist(av.rig), R.cur, st.fistW);
    figureMatrices(av.rig, R.cur, hip, av.root, fig);
    skinMatrices(fig, av.inv, n, skeleton.boneMatrices);
    if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
    if (headSk) {
      skinMatricesMapped(fig, head.inv, head.rig.n, headMap, headSk.boneMatrices);
      if (headSk.boneTexture) headSk.boneTexture.needsUpdate = true;
    }
    R.socket(fig, SLOT.handL, s, handL); R.socket(fig, SLOT.handR, s, handR);
    R.socket(fig, SLOT.head, s, headS);
  };

  // this body's claim on the person's sharp texture, held while it is drawn near
  let sharp = false;
  const claim = (on) => { if (!wantSharp || on === sharp) return; sharp = on; if (on) retainHi(av); else releaseHi(av); };
  const setFar = (far) => {
    if (far === st.far) return;
    st.far = far;
    claim(!far);
    if (far && !farB) { farB = makeFarBody(av); farB.mesh.scale.setScalar(s); farB.mesh.onBeforeRender = farBefore; group.add(farB.mesh); }
    mesh.visible = !far;
    if (carried) carried.visible = !far;       // nobody sees a phone at sixty metres
    if (farB) farB.mesh.visible = far;
    mesh.userData.far = far;
    if (far) mesh.castShadow = false;
    else R.cut();                                // no cross-fade out of a pose nobody was computing
  };
  const dist2 = (o, camera) => {
    const e = o.matrixWorld.elements, c = camera.matrixWorld.elements;
    const dx = e[12] - c[12], dy = e[13] - c[13], dz = e[14] - c[14];
    return dx * dx + dy * dy + dz * dz;
  };
  const wantFar = (o, camera) => {
    const f = mesh.userData.force;
    if (f != null) return f;
    if (near || !R.canFar()) return false;
    const lim = st.far ? FAR_IN : FAR_OUT;
    return dist2(o, camera) > lim * lim;
  };
  mesh.onBeforeRender = function (renderer, scene, camera) {
    if (scene.isScene) blobsIn(scene);
    resolve(renderer.info.render.frame);
    if (wantFar(this, camera)) setFar(true);
  };
  function farBefore(renderer, scene, camera) {
    if (scene.isScene) blobsIn(scene);
    if (!wantFar(this, camera)) { setFar(false); return; }
    // one recorded clip, no blending: the nearest gait, or standing, or sitting
    const now = performance.now() * 0.001;
    let clip = null, t = 0;
    if (st.kind === 'move') {
      const g = pickGait(av.gaits, st.v, s, _pg);
      const pick = g.b && g.w > 0.5 ? g.b : g.a;
      if (pick) { clip = pick.clip; t = st.phase * clip.dur; }
    } else if (st.kind === 'sit') { clip = R.sitClip(); t = now + st.seed; } else { clip = av.idles[0] ?? null; t = now + st.seed; }
    farB.setRow(clip ? farRow(av, clip, t) : 0);
  }

  // ---- what the owner calls ----
  // walkT is the owner's stride phase (1.6 radians a metre); the clip's own
  // cycle advances with the DISTANCE that phase covered, over the stride the
  // recorded gait takes at this speed.
  const walk = (walkT, speedK, runK = 0, mps) => {
    const scale = group.scale.x || 1;
    let v = (mps != null ? mps : speedK * unit) / scale;
    if (!(v > 0)) v = 0;
    let dT = Number.isFinite(st.lastT) && Number.isFinite(walkT) ? walkT - st.lastT : 0;
    if (Number.isFinite(walkT)) st.lastT = walkT;
    if (dT > Math.PI || dT < -Math.PI) dT = Math.atan2(Math.sin(dT), Math.cos(dT));
    const dist = Math.abs(dT) / 1.6 / scale;
    const g = pickGait(av.gaits, Math.max(v, runK > 0.5 ? 3.2 : 0), s, _pg);
    st.phase = (st.phase + dist / g.stride) % 1;
    st.v = v;
    const moving = v > 0.12 && speedK > 0.01;
    if (!st.far) { gait.walk(walkT, speedK, runK, mps); P.stamp(); st.moveK = gait.state.move; } else st.moveK = moving ? 1 : 0;
    R.base(moving || st.moveK > 0.5 ? 'move' : 'idle');
  };
  const standPose = () => { P.standPose(); if (hold) { gait.hold(); P.stamp(); } st.lastT = NaN; R.base('idle'); };
  const sitPose = (kk = 1, car = 1) => {
    P.sitPose(kk, car);
    if (prop === 'phone' && hold && car < 0.5) { gait.hold(); P.stamp(); }
    st.sitK = kk; st.lastT = NaN;
    // a car seat is the game's own pose (the wheel, the pedals); a bench has a recording
    R.base(car >= 0.5 ? 'proc' : 'sit');
  };
  const ragdollPose = () => { P.ragdollPose(); st.lastT = NaN; R.base('proc'); };
  standPose();
  // A body begins FAR unless it is one that never is: most people are born out
  // of sight, and a far body asks for no sharp texture and no pose. The first
  // frame it is drawn within reach it turns near, as any far body does.
  if (near) claim(true); else setFar(true);

  const dispose = () => {
    group.parent?.remove(group);
    untrackBody(mesh);
    removeBlob(shade);
    claim(false);
    if (headSk) { headSk.dispose(); if (wantSharp) releaseHi(head); }
    skeleton.dispose();
    farB?.dispose();
    body.clear(); group.clear();
  };
  const m = av.meta ?? {};
  const kHead = av.height / 1.78;
  return {
    group, walk, sitPose, ragdollPose, standPose, dispose,
    punchPose: P.punchPose, kickPose: P.kickPose, aimPose: P.aimPose, handsPose: P.handsPose,
    look: { jacket: look.jacket ?? m.top ?? 0x4a5560, pants: look.pants ?? m.bottom ?? 0x2f3540, skin: m.skin ?? 0xd9a066, hair: m.hair ?? 0x3a2a1a },
    outfit: { arch: look.archetype ?? null, role: look.role ?? null, prop, propTint: look.propTint ?? null, avatar: av.id, fem: av.sex === 'f' },
    prop, hold, arch: { key: look.archetype ?? (av.sex === 'f' ? 'f30' : 'm30'), sex: av.sex, h: H },
    headTop: H, avatar: av, headAvatar: head && head !== av ? head : av, human: true,
    // where the eyes and the lips are, in the head joint's own frame: the
    // campaign aims a camera at them (js/prologue-actor.js). The face itself
    // is the model's texture; nothing is drawn from these.
    eye: { x: 0.031 * s * kHead, y: (av.height - 0.118 * kHead) * s - J.head.position.y - J.chest.position.y - J.torso.position.y,
      z: -0.088 * s * kHead, lipY: (av.height - 0.185 * kHead) * s - J.head.position.y - J.chest.position.y - J.torso.position.y,
      surface: () => -0.088 * s * kHead },
    setLod(v) { mesh.userData.force = v === 'far' ? true : v === 'near' ? false : null; if (v) setFar(v === 'far'); },
    /** How open the mouth is, 0..1, for the next fifth of a second (the campaign calls it every frame). */
    mouth(level) { setMouth(st, level, performance.now() * 0.001); },
    /** Says something for this many seconds: the jaw works, and a body standing still gestures. */
    talk(seconds) { startTalk(st, seconds, performance.now() * 0.001); },
    /**
     * Lay a one-off recording over this body for the next frame drawn: the
     * clip of `role` (js/characters/avatars.js roles: fightJab, hitHead,
     * fallDown...) at `t` seconds, `w` of it (0..1), over the 'upper' body or
     * the 'full' one. Call it every step it should show; it lets go a quarter
     * second after the last call, unless `hold` keeps it (a body laid out
     * where it fell). `mask` may also be a number: the legs' share, 0..1.
     * Returns the clip's length in seconds, or 0 when this body has no such
     * recording (nothing is drawn then).
     */
    act(role, t, w = 1, mask = 'upper', fade = 0.08, hold = false) {
      const c = actClip(role);
      if (!c) return 0;
      const a = st.act ??= { clip: null, t: 0, w: 0, mask: 'upper', at: 0, fade: 0.08, hold: false };
      a.clip = c; a.t = t; a.w = w; a.mask = mask; a.fade = fade; a.hold = !!hold; a.at = performance.now() * 0.001;
      return c.dur;
    },
    /** Let go of the one-off recording at once (a body thrown by a car). */
    actStop() { if (st.act) { st.act.w = 0; st.act.hold = false; } st.fistW = 0; },
    /** The length of a role's recording on this body, in seconds (0: none). */
    actDur(role) { return actClip(role)?.dur ?? 0; },
    /** The travel a role's recording makes, figure metres { x, z } (+z backwards), or null. */
    actTravel(role) { const c = actClip(role); return c ? { x: c.tx ?? 0, z: c.tz ?? 0 } : null; },
    /** Close the hands, 0 open .. 1 a fist, for the next quarter second. */
    fist(w) { st.fistW = w; st.fistAt = performance.now() * 0.001; },
    /** What the body is playing right now: 'idle', 'move', 'sit', 'talk', a fidget's name, or 'proc'. */
    get clipKey() { return R.key; },
    /** Resolve now (tests, a still frame taken outside the render loop). */
    pose(frame = st.frame + 1) { resolve(frame); return R.cur; },
    state: st, tris: av.tris,
    parts: { body, torso: J.torso, chest: J.chest, head: J.head, pelvis: J.pelvis, cluster: mesh,
      armL: J.armL, armR: J.armR, legL: J.legL, legR: J.legR, elbowL: J.elbowL, elbowR: J.elbowR,
      kneeL: J.kneeL, kneeR: J.kneeR, footL: J.footL, footR: J.footR, handL, handR, headS },
  };
}

export { SLOT_COUNT, TAU };
