// ---- seated.js: photographs of people sitting in cars -------------------------------
//
// js/characters/seatrows.js says why and keeps the rows; this file takes the
// pictures. A person is built as the game builds anybody (makeHuman), sat in
// the car pose, and drawn VIEWS times from round about into their row of one
// render target. Nothing is downloaded and nothing is stored: the atlas is
// made from the people bank at boot and whenever somebody new takes a seat
// (sixteen small draws, a few milliseconds).
//
// The pictures are lit once, from above and ahead as the glass lights a cabin
// (js/carglass.js), and kept linear with their coverage in alpha.

import * as THREE from 'three';
import { makeHuman } from './human.js';
import { avatar, peopleReady, retainHi, releaseHi } from './avatars.js';
import { pool, avatarForRole } from './cast.js';
import { VIEWS, ROWS, TILE_W, TILE_H, FRAME_W, FRAME_H, AHEAD, ELEV, viewAzimuth, tileRect, setBaker, redrawSeat,
  rowOf, isStock, seatAtlas } from './seatrows.js';
import { SIT_DROP } from '../seating.js';
import { PLAYER_SCALE } from '../config.js';

let R = null, rt = null, scene = null, cam = null, keep = null;
const _col = new THREE.Color(), _r = [0, 0, 0, 0];
const T = new THREE.Vector3(0, FRAME_H / 2, -AHEAD);       // what every picture looks at
const DIST = 4;

/**
 * Who a key is: { body, head, driver } avatar ids (head null for the body's
 * own), or null. A stock driver is somebody of the catalogue, the same one on
 * every screen: men and women in turn.
 */
export function whoIs(key) {
  if (!key || !peopleReady()) return null;
  if (isStock(key)) {
    const name = key.slice(1);
    if (name.startsWith('civ')) {
      const n = parseInt(name.slice(3), 10) | 0;
      const p = pool(n & 1 ? 'f' : 'm', 'adult', 'adult');
      return p.length ? { body: p[((n >> 1) * 5 + 2) % p.length], head: null, driver: true } : null;
    }
    const id = avatarForRole(name, 7, 'm');
    return id ? { body: id, head: null, driver: true } : null;
  }
  const m = /^([^+]+)\+([^:]+):([dp])$/.exec(key);
  if (!m || !avatar(m[1])) return null;
  return { body: m[1], head: m[2] !== m[1] && avatar(m[2]) ? m[2] : null, driver: m[3] === 'd' };
}

function draw(row, av, head, driver) {
  const H = Math.min(1.84, Math.max(1.62, av.height));
  const c = makeHuman(av, { height: H }, { near: true, seed: 0.37, calm: true, head, sharp: false });
  c.group.scale.setScalar(PLAYER_SCALE);
  c.group.position.set(0, -SIT_DROP, 0);                   // the cushion top is the bottom of the picture
  c.sitPose(1, 1);
  if (!driver) {
    // nobody rides with their hands on a wheel that is not there: in the lap
    const p = c.parts;
    p.armL.rotation.set(0.30, 0, 0.10); p.armR.rotation.set(0.30, 0, -0.10);
    p.elbowL.rotation.x = 1.05; p.elbowR.rotation.x = 1.05;
  }
  scene.add(c.group);
  scene.updateMatrixWorld(true);
  // Pose it now. A body is posed by the render hook of its main mesh, and a
  // borrowed head is a mesh of its own that may be drawn first: in the first
  // picture it would still have no bones to stand on.
  c.pose();
  const prev = R.getRenderTarget(), auto = R.autoClear, alpha = R.getClearAlpha();
  R.getClearColor(_col);
  R.autoClear = false;
  R.setClearColor(0x000000, 0);
  rt.texture.generateMipmaps = false;                      // once, after the last picture of the row
  const ce = Math.cos(ELEV), se = Math.sin(ELEV);
  try {
    for (let v = 0; v < VIEWS; v++) {
      tileRect(row, v, _r);
      rt.viewport.set(_r[0], _r[1], _r[2], _r[3]);
      rt.scissor.set(_r[0], _r[1], _r[2], _r[3]);
      const az = viewAzimuth(v);
      cam.position.set(T.x + Math.sin(az) * ce * DIST, T.y + se * DIST, T.z + Math.cos(az) * ce * DIST);
      cam.lookAt(T);
      cam.updateMatrixWorld(true);
      // a body's render hook brings the shared contact shadows into whatever scene it is drawn in
      for (let i = scene.children.length - 1; i >= 0; i--) if (!keep.has(scene.children[i]) && scene.children[i] !== c.group) scene.remove(scene.children[i]);
      if (v === VIEWS - 1) rt.texture.generateMipmaps = true;
      R.setRenderTarget(rt);
      R.clear(true, true, false);
      R.render(scene, cam);
    }
  } finally {
    rt.texture.generateMipmaps = true;
    R.setRenderTarget(prev);
    R.setClearColor(_col, alpha);
    R.autoClear = auto;
    scene.remove(c.group);
    c.dispose();
  }
}

function bake(row, key, again) {
  if (!R) return false;
  const w = whoIs(key), av = w && avatar(w.body);
  if (!av) return false;
  const head = w.head ? avatar(w.head) : null;
  draw(row, av, head, w.driver);
  // Somebody with a name is looked at from close by: once their sharp texture
  // is in, the pictures are taken again. The stock drivers make do with what
  // is loaded, so a street of traffic downloads nothing.
  if (!again && !isStock(key)) {
    for (const a of head ? [av, head] : [av]) {
      if (a.hi || !a.hiUrl) continue;
      const wait = retainHi(a);
      if (!wait) { releaseHi(a); continue; }
      wait.then(() => { if (a.hi && rowOf(key) >= 0) redrawSeat(key); }).finally(() => releaseHi(a));
    }
  }
  return true;
}

/** Start taking pictures with this renderer (once the people bank is in). */
export function initSeated(renderer) {
  if (R || !renderer) return false;
  R = renderer;
  rt = new THREE.WebGLRenderTarget(VIEWS * TILE_W, ROWS * TILE_H, {
    depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
  });
  rt.texture.name = 'seated-people';
  rt.texture.anisotropy = 4;
  rt.scissorTest = true;
  scene = new THREE.Scene();
  const sky = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.4);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 2.6, -1.35);                        // above and ahead, as the glass lights a cabin
  scene.add(sky, key, key.target);
  keep = new Set(scene.children);
  cam = new THREE.OrthographicCamera(-FRAME_W / 2, FRAME_W / 2, FRAME_H / 2, -FRAME_H / 2, 0.1, DIST * 2);
  // empty until somebody is drawn: no picture anywhere
  const prev = R.getRenderTarget(), alpha = R.getClearAlpha();
  R.getClearColor(_col);
  rt.viewport.set(0, 0, rt.width, rt.height); rt.scissor.set(0, 0, rt.width, rt.height);
  R.setRenderTarget(rt); R.setClearColor(0x000000, 0); R.clear(true, true, false);
  R.setRenderTarget(prev); R.setClearColor(_col, alpha);
  seatAtlas.value = rt.texture;
  setBaker(bake);
  return true;
}

/** For a dev page: the render target the pictures are in. */
export const seatedTarget = () => rt;
