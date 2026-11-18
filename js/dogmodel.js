// ---- dogmodel.js: one dog, drawn as rows of one mesh ---------------------------
// A body, a head on a neck, four legs and a tail, about 150 triangles, modelled
// as a labrador (58 cm at the shoulder) and scaled per row into a terrier or a
// dachshund (js/pedprops.js DOG_BREEDS). Like the birds, what moves moves in the
// vertex shader: each vertex knows which part it belongs to and where that
// part is hinged, and each row says where in the trot it is, how far the legs
// reach, how far down the nose is and how hard the tail is going.
//
// Frame: y up, the dog FACES -z, paws on y = 0.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';

export const DOG_MAX = 24;
/** Where the lead is clipped on: the collar, in the dog's own frame. */
export const COLLAR = Object.freeze({ y: 0.56, z: -0.27 });

// part: 0 the trunk, 1 the head and neck, 2..5 the legs (FL, FR, RL, RR), 6 the tail
function part(geo, shade, id, px, py, pz) {
  const g = geo.index ? geo.toNonIndexed() : geo, n = g.attributes.position.count;
  const col = new Float32Array(n * 3).fill(shade), ap = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { ap[i * 4] = px; ap[i * 4 + 1] = py; ap[i * 4 + 2] = pz; ap[i * 4 + 3] = id; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(ap, 4));
  g.deleteAttribute('uv');
  return g;
}
const ball = (rx, ry, rz, x, y, z, ws = 7, hs = 5) => new THREE.SphereGeometry(1, ws, hs).scale(rx, ry, rz).translate(x, y, z);

let _geo = null;
export function dogGeometry() {
  if (_geo) return _geo;
  const P = [];
  // the trunk: a deep chest and a lighter loin behind it
  P.push(part(ball(0.125, 0.135, 0.22, 0, 0.47, -0.12), 1.0, 0, 0, 0, 0));
  P.push(part(ball(0.105, 0.115, 0.22, 0, 0.475, 0.16), 1.0, 0, 0, 0, 0));
  // neck, skull, muzzle, nose and two hanging ears, hinged where the neck leaves the chest
  const nx = 0, ny = 0.50, nz = -0.27;
  P.push(part(ball(0.07, 0.10, 0.085, 0, 0.575, -0.335, 6, 4), 1.0, 1, nx, ny, nz));
  P.push(part(ball(0.082, 0.082, 0.098, 0, 0.665, -0.41, 7, 5), 1.0, 1, nx, ny, nz));
  P.push(part(new THREE.BoxGeometry(0.068, 0.058, 0.13).translate(0, 0.638, -0.52), 0.86, 1, nx, ny, nz));
  P.push(part(new THREE.BoxGeometry(0.036, 0.03, 0.022).translate(0, 0.655, -0.59), 0.16, 1, nx, ny, nz));
  for (const sx of [-1, 1]) {
    P.push(part(new THREE.BoxGeometry(0.022, 0.105, 0.07).rotateZ(sx * -0.22).translate(sx * 0.088, 0.655, -0.385), 0.62, 1, nx, ny, nz));
  }
  // legs: a thigh that tapers to the paw, hinged at the shoulder and at the hip
  const leg = (id, x, z, top) => {
    P.push(part(new THREE.CylinderGeometry(0.046, 0.03, top - 0.05, 6, 1).translate(x, (top + 0.05) / 2, z), 0.94, id, x, top, z));
    P.push(part(new THREE.BoxGeometry(0.056, 0.05, 0.085).translate(x, 0.025, z - 0.014), 0.9, id, x, top, z));
  };
  leg(2, -0.075, -0.2, 0.44); leg(3, 0.075, -0.2, 0.44);
  leg(4, -0.07, 0.27, 0.46); leg(5, 0.07, 0.27, 0.46);
  // the tail, carried up and back
  P.push(part(new THREE.CylinderGeometry(0.014, 0.028, 0.32, 5, 1).translate(0, 0.16, 0).rotateX(-0.95).translate(0, 0.53, 0.36), 0.95, 6, 0, 0.53, 0.36));
  _geo = mergeGeometries(P, false);
  _geo.computeBoundingSphere();
  return _geo;
}

/** The clock the tails wag by. */
export const dogClock = { value: 0 };

const DOG_GLSL = /* glsl */`
{
  float dId = aPart.w;
  vec3 dPiv = aPart.xyz;
  if ( dId > 1.5 && dId < 5.5 ) {
    // the trot: diagonal pairs together, each leg swinging about its own hinge
    float dOff = ( dId < 2.5 || dId > 4.5 ) ? 0.0 : 3.14159;
    float da = iDog.y * sin( iDog.x + dOff );
    vec3 dr = transformed - dPiv;
    float dc = cos( da ), ds = sin( da );
    // a paw lifts a little as it comes forward
    transformed = dPiv + vec3( dr.x, dr.y * dc + dr.z * ds + max( 0.0, -ds ) * iDog.y * 0.05, dr.z * dc - dr.y * ds );
  } else if ( dId > 0.5 && dId < 1.5 ) {
    // the head: down to the pavement to sniff, up to look about
    float da = iDog.z;
    vec3 dr = transformed - dPiv;
    float dc = cos( da ), ds = sin( da );
    transformed = dPiv + vec3( dr.x, dr.y * dc + dr.z * ds, dr.z * dc - dr.y * ds );
    transformed.y += min( 0.0, da ) * 0.10;
  } else if ( dId > 5.5 ) {
    float da = iDog.w * sin( uDogT * 11.0 + instanceMatrix[ 3 ].x * 3.0 );
    vec3 dr = transformed - dPiv;
    float dc = cos( da ), ds = sin( da );
    transformed = dPiv + vec3( dr.x * dc + dr.z * ds, dr.y, dr.z * dc - dr.x * ds );
  }
}`;

let _mat = null;
export function dogMaterial() {
  if (_mat) return _mat;
  _mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  _mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDogT = dogClock;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aPart;\nattribute vec4 iDog;\nuniform float uDogT;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DOG_GLSL);
  };
  _mat.customProgramCacheKey = () => 'atc-dog-1';
  return _mat;
}

/** The instanced mesh. `anim` rows: (trot phase, leg reach in radians, head pitch, tail wag). */
export function makeDogMesh(max = DOG_MAX) {
  const geo = dogGeometry().clone();
  const anim = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  anim.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iDog', anim);
  const mesh = new THREE.InstancedMesh(geo, dogMaterial(), max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.count = 0;
  mesh.name = 'psi';
  return { mesh, anim };
}

export function disposeDogAssets() {
  _geo?.dispose(); _geo = null;
  _mat?.dispose(); _mat = null;
}
