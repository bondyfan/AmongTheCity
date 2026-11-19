// ---- rawclips.js: the clip file of the people bank ----------------------------------
//
// public/assets/people/clips.bin is every recorded clip of one skeleton family
// in one download (scripts/people/bake-clips.mjs wrote it): a JSON header, then
// 16-bit rotations frame after frame. This turns it back into what
// js/characters/avatars.js expects of an animation file: the skeleton the
// clips were made on, and a clip per name. A clip's keyframe tracks are only
// built when somebody first plays it.

import * as THREE from 'three';

/** Parse a clips.bin ArrayBuffer -> { family, faces, scene, clips: Map(name -> () => AnimationClip) }. */
export function readClipFile(buffer) {
  const view = new DataView(buffer);
  const hl = view.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hl)));
  const base = 4 + hl, rig = head.rig, n = rig.names.length;
  // the skeleton as plain objects: the retargeting only reads names, parents and rest transforms
  const scene = new THREE.Group();
  const nodes = rig.names.map((name, i) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.quaternion.fromArray(rig.restQ, i * 4);
    o.position.fromArray(rig.restP, i * 3);
    o.scale.setScalar(rig.restS[i]);
    return o;
  });
  nodes.forEach((o, i) => (rig.parent[i] < 0 ? scene : nodes[rig.parent[i]]).add(o));
  const clips = new Map();
  for (const c of head.clips) {
    let made = null;
    clips.set(c.name, () => {
      if (made) return made;
      const times = new Float32Array(c.keys);
      for (let k = 0; k < c.keys; k++) times[k] = k / c.fps;
      // the nodes that move have a rotation per key; the rest (fingers, end
      // nodes) hold the one they had on the clip's first frame
      const mv = rig.move ?? rig.names.map((_, i) => i), m = mv.length;
      const q = new Int16Array(buffer, base + c.q, c.keys * m * 4), tracks = [];
      const hold = c.hold != null ? new Int16Array(buffer, base + c.hold, n * 4) : null, one = new Float32Array([0]);
      for (let i = 0; i < n; i++) {
        const slot = mv.indexOf(i);
        if (slot < 0) {
          if (hold) tracks.push(new THREE.QuaternionKeyframeTrack(rig.names[i] + '.quaternion', one, Float32Array.from(hold.subarray(i * 4, i * 4 + 4), (x) => x / 32767)));
          continue;
        }
        const v = new Float32Array(c.keys * 4);
        for (let k = 0; k < c.keys; k++) for (let x = 0; x < 4; x++) v[k * 4 + x] = q[(k * m + slot) * 4 + x] / 32767;
        tracks.push(new THREE.QuaternionKeyframeTrack(rig.names[i] + '.quaternion', times, v));
      }
      for (const [i, off] of c.pos) {
        tracks.push(new THREE.VectorKeyframeTrack(rig.names[i] + '.position', times, new Float32Array(buffer.slice(base + off, base + off + c.keys * 12))));
      }
      return (made = new THREE.AnimationClip(c.name, (c.keys - 1) / c.fps, tracks));
    });
  }
  return { family: head.family, faces: head.faces, scene, clips, moved: rig.names };
}
