// ---- gait.js: walking, running and standing still --------------------------
//
// The old walk swung two legs like pendulums at a fixed 3.9 m per cycle,
// whatever the speed, so a pensioner at 1.2 m/s skated and a sprinter at 14
// tiptoed. This one starts from the FEET. Each foot follows a path in the
// body's own frame: on the ground it travels backwards at exactly the speed
// the body moves forwards (so in the world it stands still), then it lifts,
// swings through and lands. Two-bone inverse kinematics turns the ankle's
// position into a hip and a knee angle. The bending knee, the heel strike and
// the push off the toes all fall out of that; none of them is keyed.
//
// The stride is a function of speed (people speed up by stepping longer AND
// faster), the phase advances with DISTANCE over that stride, and the fraction
// of the cycle a foot spends on the ground shrinks as the stride outgrows the
// leg, which is what turns a walk into a run with a flight phase. Each
// archetype scales the same model: the old man's steps are short, flat and
// wide, and he never straightens his knees.
//
// Nothing here allocates. All state is one small object per person, made at
// spawn; the solver writes into the joints and into module scratch.

const TAU = Math.PI * 2;
const c01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const ss = (a, b, x) => { const t = c01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

// step: stride length against the reference adult. lift: how far the swinging
// foot clears the ground. sway and twist: hips side to side, shoulders against
// hips. arm: swing. bounce: vertical travel. width: stance, metres wider than
// the hips. toe: toes turned out, radians. duty: share of the cycle on the
// ground at a walk.
const GAIT = {
  m30: { step: 1.00, lift: 1.00, sway: 0.012, twist: 0.11, arm: 1.00, bounce: 1.0, width: 0.000, toe: 0.07, duty: 0.58, lean: 0.035 },
  f30: { step: 0.95, lift: 0.90, sway: 0.019, twist: 0.14, arm: 0.86, bounce: 0.9, width: -0.014, toe: 0.02, duty: 0.58, lean: 0.02 },
  f60: { step: 0.80, lift: 0.65, sway: 0.027, twist: 0.06, arm: 0.52, bounce: 0.7, width: 0.012, toe: 0.11, duty: 0.61, lean: 0.03 },
  m60: { step: 0.88, lift: 0.75, sway: 0.022, twist: 0.07, arm: 0.72, bounce: 0.8, width: 0.022, toe: 0.15, duty: 0.60, lean: 0.03 },
  m90: { step: 0.66, lift: 0.30, sway: 0.024, twist: 0.03, arm: 0.22, bounce: 0.35, width: 0.034, toe: 0.13, duty: 0.66, lean: 0.02 },
};

// scratch for one foot: forward of the hip, height of the ankle, pitch
const _f = { z: 0, y: 0, p: 0 };

/**
 * Where one ankle is at phase `phi` of its own cycle (0 = heel strike).
 * On the ground the foot rolls: it lands on the heel with the toes up, lies
 * flat, then pivots over the ball as the heel rises. The pivot point stays put
 * in the world, which is the whole of "no foot sliding".
 */
function footAt(phi, duty, Lc, zFront, rr, lift, aY, k) {
  const ball = 0.15 * k, heel = 0.055 * k;
  const thH = 0.30 * (1 - rr), thT = 0.95 + 0.2 * rr;
  // the two ends of the ground contact, shared by stance and swing
  const z0 = zFront - aY * Math.sin(thH) - heel * (1 - Math.cos(thH));
  const y0 = aY + heel * Math.sin(thH) - aY * (1 - Math.cos(thH));
  if (phi < duty) {
    const s = phi / duty, s1 = 0.14, s2 = 0.50;
    let z = zFront - Lc * s, y = aY, p = 0;
    if (s < s1) {
      p = thH * (1 - s / s1);
      z -= aY * Math.sin(p) + heel * (1 - Math.cos(p)); y += heel * Math.sin(p) - aY * (1 - Math.cos(p));
    } else if (s > s2) {
      const w = (s - s2) / (1 - s2), q = thT * w * Math.sqrt(w);
      p = -q;
      z += ball * (1 - Math.cos(q)) + aY * Math.sin(q); y += ball * Math.sin(q) - aY * (1 - Math.cos(q));
    }
    _f.z = z; _f.y = y; _f.p = p;
    return;
  }
  const u = (phi - duty) / (1 - duty), u2 = u * u, u3 = u2 * u;
  const z1 = zFront - Lc + ball * (1 - Math.cos(thT)) + aY * Math.sin(thT);
  const y1 = aY + ball * Math.sin(thT) - aY * (1 - Math.cos(thT));
  // leave and arrive at the ground's own speed, so there is no snap at either
  // end; capped, or a short stance would whip the foot far past its landing
  let m = -Lc * (1 - duty) / duty;
  const span = z0 - z1;
  if (m < -1.1 * span) m = -1.1 * span;
  _f.z = (2 * u3 - 3 * u2 + 1) * z1 + (u3 - 2 * u2 + u) * m + (-2 * u3 + 3 * u2) * z0 + (u3 - u2) * m;
  // a walker's foot skims; a runner's heel comes up behind first
  const bump = Math.sin(Math.PI * Math.pow(u, 1 - 0.35 * rr));
  _f.y = y1 + (y0 - y1) * u + lift * bump;
  const e = u * u * (3 - 2 * u);
  _f.p = -thT + (thH + thT) * e - 0.25 * rr * bump;
}

// ankle (fwd, up from the ground) and hip height to hip, knee and foot angles
function solveLeg(hip, knee, foot, fwd, down, pitch, L1, L2, dx) {
  let d = Math.hypot(fwd, down);
  const max = (L1 + L2) * 0.9985, min = Math.abs(L1 - L2) + 0.03;
  if (d > max) d = max; else if (d < min) d = min;
  const flex = Math.PI - Math.acos(clamp1((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2)));
  const a = Math.atan2(fwd, down) + Math.acos(clamp1((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  hip.rotation.x = a;
  knee.rotation.x = 0 - flex;
  foot.rotation.x = pitch - a + flex;
  hip.rotation.z = Math.atan2(dx, down);
}

/**
 * J: the joints (group, body, pelvis, torso, chest, head, armL/R, elbowL/R,
 * handR, legL/R, kneeL/R, footL/R, cane). D: js/bodyshape.js dims.
 * opt: { unit: m/s that speedK = 1 means when no speed is passed, seed: 0..1,
 *        cane: bool, carry: 'L' | null (an arm that holds a bag),
 *        hold: { L, R } of a HOLD key or null (js/pedprops.js holdFor): an arm
 *        that is busy with something instead of swinging }.
 * Returns { walk(walkT, speedK, runK, mps), reset(), hold() }.
 */
// An arm with a job: [shoulder forward, elbow, out from the ribs, turned in,
// how much of the walking swing is left]. The same angles standing and walking.
const HOLD = {
  bag: [0.02, 0.10, 0.07, 0, 0.22],         // a bag of shopping hanging from the hand
  leash: [0.34, 0.46, 0.05, 0, 0.12],       // the lead: the hand forward of the hip
  push: [0.60, 0.80, 0.02, 0, 0],           // both hands on the handle of a pram
  phone: [1.12, 2.70, 0.66, -0.05, 0],      // the hand at the ear, the elbow out to the side
};
function holdArm(arm, elbow, key, side, swing) {
  const h = HOLD[key];
  arm.rotation.set(h[0] + swing * h[4], 0 - h[3] * side, h[2] * side);
  elbow.rotation.x = h[1];
}

export function makeGait(J, D, opt) {
  const g = GAIT[D.key] ?? GAIT.m30, s = D.s, k = D.k;
  const L1 = D.thigh, L2 = D.shin, legK = (L1 + L2) / 0.83;
  const aY = D.ankleY;
  const unit = opt.unit ?? 1.4;
  const st = { phase: 0, lastT: NaN, move: 0, lastNow: 0, still: 0, ph: (opt.seed ?? 0) * TAU, v: 0 };
  const U = D.upper, F = D.fore + 0.065 * k;      // shoulder to elbow, elbow to grip
  const caneLen = D.wristY - 0.065 * k;           // grip to tip, as modelled
  const stand = D.hipY - s.crouch;

  const reset = () => { st.lastT = NaN; st.still = 0; };
  // an arm with a job (the stick has the right hand first)
  const jobL = opt.hold?.L ?? null, jobR = opt.cane ? null : (opt.hold?.R ?? null);

  const walk = (walkT, speedK, runK = 0, mps) => {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
    let dt = now - st.lastNow; st.lastNow = now;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    const scale = J.group.scale.x || 1;
    const first = !Number.isFinite(st.lastT);
    let v = (mps != null ? mps : speedK * unit) / scale;     // model metres a second
    if (!(v > 0)) v = 0;
    let dT = first || !Number.isFinite(walkT) ? 0 : walkT - st.lastT;
    if (Number.isFinite(walkT)) st.lastT = walkT;
    if (dT > Math.PI || dT < -Math.PI) dT = Math.atan2(Math.sin(dT), Math.cos(dT));   // a wrapped phase
    const dist = Math.abs(dT) / 1.6 / scale;

    // ---- the stride at this speed ----
    const rr = Math.max(c01(runK), ss(2.3, 3.4, v));
    const Sw = g.step * legK * (0.60 + 0.56 * Math.min(v, 2.6));
    const Sr = legK * (1.9 + 0.32 * v);
    const S = Sw + (Sr - Sw) * rr;
    const Lc = Math.min(S * g.duty, legK * (0.90 + 0.12 * rr) * (0.75 + 0.25 * g.step));
    const duty = Lc / S;
    if (first) st.phase = Number.isFinite(walkT) ? ((walkT / TAU) % 1 + 1) % 1 : 0;
    else st.phase = (st.phase + dist / S) % 1;

    // ---- moving, or standing? ----
    st.still = dist < 1e-6 ? st.still + dt : 0;
    const want = v > 0.12 && speedK > 0.01 && st.still < 0.25 ? 1 : 0;
    st.move = first ? want : st.move + (want - st.move) * Math.min(1, dt * 7);
    const m = st.move, idle = 1 - m;

    const pL = st.phase, pR = (pL + 0.5) % 1;
    const cyc = Math.cos(TAU * pL), mid = TAU * (pL - duty * 0.5);
    const amp = Math.min(1, Lc / (0.8 * legK));
    // ---- idle: a slow shift of weight, and breathing ----
    const t = now + st.ph * 3;
    const shift = Math.sin(t * 0.47 + st.ph) * 0.6 + Math.sin(t * 0.21) * 0.4;
    const breath = Math.sin(t * 1.7 + st.ph);

    // ---- pelvis ----
    const hW = stand - 0.028 * legK * amp + 0.020 * g.bounce * amp * Math.cos(2 * mid);
    const hR = stand - 0.055 * legK - 0.045 * Math.cos(2 * mid);
    // (a leg near straight is touchy: one centimetre of drop is 18 degrees of knee)
    const hI = stand - 0.002 * k - 0.003 * k * Math.abs(shift);
    const hipH = (hW + (hR - hW) * rr) * m + hI * idle;
    const swayX = -g.sway * k * Math.cos(mid) * (1 - 0.6 * rr) * m + 0.022 * k * shift * idle;
    J.body.position.y = hipH - D.hipY;
    J.body.position.x = swayX;

    // ---- legs ----
    const lift = (0.045 * g.lift + (0.20 + 0.012 * Math.min(v, 12)) * rr) * k;
    const zFront = Lc * (0.44 - 0.04 * rr) - s.crouch * 0.5;
    const wide = g.width * k;
    footAt(pL, duty, Lc, zFront, rr, lift, aY, k);
    solveLeg(J.legL, J.kneeL, J.footL, _f.z * m, hipH - (aY + (_f.y - aY) * m), _f.p * m, L1, L2, -wide - swayX);
    footAt(pR, duty, Lc, zFront, rr, lift, aY, k);
    solveLeg(J.legR, J.kneeR, J.footR, _f.z * m, hipH - (aY + (_f.y - aY) * m), _f.p * m, L1, L2, wide - swayX);
    J.legL.rotation.y = g.toe; J.legR.rotation.y = 0 - g.toe;

    // ---- trunk: hips turn with the leading leg, shoulders against them ----
    const tw = g.twist * (0.7 + 0.5 * rr) * amp * m;
    J.pelvis.rotation.y = 0 - tw * 0.6 * cyc;
    J.pelvis.rotation.z = 0.04 * g.bounce * Math.cos(mid) * m * (1 - rr);
    J.torso.rotation.x = 0 - (s.stoop + 0.14 * rr * m);
    J.torso.rotation.z = (g.sway * 1.6 * Math.cos(mid) * m) - 0.03 * shift * idle;
    J.chest.rotation.x = 0 - (s.hunch + g.lean * m + 0.05 * rr * m) + 0.010 * breath * (0.4 + 0.6 * idle);
    J.chest.rotation.y = tw * cyc;
    J.head.rotation.x = s.headUp + (g.lean * 0.6 + 0.16 * rr) * m - 0.006 * breath * idle;
    J.head.rotation.y = 0 - tw * 0.8 * cyc + 0.10 * Math.sin(t * 0.31 + st.ph * 2) * idle;
    J.head.rotation.z = 0.03 * shift * idle;

    // ---- arms: opposite the legs, elbows closing as the run builds ----
    // A runner's arm travels further back than forward (the upper arm never
    // gets far ahead of the ribs) and the elbow stays near a right angle.
    const A = g.arm * (0.20 + 0.15 * Math.min(1, v / 1.6)) * (1 - rr) + 0.58 * rr;
    const sw = A * cyc * m, back = 0.22 * rr * m;
    const eb = 0.20 + 1.30 * rr * m + 0.03 * breath * idle, ev = (0.34 * g.arm * (1 - rr) + 0.25 * rr) * m;
    const cl = opt.carry === 'L' ? 0.3 : 1;
    J.armL.rotation.x = 0 - sw * cl - back * cl + 0.03 * idle;
    J.elbowL.rotation.x = (eb + ev * Math.max(0, -cyc)) * (cl < 1 ? 0.5 : 1) + (cl < 1 ? 0.10 : 0);
    if (!opt.cane) {
      J.armR.rotation.x = sw - back + 0.03 * idle;
      J.elbowR.rotation.x = eb + ev * Math.max(0, cyc);
    } else {
      // ---- the stick: planted with the LEFT foot, carried forward with it ----
      // The tip shares the left foot's path a hand's width ahead of it, and
      // the arm is solved backwards from there: where must the hand be for a
      // stick of this length to stand on that spot?
      footAt(pL, duty, Lc, zFront, rr, lift, aY, k);
      const tipZ = (_f.z + 0.12 * k) * m + 0.16 * k * idle;
      const tipY = Math.max(0, (_f.y - aY)) * 0.6 * m;
      // the shoulder, by forward kinematics up the bent spine (sagittal plane)
      const a1 = -J.torso.rotation.x, a2 = a1 - J.chest.rotation.x;
      const shZ = Math.sin(a1) * (D.spineY - D.hipY) + Math.sin(a2) * (D.shoulderY - D.spineY);
      const shY = hipH + Math.cos(a1) * (D.spineY - D.hipY) + Math.cos(a2) * (D.shoulderY - D.spineY);
      // hand: on the circle of the stick's length round the tip, kept a
      // little ahead of the hip
      const hz = 0.17 * k + (tipZ - 0.17 * k) * 0.35;
      const dz = tipZ - hz;
      const hy = tipY + Math.sqrt(Math.max(0.01, caneLen * caneLen - dz * dz));
      let fwd = hz - shZ, down = shY - hy, d = Math.hypot(fwd, down);
      const max = (U + F) * 0.995;
      if (d > max) d = max; else if (d < 0.08) d = 0.08;
      const flex = Math.PI - Math.acos(clamp1((U * U + F * F - d * d) / (2 * U * F)));
      const up = Math.atan2(fwd, down) - Math.acos(clamp1((U * U + d * d - F * F) / (2 * U * d)));
      J.armR.rotation.x = up + a2;            // the parents lean forward by a2
      J.elbowR.rotation.x = flex;
      J.cane.rotation.x = Math.atan2(dz, hy - tipY) - (up + flex);
    }
    // ---- an arm with a job keeps to it ----
    if (jobL) holdArm(J.armL, J.elbowL, jobL, -1, 0 - sw);
    if (jobR) holdArm(J.armR, J.elbowR, jobR, 1, sw);
  };
  /** Put the busy arms where they belong on top of a fixed pose (standing, a bench). */
  const hold = () => {
    if (jobL) holdArm(J.armL, J.elbowL, jobL, -1, 0);
    if (jobR) holdArm(J.armR, J.elbowR, jobR, 1, 0);
  };
  return { walk, reset, hold, state: st };
}

// ==== pedalling ===============================================================
//
// The legs of somebody on a bicycle. Each foot is ON its pedal, and the pedal
// is where the crank puts it, so the same two-bone solve that plants a
// walker's foot on the pavement turns the crank angle into a hip and a knee:
// the knee comes up over the top of the stroke and the leg is all but straight
// at the bottom because the saddle is that high, not because either is keyed.
// The ankle drops the toes through the back of the stroke, as a real one does.
//
// `parts` is makeCitizen().parts; `fit` is the bicycle's (js/bikemodel.js) and
// is scaled by this rider's leg, like js/poses.js makeRidePose, with which
// this shares the hip position. Returns pedal(fit, crank, stand, roll):
//   crank  radians, 0 = RIGHT pedal at the top, increasing as the bike rolls
//          forward (top, front, bottom, back)
//   stand  0 riding .. 1 stopped: the LEFT foot comes off its pedal and
//          stands on the road beside the bike
//   roll   radians the bicycle leans, positive to the RIGHT (at a stop it
//          leans a little onto the standing foot, and the ground is where
//          that puts it)
// Nothing allocates.
const PEDAL_REF_THIGH = 0.415;   // js/bodyshape.js REF.hipY - REF.kneeY

export function makePedal(parts) {
  const { legL, legR, kneeL, kneeR, footL, footR } = parts;
  const L1 = 0 - kneeL.position.y, L2 = 0 - footL.position.y;
  const k = L1 / PEDAL_REF_THIGH;
  const hipX = Math.abs(legL.position.x);
  const aY = 0.085 * k, ball = 0.125 * k;          // ankle over the sole; ankle to the ball of the foot

  // one foot on its pedal at crank angle phi; `g` (0..1) takes it to the ground
  const leg = (hip, knee, foot, sx, phi, fit, seatY, seatF, g, roll) => {
    const c = fit.crank * k;
    const pf = c * Math.sin(phi), pu = fit.bbY * k + c * Math.cos(phi);
    // toes down through the back of the stroke
    const th = 0.14 + 0.20 * (0.5 - 0.5 * Math.cos(phi - 0.9));
    let af = pf - (ball * Math.cos(th) - aY * Math.sin(th));
    let au = pu + ball * Math.sin(th) + aY * Math.cos(th) + 0.012 * k;
    let pitch = 0 - th, dx = sx * (fit.pedalX * k - hipX);
    if (g > 0) {
      // on the road: a hand's width out from the pedal, on tiptoe, where the
      // lean of the bike has put the ground
      const gx = 0.30 * k, tip = 0.42;
      const gf = 0.10 * k, gu = sx * gx * Math.tan(roll) + ball * Math.sin(tip) + aY * Math.cos(tip);
      af += (gf - af) * g; au += (gu - au) * g;
      pitch += (0 - tip - pitch) * g;
      dx += (sx * (gx - hipX) - dx) * g;
    }
    solveLeg(hip, knee, foot, af - seatF, seatY - au, pitch, L1, L2, dx);
    hip.rotation.y = 0;
  };

  return (fit, crank, stand = 0, roll = 0) => {
    const st = stand > 0 ? (stand < 1 ? stand : 1) : 0;
    const seatY = (fit.seatY - fit.standDrop * st) * k, seatF = (fit.seatF + fit.standF * st) * k;
    leg(legR, kneeR, footR, 1, crank, fit, seatY, seatF, 0, roll);
    leg(legL, kneeL, footL, -1, crank + Math.PI, fit, seatY, seatF, st, roll);
  };
}
