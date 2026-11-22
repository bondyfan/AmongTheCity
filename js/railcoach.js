// ---- railcoach.js: the coach every train of the open world is made of ----
// Frank, 21 Nov 2026: "vlaky, aby všechny vlaky byly tak, jako je to, když
// nastupuje jako z Kolína ... úplně jako takhle stejný model toho vlaku".
// So a train of js/trains.js is no longer a row of painted slabs: each of its
// vehicles is the campaign's coach (js/prologue-coach.js), built from the very
// same calls: the saloon, the seats, the tables, the doors, the bogies.
//
// The campaign draws its one train as some thirty instanced batches. Six
// trains of three coaches would be five hundred draws that way, so here the
// boxes of a coach are MERGED once into three geometries (what is solid, what
// is glass, what glows) that every coach of every train shares: three draws a
// coach, and a train out of reach is one painted shell (the far model).
//
// The model's own frame is the campaign's: x along the coach toward its front,
// y up from its base (0.6 m over the railhead), z across. A coach's group has
// its origin on the railhead under the middle of its bogies and looks along -z
// like every vehicle (ARCHITECTURE.md), so the model sits in it turned a
// quarter and pushed back by MID.

import * as THREE from 'three';
import { coach, running, gangway, cab, cabLamp, doorLeaf, leafAt, lettering, PITCH } from './prologue-coach.js';

export const COACH = Object.freeze({
  pitch: PITCH,       // m of train one coach takes
  front: 16.35,       // the model's x where the slot starts, at the front…
  back: -10.35,       // …and where it ends
  mid: 2.9,           // the middle of the two bogies
  bogie: 9.55,        // each bogie this far from the middle
  rise: 0.6,          // the model's base over the railhead
});
const FAR_IN = 150, FAR_OUT = 185;   // m: nearer than the first a coach is drawn whole

// ---- the collector: the campaign's kit, gathering instead of drawing ------
function collector() {
  const solid = [], glass = [], glow = [], signs = [];
  const pose = new THREE.Object3D();
  return {
    solid, glass, glow, signs,
    box(x, y, z, w, h, d, color, rz = 0, glowing = false, surface = 'solid') {
      pose.position.set(x, y, z);
      pose.scale.set(w, h, d);
      pose.rotation.set(0, 0, rz);
      pose.updateMatrix();
      (surface === 'glass' ? glass : glowing ? glow : solid)
        .push({ m: pose.matrix.clone(), color, round: surface === 'round' });
    },
    sign(x, y, z, width, height, lines, yaw = 0, bg = '#173957', ink = '#f4f4e7') {
      signs.push({ x, y, z, width, height, text: lines.join('\n'), yaw, bg, ink });
    },
  };
}

let _unit = null;
function units() {
  return (_unit ??= { box: new THREE.BoxGeometry(), round: new THREE.SphereGeometry(0.5, 12, 8) });
}
// Every gathered box becomes part of one geometry. `local` keeps each vertex's
// place in its own unit box: the kit's shader shades by it (edges, grain).
function merge(list) {
  if (!list.length) return null;
  const U = units();
  let nv = 0, ni = 0;
  for (const b of list) {
    const g = b.round ? U.round : U.box;
    nv += g.attributes.position.count; ni += g.index.count;
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3),
    loc = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3(), c = new THREE.Color();
  let vo = 0, io = 0;
  for (const b of list) {
    const g = b.round ? U.round : U.box, P = g.attributes.position, N = g.attributes.normal, I = g.index;
    nm.getNormalMatrix(b.m);
    c.set(b.color);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      loc.set([v.x, v.y, v.z], (vo + i) * 3);
      v.applyMatrix4(b.m);
      n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      pos.set([v.x, v.y, v.z], (vo + i) * 3);
      nor.set([n.x, n.y, n.z], (vo + i) * 3);
      col.set([c.r, c.g, c.b], (vo + i) * 3);
    }
    for (let i = 0; i < I.count; i++) idx[io + i] = I.getX(i) + vo;
    vo += P.count; io += I.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aLocal', new THREE.BufferAttribute(loc, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// ---- materials, shared by every coach forever ------------------------------
let _M = null;
function mats() {
  if (_M) return _M;
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  // the kit's finish (js/prologue-kit.js), read from the merged attributes:
  // metre-scaled grain and soft corner shading on otherwise uniform surfaces
  solid.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute vec3 aLocal;\nvarying vec3 vLocal, vPlace;\n'
      + shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n vLocal=aLocal; vPlace=position;');
    shader.fragmentShader = 'varying vec3 vLocal, vPlace;\n'
      + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec3 a=abs(vLocal);
        float edge=min(max(a.x,a.y),min(max(a.y,a.z),max(a.z,a.x)));
        float grain=fract(sin(dot(floor(vPlace*28.),vec3(12.98,78.23,33.13)))*437.54);
        float lod=1.-smoothstep(.15,1.,length(fwidth(vPlace))*28.);
        diffuseColor.rgb *= (.90 + .12*vLocal.y + .09*edge + .09*grain*lod);
        `);
  };
  _M = {
    solid,
    glass: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.16, depthWrite: false }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
    far: new THREE.MeshLambertMaterial({ vertexColors: true }),
    head: new THREE.MeshBasicMaterial({ color: 0xffe6b7 }),
    tail: new THREE.MeshBasicMaterial({ color: 0xa63e32 }),
    shade: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  };
  return _M;
}

// ---- the parts, gathered once ---------------------------------------------
let _G = null;
function parts() {
  if (_G) return _G;
  const body = collector();
  coach(body, { doors: 2, destination: '' });
  running(body);
  lettering(body, 0, -1);
  const gang = collector();
  gangway(gang);
  const ends = {};
  for (const [name, x, face] of [['front', 16.18, 1], ['back', -10.18, -1]]) {
    const k = collector();
    cab(k, x, face, null);
    k.box(x - face * 0.08, 1.42, 0, 0.12, 2.56, 1.24, 0xadb3b0);
    ends[name] = merge(k.solid);
  }
  const leaves = [];
  for (const side of [-1, 1]) for (const direction of [-1, 1]) {
    const k = collector();
    doorLeaf(k, direction, side);
    leaves.push({ side, direction, geo: merge(k.solid) });
  }
  // the far model: the same coach in a dozen boxes, the colours of the near one
  const far = collector();
  far.box(3, 1.62, 0, 26.5, 2.5, 3.1, 0xe0dfd6);            // the cream body
  far.box(3, 0.39, 0, 26.52, 0.37, 3.16, 0x1b5791);         // the blue band under the windows
  far.box(1.55, 1.73, 0, 23.4, 0.72, 3.14, 0x2a3d47);       // the row of windows
  far.box(3, 2.87, 0, 26.5, 0.2, 3.14, 0xe0dfd6);
  for (const u of [-6.2, 6.2]) far.box(u, 2.96, 0, 2.15, 0.22, 1.07, 0xa6aaa8);
  for (const u of [-6.65, 12.45]) far.box(u, -0.36, 0, 3.12, 0.62, 2.23, 0x40494c);
  far.box(1, -0.34, 0, 5.4, 0.58, 1.92, 0x414a4e);
  far.box(14, 1.42, 0, 1.5, 2.51, 3.18, 0x245581);          // the doors
  const lamp = new THREE.BoxGeometry(0.06, 0.13, 0.25);
  const shade = new THREE.BoxGeometry(26.5, 3.4, 3.05);
  shade.translate(3, 1.1, 0);
  _G = {
    solid: merge(body.solid), glass: merge(body.glass), glow: merge(body.glow), signs: body.signs,
    gang: merge(gang.solid), ends, leaves, far: merge(far.solid), lamp, shade,
  };
  return _G;
}

// ---- lettering: one texture per text, one plane per size ------------------
const _signMat = new Map(), _signGeo = new Map();
function signMesh(s, text) {
  if (typeof document === 'undefined') return null;        // (headless: no canvas to letter on)
  const mk = text + '|' + s.bg + '|' + s.ink + '|' + s.width + '|' + s.height;
  let mat = _signMat.get(mk);
  if (!mat) {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = Math.max(72, Math.round((768 * s.height) / s.width));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = s.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = s.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(canvas.height * 0.62) + 'px system-ui, sans-serif';
    ctx.fillText(text, 384, canvas.height / 2, 730);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.MeshBasicMaterial({ map });
    _signMat.set(mk, mat);
  }
  const gk = s.width + 'x' + s.height;
  let geo = _signGeo.get(gk);
  if (!geo) { geo = new THREE.PlaneGeometry(s.width, s.height); _signGeo.set(gk, geo); }
  const m = new THREE.Mesh(geo, mat);
  m.position.set(s.x, s.y, s.z);
  m.rotation.y = s.yaw;
  return m;
}

const still = (o) => { o.updateMatrix(); o.matrixAutoUpdate = false; return o; };

/**
 * makeCoach({ first, last, destination }) → one vehicle of a train.
 *   group   on the railhead under the middle of its bogies, looking along -z
 *   body    canted into curves by js/trains.js (rotation.z)
 *   model   the campaign's frame: passengers are seated in it (js/trainpeople.js)
 *   doors(closed, left, right)  1 shut … 0 open, per flank (left is the model's -z)
 *   lamps(flip)  white at the leading end, red at the trailing one
 *   lod(d)       d metres from the eye: whole, or the far shell
 * `first` is the leading coach of an unflipped set (a cab at its front),
 * `last` the trailing one; every other end gets a gangway to the coach behind.
 */
export function makeCoach({ first = false, last = false, destination = 'Osobní vlak' } = {}) {
  const G = parts(), M = mats();
  const group = new THREE.Group(), body = new THREE.Group(), model = new THREE.Group();
  group.add(body);
  body.add(model);
  model.rotation.y = Math.PI / 2;
  model.position.set(0, COACH.rise, COACH.mid);
  const near = new THREE.Group(), far = still(new THREE.Mesh(G.far, M.far));
  model.add(near, far);
  far.visible = false;
  near.add(still(new THREE.Mesh(G.solid, M.solid)), still(new THREE.Mesh(G.glow, M.glow)));
  const glass = still(new THREE.Mesh(G.glass, M.glass));
  glass.renderOrder = 2;
  near.add(glass);
  if (!last) near.add(still(new THREE.Mesh(G.gang, M.solid)));
  for (const s of G.signs) {
    const m = signMesh(s, s.text.startsWith('2   ') && s.text.length === 4 ? '2   ' + destination : s.text);
    if (m) near.add(still(m));
  }
  // the whole coach throws one box of shadow: thirty thousand vertices drawn
  // a second time for the sun would cost more than the train is worth
  const shade = still(new THREE.Mesh(G.shade, M.shade));
  shade.castShadow = true;
  model.add(shade);
  const lampSets = [];
  for (const [name, x, face, on] of [['front', 16.18, 1, first], ['back', -10.18, -1, last]]) {
    if (!on) continue;
    near.add(still(new THREE.Mesh(G.ends[name], M.solid)));
    const set = [];
    for (const side of [-1, 1]) {
      const l = cabLamp(x, face, side), m = new THREE.Mesh(G.lamp, M.head);
      m.position.set(l.x, l.y, l.z);
      model.add(still(m));
      set.push(m);
    }
    lampSets.push({ face, set });
  }
  const leaves = G.leaves.map((l) => {
    const mesh = new THREE.Mesh(l.geo, M.solid);
    near.add(mesh);
    return { mesh, side: l.side, direction: l.direction };
  });
  let shown = [-1, -1], whole = true;
  const api = {
    group, body, model, first, last,
    doors(closed, left = true, right = true) {
      const want = [left ? closed : 1, right ? closed : 1];
      if (want[0] === shown[0] && want[1] === shown[1]) return;
      shown = want;
      for (const l of leaves) {
        const p = leafAt(l.direction, want[l.side < 0 ? 0 : 1], l.side);
        l.mesh.position.set(p.x, 0, p.z);
      }
    },
    lamps(flip) {
      for (const { face, set } of lampSets)
        for (const m of set) m.material = (face > 0) !== !!flip ? M.head : M.tail;
    },
    lod(d) {
      const want = whole ? d < FAR_OUT : d < FAR_IN;
      if (want === whole) return whole;
      whole = want;
      near.visible = whole;
      far.visible = !whole;
      return whole;
    },
    get whole() { return whole; },
  };
  api.doors(1);
  api.lamps(0);
  return api;
}
