// ---- bake-fight.mjs: the fighting clips of the Quaternius library, in one small file ----
//
// Run by hand, never as part of a build:
//
//   node scripts/people/bake-fight.mjs <out fight.bin> <UAL1_Standard.glb> <UAL2_Standard.glb>
//
// The Rocketbox bank (clips.bin) has no punches, no hit reactions, no fall and
// no getting up. The Universal Animation Library 1 and 2 by Quaternius (CC0,
// downloaded with the Rocketbox sources on 19 Nov 2026, kept outside the
// repository in ~/Documents/html/atc-character-sources/quaternius/) have all of
// them, recorded on an Unreal-style mannequin. This writes the dozen the fight
// needs in exactly the format of clips.bin (see bake-clips.mjs for the layout),
// under the skeleton family 'ual', so js/characters/rawclips.js reads it as it
// reads the bank and js/characters/avatars.js retargets each clip onto every
// Rocketbox body through the reference pose the first time it is played.
//
// Each library file is one mannequin carrying every clip. Only the armature is
// written (the node 'root' and below): the mesh and the Armature node above it
// carry nothing a clip moves. Fingers are left out of the moving set, as in
// clips.bin; the game curls its own fists (js/characters/fist.js).

import fs from 'node:fs';
import { register } from 'node:module';

register(new URL('../../tests/three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { GLTFLoader } = await import('../../libs/GLTFLoader.js');

// [name in the library, file index, fps]. Everything is short and fast, so 30.
const WANT = [
  ['Punch_Jab', 0], ['Punch_Cross', 0], ['Melee_Hook', 1], ['Melee_Hook_Rec', 1],
  ['Hit_Chest', 0], ['Hit_Head', 0], ['Hit_Knockback', 1],
  ['Death01', 0], ['LayToIdle', 1],
];

const [out, ...glbs] = process.argv.slice(2);
if (!out || glbs.length < 2) throw Error('usage: bake-fight.mjs <out fight.bin> <UAL1.glb> <UAL2.glb>');
const loader = new GLTFLoader();
const parse = (buf) => new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const files = [];
for (const f of glbs) files.push(await parse(fs.readFileSync(f)));

// the armature as one list, parents first: 'root' and every bone under it
function armature(g) {
  let top = null;
  g.scene.traverse((o) => { if (!top && o.name === 'root') top = o; });
  if (!top) throw Error('no root node');
  const nodes = [];
  top.traverse((o) => { if (o.isBone || o === top) nodes.push(o); });
  return nodes;
}

let rig = null, order = null;
const clips = [], chunks = [];
let at = 0;
const push = (typed) => {
  const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const off = at;
  chunks.push(b); at += b.length;
  if (at % 4) { const pad = Buffer.alloc(4 - (at % 4)); chunks.push(pad); at += pad.length; }
  return off;
};

for (const [name, fi, fpsWant = 30] of WANT) {
  const g = files[fi];
  const clip = g.animations.find((a) => a.name === name);
  if (!clip) { console.log('missing', name); continue; }
  const nodes = armature(g);
  if (!rig) {
    order = nodes.map((o) => o.name);
    rig = {
      names: order, parent: nodes.map((o) => nodes.indexOf(o.parent)),
      restQ: nodes.flatMap((o) => o.quaternion.toArray().map((v) => +v.toFixed(6))),
      restP: nodes.flatMap((o) => o.position.toArray().map((v) => +v.toFixed(5))),
      restS: nodes.map((o) => +o.scale.x.toFixed(6)),
    };
    // fingers and leaf ends hold still: the retarget has no slot for them
    rig.move = order.map((nm, i) => (/index|middle|ring|pinky|thumb|leaf/.test(nm) ? -1 : i)).filter((i) => i >= 0);
  } else if (nodes.map((o) => o.name).join() !== order.join()) throw Error('the two libraries list their bones differently');
  const rot = new Map(), pos = new Map();
  let t0 = Infinity, t1 = 0;
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.'), node = tr.name.slice(0, dot), prop = tr.name.slice(dot + 1);
    if (prop === 'quaternion') rot.set(node, tr); else if (prop === 'position') pos.set(node, tr); else continue;
    t0 = Math.min(t0, tr.times[0]); t1 = Math.max(t1, tr.times[tr.times.length - 1]);
  }
  const dur = t1 - t0;
  const keys = Math.max(2, Math.round(dur * fpsWant) + 1), n = order.length;
  const mv = rig.move, m = mv.length;
  const q = new Int16Array(keys * m * 4), hold = new Int16Array(n * 4);
  const _q = new THREE.Quaternion();
  order.forEach((nm, i) => {
    const tr = rot.get(nm), it = tr?.createInterpolant(new Float32Array(4));
    const slot = mv.indexOf(i);
    for (let k = 0; k < (slot < 0 ? 1 : keys); k++) {
      if (it) { const r = it.evaluate(t0 + (k / (keys - 1)) * dur); _q.set(r[0], r[1], r[2], r[3]).normalize(); } else _q.fromArray(rig.restQ, i * 4);
      const a = _q.toArray();
      if (k === 0) for (let c = 0; c < 4; c++) hold[i * 4 + c] = Math.round(a[c] * 32767);
      if (slot >= 0) for (let c = 0; c < 4; c++) q[(k * m + slot) * 4 + c] = Math.round(a[c] * 32767);
    }
  });
  // positions only where they move: the root and the pelvis carry the travel
  // and the drop to the ground; every other bone keeps its length
  const moved = [];
  order.forEach((nm, i) => {
    const tr = pos.get(nm);
    if (!tr || !(nm === 'root' || nm === 'pelvis')) return;
    const it = tr.createInterpolant(new Float32Array(3)), p = new Float32Array(keys * 3);
    for (let k = 0; k < keys; k++) { const r = it.evaluate(t0 + (k / (keys - 1)) * dur); p[k * 3] = r[0]; p[k * 3 + 1] = r[1]; p[k * 3 + 2] = r[2]; }
    moved.push([i, p]);
  });
  clips.push({ name, fps: +((keys - 1) / dur).toFixed(4), keys, q: push(q), hold: push(hold), pos: moved.map(([i, p]) => [i, push(p)]) });
}

const header = Buffer.from(JSON.stringify({ v: 1, family: 'ual', faces: '+z', rig, clips }), 'utf8');
const pad = (4 - (header.length % 4)) % 4;
const len = Buffer.alloc(4); len.writeUInt32LE(header.length + pad);
fs.writeFileSync(out, Buffer.concat([len, header, Buffer.alloc(pad, 0x20), ...chunks]));
console.log(`${clips.length} clips, ${rig.names.length} nodes, ${(fs.statSync(out).size / 1e3).toFixed(1)} kB -> ${out}`);
