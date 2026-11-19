// ---- birdmodel.js: one bird, drawn two hundred times in one call -------------
// Every bird in the world is an instance of ONE small mesh (about 70
// triangles): a body, a head, a beak, a tail and two wings. Species differ by
// the instance's scale and colour only (js/birdkinds.js), so a pigeon, a
// sparrow, a crow and a gull share the draw call.
//
// THE WINGS MOVE IN THE VERTEX SHADER. Each wing vertex knows which side it is
// on and how far out along the span it sits (`aWing`); each instance says where
// in the beat it is, how far the wings are open and how deep the beat is
// (`iFlap`). So a flying flock costs the CPU one small matrix per bird and
// nothing per vertex, and a bird sitting on a lamp costs nothing at all: its
// matrix is written once, and the peck of one on the pavement comes off a
// shared clock uniform.
//
// Frame: y up, the bird FACES -z like everything else that walks here, feet on
// the origin. Lengths are a town pigeon's (33 cm bill to tail, 66 cm across).

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';

/** Instances the one mesh holds: perched, flying and passing overhead together. */
export const BIRD_MAX = 420;

// where a wing is hinged, in the bird's own frame (the shader needs the same)
const ROOT_X = 0.04, ROOT_Y = 0.132, ROOT_Z = -0.022;
/** How far a standing bird carries its chest up, radians: in the air the owner levels it out by this much. */
export const REST_TILT = 0.42;

// grey per part: the instance colour is multiplied in, so this is the PATTERN
// (a darker head, dark primaries, a dark bill) and the colour is the species
function part(geo, shade) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), wing = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aWing', new THREE.BufferAttribute(wing, 2));
  g.deleteAttribute('uv');
  return g;
}

function ball(rx, ry, rz, x, y, z, shade, tilt = 0, ws = 6, hs = 4) {
  const g = new THREE.SphereGeometry(1, ws, hs).scale(rx, ry, rz);
  if (tilt) g.rotateX(tilt);
  return part(g.translate(x, y, z), shade);
}

// One wing as three stations (root, wrist, tip) of a flat sheet, two quads.
// side: -1 the bird's left (x < 0), +1 its right.
function wing(side) {
  const st = [
    // [x out from the root, leading z, trailing z, shade]
    [0.0, -0.062, 0.062, 0.92],
    [0.15, -0.058, 0.070, 0.80],
    [0.31, 0.012, 0.058, 0.50],
  ];
  const pos = [], col = [], aw = [], nor = [];
  const v = (i, lead) => {
    const s = st[i];
    pos.push(side * (ROOT_X + s[0]), ROOT_Y, ROOT_Z + (lead ? s[1] : s[2]));
    col.push(s[3], s[3], s[3]);
    aw.push(side, s[0] / 0.31);
    nor.push(0, 1, 0);
  };
  for (let i = 0; i < 2; i++) {
    // two triangles a quad, wound to face up on both sides of the bird
    const q = side > 0 ? [[i, 1], [i, 0], [i + 1, 0], [i, 1], [i + 1, 0], [i + 1, 1]]
      : [[i, 1], [i + 1, 0], [i, 0], [i, 1], [i + 1, 1], [i + 1, 0]];
    for (const [k, lead] of q) v(k, lead);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(aw, 2));
  return g;
}

function tail() {
  // a short fan behind the body, a little below its line
  const p = [0, 0.088, 0.062, -0.03, 0.046, 0.158, 0.03, 0.046, 0.158];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  return part(g, 0.62);
}

let _geo = null;
/** The shared bird geometry (position, normal, color, aWing). */
export function birdGeometry() {
  if (_geo) return _geo;
  const parts = [
    ball(0.048, 0.050, 0.092, 0, 0.108, 0.0, 1.0, REST_TILT),       // body: chest up, tail down
    ball(0.027, 0.040, 0.027, 0, 0.158, -0.056, 0.9, 0, 5, 3),      // neck
    ball(0.028, 0.028, 0.033, 0, 0.192, -0.070, 0.78, 0, 5, 3),     // head
    part(new THREE.ConeGeometry(0.010, 0.032, 4).rotateX(-Math.PI / 2).translate(0, 0.188, -0.112), 0.30),
    part(new THREE.BoxGeometry(0.008, 0.06, 0.008).translate(-0.02, 0.03, 0.006), 0.42),   // legs
    part(new THREE.BoxGeometry(0.008, 0.06, 0.008).translate(0.02, 0.03, 0.006), 0.42),
    tail(), wing(-1), wing(1),
  ];
  _geo = mergeGeometries(parts, false);
  _geo.computeBoundingSphere();
  return _geo;
}

/** The clock the perched birds peck by: one uniform for every bird. */
export const birdClock = { value: 0 };

const WING_GLSL = /* glsl */`
{
  float bSpread = iFlap.y;
  if ( aWing.x != 0.0 ) {
    float bs = aWing.x, bspan = aWing.y;
    vec3 broot = vec3( bs * ${ROOT_X.toFixed(3)}, ${ROOT_Y.toFixed(3)}, ${ROOT_Z.toFixed(3)} );
    vec3 brel = transformed - broot;
    // closed: the wing lies back along the flank, its tip over the tail
    brel.x *= mix( 0.10, 1.0, bSpread );
    brel.z += ( 1.0 - bSpread ) * bspan * 0.075;
    brel.y -= ( 1.0 - bSpread ) * ( bspan * 0.050 + ( brel.z + 0.06 ) * 0.30 );
    // open: the beat, the outer wing trailing the inner one by a little
    float ba = ( iFlap.z * sin( iFlap.x - bspan * 0.9 ) + 0.10 ) * bSpread * ( 0.55 + 0.75 * bspan );
    float bc = cos( ba ), bn = sin( ba ) * bs;
    transformed = broot + vec3( brel.x * bc - brel.y * bn, brel.x * bn + brel.y * bc, brel.z );
  }
  if ( bSpread < 0.5 && iFlap.z > 0.5 ) {
    // on the ground: two quick pecks now and then, tipping about the feet
    float bk = fract( uBirdT * 0.23 + iFlap.w );
    float bp = bk < 0.16 ? pow( sin( bk * 39.27 ), 2.0 ) * 0.72 * ( 1.0 - bSpread * 2.0 ) : 0.0;
    float pc = cos( bp ), ps = sin( bp );
    transformed = vec3( transformed.x, transformed.y * pc + transformed.z * ps, transformed.z * pc - transformed.y * ps );
  }
}`;

let _mat = null;
/** The one material: vertex pattern x instance colour, wings beaten in the shader. */
export function birdMaterial() {
  if (_mat) return _mat;
  _mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  _mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBirdT = birdClock;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aWing;\nattribute vec4 iFlap;\nuniform float uBirdT;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WING_GLSL);
  };
  _mat.customProgramCacheKey = () => 'atc-bird-3';
  return _mat;
}

/**
 * The instanced mesh every bird is a row of. `flap` is the per-instance
 * attribute the owner fills: (beat phase, wings open 0..1, beat depth in
 * radians OR 1 for "pecks on the ground" while closed, a seed 0..1).
 */
export function makeBirdMesh(max = BIRD_MAX) {
  const geo = birdGeometry().clone();
  const flap = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  flap.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iFlap', flap);
  const mesh = new THREE.InstancedMesh(geo, birdMaterial(), max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));       // allocates instanceColor
  mesh.frustumCulled = false;                         // rows are all over the neighbourhood
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  mesh.name = 'ptáci';
  return { mesh, flap };
}

export function disposeBirdAssets() {
  _geo?.dispose(); _geo = null;
  _mat?.dispose(); _mat = null;
}
