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

import * as THREE from 'three';

// ---- the sun's path, and the darkness that FOLLOWS from it ----
const SUNRISE = 5, SUNSET = 21, SUN_PEAK = 75; // hours, hours, degrees
// 0..1 from sunrise to sunset, then 1..2 on through the night — one continuous
// phase, so elevation genuinely goes negative after dark instead of the disc
// parking above the horizon all night
function solarPhase(h) {
  if (h >= SUNRISE && h < SUNSET) return (h - SUNRISE) / (SUNSET - SUNRISE);
  const nh = h < SUNRISE ? h + 24 : h;
  return 1 + (nh - SUNSET) / (24 - SUNSET + SUNRISE);
}
const sunElevAt = h => SUN_PEAK * Math.sin(Math.PI * solarPhase(h));
const smooth01 = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
// Night is derived from the sun: full day while it is well up, twilight as it
// sinks through the horizon, full night once it is properly under.
const TWILIGHT_TOP = 8, TWILIGHT_BOTTOM = -10; // degrees of elevation
const nightAtHour = h =>
  smooth01((TWILIGHT_TOP - sunElevAt(h)) / (TWILIGHT_TOP - TWILIGHT_BOTTOM));

// ---- palette: urban gray-blues by day; the Woods' sunset/night bands kept ----
const DAY_FOG = new THREE.Color(0xa8b8c8); // gray-blue city haze
const DAY_SKY = { horizon: new THREE.Color(0x9fc0dd), zenith: new THREE.Color(0x5a8fc0) };
const NIGHT_SKY = new THREE.Color(0x070c22), NIGHT_FOG = new THREE.Color(0x0d1226);
// sunset: warm haze along the horizon, pink-violet in the sky above it — the
// band across the AIR is what actually reads as a sunset; sun colour alone
// barely registers when most of the frame is facades and asphalt
const SUNSET_FOG = new THREE.Color(0xe08c4a), SUNSET_SKY = new THREE.Color(0x9c5f80);
// sun light colour (linear working space): neutral warm-white high up → deep
// sunset orange at the horizon. GOLDEN_TOP is the elevation where warming starts.
const GOLDEN_TOP = 30;
const SUN_DAY = new THREE.Color(1.0, 0.97, 0.92);
const SUN_LOW = new THREE.Color(1.0, 0.38, 0.13);
// linear fog wall: generous by day (city blocks read out to ~900 m), pulled in
// at night so the dark swallows the distance instead of a luminous gray wash
const FOG_DAY = { near: 180, far: 900 }, FOG_NIGHT = { near: 120, far: 520 };

// ---- gradient sky dome (ported verbatim from the Woods, moon included) ----
// Horizon→zenith gradient; on top of it drifting FBM clouds (sun-lit, dark
// undersides, silver lining), a proper sun — tight bright core plus a wide
// warm forward-scatter halo — dimmed behind clouds and faded out at night via
// uDay, and a cool moon disc OPPOSITE the sun so it is up exactly when the sun
// is down. The dome is small (well inside camera.far) and re-centered on the
// camera every frame, so at any distance it shows no parallax at all.
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
  void main() {
    vec3 dir = normalize(vSkyDir);
    float h = clamp(dir.y, -1.0, 1.0);
    float t = pow(1.0 - max(h, 0.0), 1.8);
    vec3 col = mix(uZenith, uHorizon, t);
    if (h < 0.0) col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.35, h));
    vec3 sd = normalize(uSunDir);
    float sunDot = max(dot(dir, sd), 0.0);
    // clouds: two FBM layers on a slowly drifting plane overhead
    float cov = 0.0;
    if (h > 0.015 && uCloudAmt > 0.001) {
      vec2 cuv = dir.xz / (h + 0.18) * 0.55 + uTime * vec2(0.0065, 0.0028);
      float den = cfbm(cuv * 1.1) * 0.72 + cfbm(cuv * 3.1 + 40.0) * 0.28;
      cov = smoothstep(0.54, 0.72, den) * smoothstep(0.015, 0.14, h) * uCloudAmt;
      float thick = smoothstep(0.54, 0.95, den);
      vec3 cLight = mix(vec3(0.17, 0.19, 0.26), vec3(1.08, 1.06, 1.02), uDay);
      vec3 cShade = mix(vec3(0.09, 0.10, 0.15), vec3(0.72, 0.76, 0.84), uDay);
      vec3 cloudCol = mix(cLight, cShade, thick);
      // silver lining: cloud edges facing the sun catch its color
      cloudCol += uSunColor * pow(sunDot, 4.0) * 0.35 * (1.0 - thick) * uDay;
      col = mix(col, cloudCol, cov);
    }
    // the sun: bright core disc, soft rim, wide warm halo — dims behind clouds
    float disc = smoothstep(0.99935, 0.99985, sunDot);
    float halo = pow(sunDot, 80.0) * 0.6 + pow(sunDot, 7.0) * 0.25;
    col += uSunColor * (disc * 1.6 + halo) * uDay * (1.0 - cov * 0.85);
    // the moon: a small cool disc opposite the sun — the sun really sets here,
    // so the night sky needs its own light source to read as a sky at all
    if (uMoon > 0.001) {
      float mDot = max(dot(dir, -sd), 0.0);
      float mDisc = smoothstep(0.9990, 0.9997, mDot);
      float mHalo = pow(mDot, 200.0) * 0.45;
      col += vec3(0.74, 0.80, 0.96) * (mDisc * 1.5 + mHalo) * uMoon * (1.0 - cov * 0.9);
    }
    gl_FragColor = vec4(col, 1.0);
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
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000; // always draws first — depth-less, nothing else needs to know
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false; // re-positioned + updateMatrix()ed by updateSky
  return mesh;
}

// ---- public API ----

// Unit sun direction for a time of day. tod 0..1 with 0 = midnight. City axes:
// x east, z SOUTH — so az 0 points east, π/2 south, π west: the sun arcs
// through the southern sky exactly as it should at Pardubice's latitude, and
// travels on under the horizon through the night (solarPhase runs 1..2 there).
export function sunDirOf(tod, out = new THREE.Vector3()) {
  const sp = solarPhase((((tod % 1) + 1) % 1) * 24);
  const elev = SUN_PEAK * Math.sin(Math.PI * sp) * (Math.PI / 180); // ±75°
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
// 23:58 without it — 1439/1440 * 1440 lands a hair under the integer).
export function todClock(tod) {
  const m = Math.floor((((tod % 1) + 1) % 1) * 24 * 60 + 1e-6);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// Build the whole sky rig: gradient dome + hemisphere ambient + shadow sun.
// Lighting leans DIRECTIONAL — a strong warm sun against a modest ambient, so
// facades get punchy sun-lit faces and deep readable shadows, not a flat wash.
export function makeSky(scene) {
  const dome = makeSkyDome(45); // small but depth-less: inside any camera.far
  scene.add(dome);
  // hemisphere adapted to the city palette: cool daylight from the sky above,
  // asphalt-gray bounce from the streets below (the Woods used forest greens)
  const hemi = new THREE.HemisphereLight(0xdfe7f0, 0x3a3d42, 0.74);
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // ortho frustum: ±90 m around the target covers a street scene plus the
  // towers throwing long shadows into it. The light stands 140 m out (see
  // updateSky), so the far plane must reach 140 + 90 + margin past the near.
  sun.shadow.camera.left = -90; sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 280;
  scene.add(hemi, sun, sun.target);
  return {
    dome, hemi, sun, target: sun.target,
    sunDir: new THREE.Vector3(0.704, 0.557, 0.44), // live direction, updated per frame
    nightK: 0,        // live darkness 0..1, updated per frame (clouds read it)
    cloudAmt: 0.82,   // main may thin/hide the DOME's painted clouds (0 = clear);
                      // the 3D cluster field in clouds.js is separate from these
    time: 0, _last: 0, // internal cloud-drift clock (wall time, clamped)
  };
}

const _fogC = new THREE.Color(), _horC = new THREE.Color(), _zenC = new THREE.Color();

// Drive the whole atmosphere from tod (0..1). Call once per frame, after the
// camera has moved. Sets scene.fog + scene.background, all dome uniforms, the
// hemi/sun intensities and colours, and parks the shadow sun on the camera.
export function updateSky(sky, tod, camera, scene) {
  const { dome, hemi, sun } = sky;
  // the cloud-drift clock advances on wall time, clamped so a hidden tab
  // doesn't teleport the cloud field when rAF resumes
  const now = performance.now();
  sky.time += Math.min(0.1, (now - (sky._last || now)) / 1000);
  sky._last = now;

  const dir = sunDirOf(tod, sky.sunDir);
  const nightK = nightAtHour((((tod % 1) + 1) % 1) * 24);
  sky.nightK = nightK; // published for clouds.js & co — see the header note
  const sunElev = Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI;

  // Night bites hard: the world's own lights drop close to nothing after dark
  // (hemi ~0.10, sun off) so street lamps and headlights are what carve out
  // the visible bubble — we darken the LIGHTS, never a screen overlay, which
  // would flatten any local light sources into the murk too.
  // A CITY at night is not a forest at night: sodium street lighting bounces
  // off tarmac and facades into a permanent warm glow (light pollution), so
  // the floor sits well above the Woods' near-black and drifts amber as the
  // sun goes. Pitch dark would also hide the pedestrians and the traffic that
  // make the place feel alive.
  hemi.intensity = 0.74 * (1 - 0.70 * nightK);
  hemi.color.setRGB(0.87 - 0.10 * nightK, 0.91 - 0.19 * nightK, 1.0 - 0.42 * nightK);
  hemi.groundColor.setRGB(0.23 + 0.16 * nightK, 0.24 + 0.10 * nightK, 0.26);
  // the directional sun switches off as it crosses the horizon — fading over
  // the ~4° around it, like the disc sinking in: it must still rake warm light
  // down the streets AT sunset, not switch off a degree early
  const above = Math.max(0, Math.min(1, (sunElev + 2) / 4));
  sun.intensity = 1.8 * (1 - 0.94 * nightK) * above;
  // GOLDEN HOUR, driven purely by how low the sun hangs: neutral warm-white
  // high up, deepening through amber to sunset orange at the horizon. Not
  // gated by nightK — that would cancel the warmth exactly when the sun sits
  // lowest and the light would never actually go gold.
  const warm = smooth01((GOLDEN_TOP - sunElev) / GOLDEN_TOP);
  sun.color.copy(SUN_DAY).lerp(SUN_LOW, warm);
  // afterglow weight for the AIR (fog + sky): peaks across the golden hour,
  // dies once the sun is well under, so the warm band fades with the light
  // instead of being dragged on through the night
  const glowK = warm * Math.max(0, Math.min(1, (sunElev + 8) / 10));

  // SUNSET first, then night — applied in that order so the gold gets
  // swallowed by the dark as dusk deepens. The night lerp stops at 0.94: a
  // hint of the day hue survives, which reads as moonlit haze, not pure black.
  _fogC.copy(DAY_FOG).lerp(SUNSET_FOG, glowK * 0.75).lerp(NIGHT_FOG, nightK * 0.94);
  _horC.copy(DAY_SKY.horizon).lerp(SUNSET_FOG, glowK * 0.75).lerp(NIGHT_FOG, nightK * 0.94);
  _zenC.copy(DAY_SKY.zenith).lerp(SUNSET_SKY, glowK * 0.62).lerp(NIGHT_SKY, nightK * 0.94);
  if (!scene.fog) scene.fog = new THREE.Fog(_fogC.getHex(), FOG_DAY.near, FOG_DAY.far);
  scene.fog.color.copy(_fogC);
  if (scene.fog.isFog) { // linear fog: the wall pulls in as night falls
    scene.fog.near = FOG_DAY.near + (FOG_NIGHT.near - FOG_DAY.near) * nightK;
    scene.fog.far = FOG_DAY.far + (FOG_NIGHT.far - FOG_DAY.far) * nightK;
  }
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
  u.uSunColor.value.copy(sun.color); // disc, cloud lining and halo all read it
  u.uTime.value = sky.time;
  u.uDay.value = 1 - nightK * 0.92;  // sun + bright clouds fade out at night
  u.uMoon.value = nightK;            // …and the moon takes over as they go
  u.uCloudAmt.value = sky.cloudAmt;

  // park the shadow rig on the camera so shadows always cover what you see.
  // The light's HEIGHT is floored just above the ground: once the sun is down
  // its intensity is zero anyway, and a light placed below the streets would
  // throw the whole ortho shadow frustum upside down.
  sun.position.set(
    camera.position.x + dir.x * 140,
    Math.max(0.12, dir.y) * 140,
    camera.position.z + dir.z * 140);
  sun.target.position.set(camera.position.x, 0, camera.position.z);
}
