// ---- peopleshadows.js: who casts into the sun's shadow map --------------------
//
// Shared by every kind of body (js/citizen.js, js/characters/human.js): the
// distance at which a person turns into their far variant, and the list of
// live bodies the shadow pass is thinned from.

import * as THREE from 'three';
import { BATCH, onBatchFlag } from './batchflags.js';

// Where the distance variant takes over, metres from the rendering camera,
// with a gap so a person standing at the line does not flicker between two.
export const FAR_OUT = 62, FAR_IN = 55;

// A body's own LOD pick only runs for a person the CAMERA drew, so everybody behind
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
/** Every skinned body registers its near mesh (userData.far / .shNear are read here). */
export const trackBody = (mesh) => { _bodies.add(mesh); };
export const untrackBody = (mesh) => { _bodies.delete(mesh); };
const SH_GIVE = 3;
// metres round a body that its shadow may reach: a 1.8 m figure under a sun
// 10 degrees up throws some 10 m; the larger value holds a caster until it is
// well clear, the smaller one lets a new one in
const SH_REACH_KEEP = 14, SH_REACH_JOIN = 11;
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();

/** Once per shadow update: people whose shadow cannot reach the view stop casting. */
export function cullPeopleShadows(camera, r = 45, shadowSlope = 0) {
  if (!BATCH.shadows || !camera) return;
  camera.updateWorldMatrix(true, false);
  _pv.multiplyMatrices(camera.projectionMatrix, _pv.copy(camera.matrixWorld).invert());
  _frustum.setFromProjectionMatrix(_pv);
  const c = camera.matrixWorld.elements, cx = c[12], cy = c[13], cz = c[14];
  const rIn = (r - SH_GIVE) ** 2, rOut = (r + SH_GIVE) ** 2, far2 = (FAR_OUT + SH_GIVE) ** 2;
  const shadowReach = Math.max(SH_REACH_JOIN, 1.8 * shadowSlope);
  for (const m of _bodies) {
    const u = m.userData, e = m.matrixWorld.elements;
    const dx = e[12] - cx, dy = e[13] - cy, dz = e[14] - cz, d2 = dx * dx + dy * dy + dz * dz;
    let near = u.shNear ? d2 < rOut : d2 < rIn;
    if (!near && d2 < far2) {
      _sph.center.set(e[12], e[13], e[14]);
      _sph.radius = shadowReach + (u.shNear ? SH_REACH_KEEP - SH_REACH_JOIN : 0);
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

