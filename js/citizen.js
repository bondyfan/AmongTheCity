// ---- Citizens: the people of Pardubice ----
//
// v3. Version 1 was eleven boxes and the owner's word for it was "Minecraft".
// Version 2 gave the boxes five silhouettes, an elbow and a knee. This version
// drops the boxes: a person is a smooth lofted body (js/bodybuild.js), a head
// with a face and shaped hair (js/bodyhead.js), dressed from a deterministic
// wardrobe (js/wardrobe.js), on a skeleton animated from the feet up
// (js/gait.js). This file is the part that holds them together: the rig, the
// pose entry points every other module calls, and the lifecycle.
//
// ONE DRAW CALL PER PERSON. The whole figure is a single SkinnedMesh with
// vertex colours and one material shared by everybody in the world:
//
//                         v2 boxes        v3
//   draw calls / person     13 (14)        1      (the same again in the shadow pass)
//   triangles, near        ~350        ~2100 to 2500
//   triangles, far          ~350        ~320 to 390   past FAR_OUT metres of the camera
//
// The far variant is not a second mesh: the geometry carries a coarse set of
// triangles over the same vertices and switching is a draw range
// (js/bodymesh.js). A far person also stops casting a shadow, which is the
// other half of what a distant figure cost.
//
// The price is one geometry (about 90 kB) and one 17-bone skeleton per person,
// so dispose() is not optional bookkeeping: owners must call it.
//
// The fixed poses (sit, ragdoll, stand, and the additive combat four) live in
// js/poses.js and are re-exported from makeCitizen under their old names.
//
// Convention (ARCHITECTURE.md), unchanged: the figure is authored FACING -z.
// Owners set group.rotation.y = heading and the face points along
// (-sin h, -cos h). A limb hangs from its joint, and POSITIVE rotation.x
// swings its lower end FORWARD. The trunk stands on its joint, so the same
// positive angle tips it BACK: a stoop is negative. (v2 had that sign wrong:
// its old man leaned backwards.) Knees bend with a negative angle, elbows with
// a positive one, like the real joints.

import * as THREE from 'three';
import { lookForUid, baseUid } from './identity.js';
import { archetype } from './people.js';
import { pickOutfit } from './wardrobe.js';
import { bodyDims } from './bodyshape.js';
import { buildJoints } from './bodyjoints.js';
import { BodyMesh } from './bodymesh.js';
import { buildBody } from './bodybuild.js';
import { buildHead } from './bodyhead.js';
import { makeGait } from './gait.js';
import { addBlob, removeBlob, blobsIn, disposeBlobs } from './groundblob.js';
import { makePoses } from './poses.js';
import { patchPeopleMaterial } from './peoplemat.js';
import { FAR_OUT, FAR_IN, trackBody, untrackBody, cullPeopleShadows } from './peopleshadows.js';

export { cullPeopleShadows };
import { holdFor } from './pedprops.js';
import { peopleReady, avatar } from './characters/avatars.js';
import { castFor } from './characters/cast.js';
import { lookOf } from './characters/appearance.js';
import { makeHuman } from './characters/human.js';


// ONE material for every citizen, for the whole session: the colours ride in
// the geometry. Standard, not Lambert, so skin and cloth pick up a little of
// the sky's reflection (scene.environment is specular only, js/envmap.js).
// The sky wrap and the street light it carries are js/peoplemat.js.
let bodyMat = null;
function material() {
  if (!bodyMat) {
    bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, envMapIntensity: 0.55 });
    patchPeopleMaterial(bodyMat);
  }
  return bodyMat;
}

// Full teardown of the shared material: for tests and a hard scene reset,
// never mid-game (every live citizen draws with it).
export function disposeCitizenAssets() {
  bodyMat?.dispose();
  bodyMat = null;
  disposeBlobs();
}

// Shared by every body: pick the draw range for this camera. Runs inside the
// renderer's own loop for objects that survived culling, so it costs nothing
// for people who are not on screen.
function pickLod(renderer, scene, camera) {
  if (scene.isScene) blobsIn(scene);       // the shared contact shadows live where the people do
  const u = this.userData, g = this.geometry.userData;
  let far = u.force != null ? u.force : u.far;
  if (u.force == null) {
    const e = this.matrixWorld.elements, c = camera.matrixWorld.elements;
    const dx = e[12] - c[12], dy = e[13] - c[13], dz = e[14] - c[14];
    const lim = u.far ? FAR_IN : FAR_OUT;
    far = dx * dx + dy * dy + dz * dz > lim * lim;
  }
  if (far === u.far) return;
  u.far = far;
  this.geometry.setDrawRange(far ? g.farStart : 0, far ? g.farCount : g.nearCount);
  this.castShadow = !far && u.shNear !== false;
}

// Who plays this citizen, and the body for them. The seed is the caller's when
// it has one; otherwise it is drawn from Math.random, which js/pedestrians.js
// lends seeded for the length of the call, so the body is as shared between
// co-op screens as the coat was.
function humanFor(look, faceDetail) {
  const uid = look.uid ?? null;
  const seed = look.seed != null ? look.seed >>> 0 : (Math.random() * 0x100000000) >>> 0;
  const cast = castFor(look, seed, uid != null ? lookOf(baseUid(uid)) : null);
  const av = cast && avatar(cast.body);
  if (!av) return null;
  try {
    // players and the story's people keep the skinned body at any distance:
    // their joints are posed by hand, and tags and seats were measured on an adult
    const own = uid != null || faceDetail;
    const height = own ? Math.min(1.84, Math.max(1.62, av.height)) : Math.min(1.94, Math.max(1.2, av.height));
    return makeHuman(av, { ...look, height: look.height ?? height }, { near: own, seed: (seed % 100003) / 100003, unit: uid != null ? 5.6 : 1.4,
      head: cast.head ? avatar(cast.head) : null });
  } catch (e) {
    console.warn('[people] ' + av.id + ' could not be built, drawing the plain figure', e);
    return null;
  }
}

// how far a bulky top holds the arms off the ribs, radians
const TOPSY = { puffer: 0.07, coat: 0.04, jacket: 0.03, hoodie: 0.03 };

/**
 * Call dispose() when the citizen leaves the world to unregister the shadow caster.
 * look = { archetype, uid, jacket, pants, skin, hair, role, outfit }.
 *   archetype  a key from js/people.js (default: the thirty-year-old man, on
 *              purpose: the hero and every peer come through the uid path and
 *              their name tags and seats were measured against him)
 *   uid        derive the whole outfit from identity.js, no randomness at all
 *   jacket, pants, skin, hair   hex overrides (the top's and the trousers'
 *              colours keep their old names)
 *   role       'police' or 'medic': a uniform instead of a wardrobe draw
 *   outfit     a finished js/wardrobe.js record (identity.js passes one)
 *   style      pin single wardrobe fields of a drawn outfit, e.g.
 *              { top: 'coat', hat: null, hairStyle: 'bob', glasses: true }
 * With no uid and no outfit the clothes are drawn from Math.random, in a fixed
 * order: js/pedestrians.js lends this call a seeded Math.random, which is what
 * makes the same citizen wear the same coat on every co-op screen.
 */
export function makeCitizen(look = {}, { faceDetail = false } = {}) {
  // A modelled human when the people bank is loaded (js/characters/), the
  // lofted figure below when it is not: headless tests, a failed download.
  if (peopleReady()) {
    const h = humanFor(look, faceDetail);
    if (h) return h;
  }
  const a = archetype(look.archetype);
  const D = bodyDims(a.key, a.h);
  const id = look.uid ?? null;
  const byUid = id == null ? null : lookForUid(baseUid(id));
  const src = look.outfit ?? byUid?.outfit ?? null;
  const pins = {
    jacket: look.jacket ?? byUid?.jacket, pants: look.pants ?? byUid?.pants,
    skin: look.skin ?? byUid?.skin, hair: look.hair ?? byUid?.hair, role: look.role,
    ...(look.style ?? null),
  };
  const o = src
    ? { ...src, topColor: pins.jacket ?? src.topColor, bottomColor: pins.pants ?? src.bottomColor,
      skin: pins.skin ?? src.skin, hair: pins.hair ?? src.hair }
    : pickOutfit(a.key, Math.random, pins);
  // what the hands are busy with (js/pedprops.js): never part of the wardrobe
  // draw, so giving somebody a dog does not change anybody's coat
  o.prop = look.prop ?? null;
  o.propTint = look.propTint ?? null;
  const hold = holdFor(o.prop, !!o.cane);
  // the one draw that is not clothing: where in the idle sway this person is
  const seed = src ? ((src.topColor ^ src.bottomColor ^ src.hair) & 1023) / 1024 : Math.random();

  // ---- the surface ----
  const M = new BodyMesh();
  buildBody(M, D, o);
  const eye = faceDetail ? {} : null;
  const headTop = buildHead(M, D, o, eye);
  const geo = M.build();

  // ---- the skeleton ----
  const group = new THREE.Group();
  // Everything hangs off an inner `body` group so the walk can move the pelvis
  // while the OWNER keeps authority over group.position (ground, bridge decks).
  const body = new THREE.Group();
  group.add(body);
  const k = D.k;
  const { bones, J, collarL, collarR } = buildJoints(D, group, body);
  const { pelvis, torso, chest, head, armL, armR, elbowL, elbowR, handL, handR,
    legL, legR, kneeL, kneeR, footL, footR } = J;

  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const mesh = new THREE.SkinnedMesh(geo, material());
  mesh.castShadow = true;
  mesh.renderOrder = 1;   // after the direct path's street-light quads (lightpools.js): shoes are not painted
  group.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());
  // A fixed sphere round the hips, big enough for a flung arm: the default is
  // recomputed from every skinned vertex, and a hundred of those is a frame.
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, D.hipY, 0), 1.35 * k);
  mesh.userData.far = false;
  mesh.userData.force = null;
  mesh.userData.shNear = true;            // until the first cullPeopleShadows
  mesh.onBeforeRender = pickLod;
  trackBody(mesh);
  const shade = addBlob(group, mesh);
  // …and only now the resting angles, so the bind pose stays the modelled one
  const rest = (0.05 + D.s.belly * 0.7 + (D.s.hip - 1) * 0.15) + ((TOPSY[o.top] ?? 0));
  collarL.rotation.z = 0 - (rest + (o.bag === 'shoulder' ? 0.10 : 0));
  collarR.rotation.z = rest;

  const gait = makeGait(J, D, { unit: byUid || look.outfit?.player ? 5.6 : 1.4, seed,
    cane: !!o.cane, carry: o.bag === 'hand' ? 'L' : null, hold });
  const { stamp, sitPose: sitBare, ragdollPose, standPose: standFree, punchPose, kickPose, aimPose, handsPose } =
    makePoses(J, { stoop: D.s.stoop, hunch: D.s.hunch, headUp: D.s.headUp, reset: gait.reset });
  // A hand with a job keeps it standing still (the lead, the pram, the phone),
  // and the phone stays at the ear on a bench too.
  const standBare = !hold ? standFree : () => { standFree(); gait.hold(); stamp(); };
  const sitPose = o.prop !== 'phone' || !hold ? sitBare : (kk = 1, car = 1) => {
    sitBare(kk, car);
    if (car < 0.5) { gait.hold(); stamp(); }
  };
  // THE STICK STANDS ON THE GROUND WHEN ITS OWNER STANDS. The fixed pose hangs
  // both arms straight down a chest stooped half a radian forward, so the man
  // with the stick held it in the air behind his heels whenever he stopped (at
  // a kerb, a bus stop, a shop window: 11 cm up and 36 cm back, measured).
  // Only the gait solves the stick arm, and its standing pose plants the tip a
  // hand ahead of the feet, so that is the pose he takes. NaN for the phase:
  // the gait stands without spending any of the stride, and reset() leaves the
  // next walk() to pick the phase up afresh, as after any fixed pose.
  const standPose = !o.cane ? standBare : () => {
    standBare();
    gait.walk(NaN, 0, 0, 0);
    gait.reset();
    stamp();
  };

  // walkT is the owner's stride phase, which it advances with DISTANCE (1.6
  // radians a metre); speedK is 0..1.3 of the owner's own idea of full speed;
  // runK (0..1) asks for the running gait outright. `mps`, when the owner
  // knows it, is the true ground speed in metres a second, and is what lets
  // the feet stay planted: without it the speed is inferred from speedK.
  // At no speed the figure stands, shifts its weight and breathes.
  const walk = (walkT, speedK, runK = 0, mps) => {
    gait.walk(walkT, speedK, runK, mps);
    stamp();
  };

  standPose();

  // Retire this body. The geometry and the skeleton's bone texture are this
  // citizen's ALONE; the room runs for hours and walkers come and go every few
  // minutes, so an owner that does `scene.remove(group)` and stops leaks both.
  const dispose = () => {
    group.parent?.remove(group);
    untrackBody(mesh);
    removeBlob(shade);
    geo.dispose();
    skeleton.dispose();
    body.clear();
    group.clear();
  };

  return {
    group, walk, sitPose, ragdollPose, standPose, dispose,
    punchPose, kickPose, aimPose, handsPose,
    look: { jacket: o.topColor, pants: o.bottomColor, skin: o.skin, hair: o.hair },
    outfit: o,
    prop: o.prop, hold,
    arch: a,
    // feet to the top of the hair or hat, before the owner's scale: name tags
    // and speech bubbles read this rather than assume 1.75
    headTop, eye,
    // 'near' | 'far' | null (automatic): the dev showroom and tests force it
    setLod(v) { mesh.userData.force = v === 'far' ? true : v === 'near' ? false : null; },
    tris: geo.userData.tris,
    // `cluster` is the one mesh; the rest are the joints. handL/handR are the
    // wrists: a pistol or a snatched handbag hangs off one.
    parts: { body, torso, chest, head, pelvis, cluster: mesh, armL, armR, legL, legR, elbowL, elbowR,
      kneeL, kneeR, footL, footR, handL, handR },
  };
}

export default makeCitizen;
