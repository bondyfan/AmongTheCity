// ---- creatorstage.js: the turntable the creator shows the body on --------------
// A small three.js scene of its own: one person on a lit floor, turned by
// dragging. It runs before the game's renderer exists (the creator opens from
// the menu), so it brings its own, and gives the GPU back when it closes. The
// people themselves are the game's: makeHuman over the loaded avatars.

import * as THREE from 'three';
import { avatar, retainHi, releaseHi } from './avatars.js';
import { makeHuman } from './human.js';

function lights(scene) {
  const hemi = new THREE.HemisphereLight(0xe6ecf5, 0x3a3d48, 0.95);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.1);
  key.position.set(-1.3, 4.6, -2.8);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 1.3);
  rim.position.set(2.4, 2.6, 3.2);
  scene.add(hemi, key, rim);
  return key;
}

function person(look) {
  const av = look && avatar(look.body);
  if (!av) return null;
  return makeHuman(av, { height: av.height }, { near: true, seed: 0.37, head: look.head ? avatar(look.head) : null });
}

/**
 * makeStage(canvas) -> { setLook(look), focus('body' | 'face'), thumb(id, mode), dispose() }
 */
export function makeStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const key = lights(scene);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -1.6; sc.right = 1.6; sc.top = 2.4; sc.bottom = -0.6; sc.near = 0.5; sc.far = 12;
  key.shadow.normalBias = 0.02;
  // the floor only shows the shadow and a soft pool of light under the feet
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.7, 48), new THREE.ShadowMaterial({ opacity: 0.42 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,214,170,0.34)'); gr.addColorStop(1, 'rgba(255,214,170,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const glow = new THREE.Mesh(new THREE.CircleGeometry(1.5, 48), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.002;
  scene.add(floor, glow);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
  const turn = new THREE.Group();
  scene.add(turn);

  let cur = null, yaw = 0.42, vel = 0, drag = null, raf = 0, dead = false, focus = 'body', f = 0, lastT = 0;
  const cam = { y: 0.95, d: 5.2 };
  const want = () => {
    const h = cur?.avatar.height ?? 1.75;
    return focus === 'face' ? { y: h - 0.12, d: 1.55 } : { y: h * 0.53, d: h * 2.95 };
  };
  const place = () => { camera.position.set(0, cam.y + 0.08, -cam.d); camera.lookAt(0, cam.y, 0); };

  const down = (e) => { drag = { x: e.clientX, yaw }; vel = 0; canvas.setPointerCapture?.(e.pointerId); };
  const move = (e) => { if (!drag) return; const ny = drag.yaw + (e.clientX - drag.x) * 0.011; vel = ny - yaw; yaw = ny; };
  const up = () => { drag = null; };
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);

  const frame = (t) => {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0); lastT = t;
    const w = canvas.clientWidth | 0, h = canvas.clientHeight | 0;
    if (w && h && (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio()))) {
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    if (!drag) { yaw += vel; vel *= 0.92; }
    const g = want(), k = 1 - Math.exp(-dt * 6);
    cam.y += (g.y - cam.y) * k; cam.d += (g.d - cam.d) * k;
    place();
    turn.rotation.y = yaw;
    f++;
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  // ---- thumbnails: a second, tiny renderer so the stage never flickers ----
  let tr = null, tscene = null, tcam = null;
  const thumb = (id, mode = 'body', w = 144, h = 192) => {
    const av = avatar(id);
    if (!av) return '';
    if (!tr) {
      const c = document.createElement('canvas');
      tr = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: false, preserveDrawingBuffer: true });
      tr.outputColorSpace = THREE.SRGBColorSpace; tr.toneMapping = THREE.ACESFilmicToneMapping; tr.toneMappingExposure = 0.95;
      tscene = new THREE.Scene(); tscene.background = new THREE.Color(0x1d2140); lights(tscene);
      tcam = new THREE.PerspectiveCamera(26, w / h, 0.1, 30);
    }
    tr.setSize(w, h, false);
    const p = makeHuman(av, { height: av.height }, { near: true, seed: 0.37, calm: true });
    p.group.rotation.y = 0.35;
    tscene.add(p.group);
    const H = av.height;
    if (mode === 'face') { tcam.position.set(0, H - 0.1, -1.25); tcam.lookAt(0, H - 0.13, 0); } else { tcam.position.set(0, H * 0.55, -H * 3.1); tcam.lookAt(0, H * 0.52, 0); }
    tr.render(tscene, tcam);
    const url = tr.domElement.toDataURL('image/jpeg', 0.86);
    tscene.remove(p.group);
    p.dispose();
    return url;
  };

  // the sharp texture of a person, held while the creator is open: resolves when it is in
  const held = new Set();
  const sharp = (id) => {
    const av = avatar(id);
    if (!av || !av.hiUrl) return Promise.resolve(false);
    if (!held.has(av)) { held.add(av); retainHi(av); }
    return av.hi ? Promise.resolve(false) : (av.hiWait ?? Promise.resolve(false)).then(() => true);
  };

  return {
    sharp,
    setLook(look) {
      if (cur) { turn.remove(cur.group); cur.dispose(); cur = null; }
      cur = person(look);
      if (cur) { cur.group.traverse((o) => { if (o.isMesh) o.castShadow = true; }); turn.add(cur.group); }
    },
    focus(v) { focus = v === 'face' ? 'face' : 'body'; },
    thumb,
    get frames() { return f; },
    dispose() {
      dead = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up);
      if (cur) { turn.remove(cur.group); cur.dispose(); cur = null; }
      for (const av of held) releaseHi(av);
      held.clear();
      floor.geometry.dispose(); floor.material.dispose(); glow.geometry.dispose(); glow.material.dispose(); glowTex.dispose();
      renderer.dispose(); renderer.forceContextLoss?.();
      if (tr) { tr.dispose(); tr.forceContextLoss?.(); tr = null; }
    },
  };
}
