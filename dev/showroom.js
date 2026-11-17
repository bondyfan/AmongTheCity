// ---- dev/showroom.js: a one-second visual loop for the car models ----------
// The full game takes tens of seconds to boot and puts a city between the
// camera and the car. This page imports the SAME js/vehicles.js the game does,
// stands the cars on a neutral floor under the game's own light rig (sun 1.8,
// hemisphere 0.74, ACES at 1.08) plus a PMREM environment generated from a
// sky-gradient scene, and frames them from URL parameters. Nothing here ships
// in the game: it is a lens for whoever is working on the cars.

import * as THREE from 'three';
// &veh=./other.js swaps the module under test (used once, to time the old
// cars against the new ones on the same machine in the same minute)
const VEH = await import(new URLSearchParams(location.search).get('veh') || '../js/vehicles.js');

const q = new URLSearchParams(location.search);
const P = {
  kind: q.get('kind') || 'all',
  view: q.get('view') || 'q',
  night: q.get('night') === '1' ? 1 : (parseFloat(q.get('night')) || 0),
  env: q.get('env') !== '0',
  color: q.get('color') ? parseInt(q.get('color'), 16) : null,
  dist: q.get('dist') ? parseFloat(q.get('dist')) : 0,
  lod: q.get('lod') || '',
  dent: q.get('dent') === '1',
  brake: q.get('brake') === '1',
  n: q.get('n') ? parseInt(q.get('n'), 10) : 0,
  steer: q.get('steer') ? parseFloat(q.get('steer')) : 0,
  fov: q.get('fov') ? parseFloat(q.get('fov')) : 0,
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const k = P.night;                                   // 0 day .. 1 night
const SKY = {
  zenith: new THREE.Color(0x4f86c9).lerp(new THREE.Color(0x05070c), k),
  horizon: new THREE.Color(0xa8b8c8).lerp(new THREE.Color(0x0b0e14), k),
  ground: new THREE.Color(0x4a4d52).lerp(new THREE.Color(0x050607), k),
};
scene.background = SKY.horizon.clone();

// the game's light rig, with the game's own night curve applied to it
const hemi = new THREE.HemisphereLight(0xdfe7f0, 0x3a3d42, 0.74 * (1 - 0.953 * k));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.8 * (1 - 0.94 * k));
// the game's sun sits at (0.704, 0.557, 0.44); here it swings round with the
// view so the side being photographed is the lit one (&sun=game keeps it put)
const REARISH = P.view === 'rq' || P.view === 'rear';
const sunDir = (q.get('sun') === 'game' ? new THREE.Vector3(0.704, 0.557, 0.44)
  : new THREE.Vector3(-0.42, 0.62, REARISH ? 0.66 : -0.66)).normalize();
sun.position.copy(sunDir).multiplyScalar(60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 160;
sun.shadow.normalBias = 0.04;
scene.add(hemi, sun, sun.target);

// ---- environment: a gradient sky dome with a sun, prefiltered in code ------
// This stands in for what the game's LIGHT package will hand to
// scene.environment. Nothing is loaded: the dome is a shader, the ground a
// disc, and PMREMGenerator turns the pair into the cube pyramid.
function makeEnvironment() {
  const s = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(50, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        uZen: { value: SKY.zenith }, uHor: { value: SKY.horizon }, uGnd: { value: SKY.ground },
        uSun: { value: sunDir }, uSunK: { value: 1 - k },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 uZen, uHor, uGnd, uSun; uniform float uSunK; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          vec3 sky = mix(uHor, uZen, pow(max(d.y, 0.0), 0.55));
          vec3 c = mix(uGnd, sky, smoothstep(-0.02, 0.03, d.y));
          float s = max(dot(d, normalize(uSun)), 0.0);
          c += vec3(1.0, 0.93, 0.8) * (pow(s, 600.0) * 40.0 + pow(s, 12.0) * 0.35) * uSunK;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
  s.add(dome);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.02);
  pm.dispose();
  return rt.texture;
}
if (P.env) scene.environment = makeEnvironment();

// neutral floor: mid-grey tarmac, rough, so paint reflections are the car's own
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x6d7074, roughness: 0.92, metalness: 0 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ---- cars ----------------------------------------------------------------
const vehicles = new VEH.Vehicles(scene);
const SHOW_COLORS = {
  octavia: 0x2f4f72, fabia: 0xb8433a, bmw: 0x22262c, mercedes: 0xb9bec6,
  tesla: 0xe9eae5, van: 0xd8d5ce, truck: 0x3a63a8, bus: 0xb5271f,
};
const kinds = P.kind === 'all' ? VEH.CAR_KINDS : P.kind.split(',');
const cars = [];
if (P.n > 0) {
  const pool = VEH.CAR_KINDS;
  const cols = Math.ceil(Math.sqrt(P.n));
  for (let i = 0; i < P.n; i++) {
    const kind = P.kind === 'all' ? pool[i % pool.length] : kinds[i % kinds.length];
    const car = vehicles.add(kind, (i % cols - cols / 2) * 4.2, (Math.floor(i / cols) - cols / 2) * 12.5, 0,
      P.color ?? undefined);
    cars.push(car);
  }
} else {
  let x = 0;
  const gap = 0.9;
  for (const kind of kinds) {
    const probe = vehicles.add(kind, 0, 0, 0, P.color ?? SHOW_COLORS[kind] ?? 0x8a9096);
    x += probe.wid / 2;
    probe.x = x; x += probe.wid / 2 + gap;
    cars.push(probe);
  }
  const mid = x / 2 - gap / 2;
  for (const c of cars) c.x -= mid;
}
// after dark the cars count as DRIVEN, so they lay their headlight pools
// (and every car burns its lamps, day or night: a showroom car is never parked)
for (const c of cars) { c.steer = P.steer; c._grounded = true; c._litT = Infinity; if (P.night > 0.3) c.ai = {}; }

// lamps: exactly what main.js updateNightLights writes, plus the module's own
// night hook when it has one
if (VEH.lampMats) {
  VEH.lampMats.head.emissiveIntensity = 1.4 + 5.0 * k;
  VEH.lampMats.tail.emissiveIntensity = 1.4 + 4.0 * k;
}
VEH.carNight?.(k);

if (P.dent) {
  for (const c of cars) {
    VEH.dentCar(c, c.x - 0.3, 0.55, c.z - c.len / 2, 0, 1, 0.32);
    VEH.dentCar(c, c.x + c.wid / 2, 0.6, c.z + 0.4, -1, 0, 0.2);
  }
}

// ---- camera ----------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(P.fov || 55, window.innerWidth / window.innerHeight, 0.1, 1400);
function frame() {
  let minX = Infinity, maxX = -Infinity, len = 0, hi = 0;
  for (const c of cars) {
    minX = Math.min(minX, c.x - c.wid / 2); maxX = Math.max(maxX, c.x + c.wid / 2);
    len = Math.max(len, c.len); hi = Math.max(hi, c.kind === 'bus' ? 3.2 : c.kind === 'truck' ? 3.0 : c.kind === 'van' ? 2.0 : 1.5);
  }
  const cx = (minX + maxX) / 2, span = maxX - minX;
  const one = cars.length === 1;
  const c0 = cars[0];
  const tgt = new THREE.Vector3(cx, hi * 0.42, 0);
  const R = P.dist || (one ? Math.max(len * 1.25, 4.6) : Math.max(span * 0.72, len * 1.3));
  const V = {
    q: [-0.62, 0.30, -0.78], rq: [0.62, 0.30, 0.78], front: [0, 0.12, -1], rear: [0, 0.12, 1],
    side: [-1, 0.10, 0], top: [0.001, 1, 0.001], low: [-0.55, 0.06, -0.83],
  };
  if (P.view === 'wheel' && one) {
    const ax = c0.len * 0.3;
    tgt.set(c0.x - c0.wid / 2, 0.36, -ax);
    camera.position.set(c0.x - c0.wid / 2 - (P.dist || 1.35), 0.55, -ax - 0.55);
  } else if (P.view === 'fp' && one) {
    VEH.attachCabin(c0);
    const e = VEH.eyeAnchor(c0, 0);
    camera.near = 0.05;
    camera.fov = 75;
    camera.position.set(c0.x + e.x, e.y, e.z);
    const yaw = (parseFloat(q.get('yaw')) || 0) * Math.PI / 180;
    tgt.set(c0.x + e.x + Math.sin(yaw) * 5, e.y - 0.35, e.z - Math.cos(yaw) * 5);
  } else {
    const d = new THREE.Vector3(...(V[P.view] ?? V.q)).normalize();
    camera.position.copy(tgt).addScaledVector(d, R);
    if (camera.position.y < 0.25) camera.position.y = 0.25;
  }
  camera.lookAt(tgt);
  camera.updateProjectionMatrix();
  sun.target.position.set(cx, 0, 0);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 60);
}
frame();
vehicles.focus = { x: camera.position.x, z: camera.position.z };
if (P.lod) vehicles.forceLod = P.lod;

function render(dt = 1 / 60) {
  if (P.brake) for (const c of cars) { c._acc = -6; c.speed = 6; c._pv = 6.1; }
  vehicles.update(dt, camera);
  if (P.brake) for (const c of cars) c.speed = 0;
  renderer.render(scene, camera);
}
render();

// ---- hud + perf ------------------------------------------------------------
const hud = document.getElementById('hud');
function stats() {
  const info = renderer.info;
  let meshes = 0, tris = 0;
  if (cars.length) {
    cars[0].mesh.traverse((o) => {
      // (a pooled wheel or distance dress is drawn by its pool, not by itself)
      if (!o.isMesh || !o.visible || !o.layers.test(camera.layers)) return;
      let p = o.parent, vis = true;
      while (p) { if (!p.visible) vis = false; p = p.parent; }
      if (!vis) return;
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
  }
  return { calls: info.render.calls, tris: info.render.triangles, carMeshes: meshes, carTris: Math.round(tris) };
}
function perf(frames = 40) {
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  render();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) render();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // forces the queue to drain
  return (performance.now() - t0) / frames;
}
const s = stats();
let line = `${P.kind} · ${P.view}${k ? ' · night ' + k : ''}${P.env ? '' : ' · no env'}  |  first car: ${s.carMeshes} meshes, ${s.carTris} tris  |  frame: ${s.calls} calls, ${s.tris} tris`;
if (P.n > 0) line += `\n${P.n} cars: ${perf().toFixed(2)} ms per frame`;
hud.textContent = line;
window.__show = { THREE, renderer, scene, camera, vehicles, cars, render, stats, perf, VEH, P };

// keep the picture alive across a screenshot round trip and window resizes
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  render();
});
setInterval(() => render(), 500);
