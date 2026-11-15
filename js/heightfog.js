// ---- heightfog.js: aerial perspective for every material at once ----------
// three's stock fog is one colour and one linear ramp, mixed in AFTER the tone
// curve. Three things were wrong with that here:
//
//   1. The ramp started at 20 % of the view distance, so everything from the
//      next junction on wore the same grey veil, and the skyline dissolved into
//      a colour that was not the colour of the sky behind it. That mismatch is
//      what made distant blocks read as paper cut-outs.
//   2. It had no idea where the sun was. Real haze glows toward the sun and the
//      dome already paints that glow, so buildings on the sunward horizon stood
//      as flat grey shapes in front of a bright sky.
//   3. It had no idea how high anything was. From a helicopter the whole world
//      sat in the same soup as the street.
//
// This module replaces the fog shader chunks ONCE, at import, before any
// material has compiled. Every material that includes three's fog chunks (all
// the built-in ones, the ground's patched MeshStandardMaterial, the water
// ShaderMaterial, the grass) then gets, with no edit of its own:
//
//   * a soft exponential-squared haze that barely touches the near field,
//     thinned with height above the ground the camera stands over
//   * the old linear ramp kept as the WALL that hides the streamed edge, so
//     fog.near / fog.far still mean what traffic.js and pedestrians.js think
//   * a fog colour that IS the dome's horizon colour, sun glow included
//   * the mix moved in FRONT of the tone curve, in linear light, so the direct
//     path (low preset) and the post path (medium, high) fog identically
//
// HOW THE NUMBERS REACH EVERY SHADER. A material's uniforms are cloned from
// ShaderLib when it first compiles, so there is no object every material
// shares. Except one kind: UniformsUtils.clone copies Color, Vector and Matrix
// values but passes a Float32Array through BY REFERENCE. The four vec4s below
// are therefore one set of typed arrays seen by every program, written once a
// frame by setAirFog(). Nothing is allocated and no material is touched.
//
// A material that never received the uniforms (a hand-rolled ShaderMaterial
// that does not merge UniformsLib.fog) reads zeros, and atcFogAir.w == 0 means
// "behave exactly like stock three fog". So the patch cannot break a shader it
// does not know about.

import * as THREE from 'three';

// xyz: unit direction TO the sun, w: how strong its glow in the haze is
const SUN = new Float32Array([0.5, 0.6, 0.4, 0]);
// rgb: sun colour (linear), w: 1 / haze scale height in metres
const TINT = new Float32Array([1, 0.97, 0.92, 1 / 320]);
// x: haze rate (k / fogFar, per metre), y: ground height the haze sits on,
// z: the haze curve's exponent, w: 1 = this module drives the fog, 0 = stock
const AIR = new Float32Array([0, 0, 3.4, 0]);
// rgb: fog colour in LINEAR light. Not three's fogColor on purpose: three
// uploads that one already converted to the output colour space when it draws
// to the canvas, and this mix happens before the conversion.
// w: the afterglow, 0..1 (sky.js): the band the dome paints along the horizon
// where the sun went down, so the haze on that side glows with it.
const COL = new Float32Array([0.35, 0.5, 0.65, 0]);
// THE FAR HAND-OVER (Prague only, js/landmarksfar.js drives it). Beyond the
// streamed ring the far skyline draws coarse ground under the castle hill and
// the Vyšehrad rock, dithered in over 0.70 to 0.90 of the built radius. The
// streamed geometry over the same ground had the wall's full horizon colour by
// then, and wherever the fine terrain or a tree stood above the coarse far
// ground it painted pale specks over the green hill and the far castle's base
// (seen from Charles Bridge). Inside the boxes below, generic geometry is now
// discarded by the SAME dither the far ground is drawn with, so the two hand
// over pixel for pixel instead of overlapping. x: built radius R (m), w: 1 = on
// (0 everywhere else, Pardubice included: the test is one compare).
const HAND = new Float32Array([0, 0, 0, 0]);
// two boxes [x0, z0, x1, z1] in world metres
const HAND_A = new Float32Array([0, 0, 0, 0]), HAND_B = new Float32Array([0, 0, 0, 0]);
// THE STREAMED EDGE, DISSOLVED (round 8, HORIZON). Where the view is open the
// wall moves out past the streamed window to the far landscape
// (js/farterrain.js), and the window's square edge would stand in clear air:
// houses, trees and road ribbons ending in a line, cells popping in along it.
// So generic geometry gives way over its outer band by the same dither and the
// same discard as the hand-over above (one test, one discard): x, z the
// window's centre, z0 = z where the dissolve starts and w where it is complete
// (Chebyshev metres from the centre, the window is square). w 0 = off, which
// it is wherever the view is not open (Pardubice, Prague: the test is one
// compare). A material with ATC_NO_EDGE defined (the far landscape) ignores it.
const EDGE = new Float32Array([0, 0, 0, 0]);
// The afterglow band, shared with the dome's shader so the two cannot drift:
// `d` is a unit direction, `sd` the unit direction to the sun (under the
// horizon by now). A low warm band, strongest over the sun's azimuth, that
// thins to nothing a hand above the horizon.
export const AFTERGLOW_GLSL = /* glsl */`
	vec3 atcAfterglow( vec3 d, vec3 sd ) {
		vec2 a = normalize( sd.xz + vec2( 1e-5 ) );
		float az = dot( normalize( d.xz + vec2( 1e-5 ) ), a ) * 0.5 + 0.5;
		float h = max( d.y, 0.0 );
		float low = exp( - h * 9.0 ), mid = exp( - h * 3.2 );
		return ( vec3( 1.0, 0.36, 0.10 ) * low + vec3( 0.42, 0.20, 0.34 ) * mid * 0.5 )
			* ( 0.10 + 0.90 * az * az * az );
	}`;

// The haze curve: 1 - exp(-(K d / fogFar)^POW). The first version squared it,
// and on the ground (the streamed world ends some 420 m out) that put a sixth
// of the fog colour on everything 150 m away and half by the time the wall
// began: the whole middle distance was one grey, which is the "flat" the noon
// frame was called. A real clear day keeps its contrast to the far end of the
// street and loses it over the last stretch, so the curve is steeper now: with
// POW 3.4 the street is clean to 150 m (3 %), a fifth is haze where the wall
// starts, and the wall still meets a horizon that is mostly air.
// One object, not two constants, so a harness can retune it on a live page.
export const HAZE = { k: 1.12, pow: 3.4 };
// Haze thins to 1/e this far above the ground. Real boundary-layer haze is a
// kilometre or two deep; this is compressed so the effect reads from a
// helicopter at 300 m, where the horizon should sit in a band you look down on.
const SCALE_H = 320;

const C = THREE.ShaderChunk;

C.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vAtcRay;
#endif`;

// The ray from the camera to the fragment, in WORLD axes. mvPosition is in
// view space; multiplying a row vector by viewMatrix applies the inverse of
// its rotation, which is all a direction needs.
C.fog_vertex = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vAtcRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif`;

C.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
	#define ATC_FOG_PARS
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vAtcRay;
	uniform vec4 atcFogSun;
	uniform vec4 atcFogTint;
	uniform vec4 atcFogAir;
	uniform vec4 atcFogCol;
	uniform vec4 atcHand;
	uniform vec4 atcHandA;
	uniform vec4 atcHandB;
	uniform vec4 atcEdge;
	// the far hand-over (HAND above): true where this fragment gives way to
	// the far ground. The hash is the far material's own (js/landmarksfar.js),
	// so a pixel is drawn by exactly one of the two. The streamed edge's
	// dissolve (EDGE above) is the same test with its own share.
	bool atcHandOut() {
		float share = 0.0;
		vec2 p = cameraPosition.xz + vAtcRay.xz;
		#ifndef ATC_NO_EDGE
		if ( atcEdge.w > 0.0 ) {
			vec2 q = abs( p - atcEdge.xy );
			share = smoothstep( atcEdge.z, atcEdge.w, max( q.x, q.y ) );
		}
		#endif
		if ( atcHand.w >= 0.5 ) {
			bool inA = p.x > atcHandA.x && p.x < atcHandA.z && p.y > atcHandA.y && p.y < atcHandA.w;
			bool inB = p.x > atcHandB.x && p.x < atcHandB.z && p.y > atcHandB.y && p.y < atcHandB.w;
			if ( inA || inB ) share = max( share, smoothstep( atcHand.x * 0.70, atcHand.x * 0.90, vFogDepth ) );
		}
		if ( share <= 0.0 ) return false;
		float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
		return ign < share;
	}
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	// 0 = clear air, 1 = nothing but fog
	float atcFogAmount() {
		#ifdef FOG_EXP2
			float wall = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		#else
			float wall = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		float k = length( vAtcRay ) * atcFogAir.x;
		// mean density along the ray through air that thins exponentially with
		// height: the closed form of the integral, not a march
		// both exponents are held to 60: from a jet thirty kilometres up exp()
		// overflows on one side and underflows on the other, and their product
		// is a NaN that paints the ground black
		float dy = max( vAtcRay.y * atcFogTint.w, - 60.0 );
		float thin = exp( - clamp( ( cameraPosition.y - atcFogAir.y ) * atcFogTint.w, 0.0, 60.0 ) );
		float col = abs( dy ) > 0.001 ? ( 1.0 - exp( - dy ) ) / dy : 1.0;
		float haze = 1.0 - exp( - pow( k, atcFogAir.z ) * min( thin * col, 1.6 ) );
		return clamp( 1.0 - ( 1.0 - wall ) * ( 1.0 - haze ), 0.0, 1.0 );
	}
	// what the haze looks like in the direction of this fragment: the dome's
	// horizon colour plus the same sun glow the dome paints (sky.js SKY_FRAG),
	// so a building that fades out fades into exactly what is behind it
	` + AFTERGLOW_GLSL + /* glsl */`
	vec3 atcFogColour() {
		vec3 rd = normalize( vAtcRay );
		float sd = max( dot( rd, atcFogSun.xyz ), 0.0 );
		vec3 c = atcFogCol.rgb
			+ atcFogTint.rgb * ( ( pow( sd, 80.0 ) * 0.6 + pow( sd, 7.0 ) * 0.25 ) * atcFogSun.w );
		// half of what the dome shows: the far ground under the band takes its
		// colour without becoming a second sky
		if ( atcFogCol.a > 0.001 ) c += atcAfterglow( rd, atcFogSun.xyz ) * ( atcFogCol.a * 0.5 );
		return c;
	}
#endif`;

// ---- the look: what the tone curve leaves undone ----
// ACES is a film curve, and its toe is film's: everything under about two
// percent goes to black. Open shade on a lawn, a wood floor, the unlit side of
// a street at night all live down there, and all of them were holes. This runs
// on the curve's OUTPUT (display-linear, 0..1): it opens the bottom of the
// range (a value near black is about doubled, one at a tenth of white gains
// two fifths, a mid-grey nothing; the lift is monotonic) and gives back the saturation
// the curve takes out of clean colours, so a lawn is green and a tiled roof
// red. One function for both render paths: three's own ACES is patched to end
// with it (below), and postfx.js ends its copy of the curve with the same text.
export const lookGLSL = (name) => /* glsl */`
	vec3 ${name}( vec3 c ) {
		vec3 t = 1.0 - c;
		t *= t; t *= t; t *= t * sqrt( t );
		c += c * t * 1.10;
		float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
		return clamp( mix( vec3( l ), c, 1.14 ), 0.0, 1.0 );
	}`;
{
  const end = 'color = ACESOutputMat * color;\n\treturn saturate( color );';
  if (C.tonemapping_pars_fragment.includes(end)) {
    C.tonemapping_pars_fragment = lookGLSL('atcLook') + '\n'
      + C.tonemapping_pars_fragment.replace(end, 'color = ACESOutputMat * color;\n\treturn atcLook( saturate( color ) );');
  }
}

// The mix itself rides in the tone-mapping chunk, which every fogged built-in
// material includes immediately BEFORE fog_fragment. That is what puts the fog
// in linear light under the tone curve.
C.tonemapping_fragment = /* glsl */`
#if defined( USE_FOG ) && defined( ATC_FOG_PARS )
	#define ATC_FOG_DONE
	if ( atcFogAir.w > 0.5 ) {
		if ( atcHandOut() ) discard;
		gl_FragColor.rgb = mix( gl_FragColor.rgb, atcFogColour(), atcFogAmount() );
	}
#endif
` + C.tonemapping_fragment;

// …and fog_fragment keeps two jobs: stock fog for a material that has no idea
// this module exists, and a late mix for a shader that includes the fog chunk
// but no tone-mapping chunk.
C.fog_fragment = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	if ( atcFogAir.w <= 0.5 ) {
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	}
	#ifndef ATC_FOG_DONE
	else {
		if ( atcHandOut() ) discard;
		gl_FragColor.rgb = mix( gl_FragColor.rgb, atcFogColour(), atcFogAmount() );
	}
	#endif
#endif`;

// Hand the shared arrays to every program that has fog. ShaderLib entries were
// built when three loaded, so they are patched in place; UniformsLib.fog is
// patched too, for a ShaderMaterial that merges it later (the water does).
const shared = () => ({
  atcFogSun: { value: SUN }, atcFogTint: { value: TINT },
  atcFogAir: { value: AIR }, atcFogCol: { value: COL },
  atcHand: { value: HAND }, atcHandA: { value: HAND_A }, atcHandB: { value: HAND_B },
  atcEdge: { value: EDGE },
});
Object.assign(THREE.UniformsLib.fog, shared());
for (const k of Object.keys(THREE.ShaderLib)) {
  const u = THREE.ShaderLib[k].uniforms;
  if (u && u.fogColor) Object.assign(u, shared());
}

/**
 * Once a frame, from sky.js. Everything is plain numbers into typed arrays.
 *   colour   THREE.Color, linear: the dome's horizon colour this minute
 *   sunDir   unit vector to the sun (it may be under the horizon)
 *   sunColor THREE.Color, linear: what the dome's halo is tinted with
 *   glow     the dome's uDay: 1 by day, close to 0 at night
 *   far      the fog wall's far distance in metres (scene.fog.far)
 *   baseY    height of the ground under the camera, metres
 *   vis      the distance the HAZE is scaled to (round 8): the wall's far
 *            distance unless the view is open, see sky.js
 */
export function setAirFog(colour, sunDir, sunColor, glow, far, baseY, after = 0, vis = far) {
  COL[0] = colour.r; COL[1] = colour.g; COL[2] = colour.b; COL[3] = after;
  SUN[0] = sunDir.x; SUN[1] = sunDir.y; SUN[2] = sunDir.z; SUN[3] = glow;
  TINT[0] = sunColor.r; TINT[1] = sunColor.g; TINT[2] = sunColor.b; TINT[3] = 1 / SCALE_H;
  AIR[0] = HAZE.k / Math.max(50, vis);
  AIR[1] = baseY;
  AIR[2] = HAZE.pow;
  AIR[3] = 1;
}

/**
 * The far hand-over (see HAND): `radius` the built radius in metres, `boxes`
 * up to two [x0, z0, x1, z1], `on` false switches it off. Plain numbers into
 * the shared arrays, once a frame from js/landmarksfar.js.
 */
export function setFarHand(radius, boxes, on) {
  HAND[0] = radius; HAND[3] = on && boxes.length ? 1 : 0;
  if (!HAND[3]) return;
  const a = boxes[0], b = boxes[1] ?? boxes[0];
  for (let i = 0; i < 4; i++) { HAND_A[i] = a[i]; HAND_B[i] = b[i]; }
}

/**
 * The streamed window's edge dissolve (see EDGE): centre (x, z), the dissolve
 * from r0 to r1 metres (Chebyshev). `on` false switches it off.
 */
export function setFarEdge(x, z, r0, r1, on) {
  EDGE[0] = x; EDGE[1] = z; EDGE[2] = r0; EDGE[3] = on ? Math.max(r1, r0 + 1) : 0;
}

/** The same amount the shader computes, for a point `dist` metres away and
 *  `dy` metres above the camera, with the wall given as near/far (and the haze
 *  scaled to `vis`, the wall's far by default). For tests and for anything on
 *  the CPU that has to agree with the picture. */
export function airFogAmount(dist, dy, camAboveGround, near, far, vis = far) {
  const t = Math.min(1, Math.max(0, (dist - near) / Math.max(1e-6, far - near)));
  const wall = t * t * (3 - 2 * t);
  const k = dist * (HAZE.k / Math.max(50, vis));
  const d = Math.max(dy / SCALE_H, -60);
  const thin = Math.exp(-Math.min(60, Math.max(camAboveGround, 0) / SCALE_H));
  const col = Math.abs(d) > 0.001 ? (1 - Math.exp(-d)) / d : 1;
  const haze = 1 - Math.exp(-Math.pow(k, HAZE.pow) * Math.min(thin * col, 1.6));
  return 1 - (1 - wall) * (1 - haze);
}

// ---- the same air, for a full-screen pass ----
// postfx.js lights the ground under street lamps in its composite, from a
// reconstructed world position, and that light has to thin out with the haze
// exactly as the ground it falls on did. `ray` runs from the camera to the
// point, in world axes; the result is how much of the point is still seen.
export const AIR_CLEAR_GLSL = /* glsl */`
	uniform vec4 atcFogTint;
	uniform vec4 atcFogAir;
	uniform vec2 uFogWall;     // scene.fog.near, scene.fog.far
	float atcAirClear( vec3 ray, float camY ) {
		float dist = length( ray );
		float wall = smoothstep( uFogWall.x, uFogWall.y, dist );
		float k = dist * atcFogAir.x;
		float dy = max( ray.y * atcFogTint.w, - 60.0 );
		float thin = exp( - clamp( ( camY - atcFogAir.y ) * atcFogTint.w, 0.0, 60.0 ) );
		float col = abs( dy ) > 0.001 ? ( 1.0 - exp( - dy ) ) / dy : 1.0;
		float haze = 1.0 - exp( - pow( k, atcFogAir.z ) * min( thin * col, 1.6 ) );
		return clamp( ( 1.0 - wall ) * ( 1.0 - haze ), 0.0, 1.0 );
	}`;
/** The shared holders the snippet above reads (plus uFogWall, the caller's). */
export const airFogUniforms = () => ({ atcFogTint: { value: TINT }, atcFogAir: { value: AIR } });

/** Where the wall starts, as a share of fog.far. sky.js sets fog.near to this. */
export const FOG_WALL_START = 0.66;
