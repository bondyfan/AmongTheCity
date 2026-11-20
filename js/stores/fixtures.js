// ---- stores/fixtures.js: a store's fittings as a handful of draw calls ----
// Main thread only. Takes the layout (js/stores/layout.js or eatlayout.js) and
// stands it in the store's own group: one InstancedMesh per kind of fitting,
// every instance showing its own cell of the goods sheet, plus the light
// strips under the ceiling and the department boards over the aisles. Also
// answers what a walker bumps into: every fitting is a box in the store's own
// axes, so the push-out is two subtractions.

import * as THREE from 'three';
import { FITTINGS, FOOT, MODULE } from './fixgeo.js';
import { goodsTexture, cellOf, CELLS } from './goodstex.js';
import { litMaterial, GLOW, ceilAt } from './shellfx.js';
import { DEPT_NAME } from './catalog.js';

let _mat = null;
/** The one material of every fitting: the goods sheet, windowed per instance. */
export function fixtureMaterial() {
  if (_mat) return _mat;
  const map = goodsTexture();
  const m = litMaterial(0xffffff, 0.42, { map, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;\nattribute float tex;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        {
          // a face with stock shows its own cell of the sheet (rows count from the top);
          // any other face reads the white cell and keeps its vertex colour
          vec2 st = mix(vec2(${(CELLS - 0.5).toFixed(1)}, 0.5), vec2(aCell.x + uv.x, ${(CELLS - 1).toFixed(1)} - aCell.y + uv.y), tex) / ${CELLS.toFixed(1)};
          #ifdef USE_MAP
            vMapUv = st;
          #endif
          #ifdef USE_EMISSIVEMAP
            vEmissiveMapUv = st;
          #endif
        }`);
    // what a fitting gives off is its own colour, not the sheet's white: a dark kick plate stays dark
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #ifdef USE_COLOR
        totalEmissiveRadiance *= vColor.rgb;
      #endif`);
  };
  m.customProgramCacheKey = () => 'atc-store-fixture-v2';
  return (_mat = m);
}

const _geos = new Map();
const geoOf = (t) => { let g = _geos.get(t); if (!g) _geos.set(t, g = FITTINGS[t]().build()); return g; };

/** Which look a fitting's instance wears. */
function lookOf(f, i) {
  if (f.t === 'chiller') return i % 5 < 3 ? ['dairy', i] : i % 5 === 3 ? ['dairy2', i] : ['meat', i];
  if (f.t === 'bakery') return ['bakery', i];
  if (f.t === 'freezer') return ['frozen', i];
  if (f.t === 'produce') return ['produce', (f.v ?? 0) + i];
  if (f.t === 'bins') return ['bins', i];
  if (f.t === 'till') return ['belt', 0];
  if (f.t === 'self') return ['selfscreen', 0];
  if (f.t === 'kiosk') return ['kiosk', 0];
  if (f.t === 'menu') return ['menu', i];
  if (f.t === 'counter') return ['wood', 0];
  if (f.t === 'steel') return ['steel', 0];
  return [f.cat ?? 'dry', i + (f.k ?? 0) * 3];
}

/**
 * buildFixtures(site, layout, group) -> { colliders, dispose() }
 * Fittings are placed in the store group's own frame: X = u, Z = v.
 */
export function buildFixtures(site, layout, group) {
  const { r } = layout.room, fl = site.floor + 0.03;
  const byType = new Map();
  const colliders = [];
  const put = (t, u, v, yaw, look, scaleX = 1) => {
    let a = byType.get(t);
    if (!a) byType.set(t, a = []);
    a.push({ u, v, yaw, look, scaleX });
  };
  for (const f of layout.fixtures) {
    const geoT = f.t === 'bakery' ? 'wallshelf' : f.t;
    if (!FITTINGS[geoT]) continue;
    const foot = FOOT[geoT];
    const D = layout.room.D, W = layout.room.W;
    // which way a one-sided fitting looks: into the room, or as its `face` says
    let yaw;
    if (f.along === 'a') yaw = f.face !== undefined ? (f.face > 0 ? Math.PI / 2 : -Math.PI / 2) : (f.b > W / 2 ? -Math.PI / 2 : Math.PI / 2);
    else yaw = f.face !== undefined ? (f.face > 0 ? Math.PI : 0) : (f.a > D / 2 ? 0 : Math.PI);
    if (f.t === 'gondola' || f.t === 'rack' || f.t === 'freezer' || f.t === 'bins' || f.t === 'till') yaw = f.along === 'a' ? Math.PI / 2 : 0;
    if (f.t === 'produce') yaw = f.b > layout.lane.c ? Math.PI / 2 : -Math.PI / 2;
    if (f.t === 'self') yaw = f.face > 0 ? Math.PI / 2 : -Math.PI / 2;
    if (f.yaw !== undefined) yaw = f.yaw;
    const single = f.t === 'till' || f.t === 'self' || f.t === 'baskets' || f.single;
    const unit = f.t === 'produce' ? 1.2 : MODULE;
    const n = single ? 1 : Math.max(1, Math.round(f.len / unit));
    for (let i = 0; i < n; i++) {
      const s = single ? 0 : (i - (n - 1) / 2) * unit;
      const a = f.a + (f.along === 'a' ? s : 0), b = f.b + (f.along === 'b' ? s : 0);
      const u = r.u0 + b, v = r.v1 - a;
      if (f.t === 'gate') {
        // two posts, their arms reaching for the middle of the lane
        put('gate', r.u0 + f.b - f.len / 2, v, 0, ['white', 0]);
        put('gate', r.u0 + f.b + f.len / 2, v, Math.PI, ['white', 0]);
        break;
      }
      put(geoT, u, v, yaw, lookOf(f, i + ((f.a * 7 + f.b * 3) | 0)));
      if (foot) {
        const alongU = Math.abs(Math.sin(yaw)) < 0.5;        // run along u, or along v
        const hu = alongU ? foot[0] : foot[1], hv = alongU ? foot[1] : foot[0];
        colliders.push([u - hu, u + hu, v - hv, v + hv]);
      }
    }
    if (f.t === 'till') {
      // the belt and the booth beside it, as two boxes (the lane stays free)
      const u = r.u0 + f.b, v = r.v1 - f.a;
      colliders.push([u - 0.35, u + 0.25, v - 1.6, v + 1.6], [u - 1.05, u - 0.35, v - 0.2, v + 1.2]);
    }
  }
  const mat = fixtureMaterial(), made = [];
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  for (const [t, list] of byType) {
    const geo = geoOf(t).clone();              // its own instance attributes
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const cells = new Float32Array(list.length * 2);
    list.forEach((it, i) => {
      Q.setFromAxisAngle(Y, it.yaw); P.set(it.u, fl, it.v); S.set(it.scaleX, 1, 1);
      mesh.setMatrixAt(i, M.compose(P, Q, S));
      const [c, row] = cellOf(it.look[0], it.look[1]);
      cells[i * 2] = c; cells[i * 2 + 1] = row;
    });
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;                // instances fill the hall: one bound is the hall
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false; mesh.receiveShadow = false;
    group.add(mesh); made.push(mesh);
  }

  // ---- light strips under the ceiling, in rows over the aisles ----
  const { W, D } = layout.room;
  const yL = Math.min(ceilAt(site, r.v0), ceilAt(site, r.v1), 5.2) - 0.3;
  const strips = [];
  for (let b = 1.6; b < W - 1; b += 3.3) for (let a = 1.5; a < D - 1.2; a += 2.4) strips.push([r.u0 + b, r.v1 - a - 0.9]);
  if (strips.length) {
    const lm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.06, 1.8), GLOW, strips.length);
    strips.forEach(([u, v], i) => lm.setMatrixAt(i, M.makeTranslation(u, yL, v)));
    lm.frustumCulled = false; lm.matrixAutoUpdate = false;
    group.add(lm); made.push(lm);
  }
  const boards = layout.kind === 'market' ? deptBoards(site, layout, group) : null;
  return {
    colliders, lightY: yL,
    dispose() {
      for (const m of made) { m.removeFromParent(); m.geometry.dispose(); m.dispose(); }
      boards?.dispose();
    },
  };
}

/**
 * The boards that hang over the aisles and name the departments, in the chain's
 * own colours: every board a row of one small canvas, all of them one mesh.
 */
function deptBoards(site, layout, group) {
  const { r } = layout.room, chain = site.chain;
  const list = [];
  for (const row of layout.rows) list.push({ a: row.a0 - 0.15, b: row.b, text: DEPT_NAME[row.cat] ?? '' });
  const bk = layout.fixtures.find((f) => f.t === 'bakery'), pr = layout.fixtures.find((f) => f.t === 'produce');
  if (pr) list.push({ a: layout.aAisle0 - 0.3, b: layout.lane.c, text: DEPT_NAME.produce });
  if (bk) list.push({ a: bk.a - bk.len / 2, b: bk.b + (bk.b < layout.room.W / 2 ? 0.9 : -0.9), text: DEPT_NAME.bakery, side: true });
  if (layout.selfs.length) list.push({ a: layout.aTill1 + 0.3, b: layout.selfs[0].b, text: 'Samoobslužné pokladny' });
  if (layout.tills.length) list.push({ a: layout.aTill1 + 0.3, b: layout.tills[Math.floor(layout.tills.length / 2)].b, text: 'Pokladny' });
  const texts = [...new Set(list.map((l) => l.text).filter(Boolean))];
  if (!texts.length) return null;
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 64 * texts.length;
  const g = cv.getContext('2d');
  const white = chain.sign.bg === 0xffffff, css = (h) => '#' + h.toString(16).padStart(6, '0');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  texts.forEach((t, i) => {
    g.fillStyle = css(white ? chain.sign.fg : chain.sign.bg); g.fillRect(0, i * 64, 512, 64);
    g.fillStyle = css(white ? 0xffffff : chain.sign.fg);
    let size = 40; g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    const w = g.measureText(t).width;
    if (w > 480) { size = Math.floor(size * 480 / w); g.font = `bold ${size}px Arial, Helvetica, sans-serif`; }
    g.fillText(t, 256, i * 64 + 34);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const pos = [], uv = [], nrm = [];
  const y0 = 2.45, y1 = 2.9, hw = 0.95;
  for (const l of list) {
    const i = texts.indexOf(l.text);
    if (i < 0) continue;
    const u = r.u0 + l.b, v = r.v1 - l.a, v0 = 1 - (i + 1) / texts.length, v1 = 1 - i / texts.length;
    // two faces: toward the front of the shop and toward the back
    for (const s of [1, -1]) {
      const A = [u - hw * s, y0, v + 0.01 * s], B = [u + hw * s, y0, v + 0.01 * s], C = [u + hw * s, y1, v + 0.01 * s], D = [u - hw * s, y1, v + 0.01 * s];
      for (const [p, t] of [[A, [0, v0]], [B, [1, v0]], [C, [1, v1]], [A, [0, v0]], [C, [1, v1]], [D, [0, v1]]]) { pos.push(...p); uv.push(...t); nrm.push(0, 0, s); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  const mat = litMaterial(0xffffff, 0.75, { map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  group.add(mesh);
  return { dispose() { mesh.removeFromParent(); geo.dispose(); mat.dispose(); tex.dispose(); } };
}

/**
 * Push a walker out of the fittings. `u`, `v` are the walker in the store's
 * own axes; returns null or the corrected [u, v].
 */
export function pushOut(colliders, u, v, rad) {
  let hit = false;
  for (const c of colliders) {
    if (u < c[0] - rad || u > c[1] + rad || v < c[2] - rad || v > c[3] + rad) continue;
    // out by the nearest face
    const dl = u - (c[0] - rad), dr = (c[1] + rad) - u, db = v - (c[2] - rad), df = (c[3] + rad) - v;
    const m = Math.min(dl, dr, db, df);
    if (m === dl) u = c[0] - rad; else if (m === dr) u = c[1] + rad; else if (m === db) v = c[2] - rad; else v = c[3] + rad;
    hit = true;
  }
  return hit ? [u, v] : null;
}
