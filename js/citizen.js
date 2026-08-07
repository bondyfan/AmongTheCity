// ---- Citizens: the people of Pardubice ----
//
// v2. The city used to be ONE body — eleven boxes, 1.75 m, and only the palette
// changed — and the user's word for it was "Minecraft". This version keeps the
// low-poly art DNA (chunky boxes, flat Lambert colours, eyes that make facing
// readable from a chase camera) and spends the difference on the two things
// that actually stop a crowd reading as a clone army:
//
//   SILHOUETTE. Five archetypes (js/people.js) — a thirty-year-old man and
//   woman, a sixty-year-old man and woman, and a ninety-year-old on a stick.
//   They differ in HEIGHT, in shoulder-to-hip ratio, in limb thickness, in
//   posture and in hair, not in colour. Fifteen centimetres of height and a
//   narrower shoulder are legible at twenty metres; a different jacket is not.
//
//   JOINTS. The old figure had a one-piece arm and a one-piece leg, so the
//   walk was two pendulums — which is exactly what made it read as a toy. This
//   one has an ELBOW and a KNEE, and the knee is most of the improvement: a
//   leg that folds under the body on the back-swing is the single strongest
//   cue that something is walking rather than being slid along the pavement.
//
// AND IT COSTS FEWER DRAW CALLS THAN THE OLD ONE. The old header said it in as
// many words — "the body count is what costs, not the walking" — so a version
// with twice the parts had to pay for itself. Everything that does not
// articulate (head, hair, eyes, pupils, neck, chest, pelvis, coat) is merged
// into ONE mesh with vertex colours, drawn with a single material shared by
// every citizen in the world. So:
//
//                     old        new
//   meshes/body        15         13     head cluster 1, arms 6, legs 6
//   materials      up to 5    1 + limbs   the cluster's is shared by everyone
//   with a stick        —        14
//
// (Fifteen, not the eleven the old header claimed: it was counting the eleven
// CHILDREN of the body group, four of which were pivot Groups holding two
// meshes each. Measured with a traverse, the old figure drew fifteen.)
//
// The price is one small BufferGeometry per citizen (~9 kB, 10 boxes of
// non-indexed triangles) instead of a purely shared cache, and dispose() below
// is therefore no longer optional bookkeeping — it is the thing that stops the
// room leaking VRAM as players and walkers come and go. The articulated limbs
// still use the shared geometry/material caches, unchanged, because there are
// only a handful of distinct limb sizes in the whole city.
//
// Convention (ARCHITECTURE.md), unchanged: the figure is authored FACING −z.
// Owners set group.rotation.y = heading and the face points along
// (−sin h, −cos h). Limbs hang from pivot Groups placed AT the joint, so
// positive rotation.x swings the lower end forward.

import * as THREE from 'three';
import { lookForUid, baseUid } from './identity.js';
import { archetype } from './people.js';

// Muted Czech-street wardrobe. Deliberately no per-instance tint jitter: that
// would need a cloned material per citizen and break the shared-material
// cache; picking from enough palette entries reads varied at street distance.
const JACKETS = [0x6b7a8c, 0x8c6b5f, 0x5f7a5f, 0x7a6b8c, 0x8c8270, 0x46586a,
  0x9b5a4a, 0x53616b, 0x74684f];
const PANTS = [0x3d4450, 0x4a4038, 0x555a52, 0x38404a, 0x5a5248, 0x2f3540];
const SKINS = [0xd9a066, 0xe8b98c, 0xc78d5a, 0xb87848, 0xf0c8a0];
const HAIRS = [0x3a2a1a, 0x22201e, 0x6b5a3a, 0x8a8a86, 0x4a342a];
// Age shows in the hair before it shows anywhere else, and it is the cheapest
// cue in the file: the sixty-year-olds draw from a greying set and the
// ninety-year-old is white. Without this an old man reads as a short man.
const HAIRS_GREY = [0x8a8a86, 0x9a978f, 0x6f6d68];
const HAIRS_WHITE = [0xcfcdc6, 0xbdbab2];
const SHOE = 0x33302c, EYE = 0xf6f1df, PUPIL = 0x201b16, CANE = 0x6b4a2a;
const MOUTH = 0x8a5a4e;

const matCache = new Map();
function mat(color) {
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshLambertMaterial({ color }));
  return matCache.get(color);
}

// ONE material for every citizen's merged body cluster, for the whole session.
// The colours ride in the geometry, so a hundred people with a hundred
// different jackets still share this.
let clusterMat = null;
function clusterMaterial() {
  if (!clusterMat) clusterMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return clusterMat;
}

// ---- shared geometry cache (articulated limbs only) -----------------------
// A citizen's limbs are a handful of distinct box sizes and every citizen of
// the same archetype uses the same ones. Keyed by (w,h,d) the whole world
// shares one set — allocation on spawn is zero for these, and there is nothing
// per-instance to leak.
const geoCache = new Map();
function geo(w, h, d) {
  const key = w + '|' + h + '|' + d;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    // These outlive every mesh referencing them, so the conventional
    // `traverse(o => o.geometry.dispose())` teardown would free buffers forty
    // other citizens are still drawing from. Neutering dispose() here makes
    // the cache safe for callers that do not know they are sharing;
    // disposeCitizenAssets() below is the real one.
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

// ---- merging the static parts into one vertex-coloured mesh ---------------
// Six faces, each four corners in CCW order as sign triples, plus its normal.
// Written out rather than generated because it is read once and never changes,
// and a loop that derives it would be longer than the table.
const FACES = [
  [0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
  [0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  [1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
  [-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
  [0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
];

const _col = new THREE.Color();

/**
 * boxes: [{ w, h, d, x, y, z, c }] → one non-indexed BufferGeometry carrying
 * position, normal and colour. Non-indexed because a box's corners do not
 * share normals anyway, so an index buffer would save nothing and cost the
 * bookkeeping. Ten boxes is 360 vertices — trivial to build, trivial to draw.
 *
 * Colours go through THREE.Color so they land in the renderer's working colour
 * space exactly as `new MeshLambertMaterial({ color })` would; writing the raw
 * sRGB bytes here would have made every merged part visibly brighter than the
 * limbs beside it.
 */
function mergedBoxes(boxes) {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) n += 36;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const b of boxes) {
    const hx = b.w / 2, hy = b.h / 2, hz = b.d / 2;
    _col.setHex(b.c);
    const r = _col.r, g = _col.g, bl = _col.b;
    for (const [nx, ny, nz, quad] of FACES) {
      for (const t of [0, 1, 2, 0, 2, 3]) {
        const s = quad[t];
        pos[o] = b.x + s[0] * hx; pos[o + 1] = b.y + s[1] * hy; pos[o + 2] = b.z + s[2] * hz;
        nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
        col[o] = r; col[o + 1] = g; col[o + 2] = bl;
        o += 3;
      }
    }
  }
  const gm = new THREE.BufferGeometry();
  gm.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  gm.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  gm.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return gm;
}

// Full teardown of the shared caches — for tests and for a hard scene reset,
// never mid-game (every live citizen references these). Calls the real dispose
// off the prototype, since the cached instances carry a no-op.
export function disposeCitizenAssets() {
  for (const g of geoCache.values()) THREE.BufferGeometry.prototype.dispose.call(g);
  geoCache.clear();
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
  clusterMat?.dispose();
  clusterMat = null;
}

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// ---- the body plan --------------------------------------------------------
// Every number below is the thirty-year-old man, in metres, and every other
// archetype is this scaled by height and then reshaped. Deriving the rest from
// one reference figure is what keeps them a FAMILY: change the reference and
// all five move together, which is what you want when the whole art style
// shifts, and it means the only per-archetype numbers left are the ones that
// carry meaning — how wide the shoulders are relative to the hips, how much
// the back is bent, how long the stride is.
//
// Vertical stack, feet at 0:
//   shoe 0 → .10, shin .10 → .48, thigh .48 → .88 (hip), pelvis .88 → 1.06,
//   chest 1.06 → 1.44, neck 1.44 → 1.52, head 1.52 → 1.74, hair → 1.78
//
// THE TORSO IS FOUR BOXES AND THAT COSTS NOTHING. Everything static merges into
// one mesh, so detail above the waist is free — the only budget it spends is
// vertices, and 360 of them is a rounding error. That is why the trunk is
// hips → waist → chest → shoulder yoke rather than one slab: the waist is
// narrower than the chest and the yoke is wider than both, which is the entire
// difference between a person and a wardrobe. The first build had one torso box
// and, screenshotted, the five archetypes differed only in height.
const REF_H = 1.78;
const B = {
  shoeH: 0.10, shoeW: 0.24, shoeD: 0.30,
  shinL: 0.38, shinW: 0.19,
  thighL: 0.40, thighW: 0.22,
  pelvisH: 0.16, pelvisW: 0.36, pelvisD: 0.24,
  waistH: 0.16, waistK: 0.84,          // narrower than the chest
  chestH: 0.22, chestW: 0.44, chestD: 0.26,
  yokeH: 0.06, yokeK: 1.07,            // …and the shoulders wider than that
  neckH: 0.07, neckW: 0.15,
  headH: 0.22, headW: 0.23, headD: 0.25,
  hairH: 0.05,
  upperArmL: 0.28, foreArmL: 0.26, armW: 0.13, handH: 0.12,
  shoulderDrop: 0.05,       // shoulder pivot below the top of the yoke
};

// What makes each one itself. `chestK`/`pelvisK`/`armK`/`thighK` are multipliers
// on the reference widths; `stoop` is radians of forward lean carried all the
// time; `stride`/`swing` scale the gait; `hair` picks the shape.
const SHAPE = {
  m30: { chestK: 1.00, pelvisK: 1.00, armK: 1.00, thighK: 1.00, stoop: 0.00, stride: 1.00, swing: 1.00, hair: 'short' },
  f30: { chestK: 0.83, pelvisK: 1.04, armK: 0.85, thighK: 0.95, stoop: 0.00, stride: 0.96, swing: 0.90, hair: 'long', shoeK: 0.92, waistK: 0.76 },
  f60: { chestK: 0.86, pelvisK: 1.16, armK: 0.88, thighK: 1.02, stoop: 0.05, stride: 0.84, swing: 0.75, hair: 'bun', shoeK: 0.92, coat: true, grey: 1, waistK: 0.90 },
  m60: { chestK: 1.03, pelvisK: 1.13, armK: 1.05, thighK: 1.08, stoop: 0.06, stride: 0.90, swing: 0.85, hair: 'short', grey: 1, waistK: 0.96 },
  m90: { chestK: 0.90, pelvisK: 0.98, armK: 0.82, thighK: 0.86, stoop: 0.17, stride: 0.55, swing: 0.45, hair: 'thin', grey: 2, cane: true },
};

/**
 * look = { jacket, pants, skin, hair } hex overrides, `archetype` (a key from
 * js/people.js), or `{ uid }` to derive the whole outfit from identity.js.
 *
 * The uid path exists because a PARTIAL look was worse than none: the net layer
 * used to pass only { jacket } and let the three remaining fields fall through
 * to Math.random(), so the same remote body had different trousers on every
 * screen AND different trousers again after each reap-and-respawn. For anything
 * with a uid — the local hero, every peer — this function must not reach for
 * Math.random at all. Anonymous pedestrians still roll the dice; nobody has to
 * agree on what a passer-by wears.
 *
 * `archetype` defaults to the thirty-year-old man, which is deliberate and not
 * laziness: the hero and every peer come through the uid path, their name tags
 * and seat anchors were measured against a 1.75 m figure, and turning somebody
 * else's avatar into a pensioner is not this function's decision to make. The
 * CROWD is where the five bodies belong, and js/pedestrians.js passes the key.
 */
export function makeCitizen(look = {}) {
  const a = archetype(look.archetype);
  const s = SHAPE[a.key] ?? SHAPE.m30;
  const k = a.h / REF_H;

  // one lookForUid call, only when a uid was given; the ?? chain below then
  // prefers any explicit override the caller also passed
  const id = look.uid ?? null;
  const byUid = id == null ? null : lookForUid(baseUid(id));
  const jacket = look.jacket ?? byUid?.jacket ?? pick(JACKETS);
  const pants = look.pants ?? byUid?.pants ?? pick(PANTS);
  const skin = look.skin ?? byUid?.skin ?? pick(SKINS);
  const hair = look.hair ?? byUid?.hair
    ?? pick(s.grey === 2 ? HAIRS_WHITE : s.grey === 1 ? HAIRS_GREY : HAIRS);

  // ---- dimensions, scaled then reshaped ----
  const shoeH = B.shoeH * k, shoeW = B.shoeW * k * (s.shoeK ?? 1), shoeD = B.shoeD * k * (s.shoeK ?? 1);
  const shinL = B.shinL * k, thighL = B.thighL * k;
  const legW = B.thighW * k * s.thighK, shinW = B.shinW * k * s.thighK;
  const pelvisH = B.pelvisH * k, pelvisW = B.pelvisW * k * s.pelvisK, pelvisD = B.pelvisD * k;
  const chestH = B.chestH * k, chestW = B.chestW * k * s.chestK, chestD = B.chestD * k;
  const waistH = B.waistH * k, waistW = chestW * (s.waistK ?? B.waistK);
  const yokeH = B.yokeH * k, yokeW = chestW * B.yokeK;
  const neckH = B.neckH * k, neckW = B.neckW * k;
  const headH = B.headH * k, headW = B.headW * k, headD = B.headD * k;
  const hairH = B.hairH * k;
  const upperArmL = B.upperArmL * k, foreArmL = B.foreArmL * k;
  const armW = B.armW * k * s.armK, handH = B.handH * k;

  const hipY = shoeH + shinL + thighL;
  const pelvisY = hipY + pelvisH / 2;
  const waistY = hipY + pelvisH + waistH / 2;
  const chestY = hipY + pelvisH + waistH + chestH / 2;
  const yokeY = hipY + pelvisH + waistH + chestH + yokeH / 2;
  const shoulderTop = hipY + pelvisH + waistH + chestH + yokeH;
  // the neck sinks INTO the yoke by a third of its height: a neck that merely
  // sits on top of the shoulders reads, in flat Lambert shading at twenty
  // metres, as a head floating over a gap. It did, and the screenshot showed it.
  const neckY = shoulderTop + neckH / 2 - neckH * 0.34;
  const headY = shoulderTop + neckH + headH / 2 - neckH * 0.34;
  const headTop = headY + headH / 2;
  const shoulderY = shoulderTop - B.shoulderDrop * k;
  const hipX = pelvisW * 0.32;
  // OUTSIDE the yoke, not inside it. The first build put the shoulder pivot at
  // `chestW * 0.5 - armW * 0.45`, i.e. buried in the torso, so a heavy man's
  // arms vanished entirely and only his hands came out at hip height.
  const shoulderX = yokeW * 0.5 + armW * 0.06;

  const group = new THREE.Group();
  // Everything hangs off an inner `body` group so the walk bob and the age
  // stoop can move the whole figure while the OWNER keeps authority over
  // group.position.y (ground height, bridge decks) on the outer group.
  const body = new THREE.Group();
  group.add(body);

  // ---- the static cluster: one mesh, one shared material ----
  const parts = [
    { w: pelvisW, h: pelvisH, d: pelvisD, x: 0, y: pelvisY, z: 0, c: pants },
    { w: waistW, h: waistH, d: chestD * 0.94, x: 0, y: waistY, z: 0, c: jacket },
    { w: chestW, h: chestH, d: chestD, x: 0, y: chestY, z: 0, c: jacket },
    { w: yokeW, h: yokeH, d: chestD * 0.96, x: 0, y: yokeY, z: 0, c: jacket },
    { w: neckW, h: neckH, d: neckW, x: 0, y: neckY, z: 0, c: skin },
    { w: headW, h: headH, d: headD, x: 0, y: headY, z: 0, c: skin },
    // a nose. Four centimetres of box, free (it merges), and it is the
    // difference between a head and a cube — it gives the face a direction
    // even at the distance where the eyes have become two pale pixels.
    { w: headW * 0.16, h: headH * 0.18, d: 0.035 * k,
      x: 0, y: headY - headH * 0.02, z: -headD / 2 - 0.017 * k, c: skin },
  ];
  // A hip-length coat, not a skirt: a skirt is a static box and the thighs
  // swing straight through one. This stops above the hip joint, so the legs
  // pass UNDER it and nothing intersects.
  if (s.coat) {
    parts.push({ w: waistW * 1.14, h: (pelvisH + waistH) * 0.62, d: chestD * 1.08,
      x: 0, y: waistY - waistH * 0.18, z: 0, c: jacket });
  }
  // Hair, and it does more work than its size suggests — length and shape are
  // half of what makes a woman read as a woman at twenty metres in a game
  // where every body is boxes.
  // HAIR WRAPS THE SKULL, it is not a lid. A flat slab on top of a cube leaves a
  // cube, and that was the last thing in the figure still reading as Minecraft
  // once the shoulders and the nose had landed. A cap plus a back panel plus
  // two side panels turns the head into a face with hair around it — and all
  // four boxes merge, so the whole thing is still one mesh and one draw call.
  const hairY = headTop - hairH / 2 + hairH * 0.6;
  const bald = s.hair === 'thin';
  parts.push({ w: headW * (bald ? 0.88 : 1.06), h: hairH * (bald ? 0.7 : 1),
    d: headD * (bald ? 0.88 : 1.06), x: 0, y: hairY, z: 0, c: hair });
  if (!bald) {
    const drop = s.hair === 'short' ? 0.42 : 0.62;   // how far down the skull
    parts.push({ w: headW * 1.05, h: headH * drop, d: headD * 0.16,
      x: 0, y: headTop - headH * drop / 2, z: headD * 0.47, c: hair });   // back
    for (const sx of [-1, 1]) {
      parts.push({ w: headW * 0.10, h: headH * drop * 0.82, d: headD * 0.9,
        x: sx * headW * 0.52, y: headTop - headH * drop / 2, z: headD * 0.03, c: hair });
    }
  } else {
    // a ninety-year-old keeps the sides and loses the top — the horseshoe is
    // the most recognisable silhouette in the file for the price of two boxes
    for (const sx of [-1, 1]) {
      parts.push({ w: headW * 0.09, h: headH * 0.26, d: headD * 0.8,
        x: sx * headW * 0.52, y: headTop - headH * 0.20, z: headD * 0.03, c: hair });
    }
  }
  if (s.hair === 'long') {
    // down the back: behind the head and neck, +z is BEHIND (the figure faces −z)
    parts.push({ w: headW * 0.92, h: headH + neckH * 2.6, d: headD * 0.30,
      x: 0, y: headY - headH * 0.32, z: headD * 0.42, c: hair });
  } else if (s.hair === 'bun') {
    parts.push({ w: headW * 0.42, h: headH * 0.42, d: headD * 0.42,
      x: 0, y: headY + headH * 0.26, z: headD * 0.52, c: hair });
  }
  // eyes on the −z face — bright whites + dark pupils, and they are the reason
  // you can tell at a glance which way somebody is facing
  const eyeX = headW * 0.28, eyeY = headY + headH * 0.10, eyeZ = -headD / 2 - 0.005;
  for (const sx of [-1, 1]) {
    parts.push({ w: headW * 0.30, h: headH * 0.26, d: 0.02, x: sx * eyeX, y: eyeY, z: eyeZ, c: EYE });
    parts.push({ w: headW * 0.13, h: headH * 0.17, d: 0.016, x: sx * eyeX, y: eyeY - headH * 0.01, z: eyeZ - 0.012, c: PUPIL });
  }
  // A mouth. One flat dark box, and with the nose above it the head finally has
  // a front — which matters most at the distance where the eyes have blurred
  // into two pale dots and the only thing left telling you which way somebody
  // is facing is the arrangement of dark marks.
  parts.push({ w: headW * 0.30, h: headH * 0.055, d: 0.015,
    x: 0, y: headY - headH * 0.28, z: eyeZ - 0.004, c: MOUTH });
  const clusterGeo = mergedBoxes(parts);
  const cluster = new THREE.Mesh(clusterGeo, clusterMaterial());
  cluster.castShadow = true;

  // A HIP JOINT for the upper body, and the stoop is the reason it exists.
  // `stoop` used to be applied to `body`, whose origin is the FEET — so an
  // eighty-year-old's bend rotated the entire figure about his ankles and he
  // leaned forward like a plank with his legs still in line with his spine.
  // Bending at the hip, with the legs left vertical underneath, is what a
  // stoop actually is; it is one more Group and Groups are free.
  const torso = new THREE.Group();
  torso.position.y = hipY;
  cluster.position.y = -hipY;
  torso.add(cluster);
  body.add(torso);

  // ---- arms: shoulder → elbow → hand ----
  // arms hang off the TORSO, not off the body, so they lean with the back
  const arm = (sx) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * shoulderX, shoulderY - hipY, 0);
    const upper = box(armW, upperArmL, armW, jacket);
    upper.position.y = -upperArmL / 2;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -upperArmL;
    const fore = box(armW * 0.92, foreArmL, armW * 0.92, jacket);
    fore.position.y = -foreArmL / 2;
    const hand = box(armW * 0.98, handH, armW * 0.98, skin);
    hand.position.y = -foreArmL - handH / 2;
    elbow.add(fore, hand);
    shoulder.add(elbow);
    return { shoulder, elbow };
  };
  const aL = arm(-1), aR = arm(1);
  const armL = aL.shoulder, armR = aR.shoulder;
  const elbowL = aL.elbow, elbowR = aR.elbow;

  // ---- legs: hip → knee → foot ----
  const leg = (sx) => {
    const hip = new THREE.Group();
    hip.position.set(sx * hipX, hipY, 0);
    const thigh = box(legW, thighL, legW, pants);
    thigh.position.y = -thighL / 2;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -thighL;
    const shin = box(shinW, shinL, shinW, pants);
    shin.position.y = -shinL / 2;
    const shoe = box(shoeW, shoeH, shoeD, SHOE);
    shoe.position.set(0, -shinL - shoeH / 2, -shoeD * 0.10);
    knee.add(shin, shoe);
    hip.add(knee);
    return { hip, knee };
  };
  const lL = leg(-1), lR = leg(1);
  const legL = lL.hip, legR = lR.hip;
  const kneeL = lL.knee, kneeR = lR.knee;

  torso.add(armL, armR);
  body.add(legL, legR);

  // ---- the walking stick ----
  // Hung off the right arm so it travels with the hand, and the right arm's
  // swing is damped to almost nothing in walk() below — a man leaning on a
  // stick does not swing that arm, and that stillness is most of what makes
  // the stick read as load-bearing rather than as a prop he is carrying.
  let cane = null;
  if (s.cane) {
    const handY = -upperArmL - foreArmL - handH;
    const len = shoulderY + handY + 0.02;    // from the hand down to the ground
    cane = box(0.035 * k, len, 0.035 * k, CANE);
    cane.position.set(sx0(armW), handY - len / 2 + handH * 0.3, -0.06 * k);
    cane.rotation.x = -0.10;                 // planted a little ahead of the foot
    armR.add(cane);
  }

  // walkT = phase in radians (owner advances it with distance), speedK 0..~1.25
  // scales the swing so a stroll barely sways and a sprint pumps. Positive
  // rotation.x swings a hanging limb toward −z = forward, so legs lead and the
  // opposite arm counter-swings, like people do. The bob runs at DOUBLE the
  // stride frequency — the body dips at each footfall, not each full cycle.
  // `runK` (0..1) turns a walk into a RUN: longer stride, driving arms, the
  // body pitched into it and a flight phase between steps. Blending rather
  // than switching means the change happens over the metre or two of
  // acceleration where the player feels it, instead of snapping at a threshold.
  //
  // NEW IN v2 — the knee, and it is the whole point. A leg that stays straight
  // through the back-swing is a pendulum; a leg that folds as the foot leaves
  // the ground is a walk. The flexion peaks a quarter-cycle after the thigh
  // reaches its rearmost point, which is KNEE_PHASE, and it is clamped to
  // positive because a knee bends one way only — the elbow is the same trick
  // with a smaller amplitude and no phase offset, since an arm swinging
  // forward bends and an arm swinging back straightens.
  const KNEE_PHASE = 1.15;
  const stride = s.stride, swingK = s.swing, stoop = s.stoop;
  const caneArm = s.cane ? 0.12 : 1;         // the stick arm barely swings

  const walk = (walkT, speedK, runK = 0) => {
    const r = runK < 0 ? 0 : runK > 1 ? 1 : runK;
    const sn = Math.sin(walkT) * speedK;
    const legAmp = (0.55 + 0.55 * r) * stride;
    const armAmp = (0.42 + 0.55 * r) * swingK;
    const kneeAmp = (0.55 + 0.75 * r) * stride;
    const elbowAmp = 0.22 + 0.85 * r;

    legL.rotation.x = sn * legAmp;
    legR.rotation.x = -sn * legAmp;
    // one-sided: max(0, …) is the joint's own limit, not a smoothing trick
    const fl = Math.sin(walkT + KNEE_PHASE), fr = Math.sin(walkT + KNEE_PHASE + Math.PI);
    kneeL.rotation.x = -(fl > 0 ? fl : 0) * kneeAmp * speedK;
    kneeR.rotation.x = -(fr > 0 ? fr : 0) * kneeAmp * speedK;

    // elbows come up as the run builds: a constant forward bias on the whole
    // arm on top of its swing, plus a bend that follows the forward reach
    armL.rotation.x = -sn * armAmp - 0.45 * r;
    armR.rotation.x = (-sn * -armAmp - 0.45 * r) * caneArm;
    elbowL.rotation.x = -elbowAmp * (0.5 - 0.5 * Math.sin(walkT));
    elbowR.rotation.x = -elbowAmp * (0.5 + 0.5 * Math.sin(walkT)) * caneArm;

    torso.rotation.x = stoop + 0.30 * r;
    // the bob doubles and stops touching down — a run has a flight phase
    body.position.y = Math.abs(Math.cos(walkT)) * (0.045 + 0.075 * r)
      * Math.min(1, speedK) + 0.05 * r;
  };

  // Thrown by a car: splay the limbs ONCE at launch — arms flung out sideways,
  // legs bent unevenly — and hold that shape while the owner tumbles the whole
  // group. Randomized per call so no two victims fold the same way. walk()
  // drives rotation.x, so the z-splay set here survives until standPose.
  const ragdollPose = () => {
    torso.rotation.x = 0;
    const rn = Math.random;
    armL.rotation.set(-0.4 - rn() * 0.9, 0, -(0.9 + rn() * 1.0));
    armR.rotation.set(-0.4 - rn() * 0.9, 0, 0.9 + rn() * 1.0);
    elbowL.rotation.x = -0.3 - rn() * 1.1;
    elbowR.rotation.x = -0.3 - rn() * 1.1;
    legL.rotation.set(0.35 + rn() * 0.7, 0, -0.1 - rn() * 0.25);
    legR.rotation.set(0.1 + rn() * 0.5, 0, 0.1 + rn() * 0.25);
    kneeL.rotation.x = -0.2 - rn() * 1.2;
    kneeR.rotation.x = -0.2 - rn() * 1.2;
    body.position.y = 0;
  };

  // Seated in a vehicle. With a real knee this is finally the pose it always
  // wanted to be: the hip folds ~70°, the knee folds the shin back down into
  // the footwell, and the feet end up under the dashboard instead of the
  // one-piece leg sticking out through the bonnet. k (0..1) blends the fold in
  // from standing, which lets the boarding slide settle a rider over its half
  // second instead of snapping.
  const sitPose = (kk = 1) => {
    torso.rotation.x = 0;
    legL.rotation.set(1.24 * kk, 0, -0.06 * kk);
    legR.rotation.set(1.30 * kk, 0, 0.06 * kk);
    kneeL.rotation.x = -1.34 * kk;
    kneeR.rotation.x = -1.30 * kk;
    armL.rotation.set(0.52 * kk, 0, -0.10 * kk);
    armR.rotation.set(0.52 * kk, 0, 0.10 * kk);
    elbowL.rotation.x = -0.55 * kk;
    elbowR.rotation.x = -0.55 * kk;
    body.position.y = 0;
  };

  // Back on their feet: undo the splay so walk() fully owns the limbs again.
  const standPose = () => {
    armL.rotation.set(0, 0, 0);
    armR.rotation.set(0, 0, 0);
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    elbowL.rotation.x = 0; elbowR.rotation.x = 0;
    kneeL.rotation.x = 0; kneeR.rotation.x = 0;
    torso.rotation.x = stoop;
    body.position.y = 0;
  };
  standPose();

  // Retire this body. Limb geometry and every material are SHARED, so there is
  // deliberately nothing to free there — but the merged cluster geometry is
  // this citizen's ALONE, and it is the one thing in the file that leaks if a
  // caller does the conventional `scene.remove(group)` and stops. The room
  // runs 24/7 and walkers come and go every few minutes; over an evening that
  // is thousands of small buffers. Owners must call this.
  const dispose = () => {
    group.parent?.remove(group);
    THREE.BufferGeometry.prototype.dispose.call(clusterGeo);
    body.clear();
    group.clear();
  };

  return {
    group, walk, sitPose, ragdollPose, standPose, dispose,
    look: { jacket, pants, skin, hair },
    arch: a,
    // How tall this particular person is, feet to the top of their hair, before
    // the owner's scale. Anything that floats something over a head — name
    // tags, speech bubbles — should read this rather than assume 1.75, now that
    // a grandmother is fifteen centimetres shorter than a young man.
    headTop,
    parts: { body, torso, cluster, armL, armR, legL, legR, elbowL, elbowR, kneeL, kneeR },
  };
}

// tiny helper kept out of the hot path: which side the stick hangs on
function sx0(w) { return w * 0.35; }

export default makeCitizen;
