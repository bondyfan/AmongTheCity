// ---- bake-clips.mjs: eighty animation files into one --------------------------
//
// Run by hand (scripts/people/build-people.sh), never as part of a build:
//
//   node scripts/people/bake-clips.mjs <dir of clip .glb> <out clips.bin> [people.json]
//
// Each Rocketbox clip arrives as its own .glb (scripts/people/convert-rocketbox.py).
// Loading eighty of those in the browser is eighty requests and eighty parses
// for data that is, in the end, one rotation per node per frame. This writes
// them as that: a JSON header, then 16-bit quaternions, frame after frame, and
// the few positions that move (the Biped's root and its pelvis).
//
//   uint32 header length, header JSON (padded to 4 bytes), then the data:
//   header = { v, family, faces, rig: { names, parent, restQ, restP, restS },
//              clips: [{ name, fps, keys, q: byteOffset, pos: [[node, byteOffset], ...] }] }
//   q:   Int16 keys * moving nodes * 4 (x, y, z, w scaled by 32767); rig.move lists them
//   hold: Int16 nodes * 4, the first key of every node: what the still ones keep
//        (fingers and end nodes: thirty of the sixty-six, and half the file)
//   pos: Float32 keys * 3, in the node's own parent space as the file had it
//
// Gaits and turns are kept at 30 keys a second, everything else at 15: an idle
// of twelve seconds does not need more, and it is most of the weight.

import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('../../tests/three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { GLTFLoader } = await import('../../libs/GLTFLoader.js');

const [dir, out, peopleFile] = process.argv.slice(2);
const people = peopleFile ? JSON.parse(fs.readFileSync(peopleFile, 'utf8')) : {};
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort();
const loader = new GLTFLoader();
const parse = (buf) => new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));

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

for (const file of files) {
  const g = await parse(fs.readFileSync(path.join(dir, file)));
  const clip = g.animations[0];
  if (!clip) { console.log('no animation in', file); continue; }
  const nodes = [];
  g.scene.traverse((o) => { if (o !== g.scene) nodes.push(o); });
  if (!rig) {
    order = nodes.map((o) => o.name);
    rig = {
      names: order, parent: nodes.map((o) => nodes.indexOf(o.parent)),
      restQ: nodes.flatMap((o) => o.quaternion.toArray().map((v) => +v.toFixed(6))),
      restP: nodes.flatMap((o) => o.position.toArray().map((v) => +v.toFixed(5))),
      restS: nodes.map((o) => +o.scale.x.toFixed(6)),
    };
    rig.move = order.map((nm, i) => (/Finger|Nub/.test(nm) ? -1 : i)).filter((i) => i >= 0);
  }
  const rot = new Map(), pos = new Map();
  let t0 = Infinity, t1 = 0;
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.'), node = tr.name.slice(0, dot), prop = tr.name.slice(dot + 1);
    if (prop === 'quaternion') rot.set(node, tr); else if (prop === 'position') pos.set(node, tr); else continue;
    t0 = Math.min(t0, tr.times[0]); t1 = Math.max(t1, tr.times[tr.times.length - 1]);
  }
  const dur = t1 - t0, name = file.slice(0, -4);
  const fps = dur <= 3 ? 30 : 15;
  const keys = Math.max(2, Math.round(dur * fps) + 1), n = order.length;
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
  const moved = [];
  order.forEach((nm, i) => {
    const tr = pos.get(nm);
    if (!tr) return;
    const v = tr.values;
    let span = 0;
    for (let c = 0; c < 3; c++) { let lo = Infinity, hi = -Infinity; for (let j = c; j < v.length; j += 3) { lo = Math.min(lo, v[j]); hi = Math.max(hi, v[j]); } span = Math.max(span, hi - lo); }
    // a bone's offset from its parent does not change; the root and the pelvis do move
    const scale = Math.max(1, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
    if (span < 1e-3 * scale && !/Pelvis$/.test(nm) && i !== 0) return;
    const it = tr.createInterpolant(new Float32Array(3)), p = new Float32Array(keys * 3);
    for (let k = 0; k < keys; k++) { const r = it.evaluate(t0 + (k / (keys - 1)) * dur); p[k * 3] = r[0]; p[k * 3 + 1] = r[1]; p[k * 3 + 2] = r[2]; }
    moved.push([i, p]);
  });
  const rec = { name, fps: +((keys - 1) / dur).toFixed(4), keys, q: push(q), hold: push(hold), pos: moved.map(([i, p]) => [i, push(p)]) };
  clips.push(rec);
}

const header = Buffer.from(JSON.stringify({ v: 1, family: people.family ?? 'rocketbox', faces: people.faces ?? '+z', rig, clips }), 'utf8');
const pad = (4 - (header.length % 4)) % 4;
const len = Buffer.alloc(4); len.writeUInt32LE(header.length + pad);
fs.writeFileSync(out, Buffer.concat([len, header, Buffer.alloc(pad, 0x20), ...chunks]));
console.log(`${clips.length} clips, ${rig.names.length} nodes, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB -> ${out}`);
