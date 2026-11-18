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
//   * THE IMPOSTOR. A far crown is a quad turned to face the eye (or the sun,
//     in the shadow pass) and painted from the atlas js/treeimpostor.js
//     renders at start-up: the species' near model seen from the side, with
//     its normal, its baked shade and a ragged alpha edge. The normal comes
//     from the picture, so the far crown is lit by the real sun like the near
//     one; the trunk under it is built here from a table, in crown space
//     (js/treeshapes.js, "the far tier").
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
import { SP, SPECIES, groundOf } from './treeshapes.js';

// The impostor atlas: one cell per species build (species * 2 + variant).
export const IMP_COLS = 8, IMP_ROWS = 4;
// The leaf shade baked into the atlas runs 0..IMP_AO_MAX, stored from
// IMP_LEAF0 up; wood is stored up to IMP_WOOD1 (see treeimpostor.js).
export const IMP_AO_MAX = 1.8, IMP_LEAF0 = 0.52, IMP_WOOD1 = 0.46;
const F = (x) => x.toFixed(4);

// The species tables the far trunk is built from, written out once as GLSL
// constants: the ground in crown radii, the trunk radius at the ground over
// the crown radius, where the trunk ends (a spruce and a poplar keep their
// leader well into the crown) and the bark colour, linear like instanceColor.
const _bc = new THREE.Color();
const glslFloats = (f) => SPECIES.map((S, i) => f(S, i).toFixed(4)).join(', ');
const TABLES = /* glsl */`
const float TREE_G[ ${SPECIES.length} ] = float[]( ${glslFloats((S, i) => groundOf(i))} );
const float TREE_TAU[ ${SPECIES.length} ] = float[]( ${glslFloats((S) => S.tau)} );
const float TREE_TOP[ ${SPECIES.length} ] = float[]( ${glslFloats((S, i) => (i === SP.SPRUCE || i === SP.POPLAR ? 0.6 : 0))} );
const vec3 TREE_BARK[ ${SPECIES.length} ] = vec3[]( ${SPECIES.map((S) => {
  _bc.setHex(S.bark);
  return `vec3( ${_bc.r.toFixed(4)}, ${_bc.g.toFixed(4)}, ${_bc.b.toFixed(4)} )`;
}).join(', ')} );`;

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
  // the impostor atlas (js/treeimpostor.js) and, per cell, x: the half size of
  // the picture in crown radii, y: the height of its centre in crown radii
  uTreeImp: { value: null },
  uTreeImpCell: { value: Array.from({ length: IMP_COLS * IMP_ROWS }, () => new THREE.Vector4(1.3, 0, 0, 0)) },
  // the finest mip the atlas is read at where a cell is still 16 texels
  // across: log2 of the cell's pixels, less 4 (js/trees.js sets it)
  uTreeImpLod: { value: 4 },
  // A/B switches (js/trees.js `ab`): x 1 = far crowns wear their picture,
  // 0 = the lumpy ball they were before it
  uTreeAB: { value: new THREE.Vector4(1, 0, 0, 0) },
  // toward the sun, world axes (js/trees.js): where a far crown looks up its
  // shadow, so that its own shadow caster does not shade it
  uTreeSun: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
};

// A transparent pixel to bind until the atlas exists: a program may compile
// before js/trees.js has rendered it.
let _impNone = null;
function impPlaceholder() {
  if (!_impNone) {
    _impNone = new THREE.DataTexture(new Uint8Array([128, 128, 0, 0]), 1, 1);
    _impNone.needsUpdate = true;
  }
  return _impNone;
}

// 32³ of tiling noise, two channels. R is cellular (distance to the nearest of
// a few scattered points), which is what a mass of leaf clusters looks like.
// G is plain value noise. Mipmapped, so a far crown averages to its mean
// instead of crawling.
const N = 32;
/** The leaf noise, made on first use (js/treeimpostor.js bakes with it too). */
export function leafNoise() {
  if (!TREE_U.uLeafTex.value) TREE_U.uLeafTex.value = leafTexture();
  return TREE_U.uLeafTex.value;
}
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
#ifdef TREE_CROWN
	uniform vec4 uTreeImpCell[ ${IMP_COLS * IMP_ROWS} ];
	uniform vec3 uTreeSun;
	// xy: where in the atlas, zw: where in the picture (0..1), or -1 on the trunk
	varying vec4 vImp;
	varying vec3 vTreeBark;
	${TABLES}
	#ifdef USE_INSTANCING_COLOR
		// the tag in the colour's low bits (js/treeshapes.js crownColor)
		float treeSpecies() { vec3 t = floor( instanceColor * 255.0 + 0.5 ); return mod( t.r, 4.0 ) * 4.0 + mod( t.b, 4.0 ); }
		float treeVariant() { return mod( floor( instanceColor.g * 255.0 + 0.5 ), 2.0 ); }
	#else
		float treeSpecies() { return 0.0; }
		float treeVariant() { return 0.0; }
	#endif
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
float tRx = 1.0;
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
	mvPosition = modelViewMatrix * mvPosition;
#elif defined( TREE_CROWN )
	if ( tQuad ) {
		// THE PICTURE: built in view space round the crown's centre, so it faces
		// the eye (in the shadow pass, the sun). Its height is the crown's from
		// the side and its width from straight above, which is also what keeps
		// a high sun's shadow of it round instead of a long smear.
		#ifdef USE_INSTANCING
			tRx = length( instanceMatrix[ 0 ].xyz );
			float tRy = length( instanceMatrix[ 1 ].xyz );
		#else
			float tRy = 1.0;
		#endif
		vec4 tCell = uTreeImpCell[ int( tCellI + 0.5 ) ];
		float tV = mix( tRx, tRy, clamp( length( viewMatrix[ 1 ].xy ), 0.0, 1.0 ) );
		vec2 tQ = uv * 2.0 - 1.0;
		vec3 tOff = vec3( tQ.x * tCell.x * tRx, tQ.y * tCell.x * tV, 0.0 );
		vec3 tSw = treeWind( vec3( tOff.x, tCell.y * tV + tOff.y, 0.0 ), tOrgW, 1.0, 1.0 );
		// The picture's centre, then toward the eye by half the crown, so the
		// trunk inside it is behind the leaves and shows only through the gaps.
		// ALONG THE RAY to the eye and shrunk by as much as it came closer, so
		// on screen it stays exactly where and as big as the crown: pushed along
		// view z, a tree off to one side of the screen slid away from its own
		// trunk (a metre at 60 m, the picture's limbs beside the real stem).
		// The light's camera is orthographic (projectionMatrix[2][3] is 0 there;
		// isOrthographic is never uploaded to a depth material).
		vec3 tC = ( modelViewMatrix * vec4( tOrg, 1.0 ) ).xyz + vec3( 0.0, tCell.y * tV, 0.0 );
		float tPush = tCell.x * tRx * 0.5;
		float tL = max( length( tC ), tPush + 0.5 );
		bool tOrtho = projectionMatrix[ 2 ][ 3 ] == 0.0;
		vec3 tDir = tOrtho ? vec3( 0.0, 0.0, 1.0 ) : - tC / tL;
		float tK = tOrtho ? 1.0 : ( tL - tPush ) / tL;
		mvPosition = vec4( tC + tDir * tPush + tOff * tK + mat3( viewMatrix ) * tSw, 1.0 );
	} else {
		mvPosition.xyz += treeWind( tRel, tOrgW, uv.x * uv.x * 0.6, 0.0 );
		mvPosition = modelViewMatrix * mvPosition;
	}
#else
	mvPosition.xyz += treeWind( tRel, tOrgW, uv.x, 0.0 );
	mvPosition = modelViewMatrix * mvPosition;
#endif
gl_Position = projectionMatrix * mvPosition;
float tFade = clamp( ( distance( tOrgW.xz, uTreeNear.xy ) - uTreeNear.z ) / max( uTreeNear.w - uTreeNear.z, 0.001 ), 0.0, 1.0 );
#ifdef TREE_NEAR
	tFade = 1.0 - tFade;
#elif defined( TREE_CROWN )
	// a shrub has no near model: it is the far tier at any distance
	if ( abs( tSp - 9.0 ) < 0.5 ) tFade = 1.0;
	vImp = vec4( ( vec2( mod( tCellI, ${IMP_COLS}.0 ), floor( tCellI / ${IMP_COLS}.0 ) ) + uv ) / vec2( ${IMP_COLS}.0, ${IMP_ROWS}.0 ),
		tQuad ? uv : vec2( - 1.0 ) );
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

// After <worldpos_vertex>: the shadow a far crown RECEIVES is looked up a crown
// and a bit toward the sun from the picture. Its own caster stands across it
// facing the sun, and looked up in place half of every crown would sit in its
// own shadow; this way a crown is shaded by the building or the tree between
// it and the sun and by nothing else. (The normal in the picture already
// darkens its far side.)
const WORLDPOS_V = /* glsl */`
#include <worldpos_vertex>
#if defined( TREE_CROWN ) && defined( USE_SHADOWMAP ) && ! defined( TREE_DEPTH )
	if ( tQuad ) worldPosition = vec4( cameraPosition + ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz + uTreeSun * ( tRx * 1.3 ), 1.0 );
#endif`;

// The far template's two parts (js/treeshapes.js): the quad, whose corners
// the projection builds, and the trunk, built here in crown space from the
// species table. The species is the tag in the colour's low bits.
const BEGIN_V = /* glsl */`
#include <begin_vertex>
float tSp = 0.0;
#ifdef TREE_CROWN
	tSp = treeSpecies();
	float tCellI = tSp * 2.0 + treeVariant();
	bool tQuad = normal.y < -0.5;
	if ( tQuad ) transformed = vec3( 0.0 );
	else {
		int tI = int( tSp + 0.5 );
		#ifdef USE_INSTANCING
			float tRyB = max( length( instanceMatrix[ 1 ].xyz ), 0.1 );
		#else
			float tRyB = 1.0;
		#endif
		float tR = uv.y * 1.45 * TREE_TAU[ tI ];
		vec2 tD = normalize( normal.xz );
		// sunk 0.3 m (treeshapes.js TRUNK_SINK) so a slope shows no daylight
		transformed = vec3( tD.x * tR, mix( - TREE_G[ tI ] - 0.3 / tRyB, TREE_TOP[ tI ], uv.x ), tD.y * tR );
	}
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
#ifdef TREE_CROWN
	uniform sampler2D uTreeImp;
	uniform float uTreeImpLod;
	varying vec4 vImp;
	// The atlas at the mip the picture's own footprint asks for, but never
	// coarser than the one where a cell is 16 texels across (past it the
	// neighbours bleed in). lod comes back for the coverage, which the mips
	// thin out: a far crown would otherwise shrink to its densest clumps.
	vec4 treeImp( vec2 uv, out float lod ) {
		vec2 sz = vec2( textureSize( uTreeImp, 0 ) );
		vec2 dx = dFdx( uv * sz ), dy = dFdy( uv * sz );
		lod = clamp( 0.5 * log2( max( max( dot( dx, dx ), dot( dy, dy ) ), 1e-8 ) ), 0.0, uTreeImpLod );
		return textureLod( uTreeImp, uv, lod );
	}
	float treeImpCover( float a, float lod ) { return a * ( 1.0 + 0.22 * lod ); }
	uniform vec4 uTreeAB;
	varying vec3 vTreeBark;
	vec3 tImpN = vec3( 0.0, 0.0, 1.0 );
#endif
float treeAlpha = 1.0;
// how much of this fragment is leaf, for the light let through and the lamps
float treeThru = 0.0;`;

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
	// the cut-out every tier falls back to without multisampling (below)
	float tCut = 1.0;
	#ifdef TREE_CROWN
	if ( vImp.z > - 0.5 ) {
		// THE PICTURE (js/treeimpostor.js), premultiplied: rg the normal, b the
		// shade (leaves from IMP_LEAF0 up, wood up to IMP_WOOD1), a the coverage
		float tLod;
		vec4 tS = treeImp( vImp.xy, tLod );
		if ( uTreeAB.x < 0.5 ) {
			// A/B: what every far crown was before the pictures, a lumpy ball
			// lit as one volume, painted here as a picture texel would be
			vec2 tP = ( vImp.zw * 2.0 - 1.0 ) * 1.3;
			float tLump = texture( uLeafTex, vec3( tP * 0.31, 0.5 ) + vTreePos * 0.05 ).r;
			float tIn = step( length( tP ), 0.84 + 0.2 * tLump );
			float tUp = smoothstep( - 0.7, 0.55, tP.y );
			tS = vec4( tP / max( 1.0, length( tP ) ) * 0.5 + 0.5,
				${F(IMP_LEAF0)} + ${F((1 - IMP_LEAF0) / IMP_AO_MAX)} * ( 0.62 + 0.38 * tUp ), 1.0 ) * tIn;
			tLod = 0.0;
		}
		vec3 tT = tS.rgb / max( tS.a, 0.004 );
		tImpN = vec3( tT.rg * 2.0 - 1.0, 0.0 );
		tImpN.xy /= max( 1.0, length( tImpN.xy ) );
		tImpN.z = sqrt( max( 0.0, 1.0 - dot( tImpN.xy, tImpN.xy ) ) );
		// a texel half leaf and half wood is drawn half of each
		float tPx = smoothstep( ${F(IMP_WOOD1)}, ${F(IMP_LEAF0)}, tT.b );
		float tAo = max( 0.0, tT.b - ${F(IMP_LEAF0)} ) * ${F(IMP_AO_MAX / (1 - IMP_LEAF0))};
		// the lit tips a little yellower, as the near model's clumps are
		vec3 tCol = diffuseColor.rgb * tAo;
		tCol = mix( tCol, tCol * vec3( 1.14, 1.06, 0.72 ), smoothstep( 1.05, 1.6, tAo ) * 0.6 );
		// a limb seen through a gap is in the crown's own shade. The picture is
		// lit as if nothing shaded it (its shadow is looked up beside it, see
		// WORLDPOS_V) while the real trunk under it sits in the crown's shadow:
		// at the 0.4..0.75 it was, every limb was paler than the stem it grew from
		vec3 tWood = vTreeBark * ( 0.14 + ${F(0.34 / IMP_WOOD1)} * min( tT.b, ${F(IMP_WOOD1)} ) );
		diffuseColor.rgb = mix( tWood, tCol, tPx );
		treeThru = tPx;
		// the edge sharpened to a pixel at any mip, then softened by coverage
		float tAc = treeImpCover( tS.a, tLod );
		float tA2c = clamp( ( tAc - 0.5 ) / max( fwidth( tAc ), 0.0001 ) + 0.5, 0.0, 1.0 );
		treeAlpha = tA2c * tSwap;
		tCut = step( 0.5, tAc );
	} else {
		float tBk = texture( uLeafTex, vTreePos * vec3( 0.42, 0.045, 0.42 ) ).g;
		diffuseColor.rgb *= mix( 0.74, 1.16, tBk );
		treeAlpha = tSwap;
	}
	#else
	#ifdef TREE_NEAR
		float tLeaf = vTreeLeaf;
		vec3 tNv = normalize( vTreeN );
	#else
		float tLeaf = 0.0;
		vec3 tNv = vec3( 0.0, 0.0, 1.0 );
	#endif
	// bark: streaks that run up the trunk
	float tBk = texture( uLeafTex, vTreePos * vec3( 0.42, 0.045, 0.42 ) ).g;
	vec3 tBark = diffuseColor.rgb * mix( 0.74, 1.16, tBk );
	#ifdef TREE_NEAR
		vec2 tA = texture( uLeafTex, vTreePos * uTreeK2.x ).rg;
		vec2 tB = texture( uLeafTex, vTreePos * uTreeK2.y + 0.37 ).rg;
		// clumps of foliage, lit and shaded, the lit ones a little yellower
		vec3 tCol = diffuseColor.rgb * ( 1.0 + uTreeK2.z * ( tA.r - 0.42 ) ) * ( 1.0 + uTreeK2.w * ( tB.r - 0.4 ) );
		tCol = mix( tCol, tCol * vec3( 1.24, 1.10, 0.60 ), tA.r * tB.r * 0.6 );
		// The near model bakes its creases and its underside into the vertex
		// colour (treemodels.js), about a seventh darker on average than the
		// picture of the same tree: a visible step across the swap band.
		tCol *= 1.15;
		diffuseColor.rgb = mix( tBark, tCol, tLeaf );
		treeThru = tLeaf;
		// the ragged edge: where a lobe turns away from the eye the leaves thin
		// out, by the same noise, so no silhouette is a smooth arc
		float tNdv = abs( dot( tNv, normalize( vViewPosition ) ) );
		float tEdge = tNdv - ( uTreeK.z + uTreeK.w * ( 1.0 - tB.r ) * ( 0.5 + 0.5 * tA.g ) );
		float tA2c = clamp( tEdge / max( fwidth( tEdge ), 0.0001 ) + 0.5, 0.0, 1.0 );
		treeAlpha = mix( 1.0, tA2c, tLeaf ) * tSwap;
		tCut = step( 0.5, mix( 1.0, tA2c, tLeaf ) );
	#else
		diffuseColor.rgb = tBark;
		treeAlpha = tSwap;
	#endif
	#endif
	// NO MULTISAMPLING (js/coverage.js): the alpha above would simply be
	// ignored, both tiers would stand whole across the band and every crown
	// would be a balloon. So: one tier per tree, changing hands at the middle
	// of the band (the fade is per tree, so a tree never shows half of each),
	// and the leafy edge as a plain cut-out.
	if ( uCoverage < 0.5 ) treeAlpha = ( vTreeFade < 0.5 ) ? 0.0 : tCut;
	if ( treeAlpha < 0.04 ) discard;
}`;

// After <normal_fragment_begin>: the picture's normal is already in view space
// (the quad faces the eye), so it simply replaces the quad's own.
const NORMAL_F = /* glsl */`
#include <normal_fragment_begin>
#ifdef TREE_CROWN
	if ( vImp.z > - 0.5 ) normal = tImpN;
#endif`;

const LIGHTS_F = /* glsl */`
#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
{
	float tThru = treeThru;
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
	float tLampLeaf = treeThru;${LAMP_DIRECT_WORLD}
	// the pool quads are drawn over the static world and paint a trunk's foot
	// themselves: cut = 1 leaves everything under their plane to them
	vec3 tLamp = atcLampDirect( atcLampW, atcLampUp, 1.0, diffuseColor.rgb );
	// leaves: duller and toward olive, the same rule the composite applies
	tLamp = mix( tLamp, vec3( dot( tLamp, vec3( 0.30, 0.59, 0.11 ) ) ) * vec3( 0.95, 1.0, 0.70 ), 0.65 * tLampLeaf )
		* ( 1.0 - 0.52 * tLampLeaf );
	reflectedLight.indirectDiffuse += tLamp;
}`;

// The shadow of a far crown is the picture's, not the quad's.
const DEPTH_PARS_F = /* glsl */`
#ifdef TREE_CROWN
	uniform sampler2D uTreeImp;
	uniform float uTreeImpLod;
	varying vec4 vImp;
	// The atlas at the mip the picture's own footprint asks for, but never
	// coarser than the one where a cell is 16 texels across (past it the
	// neighbours bleed in). lod comes back for the coverage, which the mips
	// thin out: a far crown would otherwise shrink to its densest clumps.
	vec4 treeImp( vec2 uv, out float lod ) {
		vec2 sz = vec2( textureSize( uTreeImp, 0 ) );
		vec2 dx = dFdx( uv * sz ), dy = dFdy( uv * sz );
		lod = clamp( 0.5 * log2( max( max( dot( dx, dx ), dot( dy, dy ) ), 1e-8 ) ), 0.0, uTreeImpLod );
		return textureLod( uTreeImp, uv, lod );
	}
	float treeImpCover( float a, float lod ) { return a * ( 1.0 + 0.22 * lod ); }
#endif`;
const DEPTH_F = /* glsl */`
#ifdef TREE_CROWN
	if ( vImp.z > - 0.5 ) {
		float tLod;
		vec4 tS = treeImp( vImp.xy, tLod );
		if ( treeImpCover( tS.a, tLod ) < 0.5 ) discard;
	}
#endif
#include <clipping_planes_fragment>`;

function patch(kind) {
  return (shader) => {
    Object.assign(shader.uniforms, TREE_U, LAMP_DIRECT_U);
    leafNoise();
    if (!TREE_U.uTreeImp.value) TREE_U.uTreeImp.value = impPlaceholder();
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS_V)
      .replace('#include <begin_vertex>', BEGIN_V)
      .replace('#include <project_vertex>', PROJECT_V)
      .replace('#include <worldpos_vertex>', WORLDPOS_V);
    if (kind === 'near') {
      // wood keeps its own colour: the instance colour is the LEAF colour
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>',
        '#include <color_vertex>\n\tif ( uv.y < 0.5 ) vColor.rgb = color;');
    } else if (kind === 'crown') {
      // the trunk takes its species' bark; the picture keeps the leaf colour
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>',
        '#include <color_vertex>\n\tvTreeBark = TREE_BARK[ int( treeSpecies() + 0.5 ) ];'
        + '\n\tif ( normal.y > -0.5 ) vColor.rgb = color * vTreeBark;');
    }
    if (shader.fragmentShader.includes('#include <color_fragment>')) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + PARS_F + LAMP_DIRECT_GLSL)
        .replace('#include <color_fragment>', COLOR_F)
        .replace('#include <normal_fragment_begin>', NORMAL_F)
        .replace('#include <lights_fragment_end>', LIGHTS_F)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\tgl_FragColor.a = treeAlpha;');
    } else {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + DEPTH_PARS_F)
        .replace('#include <clipping_planes_fragment>', DEPTH_F);
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

/**
 * The far materials. `crown` draws every chunk's tree batch (picture and trunk
 * in one template since the impostors); `trunk` stays as a material slot that
 * nothing draws with any more (js/geomcodec.js MAT_SLOTS is append-only).
 */
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
  // The far crown's picture faces the sun in the shadow pass, and three draws
  // a front-sided material's BACK faces into the shadow map: the picture
  // would never cast. (The trunk in the same template is closed, so drawing
  // both sides of it changes nothing.)
  crown.shadowSide = THREE.DoubleSide;
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
