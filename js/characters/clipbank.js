// ---- clipbank.js: animation clips, sampled once and kept as numbers ----------
//
// A clip arrives as keyframe tracks on the skeleton its author animated. The
// game wants something simpler and faster: for the skeleton it DRAWS, the
// local rotation of every bone at thirty frames a second, in one flat array.
// Baking does the retarget (js/characters/retarget.js) once, at load, so
// playing a clip is two array reads and a blend per bone, needs no
// AnimationMixer, and the same numbers can be written into a texture for the
// far crowd (js/characters/crowd.js).
//
// A baked clip: { name, dur, fps, frames, loop, q, hip }
//   q    Float32Array frames * bones * 4, local rotations of the TARGET rig
//   hip  Float32Array frames * 3, where the hips are against their rest
//        place, in figure metres of the target (x right, y up, z back)

import * as THREE from 'three';
import { SLOT, SLOT_COUNT, deltasOf, solve } from './retarget.js';

const _q = new THREE.Quaternion(), _p = new THREE.Quaternion(), _t = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();

/** True when two rigs are one skeleton: same names in the slots, same bind. */
export function sameRig(a, b) {
  if (a === b) return true;
  for (let s = 0; s < SLOT_COUNT; s++) {
    const i = a.slotBone[s], j = b.slotBone[s];
    if ((i < 0) !== (j < 0)) return false;
    if (i < 0) continue;
    if (a.names[i] !== b.names[j]) return false;
    let d = 0;
    for (let k = 0; k < 4; k++) d += a.C[i * 4 + k] * b.C[j * 4 + k];
    if (Math.abs(d) < 0.999) return false;
  }
  return true;
}

/**
 * Bake `clip` (a THREE.AnimationClip authored on `src`) for `tgt`.
 *   fps     samples a second (default 30)
 *   loop    the last frame meets the first (default true)
 *   travel  what to do with the hips' horizontal travel:
 *           'none' pins them over the feet (a walk on the spot),
 *           'keep' leaves the motion as authored
 *   from, to  seconds: bake only this part of the clip
 */
export function bakeClip(clip, src, tgt, { fps = 30, loop = true, travel = 'none', from = null, to = clip.duration,
  name = clip.name, direct = null } = {}) {
  // one interpolant per animated property of a source bone
  const n = tgt.n, ns = src.n;
  const rot = new Array(ns).fill(null), pos = new Array(ns).fill(null);
  let first = Infinity;
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    const i = src.names.indexOf(tr.name.slice(0, dot));
    if (i < 0) continue;
    const prop = tr.name.slice(dot + 1);
    if (prop === 'quaternion') rot[i] = tr.createInterpolant(new Float32Array(4));
    else if (prop === 'position') pos[i] = tr.createInterpolant(new Float32Array(3));
    else continue;
    if (tr.times.length && tr.times[0] < first) first = tr.times[0];
  }
  // a clip exported from frame 1 has its first key a frame in: start there,
  // or a loop would hold that pose for a frame every time round
  if (from == null) from = Number.isFinite(first) ? Math.min(first, to) : 0;
  const dur = Math.max(1 / fps, to - from);
  const frames = Math.max(2, Math.round(dur * fps) + (loop ? 0 : 1));
  // `direct`: the clip's own local rotations are right for the target as they
  // are (one skeleton family). Forced by the caller when the clip file's rest
  // pose is not a bind pose and so cannot be calibrated against.
  if (direct == null) direct = sameRig(src, tgt);
  // target bone -> source bone of the same name, and whether their parents are
  // the same bone too. Where they are not (the hips of a rig whose root motion
  // rides on a node the target does not have), the WORLD rotation is carried.
  const sIdx = direct ? tgt.names.map((nm) => src.names.indexOf(nm)) : null;
  const sameParent = direct ? sIdx.map((i, j) => i >= 0 && tgt.parent[j] >= 0 && src.parent[i] >= 0 && sIdx[tgt.parent[j]] === src.parent[i]) : null;
  const q = new Float32Array(frames * n * 4), hip = new Float32Array(frames * 3);
  const local = new Float32Array(ns * 4), world = new Float32Array(ns * 4), wpos = new Float32Array(ns * 3), wscl = new Float32Array(ns);
  const tworld = new Float32Array(n * 4);
  const delta = new Float32Array(SLOT_COUNT * 4), has = new Uint8Array(SLOT_COUNT);
  const sh = src.hips, th = tgt.hips;
  // a longer leg carries the hips higher and further with the same pose
  const legS = src.dims.thigh + src.dims.shin, legT = tgt.dims.thigh + tgt.dims.shin;
  const k = legS > 0 && legT > 0 ? legT / legS : 1;
  for (let f = 0; f < frames; f++) {
    const t = from + (loop ? f / frames : f / (frames - 1)) * dur;
    for (let i = 0; i < ns; i++) {
      const p = src.parent[i];
      if (rot[i]) { const r = rot[i].evaluate(t); _q.set(r[0], r[1], r[2], r[3]).normalize(); } else _q.fromArray(src.restQ, i * 4);
      _q.toArray(local, i * 4);
      if (pos[i]) { const r = pos[i].evaluate(t); _v.set(r[0], r[1], r[2]); } else _v.fromArray(src.restP, i * 3);
      let ps = src.topS;
      if (p < 0) { _p.copy(src.topQ); _w.copy(src.topP); } else { _p.fromArray(world, p * 4); _w.fromArray(wpos, p * 3); ps = wscl[p]; }
      wscl[i] = ps * (src.restS ? src.restS[i] : 1);
      _v.multiplyScalar(ps).applyQuaternion(_p).add(_w).toArray(wpos, i * 3);
      _p.multiply(_q).toArray(world, i * 4);
    }
    const o = f * n * 4;
    if (direct) {
      for (let j = 0; j < n; j++) {
        const i = sIdx[j], p = tgt.parent[j];
        if (p < 0) _p.copy(tgt.topQ); else _p.fromArray(tworld, p * 4);
        if (i < 0) _q.fromArray(tgt.restQ, j * 4);
        else if (sameParent[j]) _q.fromArray(local, i * 4);
        else _q.copy(_p).conjugate().multiply(_t.fromArray(world, i * 4));
        _q.toArray(q, o + j * 4);
        _p.multiply(_q).toArray(tworld, j * 4);
      }
    } else {
      deltasOf(src, world, delta, has);
      solve(tgt, delta, has, q.subarray(o, o + n * 4));
    }
    // the hips in the source's figure space, at the target's size
    if (sh >= 0) for (let c = 0; c < 3; c++) hip[f * 3 + c] = wpos[sh * 3 + c] * k;
  }
  // sideways and along: against where the clip starts. Height: against the
  // target's own standing hips (grounded properly by groundClip, below).
  const x0 = hip[0], z0 = hip[2], x1 = hip[(frames - 1) * 3], z1 = hip[(frames - 1) * 3 + 2];
  const restY = th >= 0 ? tgt.worldP[th * 3 + 1] : 0;
  // what a looping clip covers in one cycle: the last frame is one short of it
  const step = loop ? frames / (frames - 1) : 1;
  const gone = Math.hypot(x1 - x0, z1 - z0) * step;
  for (let f = 0; f < frames; f++) {
    const u = travel === 'none' && gone > 0.2 ? f / (frames - 1) : 0;
    hip[f * 3] -= x0 + (x1 - x0) * u; hip[f * 3 + 1] -= restY; hip[f * 3 + 2] -= z0 + (z1 - z0) * u;
  }
  // tx, tz: the same travel as a figure-space vector (+z is backwards), so the
  // owner of a pinned one-off (a stagger, a fall) can move the body as far
  // and the same way as the recording did
  return { name, dur, fps: frames / dur, frames, loop, q, hip, bones: n, travel: gone, tx: (x1 - x0) * step, tz: (z1 - z0) * step };
}

/**
 * Stand a baked clip on the ground. `footY(f)` is the height of the lower
 * ankle at frame f with the hips as baked; `ankleY` is where an ankle sits
 * when the body stands. The whole clip moves by one amount, taken from the
 * frames where a foot is down (the lowest tenth), so a jump still leaves the
 * ground and a walk no longer floats on a body with shorter legs.
 */
export function groundClip(bk, footY, ankleY) {
  const ys = [];
  for (let f = 0; f < bk.frames; f++) ys.push(footY(f));
  ys.sort((a, b) => a - b);
  const low = ys[Math.floor((ys.length - 1) * 0.1)];
  const d = ankleY - low;
  for (let f = 0; f < bk.frames; f++) bk.hip[f * 3 + 1] += d;
  return d;
}

/** Turn a looping clip so that frame `at` becomes frame 0. */
export function rollClip(bk, at) {
  if (!bk.loop || !(at > 0)) return bk;
  const n4 = bk.bones * 4, q = bk.q.slice(), hip = bk.hip.slice();
  for (let f = 0; f < bk.frames; f++) {
    const s = (f + at) % bk.frames;
    bk.q.set(q.subarray(s * n4, s * n4 + n4), f * n4);
    bk.hip.set(hip.subarray(s * 3, s * 3 + 3), f * 3);
  }
  return bk;
}

/**
 * The pose at `t` seconds into a baked clip. Writes n local rotations into
 * `out` and the hips' offset into `hipOut` (three numbers). Looping clips
 * wrap, the others hold their last frame.
 */
export function sampleClip(bk, t, out, hipOut) {
  const { frames, q, hip, bones } = bk;
  let x = (t / bk.dur) * (bk.loop ? frames : frames - 1);
  if (bk.loop) { x %= frames; if (x < 0) x += frames; } else x = x < 0 ? 0 : x > frames - 1 ? frames - 1 : x;
  const f0 = Math.floor(x), w = x - f0, f1 = bk.loop ? (f0 + 1) % frames : Math.min(frames - 1, f0 + 1);
  const a = f0 * bones * 4, b = f1 * bones * 4, v = 1 - w;
  for (let i = 0, m = bones * 4; i < m; i += 4) {
    const ax = q[a + i], ay = q[a + i + 1], az = q[a + i + 2], aw = q[a + i + 3];
    let bx = q[b + i], by = q[b + i + 1], bz = q[b + i + 2], bw = q[b + i + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    const x1 = ax * v + bx * w, y1 = ay * v + by * w, z1 = az * v + bz * w, w1 = aw * v + bw * w;
    const l = 1 / Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1 + w1 * w1);
    out[i] = x1 * l; out[i + 1] = y1 * l; out[i + 2] = z1 * l; out[i + 3] = w1 * l;
  }
  if (hipOut) for (let c = 0; c < 3; c++) hipOut[c] = hip[f0 * 3 + c] * v + hip[f1 * 3 + c] * w;
  return out;
}

/** out = a moved toward b by w, bone by bone (normalised lerp, short way round). */
export function mixLocals(out, a, b, w, count = out.length) {
  if (w <= 0) { if (out !== a) out.set(a.subarray(0, count)); return out; }
  const v = 1 - w;
  for (let i = 0; i < count; i += 4) {
    const ax = a[i], ay = a[i + 1], az = a[i + 2], aw = a[i + 3];
    let bx = b[i], by = b[i + 1], bz = b[i + 2], bw = b[i + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    const x1 = ax * v + bx * w, y1 = ay * v + by * w, z1 = az * v + bz * w, w1 = aw * v + bw * w;
    const l = 1 / Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1 + w1 * w1);
    out[i] = x1 * l; out[i + 1] = y1 * l; out[i + 2] = z1 * l; out[i + 3] = w1 * l;
  }
  return out;
}

export { SLOT };
