// ---- treeshader.js: what a tree is drawn with --------------------------------
// Five materials, one set of numbers. The two FAR materials (mats.trunk and
// mats.crown, built in makeMaterials) draw every tree a chunk carries; the NEAR
// material draws the detailed models js/trees.js puts round the camera; two
// depth materials let both tiers throw the right shadow.
//
// All of them are stock three materials with a few chunks patched, never
// replaced: the fog, shadow and tone-mapping includes that wave 1 rewrote at
// import (js/heightfog.js, js/sky.js) are left exactly where they are, so a
// tree fogs, shades and exposes like the wall behind it.
//
// What the patches add:
//   * WIND. A slow sway of the whole tree plus a flutter of the leaves, applied
//     AFTER the instance matrix, in metres. That order matters: the worker
//     ships the far templates quantised with the dequantisation folded into
//     the instance matrices, so nothing here may trust a template coordinate or
//     a matrix column on its own, only their product.
//   * THE SWAP. uTreeNear holds the camera and a radius band. Across it the far
//     instance thins out and the near one fills in, each staying WHOLE over its
//     own half of the band, so there is always a solid tree behind the one that
//     is fading and the sky never shows through a crown. The thinning is alpha
//     to coverage: MSAA resolves it to a soft edge. (It was a per-pixel screen
//     door, and every tree 44 to 54 m away wore a dot pattern against the sky.)
//   * LEAVES. A small tiling 3D noise turns the crown's flat colour into clumps
//     of lit and shaded foliage, and eats a ragged edge out of every lobe where
//     it turns away from the eye, which is what stops a crown being a balloon.
//   * BACKLIGHT. Leaves pass light: the side turned from the sun is not black.
//   * STREET LIGHT, on the direct path only (post off, the low preset). The
//     composite lights a tree from the lamp map on the other tiers; without it
//     a trunk beside a lamp stood black on a lit pavement. The same map is read
//     here (js/lampmap.js). Leaves take well under half of it: a crown's colour
//     is tuned for a sun that shades it, and at full strength every leaf near
//     a lamp was daylight green.
//
// In the worker import graph (through js/meshes.js): the texture is made only
// when a program first compiles, which only ever happens on the main thread.

import * as THREE from 'three';
import { COVERAGE } from './coverage.js';
import { LAMP_DIRECT_U, LAMP_DIRECT_GLSL, LAMP_DIRECT_WORLD } from './lampmap.js';

// One object each, shared by every tree program: three uploads a uniform from
// whatever .value holds when the program is next used, so writing here once a
// frame (js/trees.js) moves every tree.
export const TREE_U = {
  // x: seconds on the shared clock, folded to 512 s. y: strength. zw: direction.
  uTreeWind: { value: new THREE.Vector4(0, 1, 0.83, 0.56) },
  // xy: camera x, z in world metres. z, w: the band the swap happens across.
  // 0, 0 means "no near tier": every far tree is drawn whole.
  uTreeNear: { value: new THREE.Vector4(0, 0, 0, 0) },
  uLeafTex: { value: null },
  // x: sunlight a crown lets through whichever way a leaf faces, y: extra on
  // the side turned from the sun, z: how much of every lobe's rim is eaten,
  // w: how much more the noise eats
  uTreeK: { value: new THREE.Vector4(0.16, 0.30, 0.10, 0.95) },
  // x, y: metres-to-noise scale of the clumps and of the leaves,
  // z, w: how deep each of them shades the colour
  uTreeK2: { value: new THREE.Vector4(0.15, 0.85, 0.70, 0.62) },
  // 1 where the frame is multisampled, 0 where it is not (js/coverage.js): the
  // swap and the ragged edge are alpha to coverage and need the other answer
  uCoverage: COVERAGE,
};

// 32³ of tiling noise, two channels. R is cellular (distance to the nearest of
// a few scattered points), which is what a mass of leaf clusters looks like.
// G is plain value noise. Mipmapped, so a far crown averages to its mean
// instead of crawling.
const N = 32;
function leafTexture() {
  const data = new Uint8Array(N * N * N * 2);
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d);
    seed = Math.imul(seed ^ (seed >>> 12), 0x297a2d39);
    return ((seed ^= seed >>> 15) >>> 0) / 4294967296;
  };
  const C = 8, CELL = N / C, pts = new Float32Array(C * C * C * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = rand();
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    let best = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j, gz = cz + k;
      const p = (((gz + C) % C) * C * C + ((gy + C) % C) * C + ((gx + C) % C)) * 3;
      const dx = (gx + pts[p]) * CELL - x, dy = (gy + pts[p + 1]) * CELL - y, dz = (gz + pts[p + 2]) * CELL - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    const o = ((z * N + y) * N + x) * 2;
    data[o] = Math.round(255 * Math.max(0, 1 - Math.sqrt(best) / (CELL * 0.85)));
    data[o + 1] = Math.round(255 * rand());
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const PARS_V = /* glsl */`
uniform vec4 uTreeWind;
uniform vec4 uTreeNear;
varying vec3 vTreePos;
varying float vTreeFade;
#ifdef TREE_NEAR
	attribute vec3 aGeoN;
	varying vec3 vTreeN;
	varying float vTreeLeaf;
#endif
// rel: the vertex from its tree's origin, metres. w: how much of the sway this
// vertex takes (0 at the root). leaf: 1 on foliage, 0 on wood.
// Every rate is a whole number of turns in 512 s, the period the clock folds at.
vec3 treeWind( vec3 rel, vec3 org, float w, float leaf ) {
	float t = uTreeWind.x;
	float ph = dot( org.xz, vec2( 0.071, 0.113 ) );
	float gust = 0.55 + 0.45 * sin( t * 0.31907 + ph );
	float sway = 0.6 * sin( t * 2.20893 + ph * 3.1 ) + 0.4 * sin( t * 1.34990 + ph * 1.7 );
	float amp = uTreeWind.y * w * ( 0.012 * length( rel ) + 0.02 ) * gust;
	vec3 d = vec3( uTreeWind.z, 0.0, uTreeWind.w ) * ( amp * ( 0.5 + sway ) );
	float fl = sin( t * 5.52233 + dot( rel, vec3( 1.7, 2.3, 1.3 ) ) + ph );
	return d + vec3( fl, fl * 0.6, - fl ) * ( 0.011 * leaf * uTreeWind.y * gust );
}`;

// Replaces <project_vertex>. Same result as the stock chunk when the wind is
// still and the swap band is empty.
const PROJECT_V = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
	vec3 tOrg = instanceMatrix[ 3 ].xyz;
#else
	vec3 tOrg = vec3( 0.0 );
#endif
vec3 tRel = mvPosition.xyz - tOrg;
vec3 tOrgW = ( modelMatrix * vec4( tOrg, 1.0 ) ).xyz;
#ifdef TREE_NEAR
	mvPosition.xyz += treeWind( tRel, tOrgW, uv.x, uv.y );
#elif defined( TREE_CROWN )
	mvPosition.xyz += treeWind( tRel, tOrgW, uv.x, 1.0 );
#else
	mvPosition.xyz += treeWind( tRel, tOrgW, uv.x, 0.0 );
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
float tFade = clamp( ( distance( tOrgW.xz, uTreeNear.xy ) - uTreeNear.z ) / max( uTreeNear.w - uTreeNear.z, 0.001 ), 0.0, 1.0 );
#ifdef TREE_NEAR
	tFade = 1.0 - tFade;
#elif defined( TREE_CROWN )
	// a shrub has no near model: it is the far blob at any distance
	if ( abs( tSp - 9.0 ) < 0.5 ) tFade = 1.0;
#endif
#ifdef TREE_DEPTH
	// a shadow has no screen door: whichever tier is the more visible casts
	if ( tFade < 0.5 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
#else
	vTreeFade = tFade;
	// a different patch of the noise for every tree, or an avenue is a stencil
	vTreePos = tRel + fract( tOrgW.xzx * vec3( 0.137, 0.291, 0.073 ) ) * 19.0;
	if ( tFade <= 0.0 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
	#ifdef TREE_NEAR
		vec3 tN = aGeoN;
		#ifdef USE_INSTANCING
			mat3 tM = mat3( instanceMatrix );
			tN /= vec3( dot( tM[ 0 ], tM[ 0 ] ), dot( tM[ 1 ], tM[ 1 ] ), dot( tM[ 2 ], tM[ 2 ] ) );
			tN = tM * tN;
		#endif
		vTreeN = normalize( normalMatrix * tN );
		vTreeLeaf = uv.y;
	#endif
#endif`;

// A spruce is the one species the far blob cannot be scaled into: the shader
// draws it in to a point, by the height each vertex carries in uv.y. The
// species is the tag in the colour's low bits (js/treeshapes.js crownColor).
const BEGIN_V = /* glsl */`
#include <begin_vertex>
#if defined( TREE_CROWN ) && defined( USE_INSTANCING_COLOR )
	vec3 tTag = floor( instanceColor * 255.0 + 0.5 );
	float tSp = mod( tTag.r, 4.0 ) * 4.0 + mod( tTag.b, 4.0 );
	if ( abs( tSp - 6.0 ) < 0.5 ) transformed.xz *= mix( 1.45, 0.05, pow( uv.y, 0.8 ) );
#else
	float tSp = 0.0;
#endif`;

const PARS_F = /* glsl */`
uniform mediump sampler3D uLeafTex;
uniform vec4 uTreeK;
uniform vec4 uTreeK2;
varying vec3 vTreePos;
varying float vTreeFade;
uniform float uCoverage;
#ifdef TREE_NEAR
	varying vec3 vTreeN;
	varying float vTreeLeaf;
#endif
float treeAlpha = 1.0;`;

const COLOR_F = /* glsl */`
#include <color_fragment>
{
	// the swap: whole over this tier's own half of the band, thinning to nothing
	// across the other half. The noise only softens the four coverage steps of
	// MSAA (half a step of it), it is not the pattern itself.
	float tSwap = clamp( vTreeFade * 2.0, 0.0, 1.0 );
	if ( tSwap < 1.0 ) {
		float tIgn = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
		tSwap = clamp( tSwap + ( tIgn - 0.5 ) * 0.125, 0.0, 1.0 );
	}
	#ifdef TREE_NEAR
		float tLeaf = vTreeLeaf;
		vec3 tNv = normalize( vTreeN );
	#else
		#ifdef TREE_CROWN
			float tLeaf = 1.0;
			vec3 tNv = normalize( vNormal );
		#else
			float tLeaf = 0.0;
			vec3 tNv = vec3( 0.0, 0.0, 1.0 );
		#endif
	#endif
	// bark: streaks that run up the trunk (a far crown has no wood to draw, so
	// it does not pay for the fetch)
	#ifdef TREE_CROWN
		vec3 tBark = diffuseColor.rgb;
	#else
		float tBk = texture( uLeafTex, vTreePos * vec3( 0.42, 0.045, 0.42 ) ).g;
		vec3 tBark = diffuseColor.rgb * mix( 0.74, 1.16, tBk );
	#endif
	#if defined( TREE_NEAR ) || defined( TREE_CROWN )
		vec2 tA = texture( uLeafTex, vTreePos * uTreeK2.x ).rg;
		vec2 tB = texture( uLeafTex, vTreePos * uTreeK2.y + 0.37 ).rg;
		// clumps of foliage, lit and shaded, the lit ones a little yellower
		vec3 tCol = diffuseColor.rgb * ( 1.0 + uTreeK2.z * ( tA.r - 0.42 ) ) * ( 1.0 + uTreeK2.w * ( tB.r - 0.4 ) );
		tCol = mix( tCol, tCol * vec3( 1.24, 1.10, 0.60 ), tA.r * tB.r * 0.6 );
		#ifdef TREE_NEAR
			// The near model bakes its creases and its underside into the vertex
			// colour (treemodels.js), about a seventh darker on average than the
			// far blob of the same tree: a visible step across the swap band.
			tCol *= 1.15;
		#endif
		diffuseColor.rgb = mix( tBark, tCol, tLeaf );
		// the ragged edge: where a lobe turns away from the eye the leaves thin
		// out, by the same noise, so no silhouette is a smooth arc
		float tNdv = abs( dot( tNv, normalize( vViewPosition ) ) );
		float tEdge = tNdv - ( uTreeK.z + uTreeK.w * ( 1.0 - tB.r ) * ( 0.5 + 0.5 * tA.g ) );
		float tA2c = clamp( tEdge / max( fwidth( tEdge ), 0.0001 ) + 0.5, 0.0, 1.0 );
		treeAlpha = mix( 1.0, tA2c, tLeaf ) * tSwap;
	#else
		diffuseColor.rgb = tBark;
		treeAlpha = tSwap;
	#endif
	// NO MULTISAMPLING (js/coverage.js): the alpha above would simply be
	// ignored, both tiers would stand whole across the band and every crown
	// would be a balloon. So: one tier per tree, changing hands at the middle
	// of the band (the fade is per tree, so a tree never shows half of each),
	// and the leafy edge as a plain cut-out.
	if ( uCoverage < 0.5 ) {
		#if defined( TREE_NEAR ) || defined( TREE_CROWN )
			treeAlpha = ( vTreeFade < 0.5 ) ? 0.0 : step( 0.5, mix( 1.0, tA2c, tLeaf ) );
		#else
			treeAlpha = step( 0.5, vTreeFade );
		#endif
	}
	if ( treeAlpha < 0.04 ) discard;
}`;

const LIGHTS_F = /* glsl */`
#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
{
	#ifdef TREE_NEAR
		float tThru = vTreeLeaf;
	#elif defined( TREE_CROWN )
		float tThru = 1.0;
	#else
		float tThru = 0.0;
	#endif
	// NOT shadowed, on purpose: the shadow map would call the far side of a
	// crown "in shadow" of its own near side, which is exactly the light this
	// is. Wood gets a share too: the light a crown scatters down its own trunk,
	// without which a trunk under a dense crown at noon is a black post.
	float tBack = max( 0.0, - dot( normal, directionalLights[ 0 ].direction ) );
	vec3 tTint = mix( vec3( 1.0, 0.95, 0.82 ), vec3( 1.10, 1.0, 0.45 ), tThru );
	reflectedLight.directDiffuse += directionalLights[ 0 ].color * diffuseColor.rgb * tTint
		* ( ( uTreeK.x + tBack * uTreeK.y * tThru ) * RECIPROCAL_PI * ( 0.5 + 0.5 * tThru ) );
}
#endif
if ( uLampDK.x > 0.5 ) {
	#ifdef TREE_NEAR
		float tLampLeaf = vTreeLeaf;
	#elif defined( TREE_CROWN )
		float tLampLeaf = 1.0;
	#else
		float tLampLeaf = 0.0;
	#endif${LAMP_DIRECT_WORLD}
	// the pool quads are drawn over the static world and paint a trunk's foot
	// themselves: cut = 1 leaves everything under their plane to them
	vec3 tLamp = atcLampDirect( atcLampW, atcLampUp, 1.0, diffuseColor.rgb );
	// leaves: duller and toward olive, the same rule the composite applies
	tLamp = mix( tLamp, vec3( dot( tLamp, vec3( 0.30, 0.59, 0.11 ) ) ) * vec3( 0.95, 1.0, 0.70 ), 0.65 * tLampLeaf )
		* ( 1.0 - 0.52 * tLampLeaf );
	reflectedLight.indirectDiffuse += tLamp;
}`;

function patch(kind) {
  return (shader) => {
    Object.assign(shader.uniforms, TREE_U, LAMP_DIRECT_U);
    if (!TREE_U.uLeafTex.value) TREE_U.uLeafTex.value = leafTexture();
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS_V)
      .replace('#include <begin_vertex>', BEGIN_V)
      .replace('#include <project_vertex>', PROJECT_V);
    if (kind === 'near') {
      // wood keeps its own colour: the instance colour is the LEAF colour
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>',
        '#include <color_vertex>\n\tif ( uv.y < 0.5 ) vColor.rgb = color;');
    }
    if (shader.fragmentShader.includes('#include <color_fragment>')) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + PARS_F + LAMP_DIRECT_GLSL)
        .replace('#include <color_fragment>', COLOR_F)
        .replace('#include <lights_fragment_end>', LIGHTS_F)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\tgl_FragColor.a = treeAlpha;');
    }
  };
}

function dress(mat, kind, defines) {
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  mat.onBeforeCompile = patch(kind);
  // three keys a program on onBeforeCompile's SOURCE, and the five patches
  // share one: without a key of their own they would share one program too
  mat.customProgramCacheKey = () => 'atc-tree-lamp-' + kind;
  return mat;
}

/** The two far materials every chunk's tree InstancedMeshes share. */
export function farTreeMaterials() {
  // white: the bark and the leaf colour are per instance, the shading per vertex
  const trunk = dress(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    'trunk', { TREE_TRUNK: '' });
  const crown = dress(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    'crown', { TREE_CROWN: '' });
  // the ragged edge and the swap are alpha, resolved by MSAA into coverage,
  // not blended
  crown.alphaToCoverage = true;
  trunk.alphaToCoverage = true;
  return { trunk, crown };
}

/** The material of the near models: wood and leaves in one mesh. */
export function nearTreeMaterial() {
  const m = dress(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    'near', { TREE_NEAR: '' });
  m.alphaToCoverage = true;
  return m;
}

/**
 * The shadow of a tree. Without it the default depth material would draw every
 * far tree whole, so a tree inside the near radius would cast two shadows (and
 * the hidden blob's would fall on the model standing inside it).
 */
export function treeDepthMaterial(kind) {
  const defines = { TREE_DEPTH: '' };
  if (kind === 'near') defines.TREE_NEAR = '';
  else if (kind === 'crown') defines.TREE_CROWN = '';
  return dress(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    'depth-' + kind, defines);
}
