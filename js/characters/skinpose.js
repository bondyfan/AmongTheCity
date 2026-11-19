// ---- skinpose.js: a skeleton as flat arrays ----------------------------------
//
// A downloaded human has fifty to seventy bones. As THREE.Bone objects in the
// scene graph that is seventy matrices composed and multiplied per person per
// frame by the scene's own traversal, on screen or not. Here the skeleton is
// numbers: local rotations in, the skinning matrices out, computed only for a
// body the camera is about to draw (js/characters/human.js) or once per frame
// of a clip when the far crowd's texture is baked (js/characters/farbody.js).
//
// Matrices are column-major 4x4 in flat Float32Arrays, as three.js keeps them.
// Bones are taken as unscaled: a rig's overall scale lives in `root`.

/**
 * Figure-space matrices of every bone.
 *   rig    js/characters/retarget.js describeRig()
 *   local  n * 4 local rotations
 *   hip    the hips' offset from rest in figure metres (3 numbers) or null
 *   root   16 numbers: the frame the top bones hang in, in figure space
 *   out    n * 16
 */
export function figureMatrices(rig, local, hip, root, out) {
  const { n, parent, restP, hips } = rig;
  let hx = 0, hy = 0, hz = 0;
  if (hip && hips >= 0) {
    // into the hips' parent space: rotate by hipInv, undo the rig's scale
    const q = rig.hipInv, k = 1 / rig.topS;
    const x = hip[0], y = hip[1], z = hip[2];
    const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x;
    const iw = -q.x * x - q.y * y - q.z * z;
    hx = (ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y) * k;
    hy = (iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z) * k;
    hz = (iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x) * k;
  }
  for (let i = 0; i < n; i++) {
    const x = local[i * 4], y = local[i * 4 + 1], z = local[i * 4 + 2], w = local[i * 4 + 3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    // the local matrix, rotation and translation only
    const l0 = 1 - (yy + zz), l1 = xy + wz, l2 = xz - wy;
    const l4 = xy - wz, l5 = 1 - (xx + zz), l6 = yz + wx;
    const l8 = xz + wy, l9 = yz - wx, l10 = 1 - (xx + yy);
    let tx = restP[i * 3], ty = restP[i * 3 + 1], tz = restP[i * 3 + 2];
    if (i === hips) { tx += hx; ty += hy; tz += hz; }
    const p = parent[i], P = p < 0 ? root : out, o = p < 0 ? 0 : p * 16, d = i * 16;
    const a0 = P[o], a1 = P[o + 1], a2 = P[o + 2], a4 = P[o + 4], a5 = P[o + 5], a6 = P[o + 6],
      a8 = P[o + 8], a9 = P[o + 9], a10 = P[o + 10], a12 = P[o + 12], a13 = P[o + 13], a14 = P[o + 14];
    out[d] = a0 * l0 + a4 * l1 + a8 * l2; out[d + 1] = a1 * l0 + a5 * l1 + a9 * l2; out[d + 2] = a2 * l0 + a6 * l1 + a10 * l2; out[d + 3] = 0;
    out[d + 4] = a0 * l4 + a4 * l5 + a8 * l6; out[d + 5] = a1 * l4 + a5 * l5 + a9 * l6; out[d + 6] = a2 * l4 + a6 * l5 + a10 * l6; out[d + 7] = 0;
    out[d + 8] = a0 * l8 + a4 * l9 + a8 * l10; out[d + 9] = a1 * l8 + a5 * l9 + a9 * l10; out[d + 10] = a2 * l8 + a6 * l9 + a10 * l10; out[d + 11] = 0;
    out[d + 12] = a0 * tx + a4 * ty + a8 * tz + a12; out[d + 13] = a1 * tx + a5 * ty + a9 * tz + a13;
    out[d + 14] = a2 * tx + a6 * ty + a10 * tz + a14; out[d + 15] = 1;
  }
  return out;
}

/** out[i] = fig[i] * inv[i]: what the skinning shader multiplies a vertex by. */
export function skinMatrices(fig, inv, n, out, at = 0) {
  for (let i = 0; i < n; i++) {
    const o = i * 16, d = at + i * 16;
    const a0 = fig[o], a1 = fig[o + 1], a2 = fig[o + 2], a4 = fig[o + 4], a5 = fig[o + 5], a6 = fig[o + 6],
      a8 = fig[o + 8], a9 = fig[o + 9], a10 = fig[o + 10], a12 = fig[o + 12], a13 = fig[o + 13], a14 = fig[o + 14];
    const b0 = inv[o], b1 = inv[o + 1], b2 = inv[o + 2], b4 = inv[o + 4], b5 = inv[o + 5], b6 = inv[o + 6],
      b8 = inv[o + 8], b9 = inv[o + 9], b10 = inv[o + 10], b12 = inv[o + 12], b13 = inv[o + 13], b14 = inv[o + 14];
    out[d] = a0 * b0 + a4 * b1 + a8 * b2; out[d + 1] = a1 * b0 + a5 * b1 + a9 * b2; out[d + 2] = a2 * b0 + a6 * b1 + a10 * b2; out[d + 3] = 0;
    out[d + 4] = a0 * b4 + a4 * b5 + a8 * b6; out[d + 5] = a1 * b4 + a5 * b5 + a9 * b6; out[d + 6] = a2 * b4 + a6 * b5 + a10 * b6; out[d + 7] = 0;
    out[d + 8] = a0 * b8 + a4 * b9 + a8 * b10; out[d + 9] = a1 * b8 + a5 * b9 + a9 * b10; out[d + 10] = a2 * b8 + a6 * b9 + a10 * b10; out[d + 11] = 0;
    out[d + 12] = a0 * b12 + a4 * b13 + a8 * b14 + a12; out[d + 13] = a1 * b12 + a5 * b13 + a9 * b14 + a13;
    out[d + 14] = a2 * b12 + a6 * b13 + a10 * b14 + a14; out[d + 15] = 1;
  }
  return out;
}

/**
 * The same for a surface bound to ANOTHER skeleton of the same family (a head
 * worn on somebody else's body): bone i of that surface follows fig[map[i]].
 */
export function skinMatricesMapped(fig, inv, n, map, out) {
  for (let i = 0; i < n; i++) {
    const o = (map[i] < 0 ? 0 : map[i]) * 16, b = i * 16, d = b;
    const a0 = fig[o], a1 = fig[o + 1], a2 = fig[o + 2], a4 = fig[o + 4], a5 = fig[o + 5], a6 = fig[o + 6],
      a8 = fig[o + 8], a9 = fig[o + 9], a10 = fig[o + 10], a12 = fig[o + 12], a13 = fig[o + 13], a14 = fig[o + 14];
    const b0 = inv[b], b1 = inv[b + 1], b2 = inv[b + 2], b4 = inv[b + 4], b5 = inv[b + 5], b6 = inv[b + 6],
      b8 = inv[b + 8], b9 = inv[b + 9], b10 = inv[b + 10], b12 = inv[b + 12], b13 = inv[b + 13], b14 = inv[b + 14];
    out[d] = a0 * b0 + a4 * b1 + a8 * b2; out[d + 1] = a1 * b0 + a5 * b1 + a9 * b2; out[d + 2] = a2 * b0 + a6 * b1 + a10 * b2; out[d + 3] = 0;
    out[d + 4] = a0 * b4 + a4 * b5 + a8 * b6; out[d + 5] = a1 * b4 + a5 * b5 + a9 * b6; out[d + 6] = a2 * b4 + a6 * b5 + a10 * b6; out[d + 7] = 0;
    out[d + 8] = a0 * b8 + a4 * b9 + a8 * b10; out[d + 9] = a1 * b8 + a5 * b9 + a9 * b10; out[d + 10] = a2 * b8 + a6 * b9 + a10 * b10; out[d + 11] = 0;
    out[d + 12] = a0 * b12 + a4 * b13 + a8 * b14 + a12; out[d + 13] = a1 * b12 + a5 * b13 + a9 * b14 + a13;
    out[d + 14] = a2 * b12 + a6 * b13 + a10 * b14 + a14; out[d + 15] = 1;
  }
  return out;
}

/** Invert n rigid-with-uniform-scale matrices (rotation * s, translation). */
export function invertRigid(m, n, out) {
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const a0 = m[o], a1 = m[o + 1], a2 = m[o + 2], a4 = m[o + 4], a5 = m[o + 5], a6 = m[o + 6],
      a8 = m[o + 8], a9 = m[o + 9], a10 = m[o + 10], tx = m[o + 12], ty = m[o + 13], tz = m[o + 14];
    const s2 = 1 / (a0 * a0 + a1 * a1 + a2 * a2);
    out[o] = a0 * s2; out[o + 1] = a4 * s2; out[o + 2] = a8 * s2; out[o + 3] = 0;
    out[o + 4] = a1 * s2; out[o + 5] = a5 * s2; out[o + 6] = a9 * s2; out[o + 7] = 0;
    out[o + 8] = a2 * s2; out[o + 9] = a6 * s2; out[o + 10] = a10 * s2; out[o + 11] = 0;
    out[o + 12] = -(a0 * tx + a1 * ty + a2 * tz) * s2; out[o + 13] = -(a4 * tx + a5 * ty + a6 * tz) * s2;
    out[o + 14] = -(a8 * tx + a9 * ty + a10 * tz) * s2; out[o + 15] = 1;
  }
  return out;
}
