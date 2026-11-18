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
import { bodyDims, BONE } from './bodyshape.js';
import { BodyMesh } from './bodymesh.js';
import { buildBody } from './bodybuild.js';
import { buildHead } from './bodyhead.js';
import { makeGait } from './gait.js';
import { addBlob, removeBlob, blobsIn, disposeBlobs } from './groundblob.js';
import { makePoses } from './poses.js';
import { lampDirectPatch } from './lampmap.js';
import { BATCH, onBatchFlag } from './batchflags.js';

// Where the distance variant takes over, metres from the rendering camera,
// with a gap so a person standing at the line does not flicker between two.
const FAR_OUT = 62, FAR_IN = 55;

// ONE material for every citizen, for the whole session: the colours ride in
// the geometry. Standard, not Lambert, so skin and cloth pick up a little of
// the sky's reflection (scene.environment is specular only, js/envmap.js).
//
// THE SKY WRAP. A hemisphere light gives a vertical surface half of what it
// gives the pavement, and a person is nothing but vertical surfaces: in a
// building's shadow, and at night outside a lamp pool (the pools light the
// ground, not what stands on it), the figure went to a black cut-out against
// a lit street. The patch below adds the scene's OWN sky colour as a little
// flat fill plus a rim where the surface turns away from the eye. It reads
// hemisphereLights[0], which sky.js drives from noon to midnight, so it is the
// same term by day (a faint bright edge, the way a figure outdoors really
// has one) and by night (a dim blue outline under the moon). Nothing here is
// emissive: with the hemisphere light off, a person is black.
//
// STREET LIGHT. With the post stack the composite lights a figure from the lamp
// map like everything else. Without it (the low preset) nothing did: a man
// under a lamp was a dark shape on a lit pavement. lampDirectPatch gives the
// material the same map to read on that path (js/lampmap.js).
let bodyMat = null;
function material() {
  if (!bodyMat) {
    bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, envMapIntensity: 0.55 });
    bodyMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
#if ( NUM_HEMI_LIGHTS > 0 ) && defined( RE_IndirectDiffuse )
	irradiance += hemisphereLights[ 0 ].skyColor * ( 0.10 + 0.85 * pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 3.0 ) );
#endif`);
      lampDirectPatch(sh);
    };
    bodyMat.customProgramCacheKey = () => 'citizen-skywrap-2-lamp';
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

// ---- who casts into the sun's shadow map ------------------------------------
// pickLod above only runs for a person the CAMERA drew, so everybody behind
// it or beside it kept whatever castShadow they last had: true from birth for
// most of a crowd, and the shadow box (js/sky.js, 230 m across on medium and
// leading the view) takes in a good deal of what is behind the camera. Each
// of them was a whole skinned draw call in the shadow pass. Every live body is
// listed here and, once per shadow-map update (main.js, before the render),
// a person casts only
//   - within `r` of the camera, in any direction (a shadow from just behind
//     the camera can fall forward into the view), or
//   - when a sphere of SH_REACH round them touches the view frustum, which is
//     where their shadow could be seen at all; there pickLod's own far line
//     (FAR_OUT) keeps deciding, exactly as before.
// So nothing on screen changes: a figure in view casts as it always did, and
// only people whose shadow cannot reach the picture stop drawing one. The
// first version cut everyone past 45 m, in view too, which put a second line
// in the picture (walkers 45 to 62 m away losing their shadow) next to the
// far LOD's own at 62. Both tests have some give, so nobody flickers on one.
// `__batch.shadows = false` (js/batchflags.js) puts back cast-always.
const _bodies = new Set();
const SH_GIVE = 3;
// metres round a body that its shadow may reach: a 1.8 m figure under a sun
// 10 degrees up throws some 10 m; the larger value holds a caster until it is
// well clear, the smaller one lets a new one in
const SH_REACH_KEEP = 14, SH_REACH_JOIN = 11;
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();

/** Once per shadow update: people whose shadow cannot reach the view stop casting. */
export function cullPeopleShadows(camera, r = 45) {
  if (!BATCH.shadows || !camera) return;
  camera.updateWorldMatrix(true, false);
  _pv.multiplyMatrices(camera.projectionMatrix, _pv.copy(camera.matrixWorld).invert());
  _frustum.setFromProjectionMatrix(_pv);
  const c = camera.matrixWorld.elements, cx = c[12], cy = c[13], cz = c[14];
  const rIn = (r - SH_GIVE) ** 2, rOut = (r + SH_GIVE) ** 2, far2 = (FAR_OUT + SH_GIVE) ** 2;
  for (const m of _bodies) {
    const u = m.userData, e = m.matrixWorld.elements;
    const dx = e[12] - cx, dy = e[13] - cy, dz = e[14] - cz, d2 = dx * dx + dy * dy + dz * dz;
    let near = u.shNear ? d2 < rOut : d2 < rIn;
    if (!near && d2 < far2) {
      _sph.center.set(e[12], e[13], e[14]);
      _sph.radius = u.shNear ? SH_REACH_KEEP : SH_REACH_JOIN;
      near = _frustum.intersectsSphere(_sph);
    }
    u.shNear = near;
    m.castShadow = near && !u.far;
  }
}
onBatchFlag('shadows', (on) => {
  if (on) return;                         // the next cull sets them
  for (const m of _bodies) { m.userData.shNear = true; m.castShadow = !m.userData.far; }
});

// how far a bulky top holds the arms off the ribs, radians
const TOPSY = { puffer: 0.07, coat: 0.04, jacket: 0.03, hoodie: 0.03 };

/**
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
export function makeCitizen(look = {}) {
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
  // the one draw that is not clothing: where in the idle sway this person is
  const seed = src ? ((src.topColor ^ src.bottomColor ^ src.hair) & 1023) / 1024 : Math.random();

  // ---- the surface ----
  const M = new BodyMesh();
  buildBody(M, D, o);
  const headTop = buildHead(M, D, o);
  const geo = M.build();

  // ---- the skeleton ----
  const group = new THREE.Group();
  // Everything hangs off an inner `body` group so the walk can move the pelvis
  // while the OWNER keeps authority over group.position (ground, bridge decks).
  const body = new THREE.Group();
  group.add(body);
  const bones = [];
  const bone = (i, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.position.set(x, y, z);
    parent.add(b);
    if (i >= 0) bones[i] = b;
    return b;
  };
  const k = D.k;
  const pelvis = bone(BONE.pelvis, body, 0, D.hipY, 0);
  // The stoop bends the BACK at the hip and leaves the legs standing under it,
  // which is why the trunk has its own joint there instead of leaning `body`.
  const torso = bone(BONE.torso, body, 0, D.hipY, 0);
  const chest = bone(BONE.chest, torso, 0, D.spineY - D.hipY, 0);
  const head = bone(BONE.head, chest, 0, D.shoulderTopY + 0.012 * k - D.spineY, 0.008 * k);
  const arm = (sx, ia) => {
    // a collar joint that only ever holds the resting angle of the arm away
    // from the ribs, so the poses' own shoulder angles compose on top of it
    const collar = bone(-1, chest, sx * (D.shoulderX + 0.004 * k), D.shoulderY - D.spineY, 0);
    const shoulder = bone(ia, collar, 0, 0, 0);
    const elbow = bone(ia + 1, shoulder, 0, -D.upper, 0);
    const hand = bone(ia + 2, elbow, 0, -D.fore, 0);
    return { collar, shoulder, elbow, hand };
  };
  const aL = arm(-1, BONE.armL), aR = arm(1, BONE.armR);
  const leg = (sx, il) => {
    const hip = bone(il, body, sx * D.hipX, D.hipY, 0);
    const knee = bone(il + 1, hip, 0, -D.thigh, 0);
    const foot = bone(il + 2, knee, 0, -D.shin, 0);
    return { hip, knee, foot };
  };
  const lL = leg(-1, BONE.legL), lR = leg(1, BONE.legR);
  const cane = bone(BONE.cane, aR.hand, 0.008 * k, -0.065 * k, -0.02 * k);
  const armL = aL.shoulder, armR = aR.shoulder, elbowL = aL.elbow, elbowR = aR.elbow;
  const handL = aL.hand, handR = aR.hand;
  const legL = lL.hip, legR = lR.hip, kneeL = lL.knee, kneeR = lR.knee, footL = lL.foot, footR = lR.foot;

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
  _bodies.add(mesh);
  const shade = addBlob(group, mesh);
  // …and only now the resting angles, so the bind pose stays the modelled one
  const rest = (0.05 + D.s.belly * 0.7 + (D.s.hip - 1) * 0.15) + ((TOPSY[o.top] ?? 0));
  aL.collar.rotation.z = 0 - (rest + (o.bag === 'shoulder' ? 0.10 : 0));
  aR.collar.rotation.z = rest;

  const J = { group, body, pelvis, torso, chest, head, armL, armR, elbowL, elbowR, handL, handR,
    legL, legR, kneeL, kneeR, footL, footR, cane };
  const gait = makeGait(J, D, { unit: byUid || look.outfit?.player ? 5.6 : 1.4, seed,
    cane: !!o.cane, carry: o.bag === 'hand' ? 'L' : null });
  const { stamp, sitPose, ragdollPose, standPose: standBare, punchPose, kickPose, aimPose, handsPose } =
    makePoses(J, { stoop: D.s.stoop, hunch: D.s.hunch, headUp: D.s.headUp, reset: gait.reset });
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
    _bodies.delete(mesh);
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
    arch: a,
    // feet to the top of the hair or hat, before the owner's scale: name tags
    // and speech bubbles read this rather than assume 1.75
    headTop,
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
