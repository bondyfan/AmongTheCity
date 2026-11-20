// ---- dev/people.js: a one-second visual loop for the character models ------
// The game takes tens of seconds to boot and puts a city between the camera
// and the person. This page imports the SAME js/citizen.js the game does,
// stands people on a neutral floor under the game's light rig and walks them
// on a treadmill at a real speed, so foot sliding shows as a foot moving
// against the floor stripes. Nothing here ships in the game.

import * as THREE from 'three';

const q = new URLSearchParams(location.search);
const P = {
  who: q.get('who') || 'all',
  n: q.get('n') ? parseInt(q.get('n'), 10) : 0,
  seed: q.get('seed') ? parseInt(q.get('seed'), 10) : 1,
  pose: q.get('pose') || 'walk',
  view: q.get('view') || 'q',
  speed: q.get('speed') ? parseFloat(q.get('speed')) : null,
  t: q.get('t') != null ? parseFloat(q.get('t')) : null,
  night: q.get('night') === '1' ? 1 : (parseFloat(q.get('night')) || 0),
  lod: q.get('lod') || '',
  dist: q.get('dist') ? parseFloat(q.get('dist')) : 0,
  strip: q.get('strip') ? parseInt(q.get('strip'), 10) : 0,
  // &prop=bag,phone,pram,dog (or all): what the people carry, in turn; they then
  // really walk (the camera follows) so a dog has ground to cover
  prop: q.get('prop') ? (q.get('prop') === 'all' ? ['bag', 'phone', 'pram', 'dog'] : q.get('prop').split(',')) : null,
  talk: q.get('talk') === '1',        // everybody speaks: jaws work, standing bodies gesture
  mouth: q.get('mouth') != null ? parseFloat(q.get('mouth')) : null,   // a jaw held open this far, 0..1
  birds: q.get('birds') === '1',      // a row of each bird: seated, pecking, flying
};
// &rig=dummy: the crash-test humans of js/characters/dummy.js stand in for every citizen
if (q.get('rig') === 'dummy') (await import('../js/characters/dummy.js')).installDummies();
// &rig=bank: the real people bank (public/assets/people/); &who=av:m01,av:f12 picks people by id
if (q.get('rig') === 'bank') await (await import('../js/characters/peopleload.js')).loadPeople('/assets/people/');
const CIT = await import('../js/citizen.js');
window.__av = await import('../js/characters/avatars.js');      // for the console: the bank this page drew from
const { ARCHETYPES, archetypeAt } = await import('../js/people.js');
const { seededRnd } = await import('../js/wardrobe.js');
const SCALE = 0.9;      // config.js PLAYER_SCALE: people are drawn at this size

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const k = P.night;
renderer.toneMappingExposure = 0.82 + (2.5 - 0.82) * k;      // what sky.js drives
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = {
  zenith: new THREE.Color(0x4f86c9).lerp(new THREE.Color(0x05070c), k),
  horizon: new THREE.Color(0xa8b8c8).lerp(new THREE.Color(0x0b0e14), k),
  ground: new THREE.Color(0x4a4d52).lerp(new THREE.Color(0x050607), k),
};
scene.background = SKY.horizon.clone();
// sky.js: hemisphere 0.74 by day and 0.14 at night, sun 1.8, moon 0.10
const hemi = new THREE.HemisphereLight(0xdfe7f0, 0x3a3d42, 0.74 + (0.14 - 0.74) * k);
hemi.color.setRGB(0.87 - 0.42 * k, 0.91 - 0.33 * k, 1.0 - 0.02 * k);
const sun = new THREE.DirectionalLight(k > 0.5 ? 0x99b8ff : 0xfff2dd, 1.8 + (0.10 - 1.8) * k);
const back = P.view === 'back';
const sunDir = new THREE.Vector3(-0.42, 0.62, back ? 0.66 : -0.66).normalize();
sun.position.copy(sunDir).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 80;
sun.shadow.normalBias = 0.02;
scene.add(hemi, sun, sun.target);

// the same stand-in for scene.environment the car showroom uses
{
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uZen: { value: SKY.zenith }, uHor: { value: SKY.horizon }, uGnd: { value: SKY.ground } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uZen, uHor, uGnd; varying vec3 vDir; void main(){ vec3 d = normalize(vDir); vec3 sky = mix(uHor, uZen, pow(max(d.y, 0.0), 0.55)); gl_FragColor = vec4(mix(uGnd, sky, smoothstep(-0.02, 0.03, d.y)), 1.0); }',
  })));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(s, 0.02).texture;
  pm.dispose();
}

// a floor with stripes across the direction of travel: a planted foot stays on
// its stripe, a sliding one does not
const floorTex = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#74777b'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#5f6266'; g.fillRect(0, 0, 64, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(80, 80); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ---- the cast ----
const people = [];
const lend = (seed, fn) => {       // what js/pedestrians.js does: a seeded Math.random for one call
  const real = Math.random, r = seededRnd(seed);
  try { Math.random = r; return fn(); } finally { Math.random = real; }
};
const PROPS = await import('../js/pedprops.js');
let made = 0;
const make = (who, seed) => lend(seed, () => {
  if (who.startsWith('av:')) return CIT.makeCitizen({ avatar: who.slice(3) });
  if (who === 'police' || who === 'medic') return CIT.makeCitizen({ role: who, seed });
  if (who === 'player') return CIT.makeCitizen({ uid: 'showroom-' + seed });
  const prop = P.prop ? P.prop[made++ % P.prop.length] : null;
  const tint = prop ? PROPS[{ bag: 'BAG_TINTS', pram: 'PRAM_TINTS', dog: 'DOG_TINTS' }[prop]]?.[(seed + made) % 7] ?? 0 : 0;
  const c = CIT.makeCitizen({ archetype: who, prop, propTint: tint });
  c.propTint = tint;
  return c;
});
if (P.n > 0) {
  const cols = Math.ceil(Math.sqrt(P.n * 2.2));
  for (let i = 0; i < P.n; i++) {
    const key = archetypeAt(seededRnd(P.seed * 977 + i * 31)()).key;
    const c = make(key, P.seed * 1000 + i);
    c.x = (i % cols - (cols - 1) / 2) * 0.95; c.z = (Math.floor(i / cols)) * 1.6;
    people.push(c);
  }
} else if (P.strip > 0) {
  // one person, `strip` frozen phases of the stride in a row: a film strip
  const who = P.who === 'all' ? 'm30' : P.who.split(',')[0];
  for (let i = 0; i < P.strip; i++) {
    const c = make(who, P.seed * 1000);
    c.x = 0; c.z = (i - (P.strip - 1) / 2) * 1.3; c.frozen = i / P.strip;
    people.push(c);
  }
} else {
  const list = P.who === 'all' ? [...ARCHETYPES.map((a) => a.key), 'police', 'medic', 'player'] : P.who.split(',');
  list.forEach((who, i) => {
    const c = make(who, P.seed * 1000 + i);
    c.x = (i - (list.length - 1) / 2) * 0.95; c.z = 0;
    people.push(c);
  });
}
const run = P.pose === 'run';
const speed = P.speed ?? (run ? 6 : 1.35);
for (const c of people) {
  c.group.scale.setScalar(SCALE);
  c.group.position.set(c.x, 0, c.z);
  c.walkT = 0;
  scene.add(c.group);
  if (P.lod) c.setLod?.(P.lod);
  if (P.pose === 'rag') { c.ragdollPose(); c.group.rotation.set(-1.3, 0, 0.2); c.group.position.y = 0.25; }
}

function pose(time, dt) {
  for (const c of people) {
    if (P.mouth != null) c.mouth?.(P.mouth); else if (P.talk) c.talk?.(1);
    if (P.pose === 'walk' || P.pose === 'run' || P.pose === 'punch' || P.pose === 'kick' || P.pose === 'aim' || P.pose === 'hands') {
      const moving = P.pose === 'walk' || P.pose === 'run';
      const v = moving ? speed : 0;
      // a frozen phase: standPose() resets the gait, so the next walk() lands on it at once
      const fr = c.frozen != null ? c.frozen + (P.t ?? 0) : P.t;
      if (fr != null) { c.walkT = fr * Math.PI * 2; c.standPose(); } else c.walkT += v * dt * 1.6;
      c.walk(c.walkT, moving ? 1 : 0, 0, v);
      if (P.pose === 'punch') c.punchPose(P.t ?? (time * 0.9) % 1, 1);
      if (P.pose === 'kick') c.kickPose(P.t ?? (time * 0.9) % 1);
      if (P.pose === 'aim') c.aimPose(1, 0);
      if (P.pose === 'hands') c.handsPose(1);
    } else if (P.pose === 'stand') c.walk(0, 0, 0, 0);
    else if (P.pose === 'sit') { c.sitPose(1); c.group.position.y = 0.45 - 0.739; }
    else if (P.pose === 'bench') { c.sitPose(1, 0); c.group.position.y = 0.45 - 0.739; }
  }
  // the treadmill: the floor goes backwards under the walkers. With props the
  // people walk for real instead and the camera goes with them.
  const go = P.pose === 'walk' || P.pose === 'run';
  if (go && !P.prop) floorTex.offset.y -= speed * dt / 1;
  if (P.prop) {
    for (const r of recs) {
      if (go) { r.c.group.position.z -= speed * dt * SCALE; r.z = r.c.group.position.z; }
      r.speed = go ? speed * SCALE : 0; r.pose = P.pose === 'bench' ? 2 : go ? 0 : 1;
    }
    if (go) camera.position.z -= speed * dt * SCALE;
    scene.updateMatrixWorld(true);
    dogs.update(dt, recs, { x: 0, z: recs[0]?.z ?? 0 });
    prams.update(recs);
  }
  if (flock) flock(time, dt);
}
// ---- what they carry, drawn by the game's own modules ----
const recs = [];
let dogs = null, prams = null, flock = null;
if (P.prop) {
  dogs = new (await import('../js/dogs.js')).Dogs(scene, { groundY: () => 0 });
  prams = new (await import('../js/pedpropdraw.js')).Prams(scene);
  people.forEach((c, i) => recs.push({ c, prop: PROPS.PROP_KEYS.indexOf(c.prop), propTint: c.propTint, breed: i % 4, pid: 1000 + i * 37,
    x: c.x, z: c.z, heading: 0, speed: 0, state: 'walk', pose: 0, sitDrop: 0, mesh: c.group, dog: null,
    hand: c.hold?.L === 'leash' ? c.parts.handL : c.parts.handR, leadSide: c.hold?.L === 'leash' ? -1 : 1,
    pramX: NaN, pramY: 0, pramZ: 0, pramH: 0 }));
}
if (P.birds) {
  // each species three times: seated, pecking on the ground, in the air
  const { Birds } = await import('../js/birds.js');
  const { SPECIES } = await import('../js/birdsites.js');
  const { makeBird, MODE } = await import('../js/birdflight.js');
  const B = new Birds(scene, { world: { built: new Map() }, hourOf: () => 12 });
  const list = [];
  Object.values(SPECIES).forEach((sp, i) => {
    for (let k = 0; k < 3; k++) {
      const b = makeBird({ x: (i - 1.5) * 0.7, y: k === 2 ? 0.8 : 0, z: -1.2 - k * 0.5, yaw: 2.4 }, (i * 3 + k) / 12);
      b.pecks = k === 1;
      if (k === 2) { b.mode = MODE.FLY; b.spread = 1; b.amp = sp.amp; }
      list.push(B._add(b, sp, sp.tints[k % sp.tints.length]));
    }
  });
  const { birdClock } = await import('../js/birdmodel.js');
  flock = (time, dt) => {
    birdClock.value = time;
    for (const b of list) { if (b.mode === MODE.FLY) b.phase += dt * b.sp.hz * 6.283; B._write(b); }
    B.mesh.count = list.length; B.mesh.instanceMatrix.needsUpdate = true; B.flap.needsUpdate = true;
  };
}
if (P.pose === 'sit' || P.pose === 'bench') {
  // something to sit on: a slab at car-cushion height
  const seat = new THREE.Mesh(new THREE.BoxGeometry(people.length * 0.95 + 0.4, 0.45, 0.45), new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.9 }));
  seat.position.set(0, 0.225, 0.12); seat.receiveShadow = true; seat.castShadow = true;
  scene.add(seat);
}

// ---- camera ----
const camera = new THREE.PerspectiveCamera(P.view === 'face' ? 20 : 34, window.innerWidth / window.innerHeight, 0.1, 400);
{
  const span = Math.max(1.6, (people.length ? Math.max(...people.map((c) => c.x)) - Math.min(...people.map((c) => c.x)) : 0) + 1.2);
  const zs = people.map((c) => c.z), zc = (Math.min(...zs) + Math.max(...zs)) / 2;
  const tgt = new THREE.Vector3(0, P.view === 'face' ? 1.46 : 0.86, zc);
  const R = P.dist || (P.view === 'face' ? 1.6 : Math.max(span * 1.45, 4.4));
  const V = { q: [-0.5, 0.22, -0.84], front: [0, 0.08, -1], back: [0, 0.08, 1], side: [-1, 0.06, 0], face: [-0.25, 0.04, -1], top: [0.001, 1, -0.3] };
  camera.position.copy(tgt).addScaledVector(new THREE.Vector3(...(V[P.view] ?? V.q)).normalize(), P.strip ? (P.dist || P.strip * 1.25) : R);
  camera.lookAt(tgt);
}

let last = performance.now(), time = 0;
function render() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
  pose(time, dt);
  renderer.render(scene, camera);
}
render();

const hud = document.getElementById('hud');
function stats() {
  let meshes = 0;
  people[0]?.group.traverse((o) => { if (o.isMesh) meshes++; });
  const info = renderer.info.render;
  return { meshes, tris: people[0]?.tris ?? null, calls: info.calls, sceneTris: info.triangles };
}
function perf(frames = 60) {
  const gl = renderer.getContext(), px = new Uint8Array(4);
  render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) render();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return (performance.now() - t0) / frames;
}
const s = stats();
let line = `${P.pose} · ${P.view}${k ? ' · night' : ''}${P.lod ? ' · ' + P.lod : ''}  |  first person: ${s.meshes} meshes` +
  `${s.tris ? `, ${s.tris.near} tris near / ${s.tris.far} far` : ''}  |  frame: ${s.calls} calls, ${s.sceneTris} tris`;
if (P.n > 0) line += `\n${P.n} people: ${perf().toFixed(2)} ms per frame`;
hud.textContent = line;
window.__show = { THREE, renderer, scene, camera, people, render, stats, perf, P };

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  render();
});
setInterval(render, 33);
