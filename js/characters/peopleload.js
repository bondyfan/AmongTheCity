// ---- peopleload.js: fetch the people bank ---------------------------------------
//
// public/assets/people/manifest.json lists the modelled people (one .glb each:
// the surface as `near_body`, `near_head`, `near_hair` and a coarser `far`;
// its texture is a file of its own, fetched only when the person stands near),
// the animation files and which clip plays which role. This file downloads them and hands
// each to js/characters/avatars.js. It is started while the menu is still up,
// so the bank is usually in memory before the player has clicked anything.
//
// Nothing here is required: no manifest, a failed download or a browser
// without WebGL2 leaves peopleReady() false and the game draws its own
// lofted figures (js/citizen.js), exactly as it did before there was a bank.

import * as THREE from 'three';
import { GLTFLoader } from '../../libs/GLTFLoader.js';
import { patchPeopleMaterial } from '../peoplemat.js';
import { prepareAvatar, addClipSource, setRoles, setPeopleReady, peopleReady, setTextureFetcher } from './avatars.js';
import { setCatalog } from './cast.js';
import { readClipFile } from './rawclips.js';

export const PEOPLE_BASE = 'assets/people/';
const PARALLEL = 6;

let _loading = null;
let _stats = { state: 'idle', avatars: 0, total: 0, clips: 0, ms: 0, failed: [] };
export const peopleStats = () => _stats;

function load(loader, url) {
  return new Promise((res, rej) => loader.load(url, res, undefined, rej));
}

// What a person is drawn with: the game's people material over one texture.
// Hair and lashes are cards cut out by the texture's alpha.
function materialFor(map, key) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.86, metalness: 0, envMapIntensity: 0.35, alphaTest: 0.5 });
  return patchPeopleMaterial(m, key);
}

// 'near_head' -> 'head', 'near_hair' -> 'hair', every other near piece is body
const partName = (n) => (/^near_head/.test(n) ? 'head' : /^near_hair/.test(n) ? 'hair' : 'body');

async function loadAvatar(loader, base, m, e, farTex) {
  const g = await load(loader, base + e.file);
  const parts = [];
  let far = null;
  g.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    if (/^far/.test(o.name)) far = o; else parts.push({ name: partName(o.name), mesh: o });
  });
  if (!parts.length) throw new Error('no skinned mesh in ' + e.file);
  // every person starts on their tile of the shared far atlas (see avatars.js retainHi)
  let tile = null;
  if (farTex && e.tile && m.far) {
    tile = farTex.clone();
    tile.repeat.set(e.tile[2] / m.far.w, e.tile[3] / m.far.h);
    tile.offset.set(e.tile[0] / m.far.w, e.tile[1] / m.far.h);
  }
  const av = prepareAvatar({ id: e.id, sex: e.sex, kind: e.kind ?? 'adult', family: e.family ?? m.family ?? '', meta: e,
    scene: g.scene, parts, farMesh: far, material: materialFor(tile, 'people-near-1'), farMaterial: materialFor(tile, 'people-far-0'),
    faces: e.faces ?? m.faces ?? '+z' });
  av.tile = tile;
  av.hiUrl = e.atlas ?? null;
  return av;
}

async function run(base) {
  const t0 = performance.now();
  _stats = { state: 'loading', avatars: 0, total: 0, clips: 0, ms: 0, failed: [] };
  let m;
  try {
    const r = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    m = await r.json();
  } catch (err) {
    _stats.state = 'none';
    return false;
  }
  _stats.total = (m.avatars ?? []).length;
  const loader = new GLTFLoader(), images = new THREE.TextureLoader();
  // glTF's texture coordinates count from the top, so nothing is flipped
  const texture = (file) => new Promise((res) => images.load(base + file, (t) => {
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    res(t);
  }, undefined, () => res(null)));
  setTextureFetcher(texture);
  const farTex = m.far?.file ? await texture(m.far.file) : null;
  const jobs = [];
  for (const a of m.anims ?? []) {
    jobs.push(async () => {
      try {
        const g = await load(loader, base + a.file);
        // a file of one clip is named by the file, whatever the exporter called the action
        if (a.name && g.animations.length === 1) g.animations[0].name = a.name;
        addClipSource({ family: a.family ?? m.family ?? '', scene: g.scene, clips: g.animations, faces: a.faces ?? m.faces ?? '+z' });
        _stats.clips += g.animations.length;
      } catch (err) { console.warn('[people] clip file ' + a.file + ' skipped:', err?.message ?? err); }
    });
  }
  // every clip of the bank in one file (scripts/people/bake-clips.mjs), and
  // the fighting clips recorded on another skeleton (bake-fight.mjs), which
  // avatars.js retargets onto each body the first time one is played
  for (const cf of [m.clipFile, m.fightFile]) {
    if (!cf) continue;
    jobs.push(async () => {
      try {
        const r = await fetch(base + cf);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const file = readClipFile(await r.arrayBuffer());
        addClipSource({ family: file.family, scene: file.scene, clips: file.clips, faces: file.faces, moved: file.moved });
        _stats.clips += file.clips.size;
      } catch (err) { console.warn('[people] ' + cf + ' did not load:', err?.message ?? err); }
    });
  }
  const got = [];
  for (const e of m.avatars ?? []) {
    jobs.push(async () => {
      try { await loadAvatar(loader, base, m, e, farTex); got.push(e); _stats.avatars++; } catch (err) {
        _stats.failed.push(e.id);
        console.warn('[people] ' + e.id + ' skipped:', err?.message ?? err);
      }
    });
  }
  // a few at a time: forty parallel decodes stall the menu's own animation
  let next = 0;
  const worker = async () => { while (next < jobs.length) await jobs[next++](); };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
  if (!got.length) { _stats.state = 'none'; return false; }
  // the catalogue keeps the manifest's order, whatever order the files arrived in
  setCatalog((m.avatars ?? []).filter((e) => got.includes(e)), m.named ?? {});
  setRoles(m.roles ?? {}, m.clips ?? {});
  setPeopleReady(true);
  _stats.state = 'ready'; _stats.ms = Math.round(performance.now() - t0);
  return true;
}

/** Start loading (once). Resolves true when there are people to draw. */
export function loadPeople(base = PEOPLE_BASE) {
  return _loading ?? (_loading = run(base).catch((err) => {
    console.warn('[people] the bank did not load, keeping the plain figures:', err);
    _stats.state = 'failed';
    return false;
  }));
}

/**
 * The bank, or false after `ms`: boot waits this long for it and no longer.
 * `tell(done, total)` is called while it waits, so a slow line shows a count
 * instead of a spinner that explains nothing. A bank that is not there at all
 * (no manifest) answers at once.
 */
export function whenPeople(ms = 20000, tell = null) {
  if (peopleReady()) return Promise.resolve(true);
  const p = loadPeople();
  let timer = 0;
  if (tell) timer = setInterval(() => { if (_stats.state === 'loading' && _stats.total) tell(_stats.avatars, _stats.total); }, 300);
  return Promise.race([p, new Promise((res) => setTimeout(() => res(peopleReady()), ms))]).finally(() => clearInterval(timer));
}
