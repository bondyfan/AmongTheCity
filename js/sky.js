// ---- Sky: the sun's real path over Pardubice, and everything that follows ----
// Self-contained port of AmongTheWoods' elevation-driven day/night system,
// minus every biome/cave/dungeon branch. One continuous solar angle drives it
// all: the sun rises in the east at 05:00, peaks at 75° over noon in the
// southern sky, sets in the west at 21:00 and keeps travelling BELOW the
// horizon through the night. Darkness, the golden hour, the sunset fog band,
// the moon and the long evening shadows all derive from that ONE number — the
// sun's elevation — never from separate hour tables that can disagree with it
// (the Woods' original table declared 22:00 "night" while the sun still stood
// 24° high: stars over a lit sky, and no sunset in between).
//
//   makeSky(scene)                     → sky { dome, hemi, sun, target }
//   updateSky(sky, tod, camera, scene) — tod 0..1 (0 = midnight); every frame
//   sunDirOf(tod, out)                 → unit sun direction (x east, z south)
//   nightKOf(tod)                      → 0 day … 1 deep night (same curve)
//   todClock(tod)                      → "HH:MM" for the HUD
//
// Two live values hang off the sky object for everyone else to read rather
// than re-derive: `sky.sunDir` and `sky.nightK`. clouds.js lights its puffs
// from exactly those, which is the whole point — the clouds, the streets and
// the fog must agree about where the sun is, and guessing night back out of
// sun.intensity (as callers used to) breaks the moment the intensity curve is
// retuned.

// What this module publishes beyond the two above (all read-only for callers):
//   sky.sunColor  the sun's own colour, also while the moon holds the light
//   sky.sunI      the sun's own intensity, 0 once it is down (god rays and the
//                 lens flare want THIS, not sky.sun.intensity: after dark that
//                 light is the moon)
//   sky.moonK     0 by day, 1 once the moon carries the scene
//   sky.lightDir  where the one DirectionalLight stands: sun by day, moon by night
//   sky.env       the sky environment map (envmap.js), or null without a renderer
//   sky.exposure  the tone-mapping exposure of the moment (it opens up at night)

import * as THREE from 'three';
// Imported for its side effect as much as for setAirFog: heightfog.js replaces
// three's fog shader chunks at import, which has to happen before the first
// material compiles. sky.js is imported by main.js long before that.
import { setAirFog, FOG_WALL_START, AFTERGLOW_GLSL } from './heightfog.js';
import { SkyEnv } from './envmap.js';
import { LOOK_AB } from './lookab.js';

// ---- the sun's path, and the darkness that FOLLOWS from it ----
const SUNRISE = 5, SUNSET = 21, SUN_PEAK = 75; // hours, hours, degrees
// How far under the horizon the sun stands at solar midnight. The night half
// of the path used to mirror the day half (75 degrees down), and since the
// night is half as long as the day the sun DOUBLED its speed the instant it
// set: it fell through the whole of twilight in twenty seconds, and dusk was a
// switch. At 40 degrees it crosses the horizon at the speed it arrived with
// (about 15 degrees an hour on both sides), which is also much nearer the
// truth of a Central European summer, where the sun never gets far under.
const SUN_DIP = 40;
// 0..1 from sunrise to sunset, then 1..2 on through the night — one continuous
// phase, so elevation genuinely goes negative after dark instead of the disc
// parking above the horizon all night
function solarPhase(h) {
  if (h >= SUNRISE && h < SUNSET) return (h - SUNRISE) / (SUNSET - SUNRISE);
  const nh = h < SUNRISE ? h + 24 : h;
  return 1 + (nh - SUNSET) / (24 - SUNSET + SUNRISE);
}
const elevOfPhase = sp => (sp <= 1 ? SUN_PEAK : SUN_DIP) * Math.sin(Math.PI * sp);
const sunElevAt = h => elevOfPhase(solarPhase(h));
const smooth01 = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
// Night is derived from the sun: full day while it is well up, twilight as it
// sinks through the horizon, full night once it is properly under.
// The bottom is astronomical dusk, 18 degrees under: with the path above that
// makes the way from day to full night about an hour and three quarters of
// game time (105 real seconds), most of it AFTER sunset, the way it goes.
const TWILIGHT_TOP = 8, TWILIGHT_BOTTOM = -18; // degrees of elevation
const nightAtHour = h =>
  smooth01((TWILIGHT_TOP - sunElevAt(h)) / (TWILIGHT_TOP - TWILIGHT_BOTTOM));

// ---- palette (linear working space) ----
// The fog has no colour of its own any more: it takes the dome's HORIZON
// colour, exactly, every frame (see heightfog.js). That one decision is what
// stops the skyline reading as paper cut-outs, because a block that fades out
// now fades into precisely what is drawn behind it. So the horizon entries
// below are also the haze: a pale blue-grey by day, a warm band at sunset.
// (The first pair was 0xa9c3d9 over 0x4c86c2, a grey-blue under a pale blue: an
// overcast afternoon. A clear summer day is cleaner at the horizon and a good
// deal deeper overhead.)
// (Round 11: the zenith went a shade deeper again, 0x3a7ac6 to 0x2c6cc4, and
// the horizon a touch less white: through the tone curve's shoulder the old
// pair came out as a washed, nearly white sky over every street.)
const DAY_SKY = { horizon: new THREE.Color(0x9cc4ec), zenith: new THREE.Color(0x2c6cc4) };
// NIGHT IS BLUE, NOT BLACK. A clear night under a moon is a deep blue you can
// see shapes against; pure black is what a monitor shows when nothing was lit.
// The horizon carries a trace of warmth: a town's own glow in its own haze.
// (These look tiny. They are seen through the night exposure below, which
// multiplies everything by about two and a half.)
// (Round 11: a fifth brighter and bluer overhead, so the roofline stands
// against the sky at midnight instead of merging with it.)
const NIGHT_SKY = { horizon: new THREE.Color().setRGB(0.0140, 0.0150, 0.0230),
                    zenith: new THREE.Color().setRGB(0.0036, 0.0060, 0.0150) };
// sunset: warm haze along the horizon, pink-violet in the sky above it. The
// band across the AIR is what actually reads as a sunset; sun colour alone
// barely registers when most of the frame is facades and asphalt
const SUNSET_FOG = new THREE.Color(0xe08c4a), SUNSET_SKY = new THREE.Color(0x9c5f80);
// sun light colour (linear working space): neutral warm-white high up, deep
// sunset orange at the horizon. GOLDEN_TOP is the elevation where warming starts.
const GOLDEN_TOP = 30;
const SUN_DAY = new THREE.Color(1.0, 0.95, 0.87);
const SUN_LOW = new THREE.Color(1.0, 0.38, 0.13);
// ---- the moon as a light ----
// The dome has always drawn a moon opposite the sun. It lit nothing: after
// dark the scene had a 3.5 % ambient and that was all, which is a black
// screen with glowing lamp heads in it. The ONE DirectionalLight now changes
// hands at dusk. It is the sun while the sun is up, it is dark for the degree
// or so in which the sun crosses the horizon, and then it comes back from the
// opposite side as a dim blue key, with the same shadow map. Still one light,
// still one shadow pass, and a night with form in it.
const MOON_COL = new THREE.Color().setRGB(0.60, 0.72, 1.0);
// The moon is the JUNIOR partner on the ground, on purpose: the town's light
// at night is the lamps (lightpools.js), and a moon strong enough to compete
// with them flattens every pool. A sixth of the ambient's weight still gives
// walls a lit side and a dark side.
const MOON_I = 0.085;
// The day's fill was 0.74 of a nearly white sky, and open shade came out at a
// quarter of the sunlit ground in the SCENE and at a tenth of it on screen,
// once the tone curve's toe had had its share: a lawn under a tree was black
// at noon. A clear sky gives more than that and gives it BLUE, which is what
// makes a shadow read as shade and not as a hole (the colour is in updateSky).
// (The night's 0.14 and the moon's 0.10 came down a seventh when the toe of the
// tone curve was opened, heightfog.js lookGLSL: that lift does the work the
// extra light was doing, and roofs were turning red at midnight.)
// (Round 11, LOOK: 0.98 became 0.70, and the sun 1.8 became 2.25. With the
// old pair open shade got a third of the light of the sunlit pavement beside
// it, and a city at noon read as one flat grey: nothing told you where the sun
// was. A clear sky gives shade about a fifth of the sun's light, and that is
// roughly where the pair stands now; the sunlit pavement itself is within five
// percent of where it was, so the exposure did not have to move.)
// One object, not constants, so the pair can be retuned on a live page by eye
// (__atc.sky.light) the way heightfog.js HAZE is; `bounce` is BOUNCE below.
export const LIGHT = { hemiDay: 0.70, sunI: 2.25, bounce: 0.5 };
const HEMI_NIGHT = 0.12;
// The fill's SKY colour follows the sky: clear blue by day, the lavender of
// the sunset sky through the golden hour, moonlit blue at night. Its GROUND
// colour is light thrown back up off the sunlit streets (BOUNCE below), warm
// because paving and brick are, on top of a dim grey base for the night.
const HEMI_SKY_DAY = new THREE.Color().setRGB(0.62, 0.78, 1.0);
const HEMI_SKY_GOLD = new THREE.Color().setRGB(0.92, 0.70, 0.74);
const HEMI_SKY_NIGHT = new THREE.Color().setRGB(0.45, 0.58, 0.98);
const BOUNCE_TINT = new THREE.Color().setRGB(1.0, 0.86, 0.70);
// BOUNCE (LIGHT.bounce): half of what a 19 % street really sends back up. The
// full share lights the underside of everything as brightly as the sky does
// its top, which is true and looks flat. Half keeps the shaded face of a
// building warm and readable.
// THE OLD RIG, for the A/B only (js/lookab.js light: false): the sun/fill pair,
// the sun's colour and the sky before round 11, and the grey fill of updateSky.
const OLD = {
  hemiDay: 0.98, sunI: 1.8, sunDay: new THREE.Color(1.0, 0.97, 0.92),
  day: { horizon: new THREE.Color(0xa4c8ea), zenith: new THREE.Color(0x3a7ac6) },
  night: { horizon: new THREE.Color().setRGB(0.0125, 0.0135, 0.0205),
           zenith: new THREE.Color().setRGB(0.0028, 0.0048, 0.0120) },
};
// AERIAL PERSPECTIVE (heightfog.js DEEP): thin haze takes the colour of the
// sky about twelve degrees up, which on the dome's curve is AIR_UP of the way
// from the horizon colour to the zenith, at AIR_K of full weight by day and
// less at night, where the zenith is near black and leaning to it would only
// darken the middle distance.
const AIR_UP = 0.3, AIR_K = 0.6;
// peak of the afterglow band, linear (see updateSky)
const AFTERGLOW = 0.22;
// ---- exposure: the eye adapts, so the camera does ----
// The night's light levels above are honest: a fifth of the day's ambient, a
// moon at a twentieth of the sun. Shown through the DAY exposure they land in
// the toe of the tone curve, where the filmic fit crushes everything under
// about 2 % to black, and the street really was black again, moon or no moon.
// The answer is not to lie about the light (an ambient bright enough to
// survive the curve is what once made the lamps pointless) but to do what an
// eye or a camera does after dusk: open up. The exposure climbs geometrically
// with the same night curve everything else follows. Lamp pools, headlights
// and lit windows keep their RATIO to the moonlit street, which is the thing
// that makes them read as light.
// The day value replaces the old 1.08: with the tone curve now applied on
// every path, 1.08 put the whole frame a stop too high and washed it out.
// (0.82 for a while: with the fuller sky fill above and the opened toe in
// heightfog.js, 0.86 puts sunlit paving where a summer noon has it.)
export const EXPOSURE_DAY = 0.86, EXPOSURE_NIGHT = 2.5;
// The wall that hides the streamed edge. Generous by day; pulled in a little at
// night, where it costs nothing visually (it is the colour of the night) and
// keeps the number of actors that have to exist down.
const FOG_DAY_FAR = 900, FOG_NIGHT_FAR = 640;
// THE OPEN VIEW (round 8, HORIZON). Where js/openness.js finds the view open
// and the far landscape is drawn (sky.fogOpen, 0..1, from main.js), the wall
// moves out toward OPEN_FAR and the haze is scaled to OPEN_VIS instead of to
// the wall: on the D11 at noon 3 % haze at 2 km, a third at 4 km, the wall
// from 3.6 to 5.5 km over the far land. At fogOpen 0 every number below is
// exactly what it always was (tests/sky-light.test.mjs).
const OPEN_DAY_FAR = 5500, OPEN_NIGHT_FAR = 3600;
const OPEN_DAY_VIS = 6000, OPEN_NIGHT_VIS = 3800;

// ---- the shadow box ----
// Half-width of the ortho shadow frustum, by map size, so a texel stays near
// 10 cm at every setting: 1024 covers a street, 2048 a block, 4096 a district.
const shadowHalf = (mapSize) => mapSize >= 4096 ? 150 : mapSize >= 2048 ? 115 : 90;
const SHADOW_DIST = 170;         // how far up its own ray the light stands
// The centre of the box sits this share of its half-width AHEAD of the camera:
// what is behind you needs to cast into the frame, it does not need to receive.
const SHADOW_LEAD = 0.38;
// The light's direction is HELD and moved in steps this size. See the note at
// the shadow rig in updateSky for why that is the whole trick.
const SHADOW_STEP_COS = Math.cos(0.12 * Math.PI / 180);

// Shadows used to end in a ruled line at the edge of the box. This feathers
// the last tenth of it instead. One chunk, patched once at import, before any
// material compiles; the sun is the only light that casts.
THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment.replace(
  '\t\t}\n\t\treturn shadow;\n\t}\n\tvec2 cubeToUV',
  '\t\t}\n\t\tvec2 atcEdge = abs( shadowCoord.xy - 0.5 ) * 2.0;\n'
  + '\t\tshadow = mix( shadow, 1.0, smoothstep( 0.86, 1.0, length( atcEdge ) ) );\n'
  + '\t\treturn shadow;\n\t}\n\tvec2 cubeToUV');

// ---- gradient sky dome ----
// Horizon to zenith gradient; on top of it drifting FBM clouds (sun-lit, dark
// undersides, silver lining), a proper sun (tight bright core plus a wide warm
// forward-scatter halo) dimmed behind clouds and faded out at night via uDay,
// a cool moon disc OPPOSITE the sun so it is up exactly when the sun is down,
// and a star field behind all of it. The dome is small (well inside
// camera.far) and re-centered on the camera every frame, so at any distance it
// shows no parallax at all.
//
// ONE SHADER, TWO USES. Compiled with ATC_ENV it is the picture envmap.js
// bakes into the reflection map: the same sky, minus the stars (a prefiltered
// map would only smear them into noise), with the ground's own brightness
// below the horizon so a car door reflects tarmac rather than more sky.
const SKY_VERT = /* glsl */`
  varying vec3 vSkyDir;
  void main() {
    vSkyDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SKY_FRAG = /* glsl */`
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uTime;
  uniform float uDay;      // 1 = full daylight, 0 = deep night
  uniform float uMoon;     // 0 = no moon, 1 = full night moon
  uniform float uCloudAmt; // cloud opacity master (0 hides them entirely)
  uniform float uStars;    // 0 = none (day, twilight), 1 = a clear night
  uniform float uAfter;    // 0..1: the afterglow band where the sun went down
  uniform vec3 uGround;    // ATC_ENV only: what the ground sends back up
  uniform float uEnvGain;  // ATC_ENV only: the global reflection scale
  varying vec3 vSkyDir;
  float chash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float cnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(chash(i), chash(i + vec2(1.0, 0.0)), f.x),
               mix(chash(i + vec2(0.0, 1.0)), chash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float cfbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * cnoise(p); p = p * 2.17 + vec2(11.3, 7.9); a *= 0.5; }
    return s;
  }
  ${AFTERGLOW_GLSL}
  #ifndef ATC_ENV
  // Stars: the direction is folded onto the faces of a cube and each face cut
  // into cells; one cell in five holds a star at a hashed spot. A cube and not
  // latitude/longitude, because a lat/long grid crowds every star it has into
  // the zenith. px is the size of a screen pixel in cell units: a star is
  // never drawn smaller than a pixel, or it would flicker in and out as the
  // camera turns.
  vec3 starField(vec3 d, float px) {
    vec3 a = abs(d);
    vec2 uv; float face;
    if (a.y >= a.x && a.y >= a.z) { uv = d.xz / a.y; face = 0.0; }
    else if (a.x >= a.z) { uv = d.zy / a.x; face = d.x > 0.0 ? 1.0 : 2.0; }
    else { uv = d.xy / a.z; face = d.z > 0.0 ? 3.0 : 4.0; }
    vec2 g = uv * 40.0;
    vec2 seed = floor(g) + face * 71.0;
    float pick = chash(seed);
    if (pick < 0.80) return vec3(0.0);
    vec2 c = vec2(chash(seed + 3.1), chash(seed + 7.7)) * 0.7 + 0.15;
    float r = max(0.034, px * 40.0);
    float core = 1.0 - smoothstep(r * 0.3, r, length(fract(g) - c));
    float mag = pow(chash(seed + 13.3), 5.0);          // most stars are faint
    float tw = 0.80 + 0.20 * sin(uTime * (1.3 + 3.5 * chash(seed + 5.5)) + pick * 40.0);
    vec3 tint = mix(vec3(0.74, 0.84, 1.0), vec3(1.0, 0.90, 0.74), chash(seed + 9.9));
    // a star stretched to a whole pixel must not gain light by it
    float keep = min(1.0, (0.034 * 0.034) / (r * r) * 2.2);
    return tint * (core * (0.035 + 0.34 * mag) * tw * keep);
  }
  #endif
  void main() {
    vec3 dir = normalize(vSkyDir);
    // taken here, outside every branch: a derivative inside one is undefined
    float px = length(fwidth(dir));
    float h = clamp(dir.y, -1.0, 1.0);
    float t = pow(1.0 - max(h, 0.0), 1.8);
    // Below the horizon the dome is simply the horizon colour. It is only ever
    // seen past the edge of the streamed world, and the fog there IS this
    // colour, so the ground runs out into it without a line.
    vec3 col = mix(uZenith, uHorizon, t);
    vec3 sd = normalize(uSunDir);
    // the afterglow: under the clouds' own colour, so a cloud bank stands dark
    // against it (heightfog.js adds the same band to the haze)
    if (uAfter > 0.001) col += atcAfterglow(dir, sd) * uAfter;
    float sunDot = max(dot(dir, sd), 0.0);
    // clouds: two FBM layers on a slowly drifting plane overhead
    float cov = 0.0;
    if (h > 0.015 && uCloudAmt > 0.001) {
      vec2 cuv = dir.xz / (h + 0.18) * 0.55 + uTime * vec2(0.0065, 0.0028);
      float den = cfbm(cuv * 1.1) * 0.72 + cfbm(cuv * 3.1 + 40.0) * 0.28;
      cov = smoothstep(0.54, 0.72, den) * smoothstep(0.015, 0.14, h) * uCloudAmt;
      float thick = smoothstep(0.54, 0.95, den);
      vec3 cLight = mix(vec3(0.014, 0.018, 0.030), vec3(1.08, 1.06, 1.02), uDay);
      vec3 cShade = mix(vec3(0.004, 0.005, 0.010), vec3(0.72, 0.76, 0.84), uDay);
      vec3 cloudCol = mix(cLight, cShade, thick);
      // silver lining: cloud edges facing the sun catch its color
      cloudCol += uSunColor * pow(sunDot, 4.0) * 0.35 * (1.0 - thick) * uDay;
      col = mix(col, cloudCol, cov);
    }
    #ifndef ATC_ENV
    // stars: gone under cloud, gone in twilight, and thinned out toward the
    // horizon, where you are looking through twenty times as much air
    if (uStars > 0.001 && h > 0.0) {
      col += starField(dir, px) * (uStars * (1.0 - cov) * smoothstep(0.0, 0.24, h));
    }
    #endif
    // the sun: bright core disc, soft rim, wide warm halo. Dims behind clouds.
    // heightfog.js repeats this halo term for the haze: keep the two in step.
    float disc = smoothstep(0.99935, 0.99985, sunDot);
    float halo = pow(sunDot, 80.0) * 0.6 + pow(sunDot, 7.0) * 0.25;
    col += uSunColor * (disc * 1.6 * (1.0 - cov * 0.85) + halo * (1.0 - cov * 0.85 * step(0.015, h))) * uDay;
    // the moon: a small cool disc opposite the sun. The sun really sets here,
    // so the night sky needs its own light source to read as a sky at all
    if (uMoon > 0.001) {
      float mDot = max(dot(dir, -sd), 0.0);
      // A MOON IS A PEBBLE LIT BY THE SUN, not a second sun. It used to paint
      // the dome hard enough to read as daylight ("měsíc svítí opravdu krutě"),
      // which is also what stopped the street lamps meaning anything: you
      // cannot light a scene that is already lit. The disc stays under the
      // bloom threshold and the glow around it stays a few degrees wide.
      // 1.6° across where it used to be 4°: still three times the real thing,
      // because a true half-degree moon is four pixels and reads as a star.
      float mDisc = smoothstep(0.99955, 0.99982, mDot);
      float mHalo = pow(mDot, 600.0) * 0.030 + pow(mDot, 30.0) * 0.003;
      // a hint of the maria, so it is a body and not a hole in the sky
      float mSurf = 0.78 + 0.22 * cnoise(dir.xy * 95.0 + 3.7);
      col += vec3(0.72, 0.80, 1.0) * (mDisc * 0.42 * mSurf + mHalo) * uMoon * (1.0 - cov * 0.9);
    }
    #ifdef ATC_ENV
    col = mix(col, uGround, smoothstep(0.0, -0.10, h)) * uEnvGain;
    #endif
    gl_FragColor = vec4(col, 1.0);
    // Both chunks, like every other material: on the canvas (post off) they
    // apply the renderer's tone curve and the sRGB encode; into the post
    // target, or the reflection cube, three makes them no-ops and the dome
    // stays linear. Without them the direct path showed linear values as if
    // they were sRGB, and the low preset had a different sky.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function makeSkyDome(radius) {
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide,
    depthWrite: false, depthTest: false, fog: false,
    uniforms: {
      uHorizon: { value: DAY_SKY.horizon.clone() },
      uZenith: { value: DAY_SKY.zenith.clone() },
      uSunDir: { value: new THREE.Vector3(0.35, 0.85, 0.25) },
      uSunColor: { value: SUN_DAY.clone() },
      uTime: { value: 0 },
      uDay: { value: 1 },
      uMoon: { value: 0 },
      uCloudAmt: { value: 0.82 },
      uStars: { value: 0 },
      uAfter: { value: 0 },
      uGround: { value: new THREE.Color(0.15, 0.15, 0.15) },
      uEnvGain: { value: 1 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000; // always draws first: depth-less, nothing else needs to know
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false; // re-positioned + updateMatrix()ed by updateSky
  // ...and once more by whatever camera actually draws it. A 45 m dome is only
  // a sky while the camera is inside it: a camera moved after updateSky (a dev
  // free camera, a photo pose) stood outside and saw it as a pale glossy ball
  // by the edge of the view (the round 7 review's "dome artefact" at Žižkov and
  // Vyšehrad). three computes modelViewMatrix after this hook, and the dome
  // has no rotation or scale, so moving its world matrix is the whole job.
  mesh.onBeforeRender = (r, s, cam) => {
    mesh.position.copy(cam.position);
    mesh.matrix.setPosition(cam.position);
    mesh.matrixWorld.setPosition(cam.position);
  };
  return mesh;
}

// The capture twin of the dome's material: same shader with ATC_ENV, and the
// SAME uniform holders, so the two can never disagree about the sky.
function makeEnvDomeMaterial(domeMat) {
  return new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide,
    depthWrite: false, depthTest: false, fog: false,
    defines: { ATC_ENV: '' },
    uniforms: domeMat.uniforms,
  });
}

// ---- public API ----

// Unit sun direction for a time of day. tod 0..1 with 0 = midnight. City axes:
// x east, z SOUTH, so az 0 points east, π/2 south, π west: the sun arcs
// through the southern sky exactly as it should at Pardubice's latitude, and
// travels on under the horizon through the night (solarPhase runs 1..2 there).
export function sunDirOf(tod, out = new THREE.Vector3()) {
  const sp = solarPhase((((tod % 1) + 1) % 1) * 24);
  const elev = elevOfPhase(sp) * (Math.PI / 180); // +75° at noon, −40° at midnight
  const az = Math.PI * sp;
  return out.set(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az));
}

// How dark it is, on the same continuous curve the lights and the fog use:
// 0 while the sun is well up, 1 once it is properly under. Exported so
// modules that only need the darkness (clouds) don't have to reach into the
// light rig for it, and so it can be sampled for a time of day nobody is
// currently rendering.
export function nightKOf(tod) {
  return nightAtHour((((tod % 1) + 1) % 1) * 24);
}

// "HH:MM" for the HUD clock. Floors to the minute; tolerates tod outside 0..1.
// The epsilon absorbs float error at exact minute boundaries (23:59 read as
// 23:58 without it: 1439/1440 * 1440 lands a hair under the integer).
export function todClock(tod) {
  const m = Math.floor((((tod % 1) + 1) % 1) * 24 * 60 + 1e-6);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// Build the whole sky rig: gradient dome + hemisphere ambient + shadow sun.
// Lighting leans DIRECTIONAL: a strong warm sun against a modest ambient, so
// facades get punchy sun-lit faces and deep readable shadows, not a flat wash.
// `renderer` is optional: with it the sky also bakes itself into
// scene.environment (see envmap.js); without it (tests) nothing else changes.
export function makeSky(scene, renderer = null) {
  const dome = makeSkyDome(45); // small but depth-less: inside any camera.far
  scene.add(dome);
  // hemisphere adapted to the city palette: cool daylight from the sky above,
  // asphalt-gray bounce from the streets below (the Woods used forest greens)
  const hemi = new THREE.HemisphereLight(0xdfe7f0, 0x3a3d42, LIGHT.hemiDay);
  const sun = new THREE.DirectionalLight(0xfff2dd, LIGHT.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // The ortho frustum is sized every frame in updateSky from the map size
  // (shadowHalf), so a setting that changes the map changes the box with it.
  sun.shadow.camera.near = 1;
  // about 2 texels: enough to keep flat roofs and roadways free of shadow acne
  // without visibly detaching thin casters
  sun.shadow.normalBias = 0.15;
  scene.add(hemi, sun, sun.target);
  return {
    dome, hemi, sun, target: sun.target,
    sunDir: new THREE.Vector3(0.704, 0.557, 0.44), // live direction, updated per frame
    nightK: 0,        // live darkness 0..1, updated per frame (clouds read it)
    cloudAmt: 0.82,   // main may thin/hide the DOME's painted clouds (0 = clear);
                      // the 3D cluster field in clouds.js is separate from these
    time: 0, _last: 0, // internal cloud-drift clock (wall time, clamped)
    sunColor: SUN_DAY.clone(), sunI: LIGHT.sunI, moonK: 0, warm: 0, after: 0,
    lightDir: new THREE.Vector3(0.704, 0.557, 0.44),
    _held: new THREE.Vector3(), _half: 0,   // shadow rig state, see updateSky
    env: renderer ? new SkyEnv(renderer, scene, makeEnvDomeMaterial(dome.material)) : null,
    exposure: EXPOSURE_DAY, renderer,
    light: LIGHT, ab: LOOK_AB,   // live knobs and the A/B switches, for the console
  };
}

const _horC = new THREE.Color(), _zenC = new THREE.Color(), _gndC = new THREE.Color();
const _deepC = new THREE.Color();
const _ld = new THREE.Vector3(), _rt = new THREE.Vector3(), _up = new THREE.Vector3();
const _fw = new THREE.Vector3();
// what an average street sends back up, for the lower half of the reflection
const GROUND_ALBEDO = 0.19;

// Drive the whole atmosphere from tod (0..1). Call once per frame, after the
// camera has moved. Sets scene.fog + scene.background, all dome uniforms, the
// hemi/sun intensities and colours, and parks the shadow sun on the camera.
export function updateSky(sky, tod, camera, scene, groundY = camera.position.y - 6) {
  const { dome, hemi, sun } = sky;
  // the cloud-drift clock advances on wall time, clamped so a hidden tab
  // doesn't teleport the cloud field when rAF resumes
  const now = performance.now();
  sky.time += Math.min(0.1, (now - (sky._last || now)) / 1000);
  sky._last = now;

  const dir = sunDirOf(tod, sky.sunDir);
  const nightK = nightAtHour((((tod % 1) + 1) % 1) * 24);
  sky.nightK = nightK; // published for clouds.js & co, see the header note
  // one exposure for both render paths: the direct path reads it off the
  // renderer, and the post composite reads the renderer too
  sky.exposure = EXPOSURE_DAY * Math.pow(EXPOSURE_NIGHT / EXPOSURE_DAY, nightK);
  if (sky.renderer) sky.renderer.toneMappingExposure = sky.exposure;
  const sunElev = Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI;

  // ---- ambient ----
  // The ambient is the sky's own light and nothing else. By day it is the
  // blue bowl; at night it is a deep blue fifth of that, which is a moonlit
  // field: a kerb, a silhouette, the shape of a street. It is NOT the town's
  // lighting. That belongs to the lamps (lightpools.js draws their pools on
  // the road), and an ambient bright enough to stand in for them is what once
  // made the lamps pointless. The old floor of 3.5 % was the other mistake:
  // with no pools and no moon it left a black screen.
  const ab = LOOK_AB.light;          // false: the old rig, see OLD
  const hemiDay = ab ? LIGHT.hemiDay : OLD.hemiDay;
  hemi.intensity = hemiDay + (HEMI_NIGHT - hemiDay) * nightK;
  // (its colours are set below, once the sun and the golden hour are known)

  // ---- the sun, and who holds the light ----
  // the directional sun switches off as it crosses the horizon, fading over
  // the ~4° around it, like the disc sinking in: it must still rake warm light
  // down the streets AT sunset, not switch off a degree early
  const above = Math.max(0, Math.min(1, (sunElev + 2) / 4));
  const sunI = (ab ? LIGHT.sunI : OLD.sunI) * (1 - 0.94 * nightK) * above;
  // GOLDEN HOUR, driven purely by how low the sun hangs: neutral warm-white
  // high up, deepening through amber to sunset orange at the horizon. Not
  // gated by nightK: that would cancel the warmth exactly when the sun sits
  // lowest and the light would never actually go gold.
  const warm = smooth01((GOLDEN_TOP - sunElev) / GOLDEN_TOP);
  sky.sunColor.copy(ab ? SUN_DAY : OLD.sunDay).lerp(SUN_LOW, warm);
  sky.warm = warm;        // the grade in postfx.js follows the same curve
  sky.sunI = sunI;
  // The moon takes over once the sun is 3° under and is fully up by 13°. The
  // sun has been at zero since 2° under, so the light changes sides while it
  // is dark and nothing on screen jumps.
  const moonK = smooth01((-sunElev - 3) / 10);
  sky.moonK = moonK;
  const moonUp = sunElev < -2.5;
  if (moonUp) {
    sky.lightDir.copy(dir).negate();
    sun.color.copy(MOON_COL);
    sun.intensity = MOON_I * moonK;
  } else {
    sky.lightDir.copy(dir);
    sun.color.copy(sky.sunColor);
    sun.intensity = sunI;
  }
  // afterglow weight for the AIR (fog + sky): peaks across the golden hour,
  // dies once the sun is well under, so the warm band fades with the light
  // instead of being dragged on through the night
  const glowK = warm * Math.max(0, Math.min(1, (sunElev + 14) / 16));
  // …and the band itself, which belongs to the time AFTER sunset: nothing
  // while the disc is still up to do the job, brightest with the sun four or
  // five degrees under, and gone at astronomical dusk. Its level is tiny
  // because it is seen through an exposure that has already begun to open.
  const after = AFTERGLOW * smooth01((3 - sunElev) / 7) * smooth01((sunElev + 17) / 11);
  sky.after = after;

  // ---- the fill's colours (see HEMI_SKY_* and BOUNCE above) ----
  if (ab) {
    hemi.color.copy(HEMI_SKY_DAY).lerp(HEMI_SKY_GOLD, glowK * 0.55).lerp(HEMI_SKY_NIGHT, nightK);
    // what the streets send back up, as a share of the fill's own intensity:
    // the sun's light on the ground times half the street's albedo, plus a
    // dim grey that is all that is left of it after dark
    const bounce = LIGHT.bounce * GROUND_ALBEDO * sunI * Math.max(0, dir.y) / Math.max(0.05, hemi.intensity);
    hemi.groundColor.setRGB(0.17 + BOUNCE_TINT.r * bounce, 0.16 + BOUNCE_TINT.g * bounce, 0.15 + BOUNCE_TINT.b * bounce);
  } else {
    hemi.color.setRGB(0.72 - 0.27 * nightK, 0.84 - 0.26 * nightK, 1.0 - 0.02 * nightK);
    hemi.groundColor.setRGB(0.23 - 0.05 * nightK, 0.24 - 0.09 * nightK, 0.26 - 0.13 * nightK);
  }

  // SUNSET first, then night, applied in that order so the gold gets
  // swallowed by the dark as dusk deepens.
  const daySky = ab ? DAY_SKY : OLD.day, nightSky = ab ? NIGHT_SKY : OLD.night;
  _horC.copy(daySky.horizon).lerp(SUNSET_FOG, glowK * 0.75).lerp(nightSky.horizon, nightK);
  _zenC.copy(daySky.zenith).lerp(SUNSET_SKY, glowK * 0.62).lerp(nightSky.zenith, nightK);
  if (!scene.fog) scene.fog = new THREE.Fog(0, 600, FOG_DAY_FAR);
  // The stock uniform is still fed: a material that never heard of
  // heightfog.js falls back to it, and main.js reads it for the apron.
  scene.fog.color.copy(_horC);
  if (scene.fog.isFog) {
    // sky.fogScale lets the caller stretch the haze when the view radius grows
    // (flight streams the city much further out). The wall must always sit
    // INSIDE the streamed edge, or you see the world simply stop.
    const fs = sky.fogScale ?? 1;
    const edge = (FOG_DAY_FAR + (FOG_NIGHT_FAR - FOG_DAY_FAR) * nightK) * fs;
    // (the streamed edge's own wall, whatever the view: main.js hands it to
    // the crowd, the traffic and the Prague skyline)
    sky.edgeFar = edge;
    const fo = sky.fogOpen ?? 0;
    scene.fog.far = fo > 0 ? edge + (Math.max(edge, OPEN_DAY_FAR + (OPEN_NIGHT_FAR - OPEN_DAY_FAR) * nightK) - edge) * fo : edge;
    sky.fogVis = fo > 0 ? edge + (Math.max(edge, OPEN_DAY_VIS + (OPEN_NIGHT_VIS - OPEN_DAY_VIS) * nightK) - edge) * fo : scene.fog.far;
    // near is where the WALL starts now, not where the haze starts: the haze
    // is heightfog.js's exponential and begins at your feet
    scene.fog.near = scene.fog.far * FOG_WALL_START;
  }
  const uDay = 1 - nightK * 0.92;   // sun + bright clouds fade out at night
  _deepC.copy(_horC).lerp(_zenC, AIR_UP);
  const deepK = LOOK_AB.air ? AIR_K * (1 - 0.6 * nightK) : 0;
  setAirFog(_horC, dir, sky.sunColor, uDay, scene.fog.far ?? FOG_DAY_FAR, groundY, after,
    sky.fogVis ?? scene.fog.far ?? FOG_DAY_FAR, _deepC, deepK);
  // background still matters behind the dome: postfx passes and clears see it,
  // and if main ever hides the dome the scene collapses to a sane flat sky
  if (!scene.background?.isColor) scene.background = new THREE.Color();
  scene.background.copy(_zenC);

  // dome: re-centered on the camera every frame (zero parallax at any radius)
  dome.position.copy(camera.position);
  dome.updateMatrix();
  const u = dome.material.uniforms;
  u.uHorizon.value.copy(_horC);
  u.uZenith.value.copy(_zenC);
  u.uSunDir.value.copy(dir);
  u.uSunColor.value.copy(sky.sunColor); // disc, cloud lining and halo all read it
  u.uTime.value = sky.time;
  u.uDay.value = uDay;
  u.uMoon.value = nightK;            // …and the moon takes over as they go
  u.uCloudAmt.value = sky.cloudAmt;
  // stars wait for real darkness: nothing until the sky is 55 % of the way to
  // night, all of them only once it is there
  u.uStars.value = smooth01((nightK - 0.55) / 0.45);
  u.uAfter.value = after;

  // ---- the reflection of all of the above ----
  // What a horizontal street throws back up: its albedo times the light that
  // lands on it. Used only for the lower half of the environment map.
  const down = Math.max(0, sky.lightDir.y) * sun.intensity;
  _gndC.setRGB(
    GROUND_ALBEDO * (sun.color.r * down + hemi.color.r * hemi.intensity) / Math.PI,
    GROUND_ALBEDO * (sun.color.g * down + hemi.color.g * hemi.intensity) / Math.PI,
    GROUND_ALBEDO * (sun.color.b * down + hemi.color.b * hemi.intensity) / Math.PI);
  u.uGround.value.copy(_gndC);
  sky.env?.update(dir, nightK, sky.cloudAmt, now);

  // ---- the shadow rig ----
  // Parked on the camera so shadows always cover what you see. Heights are
  // RELATIVE to groundY, the terrain under the camera: this is an
  // absolute-elevation world (Pardubice streets lie at ~220 m ASL), and a rig
  // parked at y = 0..140 puts the whole shadow frustum a hundred metres under
  // the pavement ("stíny vůbec nefungují"). The light's height above ground
  // keeps a floor: a light below the streets would throw the whole ortho
  // frustum upside down.
  //
  // WHY SHADOWS USED TO SWIM. The box followed the camera continuously, so the
  // shadow map's texel grid slid across the world with every step and each
  // edge was resampled differently every frame. The cure is to move the box
  // only in whole texels. That needs a grid that is FIXED in the world, and
  // the grid is defined by the light's own axes, so it is only fixed while the
  // light's direction is. Here the sun turns a quarter of a degree a second,
  // and three kilometres from the origin that drags the grid two texels a
  // frame: snapping against a turning direction snaps to nothing. So the
  // direction the light is DRAWN from is held still and stepped 0.12° at a
  // time (a shadow tip moves about 2 cm per step at noon). Between steps the
  // grid is world-fixed and the snap is exact.
  _ld.set(sky.lightDir.x, Math.max(0.12, sky.lightDir.y), sky.lightDir.z).normalize();
  if (sky._held.lengthSq() < 0.5 || sky._held.dot(_ld) < SHADOW_STEP_COS) sky._held.copy(_ld);
  const ld = sky._held;
  const half = shadowHalf(sun.shadow.mapSize.x);
  const sc = sun.shadow.camera;
  if (sky._half !== half) {
    sky._half = half;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.far = SHADOW_DIST + half * 1.5 + 60;
    sc.updateProjectionMatrix();
  }
  // the light's own right and up, exactly as three builds them (lookAt with
  // world +Y), so a texel here is a texel in the map
  _rt.set(ld.z, 0, -ld.x).normalize();          // +Y × ld
  _up.crossVectors(ld, _rt);
  camera.getWorldDirection(_fw);
  const fl = Math.hypot(_fw.x, _fw.z) || 1;
  const cx = camera.position.x + (_fw.x / fl) * half * SHADOW_LEAD;
  const cz = camera.position.z + (_fw.z / fl) * half * SHADOW_LEAD;
  const texel = (half * 2) / sun.shadow.mapSize.x;
  const a = Math.round((cx * _rt.x + groundY * _rt.y + cz * _rt.z) / texel) * texel;
  const b = Math.round((cx * _up.x + groundY * _up.y + cz * _up.z) / texel) * texel;
  const c = cx * ld.x + groundY * ld.y + cz * ld.z;
  const tx = _rt.x * a + _up.x * b + ld.x * c;
  const ty = _rt.y * a + _up.y * b + ld.y * c;
  const tz = _rt.z * a + _up.z * b + ld.z * c;
  sun.target.position.set(tx, ty, tz);
  sun.position.set(tx + ld.x * SHADOW_DIST, ty + ld.y * SHADOW_DIST, tz + ld.z * SHADOW_DIST);
}
