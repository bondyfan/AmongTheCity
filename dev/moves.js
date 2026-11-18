// ---- dev/moves.js: one move of the player's, without a city -----------------
// See dev/moves.html for the parameters. Everything is stepped at a fixed
// 1/60 s from the start of the scene to the moment asked for, so a given URL
// always shows the same frame. Nothing here ships in the game.

import * as THREE from 'three';
const VEH = await import('../js/vehicles.js');
const { Player } = await import('../js/player.js');
const DOOR = await import('../js/cardoor.js');
const MOVES = await import('../js/bodymoves.js');

const q = new URLSearchParams(location.search);
const P = {
  scene: q.get('scene') || 'enter',
  t: parseFloat(q.get('t') ?? '1'), t0: parseFloat(q.get('t0') ?? '0'),
  strip: parseInt(q.get('strip') ?? '1', 10) || 1,
  kind: q.get('kind') || 'octavia',
  color: parseInt(q.get('color') || '54695d', 16),
  view: q.get('view') || 'door',
  dist: parseFloat(q.get('dist') ?? '0'),
  night: parseFloat(q.get('night') ?? '0') || 0,
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
const k = P.night;
const sky = new THREE.Color(0xa8b8c8).lerp(new THREE.Color(0x0b0e14), k);
scene.background = sky;
const hemi = new THREE.HemisphereLight(0xdfe7f0, 0x3a3d42, 0.74 * (1 - 0.953 * k) + 0.25);
const sun = new THREE.DirectionalLight(0xfff2dd, 1.8 * (1 - 0.94 * k));
sun.position.set(-25, 37, -40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 160;
scene.add(hemi, sun, sun.target);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x6d7074, roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
// a low wall to vault, for scene=wall
const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 0.9, 0.3), new THREE.MeshStandardMaterial({ color: 0x8b8f94 }));
wall.position.set(20, 0.45, 0);
wall.castShadow = true;
scene.add(wall);

const vehicles = new VEH.Vehicles(scene);
const car = vehicles.add(P.kind, 0, 0, 0, P.color);
car._grounded = true;
VEH.carNight?.(k);

// the walker's world: a flat floor, the car as the game's two discs, the wall as a box
const hulls = [car];
const world = {
  carHulls: () => hulls.filter((c) => c !== player?.inCar && c !== player?.boarding?.veh),
  supportY: (x, z, maxY) => (Math.abs(x - 20) < 2 && Math.abs(z) < 0.15 && maxY >= 0.9 ? 0.9 : 0),
  heightAt: () => 0,
  collide(pos, radius, opts) {
    let pushed = false;
    for (const c of this.carHulls()) {
      const fx = -Math.sin(c.heading), fz = -Math.cos(c.heading);
      const rr = c.wid * 0.55 + radius, back = c.len / 2 - c.wid * 0.55;
      for (const s2 of [-back, back]) {
        const cx = c.x + fx * s2, cz = c.z + fz * s2;
        const ex = pos.x - cx, ez = pos.z - cz, d2 = ex * ex + ez * ez;
        if (d2 >= rr * rr || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        pos.x = cx + ex / d * rr; pos.z = cz + ez / d * rr; pushed = true;
      }
    }
    // the wall: solid from the ground to 0.9 m
    if ((opts?.yLo ?? 0) < 0.9 && Math.abs(pos.x - 20) < 2 + radius && Math.abs(pos.z) < 0.15 + radius) {
      pos.z = (pos.z >= 0 ? 1 : -1) * (0.15 + radius); pushed = true;
    }
    return pushed;
  },
};

const input = { moveX: 0, moveZ: 0, keys: new Set() };
let player = null;
const log = [];
const cbs = {
  onDoor: () => log.push('door'), onLocked: () => log.push('locked'), onShut: () => log.push('shut'),
  onSeated: () => { log.push('seated'); car._litT = Infinity; }, onCancel: () => log.push('cancel'),
};
const spec = DOOR.doorSpec(P.kind, 0);

// each scene: where the player starts, and what happens when
const S = {
  enter: { at: [-3.2, 1.6, Math.PI / 2], run(t) { if (t === 0) player.boardVehicle(car, 0, cbs); } },
  locked: { at: [-3.2, 1.6, Math.PI / 2], run(t) { if (t === 0) player.boardVehicle(car, 0, { ...cbs, locked: true }); } },
  exit: { at: [-3, 0, 0], run(t) { if (t === 0) { player.setInCar(car); car._litT = Infinity; } if (t === 20) player.beginExit(cbs); } },
  glass: { at: [-40, 0, 0], run() {} },
  driven: { at: [-40, 0, 0], run(t) { if (t === 0) car._litT = Infinity; } },
  jump: { at: [-4, 0, 0], run(t) { if (t === 6) input.keys.add('Space'); if (t === 8) input.keys.delete('Space'); } },
  runjump: { at: [-4, 6, 0], run(t) { input.moveZ = -1; input.keys.add('ShiftLeft'); if (t === 40) input.keys.add('Space'); if (t === 42) input.keys.delete('Space'); } },
  vault: { at: [-3.4, -1.55, -Math.PI / 2], run(t) { input.moveZ = -1; if (t === 46) input.keys.add('Space'); if (t === 48) input.keys.delete('Space'); } },
  wall: { at: [20, 3, 0], run(t) { input.moveZ = -1; if (t === 26) input.keys.add('Space'); if (t === 28) input.keys.delete('Space'); } },
  getup: { at: [-4, 0, 0], run(t) { if (t === 0) player.tumble(0, -4, 2.5); } },
  getup2: { at: [-4, 0, 0], run(t) { if (t === 0) player.tumble(0, 3.2, 2.2); const r = player.ragdoll; if (r?.phase === 'lie' && !r._flip) { r._flip = true; r.pitch = Math.PI / 2; r.roll = 0; } } },
  busted: { at: [-4, 0, 0], run(t) { player.held = Math.min(1, t / 60); } },
};
const sceneDef = S[P.scene] ?? S.enter;
player = new Player(scene, sceneDef.at[0], sceneDef.at[1], sceneDef.at[2], 'dev:1');

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
function aim() {
  const px = player.pos.x, pz = player.pos.z;
  const V = {
    door: [[-4.6, 1.7, 2.6], [-0.9, 0.95, 0.1]],
    in: [[-3.0, 1.5, -1.2], [-0.4, 0.9, 0.2]],
    q: [[-4.2, 1.9, -4.6], [0, 0.8, 0]],
    bonnet: [[-2.2, 1.7, -5.6], [0, 0.9, -1.4]],
    rq: [[4.2, 1.9, 4.6], [0, 0.8, 0]],
    side: [[-6.5, 1.3, 0], [0, 0.9, 0]],
    front: [[0, 1.3, -6.5], [0, 0.9, 0]],
    top: [[0.01, 8, 0.01], [0, 0, 0]],
    me: [[px - 3.2, player.y + 1.5, pz + 2.6], [px, player.y + 0.9, pz]],
    meside: [[px - 4.5, player.y + 1.2, pz], [px, player.y + 0.9, pz]],
  }[P.view] ?? null;
  const [c, t] = V ?? [[-4.6, 1.7, 2.6], [-0.9, 0.95, 0.1]];
  const tgt = new THREE.Vector3(...t), pos = new THREE.Vector3(...c);
  if (P.dist) pos.sub(tgt).setLength(P.dist).add(tgt);
  camera.position.copy(pos);
  camera.lookAt(tgt);
}

let frame = 0;
const DT = 1 / 60;
function step() {
  sceneDef.run(frame);
  player.update(DT, { input, camYaw: sceneDef.at[2], world });
  vehicles.update(DT, camera);
  frame++;
}
function stepTo(t) { const n = Math.round(t * 60); while (frame < n) step(); }

const hud = document.getElementById('hud');
function draw() {
  const W = window.innerWidth, H = window.innerHeight, n = P.strip;
  renderer.setScissorTest(n > 1);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? P.t0 + (P.t - P.t0) * i / (n - 1) : P.t;
    stepTo(t);
    aim();
    const w = Math.floor(W / n);
    renderer.setViewport(i * w, 0, w, H);
    renderer.setScissor(i * w, 0, w, H);
    camera.aspect = w / H;
    camera.updateProjectionMatrix();
    vehicles.focus = { x: camera.position.x, z: camera.position.z };
    renderer.render(scene, camera);
  }
  hud.textContent = `${P.scene} · ${P.kind} · t ${P.t0}..${P.t} · ${log.join(' ')}  |  calls ${renderer.info.render.calls}`
    + `\nboarding ${player.boarding?.phase ?? '-'} · inCar ${!!player.inCar} · door ${DOOR.doorOpen(car).toFixed(2)} · y ${player.y.toFixed(2)} · rag ${player.ragdoll?.phase ?? '-'}`;
}
let err = null;
try { draw(); } catch (e) { err = e; hud.textContent = String(e.stack || e); }
window.__moves = { THREE, renderer, scene, camera, player, car, vehicles, world, input, step, stepTo, draw, log, P, spec, DOOR, VEH, MOVES, err };
