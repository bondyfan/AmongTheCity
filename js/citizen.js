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
import { lookForUid, baseUid } from './identity.js';

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

// ---- shared geometry cache ------------------------------------------------
// A citizen is eleven boxes, but there are only about eight DISTINCT box sizes
// among them and every citizen in the city uses the same eight. Building
// BoxGeometry per limb per body meant a 40-pedestrian street plus a dozen
// remote players allocated ~600 geometries, each with its own GPU buffers, and
// nothing disposed them when a body went away: the room runs 24/7, players join
// and are reaped, and VRAM only ever went up. Keyed by (w,h,d) the whole world
// shares one set — allocation on join drops to zero, and there is nothing
// per-instance left to leak.
const geoCache = new Map();
function geo(w, h, d) {
  const key = w + '|' + h + '|' + d;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    // These geometries outlive every mesh that references them. Owners that
    // tear a body down conventionally — `mesh.traverse(o => o.geometry?.
    // dispose?.())` — would otherwise free the GPU buffers of geometry still
    // in use by forty other citizens (three.js re-uploads it, so it is a
    // stutter rather than a crash, but it is a stutter on every despawn).
    // Neutering dispose() here makes the shared cache safe for callers that do
    // not know they are sharing; disposeCitizenAssets() below is the real one.
    g.dispose = () => {};
    geoCache.set(key, g);
  }
  return g;
}
function box(w, h, d, color) {
  const m = new THREE.Mesh(geo(w, h, d), mat(color));
  m.castShadow = true;
  return m;
}

// Full teardown of the shared caches — for tests and for a hard scene reset,
// never mid-game (every live citizen references these). Calls the real
// dispose off the prototype, since the cached instances carry a no-op.
export function disposeCitizenAssets() {
  for (const g of geoCache.values()) THREE.BufferGeometry.prototype.dispose.call(g);
  geoCache.clear();
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
}

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// look = { jacket, pants, skin, hair } hex overrides, or { uid } to derive the
// whole outfit from identity.js.
//
// The uid path exists because a PARTIAL look was worse than none: the net layer
// used to pass only { jacket } and let the three remaining fields fall through
// to Math.random(), so the same remote body had different trousers on every
// screen AND different trousers again after each reap-and-respawn. For anything
// with a uid — the local hero, every peer — this function must not reach for
// Math.random at all. Anonymous pedestrians still roll the dice; nobody has to
// agree on what a passer-by wears.
export function makeCitizen(look = {}) {
  // one lookForUid call, only when a uid was given; the ?? chain below then
  // prefers any explicit override the caller also passed
  const id = look.uid ?? null;
  const byUid = id == null ? null : lookForUid(baseUid(id));
  const jacket = look.jacket ?? byUid?.jacket ?? pick(JACKETS);
  const pants = look.pants ?? byUid?.pants ?? pick(PANTS);
  const skin = look.skin ?? byUid?.skin ?? pick(SKINS);
  const hair = look.hair ?? byUid?.hair ?? pick(HAIRS);

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
  const hairMesh = box(0.3, 0.09, 0.3, hair); hairMesh.position.y = 1.74;

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

  body.add(legL, legR, torso, head, hairMesh, eyeL, eyeR, pupL, pupR, armL, armR);

  // walkT = phase in radians (owner advances it with distance), speedK 0..~1.25
  // scales the swing so a stroll barely sways and a sprint pumps. Positive
  // rotation.x swings a hanging limb toward −z = forward, so legs lead and the
  // opposite arm counter-swings, like people do. The bob runs at DOUBLE the
  // stride frequency — the body dips at each footfall, not each full cycle.
  // `runK` (0..1) turns a walk into a RUN, and the difference is not just
  // cadence — a sprinter's stride is longer, the arms drive rather than swing,
  // the body pitches forward into it and the whole figure leaves the ground
  // between steps. Blending rather than switching means the change happens
  // where the player feels it, over the metre or two of acceleration, instead
  // of snapping at a threshold.
  const walk = (walkT, speedK, runK = 0) => {
    const r = runK < 0 ? 0 : runK > 1 ? 1 : runK;
    const s = Math.sin(walkT) * speedK;
    const leg = 0.55 + 0.55 * r;              // stride opens up
    const arm = 0.42 + 0.55 * r;              // …and the arms drive
    legL.rotation.x = s * leg;
    legR.rotation.x = -s * leg;
    // elbows come up as the run builds: the model has no elbow, so the whole
    // arm carries a constant forward bias on top of its swing
    armL.rotation.x = -s * arm - 0.45 * r;
    armR.rotation.x = s * arm - 0.45 * r;
    body.rotation.x = 0.30 * r;               // pitch into it
    // the bob doubles and stops touching down — a run has a flight phase
    body.position.y = Math.abs(Math.cos(walkT)) * (0.045 + 0.075 * r)
      * Math.min(1, speedK) + 0.05 * r;
  };

  // Thrown by a car: splay the limbs ONCE at launch — arms flung out sideways,
  // legs bent unevenly — and hold that shape while the owner tumbles the whole
  // group. Randomized per call so no two victims fold the same way. walk()
  // only drives rotation.x, so the z-splay set here survives until standPose.
  const ragdollPose = () => {
    body.rotation.x = 0;
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

  // Retire this body. Geometry and materials are SHARED (see geoCache/matCache)
  // so there is deliberately nothing to free here beyond the scene graph —
  // detaching the group and emptying it drops the only references that kept the
  // eleven meshes alive, and the GC does the rest. Owners that used to call
  // `scene.remove(group)` and stop should call this instead: remove() alone
  // leaves the meshes hanging off the group, and any owner map still pointing
  // at the record keeps the whole subtree resident.
  const dispose = () => {
    group.parent?.remove(group);
    body.clear();
    group.clear();
  };

  return { group, walk, sitPose, ragdollPose, standPose, dispose,
    look: { jacket, pants, skin, hair },
    parts: { body, torso, head, armL, armR, legL, legR } };
}
