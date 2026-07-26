// ---- Citizens: the low-poly box people of Pardubice ----
// Same art DNA as the AmongTheWoods villagers: chunky boxes, flat Lambert
// colors, eyes that make facing readable from a chase camera. Limbs hang from
// pivot Groups placed AT the shoulder/hip joints, so one walk() call swings
// them like pendulums instead of shearing boxes around their centers. All
// materials come from a module-level color-keyed cache — a street full of
// pedestrians shares a handful of materials, not forty clones.
//
// Convention (ARCHITECTURE.md): the figure is authored FACING −z. Owners set
// group.rotation.y = heading and the face points along (−sin h, −cos h).

import * as THREE from 'three';

// Muted Czech-street wardrobe. Deliberately no per-instance tint jitter: that
// would need a cloned material per citizen and break the shared-material
// cache; picking from enough palette entries reads varied at street distance.
const JACKETS = [0x6b7a8c, 0x8c6b5f, 0x5f7a5f, 0x7a6b8c, 0x8c8270, 0x46586a,
  0x9b5a4a, 0x53616b, 0x74684f];
const PANTS = [0x3d4450, 0x4a4038, 0x555a52, 0x38404a, 0x5a5248, 0x2f3540];
const SKINS = [0xd9a066, 0xe8b98c, 0xc78d5a, 0xb87848, 0xf0c8a0];
const HAIRS = [0x3a2a1a, 0x22201e, 0x6b5a3a, 0x8a8a86, 0x4a342a];
const SHOE = 0x33302c, EYE = 0xf6f1df, PUPIL = 0x201b16;

const matCache = new Map();
function mat(color) {
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshLambertMaterial({ color }));
  return matCache.get(color);
}
function box(w, h, d, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.castShadow = true;
  return m;
}
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// look = optional { jacket, pants, skin } hex overrides (the player has a
// fixed outfit; anonymous pedestrians roll the palette dice).
export function makeCitizen(look = {}) {
  const jacket = look.jacket ?? pick(JACKETS);
  const pants = look.pants ?? pick(PANTS);
  const skin = look.skin ?? pick(SKINS);

  const group = new THREE.Group();
  // Everything hangs off an inner `body` group so the walk bob can dip the
  // whole figure while the OWNER keeps authority over group.position.y
  // (ground height, bridge decks) on the outer group.
  const body = new THREE.Group();
  group.add(body);

  // legs — pivot at the hip (y 0.86), box hangs below, shoe toes point −z
  const legL = new THREE.Group(); legL.position.set(-0.13, 0.86, 0);
  const shinL = box(0.22, 0.72, 0.22, pants); shinL.position.y = -0.36; legL.add(shinL);
  const shoeL = box(0.23, 0.12, 0.28, SHOE); shoeL.position.set(0, -0.78, -0.03); legL.add(shoeL);
  const legR = new THREE.Group(); legR.position.set(0.13, 0.86, 0);
  const shinR = box(0.22, 0.72, 0.22, pants); shinR.position.y = -0.36; legR.add(shinR);
  const shoeR = box(0.23, 0.12, 0.28, SHOE); shoeR.position.set(0, -0.78, -0.03); legR.add(shoeR);

  const torso = box(0.5, 0.6, 0.28, jacket); torso.position.y = 1.16;
  const head = box(0.28, 0.28, 0.28, skin); head.position.y = 1.61; // top ≈ 1.75 m
  const hair = box(0.3, 0.09, 0.3, look.hair ?? pick(HAIRS)); hair.position.y = 1.74;

  // eyes on the −z face — bright whites + dark pupils, Woods style
  const eyeL = box(0.07, 0.06, 0.02, EYE); eyeL.position.set(-0.065, 1.635, -0.145);
  const eyeR = box(0.07, 0.06, 0.02, EYE); eyeR.position.set(0.065, 1.635, -0.145);
  const pupL = box(0.03, 0.038, 0.016, PUPIL); pupL.position.set(-0.065, 1.632, -0.158);
  const pupR = box(0.03, 0.038, 0.016, PUPIL); pupR.position.set(0.065, 1.632, -0.158);

  // arms — pivot at the shoulder (y 1.40), jacket sleeve + skin hand
  const armL = new THREE.Group(); armL.position.set(-0.32, 1.4, 0);
  const sleeveL = box(0.14, 0.56, 0.14, jacket); sleeveL.position.y = -0.28; armL.add(sleeveL);
  const handL = box(0.13, 0.12, 0.13, skin); handL.position.y = -0.61; armL.add(handL);
  const armR = new THREE.Group(); armR.position.set(0.32, 1.4, 0);
  const sleeveR = box(0.14, 0.56, 0.14, jacket); sleeveR.position.y = -0.28; armR.add(sleeveR);
  const handR = box(0.13, 0.12, 0.13, skin); handR.position.y = -0.61; armR.add(handR);

  body.add(legL, legR, torso, head, hair, eyeL, eyeR, pupL, pupR, armL, armR);

  // walkT = phase in radians (owner advances it with distance), speedK 0..~1.25
  // scales the swing so a stroll barely sways and a sprint pumps. Positive
  // rotation.x swings a hanging limb toward −z = forward, so legs lead and the
  // opposite arm counter-swings, like people do. The bob runs at DOUBLE the
  // stride frequency — the body dips at each footfall, not each full cycle.
  const walk = (walkT, speedK) => {
    const s = Math.sin(walkT) * speedK;
    legL.rotation.x = s * 0.55;
    legR.rotation.x = -s * 0.55;
    armL.rotation.x = -s * 0.42;
    armR.rotation.x = s * 0.42;
    body.position.y = Math.abs(Math.cos(walkT)) * 0.045 * Math.min(1, speedK);
  };

  // Thrown by a car: splay the limbs ONCE at launch — arms flung out sideways,
  // legs bent unevenly — and hold that shape while the owner tumbles the whole
  // group. Randomized per call so no two victims fold the same way. walk()
  // only drives rotation.x, so the z-splay set here survives until standPose.
  const ragdollPose = () => {
    const r = Math.random;
    armL.rotation.set(-0.4 - r() * 0.9, 0, -(0.9 + r() * 1.0));
    armR.rotation.set(-0.4 - r() * 0.9, 0, 0.9 + r() * 1.0);
    legL.rotation.set(0.35 + r() * 0.7, 0, -0.1 - r() * 0.25);
    legR.rotation.set(0.1 + r() * 0.5, 0, 0.1 + r() * 0.25);
    body.position.y = 0;
  };

  // Seated in a vehicle: hips folded ~90° so the one-piece legs point into
  // the footwell (knees-up read — the box people have no knee joint, so the
  // whole leg rises), arms reaching a little forward toward a wheel that
  // isn't modeled. k (0..1) blends the fold in from standing, which lets the
  // boarding slide settle a rider over its half second instead of snapping —
  // same pivot-rotation pattern as walk()/ragdollPose(), and standPose()
  // undoes it the moment the passenger steps back out. The tiny z splay
  // (outward, ragdoll sign convention) keeps sleeves out of the torso.
  const sitPose = (k = 1) => {
    legL.rotation.set(1.22 * k, 0, -0.06 * k);
    legR.rotation.set(1.28 * k, 0, 0.06 * k);
    armL.rotation.set(0.52 * k, 0, -0.10 * k);
    armR.rotation.set(0.52 * k, 0, 0.10 * k);
    body.position.y = 0;
  };

  // Back on their feet: undo the splay so walk() fully owns the limbs again.
  const standPose = () => {
    armL.rotation.set(0, 0, 0);
    armR.rotation.set(0, 0, 0);
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    body.position.y = 0;
  };

  return { group, walk, sitPose, ragdollPose, standPose,
    parts: { body, torso, head, armL, armR, legL, legR } };
}
