// ---- resolve.js: clip or game, joint by joint -----------------------------------
//
// One person's pose for this frame. js/characters/human.js owns the body; this
// file owns the decision described at the top of that one:
//
//   1. What the body is basically doing (standing, moving, sitting on a bench)
//      picks a recorded pose: two gaits blended by speed, an idle or a fidget,
//      a seated loop. No recording for it (a car seat, a ragdoll): no clip.
//   2. The game's joints are read. Where they still hold the base the owner
//      last asked for, the clip stands. Where something moved them since (a
//      hand out to a door, a vault, a pistol raised, the campaign's own
//      keyframes), that joint takes the game's angle: added on top of the clip
//      while the difference is small, replacing it once it is large.
//   3. A change of clip cross-fades from the pose that was showing.
//
// All quaternions are flat x, y, z, w; slots are js/characters/skeletonmap.js.

import * as THREE from 'three';
import { SLOT, SLOT_COUNT } from './skeletonmap.js';
import { deltasFromJoints, deltasOf, solve, worldOf } from './retarget.js';
import { sampleClip, mixLocals } from './clipbank.js';
import { pickGait, idleAt } from './animset.js';
import { roleClip } from './avatars.js';
import { talking } from './mouth.js';

// standing: a fidget may start in about four windows of ten; a recorded one runs up to twelve seconds
const IDLE = { period: 24, chance: 0.4 };
const NONE = [];
const OWN_FULL = 0.35;        // radians off the base at which a joint is wholly the game's
const LEGS = [SLOT.hips, SLOT.upperLegL, SLOT.upperLegR, SLOT.lowerLegL, SLOT.lowerLegR];
const ARM = { L: [SLOT.upperArmL, SLOT.lowerArmL, SLOT.handL], R: [SLOT.upperArmR, SLOT.lowerArmR, SLOT.handR] };
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const _pg = {}, _ia = {};
const _a = new THREE.Quaternion(), _b = new THREE.Quaternion(), _c = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _hA = [0, 0, 0], _hB = [0, 0, 0];
const SCR = new Map();
function scratch(n) {
  let s = SCR.get(n);
  if (!s) SCR.set(n, s = { A: new Float32Array(n * 4), B: new Float32Array(n * 4), W: new Float32Array(n * 4), out: new Float32Array(n * 4) });
  return s;
}
const D = new Float32Array(SLOT_COUNT * 4), CD = new Float32Array(SLOT_COUNT * 4), F = new Float32Array(SLOT_COUNT * 4);
const has = new Uint8Array(SLOT_COUNT), own = new Float32Array(SLOT_COUNT);

/**
 * av: the avatar. J: the game's joints. st: the body's state (human.js):
 * kind, phase, v, sitK, seed, far. hold: { L, R } hands with a job.
 */
export function makeResolver(av, J, st, hold) {
  const rig = av.rig, n = rig.n;
  const cur = new Float32Array(n * 4), prev = new Float32Array(n * 4);
  cur.set(rig.restQ);
  const base = new Float32Array(SLOT_COUNT * 4);     // the joints as the last base call left them
  const force = new Float32Array(SLOT_COUNT);        // a hand with a job is the game's all the time
  for (const sd of ['L', 'R']) if (hold?.[sd]) for (const s of ARM[sd]) force[s] = 1;
  const baseBody = [0, 0, 0], hip = [0, 0, 0], prevHip = [0, 0, 0], lastHip = [0, 0, 0];
  let key = null, fade = 1, fadeDur = 0.25, lastNow = 0, moved = false, sit;

  const sitClip = () => (sit === undefined ? (sit = roleClip(av, 'sit')) : sit);

  /** The owner asked for a plain base: remember the joints as they stand. */
  const setBase = (kind) => {
    st.kind = kind;
    if (st.far) return;
    deltasFromJoints(J, base, has);
    baseBody[0] = J.body.position.x; baseBody[1] = J.body.position.y; baseBody[2] = J.body.position.z;
  };

  // the recorded pose for what the body is doing, into S.A / _hA; returns its key or null
  const clipPose = (S, now, s) => {
    const k = st.kind;
    if (k === 'move' && av.gaits.length) {
      const g = pickGait(av.gaits, st.v, s, _pg);
      sampleClip(g.a.clip, st.phase * g.a.clip.dur, S.A, _hA);
      if (g.b !== g.a && g.w > 0.002) {
        sampleClip(g.b.clip, st.phase * g.b.clip.dur, S.B, _hB);
        mixLocals(S.A, S.A, S.B, g.w, n * 4);
        for (let c = 0; c < 3; c++) _hA[c] += (_hB[c] - _hA[c]) * g.w;
      }
      return 'move';
    }
    if (k === 'sit') {
      const c = sitClip();
      if (c) {
        sampleClip(c, now + st.seed % 97, S.A, _hA);
        if (st.sitK < 1 && av.idles[0]) {
          sampleClip(av.idles[0], now, S.B, _hB);
          mixLocals(S.A, S.B, S.A, smooth(st.sitK), n * 4);
          for (let c2 = 0; c2 < 3; c2++) _hA[c2] = _hB[c2] + (_hA[c2] - _hB[c2]) * smooth(st.sitK);
        }
        return 'sit';
      }
    }
    if (k === 'idle' || k === 'move') {
      // somebody standing and speaking talks with their hands: a recorded gesture loop
      if (!st.calm && talking(st, now) && av.talks?.length) {
        const c = av.talks[st.seed % av.talks.length];
        sampleClip(c, now + (st.seed % 13), S.A, _hA);
        return 'talk';
      }
      const r = idleAt(st.seed, now, av.idles, st.calm ? NONE : av.fidgets, IDLE, _ia);
      if (r.clip) { sampleClip(r.clip, r.t, S.A, _hA); return r.fidget ? r.clip.name : 'idle'; }
    }
    return null;
  };

  /** This frame's pose into `cur`; returns the hips' offset in the avatar's own metres. */
  const resolve = (s) => {
    const now = performance.now() * 0.001;
    let dt = now - lastNow; lastNow = now;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    const S = scratch(n);
    const ck = clipPose(S, now, s);
    const bp = J.body.position;
    deltasFromJoints(J, D, has);
    let out = S.out;
    moved = false;
    if (!ck) {
      solve(rig, D, has, out);
      hip[0] = bp.x / s; hip[1] = bp.y / s; hip[2] = bp.z / s;
      moved = true;
    } else {
      let any = false;
      for (let i = 0; i < SLOT_COUNT; i++) {
        own[i] = 0;
        if (!has[i]) continue;
        const o = i * 4;
        let d = D[o] * base[o] + D[o + 1] * base[o + 1] + D[o + 2] * base[o + 2] + D[o + 3] * base[o + 3];
        if (d < 0) d = -d;
        const ang = d >= 1 ? 0 : 2 * Math.acos(d);
        const w = ang > 1e-3 ? smooth(ang / OWN_FULL) : 0;
        if (w > 0) moved = true;
        own[i] = w > force[i] ? w : force[i];
        if (own[i] > 0) any = true;
      }
      const dx = bp.x - baseBody[0], dy = bp.y - baseBody[1], dz = bp.z - baseBody[2];
      if (dx * dx + dy * dy + dz * dz > 1e-8) { any = true; moved = true; }
      if (!any) {
        out = S.A;
        hip[0] = _hA[0]; hip[1] = _hA[1]; hip[2] = _hA[2];
      } else {
        worldOf(rig, S.A, S.W);
        deltasOf(rig, S.W, CD);
        for (let i = 0; i < SLOT_COUNT; i++) {
          if (!has[i]) continue;
          const o = i * 4;
          if (!(own[i] > 0)) { F[o] = CD[o]; F[o + 1] = CD[o + 1]; F[o + 2] = CD[o + 2]; F[o + 3] = CD[o + 3]; continue; }
          // what the game added since its base, laid over the clip…
          _a.fromArray(D, o); _b.fromArray(base, o).conjugate(); _c.fromArray(CD, o);
          _b.premultiply(_a).multiply(_c);
          // …giving way to the game's own angle as the difference grows
          _b.slerp(_a, own[i]).toArray(F, o);
        }
        solve(rig, F, has, out, null, S.A);
        let ho = 0;
        for (const i of LEGS) if (own[i] > ho) ho = own[i];
        hip[0] = _hA[0] + dx / s; hip[1] = _hA[1] + dy / s; hip[2] = _hA[2] + dz / s;
        hip[0] += (bp.x / s - hip[0]) * ho; hip[1] += (bp.y / s - hip[1]) * ho; hip[2] += (bp.z / s - hip[2]) * ho;
      }
    }
    const nk = ck ?? 'proc';
    if (nk !== key) {
      if (key !== null) {
        prev.set(cur); prevHip[0] = lastHip[0]; prevHip[1] = lastHip[1]; prevHip[2] = lastHip[2];
        fade = 0; fadeDur = nk === 'proc' || key === 'proc' ? 0.16 : 0.28;
      }
      key = nk;
    }
    if (fade < 1) {
      fade = Math.min(1, fade + dt / fadeDur);
      const w = smooth(fade);
      mixLocals(cur, prev, out, w, n * 4);
      for (let c = 0; c < 3; c++) hip[c] = prevHip[c] + (hip[c] - prevHip[c]) * w;
    } else cur.set(out.subarray(0, n * 4));
    lastHip[0] = hip[0]; lastHip[1] = hip[1]; lastHip[2] = hip[2];
    return hip;
  };

  /** Put `obj` (a child of the body's group) on a bone, in the game's joint frame. */
  const socket = (fig, slot, s, obj) => {
    const i = rig.slotBone[slot];
    if (i < 0) return;
    _m.fromArray(fig, i * 16).decompose(_v, _a, _s);
    _a.multiply(_b.fromArray(rig.C, i * 4).conjugate());
    obj.matrix.compose(_v.multiplyScalar(s), _a, _one);
    obj.matrixWorldNeedsUpdate = true;
  };

  return {
    cur, resolve, socket, sitClip, base: setBase,
    cut() { key = null; fade = 1; },
    /** True when nothing but a recorded clip is showing, so the baked far body can stand in. */
    canFar() { return st.kind !== 'proc' && !moved; },
    get key() { return key; },
  };
}
