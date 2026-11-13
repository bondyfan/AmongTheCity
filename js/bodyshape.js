// ---- bodyshape.js: the measurements of the five bodies ---------------------
//
// Pure numbers, no three. Everything is derived from ONE reference figure, the
// thirty-year-old man at 1.78 m, scaled by height and then reshaped by a short
// list of multipliers per archetype. That keeps the five a family (change the
// reference and all five move together) while the multipliers carry what makes
// each one itself: shoulder to hip ratio, a bust, a belly, limb thickness, how
// far the back is bent.
//
// The differences are deliberately LARGER than life. At 40 m a person is forty
// pixels tall; the ninety-year-old has to read there, and what reads there is
// silhouette: a bent back, a head carried forward, thin legs, a stick.

export const REF_H = 1.78;

// Skeleton slots. The order is the bone index in the skinned mesh.
export const BONE = {
  pelvis: 0, torso: 1, chest: 2, head: 3,
  armL: 4, elbowL: 5, handL: 6, armR: 7, elbowR: 8, handR: 9,
  legL: 10, kneeL: 11, footL: 12, legR: 13, kneeR: 14, footR: 15,
  cane: 16,
};
export const BONE_COUNT = 17;

// The reference adult, metres, feet at 0.
const REF = {
  ankleY: 0.085, kneeY: 0.50, hipY: 0.915, hipX: 0.088, crotchY: 0.835,
  beltY: 1.03, waistY: 1.12, ribY: 1.24, chestY: 1.34, armpitY: 1.425,
  spineY: 1.17,                 // where the upper back hinges (the chest bone)
  shoulderY: 1.440, shoulderX: 0.190, shoulderTopY: 1.478,
  neckY: 1.505, chinY: 1.540, crownY: 1.786,
  upper: 0.295, fore: 0.265, hand: 0.175,
};

// What makes each one itself. Widths multiply the reference; bust and belly
// are metres added to the FRONT of the trunk; stoop/hunch/headUp are radians
// of posture carried all the time (hip, upper back, and the neck's answer).
export const SHAPE = {
  m30: { sh: 1.00, chW: 1.00, chD: 1.00, waist: 1.00, hip: 1.00, limb: 1.00, bust: 0, belly: 0,
    neck: 1.00, head: 1.00, shoe: 1.00, stoop: 0, hunch: 0, headUp: 0, crouch: 0 },
  f30: { sh: 0.84, chW: 0.86, chD: 0.90, waist: 0.80, hip: 1.07, limb: 0.82, bust: 0.030, belly: 0,
    neck: 0.80, head: 0.96, shoe: 0.88, stoop: 0, hunch: 0, headUp: 0, crouch: 0 },
  f60: { sh: 0.90, chW: 0.98, chD: 1.10, waist: 1.12, hip: 1.22, limb: 0.98, bust: 0.040, belly: 0.035,
    neck: 0.88, head: 0.97, shoe: 0.90, stoop: 0.05, hunch: 0.10, headUp: 0.08, crouch: 0.012 },
  m60: { sh: 1.03, chW: 1.08, chD: 1.14, waist: 1.26, hip: 1.12, limb: 1.10, bust: 0, belly: 0.080,
    neck: 1.14, head: 1.02, shoe: 1.02, stoop: 0.03, hunch: 0.09, headUp: 0.06, crouch: 0.008 },
  m90: { sh: 0.88, chW: 0.88, chD: 0.96, waist: 1.02, hip: 0.96, limb: 0.74, bust: 0, belly: 0.025,
    neck: 0.84, head: 0.99, shoe: 0.98, stoop: 0.21, hunch: 0.30, headUp: 0.32, crouch: 0.05 },
};

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Every length the builder and the animation need, for one archetype at one
 * height. The trunk comes back as `trunk`, a list of { y, rx, fz, bz } rings
 * (bare body), and `trunkAt(y)` interpolates it.
 */
export function bodyDims(archKey, height) {
  const s = SHAPE[archKey] ?? SHAPE.m30;
  const k = height / REF_H;
  const D = { k, s, key: SHAPE[archKey] ? archKey : 'm30' };
  for (const n in REF) D[n] = REF[n] * k;
  D.hipX = REF.hipX * k * (0.55 + 0.45 * s.hip);
  D.shoulderX = REF.shoulderX * k * s.sh;
  D.thigh = D.hipY - D.kneeY;
  D.shin = D.kneeY - D.ankleY;
  D.elbowY = D.shoulderY - D.upper;
  D.wristY = D.elbowY - D.fore;
  D.limb = s.limb;
  D.neckR = 0.054 * k * s.neck;
  D.headK = k * s.head;
  // the head keeps its size when the body shrinks with age: an old man is
  // shorter in the leg and the spine, not in the skull
  D.crownY = D.chinY + (REF.crownY - REF.chinY) * D.headK;

  const b = s.belly, u = s.bust;
  D.trunk = [
    { y: D.crotchY, rx: 0.100 * s.hip, fz: 0.085, bz: 0.092 * s.hip },
    { y: D.hipY + 0.015 * k, rx: 0.168 * s.hip, fz: 0.100 + b * 0.35, bz: 0.114 * s.hip },
    { y: D.beltY, rx: 0.152 * lerp(s.hip, s.waist, 0.6), fz: 0.096 + b * 0.95, bz: 0.094 * lerp(s.hip, s.waist, 0.5) },
    { y: D.waistY, rx: 0.140 * s.waist, fz: 0.090 + b, bz: 0.088 * lerp(1, s.waist, 0.5) },
    { y: D.ribY, rx: 0.155 * s.chW, fz: 0.100 * s.chD + b * 0.5 + u * 0.55, bz: 0.098 * s.chD },
    { y: D.chestY, rx: 0.165 * s.chW, fz: 0.110 * s.chD + u, bz: 0.102 * s.chD },
    { y: D.armpitY, rx: 0.164 * s.sh, fz: 0.098 * s.chD + u * 0.25, bz: 0.096 * s.chD },
    { y: D.shoulderTopY, rx: 0.128 * s.sh, fz: 0.066, bz: 0.078 },
    { y: D.neckY, rx: 0.066 * s.neck, fz: 0.058 * s.neck, bz: 0.062 * s.neck },
  ];
  for (const r of D.trunk) { r.rx *= k; r.fz *= k; r.bz *= k; }
  D.trunkAt = (y) => {
    const t = D.trunk;
    if (y <= t[0].y) return t[0];
    for (let i = 1; i < t.length; i++) {
      if (y > t[i].y) continue;
      const f = (y - t[i - 1].y) / (t[i].y - t[i - 1].y);
      // smoothstep between rings so the profile has no corners where the
      // extra clothing rings fall between two anatomical ones
      const g = f * f * (3 - 2 * f);
      return { y, rx: lerp(t[i - 1].rx, t[i].rx, g), fz: lerp(t[i - 1].fz, t[i].fz, g), bz: lerp(t[i - 1].bz, t[i].bz, g) };
    }
    return t[t.length - 1];
  };
  return D;
}
