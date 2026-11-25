// ---- flight-cruise.js: what the window shows at 35 000 feet ----
// The cruise is ten hours and is shown as a minute. Nothing of the world can
// be seen from up there anyway: the camera's far plane is 1 400 m (main.js),
// and the map ends 110 km from Pardubice. So the aircraft is held at cruise
// height over the spot where it finished climbing, and under it floats the
// one thing a passenger actually looks at: a deck of cloud tops, with gaps
// through which the ground shows (land on the first leg, the Arabian Sea and
// the Indian Ocean on the second), lit by whatever hour the sky shows
// (js/flight.js drives the hour through worldclock.overrideTod). The deck's
// rim fades into the horizon's own colour (scene.fog.color, which js/sky.js
// sets every frame), so it has no edge.
//
// IT IS A SCALE MODEL. A real deck lies kilometres down and reaches the
// horizon; inside a 1 400 m far plane a deck 650 m down only showed below 27
// degrees, which from seat 14A is the wing. So it floats 160 m under the
// aircraft with everything shrunk by the same ratio (cloud cells of a few tens
// of metres), its rim 7 degrees under the horizon, and it streams past at the
// time-lapse's pace rather than the airliner's: ten hours in a minute.
//
// One mesh, one ShaderMaterial, only while the montage runs.

import * as THREE from 'three';

const R = 1250; // m, the deck's radius: its rim stays inside the 1 400 m far plane
const BELOW = 160; // m under the aircraft (a scale model of a deck kilometres down)
const DRIFT = 70; // m/s it streams past: the time-lapse's pace at this scale
const CELL = 70; // m per noise unit: cloud cells as they look from far above

const vert = `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const frag = `
uniform vec3 uCentre, uSun, uSunCol, uHorizon, uGround, uEye;
uniform vec2 uOffset;
uniform float uNight, uCover, uRadius, uCell;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
void main() {
  vec2 rel = vWorld.xz - uCentre.xz;
  float r = length(rel) / uRadius;
  vec2 p = (vWorld.xz + uOffset) / uCell;
  float n = fbm(p);
  float cloud = smoothstep(uCover, uCover + 0.16, n);
  // the tops catch the light: brighter where the noise climbs toward the sun
  float lift = fbm(p * 2.7 + 3.0);
  float day = clamp(uSun.y * 3.0 + 0.25, 0.0, 1.0);
  vec3 lit = mix(vec3(0.13, 0.16, 0.24), uSunCol * (0.75 + 0.35 * lift), day);
  lit = mix(lit, vec3(0.05, 0.07, 0.12), uNight * 0.85);
  // between them, the ground or the sea far below, with the sun's glint on water
  vec3 view = normalize(vWorld - uEye);
  vec3 refl = reflect(view, vec3(0.0, 1.0, 0.0));
  float glint = pow(max(dot(refl, normalize(uSun)), 0.0), 60.0) * day;
  vec3 under = uGround * (0.35 + 0.65 * day) * (1.0 - 0.8 * uNight) + uSunCol * glint * 0.8;
  vec3 col = mix(under, lit, cloud);
  // haze toward the rim, then gone into the horizon
  float haze = smoothstep(0.35, 0.95, r);
  col = mix(col, uHorizon, haze * 0.85);
  float alpha = 1.0 - smoothstep(0.8, 1.0, r);
  gl_FragColor = vec4(col, alpha);
}`;

export function cruiseDeck(scene) {
  const uniforms = {
    uCentre: { value: new THREE.Vector3() },
    uEye: { value: new THREE.Vector3() },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 0.97, 0.9) },
    uHorizon: { value: new THREE.Color(0.7, 0.78, 0.86) },
    uGround: { value: new THREE.Color(0.32, 0.33, 0.26) },
    uOffset: { value: new THREE.Vector2() },
    uNight: { value: 0 },
    uCover: { value: 0.46 },
    uRadius: { value: R },
    uCell: { value: CELL },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: vert, fragmentShader: frag,
    transparent: true, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(R, 72).rotateX(-Math.PI / 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.visible = false;
  mesh.name = 'Let • oblačnost pod letadlem';
  scene.add(mesh);
  const LAND = new THREE.Color(0.36, 0.33, 0.25), SEA = new THREE.Color(0.04, 0.16, 0.3);
  return {
    get on() { return mesh.visible; },
    show(on) { mesh.visible = on; },
    /**
     * @param plane { x, y, z, heading, speed }
     * @param sky js/sky.js state (sunDir, sunColor, nightK) and the horizon colour
     * @param sea 0 over land, 1 over the sea (it is crossed in the first leg's last part)
     */
    update(dt, plane, eye, sky, horizon, sea = 0) {
      if (!mesh.visible) return;
      mesh.position.set(plane.x, plane.y - BELOW, plane.z);
      uniforms.uCentre.value.copy(mesh.position);
      uniforms.uEye.value.copy(eye);
      // the ground moves backwards under a deck that stays put under us
      const v = DRIFT;
      const o = uniforms.uOffset.value;
      o.x += -Math.sin(plane.heading) * v * dt;
      o.y += -Math.cos(plane.heading) * v * dt;
      if (Math.abs(o.x) > 82000) o.x %= 82000;
      if (Math.abs(o.y) > 82000) o.y %= 82000;
      if (sky?.sunDir) uniforms.uSun.value.copy(sky.sunDir);
      if (sky?.sunColor) uniforms.uSunCol.value.copy(sky.sunColor);
      uniforms.uNight.value = sky?.nightK ?? 0;
      if (horizon) uniforms.uHorizon.value.copy(horizon);
      uniforms.uGround.value.copy(LAND).lerp(SEA, sea);
      // broken cloud over the desert, a fuller deck over the ocean
      uniforms.uCover.value = 0.5 - 0.07 * sea;
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
