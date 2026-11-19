// ---- farbody.js: a person sixty metres away ----------------------------------
//
// Up close a human is a skinned mesh whose pose is computed every frame it is
// on screen (js/characters/human.js). A figure twenty pixels tall does not need
// that. Its walk, its standing and its sitting are baked ONCE per modelled
// person into a float texture: one row per frame of a clip, three texels per
// bone (the top three rows of the skinning matrix). The vertex shader reads the
// row it is told to and skins from it, so a far person costs the processor one
// number a frame: which row.
//
// That number rides in instanceColor.r. Each far body is an InstancedMesh of
// one instance, because a per-object uniform on a shared built-in material is
// not re-sent between two objects that draw back to back, and an instance
// attribute is. (It also means several far copies of one person can share a
// draw call later without touching the shader.)

import * as THREE from 'three';
import { patchPeopleMaterial } from '../peoplemat.js';
import { figureMatrices, skinMatrices } from './skinpose.js';
import { motionSet, roleClip } from './avatars.js';
import { sampleClip } from './clipbank.js';

const FAR_FPS = 20;       // rows a second for a walk
const IDLE_FPS = 6;       // standing still barely moves at this distance
const IDLE_MAX = 6;       // seconds of an idle loop that are baked

const VERT_HEAD = /* glsl */`
attribute vec4 skinIndex;
attribute vec4 skinWeight;
uniform highp sampler2D uFarPose;
mat4 farBone(float i, int row) {
  int x = int(i) * 3;
  vec4 a = texelFetch(uFarPose, ivec2(x, row), 0);
  vec4 b = texelFetch(uFarPose, ivec2(x + 1, row), 0);
  vec4 c = texelFetch(uFarPose, ivec2(x + 2, row), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 farSkin() {
  int row = int(instanceColor.r + 0.5);
  return farBone(skinIndex.x, row) * skinWeight.x + farBone(skinIndex.y, row) * skinWeight.y
    + farBone(skinIndex.z, row) * skinWeight.z + farBone(skinIndex.w, row) * skinWeight.w;
}
`;

/** The far material of one avatar: its own texture, skinned from the baked rows. */
function farMaterial(av) {
  if (av.farMat) return av.farMat;
  const m = av.farMaterial.clone();
  m.uniforms = { uFarPose: { value: av.farTex } };
  patchPeopleMaterial(m, 'people-far-1', (sh) => {
    sh.uniforms.uFarPose = m.uniforms.uFarPose;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      // the instance colour is a row number here, never a colour
      .replace('#include <color_vertex>', '#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )\n\tvColor = vec3( 1.0 );\n#endif\n#ifdef USE_COLOR\n\tvColor *= color;\n#endif')
      .replace('#include <beginnormal_vertex>', 'mat4 farM = farSkin();\nvec3 objectNormal = normalize( mat3( farM ) * normal );')
      .replace('#include <begin_vertex>', 'vec3 transformed = ( farM * vec4( position, 1.0 ) ).xyz;');
  });
  av.farMat = m;
  return m;
}

/**
 * Bake the far rows of one avatar. Returns the table { clip -> { row, frames,
 * fps } } it also leaves on av.farRows. Pure arithmetic until the DataTexture.
 */
export function bakeFar(av) {
  if (av.farRows) return av.farRows;
  motionSet(av);
  const n = av.rig.n, list = [];
  const add = (clip, fps, maxDur = Infinity) => {
    if (!clip || list.some((e) => e.clip === clip)) return;
    const dur = Math.min(clip.dur, maxDur);
    list.push({ clip, dur, frames: Math.max(1, Math.round(dur * fps)), fps });
  };
  for (const g of av.gaits) add(g.clip, FAR_FPS);
  if (av.idles[0]) add(av.idles[0], IDLE_FPS, IDLE_MAX);
  add(roleClip(av, 'sit'), IDLE_FPS, IDLE_MAX);
  // row 0 is the bind pose: what a body with no clip at all stands in
  let rows = 1;
  for (const e of list) { e.row = rows; rows += e.frames; }
  const W = n * 3, data = new Float32Array(W * rows * 4);
  const local = new Float32Array(n * 4), hip = [0, 0, 0], fig = new Float32Array(n * 16), skin = new Float32Array(n * 16);
  const put = (row) => {
    skinMatrices(fig, av.inv, n, skin);
    for (let i = 0; i < n; i++) {
      const o = (row * W + i * 3) * 4, s = i * 16;
      // three rows of the matrix: (m0 m4 m8 m12), (m1 m5 m9 m13), (m2 m6 m10 m14)
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) data[o + r * 4 + c] = skin[s + c * 4 + r];
    }
  };
  figureMatrices(av.rig, av.rig.restQ, null, av.root, fig); put(0);
  const table = new Map();
  for (const e of list) {
    for (let f = 0; f < e.frames; f++) {
      sampleClip(e.clip, (f / e.frames) * e.dur, local, hip);
      figureMatrices(av.rig, local, hip, av.root, fig);
      put(e.row + f);
    }
    table.set(e.clip, e);
  }
  const tex = new THREE.DataTexture(data, W, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  av.farTex = tex; av.farRows = table; av.farData = data; av.farWidth = W;
  return table;
}

/** Which baked row shows clip time `t` (seconds). 0 when the clip was not baked. */
export function farRow(av, clip, t) {
  const e = av.farRows?.get(clip);
  if (!e) return 0;
  let f = Math.floor((t / e.dur) * e.frames) % e.frames;
  if (f < 0) f += e.frames;
  return e.row + f;
}

/**
 * The far mesh of one human. `row` is set through setRow(); the owner shows
 * and hides it.
 */
export function makeFarBody(av) {
  bakeFar(av);
  const geo = av.farGeometry ?? av.geometry;
  const mesh = new THREE.InstancedMesh(geo, farMaterial(av), 1);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.castShadow = false;
  mesh.renderOrder = 1;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, av.height * 0.5, 0), av.height * 0.8);
  mesh.userData.row = 0;
  const setRow = (r) => {
    if (r === mesh.userData.row) return;
    mesh.userData.row = r;
    mesh.instanceColor.array[0] = r;
    mesh.instanceColor.needsUpdate = true;
  };
  return { mesh, setRow, dispose() { mesh.dispose(); } };
}
